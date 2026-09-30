import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  carryAgentProfiles,
  carryPaseoPreferences,
  createPaseo,
  readAgentProfiles,
  refreshUnitPath,
  unitFile,
} from "../src/integrations/paseo.ts";
import type { HostAdapter, LinkResult, RunOptions } from "../src/link.ts";
import { noProgress } from "../src/progress.ts";
import { BUILTIN_BOX_PATH_DIRS } from "../src/tools/path.ts";
import { jqTest } from "./paseo-shell-box.ts";

/**
 * A fake box. Each Link command runs in `sh` with a temporary HOME and fake
 * `systemctl`, `loginctl`, `node`, `npm`, `sudo`, `apt` and `paseo` commands.
 * Each fake command writes its arguments to the log. Files in `state` hold the
 * unit states, the Node version, and the linger state. With `linger-denied`,
 * only `sudo` may turn on linger, and with `sudo-denied`, `sudo -n` fails.
 */
type FakeBox = {
  readonly home: string;
  readonly state: string;
  readonly commands: string[];
  /** The stdout and stderr of each command, as Ferry receives them. */
  readonly outputs: string[];
  log(): string[];
  run(command: string, options?: RunOptions): Promise<LinkResult>;
};

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const FAKES: Record<string, string> = {
  systemctl: `
[ "$1" = --user ] && shift
case "$1" in
  is-active|is-enabled)
    check=$1; shift; quiet=; [ "$1" = --quiet ] && { quiet=1; shift; }
    if [ "$check" = is-active ]; then file=active-$1 yes=active no=inactive; else file=enabled-$1 yes=enabled no=disabled; fi
    if [ -e "$STATE/$file" ]; then [ -z "$quiet" ] && echo "$yes"; exit 0; fi
    [ -z "$quiet" ] && echo "$no"; exit 3 ;;
esac
echo "systemctl $*" >> "$LOG"
case "$1" in
  disable) unit=$2; [ "$2" = --now ] && unit=$3; rm -f "$STATE/enabled-$unit"; [ "$2" = --now ] && rm -f "$STATE/active-$unit" ;;
  enable) touch "$STATE/enabled-$3" "$STATE/active-$3" ;;
  restart) touch "$STATE/active-$2" ;;
esac
exit 0`,
  loginctl: `[ "$1" = show-user ] && { [ -e "$STATE/linger" ] && echo yes || echo no; exit 0; }
echo "loginctl $*" >> "$LOG"
if [ -e "$STATE/linger-denied" ] && [ -z "$FAKE_SUDO" ]; then echo "Access denied" >&2; exit 1; fi
touch "$STATE/linger"`,
  sudo: `if [ "$1" = -n ]; then
  shift; echo "sudo -n $*" >> "$LOG"
  [ -e "$STATE/sudo-denied" ] && { echo "sudo: a password is required" >&2; exit 1; }
fi
FAKE_SUDO=1 "$@"`,
  apt: `echo "apt $*" >> "$LOG"
[ "$1" = install ] && [ -e "$STATE/apt-node" ] && cp "$STATE/apt-node" "$STATE/node"
exit 0`,
  node: `case "$1" in
  --version) cat "$STATE/node" ;;
  -e) major=$(sed 's/^v\\([0-9]*\\).*/\\1/' "$STATE/node"); [ "$major" -ge 22 ] ;;
esac`,
  npm: `echo "npm $*" >> "$LOG"
if [ -e "$STATE/npm-fail" ]; then cat "$STATE/npm-fail"; cat "$STATE/npm-fail" >&2; exit 1; fi`,
  // With a `noise` file, each command prints the file to stdout and to stderr. A failed command prints its `fail-` file.
  paseo: `noise() { if [ -e "$STATE/noise" ]; then cat "$STATE/noise" >&2; [ "$1" = out ] && cat "$STATE/noise"; fi; }
case "$1 $2" in
  "daemon status") noise; if [ -e "$STATE/status" ]; then cat "$STATE/status"; else echo '{"localDaemon":"running","daemonVersion":"0.9.2","listen":"127.0.0.1:6767"}'; fi ;;
  "daemon reload") echo "paseo daemon reload" >> "$LOG"; noise out ;;
  "project create")
    echo "paseo project create $3" >> "$LOG"; noise out
    if [ "$3" = "$(cat "$STATE/fail-project" 2>/dev/null)" ]; then cat "$STATE/fail-output" >&2 2>/dev/null; exit 1; fi ;;
  "import "*)
    echo "paseo $*" >> "$LOG"; noise out
    if [ -e "$STATE/fail-import-$2" ]; then cat "$STATE/fail-import-$2" >&2; exit 1; fi ;;
esac`,
};

function fakeBox(): FakeBox {
  const root = mkdtempSync(join(tmpdir(), "ferry-paseo-box-"));
  roots.push(root);
  const home = join(root, "home");
  const bin = join(root, "bin");
  const state = join(root, "state");
  const logPath = join(root, "log");
  for (const dir of [home, bin, state]) mkdirSync(dir, { recursive: true });
  writeFileSync(logPath, "");
  writeFileSync(join(state, "node"), "v22.3.0\n");
  for (const [name, body] of Object.entries(FAKES)) {
    writeFileSync(join(bin, name), `#!/bin/sh\n${body}\n`);
    chmodSync(join(bin, name), 0o755);
  }
  const commands: string[] = [];
  const outputs: string[] = [];
  return {
    home,
    state,
    commands,
    outputs,
    log: () => readFileSync(logPath, "utf8").split("\n").filter((line) => line !== ""),
    async run(command, options = {}) {
      commands.push(command);
      const process = Bun.spawn(["sh", "-c", `export PATH="${bin}:$PATH"; ${command}`], {
        cwd: home,
        env: { ...Bun.env, HOME: home, USER: "ploi", STATE: state, LOG: logPath },
        stdin: options.input ?? "ignore",
        stdout: "pipe",
        stderr: "pipe",
      });
      const [stdout, stderr, exitCode] = await Promise.all([
        new Response(process.stdout).text(),
        new Response(process.stderr).text(),
        process.exited,
      ]);
      outputs.push(stdout, stderr);
      // The message is that of the Link: the stderr, else the stdout.
      return exitCode === 0
        ? { ok: true, address: "box", stdout, stderr }
        : { ok: false, error: { code: "command-failed", origin: "box", message: stderr.trim() || stdout.trim() || `exit ${exitCode}` } };
    },
  };
}

