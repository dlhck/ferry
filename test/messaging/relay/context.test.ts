import { describe, expect, test } from "bun:test";
import { JoinContext, LIMITS, MessagePage } from "../../../src/messaging/protocol.ts";
import { pair, request, type Session, type World } from "./helpers.ts";

async function context(w: World, session: Session, conversation: string): Promise<JoinContext> {
  return w.ok("GET", `/v1/conversations/${conversation}/context?sessionId=${session.id}`, undefined, session.device, 200, JoinContext);
}

async function updates(w: World, from: Session, conversation: string, count: number, body: (index: number) => string): Promise<string[]> {
  const ids: string[] = [];
  for (let index = 0; index < count; index++) {
    const reply = await w.send(from, conversation, { kind: "update", body: body(index) });
    if (reply.status !== 201) throw new Error(JSON.stringify(reply.body));
    ids.push(reply.body.message.id);
  }
  return ids;
}

describe("join context", () => {
  test("20 recent messages, newest first, with a cursor to older history", async () => {
    const { w, alice, bob, conversation } = await pair();
    const ids = await updates(w, alice, conversation, 25, (index) => `Note ${index}`);
    const joined = await context(w, bob, conversation);
    expect(joined.recent.map((message) => message.id)).toEqual(ids.slice(5).reverse());
    expect(joined.size).toMatchObject({ limit: LIMITS.joinContextChars, omittedRecent: 5 });
    expect(joined.olderBefore).toBe(ids[5] ?? "");
    expect(joined.size.chars).toBe(JSON.stringify(joined).length);
    const older = await w.ok("GET", `/v1/conversations/${conversation}/messages?sessionId=${bob.id}&before=${joined.olderBefore}`, undefined, bob.device, 200, MessagePage);
    expect(older).toEqual({ messages: expect.any(Array), next: null });
    expect(older.messages.map((message) => message.id)).toEqual(ids.slice(0, 5).reverse());
  });

  test("open requests come first and are not repeated in recent; history shows the current request status", async () => {
    const { w, alice, bob, conversation } = await pair();
    const open = await request(w, alice, bob, conversation);
    const closed = await request(w, alice, bob, conversation, "Old question");
    await w.call("POST", `/v1/requests/${closed}/action`, { body: { sessionId: alice.id, action: "cancel", expectedGeneration: 1, note: "" }, device: alice.device });
    const joined = await context(w, bob, conversation);
    expect(joined.openRequests.map((message) => message.id)).toEqual([open]);
    expect(joined.recent.map((message) => message.id)).not.toContain(open);
    expect(joined.recent.find((message) => message.id === closed)?.request?.status).toBe("cancelled");
  });

  test("long bodies are cut at 1,500 characters, and the context stays within 24,000 characters", async () => {
    const { w, alice, bob, conversation } = await pair();
    await updates(w, alice, conversation, 20, (index) => `${index} ${"x".repeat(3_000)}`);
    const joined = await context(w, bob, conversation);
    expect(joined.recent.length).toBeLessThan(20);
    expect(joined.recent.length).toBeGreaterThan(5);
    for (const message of joined.recent) {
      expect([...message.body]).toHaveLength(1_500);
      expect(message.truncated).toBe(true);
    }
    expect(joined.size.chars).toBeLessThanOrEqual(LIMITS.joinContextChars);
    expect(joined.size.chars).toBe(JSON.stringify(joined).length);
    expect(joined.size.omittedRecent).toBe(20 - joined.recent.length);
    const full = await w.ok("GET", `/v1/conversations/${conversation}/messages?sessionId=${bob.id}&limit=1`, undefined, bob.device);
    expect([...full.messages[0].body].length).toBe(3_003);
    expect(full.messages[0].truncated).toBeUndefined();
  });

  test("when open requests and constraints pass the limit, the cuts are tighter, no recent message is added, and every constraint stays", async () => {
    const { w, alice, bob, conversation } = await pair();
    for (let index = 0; index < 20; index++) await request(w, alice, bob, conversation, `Request ${index} ${"r".repeat(1_400)}`);
    for (let index = 0; index < 20; index++) {
      const reply = await w.call("POST", `/v1/conversations/${conversation}/constraints`, {
        body: { sessionId: alice.id, text: `Constraint ${index} ${"c".repeat(900)}` },
        device: alice.device,
      });
      expect(reply.status).toBe(201);
    }
    const joined = await context(w, bob, conversation);
    expect(joined.activeConstraints).toHaveLength(20);
    expect(joined.openRequests).toHaveLength(20);
    expect(joined.recent).toEqual([]);
    for (const constraint of joined.activeConstraints) expect([...constraint.text].length).toBeLessThanOrEqual(500);
    for (const message of joined.openRequests) expect([...message.body]).toHaveLength(300);
  });

  test("history pages hold at most 50 messages", async () => {
    const { w, alice, bob, conversation } = await pair();
    await updates(w, alice, conversation, 55, (index) => `Note ${index}`);
    const first = await w.ok("GET", `/v1/conversations/${conversation}/messages?sessionId=${bob.id}&limit=50`, undefined, bob.device);
    expect(first.messages).toHaveLength(50);
    const rest = await w.ok("GET", `/v1/conversations/${conversation}/messages?sessionId=${bob.id}&before=${first.next}`, undefined, bob.device);
    expect(rest.messages).toHaveLength(5);
    expect(rest.next).toBeNull();
    expect((await w.call("GET", `/v1/conversations/${conversation}/messages?sessionId=${bob.id}&limit=51`, { device: bob.device })).status).toBe(400);
  });
});

describe("conversation creation", () => {
  test("the same slug is conversation-exists; a similar one without force is conversation-similar", async () => {
    const { w, alice, conversation } = await pair();
    const project = w.store.db.query<{ p: string }, [string]>("SELECT project_id AS p FROM sessions WHERE id = ?").get(alice.id)?.p;
    const create = (name: string, purpose: string, force = false) =>
      w.call("POST", `/v1/projects/${project}/conversations`, { body: { sessionId: alice.id, name, purpose, force }, device: alice.device });
    const same = await create("Production applies", "Again.", true);
    expect(same.status).toBe(409);
    expect(same.body.error).toMatchObject({ code: "conversation-exists", details: { conversation: { id: conversation } } });
    const similar = await create("production applie", "Something else.");
    expect(similar.status).toBe(409);
    expect(similar.body.error.code).toBe("conversation-similar");
    expect(similar.body.error.details.candidates.map((candidate: any) => candidate.id)).toEqual([conversation]);
    const forced = await create("production applie", "Something else.", true);
    expect(forced.status).toBe(201);
    expect(forced.body.context.conversation.slug).toBe("production-applie");
  });
});
