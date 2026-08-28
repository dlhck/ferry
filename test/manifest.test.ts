import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { readSeed } from "../src/manifest.ts";
import type { Refusal, Seed } from "../src/manifest.ts";
import { BUILTIN_HARNESSES } from "../src/registry/builtin.ts";

const homes: string[] = [];

afterEach(() => {
  for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true });
});

function makeHome(): string {
  const home = realpathSync(mkdtempSync(join(tmpdir(), "ferry-home-")));
  homes.push(home);
  return home;
}

/** Write one skill under a harness skill root. Keys are paths relative to the skill directory. */
function writeSkill(home: string, skillRoot: string, name: string, files: Record<string, string>) {
  const dir = join(home, skillRoot, name);
  for (const [path, body] of Object.entries(files)) {
    const file = join(dir, path);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, body);
  }
  return dir;
}

function write(home: string, path: string, body: string) {
  const file = join(home, path);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, body);
  return file;
}

function seedOf(home: string): Seed {
  const result = readSeed(home, BUILTIN_HARNESSES);
  if (!result.ok) throw new Error(`expected a seed, got a refusal: ${JSON.stringify(result)}`);
  return result;
}

function refusalOf(home: string): Refusal {
  const result = readSeed(home, BUILTIN_HARNESSES);
  if (result.ok) throw new Error("expected a refusal, got a seed");
  return result;
}

function names(seed: Seed): string[] {
  return seed.skills.map((skill) => skill.name);
}

function bodyOf(seed: Seed, name: string, path: string): string {
  const skill = seed.skills.find((candidate) => candidate.name === name);
  const file = skill?.files.find((candidate) => candidate.path === path);
  if (!file) throw new Error(`no ${name}/${path} in the seed`);
  return Buffer.from(file.bytes).toString();
}

describe("union of the managed harnesses", () => {
  test("a name that exists in only one harness is kept, for every harness", () => {
    const home = makeHome();
    // One name per managed root, so a wrong root drops its name from the seed.
    const roots = {
      agents: ".agents/skills",
      claude: ".claude/skills",
      codex: ".codex/skills",
      pi: ".pi/agent/skills",
      cursor: ".cursor/skills",
    };
    for (const [name, root] of Object.entries(roots)) {
      writeSkill(home, root, name, { "SKILL.md": `body of ${name}` });
    }

    const seed = seedOf(home);

    expect(names(seed)).toEqual(["agents", "claude", "codex", "cursor", "pi"]);
    for (const name of Object.keys(roots)) {
      expect(bodyOf(seed, name, "SKILL.md")).toBe(`body of ${name}`);
    }
  });

  test("a name in every harness with the same bytes collapses to one entry", () => {
    const home = makeHome();
    const roots = [".agents/skills", ".claude/skills", ".codex/skills", ".pi/agent/skills", ".cursor/skills"];
    for (const root of roots) {
      writeSkill(home, root, "unslop", { "SKILL.md": "same", "ref/notes.md": "notes" });
    }

    const seed = seedOf(home);

    expect(names(seed)).toEqual(["unslop"]);
    expect(seed.skills[0]?.files.map((file) => file.path)).toEqual(["SKILL.md", "ref/notes.md"]);
    expect(bodyOf(seed, "unslop", "SKILL.md")).toBe("same");
  });

  test("two harness roots that are the same directory collapse to one entry", () => {
    const home = makeHome();
    writeSkill(home, ".claude/skills", "unslop", { "SKILL.md": "same" });
    mkdirSync(join(home, ".codex"), { recursive: true });
    symlinkSync(join(home, ".claude", "skills"), join(home, ".codex", "skills"));

    const seed = seedOf(home);

    expect(names(seed)).toEqual(["unslop"]);
    expect(bodyOf(seed, "unslop", "SKILL.md")).toBe("same");
  });

  test("a skill directory symlinked into a second harness collapses to one entry", () => {
    const home = makeHome();
    const source = writeSkill(home, ".claude/skills", "unslop", { "SKILL.md": "same" });
    mkdirSync(join(home, ".pi", "agent", "skills"), { recursive: true });
    symlinkSync(source, join(home, ".pi", "agent", "skills", "unslop"));

    const seed = seedOf(home);

    expect(names(seed)).toEqual(["unslop"]);
    expect(bodyOf(seed, "unslop", "SKILL.md")).toBe("same");
  });

  test("the same name with different bytes refuses and names the clash", () => {
    const home = makeHome();
    writeSkill(home, ".claude/skills", "unslop", { "SKILL.md": "one" });
    writeSkill(home, ".codex/skills", "unslop", { "SKILL.md": "two" });
    writeSkill(home, ".pi/agent/skills", "tdd", { "SKILL.md": "kept" });

    const refusal = refusalOf(home);

    expect(refusal.clashes.map((clash) => clash.name)).toEqual(["unslop"]);
    expect(refusal.clashes[0]?.paths).toEqual([
      join(home, ".claude", "skills", "unslop"),
      join(home, ".codex", "skills", "unslop"),
    ]);
  });

  test("an extra file in one harness is a clash, not a silent merge", () => {
    const home = makeHome();
    writeSkill(home, ".claude/skills", "unslop", { "SKILL.md": "same" });
    writeSkill(home, ".codex/skills", "unslop", { "SKILL.md": "same", "extra.md": "only here" });

    expect(refusalOf(home).clashes.map((clash) => clash.name)).toEqual(["unslop"]);
  });

  test("project-local skill directories are ignored", () => {
    const home = makeHome();
    writeSkill(home, ".claude/skills", "unslop", { "SKILL.md": "home" });
    write(home, "work/repo/.claude/skills/local/SKILL.md", "project");

    expect(names(seedOf(home))).toEqual(["unslop"]);
  });
});

