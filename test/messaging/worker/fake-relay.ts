/**
 * An in-memory relay for the worker tests, until lane A's relay merges. It
 * answers the endpoints that the worker calls with fixed example records, and
 * it records each call. A test changes an answer with `on`, takes the relay
 * offline with `offline`, and queues events with `push`.
 */

import type { RelayAnswer, RelayCall, RelayTransport } from "../../../src/messaging/worker/outbox.ts";
import type { DispatchDecision, Message, Receipt, RelayEvent, SessionInfo } from "../../../src/messaging/worker/protocol-stub.ts";

export const OWNER = { id: "own_01JC9Z8K4Q2M7T5V3X6Y1A2B3C", githubUserId: 1001, login: "alice" };
export const PROJECT = { id: "prj_01JC9Z8K4Q2M7T5V3X6Y1A2B3C", key: "github.com/acme/app", repoId: 42, access: "granted" as const };
export const CONVERSATION = {
  id: "cnv_01JC9Z8K4Q2M7T5V3X6Y1A2B3C",
  projectId: PROJECT.id,
  slug: "production-applies",
  name: "Production applies",
  purpose: "Coordinate applies to production.",
  links: [],
  autoJoin: "all" as const,
  participants: { live: 1, total: 1 },
  openRequests: 0,
  activeConstraints: 1,
  lastMessageAt: null,
  createdAt: "2026-01-05T09:00:00.000Z",
};
export const BOB = { id: "ses_01JC9Z8K4Q2M7T5V3X6Y1BOBBB", address: "@bob/claude-q8w2er", owner: { id: "own_01JC9Z8K4Q2M7T5V3X6Y1BOBBB", githubUserId: 1002, login: "bob" }, runtime: "claude" as const };

export type Call = RelayCall & { readonly at: number };
type Handler = (call: RelayCall, match: RegExpExecArray) => RelayAnswer | Promise<RelayAnswer>;

let sessions = 0;

export function messageId(n: number): string {
  return `msg_01JC9Z8K4Q2M7T5V3X6Y1A${String(n).padStart(4, "0")}`;
}

export function message(n: number, kind: Message["kind"], body = `Body ${n}`, generation = 1): Message {
  return {
    id: messageId(n),
    conversationId: CONVERSATION.id,
    seq: n,
    kind,
    sender: BOB,
    body,
    to: [],
    answers: null,
    hop: 1,
    createdAt: "2026-01-05T09:00:00.000Z",
    ...(kind === "request"
      ? {
          request: {
            status: "pending",
            outcome: null,
            assignee: BOB,
            assigneeAccess: "granted",
            original: BOB,
            generation,
            ageMs: 0,
            answer: null,
            events: [],
          },
        }
      : {}),
  };
}

export function envelope(id: string, generation = 1): string {
  return `<ferry-message id="${id}" kind="request" generation="${generation}" conversation="app/production-applies" from="${BOB.address}" owner="bob" hop="1">\nThis message comes from another agent session through Ferry.\n---\nHas the apply finished?\n</ferry-message>`;
}

export class FakeRelay implements RelayTransport {
  readonly calls: Call[] = [];
  readonly messages = new Map<string, Message>();
  /** The receipt generation of each receipt id. */
  readonly receipts = new Map<string, { messageId: string; generation: number }>();
  offline = false;
  /** The decision of the next dispatch calls. */
  decide: (receiptId: string) => DispatchDecision = (receiptId) => ({
    decision: "go",
    leaseUntil: "2026-01-05T09:02:00.000Z",
    envelope: envelope(this.receipts.get(receiptId)?.messageId ?? "msg_unknown", this.receipts.get(receiptId)?.generation ?? 1),
  });
  #events: RelayEvent[] = [];
  #seq = 0;
  #handlers: [string, RegExp, Handler][] = [];
  #idempotency = new Map<string, RelayAnswer>();
  #sessionNumbers = new Map<string, number>();

