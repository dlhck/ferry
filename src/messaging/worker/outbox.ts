/**
 * The outbox of the messaging worker (design section 8.3). Each mutating
 * relay call goes into the `outbox` table with a new idempotency key before
 * the worker sends it, so a retry after a crash or a network drop uses the
 * same key, and the relay stores the call once.
 *
 * The caller waits for a time (5 seconds for a tool, less for a hook). When
 * the relay answers in that time, the caller gets the answer. When not, the
 * caller gets `queued-offline`, and the worker retries with a backoff of 1,
 * 2, 4, ... seconds, at most 60, for 6 days. Then the entry is `failed`.
 */

import { newId } from "./protocol-stub.ts";
import type { OutboxEntry, WorkerStore } from "./store.ts";

export type Method = "GET" | "POST" | "PATCH";

export type RelayCall = { readonly method: Method; readonly path: string; readonly body?: unknown; readonly idempotencyKey?: string };
export type RelayAnswer = { readonly status: number; readonly body: unknown };

/**
 * The narrow interface of the relay client that the worker uses. It sends one
 * call with the device credential, the `Ferry-Protocol` and `Ferry-Version`
 * headers, and the idempotency key. It returns the status and the parsed JSON
 * body of each answer, also of an error answer. It throws when the relay
 * gives no answer: a network error, a timeout, or the abort signal.
 */
export interface RelayTransport {
  request(call: RelayCall & { readonly signal?: AbortSignal }): Promise<RelayAnswer>;
}

export const OUTBOX_RETRY_LIMIT_MS = 6 * 24 * 60 * 60 * 1000;
const MAX_BACKOFF_MS = 60_000;
const BACKGROUND_TIMEOUT_MS = 30_000;

export type Call = { readonly method: Method; readonly path: string; readonly body: unknown; readonly sessionId: string | null };

export type Submitted = { readonly state: "answered"; readonly answer: RelayAnswer } | { readonly state: "queued-offline"; readonly key: string };

/** True when the answer is an error of the relay that a later try can change: a rate limit or an outage. */
export function retryable(answer: RelayAnswer): boolean {
  return answer.status === 429 || answer.status >= 500;
}

/** True when the answer comes from the relay itself, with a JSON error body or a success. A 502 of a TLS front has no such body. */
export function fromRelay(answer: RelayAnswer): boolean {
  if (answer.status < 300) return true;
  const error = (answer.body as { error?: { code?: unknown } } | null)?.error;
  return typeof error?.code === "string";
}

export function backoffMs(attempts: number): number {
  return Math.min(MAX_BACKOFF_MS, 1000 * 2 ** Math.max(0, attempts - 1));
}

export type OutboxInput = {
  readonly store: WorkerStore;
  readonly transport: RelayTransport;
  readonly clock: { now(): number };
  /** Called once for each entry that the relay answered: in `submit`, or later in `flush`. */
  readonly onAnswer: (entry: OutboxEntry, answer: RelayAnswer) => void;
  readonly log: (line: string) => void;
};

export class Outbox {
  readonly #input: OutboxInput;
  #running: Promise<void> | null = null;
  #again = false;

  constructor(input: OutboxInput) {
    this.#input = input;
  }

  #iso(ms = this.#input.clock.now()): string {
    return new Date(ms).toISOString();
  }

  /**
   * Store the call, send it, and wait at most `waitMs` for the answer. An
   * answer in that time ends the entry, also an error answer, because the
   * caller gets it and decides.
   */
  async submit(call: Call, waitMs: number): Promise<Submitted> {
    // A flush does not take the entry while this call waits for its answer.
    const entry = this.#insert(call, this.#input.clock.now() + waitMs + 1000);
    const answer = await this.#send(entry, waitMs);
    if (answer && fromRelay(answer)) {
      this.#finish(entry, answer, entry.attempts + 1);
      return { state: "answered", answer };
    }
    this.#retryLater(entry, entry.attempts + 1, answer ? `HTTP ${answer.status}` : "no answer from the relay");
    return { state: "queued-offline", key: entry.key };
  }

  /** Store the call for the next flush, with no wait. For a call whose answer no caller waits for, such as a delivery result. */
  enqueue(call: Call): string {
    return this.#insert(call, this.#input.clock.now()).key;
  }

  #insert(call: Call, nextAt: number): OutboxEntry {
    const now = this.#input.clock.now();
    const entry: OutboxEntry = {
      key: newId("idk", now),
      method: call.method,
      path: call.path,
      body: JSON.stringify(call.body ?? {}),
      sessionId: call.sessionId,
      createdAt: this.#iso(now),
      attempts: 0,
      nextAt: this.#iso(nextAt),
      lastError: null,
      state: "pending",
    };
    this.#input.store.insertOutbox(entry);
    return entry;
  }

  /**
   * Send each due entry, oldest first. The first entry without an answer
   * stops the flush, because the relay is offline. A call while a flush runs
   * makes it run once more, and returns its promise.
   */
  flush(): Promise<void> {
    if (this.#running) {
      this.#again = true;
      return this.#running;
    }
    this.#running = (async () => {
      try {
        do {
          this.#again = false;
          await this.#flushOnce();
        } while (this.#again);
      } finally {
        this.#running = null;
      }
    })();
    return this.#running;
  }

  async #flushOnce(): Promise<void> {
    for (const entry of this.#input.store.dueOutbox(this.#iso())) {
      if (this.#input.clock.now() - Date.parse(entry.createdAt) > OUTBOX_RETRY_LIMIT_MS) {
        this.#input.store.updateOutbox(entry.key, { state: "failed", attempts: entry.attempts, nextAt: entry.nextAt, lastError: entry.lastError ?? "no answer for 6 days" });
        this.#input.log(`Outbox entry ${entry.key} (${entry.method} ${entry.path}) failed after 6 days.`);
        continue;
      }
      const answer = await this.#send(entry, BACKGROUND_TIMEOUT_MS);
      const attempts = entry.attempts + 1;
      if (answer && fromRelay(answer) && !retryable(answer)) {
        this.#finish(entry, answer, attempts);
        continue;
      }
      this.#retryLater(entry, attempts, answer ? `HTTP ${answer.status}` : "no answer from the relay");
      if (!answer || !fromRelay(answer)) return;
    }
  }

  async #send(entry: OutboxEntry, timeoutMs: number): Promise<RelayAnswer | null> {
    try {
      return await this.#input.transport.request({
        method: entry.method as Method,
        path: entry.path,
        body: JSON.parse(entry.body),
        idempotencyKey: entry.key,
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch {
      return null;
    }
  }

  #finish(entry: OutboxEntry, answer: RelayAnswer, attempts: number): void {
    const error = answer.status >= 300 ? `HTTP ${answer.status} ${(answer.body as { error?: { code?: string } }).error?.code ?? ""}`.trim() : null;
    this.#input.store.updateOutbox(entry.key, { state: "sent", attempts, nextAt: entry.nextAt, lastError: error });
    this.#input.onAnswer(entry, answer);
  }

  #retryLater(entry: OutboxEntry, attempts: number, error: string): void {
    this.#input.store.updateOutbox(entry.key, { state: "pending", attempts, nextAt: this.#iso(this.#input.clock.now() + backoffMs(attempts)), lastError: error });
  }
}
