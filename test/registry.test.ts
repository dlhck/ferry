import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { ToolDefinition } from "../src/config.ts";
import { readSeed } from "../src/manifest.ts";
import { BUILTIN_HARNESSES, BUILTIN_TOOLS } from "../src/registry/builtin.ts";
import type { Refusal } from "../src/manifest.ts";
import { loadRegistry } from "../src/registry/load.ts";
import type { Registry, RegistryConfig, RegistryProblem } from "../src/registry/load.ts";
import { toolDefaults } from "../src/registry/types.ts";

const homes: string[] = [];

afterEach(() => {
  for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true });
});

function makeHome(): string {
  const home = realpathSync(mkdtempSync(join(tmpdir(), "ferry-registry-")));
  homes.push(home);
  return home;
}

function write(home: string, path: string, body: string): void {
  const file = join(home, path);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, body);
}

function registryOf(config: RegistryConfig): Registry {
  const result = loadRegistry(config);
  if (!result.ok) throw new Error(`expected a registry: ${JSON.stringify(result.problems)}`);
  return result;
}

function problemsOf(config: RegistryConfig): readonly RegistryProblem[] {
  const result = loadRegistry(config);
  if (result.ok) throw new Error("expected refused entries, got a registry");
  return result.problems;
}

function refusalOf(home: string, registry: Registry): Refusal {
  const result = readSeed(home, registry.harnesses);
  if (result.ok) throw new Error("expected a refusal, got a seed");
  return result;
}

const PNPM: ToolDefinition = {
  local: "pnpm --version",
  box: "pnpm --version",
  latest: "npm view pnpm version",
  install: 'npm install -g --prefix "$HOME/.local" pnpm@{version}',
  path: [".local/bin"],
  depends: ["node"],
};

const NODE: ToolDefinition = {
  local: "node --version",
  install: "nvm install {version}",
  path: [".nvm/current/bin"],
};

