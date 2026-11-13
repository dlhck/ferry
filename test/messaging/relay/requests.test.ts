import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { newId } from "../../../src/messaging/ids.ts";
import { RequestActionResult } from "../../../src/messaging/protocol.ts";
import { deliver, dispatchFor, pair, request, world, type Session, type World } from "./helpers.ts";

async function action(w: World, session: Session, id: string, body: Record<string, unknown>) {
  return w.call("POST", `/v1/requests/${id}/action`, { body: { sessionId: session.id, ...body }, device: session.device });
}

async function ackOf(w: World, session: Session, id: string, generation?: number): Promise<string> {
  const reply = await w.ok("POST", "/v1/messages/ack", { sessionId: session.id, items: [{ id, ...(generation === undefined ? {} : { generation }) }] }, session.device);
  return reply.items[0].result;
}

async function state(w: World, viewer: Session, id: string) {
  return (await w.ok("GET", `/v1/messages/${id}?sessionId=${viewer.id}`, undefined, viewer.device)).message.request;
}

/** A second session of bob's owner, a member of the conversation. */
async function secondBob(w: World, bob: Session, conversation: string): Promise<Session> {
  const other = (await w.register(bob.device, { runtime: "claude" })).me;
  await w.join(other, conversation);
  return other;
}

describe("request lifecycle", () => {
  test("pending, delivered, acknowledged, answered", async () => {
    const { w, alice, bob, conversation } = await pair();
    const id = await request(w, alice, bob, conversation);
    expect(await state(w, alice, id)).toMatchObject({ status: "pending", generation: 1, outcome: null, answer: null });
    await dispatchFor(w, bob, id);
    await deliver(w, bob, id);
    expect((await state(w, alice, id)).status).toBe("delivered");
    expect(await ackOf(w, bob, id, 1)).toBe("acknowledged");
    expect((await state(w, alice, id)).status).toBe("acknowledged");
    const answer = await w.send(bob, conversation, { kind: "answer", body: "It finished at 10:02.", answers: id, generation: 1 });
    expect(answer.status).toBe(201);
    expect(answer.body.message).toMatchObject({ kind: "answer", answers: id, to: [{ id: alice.id }], hop: 2 });
    expect(answer.body.receipts[0]).toMatchObject({ recipient: { id: alice.id }, generation: 0 });
    const final = await state(w, alice, id);
    expect(final).toMatchObject({ status: "answered", answer: answer.body.message.id });
    expect(final.events.map((event: any) => event.kind)).toEqual(["created", "delivered", "acknowledged", "answered"]);
  });

  test("pending to acknowledged directly, and a second ack is already-acknowledged", async () => {
    const { w, alice, bob, conversation } = await pair();
    const id = await request(w, alice, bob, conversation);
    expect(await ackOf(w, bob, id)).toBe("acknowledged");
    expect(await ackOf(w, bob, id, 1)).toBe("already-acknowledged");
    expect(await ackOf(w, alice, id, 1)).toBe("not-recipient");
    expect(await ackOf(w, bob, newId("message"))).toBe("not-recipient");
  });

  test("answered is terminal: a second answer and an action get request-closed", async () => {
    const { w, alice, bob, conversation } = await pair();
    const id = await request(w, alice, bob, conversation);
    await w.send(bob, conversation, { kind: "answer", body: "Yes.", answers: id, generation: 1 });
    const again = await w.send(bob, conversation, { kind: "answer", body: "Yes again.", answers: id, generation: 1 });
    expect(again.status).toBe(409);
    expect(again.body.error.code).toBe("request-closed");
    expect((await action(w, alice, id, { action: "cancel", expectedGeneration: 1, note: "" })).body.error.code).toBe("request-closed");
  });

  test("an answer from another session is not-assignee", async () => {
    const { w, alice, bob, conversation } = await pair();
    const id = await request(w, alice, bob, conversation);
    const reply = await w.send(alice, conversation, { kind: "answer", body: "Me?", answers: id, generation: 1 });
    expect(reply.status).toBe(403);
    expect(reply.body.error.code).toBe("not-assignee");
  });

  test("a request never expires", async () => {
    const { w, alice, bob, conversation } = await pair();
    const id = await request(w, alice, bob, conversation);
    w.clock.advance(30 * 24 * 3_600_000);
    await w.heartbeat(alice.device, [{ id: alice.id }]);
    const current = await state(w, alice, id);
    expect(current.status).toBe("pending");
    expect(current.ageMs).toBe(30 * 24 * 3_600_000);
  });
});