/** A Paseo integration whose local app has `version`, or no local app. */
function paseoWith(version: string | null) {
  const root = mkdtempSync(join(tmpdir(), "ferry-paseo-app-"));
  roots.push(root);
  const installDir = join(root, "Paseo");
  if (version !== null) {
    mkdirSync(join(installDir, "resources/bin"), { recursive: true });
    writeFileSync(join(installDir, "resources/bin/paseo"), "");
  }
  const host: HostAdapter = {
    run: async () => ({ exitCode: 0, stdout: `${version}\n`, stderr: "", timedOut: false }),
  };
  return createPaseo({ platform: "linux", linuxInstallDir: installDir, host, pollIntervalMs: 0, sleep: async () => {} });
}

/** A Paseo integration with no local app. `npm view` prints `latest`, or fails when it is null. */
function paseoUnpinned(latest: string | null, calls: string[] = []) {
  const host: HostAdapter = {
    run: async ({ argv }) => {
      calls.push(argv.join(" "));
      return latest === null
        ? { exitCode: 1, stdout: "", stderr: "npm error network", timedOut: false }
        : { exitCode: 0, stdout: `${latest}\n`, stderr: "", timedOut: false };
    },
  };
  return createPaseo({ platform: "linux", linuxInstallDir: "/nonexistent", host, pollIntervalMs: 0, sleep: async () => {} });
}

/** Mark the unit active, so `paseo daemon status --json` gives the box version. */
function activeUnit(box: FakeBox): void {
  writeFileSync(join(box.state, "active-ferry-paseo.service"), "");
}

const CURRENT = (version: string) =>
  `Paseo ${version} is current. Ferry does not install it or restart ferry-paseo.service.`;
const UNREADABLE =
  "Warning: Ferry could not read the Paseo version on the box. Ferry installs Paseo and restarts ferry-paseo.service.";

function touch(path: string, body = ""): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, body);
}

const UNIT_PATH = ".config/systemd/user/ferry-paseo.service";