describe("operator entries", () => {
  test("an empty config yields the builtin harnesses and tools", () => {
    const registry = registryOf({});

    expect(registry.harnesses.map((harness) => harness.id)).toEqual([
      "agents",
      "claude",
      "codex",
      "pi",
      "cursor",
    ]);
    expect(registry.tools.map((tool) => tool.id)).toEqual(["gh", "claude", "codex", "pi", "cursor"]);
  });

  test("the builtin tools are the agent CLIs and gh, and the kind sets the install mode and default policy", () => {
    const defaults = Object.fromEntries(
      BUILTIN_TOOLS.map((tool) => [tool.id, `${tool.kind} ${toolDefaults(tool).mode} ${toolDefaults(tool).policy}`]),
    );

    expect(defaults).toEqual({
      gh: "tool mirror operator",
      claude: "agent always latest",
      codex: "agent always latest",
      pi: "agent always latest",
      cursor: "agent always latest",
    });
  });

  test("every builtin tool names a version command and a PATH directory inside the home", () => {
    for (const tool of BUILTIN_TOOLS) {
      expect(tool.name).toBeString();
      expect(tool.localVersion).toBeString();
      expect(tool.boxVersion).toBeString();
      expect(tool.dependsOn).toBeUndefined();
      for (const dir of tool.pathDirs ?? []) expect(dir.startsWith("/") || dir.includes("..")).toBe(false);
    }
  });

  test("a [tools.<id>] table adds a tool of kind tool after the builtin tools", () => {
    const registry = registryOf({ tools: { gh: "latest", node: NODE, pnpm: PNPM } });
    const pnpm = registry.tools.find((tool) => tool.id === "pnpm");

    expect(registry.tools.map((tool) => tool.id)).toEqual(["gh", "claude", "codex", "pi", "cursor", "node", "pnpm"]);
    expect(pnpm).toMatchObject({
      id: "pnpm",
      kind: "tool",
      localVersion: "pnpm --version",
      boxVersion: "pnpm --version",
      latestVersion: "npm view pnpm version",
      pathDirs: [".local/bin"],
      dependsOn: ["node"],
    });
    expect(pnpm && toolDefaults(pnpm)).toEqual({ mode: "mirror", policy: "operator" });
    expect(pnpm?.install).toBeUndefined();
    expect(pnpm?.update).toBeUndefined();
  });

  test("the recipe replaces {version} with a shell-quoted version, and update defaults to install", () => {
    const registry = registryOf({
      tools: { node: NODE, pnpm: { ...PNPM, update: "pnpm self-update {version}" } },
    });
    const node = registry.tools.find((tool) => tool.id === "node");
    const pnpm = registry.tools.find((tool) => tool.id === "pnpm");

    expect(node?.recipe?.install("24.16.0")).toBe("nvm install '24.16.0'");
    expect(node?.recipe?.update("24.16.0")).toBe("nvm install '24.16.0'");
    expect(pnpm?.recipe?.install("10.2.0")).toBe(`npm install -g --prefix "$HOME/.local" pnpm@'10.2.0'`);
    expect(pnpm?.recipe?.update("it's")).toBe(`pnpm self-update 'it'"'"'s'`);
  });

  test("the login keys of a config tool give a printed-url login that keeps the session in the URL", () => {
    const registry = registryOf({
      tools: {
        northflank: {
          local: "northflank --version",
          install: "x",
          auth_status: "northflank list projects",
          auth_login: "northflank login --do-not-open-browser",
          auth_hosts: ["northflank.com"],
        },
      },
    });

    expect(registry.tools.at(-1)?.auth).toEqual({
      probe: "northflank list projects",
      login: "northflank login --do-not-open-browser",
      completion: { kind: "printed-url", allowedHosts: ["northflank.com"], sessionInUrl: true },
    });
    expect(registryOf({ tools: { node: NODE } }).tools.at(-1)?.auth).toBeUndefined();
  });

  test("a config tool may depend on a builtin tool", () => {
    const registry = registryOf({ tools: { hub: { local: "hub --version", install: "x", depends: ["gh"] } } });

    expect(registry.tools.at(-1)?.dependsOn).toEqual(["gh"]);
  });

  test("a registered harness contributes its skills to the seed", () => {
    const home = makeHome();
    write(home, ".config/opencode/skills/unslop/SKILL.md", "body");
    const registry = registryOf({
      harness: [{ id: "opencode", name: "OpenCode", skillRoot: ".config/opencode/skills" }],
    });

    const seed = readSeed(home, registry.harnesses);

    expect(seed.ok).toBe(true);
    expect(seed.ok && seed.skills.map((skill) => skill.name)).toEqual(["unslop"]);
  });

  test("an entry that reuses a registered id is refused", () => {
    const problems = problemsOf({
      harness: [{ id: "claude", name: "Claude fork", skillRoot: ".claude-fork/skills" }],
      tools: { gh: { local: "gh --version", install: "brew install gh" } },
    });

    expect(problems).toEqual([
      { code: "duplicate-id", reason: "harness claude is already registered" },
      {
        code: "duplicate-id",
        reason: 'tool gh is built in. Set its policy with gh = "<policy>" in [tools], or pick another id.',
      },
    ]);
  });

  test("a harness entry that does nothing is refused", () => {
    const problems = problemsOf({ harness: [{ id: "empty", name: "Empty" }] });

    expect(problems.map((problem) => problem.code)).toEqual(["invalid-entry"]);
  });

  test("a dependency on an unknown tool is refused", () => {
    const problems = problemsOf({ tools: { pnpm: PNPM } });

    expect(problems).toEqual([{ code: "unknown-dependency", reason: "tool pnpm depends on node, which is not a known tool" }]);
  });

  test("a dependency cycle is refused", () => {
    const problems = problemsOf({
      tools: {
        a: { local: "a", install: "a", depends: ["b"] },
        b: { local: "b", install: "b", depends: ["c"] },
        c: { local: "c", install: "c", depends: ["a"] },
        self: { local: "s", install: "s", depends: ["self"] },
      },
    });

    expect(problems).toEqual([
      { code: "dependency-cycle", reason: "tools depend on each other in a cycle: a -> b -> c -> a" },
      { code: "dependency-cycle", reason: "tools depend on each other in a cycle: self -> self" },
    ]);
  });

  test.each([
    ["an absolute directory", "/usr/local/bin"],
    ["a directory that leaves the home", "../bin"],
    ["the home itself", "."],
  ])("a PATH directory that is %s is refused", (_label, dir) => {
    const problems = problemsOf({ tools: { pnpm: { ...PNPM, depends: [], path: [dir] } } });

    expect(problems).toEqual([
      { code: "unsafe-path", reason: `tool pnpm path ${dir} must be a directory inside the home` },
    ]);
  });
});

