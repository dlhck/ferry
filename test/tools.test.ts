import { describe, expect, test } from "bun:test";
import type { HostAdapter, HostCommand, HostCommandResult } from "../src/link.ts";
import { BUILTIN_TOOLS } from "../src/registry/builtin.ts";
import type { ToolDescriptor } from "../src/registry/types.ts";
import { PROJECT_TOOLS, runToolsCommand } from "../src/tools/command.ts";
import { parseVersion, readLocalVersion } from "../src/tools/version.ts";

/**
 * A fake operator machine. Each key is a version command, each value is its
 * standard output. A command that is not a key fails as if the program were
 * missing. The fake sees the script after the nvm and home prefix.
 */
function fakeHost(outputs: Readonly<Record<string, string>>): HostAdapter & { readonly scripts: string[] } {
  const scripts: string[] = [];
  return {
    scripts,
    run: async (command: HostCommand): Promise<HostCommandResult> => {
      const script = command.argv.at(-1) ?? "";
      scripts.push(script);
      const versionCommand = script.slice(script.indexOf('cd "$HOME" || exit 1; ') + 'cd "$HOME" || exit 1; '.length);
      const stdout = outputs[versionCommand];
      if (stdout === undefined) return { exitCode: 127, stdout: "", stderr: "not found", timedOut: false };
      return { exitCode: 0, stdout, stderr: "", timedOut: false };
    },
  };
}

describe("parseVersion", () => {
  for (const [output, version] of [
    ["v24.16.0\n", "24.16.0"],
    ["Docker version 29.4.0, build 9d7ad9f\n", "29.4.0"],
    ["Vercel CLI 58.4.0\n58.4.0\n", "58.4.0"],
    ["gh version 2.92.0 (2026-04-28)\nhttps://github.com/cli/cli/releases/tag/v2.92.0\n", "2.92.0"],
    ["2.1.281 (Claude Code)\n", "2.1.281"],
    ["codex-cli 0.156.1\n", "0.156.1"],
    ["2026.09.15-d2fe57e\n", "2026.09.15-d2fe57e"],
    ["infisical version 0.41.85\n", "0.41.85"],
    ["1234\n", "1234"],
  ] as const) {
    test(`reads ${version} from ${JSON.stringify(output)}`, () => {
      expect(parseVersion(output)).toBe(version);
    });
  }

  test("finds no version in output without digits", () => {
    expect(parseVersion("command not found\n")).toBeNull();
    expect(parseVersion("")).toBeNull();
  });
});

describe("readLocalVersion", () => {
  const bun: ToolDescriptor = { id: "bun", kind: "tool", localVersion: "bun --version" };

  test("reads the version of an installed tool", async () => {
    expect(await readLocalVersion(bun, fakeHost({ "bun --version": "1.4.2\n" }))).toBe("1.4.2");
  });

  test("returns null for a missing tool", async () => {
    expect(await readLocalVersion(bun, fakeHost({}))).toBeNull();
  });

  test("reads the version from standard error when standard output has none", async () => {
    const pgsync: HostAdapter = { run: async () => ({ exitCode: 0, stdout: "", stderr: "0.8.0\n", timedOut: false }) };

    expect(await readLocalVersion({ localVersion: "pgsync --version" }, pgsync)).toBe("0.8.0");
  });

  test("returns null when the command prints no version", async () => {
    expect(await readLocalVersion(bun, fakeHost({ "bun --version": "\n" }))).toBeNull();
  });

  test("returns null when the command times out or the host throws", async () => {
    const slow: HostAdapter = { run: async () => ({ exitCode: null, stdout: "1.4.2", stderr: "", timedOut: true }) };
    const broken: HostAdapter = {
      run: async () => {
        throw new Error("spawn failed");
      },
    };

    expect(await readLocalVersion(bun, slow)).toBeNull();
    expect(await readLocalVersion(bun, broken)).toBeNull();
  });

  test("returns null for a tool without a version command", async () => {
    expect(await readLocalVersion({}, fakeHost({}))).toBeNull();
  });

  test("loads nvm first, so node is the nvm default Node, and runs in the home directory", async () => {
    const node = BUILTIN_TOOLS.find((tool) => tool.id === "node");
    const host = fakeHost({ "node --version": "v24.16.0\n" });

    expect(node && (await readLocalVersion(node, host))).toBe("24.16.0");
    expect(host.scripts).toEqual([
      'nvm_sh="${NVM_DIR:-$HOME/.nvm}/nvm.sh"; [ -s "$nvm_sh" ] && . "$nvm_sh" >/dev/null 2>&1; cd "$HOME" || exit 1; node --version',
    ]);
  });
});