describe("Paseo enable", () => {
  test("installs the local version, writes and starts the unit, then registers the projects, in order", async () => {
    const box = fakeBox();
    mkdirSync(join(box.home, "Developer/app/.git"), { recursive: true });
    mkdirSync(join(box.home, "code/org/repo/.git"), { recursive: true });
    mkdirSync(join(box.home, ".paseo/worktrees/x/.git"), { recursive: true });
    mkdirSync(join(box.home, "Developer/app/node_modules/pkg/.git"), { recursive: true });

    const lines = await paseoWith("0.9.2").box.enable(box, noProgress);

    const log = box.log();
    expect(log.slice(0, 4)).toEqual([
      `npm install -g --prefix ${box.home}/.local @getpaseo/cli@0.9.2`,
      "systemctl daemon-reload",
      "systemctl enable --now ferry-paseo.service",
      "loginctl enable-linger ploi",
    ]);
    expect(log.slice(4).sort()).toEqual([
      `paseo project create ${box.home}/Developer/app`,
      `paseo project create ${box.home}/code/org/repo`,
    ]);
    expect(readFileSync(join(box.home, UNIT_PATH), "utf8")).toBe(unitFile(BUILTIN_BOX_PATH_DIRS));
    expect(lines).toEqual([
      "Registered 2 of 2 box projects in Paseo.",
      "Paseo 0.9.2 runs on the box at 127.0.0.1:6767. The relay is off.",
    ]);
  });

  test("skips enable-linger when linger is already on", async () => {
    const box = fakeBox();
    writeFileSync(join(box.state, "linger"), "");

    await paseoWith("0.9.2").box.enable(box, noProgress);

    expect(box.log().filter((line) => line.includes("linger"))).toEqual([]);
  });

  test("turns on linger with sudo -n when loginctl is denied, and reports success", async () => {
    const box = fakeBox();
    writeFileSync(join(box.state, "linger-denied"), "");

    const lines = await paseoWith("0.9.2").box.enable(box, noProgress);

    expect(box.log().filter((line) => line.includes("linger"))).toEqual([
      "loginctl enable-linger ploi",
      "sudo -n loginctl enable-linger ploi",
      "loginctl enable-linger ploi",
    ]);
    expect(lines.at(-1)).toBe("Paseo 0.9.2 runs on the box at 127.0.0.1:6767. The relay is off.");
  });

  test("warns and still enables Paseo when neither loginctl nor sudo -n can turn on linger", async () => {
    const box = fakeBox();
    writeFileSync(join(box.state, "linger-denied"), "");
    writeFileSync(join(box.state, "sudo-denied"), "");

    const lines = await paseoWith("0.9.2").box.enable(box, noProgress);

    expect(lines).toContain(
      'Warning: Ferry could not turn on linger (sudo: a password is required). Without linger, ferry-paseo.service stops when you log out of the box. Run sudo loginctl enable-linger "$USER" on the box.',
    );
    expect(lines.at(-1)).toBe("Paseo 0.9.2 runs on the box at 127.0.0.1:6767. The relay is off.");
  });

  test("the unit runs the daemon in the foreground with the Link PATH, loopback listen and no relay", () => {
    const UNIT_FILE = unitFile(BUILTIN_BOX_PATH_DIRS);
    expect(UNIT_FILE).toContain("Type=simple\n");
    expect(UNIT_FILE).toContain("ExecStart=%h/.local/bin/paseo daemon run\n");
    expect(UNIT_FILE).toContain(
      "Environment=PATH=%h/.local/bin:%h/.pi/agent/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin\n",
    );
    expect(UNIT_FILE).toContain("Environment=PASEO_LISTEN=127.0.0.1:6767\n");
    expect(UNIT_FILE).toContain("Environment=PASEO_RELAY_ENABLED=false\n");
    // The daemon self-update runs npm -g, which must find the Ferry install.
    expect(UNIT_FILE).toContain("Environment=NPM_CONFIG_PREFIX=%h/.local\n");
    expect(UNIT_FILE).toContain("Restart=on-failure\nRestartSec=5\n");
    // One process that the OOM killer kills does not stop the service. Ferry sets no memory limit.
    expect(UNIT_FILE).toContain("[Service]\nOOMPolicy=continue\n");
    expect(UNIT_FILE).not.toContain("MemoryMax");
    expect(UNIT_FILE).toContain("[Install]\nWantedBy=default.target\n");
  });

  test("installs the npm latest tag and says so when there is no local app", async () => {
    const box = fakeBox();

    const lines = await paseoWith(null).box.enable(box, noProgress);

    expect(box.log()[0]).toBe(`npm install -g --prefix ${box.home}/.local @getpaseo/cli@latest`);
    expect(lines[0]).toBe("No local Paseo app. Ferry installs the npm latest tag. The version is not pinned.");
  });

  test("runs the shared Node bootstrap when the box Node is older than 22", async () => {
    const box = fakeBox();
    writeFileSync(join(box.state, "node"), "v18.19.1\n");
    writeFileSync(join(box.state, "apt-node"), "v22.9.0\n");

    await paseoWith("0.9.2").box.enable(box, noProgress);

    expect(box.log().slice(0, 3)).toEqual([
      "apt update",
      "apt install nodejs npm -y",
      `npm install -g --prefix ${box.home}/.local @getpaseo/cli@0.9.2`,
    ]);
  });

  test("stops with a clear message and installs nothing when the bootstrap leaves an old Node", async () => {
    const box = fakeBox();
    writeFileSync(join(box.state, "node"), "v18.19.1\n");

    await expect(paseoWith("0.9.2").box.enable(box, noProgress)).rejects.toThrow(
      "Paseo needs Node 22 or later, and the box has Node v18.19.1 after the apt install.",
    );
    expect(box.log().some((line) => line.startsWith("npm "))).toBe(false);
  });

  test("stops and disables an active hand-written paseo.service before the new unit starts, and keeps its file", async () => {
    const box = fakeBox();
    const old = join(box.home, ".config/systemd/user/paseo.service");
    touch(old, "[Service]\n");
    touch(join(box.state, "active-paseo.service"));
    touch(join(box.state, "enabled-paseo.service"));

    const lines = await paseoWith("0.9.2").box.enable(box, noProgress);

    const log = box.log();
    expect(log.indexOf("systemctl disable --now paseo.service")).toBeGreaterThan(-1);
    expect(log.indexOf("systemctl disable --now paseo.service")).toBeLessThan(
      log.indexOf("systemctl enable --now ferry-paseo.service"),
    );
    expect(existsSync(old)).toBe(true);
    expect(existsSync(join(box.state, "active-paseo.service"))).toBe(false);
    expect(lines).toContain(
      "Stopped and disabled the old paseo.service. The file ~/.config/systemd/user/paseo.service stays.",
    );
  });

  test("disables an enabled but stopped paseo.service, and leaves the old unit alone when there is no file", async () => {
    const stopped = fakeBox();
    touch(join(stopped.home, ".config/systemd/user/paseo.service"));
    touch(join(stopped.state, "enabled-paseo.service"));
    expect(await paseoWith("0.9.2").box.enable(stopped, noProgress)).toContain(
      "Disabled the old paseo.service. The file ~/.config/systemd/user/paseo.service stays.",
    );
    expect(stopped.log()).toContain("systemctl disable paseo.service");

    const clean = fakeBox();
    await paseoWith("0.9.2").box.enable(clean, noProgress);
    expect(clean.log().some((line) => line.includes(" paseo.service"))).toBe(false);
  });

  test("warns about a project that Paseo refuses and still succeeds", async () => {
    const box = fakeBox();
    mkdirSync(join(box.home, "app/.git"), { recursive: true });
    writeFileSync(join(box.state, "fail-project"), join(box.home, "app"));

    const lines = await paseoWith("0.9.2").box.enable(box, noProgress);

    expect(lines).toContain("Registered 0 of 1 box projects in Paseo.");
    expect(lines).toContain("Warning: paseo project create failed for app.");
  });

  test("fails when the daemon does not report running within the time limit", async () => {
    const statuses: string[] = [];
    const link = {
      run: async (command: string): Promise<LinkResult> => {
        if (command.includes("daemon status")) {
          statuses.push(command);
          return { ok: true, address: "box", stdout: '{"localDaemon":"stopped"}', stderr: "" };
        }
        return { ok: true, address: "box", stdout: command === "node --version" ? "v22.3.0\n" : "", stderr: "" };
      },
    };
    const paseo = createPaseo({ platform: "win32", pollIntervalMs: 1_000, startTimeoutMs: 3_000, sleep: async () => {} });

    await expect(paseo.box.enable(link, noProgress)).rejects.toThrow(
      "The Paseo daemon did not report running within 3 s (localDaemon is stopped).",
    );
    expect(statuses).toHaveLength(4);
  });
});

describe("Paseo enable and health", () => {
  test("the health check reads the unit that enable writes and starts", async () => {
    const box = fakeBox();
    const paseo = paseoWith("0.9.2");
    touch(join(box.home, ".config/systemd/user/paseo.service"));
    touch(join(box.state, "active-paseo.service"));

    await paseo.box.enable(box, noProgress);
    const health = await paseo.box.health(box);

    expect(health.lines[0]).toBe("Service: ferry-paseo.service active, enabled");
    expect(health.warnings).toEqual([]);
  });
});

describe("Paseo disable", () => {
  test("stops and removes the unit, keeps linger, the CLI and ~/.paseo", async () => {
    const box = fakeBox();
    await paseoWith("0.9.2").box.enable(box, noProgress);
    touch(join(box.home, ".paseo/config.json"), "{}");
    const before = box.log().length;

    const lines = await paseoWith("0.9.2").box.disable(box, noProgress, { purge: false });

    expect(box.log().slice(before)).toEqual([
      "systemctl disable --now ferry-paseo.service",
      "systemctl daemon-reload",
    ]);
    expect(existsSync(join(box.home, UNIT_PATH))).toBe(false);
    expect(existsSync(join(box.home, ".paseo/config.json"))).toBe(true);
    expect(lines).toEqual([
      "Stopped ferry-paseo.service and removed ~/.config/systemd/user/ferry-paseo.service. Linger stays on.",
      "Ferry keeps ~/.paseo on the box. It holds the Paseo config, agent state and worktrees.",
    ]);
  });

  test("--purge also uninstalls the CLI and still keeps ~/.paseo", async () => {
    const box = fakeBox();
    touch(join(box.home, ".paseo/config.json"), "{}");

    const lines = await paseoWith("0.9.2").box.disable(box, noProgress, { purge: true });

    expect(box.log()).toEqual([
      "systemctl daemon-reload",
      `npm uninstall -g --prefix ${box.home}/.local @getpaseo/cli`,
    ]);
    expect(existsSync(join(box.home, ".paseo/config.json"))).toBe(true);
    expect(lines).toContain("Removed @getpaseo/cli from ~/.local.");
    expect(lines).toContain("Ferry keeps ~/.paseo on the box. It holds the Paseo config, agent state and worktrees.");
  });
});