describe("claim", () => {
  test("a session of the same owner claims: a new generation, the old receipt is superseded, the claimer joins", async () => {
    const { w, alice, bob, conversation } = await pair();
    const id = await request(w, alice, bob, conversation);
    const bob2 = (await w.register(bob.device, { runtime: "claude" })).me;
    const claimed = await action(w, bob2, id, { action: "claim", expectedGeneration: 1 });
    expect(claimed.status).toBe(200);
    expect(claimed.body.message.request).toMatchObject({ status: "pending", generation: 2, assignee: { id: bob2.id }, original: { id: bob.id } });
    expect(claimed.body.message.request.events.at(-1)).toMatchObject({ kind: "claimed", from: { id: bob.id }, to: { id: bob2.id }, generation: 2 });
    expect(w.receiptOf(id, bob.id).state).toBe("superseded");
    expect(w.receiptOf(id, bob2.id)).toMatchObject({ state: "stored", generation: 2 });
    expect(w.store.db.query("SELECT joined_via FROM memberships WHERE session_id = ?").get(bob2.id)).toEqual({ joined_via: "claim" });
    // The old session's dispatch drops, and its ack and answer are refused.
    expect((await dispatchFor(w, bob, id)).body).toEqual({ decision: "drop", reason: "request-reassigned" });
    expect(await ackOf(w, bob, id, 1)).toBe("request-reassigned");
    const late = await w.send(bob, conversation, { kind: "answer", body: "Late", answers: id, generation: 1 });
    expect(late.body.error.code).toBe("request-reassigned");
    // The sender's worker sees the change.
    const events = await w.ok("GET", "/v1/worker/events?cursor=0", undefined, alice.device);
    expect(events.events.some((event: any) => event.type === "request.changed" && event.state.assignee.id === bob2.id)).toBe(true);
  });

  test("a session of another owner cannot claim, and a stale expected generation is a conflict", async () => {
    const { w, alice, bob, conversation } = await pair();
    const id = await request(w, alice, bob, conversation);
    const forbidden = await action(w, alice, id, { action: "claim", expectedGeneration: 1 });
    expect(forbidden.status).toBe(403);
    const bob2 = await secondBob(w, bob, conversation);
    const stale = await action(w, bob2, id, { action: "claim", expectedGeneration: 5 });
    expect(stale.status).toBe(409);
    expect(stale.body.error).toMatchObject({ code: "generation-conflict", details: { generation: 1, assignee: { id: bob.id } } });
  });

  test("two claims with the same expected generation: one wins, one gets generation-conflict", async () => {
    const { w, alice, bob, conversation } = await pair();
    const id = await request(w, alice, bob, conversation);
    const bob2 = await secondBob(w, bob, conversation);
    const bob3 = await secondBob(w, bob, conversation);
    const results = await Promise.all([
      action(w, bob2, id, { action: "claim", expectedGeneration: 1 }),
      action(w, bob3, id, { action: "claim", expectedGeneration: 1 }),
    ]);
    expect(results.map((reply) => reply.status).sort()).toEqual([200, 409]);
    expect(results.find((reply) => reply.status === 409)?.body.error.code).toBe("generation-conflict");
    expect((await state(w, alice, id)).generation).toBe(2);
  });

  test("two claims through two connections to the same file: the compare-and-swap lets one win", async () => {
    const { w, alice, bob, conversation } = await pair();
    const id = await request(w, alice, bob, conversation);
    const bob2 = await secondBob(w, bob, conversation);
    const bob3 = await secondBob(w, bob, conversation);
    const other = world({ dir: w.dir, clock: w.clock, github: w.github });
    expect(other.store.path).toBe(join(w.dir, "relay.db"));
    // Both relays read generation 1 first.
    expect((await state(w, alice, id)).generation).toBe(1);
    expect((await other.ok("GET", `/v1/messages/${id}?sessionId=${alice.id}`, undefined, alice.device)).message.request.generation).toBe(1);
    const first = await action(w, bob2, id, { action: "claim", expectedGeneration: 1 });
    const second = await other.call("POST", `/v1/requests/${id}/action`, {
      body: { sessionId: bob3.id, action: "claim", expectedGeneration: 1 },
      device: bob3.device,
    });
    expect(first.status).toBe(200);
    expect(second.status).toBe(409);
    expect(second.body.error).toMatchObject({ code: "generation-conflict", details: { generation: 2, assignee: { id: bob2.id } } });
  });

  test("a claim of an acknowledged request of a live session needs takeover, which sends a notice to the old session", async () => {
    const { w, alice, bob, conversation } = await pair();
    const id = await request(w, alice, bob, conversation);
    await ackOf(w, bob, id, 1);
    const bob2 = await secondBob(w, bob, conversation);
    const refused = await action(w, bob2, id, { action: "claim", expectedGeneration: 1 });
    expect(refused.status).toBe(409);
    expect(refused.body.error.code).toBe("in-progress");
    const taken = await action(w, bob2, id, { action: "claim", expectedGeneration: 1, takeover: true });
    expect(taken.status).toBe(200);
    const notice = w.store.db
      .query<{ id: string; body: string; sender_session_id: string }, []>("SELECT id, body, sender_session_id FROM messages WHERE kind = 'notice'")
      .get();
    expect(notice?.sender_session_id).toBe(bob2.id);
    expect(notice?.body).toContain(`Request ${id} moved to ${bob2.address}.`);
    expect(w.receiptOf(notice?.id ?? "", bob.id)).toMatchObject({ wake: 1, state: "stored" });
    expect((await dispatchFor(w, bob, notice?.id ?? "")).body.decision).toBe("go");
  });

  test("a claim of an acknowledged request of an offline session needs no takeover", async () => {
    const { w, alice, bob, conversation } = await pair();
    const id = await request(w, alice, bob, conversation);
    await ackOf(w, bob, id, 1);
    await w.ok("POST", `/v1/sessions/${bob.id}/end`, { reason: "crash" }, bob.device);
    const bob2 = await secondBob(w, bob, conversation);
    expect((await action(w, bob2, id, { action: "claim", expectedGeneration: 1 })).status).toBe(200);
  });

  test("a stale ack and a stale answer get stale-generation", async () => {
    const { w, alice, bob, conversation } = await pair();
    const id = await request(w, alice, bob, conversation);
    const bob2 = await secondBob(w, bob, conversation);
    await action(w, bob2, id, { action: "claim", expectedGeneration: 1 });
    await action(w, bob, id, { action: "claim", expectedGeneration: 2 });
    expect((await state(w, alice, id))).toMatchObject({ generation: 3, assignee: { id: bob.id } });
    expect(await ackOf(w, bob, id, 1)).toBe("stale-generation");
    const answer = await w.send(bob, conversation, { kind: "answer", body: "Old", answers: id, generation: 1 });
    expect(answer.status).toBe(409);
    expect(answer.body.error.code).toBe("stale-generation");
    expect(await ackOf(w, bob, id, 3)).toBe("acknowledged");
  });
});

