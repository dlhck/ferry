import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { Install } from "../src/install.ts";
import { readSeed } from "../src/manifest.ts";
import { BUILTIN_HARNESSES } from "../src/registry/builtin.ts";
import type { Refusal } from "../src/manifest.ts";
import { loadRegistry } from "../src/registry/load.ts";
import type { Registry, RegistryConfig, RegistryProblem } from "../src/registry/load.ts";

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

  test("a registered tool is planned with the builtin install commands", () => {
    const registry = registryOf({
      tool: [{ id: "opencode", install: { command: "curl -fsSL https://opencode.ai/install | sh" } }],
    });

    const link = { async run() { throw new Error("Install must not run a command to plan"); } };
    const plan = new Install(link, registry.tools).plan();

    expect(plan.at(-1)).toEqual({
      tool: "opencode",
      command: "curl -fsSL https://opencode.ai/install | sh",
    });
  });

  test("an entry that reuses a registered id is refused", () => {
    const problems = problemsOf({
      harness: [{ id: "claude", name: "Claude fork", skillRoot: ".claude-fork/skills" }],
      tool: [{ id: "gh", install: { command: "brew install gh" } }],
    });

    expect(problems.map((problem) => problem.code)).toEqual(["duplicate-id", "duplicate-id"]);
  });

  test("an entry that does nothing is refused", () => {
    const problems = problemsOf({
      harness: [{ id: "empty", name: "Empty" }],
      tool: [{ id: "idle" }],
    });

    expect(problems.map((problem) => problem.code)).toEqual(["invalid-entry", "invalid-entry"]);
  });

  test("an incomplete tool login recipe is refused", () => {
    const problems = problemsOf({
      tool: [{ id: "opencode", auth: { completion: { kind: "device-url", url: "https://x.dev" } } }],
    });

    expect(problems.map((problem) => problem.code)).toEqual(["invalid-entry"]);
  });
});

describe("registered login recipes", () => {
  test("a code pattern that cannot compile is refused before any login runs", () => {
    const problems = problemsOf({
      tool: [
        {
          id: "opencode",
          auth: {
            probe: "opencode auth status",
            login: "opencode auth login",
            completion: {
              kind: "device-url",
              url: "https://opencode.ai/device",
              codePattern: "[unterminated",
            },
          },
        },
      ],
    });

    expect(problems.map((problem) => problem.code)).toEqual(["invalid-entry"]);
  });

  test("a device URL that is not https is refused", () => {
    const problems = problemsOf({
      tool: [
        {
          id: "opencode",
          auth: {
            probe: "opencode auth status",
            login: "opencode auth login",
            completion: { kind: "device-url", url: "http://evil.example/collect" },
          },
        },
      ],
    });

    expect(problems.map((problem) => problem.code)).toEqual(["invalid-entry"]);
  });

  test("an allowed host that is a bare label is refused", () => {
    const problems = problemsOf({
      tool: [
        {
          id: "opencode",
          auth: {
            probe: "opencode auth status",
            login: "opencode auth login",
            completion: { kind: "printed-url", allowedHosts: ["com"] },
          },
        },
      ],
    });

    expect(problems.map((problem) => problem.code)).toEqual(["invalid-entry"]);
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
