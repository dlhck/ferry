import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  addCodexHooksScript,
  addMessagingHooks,
  MESSAGING_ALLOW_RULE,
  MESSAGING_HOOK_COMMANDS,
  MESSAGING_HOOK_TEXT,
  messagingHookCommand,
  messagingHooks,
  removeMessagingHooks,
  removeMessagingHooksScript,
  withMessagingHooks,
  withoutMessagingHooks,
} from "../../../src/messaging/hooks.ts";
import type { SeedSettings } from "../../../src/manifest.ts";
import { BUILTIN_HARNESSES } from "../../../src/registry/builtin.ts";

const HAS_JQ = Bun.which("jq") !== null;
const jqTest = (title: string, run: () => void | Promise<void>) =>
  test.skipIf(!HAS_JQ)(HAS_JQ ? title : `${title} (skipped: jq is not on the PATH)`, run);

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const bytes = (value: unknown) => new TextEncoder().encode(JSON.stringify(value));
const parsed = (settings: readonly SeedSettings[] | null, harness = "claude") =>
  JSON.parse(Buffer.from(settings!.find((entry) => entry.harness === harness)!.bytes).toString());

describe("the hook text", () => {
  test("is fixed, so the Codex trust of the hooks stays valid", () => {
    expect(messagingHookCommand("codex", "Stop")).toBe(
      'f="$HOME/.local/bin/ferry"; [ -x "$f" ] || f=$(command -v ferry) || exit 0; "$f" messaging hook codex Stop',
    );
    expect(MESSAGING_HOOK_COMMANDS).toHaveLength(13);
    expect(MESSAGING_HOOK_TEXT).toBe('\\"$f\\" messaging hook');
    expect(JSON.stringify(messagingHooks("claude"))).toContain(MESSAGING_HOOK_TEXT);
  });

  test("has the events and options of section 11.3", () => {
    const claude = messagingHooks("claude");
    expect(Object.keys(claude)).toEqual(["SessionStart", "UserPromptSubmit", "Stop", "PermissionRequest", "Notification", "PostToolUse", "SessionEnd"]);
    expect(claude.Notification).toEqual([
      { matcher: "permission_prompt", hooks: [{ type: "command", command: messagingHookCommand("claude", "Notification"), timeout: 5, async: true }] },
    ]);
    expect(claude.SessionEnd![0]!.hooks).toEqual([{ type: "command", command: messagingHookCommand("claude", "SessionEnd"), timeout: 2 }]);
    const codex = messagingHooks("codex");
    expect(Object.keys(codex)).toEqual(["SessionStart", "UserPromptSubmit", "PermissionRequest", "Stop", "PostToolUse", "SessionEnd"]);
    expect(codex.SessionStart![0]!.hooks).toEqual([{ type: "command", command: messagingHookCommand("codex", "SessionStart"), timeout: 10 }]);
    expect(codex.SessionEnd![0]!.hooks).toEqual([{ type: "command", command: messagingHookCommand("codex", "SessionEnd"), timeout: 1 }]);
  });
});

