import { describe, expect, test } from "bun:test";
import { SESSION_ADDRESS } from "../../../src/messaging/ids.ts";
import { SessionRegistered } from "../../../src/messaging/protocol.ts";
import { pair, request, world, REPO } from "./helpers.ts";

function sessionState(w: ReturnType<typeof world>, id: string) {
  return w.store.db.query<{ state: string; device_id: string }, [string]>("SELECT state, device_id FROM sessions WHERE id = ?").get(id);
}

describe("registration", () => {
  test("a new session gets an address and the project", async () => {
    const w = world();
    const device = await w.enroll("alice");
    const registered = await w.ok("POST", "/v1/sessions", {
      runtime: "claude",
      runtimeSessionId: "runtime-a",
      runtimeVersion: "2.1.323",
      adapter: "supported",
      repo: { key: REPO },
      branch: "main",
      head: null,
      worktree: "vendure-cloud",
      task: null,
      source: "startup",
    }, device, 200, SessionRegistered);
    expect(registered.session.address).toMatch(SESSION_ADDRESS);
    expect(registered.session.address.startsWith("@alice/claude-")).toBe(true);
    expect(registered.project).toMatchObject({ key: REPO, repoId: 4242, access: "granted" });
    expect(registered.refusal).toBeNull();
  });

  test("the same runtime session from the same device keeps its id and address", async () => {
    const w = world();
    const device = await w.enroll("alice");
    const first = await w.register(device, { runtimeSessionId: "runtime-a" });
    const again = await w.register(device, { runtimeSessionId: "runtime-a" });
    expect(again.session.id).toBe(first.session.id);
    expect(again.session.address).toBe(first.session.address);
  });

  test("a registration from another device of the owner moves the session and tells the old worker", async () => {
    const { w, alice, bob, conversation } = await pair();
    const id = await request(w, bob, alice, conversation);
    const box = await w.addDevice(alice.device);
    const runtimeSessionId = w.store.db.query<{ r: string }, [string]>("SELECT runtime_session_id AS r FROM sessions WHERE id = ?").get(alice.id)?.r;
    const moved = await w.register(box, { runtimeSessionId });
    expect(moved.session).toMatchObject({ id: alice.id, address: alice.address });
    expect(sessionState(w, alice.id)?.device_id).toBe(box.deviceId);
    expect(moved.assigned.map((message) => message.id)).toEqual([id]);
    const events = await w.ok("GET", "/v1/worker/events?cursor=0", undefined, alice.device);
    expect(events.events.some((event: any) => event.type === "session.moved" && event.toDeviceId === box.deviceId)).toBe(true);
    // The old device cannot act for the session now.
    expect((await w.call("GET", `/v1/sessions/${alice.id}/pending`, { device: alice.device })).status).toBe(403);
  });

  test("a refusal registers the session without a project", async () => {
    const w = world();
    const device = await w.enroll("alice");
    w.github.grant("alice", "acme/vendure-cloud", "read");
    const registered = await w.register(device);
    expect(registered.project).toBeNull();
    expect(registered.refusal?.code).toBe("no-project-access");
    const other = await w.register(device, { repo: "github.com/globex/shop" });
    expect(other.refusal?.code).toBe("owner-not-allowed");
    const none = await w.register(device, { repo: null });
    expect(none).toMatchObject({ project: null, refusal: null });
  });

  test("a session joins a conversation with a matching link or auto-join all, but not one that it left", async () => {
    const { w, alice } = await pair();
    const project = w.store.db.query<{ p: string }, [string]>("SELECT project_id AS p FROM sessions WHERE id = ?").get(alice.id)?.p;
    const create = (name: string, extra: Record<string, unknown>) =>
      w.ok("POST", `/v1/projects/${project}/conversations`, { sessionId: alice.id, name, purpose: "Coordinate.", force: true, ...extra }, alice.device, 201);
    const linked = (await create("issue 214", { links: [{ kind: "issue", ref: "#214" }] })).conversation.id;
    const everyone = (await create("releases", { autoJoin: "all" })).conversation.id;
    await create("other", { links: [{ kind: "issue", ref: "#2140" }] });
    const device = await w.enroll("carol");
    const carol = await w.register(device, { branch: "fix/214-key-rotation", runtimeSessionId: "carol-1" });
    expect(carol.autoJoined.map((entry) => entry.id).sort()).toEqual([linked, everyone].sort());
    const via = w.store.db.query<{ conversation_id: string; joined_via: string }, [string]>("SELECT conversation_id, joined_via FROM memberships WHERE session_id = ?").all(carol.me.id);
    expect(Object.fromEntries(via.map((row) => [row.conversation_id, row.joined_via]))).toEqual({ [linked]: "auto-link", [everyone]: "auto-all" });
    await w.ok("POST", `/v1/conversations/${everyone}/leave`, { sessionId: carol.me.id }, device);
    const again = await w.register(device, { branch: "fix/214-key-rotation", runtimeSessionId: "carol-1" });
    expect(again.autoJoined).toEqual([]);
  });
});