describe("reassign, cancel, and close", () => {
  test("the sender reassigns to another session, which joins the conversation", async () => {
    const { w, alice, bob, conversation } = await pair();
    const id = await request(w, alice, bob, conversation);
    const bob2 = (await w.register(bob.device, { runtime: "claude" })).me;
    const reply = await action(w, alice, id, { action: "reassign", expectedGeneration: 1, to: bob2.address });
    expect(reply.status).toBe(200);
    expect(reply.body.message.request).toMatchObject({ generation: 2, assignee: { id: bob2.id } });
    expect(reply.body.message.request.events.at(-1)).toMatchObject({ kind: "reassigned", actor: { id: alice.id }, from: { id: bob.id }, to: { id: bob2.id } });
    expect(w.store.db.query("SELECT joined_via FROM memberships WHERE session_id = ?").get(bob2.id)).toEqual({ joined_via: "request" });
  });

  test("the assignee's owner reassigns, and a third owner cannot", async () => {
    const { w, alice, bob, conversation } = await pair();
    const carol = (await w.register(await w.enroll("carol"))).me;
    await w.join(carol, conversation);
    const id = await request(w, alice, bob, conversation);
    const bob2 = (await w.register(bob.device, { runtime: "claude" })).me;
    expect((await action(w, carol, id, { action: "reassign", expectedGeneration: 1, to: bob2.address })).status).toBe(403);
    expect((await action(w, bob, id, { action: "reassign", expectedGeneration: 1, to: bob2.address })).status).toBe(200);
  });

  test("only the sender's owner cancels; cancelled is terminal", async () => {
    const { w, alice, bob, conversation } = await pair();
    const id = await request(w, alice, bob, conversation);
    expect((await action(w, bob, id, { action: "cancel", expectedGeneration: 1, note: "" })).status).toBe(403);
    const reply = await action(w, alice, id, { action: "cancel", expectedGeneration: 1, note: "The apply moved to tomorrow." });
    expect(reply.status).toBe(200);
    expect(reply.body.message.request).toMatchObject({ status: "cancelled", generation: 2, outcome: null });
    expect(await ackOf(w, bob, id, 1)).toBe("request-closed");
    expect((await action(w, alice, id, { action: "close", expectedGeneration: 2, outcome: "resolved", note: "" })).body.error.code).toBe("request-closed");
  });

  test("the sender closes with any outcome; the assignee's owner only as declined or unresolved", async () => {
    const { w, alice, bob, conversation } = await pair();
    const declined = await request(w, alice, bob, conversation);
    expect((await action(w, bob, declined, { action: "close", expectedGeneration: 1, outcome: "resolved", note: "" })).status).toBe(403);
    const reply = await action(w, bob, declined, { action: "close", expectedGeneration: 1, outcome: "declined", note: "Not my area." });
    expect(reply.status).toBe(200);
    expect(RequestActionResult.json).toBeDefined();
    expect(reply.body.message.request).toMatchObject({ status: "closed", outcome: "declined", generation: 2 });
    const resolved = await request(w, alice, bob, conversation);
    const closed = await action(w, alice, resolved, { action: "close", expectedGeneration: 1, outcome: "superseded", note: "" });
    expect(closed.body.message.request).toMatchObject({ status: "closed", outcome: "superseded" });
    expect(w.receiptOf(resolved, bob.id).state).toBe("superseded");
  });
});

