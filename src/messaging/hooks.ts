/**
 * The user-level hooks and the MCP entry of agent messaging (#306).
 *
 * Each hook runs `ferry messaging hook <runtime> <event>`. The command text is
 * fixed, so the Codex trust of the hooks stays valid across syncs and
 * releases. On a box with `messaging = true`, sync adds the Claude hooks and
 * the allow rule to the carried Claude settings, and merges the Codex hooks
 * into `~/.codex/hooks.json` with jq. On the operator machine, `ferry
 * messaging setup` writes the same hooks into the local files. Sync removes
 * these exact entries from the carried settings first, so a box without the
 * key never gets them.
 *
 * Ferry identifies its entries by the exact command text, and keeps all other
 * hooks. A removal removes only the groups and events that it made empty.
 */

import { jqEditScript, quoteShell, record } from "../box-settings.ts";
import type { SeedSettings } from "../manifest.ts";
import { REMOVE_HOOKS_FILTER } from "../notify.ts";
import type { HarnessDescriptor } from "../registry/types.ts";

export type MessagingRuntime = "claude" | "codex";

/** The reserved MCP server name. Sync never carries a server with this name from the operator machine. */
export const MESSAGING_MCP_SERVER = "ferry-messaging";
/** The Claude permission rule that lets the `ferry_*` tools run without a prompt. They talk only to the local worker. */
export const MESSAGING_ALLOW_RULE = `mcp__${MESSAGING_MCP_SERVER}`;
/** The arguments of the MCP entry, after the Ferry path. */
export const MESSAGING_MCP_ARGS = ["messaging", "mcp"] as const;

/** The Codex hooks file, relative to the home. Codex `hooks` is not a carried key, so sync edits this file on the box. */
export const CODEX_HOOKS_FILE = ".codex/hooks.json";

/** The command of one hook. It uses the box install of Ferry, else the Ferry on the PATH, else it does nothing. */
export function messagingHookCommand(runtime: MessagingRuntime, event: string): string {
  return `f="$HOME/.local/bin/ferry"; [ -x "$f" ] || f=$(command -v ferry) || exit 0; "$f" messaging hook ${runtime} ${event}`;
}

type HookOptions = { readonly timeout: number; readonly async?: true; readonly matcher?: string };

/** The hook events with their options, from section 11.3 of the design. */
const EVENTS: Readonly<Record<MessagingRuntime, Readonly<Record<string, HookOptions>>>> = {
  claude: {
    SessionStart: { timeout: 10 },
    UserPromptSubmit: { timeout: 5 },
    Stop: { timeout: 5, async: true },
    PermissionRequest: { timeout: 5 },
    Notification: { timeout: 5, async: true, matcher: "permission_prompt" },
    PostToolUse: { timeout: 5, async: true },
    SessionEnd: { timeout: 2 },
  },
  codex: {
    SessionStart: { timeout: 10 },
    UserPromptSubmit: { timeout: 5 },
    PermissionRequest: { timeout: 5 },
    Stop: { timeout: 5, async: true },
    PostToolUse: { timeout: 5, async: true },
    SessionEnd: { timeout: 1 },
  },
};

/** The hook events of `runtime`, which the hook command accepts. */
export function messagingEvents(runtime: MessagingRuntime): readonly string[] {
  return Object.keys(EVENTS[runtime]);
}

/** The hook groups of `runtime`, by event, in the form of the Claude and Codex hook settings. */
export function messagingHooks(runtime: MessagingRuntime): Record<string, Record<string, unknown>[]> {
  return Object.fromEntries(
    Object.entries(EVENTS[runtime]).map(([event, { matcher, timeout, async }]) => [
      event,
      [
        {
          ...(matcher !== undefined ? { matcher } : {}),
          hooks: [{ type: "command", command: messagingHookCommand(runtime, event), timeout, ...(async ? { async } : {}) }],
        },
      ],
    ]),
  );
}

