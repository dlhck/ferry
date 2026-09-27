import { afterEach, describe, expect, test } from "bun:test";
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { PartialOperatorConfig } from "../src/config.ts";
import {
  runIntegrationCommand,
  type IntegrationCommandDependencies,
} from "../src/integrations/command.ts";
import { INTEGRATIONS, integrationLines, type Integration } from "../src/integrations/index.ts";
import { createPaseo } from "../src/integrations/paseo.ts";
import { BunHostAdapter, type HostAdapter, type HostCommand } from "../src/link.ts";

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

  test("health and project moves are not implemented in this release", async () => {
    const paseo = createPaseo();
    const link = { run: async () => { throw new Error("no box call"); } };

    await expect(paseo.health(link)).rejects.toThrow("not implemented in this release");
    await expect(paseo.onProjectMoved(link, "/home/ploi/app")).rejects.toThrow(
      "not implemented in this release",
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

describe("integrations enable and disable", () => {
  type Recorder = { events: string[]; output: string[] };

  /** A fake integration that records each call. `failEnable` makes enable throw. */
  function fakeIntegration(recorder: Recorder, failEnable = false): Integration {
    const paseo = createPaseo({ platform: "win32" });
    return {
      ...paseo,
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

    await runIntegrationCommand({ action: "enable", name: "paseo", yes: false, dryRun: false }, dependencies(recorder));

    expect(recorder.events).toEqual(["plan enable", "confirm", "link", "enable", "config paseo=true"]);
    expect(recorder.output[0]).toBe("Enable Paseo:");
    expect(recorder.output).toContain("Paseo 0.9.2 runs on the box.");
    expect(recorder.output.slice(-4)).toEqual([
      "Connect Paseo to the box:",
      "  Open Paseo Desktop.",
      "  Open Settings → Add host → Remote SSH.",
      "  Enter ssh://ploi@box.",
    ]);
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