describe("registered paths cannot take a path another harness owns", () => {
  const collisions: readonly [string, string][] = [
    ["a skill root a builtin harness already owns", ".claude/skills"],
    ["the same skill root with a trailing slash", ".claude/skills/"],
    ["a skill root nested inside a builtin one", ".claude/skills/team/skills"],
  ];

  test.each(collisions)("%s is refused", (_label, skillRoot) => {
    const problems = problemsOf({ harness: [{ id: "fork", name: "Fork", skillRoot }] });

    expect(problems.map((problem) => problem.code)).toEqual(["path-collision"]);
  });

  const instructionFiles: readonly [string, string][] = [
    ["an instruction file a builtin harness already links", "AGENTS.md"],
    ["an instruction file that is a builtin skill root", ".agents/skills"],
    ["an instruction file inside a builtin skill root", ".claude/skills/AGENTS.md"],
  ];

  test.each(instructionFiles)("%s is refused", (_label, instructionFile) => {
    const problems = problemsOf({ harness: [{ id: "fork", name: "Fork", instructionFile }] });

    expect(problems.map((problem) => problem.code)).toEqual(["path-collision"]);
  });
});

describe("registered paths cannot widen the deny set", () => {
  const roguePaths: readonly [string, Record<string, string>, RegistryProblem["code"]][] = [
    ["an absolute skill root", { skillRoot: "/etc/skills" }, "unsafe-path"],
    ["a skill root that climbs out", { skillRoot: "../other-home/skills" }, "unsafe-path"],
    ["a skill root inside a denied directory", { skillRoot: ".git/skills" }, "denied-path"],
    ["a skill root inside the Ferry state", { skillRoot: ".ferry/exposed" }, "unsafe-path"],
    ["an instruction file inside the Ferry state", { instructionFile: "./.ferry/box.json" }, "unsafe-path"],
    [
      "an instruction file the deny set covers",
      { instructionFile: "credentials.json" },
      "denied-path",
    ],
  ];

  test.each(roguePaths)("%s is refused", (_label, paths, code) => {
    const problems = problemsOf({ harness: [{ id: "rogue", name: "Rogue", ...paths }] });

    expect(problems.map((problem) => problem.code)).toEqual([code]);
  });

  test("a registered harness holding a credential file still refuses the seed", () => {
    const home = makeHome();
    write(home, ".config/opencode/skills/unslop/SKILL.md", "body");
    write(home, ".config/opencode/skills/unslop/credentials.json", "{}");
    const registry = registryOf({
      harness: [{ id: "opencode", name: "OpenCode", skillRoot: ".config/opencode/skills" }],
    });

    const refusal = refusalOf(home, registry);

    expect(refusal.forbidden).toEqual([
      {
        path: join(home, ".config", "opencode", "skills", "unslop", "credentials.json"),
        code: "credentials",
        reason: expect.any(String),
      },
    ]);
  });

  test.each([
    ["a harness rooted at .ssh", ".ssh", { "known_hosts": "host key", "config": "Host box" }],
    ["a harness rooted at .config", ".config", { "gh/hosts.yml": "oauth_token: gho_live" }],
  ])("%s is refused, so the home stays out of any seed", (_label, skillRoot, files) => {
    const home = makeHome();
    for (const [path, body] of Object.entries(files)) write(home, `${skillRoot}/${path}`, body);

    const problems = problemsOf({ harness: [{ id: "rogue", name: "Rogue", skillRoot }] });

    expect(problems.map((problem) => problem.code)).toEqual(["invalid-skill-root"]);
    const seed = readSeed(home, BUILTIN_HARNESSES);
    expect(seed.ok && seed.skills).toEqual([]);
  });
});

describe("registered paths cannot take a builtin extra root", () => {
  test.each([
    ["a skill root inside the Claude agents root", { skillRoot: ".claude/agents/skills" }],
    ["an instruction file inside the Claude commands root", { instructionFile: ".claude/commands/AGENTS.md" }],
  ])("%s is refused", (_label, paths) => {
    const problems = problemsOf({ harness: [{ id: "fork", name: "Fork", ...paths }] });

    expect(problems.map((problem) => problem.code)).toEqual(["path-collision"]);
  });
});