describe("the instruction file", () => {
  test("the home AGENTS.md is the one instruction file", () => {
    const home = makeHome();
    write(home, "AGENTS.md", "house rules");
    write(home, ".claude/CLAUDE.md", "claude only");

    const seed = seedOf(home);

    expect(Buffer.from(seed.instructions?.bytes ?? []).toString()).toBe("house rules");
  });

  test("a home without AGENTS.md yields a seed with no instruction file", () => {
    const home = makeHome();
    writeSkill(home, ".claude/skills", "unslop", { "SKILL.md": "body" });

    expect(seedOf(home).instructions).toBeNull();
  });
});

describe("the deny set", () => {
  test("forbidden names never appear in a seed", () => {
    const home = makeHome();
    writeSkill(home, ".claude/skills", "unslop", {
      "SKILL.md": "body",
      ".DS_Store": "junk",
      "history.jsonl": "session",
      "index.sqlite": "db",
      "settings.json": "harness settings",
      ".mcp.json": "mcp",
      "node_modules/left-pad/index.js": "cache",
    });

    const seed = seedOf(home);

    expect(seed.skills[0]?.files.map((file) => file.path)).toEqual(["SKILL.md"]);
    expect(seed.leftovers).toContainEqual({
      path: join(home, ".claude", "skills", "unslop", "settings.json"),
      code: "settings",
      reason: expect.any(String),
    });
  });

  test("harness auth and state outside the skill roots never reach the seed", () => {
    const home = makeHome();
    writeSkill(home, ".claude/skills", "unslop", { "SKILL.md": "body" });
    write(home, ".claude/.credentials.json", "token");
    write(home, ".claude/__store.db", "sqlite");
    write(home, ".codex/auth.json", "token");

    const seed = seedOf(home);

    const bodies = seed.skills.flatMap((skill) =>
      skill.files.map((file) => Buffer.from(file.bytes).toString()),
    );
    expect(bodies).toEqual(["body"]);
  });

  test.each([
    [".env", "SECRET=1", "dotenv"],
    [".env.production", "SECRET=1", "dotenv"],
    ["credentials.json", "{}", "credentials"],
    ["auth.json", "{}", "credentials"],
    ["id_ed25519", "key", "private-key"],
    ["deploy.pem", "key", "private-key"],
    ["token.json", "{}", "token"],
    ["Credentials.json", "{}", "credentials"],
    ["AUTH.JSON", "{}", "credentials"],
    [".ENV", "SECRET=1", "dotenv"],
  ])("a skill holding %s refuses the whole seed", (name, body, code) => {
    const home = makeHome();
    writeSkill(home, ".claude/skills", "unslop", { "SKILL.md": "body", [name]: body });
    writeSkill(home, ".codex/skills", "clean", { "SKILL.md": "clean" });

    const refusal = refusalOf(home);

    expect(refusal.forbidden).toEqual([
      {
        path: join(home, ".claude", "skills", "unslop", name),
        code,
        reason: expect.any(String),
      },
    ]);
  });

  test("a private key renamed to look harmless still refuses", () => {
    const home = makeHome();
    writeSkill(home, ".claude/skills", "unslop", {
      "notes.md": "-----BEGIN OPENSSH PRIVATE KEY-----\nb3BlbnNzaA==\n",
    });

    expect(refusalOf(home).forbidden[0]?.code).toBe("private-key");
  });

  test("a symlink out of the skill directory refuses", () => {
    const home = makeHome();
    write(home, ".ssh/id_rsa", "key");
    const skill = writeSkill(home, ".claude/skills", "unslop", { "SKILL.md": "body" });
    symlinkSync(join(home, ".ssh", "id_rsa"), join(skill, "helper.md"));

    const refusal = refusalOf(home);

    expect(refusal.forbidden[0]?.code).toBe("symlink-escape");
    expect(refusal.forbidden[0]?.path).toBe(join(skill, "helper.md"));
  });

  test("a symlink inside the skill directory is followed", () => {
    const home = makeHome();
    const skill = writeSkill(home, ".claude/skills", "unslop", { "SKILL.md": "body" });
    symlinkSync(join(skill, "SKILL.md"), join(skill, "README.md"));

    expect(bodyOf(seedOf(home), "unslop", "README.md")).toBe("body");
  });

  test("refusals report every clash and every forbidden hit at once", () => {
    const home = makeHome();
    writeSkill(home, ".claude/skills", "unslop", { "SKILL.md": "one" });
    writeSkill(home, ".codex/skills", "unslop", { "SKILL.md": "two" });
    writeSkill(home, ".pi/agent/skills", "leaky", { "SKILL.md": "body", ".env": "SECRET=1" });

    const refusal = refusalOf(home);

    expect(refusal.clashes.map((clash) => clash.name)).toEqual(["unslop"]);
    expect(refusal.forbidden.map((forbidden) => forbidden.code)).toEqual(["dotenv"]);
  });

  test("skipped junk in one harness does not fake a clash with another", () => {
    const home = makeHome();
    writeSkill(home, ".claude/skills", "unslop", { "SKILL.md": "same", ".DS_Store": "junk" });
    writeSkill(home, ".codex/skills", "unslop", { "SKILL.md": "same" });

    expect(names(seedOf(home))).toEqual(["unslop"]);
  });

});

