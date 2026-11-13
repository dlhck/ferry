import { describe, expect, test } from "bun:test";
import { Constraint, ConstraintActionResult, JoinContext } from "../../../src/messaging/protocol.ts";
import { pair, type Session, type World } from "./helpers.ts";

async function create(w: World, session: Session, conversation: string, text = "Do not apply the key-authority stack before 14:00.") {
  return w.call("POST", `/v1/conversations/${conversation}/constraints`, { body: { sessionId: session.id, text }, device: session.device });
}

async function act(w: World, session: Session, id: string, body: Record<string, unknown>) {
  return w.call("POST", `/v1/constraints/${id}/action`, { body: { sessionId: session.id, ...body }, device: session.device });
}

async function context(w: World, session: Session, conversation: string): Promise<JoinContext> {
  return w.ok("GET", `/v1/conversations/${conversation}/context?sessionId=${session.id}`, undefined, session.device, 200, JoinContext);
}

describe("constraints", () => {
  test("a member creates one: active, the creator is responsible, its message is the source, the members get it without a wake", async () => {
    const { w, alice, bob, conversation } = await pair();
    const reply = await create(w, alice, conversation);
    expect(reply.status).toBe(201);
    const constraint = reply.body.constraint;
    expect(constraint).toMatchObject({ state: "active", responsible: { id: alice.id }, owner: { login: "alice" }, ownerAccess: "granted", resolved: null });
    const source = w.store.db.query<{ kind: string }, [string]>("SELECT kind FROM messages WHERE id = ?").get(constraint.sourceMessageId);
    expect(source?.kind).toBe("constraint");
    expect(w.receiptOf(constraint.sourceMessageId, bob.id)).toMatchObject({ wake: 0, state: "stored" });
    const events = await w.ok("GET", "/v1/worker/events?cursor=0", undefined, bob.device);
    expect(events.events.some((event: any) => event.type === "constraint.changed" && event.constraint.id === constraint.id)).toBe(true);
  });

  test("the responsible session resolves it; it leaves the join context and its history stays", async () => {
    const { w, alice, bob, conversation } = await pair();
    const id = (await create(w, alice, conversation)).body.constraint.id;
    expect((await context(w, bob, conversation)).activeConstraints.map((entry) => entry.id)).toEqual([id]);
    const resolved = await act(w, alice, id, { action: "resolve", note: "The apply finished." });
    expect(resolved.status).toBe(200);
    expect(resolved.body.constraint).toMatchObject({ state: "resolved", resolved: { by: { id: alice.id }, as: "owner", note: "The apply finished." } });
    expect((await context(w, bob, conversation)).activeConstraints).toEqual([]);
    const all = await w.ok("GET", `/v1/conversations/${conversation}/constraints?state=all`, undefined, bob.device);
    expect(all.constraints.map((entry: Constraint) => entry.id)).toEqual([id]);
    const kinds = w.store.db.query<{ kind: string }, [string]>("SELECT kind FROM constraint_events WHERE constraint_id = ? ORDER BY id").all(id);
    expect(kinds.map((row) => row.kind)).toEqual(["created", "resolved"]);
    expect((await act(w, alice, id, { action: "resolve", note: "" })).status).toBe(400);
  });

  test("another session of the same owner adopts it and then resolves it", async () => {
    const { w, alice, conversation } = await pair();
    const id = (await create(w, alice, conversation)).body.constraint.id;
    const alice2 = (await w.register(alice.device, { runtime: "codex" })).me;
    await w.join(alice2, conversation);
    const adopted = await act(w, alice2, id, { action: "adopt" });
    expect(adopted.status).toBe(200);
    expect(adopted.body.constraint.responsible.id).toBe(alice2.id);
    expect((await act(w, alice2, id, { action: "resolve", note: "Done." })).body.constraint.state).toBe("resolved");
  });

  test("another owner cannot adopt or resolve, and asks for a resolution instead", async () => {
    const { w, alice, bob, conversation } = await pair();
    const id = (await create(w, alice, conversation)).body.constraint.id;
    for (const body of [{ action: "adopt" }, { action: "resolve", note: "" }]) {
      const refused = await act(w, bob, id, body);
      expect(refused.status).toBe(403);
      expect(refused.body.error.code).toBe("not-constraint-owner");
    }
    const asked = await act(w, bob, id, { action: "request-resolution", evidence: "The apply finished at 10:02." });
    expect(asked.status).toBe(200);
    const result = asked.body as ConstraintActionResult;
    expect(result.request?.request).toMatchObject({ status: "pending", assignee: { id: alice.id } });
    expect(result.request?.body).toContain("The apply finished at 10:02.");
    expect(w.receiptOf(result.request?.id ?? "", alice.id)).toMatchObject({ wake: 1, generation: 1 });
    expect(result.constraint.state).toBe("active");
  });

  test("an admin resolves only after the constraint's owner lost access", async () => {
    const { w, alice, conversation } = await pair();
    const carolDevice = await w.enroll("carol");
    w.github.grant("carol", "acme/vendure-cloud", "admin");
    const carol = (await w.register(carolDevice)).me;
    await w.join(carol, conversation);
    const id = (await create(w, alice, conversation)).body.constraint.id;
    expect((await act(w, carol, id, { action: "resolve", note: "" })).status).toBe(403);
    w.github.grant("alice", "acme/vendure-cloud", "read");
    await w.tick(16 * 60_000);
    const view = (await w.ok("GET", `/v1/conversations/${conversation}/constraints`, undefined, carol.device)).constraints[0];
    expect(view.ownerAccess).toBe("lost");
    const resolved = await act(w, carol, id, { action: "resolve", note: "Alice left the team." });
    expect(resolved.status).toBe(200);
    expect(resolved.body.constraint.resolved).toMatchObject({ as: "admin", by: { id: carol.id } });
    const kinds = w.store.db.query<{ kind: string }, [string]>("SELECT kind FROM constraint_events WHERE constraint_id = ? ORDER BY id").all(id);
    expect(kinds.map((row) => row.kind)).toEqual(["created", "owner-lost-access", "resolved"]);
  });

  test("an old constraint stays in the join context; a non-member cannot create one", async () => {
    const { w, alice, conversation } = await pair();
    const id = (await create(w, alice, conversation)).body.constraint.id;
    w.clock.advance(90 * 24 * 3_600_000);
    const carol = (await w.register(await w.enroll("carol"))).me;
    expect((await create(w, carol, conversation)).body.error.code).toBe("not-member");
    await w.join(carol, conversation);
    const constraints = (await context(w, carol, conversation)).activeConstraints;
    expect(constraints.map((entry) => entry.id)).toEqual([id]);
    expect(constraints[0]?.ageMs).toBe(90 * 24 * 3_600_000);
  });
});