/** Every hook command of Ferry messaging, of both runtimes. */
export const MESSAGING_HOOK_COMMANDS: readonly string[] = (["claude", "codex"] as const).flatMap((runtime) =>
  messagingEvents(runtime).map((event) => messagingHookCommand(runtime, event)),
);

/** A part of each hook command as JSON writes it. A settings file that has it has the hooks of Ferry messaging. */
export const MESSAGING_HOOK_TEXT = JSON.stringify('"$f" messaging hook').slice(1, -1);

/**
 * A settings object with the hooks of `runtime` after the other hooks. The
 * hooks of Ferry messaging that the object had go first, so the result has
 * each hook once. With `allow`, the Claude allow rule is in `permissions.allow` once.
 */
export function addMessagingHooks(settings: Record<string, unknown>, runtime: MessagingRuntime, allow = false): Record<string, unknown> {
  const clean = removeMessagingHooks(settings);
  const hooks = { ...record(clean.hooks) };
  for (const [event, groups] of Object.entries(messagingHooks(runtime))) {
    hooks[event] = [...(Array.isArray(hooks[event]) ? hooks[event] : []), ...groups];
  }
  const result: Record<string, unknown> = { ...clean, hooks };
  if (allow) {
    const permissions = record(clean.permissions);
    const rules = Array.isArray(permissions.allow) ? permissions.allow : [];
    result.permissions = { ...permissions, allow: [...rules, MESSAGING_ALLOW_RULE] };
  }
  return result;
}

/**
 * The settings object without the hooks of Ferry messaging and without the
 * allow rule. A group, an event, `hooks`, `allow`, or `permissions` that only
 * Ferry filled goes too. All other content stays.
 */
export function removeMessagingHooks(settings: Record<string, unknown>): Record<string, unknown> {
  const result = { ...settings };
  const ferry = (hook: unknown) => typeof record(hook).command === "string" && MESSAGING_HOOK_COMMANDS.includes(record(hook).command as string);
  const isGroup = (group: unknown) => Array.isArray(record(group).hooks);
  if (typeof settings.hooks === "object" && settings.hooks !== null && !Array.isArray(settings.hooks)) {
    const hooks: Record<string, unknown> = {};
    for (const [event, groups] of Object.entries(settings.hooks)) {
      if (!Array.isArray(groups) || !groups.some((group) => isGroup(group) && (record(group).hooks as unknown[]).some(ferry))) {
        hooks[event] = groups;
        continue;
      }
      const kept = groups.flatMap((group) => {
        if (!isGroup(group) || !(record(group).hooks as unknown[]).some(ferry)) return [group];
        const rest = (record(group).hooks as unknown[]).filter((hook) => !ferry(hook));
        return rest.length === 0 ? [] : [{ ...record(group), hooks: rest }];
      });
      if (kept.length > 0) hooks[event] = kept;
    }
    if (Object.keys(hooks).length > 0) result.hooks = hooks;
    else delete result.hooks;
  }
  const permissions = record(settings.permissions);
  if (Array.isArray(permissions.allow) && permissions.allow.includes(MESSAGING_ALLOW_RULE)) {
    const allow = permissions.allow.filter((rule) => rule !== MESSAGING_ALLOW_RULE);
    const { allow: _allow, ...rest } = permissions;
    const next = allow.length > 0 ? { ...rest, allow } : rest;
    if (Object.keys(next).length > 0) result.permissions = next;
    else delete result.permissions;
  }
  return result;
}

/**
 * The carried settings without the messaging hooks and the allow rule of the
 * operator machine, which `ferry messaging setup` wrote there. Sync applies
 * this to every box, before `withMessagingHooks`.
 */