describe("recipients", () => {
  test("a login names the one live member session of that owner", async () => {
    const { w, alice, bob, conversation } = await pair();
    const reply = await w.send(alice, conversation, { kind: "request", body: "Status?", to: "bob" });
    expect(reply.status).toBe(201);
    expect(reply.body.message.to.map((ref: any) => ref.id)).toEqual([bob.id]);
  });

  test("a login with two live sessions, or none, is ambiguous and lists the candidates", async () => {
    const { w, alice, bob, conversation } = await pair();
    await secondBob(w, bob, conversation);
    const two = await w.send(alice, conversation, { kind: "request", body: "Status?", to: "@bob" });
    expect(two.status).toBe(409);
    expect(two.body.error.code).toBe("ambiguous-recipient");
    expect(two.body.error.details.candidates).toHaveLength(2);
    const carol = (await w.register(await w.enroll("carol"))).me;
    await w.join(carol, conversation);
    await w.ok("POST", `/v1/sessions/${carol.id}/end`, { reason: "exit" }, carol.device);
    const none = await w.send(alice, conversation, { kind: "request", body: "Status?", to: "carol" });
    expect(none.body.error.code).toBe("ambiguous-recipient");
    expect(none.body.error.details.candidates.map((candidate: any) => candidate.id)).toEqual([carol.id]);
  });

  test("a session that is not a member is joined to the conversation by the request", async () => {
    const { w, alice, conversation } = await pair();
    const carol = (await w.register(await w.enroll("carol"))).me;
    const reply = await w.send(alice, conversation, { kind: "request", body: "Status?", to: carol.id });
    expect(reply.status).toBe(201);
    expect(w.store.db.query("SELECT state, joined_via FROM memberships WHERE session_id = ?").get(carol.id)).toEqual({ state: "active", joined_via: "request" });
  });

  test("a request to itself, a request without to, and an update with to are refused", async () => {
    const { w, alice, bob, conversation } = await pair();
    expect((await w.send(alice, conversation, { kind: "request", body: "Me?", to: alice.address })).status).toBe(400);
    expect((await w.send(alice, conversation, { kind: "request", body: "Anyone?" })).status).toBe(400);
    expect((await w.send(alice, conversation, { kind: "update", body: "FYI", to: bob.address })).status).toBe(400);
  });

  test("a sender that is not a member gets not-member", async () => {
    const { w, conversation } = await pair();
    const carol = (await w.register(await w.enroll("carol"))).me;
    const reply = await w.send(carol, conversation, { kind: "update", body: "Hello" });
    expect(reply.status).toBe(403);
    expect(reply.body.error.code).toBe("not-member");
  });
});

describe("request lists", () => {
  test("assigned and sent, open and all, with a cursor", async () => {
    const { w, alice, bob, conversation } = await pair();
    const ids: string[] = [];
    for (let index = 0; index < 3; index++) {
      ids.push(await request(w, alice, bob, conversation, `Question ${index}`));
      w.clock.advance(1);
    }
    await action(w, alice, ids[0] ?? "", { action: "cancel", expectedGeneration: 1, note: "" });
    const open = await w.ok("GET", `/v1/sessions/${bob.id}/requests?role=assigned&state=open`, undefined, bob.device);
    expect(open.requests.map((message: any) => message.id)).toEqual([ids[2], ids[1]]);
    const page = await w.ok("GET", `/v1/sessions/${alice.id}/requests?role=sent&state=all&limit=2`, undefined, alice.device);
    expect(page.requests.map((message: any) => message.id)).toEqual([ids[2], ids[1]]);
    const rest = await w.ok("GET", `/v1/sessions/${alice.id}/requests?role=sent&state=all&limit=2&cursor=${page.next}`, undefined, alice.device);
    expect(rest).toEqual({ requests: [expect.objectContaining({ id: ids[0] })], next: null });
    const project = w.store.db.query<{ p: string }, [string]>("SELECT project_id AS p FROM sessions WHERE id = ?").get(bob.id)?.p;
    const owner = await w.ok("GET", `/v1/projects/${project}/requests?role=assigned`, undefined, bob.device);
    expect(owner.requests).toHaveLength(2);
  });
});
