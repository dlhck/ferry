/**
 * The relay store: one SQLite file through `bun:sqlite` (design section 10.1).
 *
 * - `~/.ferry/relay/relay.db` with mode 0600, in a directory with mode 0700.
 * - WAL mode, `synchronous = FULL`, foreign keys on, a busy timeout of 5 seconds.
 * - The schema version is in `PRAGMA user_version`. `openStore` runs the migrations.
 * - All times come from the injectable clock, as ISO 8601 UTC strings with milliseconds.
 * - Each state change and its `events` row commit in one transaction.
 *
 * The relay lock is a second SQLite file, `relay.lock`, in which the relay holds an
 * exclusive transaction. The operating system releases it when the process stops.
 */

import { Database } from "bun:sqlite";
import { chmodSync, existsSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import type { ErrorCode, RelayEvent } from "../protocol.ts";
import { migrate } from "./migrate.ts";

/** Milliseconds since the epoch. Tests give a fake clock. */
export type Clock = { now(): number };

export const systemClock: Clock = { now: () => Date.now() };

export type Store = {
  readonly db: Database;
  readonly path: string;
  readonly clock: Clock;
  now(): number;
  /** The time `at`, or now, as an ISO 8601 UTC string with milliseconds. */
  iso(at?: number): string;
  /** Run `fn` in one immediate transaction. A throw rolls it back. Nested calls use savepoints. */
  tx<T>(fn: () => T): T;
  /** Call `listener` after a commit that added an event for `deviceId`. Returns the function that removes it. */
  subscribe(deviceId: string, listener: () => void): () => void;
  /** Called by `emit`. The listeners run after the current synchronous code, so after the commit. */
  notify(deviceIds: readonly string[]): void;
  close(): void;
};

/** An error with a protocol code. The server turns it into the error body of design section 7.1. */
export class RelayError extends Error {
  constructor(
    readonly code: ErrorCode,
    message: string,
    readonly hint: string | null = null,
    readonly details?: Readonly<Record<string, unknown>>,
  ) {
    super(message);
    this.name = "RelayError";
  }
}

export function iso(at: number): string {
  return new Date(at).toISOString();
}

export function openStore(path: string, clock: Clock = systemClock): Store {
  ensurePrivateDir(dirname(path));
  const created = !existsSync(path);
  const db = new Database(path, { create: true, strict: true });
  if (created) chmodSync(path, 0o600);
  db.run("PRAGMA journal_mode = WAL");
  db.run("PRAGMA synchronous = FULL");
  db.run("PRAGMA foreign_keys = ON");
  db.run("PRAGMA busy_timeout = 5000");
  migrate(db, path, clock);
  const listeners = new Map<string, Set<() => void>>();
  const store: Store = {
    db,
    path,
    clock,
    now: () => clock.now(),
    iso: (at) => iso(at ?? clock.now()),
    tx: (fn) => (db.inTransaction ? db.transaction(fn)() : db.transaction(fn).immediate()),
    subscribe(deviceId, listener) {
      let set = listeners.get(deviceId);
      if (set === undefined) listeners.set(deviceId, (set = new Set()));
      set.add(listener);
      return () => void set.delete(listener);
    },
    notify(deviceIds) {
      const calls = deviceIds.flatMap((deviceId) => [...(listeners.get(deviceId) ?? [])]);
      if (calls.length > 0) queueMicrotask(() => calls.forEach((call) => call()));
    },
    close: () => db.close(),
  };
  return store;
}

/** Make the directory with mode 0700 when it is missing. */
export function ensurePrivateDir(dir: string): void {
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: 0o700 });
}

/**
 * Take the relay lock in `dir`. Returns the function that releases it, or null
 * when another relay holds it.
 */
export function acquireRelayLock(dir: string): (() => void) | null {
  ensurePrivateDir(dir);
  const path = join(dir, "relay.lock");
  const lock = new Database(path, { create: true });
  chmodSync(path, 0o600);
  lock.run("PRAGMA busy_timeout = 0");
  try {
    lock.run("BEGIN EXCLUSIVE");
  } catch {
    lock.close();
    return null;
  }
  return () => {
    lock.run("ROLLBACK");
    lock.close();
  };
}

/** The payload of an event without its sequence number. */
export type EventPayload = RelayEvent extends infer E ? (E extends RelayEvent ? Omit<E, "seq"> : never) : never;

/**
 * Add an event for the devices in `deviceIds`. Call it in the transaction of the
 * state change. The workers of the devices get it from the long poll.
 */
export function emit(store: Store, event: EventPayload, deviceIds: readonly string[]): void {
  const targets = [...new Set(deviceIds)];
  if (targets.length === 0) return;
  const { type, ...payload } = event;
  const row = store.db
    .query<{ seq: number }, [string, string, string]>("INSERT INTO events (type, payload, at) VALUES (?, ?, ?) RETURNING seq")
    .get(type, JSON.stringify(payload), store.iso());
  const insert = store.db.query("INSERT INTO event_targets (device_id, seq) VALUES (?, ?)");
  for (const deviceId of targets) insert.run(deviceId, row?.seq ?? 0);
  store.notify(targets);
}

/** The device of a session, for the target of an event. */
export function deviceOf(store: Store, sessionId: string): string {
  const row = store.db.query<{ device_id: string }, [string]>("SELECT device_id FROM sessions WHERE id = ?").get(sessionId);
  if (row === null) throw new RelayError("not-found", `Session ${sessionId} does not exist.`);
  return row.device_id;
}

export function getMeta(store: Store, key: string): string | null {
  return store.db.query<{ value: string }, [string]>("SELECT value FROM meta WHERE key = ?").get(key)?.value ?? null;
}

export function setMeta(store: Store, key: string, value: string): void {
  store.db.query("INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value").run(key, value);
}