export function withoutMessagingHooks(settings: readonly SeedSettings[]): readonly SeedSettings[] {
  const result = settings.map((entry) => {
    if (entry.harness !== "claude") return entry;
    const carried = parse(entry.bytes);
    if (carried === null) return entry;
    const clean = removeMessagingHooks(carried);
    return JSON.stringify(clean) === JSON.stringify(carried) ? entry : { harness: entry.harness, bytes: new TextEncoder().encode(JSON.stringify(clean)) };
  });
  // The same array when nothing changed, so that sync sees that the settings are the operator settings.
  return result.every((entry, index) => entry === settings[index]) ? settings : result;
}

/**
 * The carried settings with the Claude hooks of Ferry messaging, and the allow
 * rule when `permissions` is a carried key. Only a box with `messaging = true`
 * gets them. Returns null when Claude is off for the box, or when the operator
 * has no Claude settings file: a new settings entry would remove the other
 * carried keys from the box settings.
 */
export function withMessagingHooks(settings: readonly SeedSettings[], harnesses: readonly HarnessDescriptor[]): SeedSettings[] | null {
  const claude = harnesses.find((harness) => harness.id === "claude");
  const entry = settings.find((candidate) => candidate.harness === "claude");
  if (!claude?.settings?.keys.includes("hooks") || !entry) return null;
  const carried = parse(entry.bytes) ?? {};
  const bytes = new TextEncoder().encode(JSON.stringify(addMessagingHooks(carried, "claude", claude.settings.keys.includes("permissions"))));
  return settings.map((candidate) => (candidate === entry ? { harness: "claude", bytes } : candidate));
}

/** A jq filter that removes the allow rule `$a` from `permissions.allow`, and an `allow` or `permissions` that only it filled. */
const REMOVE_ALLOW_RULE = [
  'if (.permissions | type) == "object" and (.permissions.allow | type) == "array" and any(.permissions.allow[]; . == $a)',
  "then .permissions.allow |= map(select(. != $a)) | (if .permissions.allow == [] then del(.permissions.allow) else . end)",
  "| (if .permissions == {} then del(.permissions) else . end) else . end",
].join(" ");

/** A jq filter that removes `hooks` when the removal made it empty. */
const REMOVE_EMPTY_HOOKS = 'if .hooks == {} then del(.hooks) else . end';

/**
 * The box script that removes the hooks of Ferry messaging for `runtime`, and
 * the allow rule, from the JSON settings file `path`. It prints the status
 * letters of `jqEditScript`. Box uninstall and sync run it for the Claude
 * settings and the Codex hooks file.
 */
export function removeMessagingHooksScript(path: string, runtime: MessagingRuntime): string {
  const commands = messagingEvents(runtime).map((event) => messagingHookCommand(runtime, event));
  return jqEditScript(
    path,
    `--argjson c ${quoteShell(JSON.stringify(commands))} --arg a ${quoteShell(MESSAGING_ALLOW_RULE)}`,
    'type == "object"',
    `${REMOVE_HOOKS_FILTER} | ${REMOVE_EMPTY_HOOKS} | ${REMOVE_ALLOW_RULE}`,
  );
}

/**
 * The box script that merges the Codex hooks of Ferry messaging into
 * `path`, after it removes the earlier ones, so each hook is there once. The
 * other hooks stay. It prints the status letters of `jqEditScript`.
 */
export function addCodexHooksScript(path: string): string {
  return jqEditScript(
    path,
    `--argjson c ${quoteShell(JSON.stringify(messagingEvents("codex").map((event) => messagingHookCommand("codex", event))))} --argjson h ${quoteShell(JSON.stringify(messagingHooks("codex")))}`,
    'type == "object" and ((.hooks // {}) | type) == "object"',
    `${REMOVE_HOOKS_FILTER} | reduce ($h | to_entries[]) as $e (.; .hooks[$e.key] = ((.hooks[$e.key] // []) + $e.value))`,
  );
}

function parse(bytes: Uint8Array): Record<string, unknown> | null {
  try {
    const value = JSON.parse(Buffer.from(bytes).toString());
    return typeof value === "object" && value !== null && !Array.isArray(value) ? value : null;
  } catch {
    return null;
  }
}