  constructor(readonly clock: { now(): number }) {
    this.on("POST", /^\/v1\/sessions$/, (call) => {
      const body = call.body as { runtime: "claude" | "codex"; runtimeSessionId: string; adapter: SessionInfo["adapter"] };
      // The session key is the owner, the runtime, and the runtime session id (design 5).
      const key = `${body.runtime}:${body.runtimeSessionId}`;
      const n = this.#sessionNumbers.get(key) ?? ++sessions;
      this.#sessionNumbers.set(key, n);
      const session: SessionInfo = {
        id: `ses_01JC9Z8K4Q2M7T5V3X6Y1A${String(n).padStart(4, "0")}`,
        address: `@alice/${body.runtime}-${String(n).padStart(6, "a")}`,
        owner: OWNER,
        runtime: body.runtime,
        state: "live",
        activity: "idle",
        adapter: body.adapter,
        task: null,
        branch: null,
        head: null,
        worktree: null,
        host: "alice-box",
        lastSeenAt: new Date(this.clock.now()).toISOString(),
        memberships: [CONVERSATION.id],
      };
      return { status: 201, body: { session, project: PROJECT, refusal: null, autoJoined: [CONVERSATION], assigned: [], pendingUpdates: 0 } };
    });
    this.on("GET", /^\/v1\/messages\/([^/?]+)/, (_call, match) => {
      const found = this.messages.get(decodeURIComponent(match[1]!));
      if (!found) return { status: 404, body: { error: { code: "not-found", message: "No message.", hint: null } } };
      const receipts = [...this.receipts.entries()]
        .filter(([, receipt]) => receipt.messageId === found.id)
        .map(([id, receipt]): Partial<Receipt> => ({ id, messageId: found.id, generation: receipt.generation, state: "stored", hold: null }));
      return { status: 200, body: { message: found, receipts } };
    });
    this.on("POST", /^\/v1\/deliveries\/([^/]+)\/dispatch$/, (_call, match) => ({ status: 200, body: this.decide(decodeURIComponent(match[1]!)) }));
    this.on("POST", /^\/v1\/deliveries\/([^/]+)\/result$/, () => ({ status: 200, body: {} }));
    this.on("GET", /^\/v1\/projects\/[^/]+\/conversations/, () => ({ status: 200, body: { conversations: [CONVERSATION] } }));
    this.on("POST", /^\/v1\/conversations\/[^/]+\/messages$/, (call) => {
      const body = call.body as { kind: Message["kind"]; body: string };
      return { status: 201, body: { message: { ...message(9000, body.kind, body.body) }, receipts: [] } };
    });
    this.on("POST", /^\/v1\/messages\/ack$/, (call) => {
      const items = (call.body as { items: { id: string }[] }).items;
      return { status: 200, body: { items: items.map((item) => ({ id: item.id, result: "acknowledged" })) } };
    });
    this.on("PATCH", /^\/v1\/sessions\/[^/]+$/, () => ({ status: 200, body: {} }));
    this.on("POST", /^\/v1\/sessions\/[^/]+\/end$/, () => ({ status: 200, body: {} }));
    this.on("POST", /^\/v1\/worker\/heartbeat$/, () => ({ status: 200, body: { serverTime: new Date(this.clock.now()).toISOString() } }));
    this.on("GET", /^\/v1\/worker\/events/, () => {
      const events = this.#events.splice(0);
      return { status: 200, body: { cursor: this.#seq, events, resync: false } };
    });
  }

  /** Answer a method and path pattern. A later handler for the same pattern comes first. */
  on(method: string, path: RegExp, handler: Handler): void {
    this.#handlers.unshift([method, path, handler]);
  }

  /** A message on the relay, and one receipt of it for a session. Returns the delivery.ready event. */
  deliver(sessionId: string, stored: Message, receiptId: string, generation = stored.request?.generation ?? 0): Extract<RelayEvent, { type: "delivery.ready" }> {
    this.messages.set(stored.id, stored);
    this.receipts.set(receiptId, { messageId: stored.id, generation });
    const event = { seq: ++this.#seq, type: "delivery.ready" as const, receiptId, sessionId, messageId: stored.id, kind: stored.kind, wake: stored.kind !== "update" && stored.kind !== "constraint" };
    this.#events.push(event);
    return event;
  }

  push(event: RelayEvent): void {
    this.#events.push({ ...event, seq: ++this.#seq } as RelayEvent);
  }

  /** The calls for a method and a path pattern. */
  find(method: string, path: RegExp): Call[] {
    return this.calls.filter((call) => call.method === method && path.test(call.path));
  }

  /** The bodies of the delivery results. */
  results(): { receiptId: string; outcome: string; evidence: { kind: string } | null; generation: number }[] {
    return this.find("POST", /\/result$/).map((call) => ({ receiptId: decodeURIComponent(call.path.split("/")[3]!), ...(call.body as { outcome: string; evidence: { kind: string } | null; generation: number }) }));
  }

  async request(call: RelayCall & { signal?: AbortSignal }): Promise<RelayAnswer> {
    if (this.offline) throw new Error("connect ECONNREFUSED");
    this.calls.push({ method: call.method, path: call.path, body: call.body, idempotencyKey: call.idempotencyKey, at: this.clock.now() });
    if (call.idempotencyKey && this.#idempotency.has(call.idempotencyKey)) return this.#idempotency.get(call.idempotencyKey)!;
    for (const [method, pattern, handler] of this.#handlers) {
      const match = pattern.exec(call.path);
      if (method !== call.method || !match) continue;
      const answer = await handler(call, match);
      if (call.idempotencyKey && call.method !== "GET") this.#idempotency.set(call.idempotencyKey, answer);
      return answer;
    }
    return { status: 404, body: { error: { code: "not-found", message: `No fake for ${call.method} ${call.path}`, hint: null } } };
  }
}
