/**
 * The limits of the relay (design sections 6.5 and 13), and the checks of the
 * rate limits.
 */

import { RelayError, type Store } from "./store.ts";

export const MINUTE = 60_000;
export const HOUR = 60 * MINUTE;
export const DAY = 24 * HOUR;

export const WAKES_PER_HOUR = 20;
export const WAKE_WINDOW_MS = HOUR;
/** A message with a hop above this does not wake. */
export const MAX_HOPS = 6;
export const SENDS_PER_HOUR = 120;
export const CREATES_PER_HOUR = 10;
export const MAX_MEMBERS = 100;
export const MAX_ACTIVE_CONSTRAINTS = 50;
export const LEASE_MS = 2 * MINUTE;
/** A receipt gets at most this many `go` decisions: the first injection and one re-injection. */
export const MAX_ATTEMPTS = 2;
export const FAILED_RETRY_MS = MINUTE;
export const MAX_FAILURES = 3;
export const HEARTBEAT_STALE_MS = 90_000;
export const RECHECK_MS = 15 * MINUTE;
export const OUTAGE_GRACE_MS = HOUR;
export const LONG_POLL_MAX_MS = 25_000;
export const EVENTS_PER_POLL = 200;
export const PAGE_LIMIT = 50;

export const RETENTION = {
  idempotencyMs: 7 * DAY,
  eventsMs: 30 * DAY,
  wakeLogMs: 2 * HOUR,
} as const;

/** The wakes of a session in the rolling window that ends now. */
export function wakesInWindow(store: Store, sessionId: string): number {
  const since = store.iso(store.now() - WAKE_WINDOW_MS);
  return (
    store.db.query<{ n: number }, [string, string]>("SELECT count(*) AS n FROM wake_log WHERE session_id = ? AND at > ?").get(sessionId, since)
      ?.n ?? 0
  );
}

/** Throw `rate-limited` when a session sent `SENDS_PER_HOUR` messages in the last hour. */
export function checkSendRate(store: Store, sessionId: string): void {
  checkRate(
    store,
    "SELECT created_at AS at FROM messages WHERE sender_session_id = ? AND created_at > ? ORDER BY created_at",
    sessionId,
    SENDS_PER_HOUR,
    "This session sent 120 messages in the last hour.",
  );
}

/** Throw `rate-limited` when an owner created `CREATES_PER_HOUR` conversations in the last hour. */
export function checkCreateRate(store: Store, ownerId: string): void {
  checkRate(
    store,
    `SELECT c.created_at AS at FROM conversations c JOIN sessions s ON s.id = c.created_by_session_id
     WHERE s.owner_id = ? AND c.created_at > ? ORDER BY c.created_at`,
    ownerId,
    CREATES_PER_HOUR,
    "This owner created 10 conversations in the last hour.",
  );
}

function checkRate(store: Store, sql: string, key: string, limit: number, message: string): void {
  const rows = store.db.query<{ at: string }, [string, string]>(sql).all(key, store.iso(store.now() - HOUR));
  if (rows.length < limit) return;
  const oldest = Date.parse(rows[rows.length - limit]?.at ?? "");
  const retryAfterMs = Math.max(1, oldest + HOUR - store.now());
  throw new RelayError("rate-limited", message, "Wait, then try again.", { retryAfterMs });
}
