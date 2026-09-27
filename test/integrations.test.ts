import { afterEach, describe, expect, test } from "bun:test";
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { PartialOperatorConfig } from "../src/config.ts";
import { INTEGRATIONS, integrationLines } from "../src/integrations/index.ts";
import { createPaseo, paseoSourceHint } from "../src/integrations/paseo.ts";
import type { Integration, IntegrationLink } from "../src/integrations/types.ts";
import { BunHostAdapter, type HostAdapter, type HostCommand, type LinkResult } from "../src/link.ts";
import { noProgress } from "../src/progress.ts";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function tempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "ferry-integrations-"));
  roots.push(root);
  return root;
}

function touch(path: string, body = ""): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, body);
}

/** Answers `<cli> --version` with `cli` and `plutil` with `plutil`, and records each argv. */
function fakeHost(
  cli: { stdout: string; exitCode?: number },
  plutil: { stdout: string; exitCode?: number } = { stdout: "", exitCode: 1 },
): HostAdapter & { calls: string[][] } {
  const calls: string[][] = [];
  return {
    calls,
    async run(command: HostCommand) {
      calls.push([...command.argv]);
      const answer = command.argv[0] === "plutil" ? plutil : cli;
      return { exitCode: answer.exitCode ?? 0, stdout: answer.stdout, stderr: "", timedOut: false };
    },
  };
}

const BINARY_PLIST = join(import.meta.dir, "fixtures/binary-Info.plist");

const CONFIG: PartialOperatorConfig = {
  version: 1,
  publisher: "operator",
  snapshotUrl: "snapshot.git",
  host: { transport: "ssh", destination: "ploi@box" },
};

describe("Paseo local version", () => {
  test("reads the version from the CLI in the macOS app", async () => {
    const app = join(tempRoot(), "Paseo.app");
    const cli = join(app, "Contents/Resources/bin/paseo");
    touch(cli);
    copyFileSync(BINARY_PLIST, join(app, "Contents/Info.plist"));
    const host = fakeHost({ stdout: "0.9.2\n" });

    const version = await createPaseo({ platform: "darwin", macApp: app, host }).localVersion();

    expect(version).toEqual({ version: "0.9.2", source: cli });
    expect(host.calls).toEqual([[cli, "--version"]]);
  });

  test("reads the Info.plist of the macOS app with plutil when the CLI fails", async () => {
    const app = join(tempRoot(), "Paseo.app");
    const cli = join(app, "Contents/Resources/bin/paseo");
    const plist = join(app, "Contents/Info.plist");
    touch(cli);
    copyFileSync(BINARY_PLIST, plist);
    const host = fakeHost({ stdout: "", exitCode: 1 }, { stdout: "0.9.1\n" });

    const version = await createPaseo({ platform: "darwin", macApp: app, host }).localVersion();

    expect(version).toEqual({ version: "0.9.1", source: plist });
    expect(host.calls).toEqual([
      [cli, "--version"],
      ["plutil", "-extract", "CFBundleShortVersionString", "raw", "-o", "-", plist],
    ]);
  });

  test.skipIf(process.platform !== "darwin")("reads a binary Info.plist with the real plutil", async () => {
    const app = join(tempRoot(), "Paseo.app");
    const plist = join(app, "Contents/Info.plist");
    mkdirSync(dirname(plist), { recursive: true });
    copyFileSync(BINARY_PLIST, plist);

    const version = await createPaseo({ platform: "darwin", macApp: app, host: new BunHostAdapter() })
      .localVersion();

    expect(version).toEqual({ version: "0.9.2", source: plist });
  });

  test("reads the version from the CLI in the Linux install directory", async () => {
    const installDir = join(tempRoot(), "Paseo");
    const cli = join(installDir, "resources/bin/paseo");
    touch(cli);
    const host = fakeHost({ stdout: "paseo 0.10.0-beta.1\n" });

    const version = await createPaseo({ platform: "linux", linuxInstallDir: installDir, host })
      .localVersion();

    expect(version).toEqual({ version: "0.10.0-beta.1", source: cli });
    expect(host.calls).toEqual([[cli, "--version"]]);
  });

  test("returns no version and runs nothing when there is no local app", async () => {
    const root = tempRoot();
    const host = fakeHost({ stdout: "0.9.2\n" }, { stdout: "0.9.2\n" });

    expect(
      await createPaseo({ platform: "darwin", macApp: join(root, "Paseo.app"), host }).localVersion(),
    ).toEqual({ version: null, source: null });
    expect(
      await createPaseo({ platform: "linux", linuxInstallDir: join(root, "Paseo"), host }).localVersion(),
    ).toEqual({ version: null, source: null });
    expect(host.calls).toEqual([]);
  });
});

