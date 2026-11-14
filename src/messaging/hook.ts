/**
 * The client side of the worker socket `~/.ferry/messaging/worker.sock`, and
 * the hook entry `ferry messaging hook <runtime> <event>` (section 8.1 of the
 * agent messaging design).
 *
 * The hooks and the MCP server talk only to the local worker. They hold no
 * relay credential. A hook exits with 0 on every error, and prints only the
 * context of the event. This module loads no relay, worker, or MCP SDK
 * module, so the hook starts fast.
 */

import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { createConnection } from "node:net";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { processStart } from "../process-start.ts";

/** The worker state directory, relative to the home. It is never in the snapshot and never in a checkout. */
export const MESSAGING_DIR = ".ferry/messaging";
const SPOOL_LIMIT = 500;

export function workerSocketPath(home: string): string {
  return join(home, MESSAGING_DIR, "worker.sock");
}

/** The process chain of a hook or MCP process, from the process itself up to pid 1. The worker finds the runtime process in it. */
export type Caller = { readonly ancestors: readonly { readonly pid: number; readonly startTime: string }[] };

export type LocalResponse =
  | { readonly v: 1; readonly id: string; readonly ok: true; readonly result: unknown }
  | { readonly v: 1; readonly id: string; readonly ok: false; readonly error: { readonly code: string; readonly message: string } };

/** The worker did not accept the connection: it does not run, or messaging is not set up on this host. */
export const WORKER_OFFLINE = "worker-offline";
/** The worker accepted the call, but did not answer in time. */
export const WORKER_TIMEOUT = "worker-timeout";

/**
 * Send one request to the worker and read one response line. A failed
 * connection gives the error `worker-offline`, and no answer in `timeoutMs`
 * gives `worker-timeout`. This function never throws.
 */
