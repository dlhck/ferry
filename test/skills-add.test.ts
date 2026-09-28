import { describe, expect, test } from "bun:test";
import { runSkillsAdd, SkillsAddError, skillsAddArgv } from "../src/skills-add.ts";

describe("skillsAddArgv", () => {
  test("adds -g and --copy after the caller's arguments", () => {
    expect(
      skillsAddArgv(
        ["vercel-labs/agent-skills", "--skill", "frontend-design", "-a", "claude-code", "-y"],
        { project: false },
      ),
    ).toEqual([
      "npx",
      "skills",
      "add",
      "vercel-labs/agent-skills",
      "--skill",
      "frontend-design",
      "-a",
      "claude-code",
      "-y",
      "-g",
      "--copy",
    ]);
  });

  test("omits -g for a project install", () => {
    expect(skillsAddArgv(["owner/repo"], { project: true })).toEqual([
      "npx",
      "skills",
      "add",
      "owner/repo",
      "--copy",
    ]);
  });

  test("does not repeat flags the caller passed", () => {
    expect(skillsAddArgv(["owner/repo", "-g", "--copy"], { project: false })).toEqual([
      "npx",
      "skills",
      "add",
      "owner/repo",
      "-g",
      "--copy",
    ]);
    expect(skillsAddArgv(["--global", "owner/repo"], { project: false })).toEqual([
      "npx",
      "skills",
      "add",
      "--global",
      "owner/repo",
      "--copy",
    ]);
  });

  test("adds flags before -- and keeps the arguments after it unchanged", () => {
    expect(skillsAddArgv(["-y", "--", "--copy", "owner/repo"], { project: false })).toEqual([
      "npx",
      "skills",
      "add",
      "-y",
      "-g",
      "--copy",
      "--",
      "--copy",
      "owner/repo",
    ]);
  });
});

describe("runSkillsAdd", () => {
  test("runs npx skills add with the built argv", async () => {
    const calls: (readonly string[])[] = [];
    const argv = await runSkillsAdd({ args: ["owner/repo"], project: false }, async (argv) => {
      calls.push(argv);
      return 0;
    });

    expect(calls).toEqual([["npx", "skills", "add", "owner/repo", "-g", "--copy"]]);
    expect(argv).toEqual(["npx", "skills", "add", "owner/repo", "-g", "--copy"]);
  });

  test("reports the child exit code when npx fails", async () => {
    const error = await runSkillsAdd({ args: ["owner/repo"], project: false }, async () => 7).catch(
      (caught: unknown) => caught,
    );

    expect(error).toBeInstanceOf(SkillsAddError);
    expect((error as SkillsAddError).exitCode).toBe(7);
  });
});
