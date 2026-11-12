/**
 * Agent notifications. `ferry notify` runs on the box from a hook of a
 * harness, such as the Claude `Stop` hook. It writes one event to
 * `~/.ferry/events/<id>.json`. `ferry tunnel --follow` on the operator machine
 * reads the events and writes them to `~/.ferry/tunnels/<box>.events.json`,
 * and the menu bar app posts one notification for each new event.
 *
 * An event holds the harness, the kind, the project path, and the time. It
 * never holds prompt text or agent output.
 */

import { mkdirSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { record } from "./box-settings.ts";
import { redactTokens, redactUrlCredentials, type SeedSettings } from "./manifest.ts";
import type { HarnessDescriptor } from "./registry/types.ts";

/** The directory of the events on the box, relative to the home. */
export const EVENTS_DIR = ".ferry/events";

/** `turn-ended`: the agent ended its turn. `waiting-for-input`: the agent asks the operator for an answer or a permission. */
export const EVENT_KINDS = ["turn-ended", "waiting-for-input"] as const;
export type EventKind = (typeof EVENT_KINDS)[number];

/** One file in `~/.ferry/events/` on the box. */
export type AgentEvent = {
  /** `<milliseconds>-<pid>`, which is also the file name. */
  readonly id: string;
  readonly harness: string;
  readonly kind: EventKind;
  /** The working directory of the agent, with tokens and URL credentials replaced. */
  readonly project: string;
  /** ISO 8601 time on the box. */
  readonly at: string;
};

/** An event in the operator file, with the time on the operator machine when Ferry received it. */
export type ReceivedEvent = AgentEvent & { readonly receivedAt: string };

/** The content of `~/.ferry/tunnels/<box>.events.json`. The menu bar app reads it. */
export type EventsFile = {
  readonly schemaVersion: 1;
  readonly box: string;
  /** ISO 8601 time. */
  readonly updatedAt: string;
  /** The newest events, oldest first. */
  readonly events: readonly ReceivedEvent[];
  /**
   * The IDs of the events that were on the box at the first read. Ferry
   * shows none of them, because they are older than the first follow.
   */
  readonly seen?: readonly string[];
};

/** The box keeps this number of events, and the operator file too. */
export const MAX_EVENTS = 20;
/** The box removes an event after this time, so a later connection does not get it. */
export const EVENT_TTL_MS = 60 * 60 * 1_000;

const HARNESS_ID = /^[a-z0-9][a-z0-9-]{0,31}$/;
const EVENT_ID = /^\d{1,16}-\d{1,10}$/;
const MAX_PROJECT_LENGTH = 1_024;

export type NotifyInput = { readonly harness: string; readonly kind: string };

export type NotifyDependencies = {
  readonly home: string;
  readonly cwd: string;
  readonly pid: number;
  readonly now: () => Date;
  /** The hook input. Ferry reads only its `cwd` field. */
  readonly readStdin: () => Promise<string>;
};

export class NotifyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "NotifyError";
  }
}

/** Write one event and remove the old events. Returns the event. */
export async function runNotify(input: NotifyInput, dependencies: Partial<NotifyDependencies> = {}): Promise<AgentEvent> {
  const resolved = { ...defaultDependencies(), ...dependencies };
  if (!HARNESS_ID.test(input.harness)) {
    throw new NotifyError(`invalid harness ${input.harness}. Use a harness id, such as claude.`);
  }
  if (!isKind(input.kind)) throw new NotifyError(`invalid event ${input.kind}. Use ${EVENT_KINDS.join(" or ")}.`);
  const now = resolved.now();
  const id = `${now.getTime()}-${resolved.pid}`;
  const event: AgentEvent = {
    id,
    harness: input.harness,
    kind: input.kind,
    project: redactUrlCredentials(redactTokens(hookCwd(await resolved.readStdin()) ?? resolved.cwd)),
    at: now.toISOString(),
  };
  const dir = join(resolved.home, EVENTS_DIR);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const path = join(dir, `${id}.json`);
  // A rename is atomic, so the follow command never reads a part of the file.
  writeFileSync(`${path}.tmp`, `${JSON.stringify(event)}\n`, { mode: 0o600 });
  renameSync(`${path}.tmp`, path);
  pruneEvents(dir, now.getTime());
  return event;
}

/** Remove the events older than EVENT_TTL_MS, then all but the newest MAX_EVENTS. */
function pruneEvents(dir: string, now: number): void {
  const ids = readdirSync(dir)
    .map((file) => /^(\d+)-\d+\.json$/.exec(file))
    .filter((match) => match !== null)
    .sort((a, b) => Number(a[1]) - Number(b[1]));
  ids.forEach((match, index) => {
    if (now - Number(match[1]) > EVENT_TTL_MS || index < ids.length - MAX_EVENTS) rmSync(join(dir, match[0]), { force: true });
  });
}