describe("the settings merge", () => {
  const own = { model: "opus", hooks: { Stop: [{ hooks: [{ type: "command", command: "own-stop" }] }] }, permissions: { allow: ["Bash(ls)"] } };

  test("adds each hook once after the other hooks, with the allow rule once", () => {
    const once = addMessagingHooks(own, "claude", true);
    const twice = addMessagingHooks(once, "claude", true);
    expect(twice).toEqual(once);
    const stop = (once.hooks as Record<string, unknown[]>).Stop!;
    expect(stop[0]).toEqual(own.hooks.Stop[0]);
    expect(stop).toHaveLength(2);
    expect((once.permissions as { allow: string[] }).allow).toEqual(["Bash(ls)", MESSAGING_ALLOW_RULE]);
  });

  test("the removal gives back the settings without Ferry, and removes what only Ferry filled", () => {
    expect(removeMessagingHooks(addMessagingHooks(own, "claude", true))).toEqual(own);
    expect(removeMessagingHooks(addMessagingHooks({}, "codex", true))).toEqual({});
  });

  test("a hook of another tool in a Ferry group stays", () => {
    const settings = addMessagingHooks({}, "claude");
    const stop = (settings.hooks as Record<string, { hooks: unknown[] }[]>).Stop!;
    stop[0]!.hooks.push({ type: "command", command: "own" });
    expect(removeMessagingHooks(settings)).toEqual({ hooks: { Stop: [{ hooks: [{ type: "command", command: "own" }] }] } });
  });

  test("withMessagingHooks adds the hooks and the allow rule to the carried Claude settings", () => {
    const settings = [{ harness: "claude", bytes: bytes({ model: "opus" }) }];
    const result = parsed(withMessagingHooks(settings, BUILTIN_HARNESSES));
    expect(result.model).toBe("opus");
    expect(result.permissions).toEqual({ allow: [MESSAGING_ALLOW_RULE] });
    expect(result.hooks.SessionStart[0].hooks[0].command).toBe(messagingHookCommand("claude", "SessionStart"));
  });

  test("withMessagingHooks gives null without Claude settings or with Claude off", () => {
    expect(withMessagingHooks([], BUILTIN_HARNESSES)).toBeNull();
    expect(withMessagingHooks([{ harness: "claude", bytes: bytes({}) }], BUILTIN_HARNESSES.filter((harness) => harness.id !== "claude"))).toBeNull();
  });

  test("withoutMessagingHooks removes the hooks of ferry messaging setup, and gives the same array when there are none", () => {
    const clean = [{ harness: "claude", bytes: bytes({ model: "opus" }) }];
    expect(withoutMessagingHooks(clean)).toBe(clean);
    const operator = [{ harness: "claude", bytes: bytes(addMessagingHooks({ model: "opus" }, "claude", true)) }];
    expect(parsed(withoutMessagingHooks(operator))).toEqual({ model: "opus" });
  });
});

describe("the jq scripts", () => {
  const file = (text: string) => {
    const root = mkdtempSync(join(tmpdir(), "ferry-msg-jq-"));
    roots.push(root);
    const path = join(root, "settings.json");
    writeFileSync(path, text);
    return path;
  };
  const run = (script: string) => {
    const result = Bun.spawnSync(["sh", "-c", script]);
    return result.stdout.toString().trim();
  };

  jqTest("addCodexHooksScript merges the hooks once and keeps the other hooks", () => {
    const path = file(JSON.stringify({ hooks: { Stop: [{ hooks: [{ type: "command", command: "own" }] }] } }));
    run(addCodexHooksScript(path));
    run(addCodexHooksScript(path));
    const result = JSON.parse(readFileSync(path, "utf8"));
    expect(result.hooks.Stop).toEqual([{ hooks: [{ type: "command", command: "own" }] }, ...messagingHooks("codex").Stop!]);
    expect(result.hooks.SessionStart).toEqual(messagingHooks("codex").SessionStart);
  });

  jqTest("addCodexHooksScript makes a missing file", () => {
    const path = file("");
    rmSync(path);
    run(addCodexHooksScript(path));
    expect(JSON.parse(readFileSync(path, "utf8"))).toEqual({ hooks: messagingHooks("codex") });
  });

  jqTest("removeMessagingHooksScript gives the same result as removeMessagingHooks", () => {
    const own = { hooks: { Stop: [{ hooks: [{ type: "command", command: "own" }] }] }, permissions: { allow: ["Bash(ls)"] } };
    const path = file(JSON.stringify(addMessagingHooks(own, "claude", true)));
    run(removeMessagingHooksScript(path, "claude"));
    expect(JSON.parse(readFileSync(path, "utf8"))).toEqual(own);
  });

  jqTest("removeMessagingHooksScript leaves a file that is not JSON as it is", () => {
    const path = file("not json");
    expect(run(removeMessagingHooksScript(path, "codex"))).toBe("E");
    expect(readFileSync(path, "utf8")).toBe("not json");
  });
});
