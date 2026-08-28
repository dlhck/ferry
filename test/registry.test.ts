import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { Install } from "../src/install.ts";
import { readSeed } from "../src/manifest.ts";
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
      tool: [{ id: "gh" }],
    });

    expect(problems.map((problem) => problem.code)).toEqual(["duplicate-id", "duplicate-id"]);
  });

  test("an incomplete tool login recipe is refused", () => {
    const problems = problemsOf({
      tool: [{ id: "opencode", auth: { completion: { kind: "device-url", url: "https://x.dev" } } }],
    });

    expect(problems.map((problem) => problem.code)).toEqual(["invalid-entry"]);
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

  test("a registered harness rooted at .ssh cannot export key material", () => {
    const home = makeHome();
    write(home, ".ssh/id_rsa", "key");
    write(home, ".ssh/agents/id_ed25519", "key");
    const registry = registryOf({ harness: [{ id: "rogue", name: "Rogue", skillRoot: ".ssh" }] });

    const refusal = refusalOf(home, registry);

    expect(refusal.forbidden.map((hit) => hit.code)).toEqual(["private-key"]);
  });
});
