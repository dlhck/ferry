import { describe, expect, test } from "bun:test";
import { HOUR, MINUTE } from "../../../src/messaging/relay/limits.ts";
import { pair, request, world } from "./helpers.ts";

function grantOf(w: ReturnType<typeof world>, ownerId: string) {
  return w.store.db.query<{ state: string; permission: string }, [string]>("SELECT state, permission FROM access_grants WHERE owner_id = ?").get(ownerId);
}

function membership(w: ReturnType<typeof world>, sessionId: string, conversationId: string) {
  return w.store.db
    .query<{ state: string; ended_reason: string | null }, [string, string]>("SELECT state, ended_reason FROM memberships WHERE session_id = ? AND conversation_id = ?")
    .get(sessionId, conversationId);
}

describe("project access", () => {
  test("maintenance checks a grant again after 15 minutes, not before", async () => {
    const { w } = await pair();
    const permissionCalls = () => w.github.calls.filter((call) => call.startsWith("permission")).length;
    const before = permissionCalls();
    await w.tick(10 * MINUTE);
    expect(permissionCalls()).toBe(before);
    await w.tick(6 * MINUTE);
    expect(permissionCalls()).toBe(before + 2);
  });

  test("a loss ends the memberships, supersedes the open receipts, and keeps the request open", async () => {
    const { w, alice, bob, conversation } = await pair();
    const id = await request(w, alice, bob, conversation);
    w.github.grant("bob", "acme/vendure-cloud", "read");
    await w.tick(16 * MINUTE);
    expect(grantOf(w, bob.device.ownerId)).toEqual({ state: "lost", permission: "read" });
    expect(membership(w, bob.id, conversation)).toEqual({ state: "ended", ended_reason: "access-lost" });
    expect(w.receiptOf(id, bob.id).state).toBe("superseded");
    expect((await w.ok("GET", `/v1/messages/${id}?sessionId=${alice.id}`, undefined, alice.device)).message.request.status).toBe("pending");
    const events = await w.ok("GET", "/v1/worker/events?cursor=0", undefined, bob.device);
    expect(events.events.some((event: any) => event.type === "session.access-lost" && event.sessionId === bob.id)).toBe(true);
    const rejoin = await w.call("POST", `/v1/conversations/${conversation}/join`, { body: { sessionId: bob.id }, device: bob.device });
    expect(rejoin.status).toBe(403);
    expect(rejoin.body.error.code).toBe("no-project-access");
  });

  test("a GitHub outage keeps access for 1 hour, then suspends the memberships; a later success restores them", async () => {
    const { w, bob, conversation } = await pair();
    w.github.unavailable = true;
    await w.tick(16 * MINUTE);
    expect(grantOf(w, bob.device.ownerId)?.state).toBe("unverifiable");
    expect(membership(w, bob.id, conversation)?.state).toBe("active");
    await w.tick(16 * MINUTE);
    await w.tick(16 * MINUTE);
    expect(membership(w, bob.id, conversation)?.state).toBe("active");
    await w.tick(HOUR);
    expect(membership(w, bob.id, conversation)).toEqual({ state: "suspended", ended_reason: "access-unverifiable" });
    w.github.unavailable = false;
    await w.tick(16 * MINUTE);
    expect(grantOf(w, bob.device.ownerId)?.state).toBe("granted");
    expect(membership(w, bob.id, conversation)?.state).toBe("active");
  });

  test("a project of an owner that the relay does not serve is refused; owners compare without case", async () => {
    const w = world({ allowedOwners: ["ACME"] });
    const device = await w.enroll("alice");
    expect((await w.register(device)).refusal).toBeNull();
    expect((await w.register(device, { repo: "github.com/globex/shop" })).refusal?.code).toBe("owner-not-allowed");
  });

  test("a repository whose owner did not install the App is app-not-installed with the install link", async () => {
    const w = world({ allowedOwners: ["acme", "globex"] });
    w.github.addRepo("globex/shop", 5151);
    w.github.uninstalled.add("globex");
    const device = await w.enroll("alice");
    const registered = await w.register(device, { repo: "github.com/globex/shop" });
    expect(registered.refusal?.code).toBe("app-not-installed");
    expect(registered.refusal?.message).toContain("acme-ferry-relay");
  });
});
