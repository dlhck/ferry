import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { resolveBoxes } from "../src/boxes.ts";
import { configPath, readConfig, setIntegration, withBoxes, writeConfig } from "../src/config.ts";

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

  test("reads the [status] limits", () => {
    const home = homeWithConfig([...BASE, "", "[status]", "disk_free_percent = 15", "disk_free_gib = 2.5", "memory_available_percent = 0"]);

    expect(readConfig(home)?.status).toEqual({ diskFreePercent: 15, diskFreeGiB: 2.5, memoryAvailablePercent: 0 });
    expect(readConfig(homeWithConfig(BASE))?.status).toBeUndefined();
  });

  test("refuses a [status] limit that is not a number, or a percent above 100", () => {
    expect(() => readConfig(homeWithConfig([...BASE, "", "[status]", 'disk_free_gib = "5"']))).toThrow(
      "invalid value for disk_free_gib in [status]",
    );
    expect(() => readConfig(homeWithConfig([...BASE, "", "[status]", "disk_free_gib = -1"]))).toThrow("Use a number of 0 or more.");
    expect(() => readConfig(homeWithConfig([...BASE, "", "[status]", "memory_available_percent = 101"]))).toThrow(
      "Use a number from 0 to 100.",
    );
    expect(() => readConfig(homeWithConfig([...BASE, "", "[status]", "load = 2"]))).toThrow("unknown key load in [status]");
  });

  test("writing the config keeps the [status] limits", () => {
    const home = homeWithConfig(BASE);

    writeConfig({
      version: 1,
      publisher: "operator",
      snapshotUrl: "snapshot.git",
      host: { tailscale: "box", sshUser: "ferry" },
      status: { diskFreeGiB: 2.5, memoryAvailablePercent: 5 },
    }, home);

    expect(readConfig(home)?.status).toEqual({ diskFreeGiB: 2.5, memoryAvailablePercent: 5 });
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

  test("reads paseo_auto_archive with a box override and keeps it on a config write", () => {
    const home = homeWithConfig([
      'version = 1', 'publisher = "operator"', 'snapshot_url = "snapshot.git"',
      "[integrations]", "paseo = true", "paseo_auto_archive = true",
      "[box.a]", 'transport = "ssh"', 'destination = "user@a.example"',
      "[box.a.integrations]", "paseo_auto_archive = false",
      "[box.b]", 'transport = "ssh"', 'destination = "user@b.example"',
    ]);
    setIntegration("paseo", true, home, "b");
    expect(resolveBoxes(readConfig(home)!).map((box) => box.integrations.paseo_auto_archive)).toEqual([false, true]);
    expect(readFileSync(configPath(home), "utf8")).toContain("paseo_auto_archive = true");
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
      expect(() => readConfig(home)).toThrow('Use "operator", "latest", "off", or an exact version such as 1.4.2.');
    });
  }

  test("refuses a policy for a tool that is not built in, and names the builtin tools", () => {
    const home = homeWithConfig([...BASE, "", "[tools]", 'pnpm = "operator"']);

    expect(() => readConfig(home)).toThrow("unknown tool pnpm in [tools]");
    expect(() => readConfig(home)).toThrow("Known tools: gh, jq, claude, codex, pi, cursor.");
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

  test("reads the login keys of a tool table", () => {
    const home = homeWithConfig([
      ...BASE,
      "",
      "[tools.northflank]",
      'local = "northflank --version"',
      'install = "npm install -g @northflank/cli@{version}"',
      'auth_status = "northflank list projects"',
      'auth_login = "northflank login --do-not-open-browser"',
      'auth_hosts = ["northflank.com"]',
    ]);

    expect(readConfig(home)?.tools?.northflank).toMatchObject({
      auth_status: "northflank list projects",
      auth_login: "northflank login --do-not-open-browser",
      auth_hosts: ["northflank.com"],
    });
  });

  test("refuses a tool table with only some of the login keys", () => {
    const home = homeWithConfig([
      ...BASE,
      "",
      "[tools.northflank]",
      'local = "northflank --version"',
      'install = "x"',
      'auth_login = "northflank login --do-not-open-browser"',
    ]);

    expect(() => readConfig(home)).toThrow("missing auth_status in [tools.northflank]");
    expect(() => readConfig(home)).toThrow("A login needs auth_status, auth_login, and auth_hosts.");
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
    ['auth_hosts = "northflank.com"', "invalid value for auth_hosts in [tools.pnpm]"],
    ["auth_login = 1", "invalid value for auth_login in [tools.pnpm]"],
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

const TOP = ["version = 1", 'publisher = "operator"', 'snapshot_url = "snapshot.git"'];

const BOX_A = ["[box.a]", 'transport = "ssh"', 'destination = "dev@box-a.example"'];
const BOX_B = ["[box.b]", 'tailscale = "box-b"', 'ssh_user = "dev"'];

describe("box tables", () => {
  test("reads a [host] config as it is, with no boxes", () => {
    const config = readConfig(homeWithConfig(BASE));

    expect(config?.host).toEqual({ tailscale: "box", sshUser: "ferry" });
    expect(config?.boxes).toBeUndefined();
  });

  test("reads one box", () => {
    const config = readConfig(homeWithConfig([...TOP, "", ...BOX_A]));

    expect(config?.boxes).toEqual([{ name: "a", host: { transport: "ssh", destination: "dev@box-a.example" } }]);
    expect(config?.host).toBeUndefined();
  });

  test("reads several boxes in config order with their overrides", () => {
    const home = homeWithConfig([
      ...TOP,
      "",
      "[integrations]",
      "paseo = true",
      "",
      "[tools]",
      'codex = "operator"',
      "",
      "[box.b.tools]",
      'codex = "latest"',
      'pnpm = "10.2.0"',
      "",
      ...BOX_B,
      "",
      "[box.b.integrations]",
      "paseo = false",
      "",
      ...BOX_A,
      "",
      "[tools.pnpm]",
      'local = "pnpm --version"',
      'install = "x"',
    ]);

    expect(readConfig(home)?.boxes).toEqual([
      {
        name: "b",
        host: { tailscale: "box-b", sshUser: "dev" },
        integrations: { paseo: false },
        tools: { codex: "latest", pnpm: "10.2.0" },
      },
      { name: "a", host: { transport: "ssh", destination: "dev@box-a.example" } },
    ]);
  });

  test("writing the config keeps several boxes and their overrides", () => {
    const home = homeWithConfig(BASE);
    const boxes = [
      { name: "b", host: { tailscale: "box-b", sshUser: "dev" }, integrations: { paseo: false }, tools: { codex: "latest" } },
      { name: "1", host: { transport: "ssh" as const, destination: "dev@box-a.example" } },
    ];

    writeConfig({
      version: 1,
      publisher: "operator",
      snapshotUrl: "snapshot.git",
      boxes,
      integrations: { paseo: true },
      tools: { codex: "operator" },
    }, home);

    const text = readFileSync(configPath(home), "utf8");
    expect(text).not.toContain("[host]");
    expect(text).toContain(
      '[box.b]\ntailscale = "box-b"\nssh_user = "dev"\n\n[box.b.integrations]\npaseo = false\n\n[box.b.tools]\ncodex = "latest"\n\n' +
        '[box.1]\ntransport = "ssh"\ndestination = "dev@box-a.example"\n',
    );
    expect(readConfig(home)).toEqual({
      version: 1,
      publisher: "operator",
      snapshotUrl: "snapshot.git",
      boxes,
      integrations: { paseo: true },
      tools: { codex: "operator" },
    });
  });

  test("reads and writes git_auth of a box", () => {
    const home = homeWithConfig([...TOP, "", ...BOX_A, 'git_auth = "box"', "", ...BOX_B, 'git_auth = "agent"']);
    const config = readConfig(home);

    expect(config?.boxes).toEqual([
      { name: "a", host: { transport: "ssh", destination: "dev@box-a.example" }, gitAuth: "box" },
      { name: "b", host: { tailscale: "box-b", sshUser: "dev" }, gitAuth: "agent" },
    ]);
    writeConfig({ version: 1, publisher: "operator", snapshotUrl: "snapshot.git", boxes: config?.boxes ?? [] }, home);
    expect(readFileSync(configPath(home), "utf8")).toContain(
      '[box.a]\ntransport = "ssh"\ndestination = "dev@box-a.example"\ngit_auth = "box"\n\n',
    );
    expect(readConfig(home)).toEqual(config);
  });

  test("refuses an unknown git_auth value", () => {
    const home = homeWithConfig([...TOP, "", ...BOX_A, 'git_auth = "token"']);

    expect(() => readConfig(home)).toThrow('invalid git_auth in [box.a]');
  });

  test("refuses git_auth in [host]", () => {
    const home = homeWithConfig([...BASE, 'git_auth = "box"']);

    expect(() => readConfig(home)).toThrow("unknown key git_auth in [host]");
  });

  test("writing a [host] config keeps [host] and writes the same text as before", () => {
    const home = homeWithConfig(BASE);

    writeConfig({
      version: 1,
      publisher: "operator",
      snapshotUrl: "snapshot.git",
      host: { transport: "ssh", destination: "dev@box-a.example" },
      integrations: { paseo: true },
    }, home);

    expect(readFileSync(configPath(home), "utf8")).toBe(
      'version = 1\npublisher = "operator"\nsnapshot_url = "snapshot.git"\n\n[host]\ntransport = "ssh"\ndestination = "dev@box-a.example"\n\n[integrations]\npaseo = true\n',
    );
  });

  test("refuses a config with [host] and a box table", () => {
    const home = homeWithConfig([...BASE, "", ...BOX_A]);

    expect(() => readConfig(home)).toThrow("has both [host] and [box.a]");
    expect(() => readConfig(home)).toThrow("Move [host] to a [box.<name>] table");
  });

  for (const name of ["A", "-a", "a_b", '"a"', "", "a".repeat(33), "all"]) {
    test(`refuses the box name ${JSON.stringify(name)}`, () => {
      const home = homeWithConfig([...TOP, "", `[box.${name}]`, 'transport = "ssh"', 'destination = "x"']);

      expect(() => readConfig(home)).toThrow("invalid box name");
    });
  }

  test("accepts a box name of 32 characters", () => {
    const name = `a${"-".repeat(30)}9`;
    const home = homeWithConfig([...TOP, "", `[box.${name}]`, 'transport = "ssh"', 'destination = "x"']);

    expect(readConfig(home)?.boxes?.[0]?.name).toBe(name);
  });

  test("refuses an unknown box table", () => {
    const home = homeWithConfig([...TOP, "", ...BOX_A, "", "[box.a.harness]"]);
    const host = homeWithConfig([...TOP, "", ...BOX_A, "", "[box.a.host]"]);

    expect(() => readConfig(home)).toThrow("unknown table [box.a.harness]");
    expect(() => readConfig(host)).toThrow("unknown table [box.a.host]");
  });

  test("refuses a box table that the config names twice", () => {
    const twice = homeWithConfig([...TOP, "", ...BOX_A, "", ...BOX_A]);
    const tools = homeWithConfig([...TOP, "", ...BOX_A, "", "[box.a.tools]", "", "[box.a.tools]"]);
    const key = homeWithConfig([...TOP, "", ...BOX_A, "", "[box.a.tools]", 'gh = "latest"', 'gh = "operator"']);

    expect(() => readConfig(twice)).toThrow("duplicate table [box.a]");
    expect(() => readConfig(tools)).toThrow("duplicate table [box.a.tools]");
    expect(() => readConfig(key)).toThrow("duplicate tool gh in [box.a.tools]");
  });

  for (const [lines, message] of [
    [[...BOX_A, 'snapshot_url = "x"'], "unknown key snapshot_url in [box.a]"],
    [[...BOX_A, 'transport = "mosh"'], "unsupported transport in [box.a]"],
    [[...BOX_A, "", "[box.a.integrations]", "zed = true"], "unknown key zed in [box.a.integrations]"],
    [[...BOX_A, "", "[box.a.integrations]", 'paseo = "yes"'], "invalid boolean for paseo in [box.a.integrations]"],
    [[...BOX_A, "", "[box.a.tools]", 'gh = "lts"'], "invalid policy for gh in [box.a.tools]"],
    [[...BOX_A, "", "[box.a.tools]", "gh = { version = \"1.0.0\" }"], "invalid policy for gh in [box.a.tools]"],
    [[...BOX_A, "", "[box.a.tools]", 'pnpm = "latest"'], "unknown tool pnpm in [box.a.tools]"],
  ] as const) {
    test(`refuses the box line ${lines.at(-1)}`, () => {
      expect(() => readConfig(homeWithConfig([...TOP, "", ...lines]))).toThrow(message);
    });
  }

  test("names the known tools for an unknown tool in a box", () => {
    const home = homeWithConfig([...TOP, "", ...BOX_A, "", "[box.a.tools]", 'pnpm = "latest"']);

    expect(() => readConfig(home)).toThrow("Known tools: gh, jq, claude, codex, pi, cursor.");
  });

  test("refuses a box without complete transport values", () => {
    const partial = homeWithConfig([...TOP, "", "[box.a]", 'tailscale = "box-a"']);
    const overridesOnly = homeWithConfig([...TOP, "", "[box.a.integrations]", "paseo = true"]);

    expect(() => readConfig(partial)).toThrow("box a in");
    expect(() => readConfig(partial)).toThrow('[box.a] needs transport = "ssh" with destination, or tailscale and ssh_user.');
    expect(() => readConfig(overridesOnly)).toThrow("[box.a] needs");
  });

  test("reads default_box when it names a box", () => {
    const home = homeWithConfig([...TOP, 'default_box = "b"', "", ...BOX_A, "", ...BOX_B]);

    expect(readConfig(home)?.defaultBox).toBe("b");
    expect(readConfig(homeWithConfig([...TOP, "", ...BOX_A]))?.defaultBox).toBeUndefined();
  });

  test("refuses default_box that names no box, and names the known boxes", () => {
    const home = homeWithConfig([...TOP, 'default_box = "c"', "", ...BOX_A, "", ...BOX_B]);

    expect(() => readConfig(home)).toThrow("default_box c in");
    expect(() => readConfig(home)).toThrow("names no box. Known boxes: a, b.");
  });

  test("refuses default_box in a [host] config", () => {
    const home = homeWithConfig([...TOP, 'default_box = "default"', "", ...BASE.slice(4)]);

    expect(() => readConfig(home)).toThrow("default_box in");
    expect(() => readConfig(home)).toThrow("needs [box.<name>] tables");
  });

  test("writing the config keeps default_box", () => {
    const home = homeWithConfig(BASE);
    const boxes = [
      { name: "a", host: { transport: "ssh" as const, destination: "dev@box-a.example" } },
      { name: "b", host: { tailscale: "box-b", sshUser: "dev" } },
    ];

    writeConfig({ version: 1, publisher: "operator", snapshotUrl: "snapshot.git", defaultBox: "b", boxes }, home);

    expect(readFileSync(configPath(home), "utf8")).toStartWith(
      'version = 1\npublisher = "operator"\nsnapshot_url = "snapshot.git"\ndefault_box = "b"\n\n',
    );
    expect(readConfig(home)).toEqual({ version: 1, publisher: "operator", snapshotUrl: "snapshot.git", defaultBox: "b", boxes });
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

  test("keeps the box tables and default_box", () => {
    const home = homeWithConfig([...TOP, 'default_box = "a"', "", ...BOX_A, "", "[box.a.integrations]", "paseo = false", "", ...BOX_B]);
    const before = readConfig(home);

    setIntegration("paseo", true, home);
    expect(readConfig(home)).toEqual({ ...before, integrations: { paseo: true } });
  });

  test("with a box, sets the key in [box.<name>.integrations] and keeps [integrations]", () => {
    const home = homeWithConfig([...TOP, 'default_box = "a"', "", "[integrations]", "paseo = true", "", ...BOX_A, "", ...BOX_B]);

    setIntegration("paseo", false, home, "b");
    expect(readConfig(home)?.integrations).toEqual({ paseo: true });
    expect(readConfig(home)?.boxes?.map((box) => box.integrations)).toEqual([undefined, { paseo: false }]);
    expect(readConfig(home)?.defaultBox).toBe("a");
  });

  test("refuses an incomplete config", () => {
    const home = homeWithConfig(["version = 1"]);

    expect(() => setIntegration("paseo", true, home)).toThrow("is not complete. Run ferry init.");
  });
});

describe('the "off" policy', () => {
  test("reads and writes off in [tools] and [box.<name>.tools], and a box turns a tool on again", () => {
    const home = homeWithConfig([
      ...TOP,
      "",
      "[tools]",
      'pi = "off"',
      'cursor = "off"',
      "",
      ...BOX_A,
      "",
      "[box.a.tools]",
      'codex = "off"',
      'pi = "latest"',
      "",
      ...BOX_B,
    ]);
    const config = readConfig(home);

    expect(config?.tools).toEqual({ pi: "off", cursor: "off" });
    expect(config?.boxes?.[0]?.tools).toEqual({ codex: "off", pi: "latest" });
    const [a, b] = resolveBoxes(config!);
    expect(a?.tools).toEqual({ pi: "latest", cursor: "off", codex: "off" });
    expect(b?.tools).toEqual({ pi: "off", cursor: "off" });

    writeConfig(withBoxes(config, config!.boxes!, undefined), home);
    expect(readFileSync(configPath(home), "utf8")).toContain('[tools]\npi = "off"\ncursor = "off"\n');
    expect(readFileSync(configPath(home), "utf8")).toContain('[box.a.tools]\ncodex = "off"\npi = "latest"\n');
    expect(readConfig(home)).toEqual(config);
  });

  test("gh can be off", () => {
    expect(readConfig(homeWithConfig([...BASE, "", "[tools]", 'gh = "off"']))?.tools).toEqual({ gh: "off" });
  });

  test("refuses off in a [tools.<id>] table", () => {
    const home = homeWithConfig([...BASE, "", "[tools.pnpm]", 'version = "off"', 'local = "pnpm --version"', 'install = "x"']);

    expect(() => readConfig(home)).toThrow('invalid policy for version in [tools.pnpm]');
    expect(() => readConfig(home)).toThrow('"off" is only for a built-in tool. To remove the tool, delete its table.');
  });

  test("refuses off in a box for a tool that the config defines", () => {
    const home = homeWithConfig([
      ...TOP,
      "",
      "[tools.pnpm]",
      'local = "pnpm --version"',
      'install = "x"',
      "",
      ...BOX_A,
      "",
      "[box.a.tools]",
      'pnpm = "off"',
    ]);

    expect(() => readConfig(home)).toThrow(
      'invalid policy for pnpm in [box.a.tools] of ' + configPath(home) + '. "off" is only for a built-in tool. To remove the tool, delete its [tools.pnpm] table.',
    );
  });
});