describe("Paseo integration", () => {
  test("the registry has Paseo only", () => {
    expect(INTEGRATIONS.map((integration) => integration.id)).toEqual(["paseo"]);
  });

  test("connect steps name the Desktop settings and the box destination", () => {
    expect(createPaseo().connectSteps("ploi@box")).toEqual([
      "Open Paseo Desktop.",
      "Open Settings → Add host → Remote SSH.",
      "Enter ssh://ploi@box.",
    ]);
  });

  test("connect steps keep an ssh:// destination with its port", () => {
    expect(createPaseo().connectSteps("ssh://user@box.example:2222")).toContain(
      "Enter ssh://user@box.example:2222.",
    );
  });

  test("connect steps put an IPv6 host in brackets", () => {
    expect(createPaseo().connectSteps("user@fd7a:115c:a1e0::1")).toContain(
      "Enter ssh://user@[fd7a:115c:a1e0::1].",
    );
    expect(createPaseo().connectSteps("fd7a:115c:a1e0::1")).toContain(
      "Enter ssh://[fd7a:115c:a1e0::1].",
    );
  });

  test("the box steps are not implemented in this release", async () => {
    const paseo = createPaseo();
    const link = { run: async () => { throw new Error("no box call"); } };

    await expect(paseo.plan(link)).rejects.toThrow("not implemented in this release");
    await expect(paseo.enable(link, noProgress)).rejects.toThrow("not implemented in this release");
    await expect(paseo.disable(link, noProgress, { purge: true })).rejects.toThrow(
      "not implemented in this release",
    );
    await expect(paseo.update(link, noProgress)).rejects.toThrow("not implemented in this release");
  });
});

/** The daemon status of Paseo 0.9.2 on a box, without `serverId`, `hostname` and the paths. */
const DAEMON_STATUS = {
  pid: 142930,
  listen: "127.0.0.1:6767",
  configuredListen: "127.0.0.1:6767",
  localDaemon: "running",
  desktopManaged: false,
  daemonVersion: "0.9.2",
  providers: [
    { provider: "claude", available: true, error: null },
    { provider: "copilot", available: false, error: null },
  ],
  relay: { enabled: false, endpoint: "relay.paseo.sh:443" },
  connectedDaemon: "reachable",
};

type BoxState = {
  active?: string;
  enabled?: string;
  oldActive?: string;
  /** The stdout of `paseo daemon status --json`, or null when `paseo` is not on PATH. */
  status?: string | null;
};

/** Answers the health command as `sh` on the box would, and records each command. */
function boxLink(state: BoxState | LinkResult): IntegrationLink & { commands: string[] } {
  const commands: string[] = [];
  return {
    commands,
    async run(command) {
      commands.push(command);
      if ("ok" in state) return state;
      const status = state.status === undefined ? JSON.stringify(DAEMON_STATUS) : state.status;
      const stdout = [
        `active=${state.active ?? "active"}`,
        `enabled=${state.enabled ?? "enabled"}`,
        `old=${state.oldActive ?? "inactive"}`,
        ...(status === null ? ["missing"] : ["ferry-section", status]),
      ].join("\n");
      return { ok: true, address: "100.64.0.8", stdout: `${stdout}\n`, stderr: "" };
    },
  };
}

/** A Paseo integration with a local app at `version`, or no local app. */
function paseoWithApp(version: string | null): Integration {
  if (version === null) return createPaseo({ platform: "win32" });
  const app = join(tempRoot(), "Paseo.app");
  touch(join(app, "Contents/Resources/bin/paseo"));
  return createPaseo({ platform: "darwin", macApp: app, host: fakeHost({ stdout: `${version}\n` }) });
}

function daemonStatus(change: Record<string, unknown>): string {
  return JSON.stringify({ ...DAEMON_STATUS, ...change });
}

