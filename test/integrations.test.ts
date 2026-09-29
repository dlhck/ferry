import { afterEach, describe, expect, test } from "bun:test";
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { configPath, type PartialOperatorConfig } from "../src/config.ts";
import {
  runIntegrationCommand,
  type IntegrationCommandDependencies,
} from "../src/integrations/command.ts";
import { INTEGRATIONS, integrationLines, listIntegrations, operatorIntegrations } from "../src/integrations/index.ts";
import { EXAMPLE_ID, operatorIntegration } from "./fake-integration.ts";

/** The `ferry integrations` lines, as the CLI prints them. */
async function integrationText(...args: Parameters<typeof listIntegrations>): Promise<string[]> {
  return integrationLines(await listIntegrations(...args));
}
import { createPaseo, paseoSourceHint } from "../src/integrations/paseo.ts";
import type { BoxIntegration, Integration, IntegrationLink } from "../src/integrations/types.ts";
import { BunHostAdapter, type HostAdapter, type HostCommand, type LinkResult } from "../src/link.ts";

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

    const version = await createPaseo({ platform: "darwin", macApp: app, host }).box.localVersion();

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

    const version = await createPaseo({ platform: "darwin", macApp: app, host }).box.localVersion();

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
      .box.localVersion();

    expect(version).toEqual({ version: "0.9.2", source: plist });
  });

  test("reads the version from the CLI in the Linux install directory", async () => {
    const installDir = join(tempRoot(), "Paseo");
    const cli = join(installDir, "resources/bin/paseo");
    touch(cli);
    const host = fakeHost({ stdout: "paseo 0.10.0-beta.1\n" });

    const version = await createPaseo({ platform: "linux", linuxInstallDir: installDir, host })
      .box.localVersion();

    expect(version).toEqual({ version: "0.10.0-beta.1", source: cli });
    expect(host.calls).toEqual([[cli, "--version"]]);
  });

  test("returns no version and runs nothing when there is no local app", async () => {
    const root = tempRoot();
    const host = fakeHost({ stdout: "0.9.2\n" }, { stdout: "0.9.2\n" });

    expect(
      await createPaseo({ platform: "darwin", macApp: join(root, "Paseo.app"), host }).box.localVersion(),
    ).toEqual({ version: null, source: null });
    expect(
      await createPaseo({ platform: "linux", linuxInstallDir: join(root, "Paseo"), host }).box.localVersion(),
    ).toEqual({ version: null, source: null });
    expect(host.calls).toEqual([]);
  });
});

