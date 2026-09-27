import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createPaseo, UNIT_FILE } from "../src/integrations/paseo.ts";
import type { HostAdapter, LinkResult } from "../src/link.ts";
import { noProgress } from "../src/progress.ts";

/**
 * A fake box. Each Link command runs in `sh` with a temporary HOME and fake
 * `systemctl`, `loginctl`, `node`, `npm`, `sudo`, `apt` and `paseo` commands.
 * Each fake command writes its arguments to the log. Files in `state` hold the
 * unit states and the Node version.
 */
type FakeBox = {
  readonly home: string;
  readonly state: string;
  readonly commands: string[];
  log(): string[];
  run(command: string): Promise<LinkResult>;
};

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const FAKES: Record<string, string> = {
  systemctl: `
[ "$1" = --user ] && shift
case "$1" in
  is-active) [ -e "$STATE/active-$3" ]; exit ;;
  is-enabled) [ -e "$STATE/enabled-$3" ]; exit ;;
esac
echo "systemctl $*" >> "$LOG"
case "$1" in
  disable) unit=$2; [ "$2" = --now ] && unit=$3; rm -f "$STATE/enabled-$unit"; [ "$2" = --now ] && rm -f "$STATE/active-$unit" ;;
  enable) touch "$STATE/enabled-$3" "$STATE/active-$3" ;;
  restart) touch "$STATE/active-$2" ;;
esac
exit 0`,
  loginctl: 'echo "loginctl $*" >> "$LOG"',
  sudo: '"$@"',
  apt: `echo "apt $*" >> "$LOG"
[ "$1" = install ] && [ -e "$STATE/apt-node" ] && cp "$STATE/apt-node" "$STATE/node"
exit 0`,
  node: `case "$1" in
  --version) cat "$STATE/node" ;;
  -e) major=$(sed 's/^v\\([0-9]*\\).*/\\1/' "$STATE/node"); [ "$major" -ge 22 ] ;;
esac`,
  npm: 'echo "npm $*" >> "$LOG"',
  paseo: `case "$1 $2" in
  "daemon status") echo '{"localDaemon":"running","daemonVersion":"0.9.2","listen":"127.0.0.1:6767"}' ;;
  "project create") echo "paseo project create $3" >> "$LOG"; [ "$3" != "$(cat "$STATE/fail-project" 2>/dev/null)" ] ;;
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
  return {
    home,
    state,
    commands,
    log: () => readFileSync(logPath, "utf8").split("\n").filter((line) => line !== ""),
    async run(command) {
      commands.push(command);
      const process = Bun.spawn(["sh", "-c", `export PATH="${bin}:$PATH"; ${command}`], {
        cwd: home,
        env: { ...Bun.env, HOME: home, USER: "ploi", STATE: state, LOG: logPath },
        stdout: "pipe",
        stderr: "pipe",
      });
      const [stdout, stderr, exitCode] = await Promise.all([
        new Response(process.stdout).text(),
        new Response(process.stderr).text(),
        process.exited,
      ]);
      return exitCode === 0
        ? { ok: true, address: "box", stdout, stderr }
        : { ok: false, error: { code: "command-failed", origin: "box", message: stderr.trim() || `exit ${exitCode}` } };
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

    const lines = await paseoWith("0.9.2").enable(box, noProgress);

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
    expect(readFileSync(join(box.home, UNIT_PATH), "utf8")).toBe(UNIT_FILE);
    expect(lines).toEqual([
      "Registered 2 of 2 box projects in Paseo.",
      "Paseo 0.9.2 runs on the box at 127.0.0.1:6767. The relay is off.",
    ]);
  });

  test("the unit runs the daemon in the foreground with the Link PATH, loopback listen and no relay", () => {
    expect(UNIT_FILE).toContain("Type=simple\n");
    expect(UNIT_FILE).toContain("ExecStart=%h/.local/bin/paseo daemon run\n");
    expect(UNIT_FILE).toContain(
      "Environment=PATH=%h/.local/bin:%h/.pi/agent/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin\n",
    );
    expect(UNIT_FILE).toContain("Environment=PASEO_LISTEN=127.0.0.1:6767\n");
    expect(UNIT_FILE).toContain("Environment=PASEO_RELAY_ENABLED=false\n");
    expect(UNIT_FILE).toContain("Restart=on-failure\nRestartSec=5\n");
    expect(UNIT_FILE).toContain("[Install]\nWantedBy=default.target\n");
  });

  test("installs the npm latest tag and says so when there is no local app", async () => {
    const box = fakeBox();

    const lines = await paseoWith(null).enable(box, noProgress);

    expect(box.log()[0]).toBe(`npm install -g --prefix ${box.home}/.local @getpaseo/cli@latest`);
    expect(lines[0]).toBe("No local Paseo app. Ferry installs the npm latest tag. The version is not pinned.");
  });

  test("runs the shared Node bootstrap when the box Node is older than 22", async () => {
    const box = fakeBox();
    writeFileSync(join(box.state, "node"), "v18.19.1\n");
    writeFileSync(join(box.state, "apt-node"), "v22.9.0\n");

    await paseoWith("0.9.2").enable(box, noProgress);

    expect(box.log().slice(0, 3)).toEqual([
      "apt update",
      "apt install nodejs npm -y",
      `npm install -g --prefix ${box.home}/.local @getpaseo/cli@0.9.2`,
    ]);
  });

  test("stops with a clear message and installs nothing when the bootstrap leaves an old Node", async () => {
    const box = fakeBox();
    writeFileSync(join(box.state, "node"), "v18.19.1\n");

    await expect(paseoWith("0.9.2").enable(box, noProgress)).rejects.toThrow(
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

    const lines = await paseoWith("0.9.2").enable(box, noProgress);

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
    expect(await paseoWith("0.9.2").enable(stopped, noProgress)).toContain(
      "Disabled the old paseo.service. The file ~/.config/systemd/user/paseo.service stays.",
    );
    expect(stopped.log()).toContain("systemctl disable paseo.service");

    const clean = fakeBox();
    await paseoWith("0.9.2").enable(clean, noProgress);
    expect(clean.log().some((line) => line.includes(" paseo.service"))).toBe(false);
  });

  test("warns about a project that Paseo refuses and still succeeds", async () => {
    const box = fakeBox();
    mkdirSync(join(box.home, "app/.git"), { recursive: true });
    writeFileSync(join(box.state, "fail-project"), join(box.home, "app"));

    const lines = await paseoWith("0.9.2").enable(box, noProgress);

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

    await expect(paseo.enable(link, noProgress)).rejects.toThrow(
      "The Paseo daemon did not report running within 3 s (localDaemon is stopped).",
    );
    expect(statuses).toHaveLength(4);
  });
});

describe("Paseo disable", () => {
  test("stops and removes the unit, keeps linger, the CLI and ~/.paseo", async () => {
    const box = fakeBox();
    await paseoWith("0.9.2").enable(box, noProgress);
    touch(join(box.home, ".paseo/config.json"), "{}");
    const before = box.log().length;

    const lines = await paseoWith("0.9.2").disable(box, noProgress, { purge: false });

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

    const lines = await paseoWith("0.9.2").disable(box, noProgress, { purge: true });

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
  test("installs the local version and restarts the unit", async () => {
    const box = fakeBox();

    const lines = await paseoWith("0.9.3").update(box, noProgress);

    expect(box.log()).toEqual([
      `npm install -g --prefix ${box.home}/.local @getpaseo/cli@0.9.3`,
      "systemctl restart ferry-paseo.service",
    ]);
    expect(lines).toEqual(["Paseo 0.9.2 runs on the box."]);
  });
});

describe("Paseo plan", () => {
  test("lists the exact enable commands and connects to nothing", async () => {
    const lines = await paseoWith("0.9.2").plan("enable");

    expect(lines[0]).toMatch(/^Local app: Paseo 0\.9\.2 \(/);
    expect(lines).toContain('  npm install -g --prefix "$HOME/.local" @getpaseo/cli@0.9.2');
    expect(lines).toContain("  systemctl --user daemon-reload && systemctl --user enable --now ferry-paseo.service && loginctl enable-linger \"$USER\"");
    expect(lines).toContain("  #   Environment=PASEO_RELAY_ENABLED=false");
    expect(lines.at(-1)).toBe("Config: set [integrations] paseo = true after the box steps succeed.");
  });

  test("the disable plan adds the uninstall only for purge", async () => {
    const paseo = paseoWith("0.9.2");
    const uninstall = '  npm uninstall -g --prefix "$HOME/.local" @getpaseo/cli';

    expect(await paseo.plan("disable")).not.toContain(uninstall);
    expect(await paseo.plan("purge")).toContain(uninstall);
  });
});
