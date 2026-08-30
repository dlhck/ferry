import { afterEach, describe, expect, test } from "bun:test";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { runInit, type InitDependencies } from "../src/init.ts";
import type { Seed } from "../src/manifest.ts";
import { BUILTIN_HARNESSES } from "../src/registry/builtin.ts";
import { runUninstall, UninstallRefusal } from "../src/uninstall.ts";

const homes: string[] = [];

afterEach(() => {
  for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true });
});

describe("ferry uninstall", () => {
  test("restores the local machine to its state before init", async () => {
    const home = makeHome();
    write(join(home, "AGENTS.md"), "original instructions\n");
    write(join(home, ".agents/skills/tdd/SKILL.md"), "test first\n");
    write(join(home, ".agents/skills/not-a-skill.txt"), "leave this alone\n");
    mkdirSync(join(home, ".claude"), { recursive: true });
    symlinkSync("../AGENTS.md", join(home, ".claude/CLAUDE.md"));
    const beforeTopLevel = readdirSync(home).sort();

    await runInit(initInput(home), initDependencies(home));

    expect(existsSync(join(home, ".ferry/uninstall.json"))).toBe(true);
    expect(lstatSync(join(home, ".claude/CLAUDE.md")).isSymbolicLink()).toBe(true);
    expect(realpathSync(join(home, ".claude/CLAUDE.md"))).toBe(join(home, ".ferry/store/AGENTS.md"));

    const result = runUninstall({ home, harnesses: BUILTIN_HARNESSES });

    expect(result.restored).toBeGreaterThanOrEqual(3);
    expect(readFileSync(join(home, "AGENTS.md"), "utf8")).toBe("original instructions\n");
    expect(readFileSync(join(home, ".agents/skills/tdd/SKILL.md"), "utf8")).toBe("test first\n");
    expect(readFileSync(join(home, ".agents/skills/not-a-skill.txt"), "utf8")).toBe(
      "leave this alone\n",
    );
    expect(existsSync(join(home, ".codex"))).toBe(false);
    expect(readlinkSync(join(home, ".claude/CLAUDE.md"))).toBe("../AGENTS.md");
    expect(existsSync(join(home, ".ferry"))).toBe(false);
    expect(readdirSync(home).sort()).toEqual(beforeTopLevel);
    expect(findBackups(home)).toEqual([]);
  });

  test("a second init keeps the first pre-init state", async () => {
    const home = makeHome();
    write(join(home, "AGENTS.md"), "before first init\n");
    write(join(home, ".agents/skills/tdd/SKILL.md"), "test first\n");
    const deps = initDependencies(home);

    await runInit(initInput(home), deps);
    await runInit(initInput(home), deps);
    runUninstall({ home, harnesses: BUILTIN_HARNESSES });

    expect(readFileSync(join(home, "AGENTS.md"), "utf8")).toBe("before first init\n");
    expect(readFileSync(join(home, ".agents/skills/tdd/SKILL.md"), "utf8")).toBe("test first\n");
    expect(existsSync(join(home, ".ferry"))).toBe(false);
  });

  test("refuses before writing when a managed link contains local data", async () => {
    const home = makeHome();
    write(join(home, "AGENTS.md"), "original instructions\n");
    write(join(home, ".agents/skills/tdd/SKILL.md"), "test first\n");
    await runInit(initInput(home), initDependencies(home));
    const changed = join(home, ".codex/skills/tdd");
    rmSync(changed);
    write(join(changed, "local.md"), "do not delete\n");
    const managed = join(home, ".agents/skills/tdd");

    expect(() => runUninstall({ home, harnesses: BUILTIN_HARNESSES })).toThrow(
      new UninstallRefusal("changed-path", `refusing changed managed path ${changed}`),
    );

    expect(readFileSync(join(changed, "local.md"), "utf8")).toBe("do not delete\n");
    expect(lstatSync(managed).isSymbolicLink()).toBe(true);
    expect(existsSync(join(home, ".ferry/config.toml"))).toBe(true);
  });

  test("restores backups made by init versions without uninstall state", () => {
    const home = makeHome();
    const storeSkill = join(home, ".ferry/store/skills/tdd");
    const managed = join(home, ".agents/skills/tdd");
    const backup = `${managed}.ferry-backup-20260830T120000Z`;
    write(join(storeSkill, "SKILL.md"), "current\n");
    write(join(backup, "SKILL.md"), "before init\n");
    mkdirSync(dirname(managed), { recursive: true });
    symlinkSync(storeSkill, managed);
    write(join(home, ".ferry/config.toml"), "version = 1\n");

    runUninstall({ home, harnesses: BUILTIN_HARNESSES });

    expect(readFileSync(join(managed, "SKILL.md"), "utf8")).toBe("before init\n");
    expect(existsSync(backup)).toBe(false);
    expect(existsSync(join(home, ".ferry"))).toBe(false);
  });
});

function makeHome(): string {
  const home = realpathSync(mkdtempSync(join(tmpdir(), "ferry-uninstall-")));
  homes.push(home);
  return home;
}

function initInput(home: string) {
  return {
    home,
    harnesses: BUILTIN_HARNESSES,
    sshDestination: "ubuntu@box",
    snapshotUrl: "snapshot.git",
  } as const;
}

function initDependencies(home: string): InitDependencies {
  return {
    publisher: () => "operator.test",
    createLink: () => ({
      async run() {
        return { ok: true, address: "ubuntu@box", stdout: "", stderr: "" };
      },
    }),
    async openStore(_remote, seed) {
      const path = join(home, ".ferry", "store");
      writeStore(path, seed);
      return {
        path,
        async publish(value) {
          writeStore(path, value);
          return { published: true, tip: "seed-tip" };
        },
      };
    },
  };
}

function writeStore(path: string, seed: Seed): void {
  mkdirSync(join(path, "skills"), { recursive: true });
  for (const skill of seed.skills) {
    for (const file of skill.files) {
      write(join(path, "skills", skill.name, file.path), file.bytes);
    }
  }
  write(join(path, "AGENTS.md"), seed.instructions?.bytes ?? new Uint8Array());
}

function write(path: string, body: string | Uint8Array): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, body);
}

function findBackups(home: string): string[] {
  const backups: string[] = [];
  const visit = (directory: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.name.includes(".ferry-backup-")) backups.push(path);
      else if (entry.isDirectory()) visit(path);
    }
  };
  visit(home);
  return backups;
}
