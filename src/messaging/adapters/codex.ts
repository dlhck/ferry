/**
 * The Codex adapter (design section 9.3). It runs
 * `codex queue --thread <id> --message <envelope>` with the `CODEX_HOME` of
 * the session, and never with `--resume`, because `--resume` can start a
 * stopped thread. A live thread takes the queued message after its current
 * turn.
 *
 * Risk R2: the queue store, the output line of `codex queue`, and the thread
 * writer lock are internal to Codex. `CODEX_INTERNALS` is the only place that
 * knows them, so a change in a Codex release is one edit there. Ferry only
 * reads the queue store and the lock table. It never deletes a queue row and
 * never takes the lock.
 */

import { Database } from "bun:sqlite";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { alive, flockHolders, systemProcesses, type ProcessTable } from "../worker/registry.ts";
import { transcriptHas } from "./transcript.ts";
import { gate, type Adapter, type LocalSession } from "./types.ts";

export const CODEX_MINIMUM = "0.169.0";
/** The versions that passed the real-CLI suite. Lane E's suite keeps `docs/agent-messaging-runtimes.md` and this list the same. */
export const CODEX_PASSED: readonly string[] = ["0.169.0"];

/** The Codex details that are not documented (R2), observed on 0.169.0. */
export const CODEX_INTERNALS = {
  /** The queue store in `CODEX_HOME`, and the table and columns that Ferry reads. */
  queueStore: "queue_1.sqlite",
  queueRow: "SELECT 1 FROM queued_items WHERE id = ?",
  /** The lock file of a loaded thread in `CODEX_HOME`. The process that has the thread holds a `flock` write lock on it. */
  lockFile: (thread: string) => join("thread-writer-locks", `${thread}.lock`),
  /** The line that `codex queue` prints. */
  queuedLine: /^Queued message (\S+) for thread \S+\.$/m,
  /** The output of `codex --version`. */
  versionLine: /^codex-cli (\d+\.\d+\.\d+)/m,
} as const;

/** The time after registration in which the thread can take its writer lock (the capability check). */
const CAPABILITY_WAIT_MS = 10_000;
const QUEUE_TIMEOUT_MS = 10_000;

export type RunResult = { readonly status: number | null; readonly stdout: string };

export type CodexAdapterInput = {
  readonly now: () => number;
  readonly processes?: ProcessTable;
  /** The pids that hold a `flock` write lock on a file. Null when the file does not exist or the locks are not readable. */
  readonly lockHolders?: (path: string) => number[] | null;
  /** Run a program with arguments and extra environment. */
  readonly run?: (program: string, args: readonly string[], env: Record<string, string>) => RunResult;
};

function defaultRun(program: string, args: readonly string[], env: Record<string, string>): RunResult {
  const result = spawnSync(program, args, { encoding: "utf8", env: { ...process.env, ...env }, timeout: QUEUE_TIMEOUT_MS, stdio: ["ignore", "pipe", "pipe"] });
  return { status: result.status, stdout: result.stdout ?? "" };
}

/**
 * True when the queue row is still in the store, false when it is gone, and
 * null when Ferry cannot read the store.
 */
export function queueRowExists(codexHome: string, id: string): boolean | null {
  let db: Database | null = null;
  try {
    db = new Database(join(codexHome, CODEX_INTERNALS.queueStore), { readonly: true });
    return db.query(CODEX_INTERNALS.queueRow).get(id) !== null;
  } catch {
    return null;
  } finally {
    db?.close();
  }
}

export function createCodexAdapter(input: CodexAdapterInput): Adapter {
  const processes = input.processes ?? systemProcesses;
  const lockHolders = input.lockHolders ?? flockHolders;
  const run = input.run ?? defaultRun;
  // The sessions whose process held the writer lock once. For them, a lock without the process means the thread is gone.
  const lockSeen = new Set<string>();

  const holdsLock = (session: LocalSession): boolean => {
    if (!session.codexHome) return false;
    const held = lockHolders(join(session.codexHome, CODEX_INTERNALS.lockFile(session.runtimeSessionId)))?.includes(session.runtimePid) ?? false;
    if (held) lockSeen.add(session.runtimeSessionId);
    return held;
  };

  const live = (session: LocalSession): boolean => {
    if (!alive(session.runtimePid, session.runtimePidStart, processes)) return false;
    // Without the lock layout, liveness is the process and SessionEnd only.
    return holdsLock(session) || !lockSeen.has(session.runtimeSessionId);
  };

  return {
    runtime: "codex",
    version(output) {
      return CODEX_INTERNALS.versionLine.exec(output.trim())?.[1] ?? null;
    },
    async check(session) {
      const result = gate("Codex", session.runtimeVersion, CODEX_MINIMUM, CODEX_PASSED);
      if (result.adapter === "unsupported") return result;
      if (!session.codexHome) return { adapter: "unsupported", reason: "The session has no Codex home." };
      if (holdsLock(session) || input.now() - Date.parse(session.registeredAt) < CAPABILITY_WAIT_MS) return result;
      return { adapter: "untested", reason: "The Codex thread writer lock is not where Ferry expects it. Ferry uses only the process and SessionEnd for liveness." };
    },
    async live(session) {
      return live(session);
    },
    async inject(session, envelope) {
      if (!session.codexHome) return { ok: false, error: "The session has no Codex home." };
      // Known limit: the envelope is an argument, so other OS users on the
      // host can see it in the process list while `codex queue` runs. Codex
      // 0.169.0 has no option to read the message from stdin or a file.
      const result = run(session.runtimeExe, ["queue", "--thread", session.runtimeSessionId, "--message", envelope], { CODEX_HOME: session.codexHome });
      // The output can echo the message, so the error has only the exit status.
      if (result.status !== 0) return { ok: false, error: `codex queue exited with ${result.status ?? "a signal"}.` };
      return { ok: true, runtimeRef: CODEX_INTERNALS.queuedLine.exec(result.stdout)?.[1] ?? null };
    },
    async confirm(session, attempt) {
      if (transcriptHas(session.transcriptPath, attempt.transcriptOffset ?? 0, attempt.messageId)) return { state: "delivered", evidence: "transcript" };
      const isLive = live(session);
      const row = attempt.runtimeRef && session.codexHome ? queueRowExists(session.codexHome, attempt.runtimeRef) : null;
      if (row === false && isLive && holdsLock(session)) return { state: "delivered", evidence: "codex-queue-consumed" };
      if (!isLive && row !== false) return { state: "stranded" };
      return { state: "pending" };
    },
  };
}
