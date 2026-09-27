import { describe, expect, test } from "bun:test";
import type { HostAdapter, HostCommand, HostCommandResult } from "../src/link.ts";
import type { PartialOperatorConfig } from "../src/config.ts";
import { BUILTIN_TOOLS } from "../src/registry/builtin.ts";
import { loadRegistry } from "../src/registry/load.ts";
import type { ToolDescriptor } from "../src/registry/types.ts";
import { runToolsCommand } from "../src/tools/command.ts";
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
    const stderr: HostAdapter = { run: async () => ({ exitCode: 0, stdout: "", stderr: "0.8.0\n", timedOut: false }) };

    expect(await readLocalVersion({ localVersion: "tool --version" }, stderr)).toBe("0.8.0");
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
    const node: ToolDescriptor = { id: "node", kind: "tool", localVersion: "node --version" };
    const host = fakeHost({ "node --version": "v24.16.0\n" });

    expect(await readLocalVersion(node, host)).toBe("24.16.0");
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
  };

  const CONFIG: PartialOperatorConfig = {
    tools: {
      claude: "operator",
      node: { local: "node --version", install: "nvm install {version}" },
      pnpm: { version: "10.2.0", local: "pnpm --version", install: "npm install -g pnpm@{version}", depends: ["node"] },
    },
  };

  function toolsOf(config: PartialOperatorConfig): readonly ToolDescriptor[] {
    const registry = loadRegistry(config);
    if (!registry.ok) throw new Error(JSON.stringify(registry.problems));
    return registry.tools;
  }

  test("lists the builtin tools and the config tools with kind, install mode, policy, and the operator version", async () => {
    const lines: string[] = [];

    await runToolsCommand({
      readConfig: () => CONFIG,
      tools: toolsOf(CONFIG),
      local: fakeHost(OPERATOR),
      writeLine: (line) => lines.push(line),
    });

    expect(lines).toEqual([
      "Tools",
      "  TOOL    KIND   INSTALL  POLICY              OPERATOR  VERSION  NAME",
      "  gh      tool   mirror   operator (default)  yes       2.92.0   GitHub CLI",
      "  claude  agent  always   operator            yes       2.1.281  Claude Code",
      "  codex   agent  always   latest (default)    no        -        Codex",
      "  pi      agent  always   latest (default)    no        -        Pi",
      "  cursor  agent  always   latest (default)    no        -        Cursor Agent",
      "  node    tool   mirror   operator (default)  yes       24.16.0  node",
      "  pnpm    tool   mirror   10.2.0              no        -        pnpm",
      "",
      "ferry tools reads this machine only. It does not connect to the box.",
    ]);
  });

  const BOXES: PartialOperatorConfig = {
    ...CONFIG,
    boxes: [
      { name: "a", host: { transport: "ssh", destination: "dev@box-a.example" } },
      { name: "b", host: { transport: "ssh", destination: "dev@box-b.example" }, tools: { codex: "0.150.0", pnpm: "11.0.0" } },
    ],
  };

  test("with box tables, adds the effective policy of each box", async () => {
    const lines: string[] = [];

    await runToolsCommand({
      readConfig: () => BOXES,
      tools: toolsOf(BOXES),
      local: fakeHost(OPERATOR),
      writeLine: (line) => lines.push(line),
    });

    expect(lines).toEqual([
      "Tools",
      "  TOOL    KIND   INSTALL  POLICY              BOX a               BOX b               OPERATOR  VERSION  NAME",
      "  gh      tool   mirror   operator (default)  operator (default)  operator (default)  yes       2.92.0   GitHub CLI",
      "  claude  agent  always   operator            operator            operator            yes       2.1.281  Claude Code",
      "  codex   agent  always   latest (default)    latest (default)    0.150.0             no        -        Codex",
      "  pi      agent  always   latest (default)    latest (default)    latest (default)    no        -        Pi",
      "  cursor  agent  always   latest (default)    latest (default)    latest (default)    no        -        Cursor Agent",
      "  node    tool   mirror   operator (default)  operator (default)  operator (default)  yes       24.16.0  node",
      "  pnpm    tool   mirror   10.2.0              10.2.0              11.0.0              no        -        pnpm",
      "",
      "A BOX column shows the version policy of that box, not the version on the box.",
      "ferry tools reads this machine only. It does not connect to a box.",
    ]);
  });

  test("the box selection narrows the box columns", async () => {
    const lines: string[] = [];

    await runToolsCommand({
      readConfig: () => BOXES,
      tools: toolsOf(BOXES),
      local: fakeHost(OPERATOR),
      writeLine: (line) => lines.push(line),
      boxes: ["b"],
    });

    expect(lines[1]).toBe("  TOOL    KIND   INSTALL  POLICY              BOX b               OPERATOR  VERSION  NAME");
    expect(lines[4]).toContain("latest (default)    0.150.0  ");
  });

  test("runs without a config and lists only the builtin tools", async () => {
    const lines: string[] = [];

    await runToolsCommand({
      readConfig: () => null,
      tools: BUILTIN_TOOLS,
      local: fakeHost({}),
      writeLine: (line) => lines.push(line),
    });

    expect(lines.slice(1, -2).map((line) => line.trim().split(/\s+/)[0])).toEqual(["TOOL", "gh", "claude", "codex", "pi", "cursor"]);
    expect(lines.join("\n")).not.toContain("project");
  });
});
