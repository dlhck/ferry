/**
 * The harness of the real-CLI suite (design 15.3).
 *
 * It starts real `claude` and `codex` sessions in tmux, launched the normal way,
 * with Ferry's hooks and MCP entry given as CLI options only (`--settings` and
 * `--mcp-config` for Claude, `-c` for Codex). It changes no global Claude or Codex
 * setting, and the runtimes keep their own logins.
 *
 * The relay and the fake GitHub run in this process. Each identity has its own
 * `HOME` for Ferry state only: the hooks, the MCP server, and the worker run with
 * that `HOME`, and the runtimes run with the real one.
 *
 * Opt-in: the suite runs only with `FERRY_E2E_RUNTIMES=1`, which the
 * `test:e2e-runtimes` script sets. It uses real model tokens.
 * Its state goes to `$FERRY_E2E_RUNTIMES_DIR` (default `~/.cache/ferry-e2e-runtimes`),
 * never to `/tmp` and never into a participating checkout.
 */

import { Database } from "bun:sqlite";
import { appendFileSync, copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { systemClock } from "../messaging/harness/clock.ts";
import { ALICE, BOB } from "../messaging/harness/homes.ts";
import { waitingFor } from "../messaging/harness/lanes.ts";
import { parseEnvelopes, relaySession, REPO_ROOT, RELAY_STACK_PARTS, startRelayStack, waitFor, type RelayStack, type ToolResult } from "../messaging/harness/system.ts";
import { callWorker } from "../messaging/harness/wire.ts";

export const enabled = process.env.FERRY_E2E_RUNTIMES === "1";
const waiting = waitingFor([...RELAY_STACK_PARTS, "cli"]);
export const ready = enabled && waiting.length === 0;

export function e2eTitle(title: string): string {
  if (!enabled) return `${title} (opt-in: bun run test:e2e-runtimes)`;
  return waiting.length === 0 ? title : `${title} (waits for ${waiting.join(", ")})`;
}

export const RUN_ROOT = process.env.FERRY_E2E_RUNTIMES_DIR ?? join(homedir(), ".cache", "ferry-e2e-runtimes");
export const RUN_ID = new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z");
export const RUN_DIR = join(RUN_ROOT, RUN_ID);
const CLI = join(REPO_ROOT, "src", "cli.ts");
const BUN = process.execPath;

export type Runtime = "claude" | "codex";

/** Design 11.3: the events, options, and timeouts of the Ferry hooks. */
const CLAUDE_HOOKS: readonly (readonly [string, { timeout: number; async?: boolean; matcher?: string }])[] = [
  ["SessionStart", { timeout: 10 }],
  ["UserPromptSubmit", { timeout: 5 }],
  ["Stop", { timeout: 5, async: true }],
  ["PermissionRequest", { timeout: 5 }],
  ["Notification", { timeout: 5, async: true, matcher: "permission_prompt" }],
  ["PostToolUse", { timeout: 5, async: true }],
  ["SessionEnd", { timeout: 2 }],
];
const CODEX_HOOKS: readonly (readonly [string, { timeout: number; async?: boolean }])[] = [
  ["SessionStart", { timeout: 10 }],
  ["UserPromptSubmit", { timeout: 5 }],
  ["PermissionRequest", { timeout: 5 }],
  ["Stop", { timeout: 5, async: true }],
  ["PostToolUse", { timeout: 5, async: true }],
  ["SessionEnd", { timeout: 1 }],
];

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

function hookCommand(home: string, runtime: Runtime, event: string): string {
  return `HOME=${shellQuote(home)} ${shellQuote(BUN)} ${shellQuote(CLI)} messaging hook ${runtime} ${event}`;
}

/** A TOML value for `codex -c`. JSON strings, numbers, and booleans are valid TOML. */
function toml(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(toml).join(",")}]`;
  if (value !== null && typeof value === "object") {
    return `{${Object.entries(value)
      .map(([key, entry]) => `${/^[A-Za-z0-9_-]+$/.test(key) ? key : JSON.stringify(key)}=${toml(entry)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function tmuxArgs(socket: string, ...args: string[]): string[] {
  return ["tmux", "-L", socket, ...args];
}

function run(argv: string[], env?: Record<string, string>): string {
  const result = Bun.spawnSync(argv, { env: env ?? (process.env as Record<string, string>), stdout: "pipe", stderr: "pipe" });
  if (result.exitCode !== 0) throw new Error(`${argv.join(" ")} failed: ${result.stderr.toString().trim()}`);
  return result.stdout.toString();
}

type ProcInfo = { ppid: number; startTime: string; comm: string };

/**
 * The parent, start time, and name of a process, in the form that the worker uses
 * (design 8.1): `/proc/<pid>/stat` field 22 on Linux, `ps -o lstart=` on macOS.
 */
function procStat(pid: number): ProcInfo | null {
  if (process.platform === "darwin") {
    const result = Bun.spawnSync(["ps", "-o", "ppid=,lstart=,comm=", "-p", String(pid)], { stdout: "pipe", stderr: "ignore" });
    const fields = result.stdout.toString().trim().split(/\s+/);
    if (result.exitCode !== 0 || fields.length < 7) return null;
    const comm = fields.slice(6).join(" ");
    return { ppid: Number(fields[0]), startTime: fields.slice(1, 6).join(" "), comm: comm.slice(comm.lastIndexOf("/") + 1) };
  }
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    const close = stat.lastIndexOf(")");
    const comm = stat.slice(stat.indexOf("(") + 1, close);
    const fields = stat.slice(close + 2).split(" ");
    // After the comm: field 3 is the state, field 4 the ppid, field 22 the start time.
    return { ppid: Number(fields[1]), startTime: fields[19] ?? "", comm };
  } catch {
    return null;
  }
}

/** The parent of each process. */
function processParents(): Map<number, number> {
  const parents = new Map<number, number>();
  if (process.platform === "darwin") {
    const result = Bun.spawnSync(["ps", "-axo", "pid=,ppid="], { stdout: "pipe" });
    for (const line of result.stdout.toString().trim().split("\n")) {
      const [pid, ppid] = line.trim().split(/\s+/).map(Number);
      if (pid !== undefined && ppid !== undefined) parents.set(pid, ppid);
    }
    return parents;
  }
  for (const entry of readdirSync("/proc")) {
    const pid = Number(entry);
    if (!Number.isInteger(pid)) continue;
    const stat = procStat(pid);
    if (stat !== null) parents.set(pid, stat.ppid);
  }
  return parents;
}

/** The ancestors of a process up to pid 1, as a hook child of it would send them (design 8.1). */
export function ancestors(pid: number): { pid: number; startTime: string }[] {
  const result: { pid: number; startTime: string }[] = [];
  for (let current = pid; current > 1; ) {
    const stat = procStat(current);
    if (stat === null) break;
    result.push({ pid: current, startTime: stat.startTime });
    current = stat.ppid;
  }
  return result;
}

/** The runtime process in the tree of the tmux pane: the first process with the runtime's name. */
function runtimePid(panePid: number, runtime: Runtime): number {
  const children = new Map<number, number[]>();
  for (const [pid, ppid] of processParents()) children.set(ppid, [...(children.get(ppid) ?? []), pid]);
  const queue = [panePid];
  while (queue.length > 0) {
    const pid = queue.shift()!;
    if (procStat(pid)?.comm === runtime) return pid;
    queue.push(...(children.get(pid) ?? []));
  }
  return panePid;
}

export type RealSession = {
  readonly login: string;
  readonly runtime: Runtime;
  readonly target: string;
  readonly cwd: string;
  pid: number;
  address: string;
  id: string;
  threadId: string | null;
  tool(name: string, args?: Record<string, unknown>): Promise<ToolResult>;
  /** The session as `ferry_peers` shows it: state and activity. */
  peer(): Promise<{ state: string; activity: string | null } | null>;
  capture(): string;
  /** Types text into the runtime and presses Enter, as the human does. */
  type(text: string): Promise<void>;
  keys(...keys: string[]): void;
  kill9(): void;
};

export type E2E = {
  readonly stack: RelayStack;
  /** The word that the test skill tells the agent to end each Ferry answer with. */
  readonly marker: string;
  launch(login: string, runtime: Runtime, options?: { readonly where?: "main" | "linked"; readonly allowedTools?: string; readonly resume?: RealSession }): Promise<RealSession>;
  sessions(): readonly RealSession[];
  /** Writes each pane to the run directory, for a failed case. */
  savePanes(label: string): void;
  stop(): Promise<void>;
};

/**
 * The bundled skill, copied into each Ferry home, with one test line. The marker is
 * only in this file, never in a message, so an answer with the marker proves that
 * the model read the skill that the `SessionStart` context named.
 */
function installSkill(home: string, marker: string): void {
  const source = join(REPO_ROOT, "skills", "ferry-messaging", "SKILL.md");
  const dir = join(home, ".agents", "skills", "ferry-messaging");
  mkdirSync(dir, { recursive: true });
  copyFileSync(source, join(dir, "SKILL.md"));
  appendFileSync(join(dir, "SKILL.md"), `\n\nTest run ${RUN_ID}: end the body of each ferry_send answer with the word ${marker}.\n`);
}

export async function startE2E(): Promise<E2E> {
  mkdirSync(join(RUN_DIR, "tmp"), { recursive: true });
  // The test homes and checkouts go under the run directory, not /tmp.
  process.env.TMPDIR = join(RUN_DIR, "tmp");
  const marker = `FERRY-E2E-${Math.random().toString(36).slice(2, 10).toUpperCase()}`;
  const stack = await startRelayStack({ identities: [ALICE, BOB], clock: systemClock });
  const socket = `ferry-e2e-${process.pid}`;
  const workers: Bun.Subprocess[] = [];
  for (const p of stack.participants.values()) {
    installSkill(p.home.home, marker);
    const log = Bun.file(join(RUN_DIR, `worker-${p.home.login}.log`));
    workers.push(Bun.spawn([BUN, CLI, "messaging", "worker"], { env: { ...process.env, HOME: p.home.home }, stdout: log, stderr: log }));
    await waitFor(() => existsSync(p.socketPath), { timeoutMs: 20_000, what: `the worker of ${p.home.login}` });
  }
  const sessions: RealSession[] = [];
  let count = 0;
  let server = false;

  const launch: E2E["launch"] = async (login, runtime, options = {}) => {
    const p = stack.participant(login);
    const cwd = options.where === "linked" ? p.checkout.linked : p.checkout.main;
    const target = `${runtime}-${login}-${++count}`;
    let command: string[];
    if (runtime === "claude") {
      const hooks: Record<string, unknown[]> = {};
      for (const [event, { matcher, ...hook }] of CLAUDE_HOOKS) {
        hooks[event] = [{ ...(matcher === undefined ? {} : { matcher }), hooks: [{ type: "command", command: hookCommand(p.home.home, "claude", event), ...hook }] }];
      }
      const settings = join(RUN_DIR, `${target}-settings.json`);
      writeFileSync(settings, JSON.stringify({ hooks, permissions: { allow: ["mcp__ferry-messaging"] } }, null, 2));
      const mcp = join(RUN_DIR, `${target}-mcp.json`);
      writeFileSync(
        mcp,
        JSON.stringify({ mcpServers: { "ferry-messaging": { command: BUN, args: [CLI, "messaging", "mcp"], env: { HOME: p.home.home } } } }, null, 2),
      );
      command = ["claude", "--settings", settings, "--mcp-config", mcp];
      if (options.allowedTools !== undefined) command.push("--allowedTools", options.allowedTools);
      if (options.resume !== undefined) command.push("--resume", options.resume.threadId ?? "");
    } else {
      const hooks: Record<string, unknown[]> = {};
      for (const [event, hook] of CODEX_HOOKS) hooks[event] = [{ hooks: [{ type: "command", command: hookCommand(p.home.home, "codex", event), ...hook }] }];
      command = [
        "codex",
        ...(options.resume !== undefined ? ["resume", options.resume.threadId ?? ""] : []),
        "-c",
        `projects=${toml({ [cwd]: { trust_level: "trusted" } })}`,
        "-c",
        `mcp_servers.ferry-messaging=${toml({ command: BUN, args: [CLI, "messaging", "mcp"], env: { HOME: p.home.home } })}`,
        "-c",
        `hooks=${toml(hooks)}`,
      ];
    }
    // The runtime keeps the real HOME and its login. CODEX_HOME is explicit, so the hook reports it.
    const env = `CODEX_HOME=${shellQuote(process.env.CODEX_HOME ?? join(homedir(), ".codex"))}`;
    const line = `cd ${shellQuote(cwd)} && exec env ${env} ${command.map(shellQuote).join(" ")}`;
    const tmux = server ? ["new-window", "-d", "-n", target] : ["new-session", "-d", "-x", "200", "-y", "50", "-s", "ferry-e2e", "-n", target];
    run(tmuxArgs(socket, ...tmux, line));
    server = true;
    const paneTarget = `ferry-e2e:${target}`;
    const panePid = Number(run(tmuxArgs(socket, "display", "-p", "-t", paneTarget, "#{pane_pid}")).trim());

    const session: RealSession = {
      login,
      runtime,
      target: paneTarget,
      cwd,
      pid: panePid,
      address: "",
      id: "",
      threadId: options.resume?.threadId ?? null,
      async tool(name, args = {}) {
        const reply = await callWorker(p.socketPath, "tool.call", { tool: name, arguments: args, caller: { ancestors: ancestors(session.pid) } });
        if (!reply.ok) throw new Error(`the worker refused ${name}: ${reply.error.code}`);
        return reply.result as ToolResult;
      },
      async peer() {
        const peers = await session.tool("ferry_peers", {});
        const found = (peers.result?.sessions as { address: string; state: string; activity: string | null }[] | undefined)?.find(
          (candidate) => candidate.address === session.address,
        );
        return found ?? null;
      },
      capture: () => run(tmuxArgs(socket, "capture-pane", "-p", "-t", paneTarget)),
      async type(text) {
        run(tmuxArgs(socket, "send-keys", "-t", paneTarget, "-l", text));
        await Bun.sleep(300);
        run(tmuxArgs(socket, "send-keys", "-t", paneTarget, "Enter"));
      },
      keys: (...keys) => void run(tmuxArgs(socket, "send-keys", "-t", paneTarget, ...keys)),
      kill9: () => process.kill(session.pid, "SIGKILL"),
    };

    // Registration: the SessionStart hook ran and the worker knows the runtime process.
    await waitFor(
      async () => {
        const screen = session.capture();
        if (/trust the files in this folder/i.test(screen)) session.keys("Enter");
        if (runtime === "codex" && /hook/i.test(screen) && /trust/i.test(screen)) {
          throw new Error("Codex asks to trust the Ferry hooks. The suite does not answer it, because the trust is a global Codex setting. See docs/agent-messaging-runtimes.md.");
        }
        session.pid = runtimePid(panePid, runtime);
        const whoami = await session.tool("ferry_whoami");
        const address = whoami.ok ? String(whoami.result?.address ?? "") : "";
        if (address === "") return null;
        const relay = await relaySession(p.http, p.checkout.key, address);
        if (relay === null) return null;
        session.address = address;
        session.id = relay.id;
        return relay;
      },
      { timeoutMs: 120_000, what: `the registration of ${target}` },
    );
    if (session.threadId === null) session.threadId = runtimeSessionId(stack, session);
    sessions.push(session);
    return session;
  };

  return {
    stack,
    marker,
    launch,
    sessions: () => sessions,
    savePanes(label) {
      for (const session of sessions) {
        try {
          writeFileSync(join(RUN_DIR, `${label}-${session.target.replace(/^:/, "")}.txt`), session.capture());
        } catch {
          // The pane is gone.
        }
      }
    },
    async stop() {
      try {
        run(tmuxArgs(socket, "kill-server"));
      } catch {
        // No server is left.
      }
      for (const worker of workers) worker.kill("SIGTERM");
      await Promise.all(workers.map((worker) => worker.exited));
      await stack.stop();
    },
  };
}

/**
 * The runtime session id (the Codex thread id), for a resume. The relay API does not
 * return it, so it comes from the worker store (design 8.2).
 */
function runtimeSessionId(stack: RelayStack, session: RealSession): string | null {
  const store = join(stack.participant(session.login).home.messagingDir, "worker.sqlite");
  if (!existsSync(store)) return null;
  const db = new Database(store, { readonly: true });
  try {
    const row = db.query("SELECT runtime_session_id AS id FROM local_sessions WHERE relay_session_id = ?").get(session.id) as { id: string } | null;
    return row?.id ?? null;
  } finally {
    db.close();
  }
}

/** The rows of the real Codex queue store for a thread. Read-only. */
export function codexQueuedRows(threadId: string): number {
  const path = join(process.env.CODEX_HOME ?? join(homedir(), ".codex"), "queue_1.sqlite");
  if (!existsSync(path)) return 0;
  const db = new Database(path, { readonly: true });
  try {
    return (db.query("SELECT count(*) AS n FROM queued_items WHERE thread_id = ?").get(threadId) as { n: number }).n;
  } finally {
    db.close();
  }
}

/** The request and its answer, from the relay, as the sender sees them. */
export async function requestOutcome(e2e: E2E, sender: RealSession, id: string) {
  const http = e2e.stack.participant(sender.login).http;
  const request = await http.get<{ message: { request?: { status: string; answer: string | null } }; receipts: { state: string; hold: string | null }[] }>(
    `/v1/messages/${id}?sessionId=${sender.id}`,
  );
  const answerId = request.body.message.request?.answer ?? null;
  const answer =
    answerId === null
      ? null
      : await http.get<{ message: { body: string; answers: string | null }; receipts: { state: string; evidence: { kind: string }[] }[] }>(
          `/v1/messages/${answerId}?sessionId=${sender.id}`,
        );
  return { request: request.body, answer: answer?.body ?? null };
}

export { parseEnvelopes, waitFor };