describe("Paseo integration", () => {
  test("the registry has Paseo only", () => {
    expect(INTEGRATIONS.map((integration) => integration.id)).toEqual(["paseo"]);
  });

  test("connect steps name the Desktop settings and the box destination", () => {
    expect(createPaseo().box.connectSteps("ploi@box")).toEqual([
      "Open Paseo Desktop.",
      "Open Settings → Add host → Remote SSH.",
      "Enter ssh://ploi@box.",
    ]);
  });

  test("connect steps keep an ssh:// destination with its port", () => {
    expect(createPaseo().box.connectSteps("ssh://user@box.example:2222")).toContain(
      "Enter ssh://user@box.example:2222.",
    );
  });

  test("connect steps put an IPv6 host in brackets", () => {
    expect(createPaseo().box.connectSteps("user@fd7a:115c:a1e0::1")).toContain(
      "Enter ssh://user@[fd7a:115c:a1e0::1].",
    );
    expect(createPaseo().box.connectSteps("fd7a:115c:a1e0::1")).toContain(
      "Enter ssh://[fd7a:115c:a1e0::1].",
    );
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
function paseoWithApp(version: string | null): BoxIntegration {
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

    const health = await paseoWithApp("0.9.2").box.health(link);

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

    const health = await paseoWithApp("0.9.2").box.health(link);

    expect(health.lines).toContain("Service: ferry-paseo.service inactive, enabled");
    expect(health.lines).toContain("Daemon: stopped, unreachable");
    expect(health.lines).toContain("Version: box unknown, local app 0.9.2");
    expect(health.warnings).toEqual([
      "The Paseo daemon on the box is stopped. Run ferry integrations enable paseo to start it.",
    ]);
  });

  test("warns when the box version differs from the local app", async () => {
    const health = await paseoWithApp("0.10.0").box.health(boxLink({}));

    expect(health.lines).toContain("Version: box 0.9.2, local app 0.10.0");
    expect(health.warnings).toEqual([
      "The box runs Paseo 0.9.2 and the local app is 0.10.0. Run ferry update.",
    ]);
  });

  test("says not pinned when there is no local app", async () => {
    const health = await paseoWithApp(null).box.health(boxLink({}));

    expect(health.lines).toContain("Version: box 0.9.2, not pinned (no local Paseo app)");
    expect(health.warnings).toEqual([]);
    expect(health.json).toMatchObject({ localVersion: null, pinned: false });
  });

  test("warns when the relay is on", async () => {
    const health = await paseoWithApp("0.9.2").box.health(boxLink({ status: daemonStatus({ relay: { enabled: true } }) }));

    expect(health.lines).toContain("Listen: 127.0.0.1:6767, relay ON");
    expect(health.warnings).toEqual(["The Paseo relay is on. Ferry keeps it off on the box."]);
    expect(health.json).toMatchObject({ relay: true });
  });

  test("warns when the daemon listens on an address that is not loopback", async () => {
    const health = await paseoWithApp("0.9.2").box.health(boxLink({ status: daemonStatus({ listen: "0.0.0.0:6767" }) }));

    expect(health.warnings).toEqual([
      "Paseo listens on 0.0.0.0:6767, which is not a loopback address. Other hosts can control the daemon.",
    ]);
  });

  test("accepts the loopback addresses", async () => {
    for (const listen of ["127.0.0.1:6767", "localhost:6767", "[::1]:6767", "/run/user/1000/paseo.sock"]) {
      const health = await paseoWithApp("0.9.2").box.health(boxLink({ status: daemonStatus({ listen }) }));
      expect(health.warnings).toEqual([]);
    }
  });

  test("warns when the old paseo.service is active", async () => {
    const health = await paseoWithApp("0.9.2").box.health(boxLink({ active: "inactive", oldActive: "active" }));

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

    const health = await paseoWithApp("0.9.2").box.health(link);

    expect(health.lines).toEqual(["Box: unavailable (network/host-offline)"]);
    expect(health.warnings).toEqual([]);
    expect(health.json).toEqual({ error: "network/host-offline" });
  });

  test("reports that Paseo is not installed on the box", async () => {
    const health = await paseoWithApp("0.9.2").box.health(
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
    const health = await paseoWithApp("0.9.2").box.health(boxLink({ status: "secretKeyB64=abc {not json" }));

    expect(health.lines).toContain("Daemon: unknown, paseo daemon status printed no valid JSON");
    expect(health.warnings).toEqual(["Ferry cannot read the output of paseo daemon status --json on the box."]);
    expect(health.json).toMatchObject({ error: "malformed-status" });
    expect(JSON.stringify(health)).not.toContain("secretKeyB64");
  });

  test("never shows the server ID or the hostname", async () => {
    const health = await paseoWithApp("0.9.2").box.health(
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

    await createPaseo().box.onProjectMoved(link, "~/Developer/it's");

    expect(commands).toEqual([`paseo project create "$HOME"/'Developer/it'"'"'s' >/dev/null`]);
  });

  test("fails with the box message when the command fails", async () => {
    const link: IntegrationLink = {
      async run() {
        return { ok: false, error: { code: "command-failed", origin: "box", message: "directory_not_found" } };
      },
    };

    await expect(createPaseo().box.onProjectMoved(link, "~/app")).rejects.toThrow(
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

    expect(await integrationText(CONFIG, [paseo])).toEqual([
      "paseo  disabled  Paseo daemon on the box",
      "  Parts: box",
      `  Local app: 0.9.2 (${cli})`,
    ]);
  });

  test("shows an enabled integration with the Desktop connect steps", async () => {
    const paseo = createPaseo({ platform: "linux", linuxInstallDir: join(tempRoot(), "none") });

    expect(await integrationText({ ...CONFIG, integrations: { paseo: true } }, [paseo])).toEqual([
      "paseo  enabled  Paseo daemon on the box",
      "  Parts: box",
      "  Local app: not found. The box version is not pinned.",
      "  Connect to the box:",
      "    Open Paseo Desktop.",
      "    Open Settings → Add host → Remote SSH.",
      "    Enter ssh://ploi@box.",
    ]);
  });

  test("uses the Tailscale host and SSH user as the destination", async () => {
    const paseo = createPaseo({ platform: "linux", linuxInstallDir: join(tempRoot(), "none") });
    const config: PartialOperatorConfig = {
      ...CONFIG,
      host: { tailscale: "box", sshUser: "ferry" },
      integrations: { paseo: true },
    };

    expect(await integrationText(config, [paseo])).toContain("    Enter ssh://ferry@box.");
  });
});

describe("integration list with box tables", () => {
  const BOXES: PartialOperatorConfig = {
    ...CONFIG,
    host: undefined,
    integrations: { paseo: true },
    boxes: [
      { name: "a", host: { transport: "ssh", destination: "dev@box-a.example" } },
      { name: "b", host: { tailscale: "box-b", sshUser: "dev" }, integrations: { paseo: false } },
    ],
  };
  const paseo = () => createPaseo({ platform: "linux", linuxInstallDir: join(tempRoot(), "none") });

  test("lists the effective state of each box with the connect steps of that box", async () => {
    expect(await integrationText(BOXES, [paseo()])).toEqual([
      "Box a",
      "  paseo  enabled  Paseo daemon on the box",
      "    Parts: box",
      "    Local app: not found. The box version is not pinned.",
      "    Connect to the box:",
      "      Open Paseo Desktop.",
      "      Open Settings → Add host → Remote SSH.",
      "      Enter ssh://dev@box-a.example.",
      "Box b",
      "  paseo  disabled  Paseo daemon on the box",
      "    Parts: box",
      "    Local app: not found. The box version is not pinned.",
    ]);
  });

  test("the selection narrows the list", async () => {
    const lines = await integrationText(BOXES, [paseo()], ["b"]);
    expect(lines[0]).toBe("Box b");
    expect(lines.some((line) => line.startsWith("Box a"))).toBe(false);
  });

  test("reads the local app version once", async () => {
    let reads = 0;
    const base = paseo();
    const counted: Integration = { ...base, box: { ...base.box, localVersion: async () => { reads += 1; return { version: null, source: null }; } } };
    await integrationText(BOXES, [counted]);
    expect(reads).toBe(1);
  });
});

describe("integrations enable and disable", () => {
  type Recorder = { events: string[]; output: string[] };

  /** A fake integration that records each call. `failEnable` makes enable throw. */
  function fakeIntegration(recorder: Recorder, failEnable = false): Integration {
    const paseo = createPaseo({ platform: "win32" });
    return {
      ...paseo,
      box: {
        ...paseo.box,
        plan: async (action) => {
          recorder.events.push(`plan ${action}`);
          return [`Box: ${action} commands`];
        },
        enable: async () => {
          recorder.events.push("enable");
          if (failEnable) throw new Error("npm install failed");
          return ["Paseo 0.9.2 runs on the box."];
        },
        disable: async (_link, _progress, options) => {
          recorder.events.push(`disable purge=${options.purge}`);
          return ["Stopped."];
        },
      },
    };
  }

  function dependencies(recorder: Recorder, overrides: Partial<IntegrationCommandDependencies> = {}) {
    return {
      integrations: [fakeIntegration(recorder)],
      readConfig: () => CONFIG,
      setIntegration: (id: string, enabled: boolean) => recorder.events.push(`config ${id}=${enabled}`),
      createLink: () => {
        recorder.events.push("link");
        return { run: async () => { throw new Error("no box call"); } };
      },
      confirm: async () => {
        recorder.events.push("confirm");
        return true;
      },
      writeLine: (line: string) => recorder.output.push(line),
      ...overrides,
    } satisfies Partial<IntegrationCommandDependencies>;
  }

  test("enable shows the plan, asks, runs the box steps, then sets the config flag and prints the connect steps", async () => {
    const recorder: Recorder = { events: [], output: [] };

    const result = await runIntegrationCommand({ action: "enable", name: "paseo", yes: false, dryRun: false }, dependencies(recorder));

    expect(result).toEqual({
      integration: "paseo",
      action: "enable",
      plan: ["Box: enable commands"],
      dryRun: false,
      output: ["Paseo 0.9.2 runs on the box."],
      enabled: true,
      connectSteps: ["Open Paseo Desktop.", "Open Settings → Add host → Remote SSH.", "Enter ssh://ploi@box."],
    });
    expect(recorder.events).toEqual(["plan enable", "confirm", "link", "enable", "config paseo=true"]);
    expect(recorder.output[0]).toBe("Enable Paseo:");
    expect(recorder.output).toContain(`Set [integrations] paseo = true in ${configPath()}.`);
    expect(recorder.output).toContain("Paseo 0.9.2 runs on the box.");
    expect(recorder.output.slice(-4)).toEqual([
      "Connect Paseo to the box:",
      "  Open Paseo Desktop.",
      "  Open Settings → Add host → Remote SSH.",
      "  Enter ssh://ploi@box.",
    ]);
  });

  test("names the box table when the flag goes to [box.<name>.integrations]", async () => {
    const recorder: Recorder = { events: [], output: [] };

    await runIntegrationCommand(
      { action: "disable", name: "paseo", yes: true, purge: false },
      dependencies(recorder, { box: "b" }),
    );

    expect(recorder.output.at(-1)).toBe(`Set [box.b.integrations] paseo = false in ${configPath()}.`);
  });

  test("enable does not set the config flag when a box step fails", async () => {
    const recorder: Recorder = { events: [], output: [] };

    await expect(
      runIntegrationCommand(
        { action: "enable", name: "paseo", yes: true, dryRun: false },
        dependencies(recorder, { integrations: [fakeIntegration(recorder, true)] }),
      ),
    ).rejects.toThrow("npm install failed");
    expect(recorder.events).toEqual(["plan enable", "link", "enable"]);
  });

  test("--dry-run prints the plan and does not connect, ask or write", async () => {
    const recorder: Recorder = { events: [], output: [] };

    await runIntegrationCommand({ action: "enable", name: "paseo", yes: false, dryRun: true }, dependencies(recorder));

    expect(recorder.events).toEqual(["plan enable"]);
    expect(recorder.output).toEqual(["Enable Paseo:", "Box: enable commands", "Dry run: Ferry made no changes."]);
  });

  test("a refused confirmation changes nothing", async () => {
    const recorder: Recorder = { events: [], output: [] };

    await runIntegrationCommand(
      { action: "disable", name: "paseo", yes: false, purge: false },
      dependencies(recorder, { confirm: async () => false }),
    );

    expect(recorder.events).toEqual(["plan disable"]);
    expect(recorder.output.at(-1)).toBe("Disable cancelled.");
  });

  test("disable --purge runs the purge plan, then sets the config flag to false", async () => {
    const recorder: Recorder = { events: [], output: [] };

    await runIntegrationCommand({ action: "disable", name: "paseo", yes: true, purge: true }, dependencies(recorder));

    expect(recorder.events).toEqual(["plan purge", "link", "disable purge=true", "config paseo=false"]);
  });

  test("refuses an unknown integration and a config without a host", async () => {
    const recorder: Recorder = { events: [], output: [] };

    await expect(
      runIntegrationCommand({ action: "enable", name: "slack", yes: true, dryRun: false }, dependencies(recorder)),
    ).rejects.toThrow("Unknown integration slack. Known integrations: paseo.");
    await expect(
      runIntegrationCommand(
        { action: "enable", name: "paseo", yes: true, dryRun: true },
        dependencies(recorder, { readConfig: () => null }),
      ),
    ).rejects.toThrow("Ferry config has no complete host. Run ferry init.");
    expect(recorder.events).toEqual([]);
  });
});

describe("an integration with only an operator part", () => {
  test("enable changes only the config: no plan, no question, and no box link", async () => {
    const events: string[] = [];
    const output: string[] = [];

    const result = await runIntegrationCommand(
      { action: "enable", name: "example", yes: false, dryRun: false },
      {
        integrations: [operatorIntegration()],
        readConfig: () => CONFIG,
        setIntegration: (id, enabled) => events.push(`config ${id}=${enabled}`),
        createLink: () => {
          events.push("link");
          return { run: async () => { throw new Error("no box call"); } };
        },
        confirm: async () => {
          events.push("confirm");
          return true;
        },
        writeLine: (line) => output.push(line),
      },
    );

    expect(result).toEqual({
      integration: EXAMPLE_ID,
      action: "enable",
      plan: [],
      dryRun: false,
      output: [],
      enabled: true,
      connectSteps: [],
    });
    expect(events).toEqual(["config example=true"]);
    expect(output).toEqual(["Enable Example:", `Set [integrations] example = true in ${configPath()}.`]);
  });

  test("enable says when the integration cannot run on this machine", async () => {
    const output: string[] = [];

    await runIntegrationCommand(
      { action: "enable", name: "example", yes: true, dryRun: false },
      {
        integrations: [operatorIntegration({ available: false })],
        readConfig: () => CONFIG,
        setIntegration: () => {},
        writeLine: (line) => output.push(line),
      },
    );

    expect(output.at(-1)).toBe("Example is not available on this machine. Ferry adds its commands when it is.");
  });

  test("the list shows the parts of each integration and whether the operator part can run here", async () => {
    const paseo = createPaseo({ platform: "linux", linuxInstallDir: join(tempRoot(), "none") });
    const config: PartialOperatorConfig = { ...CONFIG, integrations: { [EXAMPLE_ID]: true } };

    const list = await listIntegrations(config, [paseo, operatorIntegration({ available: false })]);

    expect(list.boxes[0]?.integrations.map(({ id, parts, available }) => ({ id, parts, available }))).toEqual([
      { id: "paseo", parts: ["box"], available: null },
      { id: EXAMPLE_ID, parts: ["operator"], available: false },
    ]);
    expect(integrationLines(list).slice(3)).toEqual([
      "example  enabled  Example checks on this machine",
      "  Parts: operator",
      "  This machine: not available",
    ]);
  });

  test("is on when [integrations] or at least one box enables it", () => {
    const example = operatorIntegration();
    const boxes = (override: boolean | undefined): PartialOperatorConfig => ({
      ...CONFIG,
      host: undefined,
      integrations: { [EXAMPLE_ID]: true },
      boxes: [
        { name: "a", host: { transport: "ssh", destination: "dev@box-a.example" }, integrations: { [EXAMPLE_ID]: false } },
        {
          name: "b",
          host: { transport: "ssh", destination: "dev@box-b.example" },
          ...(override === undefined ? {} : { integrations: { [EXAMPLE_ID]: override } }),
        },
      ],
    });

    expect(operatorIntegrations(CONFIG, [example])).toEqual([]);
    expect(operatorIntegrations({ ...CONFIG, integrations: { [EXAMPLE_ID]: true } }, [example])).toEqual([example]);
    expect(operatorIntegrations(boxes(undefined), [example])).toEqual([example]);
    expect(operatorIntegrations(boxes(false), [example])).toEqual([]);
    expect(operatorIntegrations({ ...CONFIG, integrations: { paseo: true } }, INTEGRATIONS)).toEqual([]);
  });
});
