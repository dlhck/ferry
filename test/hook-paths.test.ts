import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { uncarriedHookPaths } from "../src/hook-paths.ts";
import { BUILTIN_HARNESSES } from "../src/registry/builtin.ts";

const homes: string[] = [];

afterEach(() => {
  for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true });
});

function homeWithHooks(...commands: string[]): string {
  const home = realpathSync(mkdtempSync(join(tmpdir(), "ferry-hook-paths-")));
  homes.push(home);
  mkdirSync(join(home, ".claude"), { recursive: true });
  writeFileSync(
    join(home, ".claude", "settings.json"),
    JSON.stringify({ hooks: { Stop: [{ hooks: commands.map((command) => ({ type: "command", command })) }] } }),
  );
  return home;
}

describe("uncarriedHookPaths", () => {
  test("names each hook path under the home that Ferry does not carry", () => {
    const home = homeWithHooks();
    const absolute = join(home, ".claude", "hooks", "format.sh");
    writeFileSync(
      join(home, ".claude", "settings.json"),
      JSON.stringify({
        hooks: {
          Stop: [{ hooks: [{ type: "command", command: "~/bin/notify.sh" }] }],
          PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: absolute }] }],
        },
      }),
    );
    const file = join(home, ".claude", "settings.json");

    expect(uncarriedHookPaths(home, BUILTIN_HARNESSES)).toEqual([
      { file, at: "hooks.Stop[0].hooks[0].command", path: "~/bin/notify.sh" },
      // The box home has a different path, so an absolute operator home path never passes.
      { file, at: "hooks.PreToolUse[0].hooks[0].command", path: absolute },
    ]);
  });

  test.each([
    "paseo hooks claude stop",
    "jq -r .tool_input.command",
    "~/.claude/hooks/format.sh",
    `sh ${"$"}{HOME}/.claude/hooks/format.sh`,
    '"$CLAUDE_PROJECT_DIR"/.claude/hooks/check.sh',
  ])("gives nothing for an inline or carried hook command: %s", (command) => {
    expect(uncarriedHookPaths(homeWithHooks(command), BUILTIN_HARNESSES)).toEqual([]);
  });

  test("gives nothing when the Claude harness is not checked", () => {
    const home = homeWithHooks("~/bin/notify.sh");
    const others = BUILTIN_HARNESSES.filter((harness) => harness.id !== "claude");

    expect(uncarriedHookPaths(home, others)).toEqual([]);
  });

  test("gives nothing when the settings file is missing or not valid", () => {
    const home = homeWithHooks();
    writeFileSync(join(home, ".claude", "settings.json"), "{");

    expect(uncarriedHookPaths(home, BUILTIN_HARNESSES)).toEqual([]);
    rmSync(join(home, ".claude", "settings.json"));
    expect(uncarriedHookPaths(home, BUILTIN_HARNESSES)).toEqual([]);
  });
});
