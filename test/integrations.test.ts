import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { PartialOperatorConfig } from "../src/config.ts";
import { INTEGRATIONS, integrationLines } from "../src/integrations/index.ts";
import { createPaseo } from "../src/integrations/paseo.ts";
import type { HostAdapter, HostCommand } from "../src/link.ts";
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

/** Answers `<cli> --version` with the given output and records each argv. */
function fakeHost(stdout: string, exitCode = 0): HostAdapter & { calls: string[][] } {
  const calls: string[][] = [];
  return {
    calls,
    async run(command: HostCommand) {
      calls.push([...command.argv]);
      return { exitCode, stdout, stderr: "", timedOut: false };
    },
  };
}

const PLIST = `<?xml version="1.0" encoding="UTF-8"?>
<plist version="1.0">
  <dict>
    <key>CFBundleName</key>
    <string>Paseo</string>
    <key>CFBundleShortVersionString</key>
    <string>0.9.1</string>
  </dict>
</plist>
`;

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
    touch(join(app, "Contents/Info.plist"), PLIST);
    const host = fakeHost("0.9.2\n");

    const version = await createPaseo({ platform: "darwin", macApp: app, host }).localVersion();

    expect(version).toEqual({ version: "0.9.2", source: cli });
    expect(host.calls).toEqual([[cli, "--version"]]);
  });

  test("reads the Info.plist of the macOS app when the CLI fails", async () => {
    const app = join(tempRoot(), "Paseo.app");
    touch(join(app, "Contents/Resources/bin/paseo"));
    touch(join(app, "Contents/Info.plist"), PLIST);

    const version = await createPaseo({ platform: "darwin", macApp: app, host: fakeHost("", 1) })
      .localVersion();

    expect(version).toEqual({ version: "0.9.1", source: join(app, "Contents/Info.plist") });
  });

  test("reads the version from the CLI in the Linux install directory", async () => {
    const installDir = join(tempRoot(), "Paseo");
    const cli = join(installDir, "resources/bin/paseo");
    touch(cli);
    const host = fakeHost("paseo 0.10.0-beta.1\n");

    const version = await createPaseo({ platform: "linux", linuxInstallDir: installDir, host })
      .localVersion();

    expect(version).toEqual({ version: "0.10.0-beta.1", source: cli });
    expect(host.calls).toEqual([[cli, "--version"]]);
  });

  test("returns no version and runs nothing when there is no local app", async () => {
    const root = tempRoot();
    const host = fakeHost("0.9.2\n");

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

  test("the box steps are not implemented in this release", async () => {
    const paseo = createPaseo();
    const link = { run: async () => { throw new Error("no box call"); } };

    await expect(paseo.plan(link)).rejects.toThrow("not implemented in this release");
    await expect(paseo.enable(link, noProgress)).rejects.toThrow("not implemented in this release");
    await expect(paseo.disable(link, noProgress, { purge: true })).rejects.toThrow(
      "not implemented in this release",
    );
    await expect(paseo.update(link, noProgress)).rejects.toThrow("not implemented in this release");
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
    const paseo = createPaseo({ platform: "darwin", macApp: app, host: fakeHost("0.9.2\n") });

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