export function callWorker(
  socket: string,
  op: string,
  params: Record<string, unknown>,
  timeoutMs: number,
): Promise<LocalResponse> {
  const id = `${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const failure = (code: string, message: string): LocalResponse => ({ v: 1, id, ok: false, error: { code, message } });
  return new Promise((resolve) => {
    let connected = false;
    let buffer = "";
    let done = false;
    const finish = (response: LocalResponse) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      connection.destroy();
      resolve(response);
    };
    const connection = createConnection({ path: socket });
    const timer = setTimeout(
      () => finish(connected ? failure(WORKER_TIMEOUT, "The Ferry messaging worker did not answer in time.") : failure(WORKER_OFFLINE, "The Ferry messaging worker does not run on this host.")),
      timeoutMs,
    );
    connection.setEncoding("utf8");
    connection.on("connect", () => {
      connected = true;
      connection.write(`${JSON.stringify({ v: 1, id, op, params })}\n`);
    });
    connection.on("data", (chunk: string) => {
      buffer += chunk;
      const end = buffer.indexOf("\n");
      if (end < 0) return;
      finish(parseResponse(buffer.slice(0, end), id) ?? failure("invalid-response", "The Ferry messaging worker gave an invalid response."));
    });
    connection.on("error", () => finish(connected ? failure(WORKER_TIMEOUT, "The connection to the Ferry messaging worker failed.") : failure(WORKER_OFFLINE, "The Ferry messaging worker does not run on this host.")));
    connection.on("close", () => finish(failure(connected ? WORKER_TIMEOUT : WORKER_OFFLINE, "The Ferry messaging worker closed the connection.")));
  });
}

function parseResponse(line: string, id: string): LocalResponse | null {
  try {
    const value = JSON.parse(line) as Record<string, unknown>;
    if (value.v !== 1 || value.id !== id || typeof value.ok !== "boolean") return null;
    if (value.ok) return { v: 1, id, ok: true, result: value.result };
    const error = value.error as Record<string, unknown> | undefined;
    if (typeof error?.code !== "string" || typeof error.message !== "string") return null;
    return { v: 1, id, ok: false, error: { code: error.code, message: error.message } };
  } catch {
    return null;
  }
}

/** The parent of `pid`, or null when Ferry cannot read it. */
function processParent(pid: number): number | null {
  let value: string | undefined;
  try {
    if (process.platform === "linux") {
      // The fields start after the command name in parentheses, which can have spaces. The parent is field 4.
      const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
      value = stat.slice(stat.lastIndexOf(")") + 2).split(" ")[1];
    } else {
      const ps = spawnSync("/bin/ps", ["-o", "ppid=", "-p", String(pid)], { encoding: "utf8" });
      value = ps.status === 0 ? ps.stdout.trim() : undefined;
    }
  } catch {
    return null;
  }
  const parent = Number(value);
  return Number.isInteger(parent) && parent > 0 ? parent : null;
}

/** The process chain of `pid` up to pid 1, with the start of each process in the form of `processStart`. */
export function callerAncestors(pid: number = process.pid): Caller {
  const ancestors: { pid: number; startTime: string }[] = [];
  for (let current: number | null = pid; current !== null && ancestors.length < 64; current = processParent(current)) {
    const startTime = processStart(current);
    if (startTime === null) break;
    ancestors.push({ pid: current, startTime });
    if (current === 1) break;
  }
  return { ancestors };
}

/** The worker op of each hook event. The Claude `Notification` hook with the matcher `permission_prompt` is a permission request. */
const OPS: Readonly<Record<string, string>> = {
  SessionStart: "hook.sessionStart",
  UserPromptSubmit: "hook.userPromptSubmit",
  Stop: "hook.stop",
  PermissionRequest: "hook.permissionRequest",
  Notification: "hook.permissionRequest",
  PostToolUse: "hook.postToolUse",
  SessionEnd: "hook.sessionEnd",
};

/** The time that the hook waits for the worker: the answer times of section 8.1. Then the hook goes on without the worker. */
const TIMEOUTS: Readonly<Record<string, number>> = { SessionStart: 1_500, UserPromptSubmit: 1_500, SessionEnd: 500 };
const DEFAULT_TIMEOUT_MS = 1_500;

/** The fields of the hook input that the worker reads. Ferry sends no other field. */
const EVENT_FIELDS = ["session_id", "transcript_path", "cwd", "source", "reason", "hook_event_name"] as const;
/** The start of each Ferry envelope in a prompt. The worker reads only these, so no prompt text leaves the hook. */
const ENVELOPE_START = /<ferry-message id="msg_[0-9A-HJKMNP-TV-Z]{26}"/g;

export const OFFLINE_CONTEXT =
  "Ferry messaging is offline on this host. The ferry_* tools do not work now. Continue your own work, and do not wait for messages from other sessions.";

export type HookInput = { readonly runtime: string; readonly event: string };

export type HookDependencies = {
  readonly home: string;
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly readStdin: () => Promise<string>;
  readonly caller: () => Caller;
  readonly call: typeof callWorker;
  readonly now: () => number;
  readonly pid: number;
};

/**
 * Run one hook. Returns the text for stdout: the hook JSON with the context
 * for `SessionStart` and `UserPromptSubmit`, else an empty string. Without
 * `~/.ferry/messaging`, messaging is not set up on this host, and the hook
 * does nothing. When the worker does not run, the hook writes its request to
 * the spool, which the worker replays at start, and a `SessionStart` in a
 * checkout gets the offline context. This function never throws.
 */
export async function runHook(input: HookInput, dependencies: Partial<HookDependencies> = {}): Promise<string> {
  try {
    const resolved = { ...defaultDependencies(), ...dependencies };
    const { runtime, event } = input;
    // The hook loads nothing of hooks.ts, so that it starts fast. OPS has the events of both runtimes.
    if ((runtime !== "claude" && runtime !== "codex") || !Object.hasOwn(OPS, event)) return "";
    const directory = join(resolved.home, MESSAGING_DIR);
    if (!existsSync(directory)) return "";
    const hookEvent = hookFields(await resolved.readStdin());
    const params: Record<string, unknown> = { runtime, event: hookEvent, caller: resolved.caller() };
    if (event === "SessionStart") {
      params.env = {
        ...(resolved.env.CLAUDE_CODE_MESSAGING_SOCKET ? { messagingSocket: resolved.env.CLAUDE_CODE_MESSAGING_SOCKET } : {}),
        ...(resolved.env.CLAUDE_CODE_MESSAGING_TOKEN ? { messagingToken: resolved.env.CLAUDE_CODE_MESSAGING_TOKEN } : {}),
        ...(resolved.env.CODEX_HOME ? { codexHome: resolved.env.CODEX_HOME } : {}),
      };
    }
    const op = OPS[event]!;
    const response = await resolved.call(workerSocketPath(resolved.home), op, params, TIMEOUTS[event] ?? DEFAULT_TIMEOUT_MS);
    if (!response.ok) {
      if (response.error.code !== WORKER_OFFLINE) return "";
      spool(directory, op, params, resolved.now(), resolved.pid);
      return event === "SessionStart" && inCheckout(hookEvent.cwd) ? contextOutput(event, OFFLINE_CONTEXT) : "";
    }
    if (event !== "SessionStart" && event !== "UserPromptSubmit") return "";
    const context = (response.result as { additionalContext?: unknown } | null)?.additionalContext;
    return typeof context === "string" && context !== "" ? contextOutput(event, context) : "";
  } catch {
    return "";
  }
}

/** The hook output that gives the context to Claude Code and Codex. */
function contextOutput(event: string, context: string): string {
  return `${JSON.stringify({ hookSpecificOutput: { hookEventName: event, additionalContext: context } })}\n`;
}

/** The fields of the hook input that the worker reads. Of `prompt`, only the starts of the Ferry envelopes stay. */
export function hookFields(stdin: string): Record<string, unknown> {
  let value: unknown;
  try {
    value = JSON.parse(stdin);
  } catch {
    return {};
  }
  if (typeof value !== "object" || value === null) return {};
  const input = value as Record<string, unknown>;
  const fields: Record<string, unknown> = {};
  for (const field of EVENT_FIELDS) if (typeof input[field] === "string") fields[field] = input[field];
  if (typeof input.prompt === "string") fields.prompt = (input.prompt.match(ENVELOPE_START) ?? []).join("\n");
  return fields;
}

/** True when `cwd` is in a Git checkout. The hook reads only the file system, and runs no Git command. */
function inCheckout(cwd: unknown): boolean {
  if (typeof cwd !== "string" || !cwd.startsWith("/")) return false;
  for (let directory = cwd; ; directory = dirname(directory)) {
    if (existsSync(join(directory, ".git"))) return true;
    if (dirname(directory) === directory) return false;
  }
}

/** Write the request to `spool/<ms>-<pid>.json` (0600), as the same `LocalRequest` JSON as on the socket. A full spool takes no more files, so a long worker outage does not fill the disk. */
function spool(directory: string, op: string, params: Record<string, unknown>, now: number, pid: number): void {
  try {
    const spoolDirectory = join(directory, "spool");
    mkdirSync(spoolDirectory, { recursive: true, mode: 0o700 });
    if (readdirSync(spoolDirectory).length >= SPOOL_LIMIT) return;
    writeFileSync(join(spoolDirectory, `${now}-${pid}.json`), `${JSON.stringify({ v: 1, id: `spool-${now}-${pid}`, op, params })}\n`, { mode: 0o600, flag: "wx" });
  } catch {
    // The spool is a best effort. The hook still exits with 0.
  }
}

function defaultDependencies(): HookDependencies {
  return {
    home: homedir(),
    env: process.env,
    // A hook gives its input on stdin. A run in a terminal has none.
    readStdin: () => (process.stdin.isTTY ? Promise.resolve("") : Bun.stdin.text()),
    caller: () => callerAncestors(),
    call: callWorker,
    now: Date.now,
    pid: process.pid,
  };
}