describe("Paseo update", () => {
  test("does not install or restart when the box runs the local version", async () => {
    const box = fakeBox();
    activeUnit(box);

    const lines = await paseoWith("0.9.2").box.update(box, noProgress);

    expect(box.log()).toEqual([]);
    expect(lines).toEqual([CURRENT("0.9.2")]);
  });

  test("installs the local version and restarts the unit when the box version differs", async () => {
    const box = fakeBox();
    activeUnit(box);

    const lines = await paseoWith("0.9.3").box.update(box, noProgress);

    expect(box.log()).toEqual([
      `npm install -g --prefix ${box.home}/.local @getpaseo/cli@0.9.3`,
      "systemctl restart ferry-paseo.service",
    ]);
    expect(lines).toEqual(["Paseo 0.9.2 runs on the box."]);
  });

  test("updates with a warning when it cannot read the box version", async () => {
    const box = fakeBox();

    const lines = await paseoWith("0.9.2").box.update(box, noProgress);

    expect(box.log()).toEqual([
      `npm install -g --prefix ${box.home}/.local @getpaseo/cli@0.9.2`,
      "systemctl restart ferry-paseo.service",
    ]);
    expect(lines).toEqual([UNREADABLE, "Paseo 0.9.2 runs on the box."]);
  });

  test("without a local app, compares the box version with the npm latest version", async () => {
    const box = fakeBox();
    activeUnit(box);
    const calls: string[] = [];

    const lines = await paseoUnpinned("0.9.2", calls).box.update(box, noProgress);

    expect(calls).toEqual(["npm view @getpaseo/cli version"]);
    expect(box.log()).toEqual([]);
    expect(lines).toEqual([CURRENT("0.9.2")]);
  });

  test("without a local app, installs the npm latest version when the box version differs", async () => {
    const box = fakeBox();
    activeUnit(box);

    const lines = await paseoUnpinned("0.10.0").box.update(box, noProgress);

    expect(box.log()).toEqual([
      `npm install -g --prefix ${box.home}/.local @getpaseo/cli@0.10.0`,
      "systemctl restart ferry-paseo.service",
    ]);
    expect(lines).toEqual(["Paseo 0.9.2 runs on the box. The version is not pinned."]);
  });

  test("without a local app, installs the latest tag with a warning when npm view fails", async () => {
    const box = fakeBox();
    activeUnit(box);

    const lines = await paseoUnpinned(null).box.update(box, noProgress);

    expect(box.log()).toEqual([
      `npm install -g --prefix ${box.home}/.local @getpaseo/cli@latest`,
      "systemctl restart ferry-paseo.service",
    ]);
    expect(lines).toEqual([
      "Warning: npm view @getpaseo/cli version failed. Ferry installs the npm latest tag and restarts ferry-paseo.service.",
      "Paseo 0.9.2 runs on the box. The version is not pinned.",
    ]);
  });
});

describe("Paseo unit PATH", () => {
  const dirs = [".local/bin", ".pi/agent/bin", ".bun/bin"];

  test("enable writes the PATH directories of the Link into the unit", async () => {
    const box = fakeBox();

    await paseoWith("0.9.2").box.enable(Object.assign(box, { pathDirs: dirs }), noProgress);

    expect(readFileSync(join(box.home, UNIT_PATH), "utf8")).toBe(unitFile(dirs));
  });

  test("rewrites the unit, reloads systemd and restarts the daemon when the PATH changed", async () => {
    const box = fakeBox();
    touch(join(box.home, UNIT_PATH), unitFile(BUILTIN_BOX_PATH_DIRS));

    expect(await refreshUnitPath(box, dirs)).toMatchObject({ detail: "restarted" });

    expect(readFileSync(join(box.home, UNIT_PATH), "utf8")).toBe(unitFile(dirs));
    expect(box.log()).toEqual(["systemctl daemon-reload", "systemctl restart ferry-paseo.service"]);
  });

  test("does not write the unit or restart the daemon when the PATH is current", async () => {
    const box = fakeBox();
    touch(join(box.home, UNIT_PATH), unitFile(dirs));

    expect(await refreshUnitPath(box, dirs)).toEqual({ detail: "no changes", note: null });

    expect(box.log()).toEqual([]);
    expect(box.commands).toHaveLength(1);
  });

  test("refuses when the unit is not on the box", async () => {
    const box = fakeBox();

    await expect(refreshUnitPath(box, dirs)).rejects.toThrow("Run ferry integrations enable paseo");
    expect(box.log()).toEqual([]);
  });
});