describe("ferry tools", () => {
  const OPERATOR = {
    "gh --version": "gh version 2.92.0 (2026-04-28)\n",
    "claude --version": "2.1.281 (Claude Code)\n",
    "node --version": "v24.16.0\n",
    "bun --version": "1.4.2\n",
    "pgsync --version": "0.8.0\n",
  };

  test("lists every registry tool with kind, install mode, policy, and the operator version, then the project tools", async () => {
    const lines: string[] = [];

    await runToolsCommand({
      readConfig: () => ({ tools: { bun: "1.4.2", claude: "operator" } }),
      tools: BUILTIN_TOOLS,
      local: fakeHost(OPERATOR),
      writeLine: (line) => lines.push(line),
    });

    expect(lines).toEqual([
      "Tools",
      "  TOOL        KIND   INSTALL  POLICY              OPERATOR  VERSION  NAME",
      "  gh          tool   mirror   operator (default)  yes       2.92.0   GitHub CLI",
      "  claude      agent  always   operator            yes       2.1.281  Claude Code",
      "  codex       agent  always   latest (default)    no        -        Codex",
      "  pi          agent  always   latest (default)    no        -        Pi",
      "  cursor      agent  always   latest (default)    no        -        Cursor Agent",
      "  node        tool   mirror   operator (default)  yes       24.16.0  Node.js (nvm)",
      "  npm         tool   mirror   operator (default)  no        -        npm",
      "  pnpm        tool   mirror   operator (default)  no        -        pnpm",
      "  bun         tool   mirror   1.4.2               yes       1.4.2    Bun",
      "  docker      tool   mirror   operator (default)  no        -        Docker",
      "  vercel      tool   mirror   operator (default)  no        -        Vercel CLI",
      "  infisical   tool   mirror   operator (default)  no        -        Infisical CLI",
      "  playwright  tool   mirror   operator (default)  no        -        Playwright browsers (Chromium revision)",
      "",
      "Needed by projects, no Ferry recipe",
      "  yarn    not on the operator machine",
      "  uv      not on the operator machine",
      "  go      not on the operator machine",
      "  rust    not on the operator machine",
      "  java    not on the operator machine",
      "  pgsync  on the operator machine, 0.8.0",
      "",
      "ferry tools reads this machine only. It does not connect to the box.",
    ]);
  });

  test("runs without a config and without a project tool list", async () => {
    const lines: string[] = [];

    await runToolsCommand({
      readConfig: () => null,
      tools: [{ id: "aider" }],
      projectTools: [],
      local: fakeHost({}),
      writeLine: (line) => lines.push(line),
    });

    expect(lines).toEqual([
      "Tools",
      "  TOOL   KIND   INSTALL  POLICY            OPERATOR  VERSION  NAME",
      "  aider  agent  always   latest (default)  no        -        aider",
      "",
      "ferry tools reads this machine only. It does not connect to the box.",
    ]);
  });

  test("the project tools are the ones from the #106 inventory that Ferry has no recipe for", () => {
    expect(PROJECT_TOOLS.map((tool) => tool.id)).toEqual(["yarn", "uv", "go", "rust", "java", "pgsync"]);
    const ids = new Set(BUILTIN_TOOLS.map((tool) => tool.id));
    for (const tool of PROJECT_TOOLS) expect(ids.has(tool.id)).toBe(false);
  });
});