describe("Paseo health", () => {
  test("reports a running daemon with the same version as the local app", async () => {
    const link = boxLink({});

    const health = await paseoWithApp("0.9.2").health(link);

    expect(health.lines).toEqual([
      "Service: ferry-paseo.service active, enabled",
      "Daemon: running, reachable",
      "Version: box 0.9.2, local app 0.9.2",
      "Listen: 127.0.0.1:6767, relay off",
      "Providers: claude available, copilot unavailable",
    ]);
    expect(health.warnings).toEqual([]);
    expect(health.json).toEqual({
      installed: true,
      service: { unit: "ferry-paseo.service", active: "active", enabled: "enabled" },
      oldService: { unit: "paseo.service", active: "inactive" },
      localDaemon: "running",
      connectedDaemon: "reachable",
      daemonVersion: "0.9.2",
      localVersion: "0.9.2",
      pinned: true,
      listen: "127.0.0.1:6767",
      relay: false,
      providers: [
        { provider: "claude", available: true },
        { provider: "copilot", available: false },
      ],
      error: null,
    });
    expect(link.commands).toHaveLength(1);
    expect(link.commands[0]).toContain("systemctl --user is-active ferry-paseo.service");
    expect(link.commands[0]).toContain("systemctl --user is-enabled ferry-paseo.service");
    expect(link.commands[0]).toContain("systemctl --user is-active paseo.service");
    expect(link.commands[0]).toContain("paseo daemon status --json");
  });

  test("warns when the daemon is stopped", async () => {
    const link = boxLink({
      active: "inactive",
      status: daemonStatus({ localDaemon: "stopped", connectedDaemon: "unreachable", daemonVersion: null }),
    });

    const health = await paseoWithApp("0.9.2").health(link);

    expect(health.lines).toContain("Service: ferry-paseo.service inactive, enabled");
    expect(health.lines).toContain("Daemon: stopped, unreachable");
    expect(health.lines).toContain("Version: box unknown, local app 0.9.2");
    expect(health.warnings).toEqual([
      "The Paseo daemon on the box is stopped. Run ferry integrations enable paseo to start it.",
    ]);
  });

  test("warns when the box version differs from the local app", async () => {
    const health = await paseoWithApp("0.10.0").health(boxLink({}));

    expect(health.lines).toContain("Version: box 0.9.2, local app 0.10.0");
    expect(health.warnings).toEqual([
      "The box runs Paseo 0.9.2 and the local app is 0.10.0. Run ferry update.",
    ]);
  });

  test("says not pinned when there is no local app", async () => {
    const health = await paseoWithApp(null).health(boxLink({}));

    expect(health.lines).toContain("Version: box 0.9.2, not pinned (no local Paseo app)");
    expect(health.warnings).toEqual([]);
    expect(health.json).toMatchObject({ localVersion: null, pinned: false });
  });

  test("warns when the relay is on", async () => {
    const health = await paseoWithApp("0.9.2").health(boxLink({ status: daemonStatus({ relay: { enabled: true } }) }));

    expect(health.lines).toContain("Listen: 127.0.0.1:6767, relay ON");
    expect(health.warnings).toEqual(["The Paseo relay is on. Ferry keeps it off on the box."]);
    expect(health.json).toMatchObject({ relay: true });
  });

  test("warns when the daemon listens on an address that is not loopback", async () => {
    const health = await paseoWithApp("0.9.2").health(boxLink({ status: daemonStatus({ listen: "0.0.0.0:6767" }) }));

    expect(health.warnings).toEqual([
      "Paseo listens on 0.0.0.0:6767, which is not a loopback address. Other hosts can control the daemon.",
    ]);
  });

  test("accepts the loopback addresses", async () => {
    for (const listen of ["127.0.0.1:6767", "localhost:6767", "[::1]:6767", "/run/user/1000/paseo.sock"]) {
      const health = await paseoWithApp("0.9.2").health(boxLink({ status: daemonStatus({ listen }) }));
      expect(health.warnings).toEqual([]);
    }
  });

  test("warns when the old paseo.service is active", async () => {
    const health = await paseoWithApp("0.9.2").health(boxLink({ active: "inactive", oldActive: "active" }));

    expect(health.warnings).toEqual([
      "The old paseo.service is active, so two Paseo daemons can run. Run ferry integrations enable paseo to replace it.",
    ]);
    expect(health.json).toMatchObject({ oldService: { unit: "paseo.service", active: "active" } });
  });

  test("reports an offline host as a line, not an error", async () => {
    const link = boxLink({
      ok: false,
      error: { code: "host-offline", origin: "network", message: "Tailscale host box is offline" },
    });

    const health = await paseoWithApp("0.9.2").health(link);

    expect(health.lines).toEqual(["Box: unavailable (network/host-offline)"]);
    expect(health.warnings).toEqual([]);
    expect(health.json).toEqual({ error: "network/host-offline" });
  });

  test("reports that Paseo is not installed on the box", async () => {
    const health = await paseoWithApp("0.9.2").health(
      boxLink({ active: "inactive", enabled: "not-found", status: null }),
    );

    expect(health.lines).toEqual([
      "Service: ferry-paseo.service inactive, not-found",
      "Paseo: not installed on the box",
    ]);
    expect(health.warnings).toEqual(["Paseo is not installed on the box. Run ferry integrations enable paseo."]);
    expect(health.json).toMatchObject({ installed: false, localDaemon: null, error: null });
  });

  test("reports malformed status output without the output itself", async () => {
    const health = await paseoWithApp("0.9.2").health(boxLink({ status: "secretKeyB64=abc {not json" }));

    expect(health.lines).toContain("Daemon: unknown, paseo daemon status printed no valid JSON");
    expect(health.warnings).toEqual(["Ferry cannot read the output of paseo daemon status --json on the box."]);
    expect(health.json).toMatchObject({ error: "malformed-status" });
    expect(JSON.stringify(health)).not.toContain("secretKeyB64");
  });

  test("never shows the server ID or the hostname", async () => {
    const health = await paseoWithApp("0.9.2").health(
      boxLink({ status: daemonStatus({ serverId: "srv_secret", hostname: "box-host", logPath: "/p/daemon.log" }) }),
    );

    const text = JSON.stringify(health);
    expect(text).not.toContain("srv_secret");
    expect(text).not.toContain("box-host");
    expect(text).not.toContain("daemon.log");
  });
});

