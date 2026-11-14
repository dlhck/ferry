import { describe, expect, test } from "bun:test";
import { newId } from "../../src/messaging/ids.ts";
import {
  Ack,
  ConstraintAction,
  DispatchDecision,
  ERROR_CODES,
  ERROR_STATUS,
  ErrorBody,
  HEADERS,
  JSON_SCHEMAS,
  Message,
  MessageCreate,
  PROTOCOL_VERSION,
  RelayEvent,
  RequestAction,
  SessionInfo,
  SessionRegister,
  errorBody,
  receiptDisplay,
  validate,
  type Message as MessageType,
  type SessionRef,
} from "../../src/messaging/protocol.ts";

const NOW = "2026-11-13T10:00:00.000Z";

const alice = { id: newId("owner"), githubUserId: 1001, login: "alice" };

const sender: SessionRef = {
  id: newId("session"),
  address: "@alice/codex-7k2m9q",
  owner: alice,
  runtime: "codex",
};

const assignee: SessionRef = {
  id: newId("session"),
  address: "@bob/claude-q8w2er",
  owner: { id: newId("owner"), githubUserId: 1002, login: "bob" },
  runtime: "claude",
};

function request(): MessageType {
  return {
    id: newId("message"),
    conversationId: newId("conversation"),
    seq: 1,
    kind: "request",
    sender,
    body: "Has the key-authority apply finished?",
    to: [assignee],
    answers: null,
    hop: 1,
    createdAt: NOW,
    request: {
      status: "pending",
      outcome: null,
      assignee,
      assigneeAccess: "granted",
      original: assignee,
      generation: 1,
      ageMs: 0,
      answer: null,
      events: [{ kind: "created", at: NOW, actor: sender, generation: 1 }],
    },
  };
}

function issues(result: ReturnType<typeof validate>): readonly string[] {
  return result.ok ? [] : result.issues;
}

describe("validators", () => {
  test("a complete message is valid", () => {
    expect(validate(Message, request()).ok).toBe(true);
  });

  test("an unknown field is refused at the top and in a nested object", () => {
    expect(issues(validate(Message, { ...request(), extra: 1 }))).toEqual(["$.extra: unknown field"]);
    const nested = request();
    expect(issues(validate(Message, { ...nested, sender: { ...nested.sender, extra: true } }))).toEqual([
      "$.sender.extra: unknown field",
    ]);
    const deep = { ...nested, request: { ...nested.request, events: [{ ...nested.request?.events[0], extra: "x" }] } };
    expect(issues(validate(Message, deep))).toEqual(["$.request.events[0].extra: unknown field"]);
  });

  test("a missing field, a wrong type, and a bad id are refused with their paths", () => {
    const { body: _body, ...missing } = request();
    expect(issues(validate(Message, missing))).toEqual(["$.body: missing"]);
    expect(issues(validate(Message, { ...request(), hop: 0 }))).toEqual(["$.hop: less than 1"]);
    expect(issues(validate(Message, { ...request(), seq: 1.5 }))).toEqual(["$.seq: expected an integer, got number"]);
    expect(issues(validate(Message, { ...request(), id: newId("session") }))[0]).toStartWith("$.id: does not match");
    expect(issues(validate(Message, null))).toEqual(["$: expected an object, got null"]);
  });

  test("an optional field can be absent or undefined, and a nullable field can be null", () => {
    const { request: _request, ...update } = { ...request(), kind: "update" as const, to: [] };
    expect(validate(Message, update).ok).toBe(true);
    expect(validate(Message, { ...update, truncated: undefined }).ok).toBe(true);
    expect(validate(Message, { ...update, answers: undefined }).ok).toBe(false);
  });

  test("string limits count code points, and the body limit counts bytes", () => {
    const base = { sessionId: sender.id, kind: "update" as const };
    expect(validate(MessageCreate, { ...base, body: "x".repeat(16_384) }).ok).toBe(true);
    expect(issues(validate(MessageCreate, { ...base, body: "x".repeat(16_385) }))).toEqual(["$.body: larger than 16384 bytes"]);
    expect(issues(validate(MessageCreate, { ...base, body: "é".repeat(8_193) }))).toEqual(["$.body: larger than 16384 bytes"]);
    expect(issues(validate(MessageCreate, { ...base, body: "" }))).toEqual(["$.body: shorter than 1 characters"]);

    const register = {
      runtime: "claude",
      runtimeSessionId: "8a6f0c2e",
      runtimeVersion: "2.1.323",
      adapter: "supported",
      repo: { key: "github.com/acme/vendure-cloud" },
      branch: "feat/clo-1442-key-authority",
      head: "0123456789abcdef0123456789abcdef01234567",
      worktree: "vendure-cloud",
      source: "startup",
    };
    expect(validate(SessionRegister, { ...register, task: "😀".repeat(280) }).ok).toBe(true);
    expect(issues(validate(SessionRegister, { ...register, task: "😀".repeat(281) }))).toEqual(["$.task: longer than 280 characters"]);
    expect(issues(validate(SessionRegister, { ...register, task: null, repo: { key: "github.com/Acme/App" } }))[0]).toStartWith(
      "$.repo.key: does not match",
    );
  });

  test("an array limit is checked", () => {
    const items = Array.from({ length: 51 }, () => ({ id: newId("message") }));
    expect(issues(validate(Ack, { sessionId: sender.id, items }))).toEqual(["$.items: more than 50 items"]);
    expect(issues(validate(Ack, { sessionId: sender.id, items: [] }))).toEqual(["$.items: fewer than 1 items"]);
  });

  test("a tagged union takes only the fields of its variant", () => {
    expect(validate(DispatchDecision, { decision: "go", leaseUntil: NOW, envelope: "<ferry-message>" }).ok).toBe(true);
    expect(validate(DispatchDecision, { decision: "hold", hold: "wake-rate" }).ok).toBe(true);
    expect(validate(DispatchDecision, { decision: "drop", reason: "request-closed" }).ok).toBe(true);
    expect(issues(validate(DispatchDecision, { decision: "hold", hold: "wake-rate", envelope: "x" }))).toEqual([
      "$.envelope: unknown field",
    ]);
    expect(issues(validate(DispatchDecision, { decision: "maybe" }))[0]).toStartWith('$.decision: expected one of "go"');
    expect(validate(RelayEvent, { type: "device.revoked", seq: 3 }).ok).toBe(true);
    expect(validate(ConstraintAction, { action: "request-resolution", sessionId: sender.id, evidence: "The apply finished." }).ok).toBe(
      true,
    );
    const close = { action: "close", sessionId: sender.id, expectedGeneration: 2, outcome: "done", note: "" };
    expect(issues(validate(RequestAction, close))[0]).toStartWith("$.outcome: expected one of");
  });

  test("a session info takes the fields of a session ref and its own", () => {
    const info = {
      ...sender,
      state: "live",
      activity: "idle",
      adapter: "supported",
      task: null,
      branch: null,
      head: null,
      worktree: null,
      host: "fsn1",
      lastSeenAt: NOW,
    };
    expect(validate(SessionInfo, info).ok).toBe(true);
    expect(validate(SessionInfo, { ...info, memberships: [newId("conversation")] }).ok).toBe(true);
    expect(validate(SessionInfo, { ...info, address: "@alice/codex-7k2m9" }).ok).toBe(false);
  });
});