describe("Paseo box output", () => {
  // Build the value at run time so this file holds no string a secret scanner flags.
  const SECRET = "box-only-" + "password-" + "q7Zx9";
  const dirs = [".local/bin", ".pi/agent/bin", ".bun/bin"];
  /** A unit with an `Environment=` line that the operator added on the box by hand. */
  const withSecret = (unit: string) =>
    unit.replace("Restart=on-failure", `Environment=DATABASE_PASSWORD=${SECRET}\nRestart=on-failure`);
  /** All that Ferry sends to the box and gets back. */
  const crossed = (box: FakeBox) => JSON.stringify({ commands: box.commands, outputs: box.outputs });

  test("the unit never reaches Ferry when the PATH is current", async () => {
    const box = fakeBox();
    touch(join(box.home, UNIT_PATH), withSecret(unitFile(dirs)));

    expect(await refreshUnitPath(box, dirs)).toEqual({ detail: "no changes", note: null });

    expect(box.outputs).toEqual(["unchanged\n", ""]);
    expect(crossed(box)).not.toContain(SECRET);
    expect(readFileSync(join(box.home, UNIT_PATH), "utf8")).toBe(withSecret(unitFile(dirs)));
    expect(box.log()).toEqual([]);
  });

  test("the unit never reaches Ferry when the PATH changed, and the box keeps each other line", async () => {
    const box = fakeBox();
    touch(join(box.home, UNIT_PATH), withSecret(unitFile(BUILTIN_BOX_PATH_DIRS, true)));

    expect(await refreshUnitPath(box, dirs)).toMatchObject({ detail: "restarted" });

    expect(box.outputs).toEqual(["updated\n", ""]);
    expect(crossed(box)).not.toContain(SECRET);
    expect(readFileSync(join(box.home, UNIT_PATH), "utf8")).toBe(withSecret(unitFile(dirs, true)));
    expect(existsSync(join(box.home, `${UNIT_PATH}.ferry-tmp`))).toBe(false);
    expect(box.log()).toEqual(["systemctl daemon-reload", "systemctl restart ferry-paseo.service"]);
  });

  test("the box adds the PATH line to a unit that has none", async () => {
    const box = fakeBox();
    const unit = withSecret(unitFile(dirs));
    const path = unit.split("\n").find((line) => line.startsWith("Environment=PATH="));
    touch(join(box.home, UNIT_PATH), unit.replace(`${path}\n`, ""));

    expect(await refreshUnitPath(box, dirs)).toMatchObject({ detail: "restarted" });

    expect(readFileSync(join(box.home, UNIT_PATH), "utf8")).toBe(unit.replace(`${path}\n`, "").replace("[Service]\n", `[Service]\n${path}\n`));
    expect(crossed(box)).not.toContain(SECRET);
  });

  test("the box refuses a unit without a [Service] section, and does not restart the daemon", async () => {
    const box = fakeBox();
    const unit = `[Unit]\nEnvironment=DATABASE_PASSWORD=${SECRET}\n`;
    touch(join(box.home, UNIT_PATH), unit);

    await expect(refreshUnitPath(box, dirs)).rejects.toThrow("Ferry could not write the PATH line");

    expect(readFileSync(join(box.home, UNIT_PATH), "utf8")).toBe(unit);
    expect(existsSync(join(box.home, `${UNIT_PATH}.ferry-tmp`))).toBe(false);
    expect(crossed(box)).not.toContain(SECRET);
    expect(box.log()).toEqual([]);
  });

  test("enable never reads an existing unit, replaces it, and restarts the daemon", async () => {
    const box = fakeBox();
    touch(join(box.home, UNIT_PATH), withSecret(unitFile(BUILTIN_BOX_PATH_DIRS)));

    const lines = await paseoWith("0.9.2").box.enable(box, noProgress);

    expect(crossed(box)).not.toContain(SECRET);
    expect(lines.join("\n")).not.toContain(SECRET);
    // Enable writes the whole unit again, so a line that the operator added by hand is gone.
    expect(readFileSync(join(box.home, UNIT_PATH), "utf8")).toBe(unitFile(BUILTIN_BOX_PATH_DIRS));
    expect(box.log()).toContain("systemctl restart ferry-paseo.service");
    expect(lines).toContain("The service config changed, so Ferry restarted the Paseo daemon. The restart stopped its agents.");
  });

  test("enable does not restart the daemon for a new unit or for the same unit", async () => {
    const box = fakeBox();

    await paseoWith("0.9.2").box.enable(box, noProgress);
    await paseoWith("0.9.2").box.enable(box, noProgress);

    expect(box.log()).not.toContain("systemctl restart ferry-paseo.service");
    expect(box.outputs).toContain("created\n");
    expect(box.outputs).toContain("unchanged\n");
  });

  /** A unit that Ferry wrote before it set the OOM policy. */
  const withoutPolicy = (unit: string) => unit.replace("OOMPolicy=continue\n", "");
  const ADDED = "systemd applied the line without a restart of the Paseo daemon. " +
    "When a process of an agent runs out of memory, the daemon and the other agents continue.";

  test("a sync adds the OOM policy line to a unit without it, reloads systemd, and does not restart the daemon", async () => {
    const box = fakeBox();
    touch(join(box.home, UNIT_PATH), withoutPolicy(withSecret(unitFile(dirs, true))));

    expect(await refreshUnitPath(box, dirs)).toEqual({
      detail: "OOMPolicy=continue added, no restart",
      note: `Ferry added OOMPolicy=continue to ferry-paseo.service on the box. ${ADDED}`,
    });

    expect(box.outputs).toEqual(["policy\n", ""]);
    expect(crossed(box)).not.toContain(SECRET);
    // The unit is now the text that enable writes, with the line of the operator.
    expect(readFileSync(join(box.home, UNIT_PATH), "utf8")).toBe(withSecret(unitFile(dirs, true)));
    expect(existsSync(join(box.home, `${UNIT_PATH}.ferry-tmp`))).toBe(false);
    expect(box.log()).toEqual(["systemctl daemon-reload"]);

    expect(await refreshUnitPath(box, dirs)).toEqual({ detail: "no changes", note: null });
    expect(box.log()).toEqual(["systemctl daemon-reload"]);
  });

  test("a sync sets the PATH line and the OOM policy line in one write, with one restart", async () => {
    const box = fakeBox();
    touch(join(box.home, UNIT_PATH), withoutPolicy(withSecret(unitFile(BUILTIN_BOX_PATH_DIRS))));

    expect(await refreshUnitPath(box, dirs)).toMatchObject({ detail: "restarted" });

    expect(readFileSync(join(box.home, UNIT_PATH), "utf8")).toBe(withSecret(unitFile(dirs)));
    expect(box.log()).toEqual(["systemctl daemon-reload", "systemctl restart ferry-paseo.service"]);
  });

  test("a sync keeps the OOMPolicy value that the operator set in the unit or in a drop-in file", async () => {
    for (const own of ["OOMPolicy=stop", "  OOMPolicy = kill"]) {
      const box = fakeBox();
      const unit = withSecret(unitFile(dirs)).replace("OOMPolicy=continue", own);
      touch(join(box.home, UNIT_PATH), unit);

      expect(await refreshUnitPath(box, dirs)).toEqual({ detail: "no changes", note: null });

      expect(readFileSync(join(box.home, UNIT_PATH), "utf8")).toBe(unit);
      expect(box.log()).toEqual([]);
    }
    // systemd reads a drop-in file after the unit, so its value has priority. Ferry does not change the file.
    const box = fakeBox();
    const dropIn = join(box.home, `${UNIT_PATH}.d/local.conf`);
    touch(dropIn, "[Service]\nOOMPolicy=stop\n");
    touch(join(box.home, UNIT_PATH), withoutPolicy(unitFile(dirs)));

    await refreshUnitPath(box, dirs);

    expect(readFileSync(dropIn, "utf8")).toBe("[Service]\nOOMPolicy=stop\n");
    expect(box.log()).toEqual(["systemctl daemon-reload"]);
  });

  test("enable adds the OOM policy line to an existing unit and does not restart the daemon", async () => {
    const box = fakeBox();
    touch(join(box.home, UNIT_PATH), withoutPolicy(unitFile(BUILTIN_BOX_PATH_DIRS)));

    const lines = await paseoWith("0.9.2").box.enable(box, noProgress);

    expect(box.outputs).toContain("policy\n");
    expect(readFileSync(join(box.home, UNIT_PATH), "utf8")).toBe(unitFile(BUILTIN_BOX_PATH_DIRS));
    expect(box.log()).toContain("systemctl daemon-reload");
    expect(box.log()).not.toContain("systemctl restart ferry-paseo.service");
    expect(lines).toContain(`Ferry added OOMPolicy=continue to ferry-paseo.service. ${ADDED}`);
  });

  test("enable restarts the daemon when the unit differs by the OOM policy line and by another line", async () => {
    const box = fakeBox();
    touch(join(box.home, UNIT_PATH), withoutPolicy(unitFile(BUILTIN_BOX_PATH_DIRS, true)));

    await paseoWith("0.9.2").box.enable(box, noProgress);

    expect(box.outputs).toContain("changed\n");
    expect(box.log()).toContain("systemctl restart ferry-paseo.service");
  });

  test("enable does not restart the daemon after a sync added the OOM policy line", async () => {
    const box = fakeBox();
    touch(join(box.home, UNIT_PATH), withoutPolicy(unitFile(BUILTIN_BOX_PATH_DIRS)));

    await refreshUnitPath(box, BUILTIN_BOX_PATH_DIRS);
    await paseoWith("0.9.2").box.enable(box, noProgress);

    expect(box.outputs).toContain("unchanged\n");
    expect(box.log()).not.toContain("systemctl restart ferry-paseo.service");
  });

  test("the output of paseo daemon status and paseo daemon reload stays on the box", async () => {
    const box = fakeBox();
    touch(join(box.state, "active-ferry-paseo.service"));
    writeFileSync(join(box.state, "status"), JSON.stringify({ localDaemon: "running", providers: [{ provider: "claude", available: true }] }));
    writeFileSync(join(box.state, "noise"), `token=${SECRET}\n`);

    if (Bun.which("jq") !== null) {
      const carry = await carryAgentProfiles(box, [{ id: "p1", name: "Reviewer", provider: "claude" }]);
      expect(carry.changed).toBe(true);
      expect(box.log()).toEqual(["paseo daemon reload"]);
    }
    await paseoWith("0.9.2").box.update(box, noProgress);

    expect(crossed(box)).not.toContain(SECRET);
  });

  test("a failed npm install shows only the npm error code", async () => {
    const box = fakeBox();
    writeFileSync(join(box.state, "npm-fail"), `npm error code E401\nnpm error 401 https://user:${SECRET}@registry.example/\n`);

    const error = await paseoWith("0.9.2").box.enable(box, noProgress).catch(String);

    expect(error).toBe(
      'PaseoError: The Paseo install failed. Run npm install -g --prefix "$HOME/.local" @getpaseo/cli@0.9.2 on the box to see the npm output: npm error code E401',
    );
    expect(crossed(box)).not.toContain(SECRET);
  });

  test("a moved project and its sessions go to Paseo, and the box answers with a status word", async () => {
    const box = fakeBox();
    writeFileSync(join(box.state, "noise"), `token=${SECRET}\n`);
    writeFileSync(join(box.state, "fail-import-known"), `Error: Failed to import agent: Provider session is already imported: known ${SECRET}\n`);

    await createPaseo().box.onProjectMoved(box, "~/Developer/it's", [
      { provider: "claude", id: "known" },
      { provider: "codex", id: "it's" },
    ]);

    const app = join(box.home, "Developer/it's");
    expect(box.log()).toEqual([
      `paseo project create ${app}`,
      `paseo import known --provider claude --cwd ${app}`,
      `paseo import it's --provider codex --cwd ${app}`,
    ]);
    expect(box.outputs).toEqual(["ok\n", "", "duplicate\n", "", "ok\n", ""]);
    expect(crossed(box)).not.toContain(SECRET);
  });

  test("a failed import gives a fixed message, and the paseo output stays on the box", async () => {
    const box = fakeBox();
    writeFileSync(join(box.state, "fail-import-broken"), `Error: no session in ${SECRET}\n`);

    const error = await createPaseo().box.onProjectMoved(box, "~/app", [
      { provider: "codex", id: "broken" },
      { provider: "claude", id: "new" },
    ]).catch(String);

    expect(error).toBe(
      `Error: paseo import failed for codex session broken (Paseo printed an error. Run paseo import 'broken' --provider 'codex' --cwd "$HOME"/'app' on the box to see it)`,
    );
    expect(box.log()).toHaveLength(3);
    expect(crossed(box)).not.toContain(SECRET);
  });

  test("a failed project create names a directory that Paseo did not find, and else gives a fixed message", async () => {
    const box = fakeBox();
    writeFileSync(join(box.state, "fail-project"), join(box.home, "app"));
    writeFileSync(join(box.state, "fail-output"), `Error: directory_not_found ${SECRET}\n`);

    await expect(createPaseo().box.onProjectMoved(box, "~/app", [{ provider: "claude", id: "1a2b" }])).rejects.toThrow(
      "paseo project create failed: Paseo did not find the directory on the box (directory_not_found)",
    );
    expect(box.log()).toHaveLength(1);

    writeFileSync(join(box.state, "fail-output"), `Error: ${SECRET}\n`);
    const error = await createPaseo().box.onProjectMoved(box, "~/app", []).catch(String);
    expect(error).toBe(
      `Error: paseo project create failed: Paseo printed an error. Run paseo project create "$HOME"/'app' on the box to see it`,
    );
    expect(crossed(box)).not.toContain(SECRET);
  });
});

