import { afterEach, describe, expect, test } from "bun:test";
import {
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readlinkSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { adoptPublishedSkills, AdoptionRefusal } from "../src/adopt.ts";
import type { Seed } from "../src/manifest.ts";

const homes: string[] = [];

afterEach(() => {
  for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true });
});

function fixture(source = "same\n", stored = "same\n") {
  const home = mkdtempSync(join(tmpdir(), "ferry-adopt-"));
  homes.push(home);
  const store = join(home, ".ferry", "store");
  mkdirSync(join(home, ".custom", "skills", "example"), { recursive: true });
  mkdirSync(join(store, "skills", "example"), { recursive: true });
  writeFileSync(join(home, ".custom", "skills", "example", "SKILL.md"), source);
  writeFileSync(join(store, "skills", "example", "SKILL.md"), stored);
  const seed: Seed = {
    ok: true,
    skills: [{ name: "example", files: [{ path: "SKILL.md", bytes: Buffer.from(source) }] }],
    instructions: null,
    roots: [],
    settings: [],
    identity: "identity",
    leftovers: [],
  };
  return { home, store, seed };
}

describe("local skill adoption", () => {
  test("replaces an identical published directory with a managed symlink", () => {
    const { home, store, seed } = fixture();
    const path = join(home, ".custom", "skills", "example");

    adoptPublishedSkills(home, store, [{ id: "custom", name: "Custom", skillRoot: ".custom/skills" }], seed);

    expect(lstatSync(path).isSymbolicLink()).toBe(true);
    expect(resolve(join(path, ".."), readlinkSync(path))).toBe(join(store, "skills", "example"));
  });

  test("refuses replacement when source bytes differ from stored bytes", () => {
    const { home, store, seed } = fixture("source\n", "stored\n");
    const path = join(home, ".custom", "skills", "example");

    expect(() =>
      adoptPublishedSkills(home, store, [{ id: "custom", name: "Custom", skillRoot: ".custom/skills" }], seed),
    ).toThrow(AdoptionRefusal);
    expect(lstatSync(path).isDirectory()).toBe(true);
  });

  test("replaces a relative symlink chain into the store copy with a direct store link", () => {
    const { home, store, seed } = fixture();
    const intermediate = join(home, ".agents", "skills", "example");
    const path = join(home, ".chain", "skills", "example");
    mkdirSync(join(intermediate, ".."), { recursive: true });
    mkdirSync(join(path, ".."), { recursive: true });
    symlinkSync(join(store, "skills", "example"), intermediate);
    symlinkSync(join("..", "..", ".agents", "skills", "example"), path);

    adoptPublishedSkills(
      home,
      store,
      [
        { id: "chain", name: "Chain", skillRoot: ".chain/skills" },
        { id: "agents", name: "Agents", skillRoot: ".agents/skills" },
      ],
      seed,
    );

    expect(lstatSync(path).isSymbolicLink()).toBe(true);
    expect(readlinkSync(path)).toBe(join(store, "skills", "example"));
    expect(readlinkSync(intermediate)).toBe(join(store, "skills", "example"));
  });

  test("leaves a broken symlink chain in place", () => {
    const { home, store, seed } = fixture();
    const path = join(home, ".chain", "skills", "example");
    mkdirSync(join(path, ".."), { recursive: true });
    symlinkSync(join("..", "..", ".agents", "skills", "example"), path);

    adoptPublishedSkills(home, store, [{ id: "chain", name: "Chain", skillRoot: ".chain/skills" }], seed);

    expect(readlinkSync(path)).toBe(join("..", "..", ".agents", "skills", "example"));
  });

  test("refuses a symlink chain that resolves outside the store copy", () => {
    const { home, store, seed } = fixture();
    const path = join(home, ".chain", "skills", "example");
    mkdirSync(join(path, ".."), { recursive: true });
    symlinkSync(join("..", "..", ".custom", "skills", "example"), path);

    expect(() =>
      adoptPublishedSkills(home, store, [{ id: "chain", name: "Chain", skillRoot: ".chain/skills" }], seed),
    ).toThrow(AdoptionRefusal);
    expect(readlinkSync(path)).toBe(join("..", "..", ".custom", "skills", "example"));
  });

  test("removes leftover links to the Codex system skills and keeps a real directory", () => {
    const { home, store, seed } = fixture();
    const leftover = join(home, ".custom", "skills", ".system");
    symlinkSync(join(store, "skills", ".system"), leftover);
    const official = join(home, ".codex", "skills", ".system", "SKILL.md");
    mkdirSync(join(official, ".."), { recursive: true });
    writeFileSync(official, "codex system skill\n");

    adoptPublishedSkills(
      home,
      store,
      [
        { id: "custom", name: "Custom", skillRoot: ".custom/skills" },
        { id: "codex", name: "Codex", skillRoot: ".codex/skills", ownSkills: false },
      ],
      seed,
    );

    expect(lstatSync(leftover, { throwIfNoEntry: false })).toBeUndefined();
    expect(readFileSync(official, "utf8")).toBe("codex system skill\n");
  });
});

describe("local root adoption", () => {
  test("replaces an identical published root with a managed symlink", () => {
    const { home, store, seed } = fixture();
    const path = join(home, ".claude", "agents");
    mkdirSync(path, { recursive: true });
    mkdirSync(join(store, "roots", ".claude", "agents"), { recursive: true });
    writeFileSync(join(path, "reviewer.md"), "review\n");
    writeFileSync(join(store, "roots", ".claude", "agents", "reviewer.md"), "review\n");
    const withRoot: Seed = {
      ...seed,
      roots: [{ path: ".claude/agents", files: [{ path: "reviewer.md", bytes: Buffer.from("review\n") }] }],
    };

    adoptPublishedSkills(home, store, [{ id: "claude", name: "Claude", extraRoots: [".claude/agents"] }], withRoot);

    expect(lstatSync(path).isSymbolicLink()).toBe(true);
    expect(resolve(join(path, ".."), readlinkSync(path))).toBe(join(store, "roots", ".claude", "agents"));
  });
});