describe("seed identity", () => {
  test("two reads of the same home give the same identity", () => {
    const home = makeHome();
    writeSkill(home, ".claude/skills", "unslop", { "SKILL.md": "body" });
    write(home, "AGENTS.md", "rules");

    expect(seedOf(home).identity).toBe(seedOf(home).identity);
  });

  test("adding a skill changes the identity", () => {
    const home = makeHome();
    writeSkill(home, ".claude/skills", "unslop", { "SKILL.md": "body" });
    const before = seedOf(home).identity;

    writeSkill(home, ".claude/skills", "tdd", { "SKILL.md": "red green" });

    expect(seedOf(home).identity).not.toBe(before);
  });

  test("removing a skill changes the identity", () => {
    const home = makeHome();
    writeSkill(home, ".claude/skills", "unslop", { "SKILL.md": "body" });
    writeSkill(home, ".claude/skills", "tdd", { "SKILL.md": "red green" });
    const before = seedOf(home).identity;

    rmSync(join(home, ".claude", "skills", "tdd"), { recursive: true });

    expect(seedOf(home).identity).not.toBe(before);
  });

  test("editing a skill body changes the identity", () => {
    const home = makeHome();
    writeSkill(home, ".claude/skills", "unslop", { "SKILL.md": "body" });
    const before = seedOf(home).identity;

    writeSkill(home, ".claude/skills", "unslop", { "SKILL.md": "new body" });

    expect(seedOf(home).identity).not.toBe(before);
  });

  test("renaming a skill changes the identity", () => {
    const home = makeHome();
    writeSkill(home, ".claude/skills", "unslop", { "SKILL.md": "body" });
    const before = seedOf(home).identity;

    rmSync(join(home, ".claude", "skills", "unslop"), { recursive: true });
    writeSkill(home, ".claude/skills", "de-slop", { "SKILL.md": "body" });

    expect(seedOf(home).identity).not.toBe(before);
  });

  test("editing the instruction file changes the identity", () => {
    const home = makeHome();
    write(home, "AGENTS.md", "rules");
    const before = seedOf(home).identity;

    write(home, "AGENTS.md", "new rules");

    expect(seedOf(home).identity).not.toBe(before);
  });

  test("the same skill reached through a second harness leaves the identity alone", () => {
    const home = makeHome();
    writeSkill(home, ".claude/skills", "unslop", { "SKILL.md": "body" });
    const before = seedOf(home).identity;

    writeSkill(home, ".codex/skills", "unslop", { "SKILL.md": "body" });

    expect(seedOf(home).identity).toBe(before);
  });
});

describe("an empty home", () => {
  test("no harness directories yield an empty seed", () => {
    const seed = seedOf(makeHome());

    expect(seed.skills).toEqual([]);
    expect(seed.instructions).toBeNull();
    expect(seed.identity).toMatch(/^[0-9a-f]{64}$/);
  });

  test("a loose file in a skill root is reported and not imported", () => {
    const home = makeHome();
    write(home, ".claude/skills/README.md", "loose");

    const seed = seedOf(home);

    expect(seed.skills).toEqual([]);
    expect(seed.leftovers).toEqual([
      {
        path: join(home, ".claude", "skills", "README.md"),
        code: "not-a-directory",
        reason: expect.any(String),
      },
    ]);
  });
});