describe("JSON Schemas", () => {
  test("each object in each schema is closed", () => {
    const open: string[] = [];
    const walk = (node: unknown, path: string): void => {
      if (Array.isArray(node)) return node.forEach((item, index) => walk(item, `${path}[${index}]`));
      if (typeof node !== "object" || node === null) return;
      const record = node as Record<string, unknown>;
      if (record.type === "object" && record.properties !== undefined && record.additionalProperties !== false) open.push(path);
      for (const [key, value] of Object.entries(record)) walk(value, `${path}.${key}`);
    };
    for (const [name, schema] of Object.entries(JSON_SCHEMAS)) walk(schema, name);
    expect(open).toEqual([]);
  });

  test("a schema names its required fields and limits", () => {
    const schema = JSON_SCHEMAS.MessageCreate as {
      title: string;
      required: string[];
      properties: Record<string, Record<string, unknown>>;
    };
    expect(schema.title).toBe("MessageCreate");
    expect(schema.required).toEqual(["sessionId", "kind", "body"]);
    expect(schema.properties.causeIds?.maxItems).toBe(20);
    expect(schema.properties.kind?.enum).toEqual(["update", "request", "answer"]);
    expect((JSON_SCHEMAS.DispatchDecision as { oneOf: unknown[] }).oneOf).toHaveLength(3);
    expect(JSON.parse(JSON.stringify(JSON_SCHEMAS))).toEqual(JSON_SCHEMAS);
  });
});

describe("errors and headers", () => {
  test("each error code has the status of the design table", () => {
    expect(ERROR_CODES).toHaveLength(32);
    expect(ERROR_STATUS["invalid-request"]).toBe(400);
    expect(ERROR_STATUS["device-revoked"]).toBe(401);
    expect(ERROR_STATUS["not-constraint-owner"]).toBe(403);
    expect(ERROR_STATUS["enrollment-unknown"]).toBe(404);
    expect(ERROR_STATUS["ambiguous-recipient"]).toBe(409);
    expect(ERROR_STATUS["enrollment-denied"]).toBe(410);
    expect(ERROR_STATUS["enrollment-failed"]).toBe(410);
    expect(ERROR_STATUS["device-flow-disabled"]).toBe(403);
    expect(ERROR_STATUS["too-large"]).toBe(413);
    expect(ERROR_STATUS["upgrade-required"]).toBe(426);
    expect(ERROR_STATUS["rate-limited"]).toBe(429);
    expect(ERROR_STATUS.unavailable).toBe(503);
  });

  test("an error body is valid with and without details", () => {
    expect(validate(ErrorBody, errorBody("not-found", "No such conversation.")).ok).toBe(true);
    const limited = errorBody("rate-limited", "Too many sends.", "Wait, then send again.", { retryAfterMs: 1000 });
    expect(limited).toEqual({
      error: { code: "rate-limited", message: "Too many sends.", hint: "Wait, then send again.", details: { retryAfterMs: 1000 } },
    });
    expect(validate(ErrorBody, limited).ok).toBe(true);
    expect(validate(ErrorBody, { error: { code: "teapot", message: "", hint: null } }).ok).toBe(false);
  });

  test("the headers and the protocol version", () => {
    expect(PROTOCOL_VERSION).toBe(1);
    expect(HEADERS).toEqual({
      protocol: "Ferry-Protocol",
      version: "Ferry-Version",
      idempotencyKey: "Idempotency-Key",
      idempotentReplay: "Idempotent-Replay",
    });
  });

  test("a receipt display is its hold text, else its state", () => {
    expect(receiptDisplay("stored", "wake-rate")).toBe("held: wake limit");
    expect(receiptDisplay("stored", "wake-hops")).toBe("held: wake limit");
    expect(receiptDisplay("stored", "worker-offline")).toBe("held: recipient host offline");
    expect(receiptDisplay("delivered", null)).toBe("delivered");
  });
});