describe("Paseo project move", () => {
  test("registers the moved project on the box", async () => {
    const commands: string[] = [];
    const link: IntegrationLink = {
      async run(command) {
        commands.push(command);
        return { ok: true, address: "100.64.0.8", stdout: "", stderr: "" };
      },
    };

    await createPaseo().onProjectMoved(link, "~/Developer/it's");

    expect(commands).toEqual([`paseo project create "$HOME"/'Developer/it'"'"'s' >/dev/null`]);
  });

  test("fails with the box message when the command fails", async () => {
    const link: IntegrationLink = {
      async run() {
        return { ok: false, error: { code: "command-failed", origin: "box", message: "directory_not_found" } };
      },
    };

    await expect(createPaseo().onProjectMoved(link, "~/app")).rejects.toThrow(
      "paseo project create failed: directory_not_found",
    );
  });

  test("names the command that removes the source project from Paseo", () => {
    expect(paseoSourceHint("~/Developer/app", "this machine")).toBe(
      "Paseo still lists ~/Developer/app on this machine. Ferry does not remove it. To remove it from Paseo, run paseo project ls to find its ID, then paseo project delete <id>. The files stay.",
    );
  });
});

describe("integration list", () => {
  test("shows a disabled integration with its local app version and source", async () => {
    const app = join(tempRoot(), "Paseo.app");
    const cli = join(app, "Contents/Resources/bin/paseo");
    touch(cli);
    const paseo = createPaseo({ platform: "darwin", macApp: app, host: fakeHost({ stdout: "0.9.2\n" }) });

    expect(await integrationLines(CONFIG, [paseo])).toEqual([
      "paseo  disabled  Paseo daemon on the box",
      `  Local app: 0.9.2 (${cli})`,
      "",
      "Ferry does not set up integrations on the box in this release.",
    ]);
  });

  test("shows an enabled integration with the Desktop connect steps", async () => {
    const paseo = createPaseo({ platform: "linux", linuxInstallDir: join(tempRoot(), "none") });

    expect(await integrationLines({ ...CONFIG, integrations: { paseo: true } }, [paseo])).toEqual([
      "paseo  enabled  Paseo daemon on the box",
      "  Local app: not found. The box version is not pinned.",
      "  Connect to the box:",
      "    Open Paseo Desktop.",
      "    Open Settings → Add host → Remote SSH.",
      "    Enter ssh://ploi@box.",
      "",
      "Ferry does not set up integrations on the box in this release.",
    ]);
  });

  test("uses the Tailscale host and SSH user as the destination", async () => {
    const paseo = createPaseo({ platform: "linux", linuxInstallDir: join(tempRoot(), "none") });
    const config: PartialOperatorConfig = {
      ...CONFIG,
      host: { tailscale: "box", sshUser: "ferry" },
      integrations: { paseo: true },
    };

    expect(await integrationLines(config, [paseo])).toContain("    Enter ssh://ferry@box.");
  });
});