describe("Paseo plan", () => {
  test("lists the exact enable commands and connects to nothing", async () => {
    const lines = await paseoWith("0.9.2").box.plan("enable");

    expect(lines[0]).toMatch(/^Local app: Paseo 0\.9\.2 \(/);
    expect(lines).toContain('  npm install -g --prefix "$HOME/.local" @getpaseo/cli@0.9.2');
    expect(lines).toContain("  systemctl --user daemon-reload && systemctl --user enable --now ferry-paseo.service");
    expect(lines).toContain(
      '  [ "$(loginctl show-user "$USER" -p Linger --value 2>/dev/null)" = yes ] || loginctl enable-linger "$USER" 2>/dev/null || sudo -n loginctl enable-linger "$USER"',
    );
    expect(lines).toContain("  #   Environment=PASEO_RELAY_ENABLED=false");
    expect(lines.at(-1)).toBe("Config: set [integrations] paseo = true after the box steps succeed.");
  });

  test("the disable plan adds the uninstall only for purge", async () => {
    const paseo = paseoWith("0.9.2");
    const uninstall = '  npm uninstall -g --prefix "$HOME/.local" @getpaseo/cli';

    expect(await paseo.box.plan("disable")).not.toContain(uninstall);
    expect(await paseo.box.plan("purge")).toContain(uninstall);
  });

  test("the enable, disable and purge plans make no box call, also with a link", async () => {
    const box = fakeBox();
    const paseo = paseoWith("0.9.2");

    await paseo.box.plan("enable", box);
    await paseo.box.plan("disable", box);
    await paseo.box.plan("purge", box);

    expect(box.commands).toEqual([]);
  });

  test("the update plan shows the skip when the box runs the local version, and changes nothing", async () => {
    const box = fakeBox();
    activeUnit(box);

    const lines = await paseoWith("0.9.2").box.plan("update", box);

    expect(lines.slice(1)).toEqual([CURRENT("0.9.2")]);
    expect(box.log()).toEqual([]);
  });

  test("the update plan shows the box commands when the box version differs", async () => {
    const box = fakeBox();
    activeUnit(box);

    const lines = await paseoWith("0.9.3").box.plan("update", box);

    expect(lines.slice(1)).toEqual([
      "Box: Paseo 0.9.2",
      "Box commands:",
      '  npm install -g --prefix "$HOME/.local" @getpaseo/cli@0.9.3',
      "  systemctl --user restart ferry-paseo.service",
      "  systemctl --user is-active --quiet ferry-paseo.service && paseo daemon status --json 2>/dev/null",
      "The restart stops the agents that run on the box.",
    ]);
    expect(box.log()).toEqual([]);
  });

  test("the update plan warns when it cannot read the box version", async () => {
    const box = fakeBox();

    const lines = await paseoWith("0.9.2").box.plan("update", box);

    expect(lines[1]).toBe(UNREADABLE);
    expect(lines).toContain("  systemctl --user restart ferry-paseo.service");
  });
});

describe("Paseo agent profiles", () => {
  // Build the value at run time so this file holds no string a secret scanner flags.
  const secret = "hunter" + "2-" + "q7Z";
  const claude = { id: "p1", name: "Reviewer", provider: "claude", model: "opus" };
  const codex = { id: "p2", name: "Builder", provider: "codex", model: "gpt" };
  const copilot = { id: "p3", name: "Pilot", provider: "copilot", model: "any" };

  function operatorHome(config: unknown): string {
    const home = mkdtempSync(join(tmpdir(), "ferry-paseo-home-"));
    roots.push(home);
    if (config !== undefined) touch(join(home, ".paseo/config.json"), JSON.stringify(config));
    return home;
  }

  function runningBox(providers: readonly { provider: string; available: boolean }[]): FakeBox {
    const box = fakeBox();
    touch(join(box.state, "active-ferry-paseo.service"));
    writeFileSync(join(box.state, "status"), JSON.stringify({ localDaemon: "running", providers }));
    return box;
  }

  test("reads only daemon.agentProfiles from the local config", () => {
    const home = operatorHome({
      daemon: { listen: "127.0.0.1:6767", auth: { password: secret }, agentProfiles: [claude, codex] },
      providers: { openai: { apiKey: secret } },
      agents: { providers: { claude: { env: { KEY: secret } } } },
    });

    expect(readAgentProfiles(home)).toEqual([claude, codex]);
  });

  test("returns no profiles when the local config or the key is missing", () => {
    expect(readAgentProfiles(operatorHome(undefined))).toEqual([]);
    expect(readAgentProfiles(operatorHome({ daemon: { listen: "127.0.0.1:6767" } }))).toEqual([]);
  });

  test("refuses the carry and names each profile with an env block or a secret, never the value", () => {
    const home = operatorHome({
      daemon: {
        agentProfiles: [
          claude,
          { ...codex, env: { MODE: "fast" } },
          { ...copilot, notes: "use it", apiKey: secret },
        ],
      },
    });

    let error: unknown;
    try {
      readAgentProfiles(home);
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(Error);
    const message = (error as Error).message;
    expect(message).toContain("Builder");
    expect(message).toContain("env");
    expect(message).toContain("Pilot");
    expect(message).toContain("key apiKey holds a password or secret");
    expect(message).not.toContain("Reviewer");
    expect(message).not.toContain(secret);
  });

  test("refuses a profile with a token in a value", () => {
    const token = "gh" + "p_" + "A".repeat(36);
    const home = operatorHome({ daemon: { agentProfiles: [{ ...claude, notes: `use ${token}` }] } });

    expect(() => readAgentProfiles(home)).toThrow("Reviewer");
  });

  jqTest("merges the profiles into the box config, keeps other keys, skips a missing provider, and reloads", async () => {
    const box = runningBox([
      { provider: "claude", available: true },
      { provider: "codex", available: true },
      { provider: "copilot", available: false },
    ]);
    touch(join(box.home, ".paseo/config.json"), JSON.stringify({ version: 1, daemon: { listen: "127.0.0.1:6767", agentProfiles: [{ id: "old" }] }, app: { baseUrl: "x" } }));

    const result = await carryAgentProfiles(box, [claude, codex, copilot]);

    expect(result).toEqual({
      carried: ["Reviewer", "Builder"],
      warnings: ["Paseo agent profile Pilot was not carried: provider copilot is not available on the box."],
      changed: true,
    });
    expect(JSON.parse(readFileSync(join(box.home, ".paseo/config.json"), "utf8"))).toEqual({
      version: 1,
      daemon: { listen: "127.0.0.1:6767", agentProfiles: [claude, codex] },
      app: { baseUrl: "x" },
    });
    expect(box.log()).toEqual(["paseo daemon reload"]);
  });

  jqTest("skips a profile whose provider the box does not list", async () => {
    const box = runningBox([{ provider: "claude", available: true }]);

    const result = await carryAgentProfiles(box, [claude, { ...codex, provider: "custom" }]);

    expect(result.warnings).toEqual([
      "Paseo agent profile Builder was not carried: provider custom is not available on the box.",
    ]);
    expect(JSON.parse(readFileSync(join(box.home, ".paseo/config.json"), "utf8"))).toEqual({
      daemon: { agentProfiles: [claude] },
    });
  });

  jqTest("writes nothing and does not reload when the box already has the profiles", async () => {
    const box = runningBox([{ provider: "claude", available: true }]);
    const text = JSON.stringify({ daemon: { agentProfiles: [claude] } });
    touch(join(box.home, ".paseo/config.json"), text);

    const result = await carryAgentProfiles(box, [claude]);

    expect(result.changed).toBe(false);
    expect(box.log()).toEqual([]);
    expect(readFileSync(join(box.home, ".paseo/config.json"), "utf8")).toBe(text);
  });

  test("with no profiles, it does nothing on the box", async () => {
    const box = runningBox([]);

    expect(await carryAgentProfiles(box, [])).toEqual({ carried: [], warnings: [], changed: false });
    expect(box.commands).toEqual([]);
  });

  test("fails and writes nothing when the daemon does not run", async () => {
    const box = fakeBox();

    await expect(carryAgentProfiles(box, [claude])).rejects.toThrow("providers");
    expect(existsSync(join(box.home, ".paseo/config.json"))).toBe(false);
  });
});

describe("Paseo preferences", () => {
  const claude = { provider: "claude", model: "haiku" };
  const codex = { provider: "codex", model: "mini", thinkingOptionId: "low" };
  const config = (box: FakeBox) => JSON.parse(readFileSync(join(box.home, ".paseo/config.json"), "utf8"));

  function runningBox(providers: readonly { provider: string; available: boolean }[]): FakeBox {
    const box = fakeBox();
    touch(join(box.state, "active-ferry-paseo.service"));
    writeFileSync(join(box.state, "status"), JSON.stringify({ localDaemon: "running", providers }));
    return box;
  }

  jqTest("sets only the two fields, keeps other box keys, skips a missing provider, and reloads", async () => {
    const box = runningBox([
      { provider: "claude", available: true },
      { provider: "codex", available: false },
    ]);
    touch(join(box.home, ".paseo/config.json"), JSON.stringify({
      version: 1,
      daemon: { listen: "127.0.0.1:6767", agentProfiles: [{ id: "keep" }] },
      agents: { providers: { claude: { enabled: true } }, metadataGeneration: { providers: [{ provider: "pi" }] } },
    }));

    const result = await carryPaseoPreferences(box, { metadataProviders: [claude, codex], appendSystemPrompt: "Be brief." });

    expect(result).toEqual({
      warnings: ["Paseo metadata provider codex was not carried: it is not available on the box."],
      changed: true,
    });
    expect(config(box)).toEqual({
      version: 1,
      daemon: { listen: "127.0.0.1:6767", agentProfiles: [{ id: "keep" }], appendSystemPrompt: "Be brief." },
      agents: { providers: { claude: { enabled: true } }, metadataGeneration: { providers: [claude] } },
    });
    expect(box.log()).toEqual(["paseo daemon reload"]);
  });

  test("keeps the box list when no local metadata provider is available on the box", async () => {
    const box = runningBox([{ provider: "claude", available: false }]);
    touch(join(box.home, ".paseo/config.json"), JSON.stringify({ agents: { metadataGeneration: { providers: [{ provider: "pi" }] } } }));

    const result = await carryPaseoPreferences(box, { metadataProviders: [claude] });

    expect(result.changed).toBe(false);
    expect(result.warnings).toContain("Ferry kept the box agents.metadataGeneration.providers, because no local metadata provider is available on the box.");
    expect(config(box).agents.metadataGeneration.providers).toEqual([{ provider: "pi" }]);
    expect(box.log()).toEqual([]);
  });

  jqTest("explicit empty values clear the box values without a provider check", async () => {
    const box = fakeBox();
    touch(join(box.home, ".paseo/config.json"), JSON.stringify({
      daemon: { appendSystemPrompt: "Old." },
      agents: { metadataGeneration: { providers: [{ provider: "pi" }] } },
    }));

    expect(await carryPaseoPreferences(box, { metadataProviders: [], appendSystemPrompt: "" })).toEqual({ warnings: [], changed: true });
    expect(config(box)).toEqual({ daemon: { appendSystemPrompt: "" }, agents: { metadataGeneration: { providers: [] } } });
    expect(box.commands.some((command) => command.includes("daemon status"))).toBe(false);
  });

  test("with no local fields, it does nothing on the box", async () => {
    const box = runningBox([]);

    expect(await carryPaseoPreferences(box, {})).toEqual({ warnings: [], changed: false });
    expect(box.commands).toEqual([]);
  });

  jqTest("writes nothing and does not reload when the box already has the values", async () => {
    const box = fakeBox();
    touch(join(box.home, ".paseo/config.json"), `${JSON.stringify({ daemon: { appendSystemPrompt: "Be brief." } }, null, 2)}\n`);

    expect((await carryPaseoPreferences(box, { appendSystemPrompt: "Be brief." })).changed).toBe(false);
    expect(box.log()).toEqual([]);
  });

  jqTest("fails without the instruction text when the box config is not an object", async () => {
    const box = fakeBox();
    touch(join(box.home, ".paseo/config.json"), JSON.stringify({ agents: [] }));

    const error = await carryPaseoPreferences(box, { appendSystemPrompt: "Private rule." }).catch((caught: unknown) => caught);
    expect(String(error)).toContain("agents");
    expect(String(error)).not.toContain("Private rule.");
    expect(box.log()).toEqual([]);
  });
});