/** The `cwd` field of the hook input when it is an absolute path. Ferry reads no other field. */
function hookCwd(stdin: string): string | null {
  let value: unknown;
  try {
    value = JSON.parse(stdin);
  } catch {
    return null;
  }
  const cwd = typeof value === "object" && value !== null ? (value as Record<string, unknown>).cwd : undefined;
  return typeof cwd === "string" && validProject(cwd) ? cwd : null;
}

function validProject(value: string): boolean {
  return value.startsWith("/") && value.length <= MAX_PROJECT_LENGTH && !/[\u0000-\u001f\u007f]/.test(value);
}

function isKind(value: string): value is EventKind {
  return (EVENT_KINDS as readonly string[]).includes(value);
}

/**
 * Read one event file of the box. The box output is not trusted, so Ferry
 * keeps only the known fields with valid values, and replaces the tokens in
 * the project path again. Returns null for an event that is not valid.
 */
export function parseBoxEvent(json: string): AgentEvent | null {
  let value: unknown;
  try {
    value = JSON.parse(json);
  } catch {
    return null;
  }
  if (typeof value !== "object" || value === null) return null;
  const { id, harness, kind, project, at } = value as Record<string, unknown>;
  if (typeof id !== "string" || !EVENT_ID.test(id)) return null;
  if (typeof harness !== "string" || !HARNESS_ID.test(harness)) return null;
  if (typeof kind !== "string" || !isKind(kind)) return null;
  if (typeof project !== "string" || !validProject(project)) return null;
  if (typeof at !== "string" || Number.isNaN(Date.parse(at))) return null;
  return { id, harness, kind, project: redactUrlCredentials(redactTokens(project)), at: new Date(at).toISOString() };
}

/**
 * Add the events that `known` and `seen` do not have. Keep the newest
 * MAX_EVENTS, oldest first. Returns null when no event is new, so Ferry does
 * not write the file again.
 */
export function mergeEvents(
  known: readonly ReceivedEvent[],
  incoming: readonly AgentEvent[],
  receivedAt: string,
  seen: readonly string[] = [],
): ReceivedEvent[] | null {
  const ids = new Set([...known.map((event) => event.id), ...seen]);
  const added: ReceivedEvent[] = [];
  for (const event of incoming) {
    if (ids.has(event.id)) continue;
    ids.add(event.id);
    added.push({ ...event, receivedAt });
  }
  if (added.length === 0) return null;
  return [...known, ...added]
    .sort((a, b) => a.at.localeCompare(b.at))
    .slice(-MAX_EVENTS);
}

export function eventsFilePath(box: string, home = homedir()): string {
  return join(home, ".ferry", "tunnels", `${box}.events.json`);
}

/** The Claude harness, whose `Stop` and `Notification` hooks run `ferry notify`. */
const CLAUDE = "claude";

/**
 * The hooks that Ferry adds to the Claude settings on the box. The Notification
 * matcher takes a permission prompt and a question of an MCP server, not the
 * reminder after 60 s of idle time, which follows each Stop event. The box
 * install of Ferry is in `~/.local/bin`, which can be missing from the PATH
 * of a hook.
 */
export const NOTIFY_HOOKS: Readonly<Record<string, Record<string, unknown>>> = {
  Stop: { hooks: [notifyHook("turn-ended")] },
  Notification: { matcher: "permission_prompt|elicitation_dialog", hooks: [notifyHook("waiting-for-input")] },
};

function notifyHook(kind: EventKind): Record<string, unknown> {
  return { type: "command", command: `"$HOME/.local/bin/ferry" notify ${CLAUDE} ${kind}`, timeout: 10 };
}

/**
 * The carried settings with NOTIFY_HOOKS after the hooks of the operator.
 * Only the box gets these settings, so the settings of the operator stay the
 * same. Returns null when Claude is off for the box, or when the operator
 * has no Claude settings file: a new settings entry would remove the other
 * carried keys from the box settings.
 */
export function withNotifyHooks(
  settings: readonly SeedSettings[],
  harnesses: readonly HarnessDescriptor[],
): SeedSettings[] | null {
  const claude = harnesses.find((harness) => harness.id === CLAUDE);
  const entry = settings.find((candidate) => candidate.harness === CLAUDE);
  if (!claude?.settings?.keys.includes("hooks") || !entry) return null;
  const carried = record(JSON.parse(Buffer.from(entry.bytes).toString()));
  const hooks = { ...record(carried.hooks) };
  for (const [event, group] of Object.entries(NOTIFY_HOOKS)) {
    hooks[event] = [...(Array.isArray(hooks[event]) ? hooks[event] : []), group];
  }
  const bytes = new TextEncoder().encode(JSON.stringify({ ...carried, hooks }));
  return settings.map((candidate) => (candidate === entry ? { harness: CLAUDE, bytes } : candidate));
}

function defaultDependencies(): NotifyDependencies {
  return {
    home: homedir(),
    cwd: process.cwd(),
    pid: process.pid,
    now: () => new Date(),
    // A hook gives its input on stdin. A run in a terminal has none.
    readStdin: () => (process.stdin.isTTY ? Promise.resolve("") : Bun.stdin.text()),
  };
}
