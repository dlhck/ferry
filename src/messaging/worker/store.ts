/**
 * The local store of the messaging worker, `~/.ferry/messaging/worker.sqlite`
 * (design section 8.2). Mode 0600, WAL mode. It holds the Claude messaging
 * token of each live session, because the worker must reach the inbox socket
 * after a restart. The file stays on this host, outside each checkout and
 * outside the snapshot.
 *
 * The tables of the design have some more columns here: the relay identity of
 * a session (address, project, refusal), the activity at an injection (for
 * the frame check), the acknowledged messages (for the re-injection rule), and
 * the versions that the frame check marked.
 */

import { Database } from "bun:sqlite";
import { chmodSync, existsSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type { Attempt, LocalSession } from "../adapters/types.ts";
import type { Activity, AdapterState, Runtime } from "./protocol-stub.ts";

const SCHEMA = `
CREATE TABLE IF NOT EXISTS local_sessions (
  runtime_pid INTEGER NOT NULL, runtime_pid_start TEXT NOT NULL,
  runtime TEXT NOT NULL CHECK (runtime IN ('claude','codex')),
  runtime_session_id TEXT NOT NULL, runtime_version TEXT NOT NULL, runtime_exe TEXT NOT NULL,
  relay_session_id TEXT, transcript_path TEXT,
  claude_socket TEXT, claude_token TEXT,
  codex_home TEXT,
  state TEXT NOT NULL CHECK (state IN ('live','offline')),
  activity TEXT CHECK (activity IN ('idle','busy','awaiting-approval')),
  turn_origin TEXT NOT NULL DEFAULT 'human' CHECK (turn_origin IN ('human','peer')),
  turn_causes TEXT NOT NULL DEFAULT '[]',
  turn_ended_at TEXT, registered_at TEXT NOT NULL, ended_at TEXT,
  address TEXT, owner_login TEXT, project_id TEXT, project_key TEXT, refusal TEXT,
  adapter TEXT NOT NULL DEFAULT 'unsupported', adapter_reason TEXT,
  PRIMARY KEY (runtime, runtime_session_id)
);
CREATE INDEX IF NOT EXISTS local_sessions_pid ON local_sessions (runtime_pid, runtime_pid_start);
CREATE INDEX IF NOT EXISTS local_sessions_relay ON local_sessions (relay_session_id);
CREATE TABLE IF NOT EXISTS outbox (
  key TEXT PRIMARY KEY,
  method TEXT NOT NULL, path TEXT NOT NULL, body TEXT NOT NULL,
  session_id TEXT, created_at TEXT NOT NULL, attempts INTEGER NOT NULL DEFAULT 0,
  next_at TEXT NOT NULL, last_error TEXT,
  state TEXT NOT NULL CHECK (state IN ('pending','sent','failed'))
);
CREATE INDEX IF NOT EXISTS outbox_state ON outbox (state, next_at);
CREATE TABLE IF NOT EXISTS attempts (
  receipt_id TEXT NOT NULL, attempt INTEGER NOT NULL, generation INTEGER NOT NULL,
  session_id TEXT NOT NULL, message_id TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('queued','dispatching','held','dropped','injecting','injected','failed','confirmed','unconfirmed','stranded')),
  runtime_ref TEXT,
  transcript_offset INTEGER, injected_at TEXT, watch_until TEXT, updated_at TEXT NOT NULL,
  activity TEXT,
  PRIMARY KEY (receipt_id, attempt)
);
CREATE INDEX IF NOT EXISTS attempts_state ON attempts (state);
CREATE TABLE IF NOT EXISTS digest (session_id TEXT NOT NULL, receipt_id TEXT NOT NULL, message_json TEXT NOT NULL, added_at TEXT NOT NULL, PRIMARY KEY (session_id, receipt_id));
CREATE TABLE IF NOT EXISTS cursor (id INTEGER PRIMARY KEY CHECK (id = 1), seq INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS acks (session_id TEXT NOT NULL, message_id TEXT NOT NULL, at TEXT NOT NULL, PRIMARY KEY (session_id, message_id));
CREATE TABLE IF NOT EXISTS runtime_marks (
  runtime TEXT NOT NULL, version TEXT NOT NULL,
  streak INTEGER NOT NULL DEFAULT 0,
  unconfirmed_by TEXT,
  PRIMARY KEY (runtime, version)
);
`;

/** A session row with the relay fields of this store. */
export type StoredSession = LocalSession & {
  readonly turnOrigin: "human" | "peer";
  readonly turnCauses: readonly string[];
  readonly turnEndedAt: string | null;
  readonly endedAt: string | null;
  readonly address: string | null;
  readonly ownerLogin: string | null;
  readonly projectId: string | null;
  readonly projectKey: string | null;
  readonly refusal: { readonly code: string; readonly message: string } | null;
  readonly adapter: AdapterState;
  readonly adapterReason: string | null;
};

export type AttemptState = "queued" | "dispatching" | "held" | "dropped" | "injecting" | "injected" | "failed" | "confirmed" | "unconfirmed" | "stranded";

export type StoredAttempt = Attempt & {
  readonly state: AttemptState;
  readonly watchUntil: string | null;
  readonly updatedAt: string;
  readonly activity: Activity | null;
};

export type OutboxEntry = {
  readonly key: string;
  readonly method: string;
  readonly path: string;
  readonly body: string;
  readonly sessionId: string | null;
  readonly createdAt: string;
  readonly attempts: number;
  readonly nextAt: string;
  readonly lastError: string | null;
  readonly state: "pending" | "sent" | "failed";
};

export type DigestRow = { readonly sessionId: string; readonly receiptId: string; readonly item: unknown; readonly addedAt: string };

type Row = Record<string, string | number | null>;

const str = (value: unknown): string | null => (typeof value === "string" ? value : null);

function toSession(row: Row): StoredSession {
  return {
    runtime: row.runtime as Runtime,
    runtimeSessionId: row.runtime_session_id as string,
    runtimeVersion: row.runtime_version as string,
    runtimeExe: row.runtime_exe as string,
    runtimePid: row.runtime_pid as number,
    runtimePidStart: row.runtime_pid_start as string,
    relaySessionId: str(row.relay_session_id),
    transcriptPath: str(row.transcript_path),
    claudeSocket: str(row.claude_socket),
    claudeToken: str(row.claude_token),
    codexHome: str(row.codex_home),
    state: row.state as "live" | "offline",
    activity: str(row.activity) as Activity | null,
    registeredAt: row.registered_at as string,
    turnOrigin: row.turn_origin as "human" | "peer",
    turnCauses: JSON.parse(row.turn_causes as string) as string[],
    turnEndedAt: str(row.turn_ended_at),
    endedAt: str(row.ended_at),
    address: str(row.address),
    ownerLogin: str(row.owner_login),
    projectId: str(row.project_id),
    projectKey: str(row.project_key),
    refusal: row.refusal ? (JSON.parse(row.refusal as string) as { code: string; message: string }) : null,
    adapter: row.adapter as AdapterState,
    adapterReason: str(row.adapter_reason),
  };
}

function toAttempt(row: Row): StoredAttempt {
  return {
    receiptId: row.receipt_id as string,
    attempt: row.attempt as number,
    generation: row.generation as number,
    sessionId: row.session_id as string,
    messageId: row.message_id as string,
    runtimeRef: str(row.runtime_ref),
    transcriptOffset: typeof row.transcript_offset === "number" ? row.transcript_offset : null,
    injectedAt: str(row.injected_at),
    state: row.state as AttemptState,
    watchUntil: str(row.watch_until),
    updatedAt: row.updated_at as string,
    activity: str(row.activity) as Activity | null,
  };
}

function toOutbox(row: Row): OutboxEntry {
  return {
    key: row.key as string,
    method: row.method as string,
    path: row.path as string,
    body: row.body as string,
    sessionId: str(row.session_id),
    createdAt: row.created_at as string,
    attempts: row.attempts as number,
    nextAt: row.next_at as string,
    lastError: str(row.last_error),
    state: row.state as OutboxEntry["state"],
  };
}

/** The columns of `local_sessions` that `updateSession` can change, by field name. */
const SESSION_COLUMNS = {
  runtimeVersion: "runtime_version",
  runtimeExe: "runtime_exe",
  runtimePid: "runtime_pid",
  runtimePidStart: "runtime_pid_start",
  relaySessionId: "relay_session_id",
  transcriptPath: "transcript_path",
  claudeSocket: "claude_socket",
  claudeToken: "claude_token",
  codexHome: "codex_home",
  state: "state",
  activity: "activity",
  turnOrigin: "turn_origin",
  turnCauses: "turn_causes",
  turnEndedAt: "turn_ended_at",
  registeredAt: "registered_at",
  endedAt: "ended_at",
  address: "address",
  ownerLogin: "owner_login",
  projectId: "project_id",
  projectKey: "project_key",
  refusal: "refusal",
  adapter: "adapter",
  adapterReason: "adapter_reason",
} as const;

export type SessionChange = { -readonly [K in keyof typeof SESSION_COLUMNS]?: StoredSession[K] };

const ATTEMPT_COLUMNS = {
  state: "state",
  runtimeRef: "runtime_ref",
  transcriptOffset: "transcript_offset",
  injectedAt: "injected_at",
  watchUntil: "watch_until",
  activity: "activity",
} as const;

export type AttemptChange = { -readonly [K in keyof typeof ATTEMPT_COLUMNS]?: StoredAttempt[K] };

function columnValue(value: unknown): string | number | null {
  if (value === null || value === undefined) return null;
  if (typeof value === "string" || typeof value === "number") return value;
  return JSON.stringify(value);
}

export class WorkerStore {
  readonly db: Database;

  constructor(path: string) {
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    const created = !existsSync(path);
    this.db = new Database(path, { create: true });
    if (created) chmodSync(path, 0o600);
    this.db.exec("PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000;");
    this.db.exec(SCHEMA);
  }

  close(): void {
    this.db.close();
  }

  // Sessions

  insertSession(session: StoredSession): void {
    this.db
      .query(
        `INSERT OR REPLACE INTO local_sessions (runtime_pid, runtime_pid_start, runtime, runtime_session_id, runtime_version, runtime_exe,
          relay_session_id, transcript_path, claude_socket, claude_token, codex_home, state, activity, turn_origin, turn_causes,
          turn_ended_at, registered_at, ended_at, address, owner_login, project_id, project_key, refusal, adapter, adapter_reason)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        session.runtimePid,
        session.runtimePidStart,
        session.runtime,
        session.runtimeSessionId,
        session.runtimeVersion,
        session.runtimeExe,
        session.relaySessionId,
        session.transcriptPath,
        session.claudeSocket,
        session.claudeToken,
        session.codexHome,
        session.state,
        session.activity,
        session.turnOrigin,
        JSON.stringify(session.turnCauses),
        session.turnEndedAt,
        session.registeredAt,
        session.endedAt,
        session.address,
        session.ownerLogin,
        session.projectId,
        session.projectKey,
        columnValue(session.refusal),
        session.adapter,
        session.adapterReason,
      );
  }

  updateSession(runtime: Runtime, runtimeSessionId: string, change: SessionChange): void {
    const entries = Object.entries(change).filter(([, value]) => value !== undefined);
    if (entries.length === 0) return;
    const sets = entries.map(([field]) => `${SESSION_COLUMNS[field as keyof typeof SESSION_COLUMNS]} = ?`).join(", ");
    this.db
      .query(`UPDATE local_sessions SET ${sets} WHERE runtime = ? AND runtime_session_id = ?`)
      .run(...entries.map(([, value]) => columnValue(value)), runtime, runtimeSessionId);
  }

  session(runtime: Runtime, runtimeSessionId: string): StoredSession | null {
    const row = this.db.query("SELECT * FROM local_sessions WHERE runtime = ? AND runtime_session_id = ?").get(runtime, runtimeSessionId) as Row | null;
    return row ? toSession(row) : null;
  }

  sessionByRelayId(relaySessionId: string): StoredSession | null {
    const row = this.db.query("SELECT * FROM local_sessions WHERE relay_session_id = ?").get(relaySessionId) as Row | null;
    return row ? toSession(row) : null;
  }

  /** The live sessions of one runtime process. A process has one current session: the one registered last. */
  sessionsOfProcess(pid: number, start: string): StoredSession[] {
    const rows = this.db
      .query("SELECT * FROM local_sessions WHERE runtime_pid = ? AND runtime_pid_start = ? AND state = 'live' ORDER BY registered_at DESC")
      .all(pid, start) as Row[];
    return rows.map(toSession);
  }

  sessions(): StoredSession[] {
    return (this.db.query("SELECT * FROM local_sessions ORDER BY registered_at").all() as Row[]).map(toSession);
  }

  // Outbox

  insertOutbox(entry: OutboxEntry): void {
    this.db
      .query("INSERT INTO outbox (key, method, path, body, session_id, created_at, attempts, next_at, last_error, state) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
      .run(entry.key, entry.method, entry.path, entry.body, entry.sessionId, entry.createdAt, entry.attempts, entry.nextAt, entry.lastError, entry.state);
  }

  updateOutbox(key: string, change: { state: OutboxEntry["state"]; attempts: number; nextAt: string; lastError: string | null }): void {
    this.db.query("UPDATE outbox SET state = ?, attempts = ?, next_at = ?, last_error = ? WHERE key = ?").run(change.state, change.attempts, change.nextAt, change.lastError, key);
  }

  outboxEntry(key: string): OutboxEntry | null {
    const row = this.db.query("SELECT * FROM outbox WHERE key = ?").get(key) as Row | null;
    return row ? toOutbox(row) : null;
  }

  /** The pending entries whose next try is due, oldest first. */
  dueOutbox(now: string): OutboxEntry[] {
    return (this.db.query("SELECT * FROM outbox WHERE state = 'pending' AND next_at <= ? ORDER BY created_at, key").all(now) as Row[]).map(toOutbox);
  }

  outboxEntries(state: "pending" | "failed", sessionId?: string): OutboxEntry[] {
    const rows =
      sessionId === undefined
        ? this.db.query("SELECT * FROM outbox WHERE state = ? ORDER BY created_at").all(state)
        : this.db.query("SELECT * FROM outbox WHERE state = ? AND session_id = ? ORDER BY created_at").all(state, sessionId);
    return (rows as Row[]).map(toOutbox);
  }

  // Attempts

  /** A new attempt row for a receipt, with the next attempt number. */
  insertAttempt(receiptId: string, generation: number, sessionId: string, messageId: string, now: string): StoredAttempt {
    const last = this.db.query("SELECT MAX(attempt) AS n FROM attempts WHERE receipt_id = ?").get(receiptId) as { n: number | null };
    const attempt = (last.n ?? 0) + 1;
    this.db
      .query("INSERT INTO attempts (receipt_id, attempt, generation, session_id, message_id, state, updated_at) VALUES (?, ?, ?, ?, ?, 'queued', ?)")
      .run(receiptId, attempt, generation, sessionId, messageId, now);
    return this.attempt(receiptId, attempt)!;
  }

  updateAttempt(receiptId: string, attempt: number, change: AttemptChange, now: string): void {
    const entries = Object.entries(change).filter(([, value]) => value !== undefined);
    const sets = [...entries.map(([field]) => `${ATTEMPT_COLUMNS[field as keyof typeof ATTEMPT_COLUMNS]} = ?`), "updated_at = ?"].join(", ");
    this.db.query(`UPDATE attempts SET ${sets} WHERE receipt_id = ? AND attempt = ?`).run(...entries.map(([, value]) => columnValue(value)), now, receiptId, attempt);
  }

  attempt(receiptId: string, attempt: number): StoredAttempt | null {
    const row = this.db.query("SELECT * FROM attempts WHERE receipt_id = ? AND attempt = ?").get(receiptId, attempt) as Row | null;
    return row ? toAttempt(row) : null;
  }

  latestAttempt(receiptId: string): StoredAttempt | null {
    const row = this.db.query("SELECT * FROM attempts WHERE receipt_id = ? ORDER BY attempt DESC LIMIT 1").get(receiptId) as Row | null;
    return row ? toAttempt(row) : null;
  }

  /** The latest attempt of each receipt, for the states given. */
  latestAttempts(states: readonly AttemptState[]): StoredAttempt[] {
    const marks = states.map(() => "?").join(", ");
    const rows = this.db
      .query(
        `SELECT a.* FROM attempts a JOIN (SELECT receipt_id, MAX(attempt) AS attempt FROM attempts GROUP BY receipt_id) l
         ON a.receipt_id = l.receipt_id AND a.attempt = l.attempt WHERE a.state IN (${marks}) ORDER BY a.updated_at`,
      )
      .all(...states) as Row[];
    return rows.map(toAttempt);
  }

  attemptsOfSession(sessionId: string, states: readonly AttemptState[]): StoredAttempt[] {
    return this.latestAttempts(states).filter((attempt) => attempt.sessionId === sessionId);
  }

  // Digest

  addDigest(sessionId: string, receiptId: string, item: unknown, now: string): void {
    this.db.query("INSERT OR REPLACE INTO digest (session_id, receipt_id, message_json, added_at) VALUES (?, ?, ?, ?)").run(sessionId, receiptId, JSON.stringify(item), now);
  }

  digest(sessionId: string): DigestRow[] {
    const rows = this.db.query("SELECT * FROM digest WHERE session_id = ? ORDER BY added_at, receipt_id").all(sessionId) as Row[];
    return rows.map((row) => ({ sessionId: row.session_id as string, receiptId: row.receipt_id as string, item: JSON.parse(row.message_json as string), addedAt: row.added_at as string }));
  }

  removeDigest(sessionId: string, receiptId: string): void {
    this.db.query("DELETE FROM digest WHERE session_id = ? AND receipt_id = ?").run(sessionId, receiptId);
  }

  // Cursor

  cursor(): number {
    const row = this.db.query("SELECT seq FROM cursor WHERE id = 1").get() as { seq: number } | null;
    return row?.seq ?? 0;
  }

  setCursor(seq: number): void {
    this.db.query("INSERT INTO cursor (id, seq) VALUES (1, ?) ON CONFLICT (id) DO UPDATE SET seq = excluded.seq").run(seq);
  }

  // Acks

  addAck(sessionId: string, messageId: string, now: string): void {
    this.db.query("INSERT OR IGNORE INTO acks (session_id, message_id, at) VALUES (?, ?, ?)").run(sessionId, messageId, now);
  }

  acked(sessionId: string, messageId: string): boolean {
    return this.db.query("SELECT 1 FROM acks WHERE session_id = ? AND message_id = ?").get(sessionId, messageId) !== null;
  }

  // Frame check marks

  /** Count an unconfirmed attempt on an idle session. Returns the streak. */
  addUnconfirmed(runtime: Runtime, version: string): number {
    this.db
      .query("INSERT INTO runtime_marks (runtime, version, streak) VALUES (?, ?, 1) ON CONFLICT (runtime, version) DO UPDATE SET streak = streak + 1")
      .run(runtime, version);
    return (this.db.query("SELECT streak FROM runtime_marks WHERE runtime = ? AND version = ?").get(runtime, version) as { streak: number }).streak;
  }

  resetStreak(runtime: Runtime, version: string): void {
    this.db.query("UPDATE runtime_marks SET streak = 0 WHERE runtime = ? AND version = ?").run(runtime, version);
  }

  /** Mark the version `unconfirmed` for this Ferry version. A new Ferry version clears the mark. */
  markUnconfirmed(runtime: Runtime, version: string, ferryVersion: string): void {
    this.db.query("UPDATE runtime_marks SET unconfirmed_by = ? WHERE runtime = ? AND version = ?").run(ferryVersion, runtime, version);
  }

  isUnconfirmed(runtime: Runtime, version: string, ferryVersion: string): boolean {
    return this.db.query("SELECT 1 FROM runtime_marks WHERE runtime = ? AND version = ? AND unconfirmed_by = ?").get(runtime, version, ferryVersion) !== null;
  }
}
