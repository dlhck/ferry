import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { configPath, readConfig, setIntegration, writeConfig } from "../src/config.ts";

const homes: string[] = [];

function homeWithConfig(lines: readonly string[]): string {
  const home = mkdtempSync(join(tmpdir(), "ferry-config-"));
  homes.push(home);
  const path = configPath(home);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, [...lines, ""].join("\n"));
  return home;
}

const BASE = [
  "version = 1",
  'publisher = "operator"',
  'snapshot_url = "snapshot.git"',
  "",
  "[host]",
  'tailscale = "box"',
  'ssh_user = "ferry"',
];

afterEach(() => {
  for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true });
});

describe("operator config", () => {
  test("reads custom harness roots and instruction targets", () => {
    const home = mkdtempSync(join(tmpdir(), "ferry-config-"));
    homes.push(home);
    const path = configPath(home);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, [
      "version = 1",
      'publisher = "operator"',
      'snapshot_url = "snapshot.git"',
      "",
      "[host]",
      'tailscale = "box"',
      'ssh_user = "ferry"',
      "",
      "[[harness]]",
      'id = "opencode"',
      'name = "OpenCode"',
      'skill_root = ".config/opencode/skills"',
      'instruction_file = ".config/opencode/AGENTS.md"',
      "",
    ].join("\n"));

    expect(readConfig(home)).toMatchObject({
      harness: [{
        id: "opencode",
        name: "OpenCode",
        skillRoot: ".config/opencode/skills",
        instructionFile: ".config/opencode/AGENTS.md",
      }],
    });
  });

  test("writing the config keeps custom harness entries", () => {
    const home = homeWithConfig(BASE);
    const harness = [{
      id: "opencode",
      name: "OpenCode",
      skillRoot: ".config/opencode/skills",
      instructionFile: ".config/opencode/AGENTS.md",
    }];

    writeConfig({
      version: 1,
      publisher: "operator",
      snapshotUrl: "snapshot.git",
      host: { tailscale: "box", sshUser: "ferry" },
      harness,
    }, home);

    expect(readConfig(home)?.harness).toEqual(harness);
  });

  test("reads the watch update switch", () => {
    expect(readConfig(homeWithConfig([...BASE, "", "[update]", "watch = true"]))?.update).toEqual({ watch: true });
    expect(readConfig(homeWithConfig([...BASE, "", "[update]", "watch = false"]))?.update).toEqual({ watch: false });
    expect(readConfig(homeWithConfig(BASE))?.update).toBeUndefined();
  });

  test("refuses a watch update value that is not a boolean", () => {
    const home = homeWithConfig([...BASE, "", "[update]", 'watch = "yes"']);

    expect(() => readConfig(home)).toThrow("invalid boolean");
  });

  test("writing the config keeps the watch update switch", () => {
    const home = homeWithConfig(BASE);

    writeConfig({
      version: 1,
      publisher: "operator",
      snapshotUrl: "snapshot.git",
      host: { tailscale: "box", sshUser: "ferry" },
      update: { watch: true },
    }, home);

    expect(readConfig(home)?.update).toEqual({ watch: true });
  });

  test("reads the integration switches", () => {
    expect(readConfig(homeWithConfig([...BASE, "", "[integrations]", "paseo = true"]))?.integrations).toEqual({ paseo: true });
    expect(readConfig(homeWithConfig([...BASE, "", "[integrations]", "paseo = false"]))?.integrations).toEqual({ paseo: false });
    expect(readConfig(homeWithConfig(BASE))?.integrations).toBeUndefined();
  });

  test("refuses an unknown integration name", () => {
    const home = homeWithConfig([...BASE, "", "[integrations]", "zed = true"]);

    expect(() => readConfig(home)).toThrow("unknown key zed in [integrations]");
  });

  test("refuses an integration value that is not a boolean", () => {
    const home = homeWithConfig([...BASE, "", "[integrations]", 'paseo = "yes"']);

    expect(() => readConfig(home)).toThrow("invalid boolean for paseo in [integrations]");
  });

  test("writing the config keeps the integration switches and the other sections", () => {
    const home = homeWithConfig(BASE);

    writeConfig({
      version: 1,
      publisher: "operator",
      snapshotUrl: "snapshot.git",
      host: { tailscale: "box", sshUser: "ferry" },
      harness: [{ id: "opencode", name: "OpenCode" }],
      update: { watch: true },
      integrations: { paseo: true },
    }, home);

    expect(readConfig(home)).toMatchObject({
      harness: [{ id: "opencode", name: "OpenCode" }],
      update: { watch: true },
      integrations: { paseo: true },
    });
  });

  test("reads the [tools] policies", () => {
    const home = homeWithConfig([...BASE, "", "[tools]", 'node = "operator"', 'bun = "1.4.2"', 'claude = "latest"', 'cursor = "2026.09.15-d2fe57e"']);

    expect(readConfig(home)?.tools).toEqual({
      node: "operator",
      bun: "1.4.2",
      claude: "latest",
      cursor: "2026.09.15-d2fe57e",
    });
    expect(readConfig(homeWithConfig(BASE))?.tools).toBeUndefined();
  });

  for (const value of ['"lts"', '"^1.4.0"', '"24"', '"v24.16.0"', '"1.4.2; rm -rf ~"', '""', "true"]) {
    test(`refuses the tool policy ${value}`, () => {
      const home = homeWithConfig([...BASE, "", "[tools]", `bun = ${value}`]);

      expect(() => readConfig(home)).toThrow("invalid policy for bun in [tools]");
      expect(() => readConfig(home)).toThrow('Use "operator", "latest", or an exact version such as 1.4.2.');
    });
  }

  test("refuses an unknown tool and names the known tools", () => {
    const home = homeWithConfig([...BASE, "", "[tools]", 'yarn = "operator"']);

    expect(() => readConfig(home)).toThrow("unknown tool yarn in [tools]");
    expect(() => readConfig(home)).toThrow("Known tools: gh, claude, codex, pi, cursor, node, npm, pnpm, bun");
  });

  test("writing the config keeps the [tools] table", () => {
    const home = homeWithConfig(BASE);

    writeConfig({
      version: 1,
      publisher: "operator",
      snapshotUrl: "snapshot.git",
      host: { tailscale: "box", sshUser: "ferry" },
      integrations: { paseo: true },
      tools: { node: "operator", bun: "1.4.2", claude: "latest" },
    }, home);

    expect(readConfig(home)?.tools).toEqual({ node: "operator", bun: "1.4.2", claude: "latest" });
    expect(readFileSync(configPath(home), "utf8")).toContain('[tools]\nnode = "operator"\nbun = "1.4.2"\nclaude = "latest"\n');
  });

  test("refuses an unknown key and names it", () => {
    const home = homeWithConfig([...BASE, "", "[[harness]]", 'id = "opencode"', 'skil_root = ".config/opencode/skills"']);

    expect(() => readConfig(home)).toThrow("unknown key skil_root in [[harness]]");
  });

  test("refuses a known key in the wrong section", () => {
    const home = homeWithConfig([...BASE, 'snapshot_url = "other.git"']);

    expect(() => readConfig(home)).toThrow("unknown key snapshot_url in [host]");
  });

  test("refuses an unknown section", () => {
    const home = homeWithConfig([...BASE, "", "[[tool]]", 'id = "aider"']);

    expect(() => readConfig(home)).toThrow("unsupported line [[tool]]");
  });
});

describe("setIntegration", () => {
  test("sets one integration key and keeps the other sections", () => {
    const home = homeWithConfig([...BASE, "", "[[harness]]", 'id = "zed"', 'skill_root = ".zed/skills"', "", "[update]", "watch = true"]);

    setIntegration("paseo", true, home);
    expect(readConfig(home)).toEqual({
      version: 1,
      publisher: "operator",
      snapshotUrl: "snapshot.git",
      host: { tailscale: "box", sshUser: "ferry" },
      harness: [{ id: "zed", skillRoot: ".zed/skills" }],
      update: { watch: true },
      integrations: { paseo: true },
    });

    setIntegration("paseo", false, home);
    expect(readConfig(home)?.integrations).toEqual({ paseo: false });
  });

  test("refuses an incomplete config", () => {
    const home = homeWithConfig(["version = 1"]);

    expect(() => setIntegration("paseo", true, home)).toThrow("is not complete. Run ferry init.");
  });
});
