import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { installBundledSkill } from "../src/bundled-skill.ts";
import { BUILTIN_HARNESSES } from "../src/registry/builtin.ts";

const homes: string[] = [];
const BUNDLED = readFileSync(join(import.meta.dir, "../skills/ferry/SKILL.md"), "utf8");

afterEach(() => {
  for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true });
});

function makeHome(): string {
  const home = realpathSync(mkdtempSync(join(tmpdir(), "ferry-skill-")));
  homes.push(home);
  return home;
}

function write(path: string, body: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, body);
}

function install(home: string, options: { enabled?: boolean; skill?: string } = {}) {
  return installBundledSkill({ home, harnesses: BUILTIN_HARNESSES, ...options });
}

const skillFile = (home: string) => join(home, ".agents/skills/ferry/SKILL.md");

describe("installBundledSkill", () => {
  test("writes the bundled skill into a missing folder", () => {
    const home = makeHome();
    expect(install(home, { enabled: true }).action).toBe("installed");
    expect(readFileSync(skillFile(home), "utf8")).toBe(BUNDLED);
    expect(install(home).action).toBe("unchanged");
  });

  test("replaces the skill that Ferry wrote with the skill of a new version", () => {
    const home = makeHome();
    install(home, { skill: "old version\n" });
    const result = install(home, { skill: "new version\n" });
    expect(result).toMatchObject({ action: "updated", message: "Updated the Ferry skill in ~/.agents/skills/ferry." });
    expect(readFileSync(skillFile(home), "utf8")).toBe("new version\n");
  });

  test("keeps a skill with local changes", () => {
    const home = makeHome();
    install(home, { skill: "old version\n" });
    write(skillFile(home), "my own rules\n");
    const result = install(home, { skill: "new version\n" });
    expect(result.action).toBe("kept");
    expect(result.message).toContain("local changes");
    expect(readFileSync(skillFile(home), "utf8")).toBe("my own rules\n");
  });

  test("keeps a skill folder that another tool wrote", () => {
    const home = makeHome();
    write(skillFile(home), "from npx skills\n");
    expect(install(home).action).toBe("kept");
    expect(readFileSync(skillFile(home), "utf8")).toBe("from npx skills\n");
  });

  test("keeps a skill folder with other files", () => {
    const home = makeHome();
    install(home, { skill: "old version\n" });
    write(join(home, ".agents/skills/ferry/notes.md"), "notes\n");
    expect(install(home, { skill: "new version\n" }).action).toBe("kept");
    expect(readFileSync(skillFile(home), "utf8")).toBe("old version\n");
  });

  test("does not add a skill that clashes with a ferry skill in another root", () => {
    const home = makeHome();
    write(join(home, ".claude/skills/ferry/SKILL.md"), "claude copy\n");
    const result = install(home);
    expect(result).toMatchObject({ action: "kept" });
    expect(result.message).toContain("~/.claude/skills/ferry");
    expect(existsSync(join(home, ".agents/skills/ferry"))).toBe(false);
  });

  test("writes through a link into the store", () => {
    const home = makeHome();
    install(home, { skill: "old version\n" });
    const store = join(home, ".ferry/store/skills/ferry");
    mkdirSync(dirname(store), { recursive: true });
    write(join(store, "SKILL.md"), "old version\n");
    rmSync(join(home, ".agents/skills/ferry"), { recursive: true });
    symlinkSync(store, join(home, ".agents/skills/ferry"));
    expect(install(home, { skill: "new version\n" }).action).toBe("updated");
    expect(readFileSync(join(store, "SKILL.md"), "utf8")).toBe("new version\n");
  });

  test("--no-skill writes nothing, and the recorded choice holds until init turns it on", () => {
    const home = makeHome();
    expect(install(home, { enabled: false }).action).toBe("off");
    expect(install(home).action).toBe("off");
    expect(existsSync(join(home, ".agents/skills/ferry"))).toBe(false);
    expect(install(home, { enabled: true }).action).toBe("installed");
    expect(install(home).action).toBe("unchanged");
  });
});
