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

  test("reads the [tools] policies of the builtin tools", () => {
    const home = homeWithConfig([...BASE, "", "[tools]", 'gh = "operator"', 'codex = "1.4.2"', 'claude = "latest"', 'cursor = "2026.09.15-d2fe57e"']);

    expect(readConfig(home)?.tools).toEqual({
      gh: "operator",
      codex: "1.4.2",
      claude: "latest",
      cursor: "2026.09.15-d2fe57e",
    });
    expect(readConfig(homeWithConfig(BASE))?.tools).toBeUndefined();
  });

  for (const value of ['"lts"', '"^1.4.0"', '"24"', '"v24.16.0"', '"1.4.2; rm -rf ~"', '""', "true"]) {
    test(`refuses the tool policy ${value}`, () => {
      const home = homeWithConfig([...BASE, "", "[tools]", `gh = ${value}`]);

      expect(() => readConfig(home)).toThrow("invalid policy for gh in [tools]");
      expect(() => readConfig(home)).toThrow('Use "operator", "latest", or an exact version such as 1.4.2.');
    });
  }

  test("refuses a policy for a tool that is not built in, and names the builtin tools", () => {
    const home = homeWithConfig([...BASE, "", "[tools]", 'pnpm = "operator"']);

    expect(() => readConfig(home)).toThrow("unknown tool pnpm in [tools]");
    expect(() => readConfig(home)).toThrow("Known tools: gh, claude, codex, pi, cursor.");
    expect(() => readConfig(home)).toThrow("To define a tool, add a [tools.pnpm] table.");
  });

  test("reads a [tools.<id>] table that defines a tool", () => {
    const home = homeWithConfig([
      ...BASE,
      "",
      "[tools]",
      'gh = "latest"',
      "",
      "[tools.pnpm]",
      'version = "10.2.0"',
      'local = "pnpm --version"',
      "box = 'pnpm --version'",
      'latest = "npm view pnpm version"',
      `install = 'npm install -g --prefix "$HOME/.local" pnpm@{version}'`,
      'update = "pnpm self-update {version}"',
      'path = [".local/bin"]',
      'depends = ["node"]',
      "",
      "[tools.node]",
      'local = "node --version"',
      'install = "nvm install {version}"',
    ]);

    expect(readConfig(home)?.tools).toEqual({
      gh: "latest",
      pnpm: {
        version: "10.2.0",
        local: "pnpm --version",
        box: "pnpm --version",
        latest: "npm view pnpm version",
        install: 'npm install -g --prefix "$HOME/.local" pnpm@{version}',
        update: "pnpm self-update {version}",
        path: [".local/bin"],
        depends: ["node"],
      },
      node: { local: "node --version", install: "nvm install {version}" },
    });
  });

  test("refuses an unknown key in a tool table and names the tool and the key", () => {
    const home = homeWithConfig([...BASE, "", "[tools.pnpm]", 'local = "pnpm --version"', 'install = "x"', 'kind = "agent"']);

    expect(() => readConfig(home)).toThrow("unknown key kind in [tools.pnpm]");
  });

  for (const [line, message] of [
    ["local = 1", "invalid value for local in [tools.pnpm]"],
    ['install = [".local/bin"]', "invalid value for install in [tools.pnpm]"],
    ['path = ".local/bin"', "invalid value for path in [tools.pnpm]"],
    ["depends = [1]", "invalid value for depends in [tools.pnpm]"],
    ['depends = [""]', "invalid value for depends in [tools.pnpm]"],
    ['version = "lts"', "invalid policy for version in [tools.pnpm]"],
    ["latest = 1", "invalid value for latest in [tools.pnpm]"],
    ['latest = ""', "invalid value for latest in [tools.pnpm]"],
    ['latest = ["npm view pnpm version"]', "invalid value for latest in [tools.pnpm]"],
  ] as const) {
    test(`refuses the tool table line ${line}`, () => {
      const home = homeWithConfig([...BASE, "", "[tools.pnpm]", 'local = "pnpm --version"', 'install = "x"', line]);

      expect(() => readConfig(home)).toThrow(message);
    });
  }

  for (const [line, message] of [
    ['install = "npm i -g pnpm@{tag}"', "unknown placeholder {tag} in install of [tools.pnpm]"],
    ['update = "pnpm self-update {Version}"', "unknown placeholder {Version} in update of [tools.pnpm]"],
    ['local = "pnpm --version {version}"', "unknown placeholder {version} in local of [tools.pnpm]"],
    ['latest = "npm view pnpm@{version} version"', "unknown placeholder {version} in latest of [tools.pnpm]"],
  ] as const) {
    test(`refuses the placeholder in ${line}`, () => {
      const home = homeWithConfig([...BASE, "", "[tools.pnpm]", 'local = "pnpm --version"', 'install = "x"', line]);

      expect(() => readConfig(home)).toThrow(message);
      expect(() => readConfig(home)).toThrow("{version} in install and update is the only placeholder");
    });
  }

  test("a shell ${...} expansion is not a placeholder", () => {
    const home = homeWithConfig([...BASE, "", "[tools.node]", 'local = "node --version"', 'install = ". \\"${NVM_DIR}/nvm.sh\\" && nvm install {version}"']);

    expect(readConfig(home)?.tools?.node).toMatchObject({ install: '. "${NVM_DIR}/nvm.sh" && nvm install {version}' });
  });

  test("refuses a tool table without a local version command or an install command", () => {
    const withoutInstall = homeWithConfig([...BASE, "", "[tools.pnpm]", 'local = "pnpm --version"']);
    const withoutLocal = homeWithConfig([...BASE, "", "[tools.pnpm]", 'install = "x"']);

    expect(() => readConfig(withoutInstall)).toThrow("missing install in [tools.pnpm]");
    expect(() => readConfig(withoutLocal)).toThrow("missing local in [tools.pnpm]");
  });

  test("refuses a tool that the config names twice", () => {
    const twice = homeWithConfig([...BASE, "", "[tools.pnpm]", 'local = "x"', 'install = "x"', "", "[tools.pnpm]"]);
    const repeated = homeWithConfig([...BASE, "", "[tools]", 'gh = "latest"', 'gh = "operator"']);

    expect(() => readConfig(twice)).toThrow("duplicate tool pnpm");
    expect(() => readConfig(repeated)).toThrow("duplicate tool gh");
  });

  test("writing the config keeps the [tools] policies and the tool tables", () => {
    const home = homeWithConfig(BASE);
    const tools = {
      gh: "operator",
      claude: "latest",
      pnpm: {
        version: "operator",
        local: "pnpm --version",
        box: "pnpm --version",
        latest: "npm view pnpm version",
        install: 'npm install -g --prefix "$HOME/.local" pnpm@{version}',
        path: [".local/bin"],
        depends: ["node"],
      },
      node: { local: "node --version", install: "nvm install {version}" },
    };

    writeConfig({
      version: 1,
      publisher: "operator",
      snapshotUrl: "snapshot.git",
      host: { tailscale: "box", sshUser: "ferry" },
      integrations: { paseo: true },
      tools,
    }, home);

    expect(readConfig(home)?.tools).toEqual(tools);
    expect(readFileSync(configPath(home), "utf8")).toContain('[tools]\ngh = "operator"\nclaude = "latest"\n\n[tools.pnpm]\nversion = "operator"\n');
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