describe("liveness", () => {
  test("a device without a heartbeat for 90 s makes its sessions unknown; a heartbeat makes them live", async () => {
    const { w, alice, bob, conversation } = await pair();
    await w.heartbeat(bob.device, [{ id: bob.id }]);
    await w.tick(91_000);
    expect(sessionState(w, bob.id)?.state).toBe("unknown");
    const id = await request(w, alice, bob, conversation);
    expect(w.receiptOf(id, bob.id).hold).toBe("worker-offline");
    await w.heartbeat(bob.device, [{ id: bob.id }]);
    expect(sessionState(w, bob.id)?.state).toBe("live");
    expect(w.receiptOf(id, bob.id).hold).toBeNull();
  });

  test("a heartbeat that does not name an unknown session makes it offline", async () => {
    const { w, alice, bob, conversation } = await pair();
    await w.tick(91_000);
    const id = await request(w, alice, bob, conversation);
    await w.heartbeat(bob.device, []);
    expect(sessionState(w, bob.id)?.state).toBe("offline");
    expect(w.receiptOf(id, bob.id).hold).toBe("recipient-offline");
  });

  test("an ended session is offline and a registration brings it back; a retired session ends its memberships", async () => {
    const { w, bob, conversation } = await pair();
    await w.ok("POST", `/v1/sessions/${bob.id}/end`, { reason: "exit" }, bob.device);
    expect(sessionState(w, bob.id)?.state).toBe("offline");
    await w.heartbeat(bob.device, [{ id: bob.id }]);
    expect(sessionState(w, bob.id)?.state).toBe("live");
    await w.ok("POST", `/v1/sessions/${bob.id}/end`, { reason: "retired" }, bob.device);
    expect(sessionState(w, bob.id)?.state).toBe("retired");
    const membership = w.store.db.query("SELECT state, ended_reason FROM memberships WHERE session_id = ? AND conversation_id = ?").get(bob.id, conversation);
    expect(membership).toEqual({ state: "ended", ended_reason: "retired" });
    // A heartbeat does not revive a retired session.
    await w.heartbeat(bob.device, [{ id: bob.id }]);
    expect(sessionState(w, bob.id)?.state).toBe("retired");
  });

  test("an adapter change releases the runtime holds", async () => {
    const { w, alice, bob, conversation } = await pair();
    await w.ok("PATCH", `/v1/sessions/${bob.id}`, { adapter: "unconfirmed" }, bob.device);
    const id = await request(w, alice, bob, conversation);
    expect(w.receiptOf(id, bob.id).hold).toBe("runtime-unconfirmed");
    await w.ok("PATCH", `/v1/sessions/${bob.id}`, { adapter: "supported" }, bob.device);
    expect(w.receiptOf(id, bob.id).hold).toBeNull();
  });
});
