import { describe, expect, test } from "bun:test";
import { HOUR } from "../../../src/messaging/relay/limits.ts";
import { deliver, dispatchFor, pair, request, type Session, type World } from "./helpers.ts";

async function update(w: World, from: Session, conversation: string, causeIds: string[] = [], body = "FYI") {
  const reply = await w.send(from, conversation, { kind: "update", body, causeIds });
  if (reply.status !== 201) throw new Error(`update: ${reply.status} ${JSON.stringify(reply.body)}`);
  return reply.body.message;
}

describe("wake rate", () => {
  test("the 21st wake in one hour is held, and maintenance releases it after the first wake leaves the window", async () => {
    const { w, alice, bob, conversation } = await pair();
    const ids: string[] = [];
    for (let index = 0; index < 21; index++) {
      ids.push(await request(w, alice, bob, conversation, `Question ${index}`));
      w.clock.advance(1_000);
    }
    for (const id of ids.slice(0, 20)) {
      expect((await dispatchFor(w, bob, id)).body.decision).toBe("go");
      await deliver(w, bob, id);
    }
    const last = ids[20] ?? "";
    expect((await dispatchFor(w, bob, last)).body).toEqual({ decision: "hold", hold: "wake-rate" });
    expect(w.receiptOf(last, bob.id).hold).toBe("wake-rate");
    await w.tick(30 * 60_000);
    expect(w.receiptOf(last, bob.id).hold).toBe("wake-rate");
    await w.tick(31 * 60_000);
    expect(w.receiptOf(last, bob.id).hold).toBeNull();
    expect((await dispatchFor(w, bob, last)).body.decision).toBe("go");
  });

  test("receipts that do not wake do not count", async () => {
    const { w, alice, bob, conversation } = await pair();
    for (let index = 0; index < 25; index++) {
      const message = await update(w, alice, conversation, [], `Note ${index}`);
      expect((await dispatchFor(w, bob, message.id)).body.decision).toBe("go");
    }
    const id = await request(w, alice, bob, conversation);
    expect((await dispatchFor(w, bob, id)).body.decision).toBe("go");
  });
});

describe("hops", () => {
  test("a chain of causes counts hops, and the 7th hop does not wake", async () => {
    const { w, alice, bob, conversation } = await pair();
    let previous = await w.send(alice, conversation, { kind: "request", body: "Start", to: bob.address });
    let id: string = previous.body.message.id;
    expect(previous.body.message.hop).toBe(1);
    const order = [bob, alice];
    let holder = bob;
    for (let hop = 2; hop <= 7; hop++) {
      const sender = order[hop % 2] ?? bob;
      const recipient = sender === bob ? alice : bob;
      holder = recipient;
      previous = await w.send(sender, conversation, { kind: "request", body: `Hop ${hop}`, to: recipient.address, causeIds: [id] });
      expect(previous.status).toBe(201);
      expect(previous.body.message.hop).toBe(hop);
      id = previous.body.message.id;
      const receipt = w.receiptOf(id, recipient.id);
      expect(receipt.hold).toBe(hop > 6 ? "wake-hops" : null);
    }
    const pendingReply = await w.ok("GET", `/v1/sessions/${holder.id}/pending`, undefined, holder.device);
    expect(pendingReply.heldByHops.map((entry: any) => entry.message.id)).toEqual([id]);
    expect(pendingReply.receipts.some((entry: any) => entry.message.id === id)).toBe(false);
  });

  test("a cause that the sender did not receive does not raise the hop", async () => {
    const { w, alice, bob, conversation } = await pair();
    const own = await update(w, alice, conversation);
    expect((await update(w, alice, conversation, [own.id])).hop).toBe(1);
    expect((await update(w, bob, conversation, [own.id])).hop).toBe(2);
  });

  test("an answer has at least the hop of its request plus one", async () => {
    const { w, alice, bob, conversation } = await pair();
    const id = await request(w, alice, bob, conversation);
    const answer = await w.send(bob, conversation, { kind: "answer", body: "Yes.", answers: id, generation: 1 });
    expect(answer.body.message.hop).toBe(2);
  });
});

describe("rate limits", () => {
  test("the 121st message of a session in one hour is rate-limited with a retry time", async () => {
    const { w, alice, conversation } = await pair();
    for (let index = 0; index < 120; index++) {
      await update(w, alice, conversation, [], `Note ${index}`);
      w.clock.advance(10_000);
    }
    const refused = await w.send(alice, conversation, { kind: "update", body: "One more" });
    expect(refused.status).toBe(429);
    expect(refused.body.error.code).toBe("rate-limited");
    expect(refused.body.error.details.retryAfterMs).toBe(HOUR - 120 * 10_000);
    w.clock.advance(refused.body.error.details.retryAfterMs + 1);
    expect((await w.send(alice, conversation, { kind: "update", body: "One more" })).status).toBe(201);
  });

  test("the 11th conversation of an owner in one hour is rate-limited", async () => {
    const { w, alice } = await pair();
    for (let index = 1; index < 10; index++) await w.conversation(alice, `topic ${index}`);
    const project = w.store.db.query<{ p: string }, [string]>("SELECT project_id AS p FROM sessions WHERE id = ?").get(alice.id)?.p;
    const refused = await w.call("POST", `/v1/projects/${project}/conversations`, {
      body: { sessionId: alice.id, name: "topic 11", purpose: "More.", force: true },
      device: alice.device,
    });
    expect(refused.status).toBe(429);
    expect(refused.body.error.code).toBe("rate-limited");
  });
});
