import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { credentialSha256, newDeviceCredential, newId } from "../../../src/messaging/ids.ts";
import { DeviceList, EnrollPolled, EnrollStarted, ErrorBody, Health, HEADERS, Me, validate } from "../../../src/messaging/protocol.ts";
import { startRelay } from "../../../src/messaging/relay/server.ts";
import { FakeClock, FakeGitHub, pair, tempDir, world, type World } from "./helpers.ts";

async function start(w: World, login = "alice") {
  const credential = newDeviceCredential();
  const started = await w.ok("POST", "/v1/enroll/start", { deviceName: "laptop", platform: "darwin", ferryVersion: "0.13.0", credentialSha256: credentialSha256(credential) }, undefined, 200, EnrollStarted);
  w.github.addUser(login, 501);
  return { credential, enrollmentId: started.enrollmentId, started };
}

const poll = (w: World, enrollmentId: string) => w.call("POST", "/v1/enroll/poll", { body: { enrollmentId } });

describe("enrollment", () => {
  test("pending, slow-down adds 5 s, then complete; a repeated poll returns the same result", async () => {
    const w = world();
    const { credential, enrollmentId, started } = await start(w);
    expect(started.intervalMs).toBe(5_000);
    w.github.polls.push({ state: "pending" }, { state: "slow-down" }, { state: "complete", user: { id: 501, login: "alice" } });
    expect((await poll(w, enrollmentId)).body).toEqual({ state: "pending", intervalMs: 5_000 });
    const slow = await poll(w, enrollmentId);
    expect(slow.status).toBe(202);
    expect(slow.body).toEqual({ state: "pending", intervalMs: 10_000 });
    const done = await poll(w, enrollmentId);
    expect(done.status).toBe(200);
    expect(done.body).toMatchObject({ state: "complete", owner: { login: "alice", githubUserId: 501 } });
    expect((await poll(w, enrollmentId)).body).toEqual(done.body);
    const device = { credential, deviceId: done.body.device.id, ownerId: done.body.owner.id, login: "alice" };
    expect((await w.ok("GET", "/v1/me", undefined, device, 200, Me)).device).toMatchObject({ id: device.deviceId, platform: "darwin" });
    expect(EnrollPolled.json).toBeDefined();
  });

  test("expired, denied, and unknown enrollments", async () => {
    const w = world();
    const expired = await start(w);
    w.github.polls.push({ state: "expired" });
    expect((await poll(w, expired.enrollmentId)).body.error.code).toBe("enrollment-expired");
    expect((await poll(w, expired.enrollmentId)).body.error.code).toBe("enrollment-unknown");
    const denied = await start(w);
    w.github.polls.push({ state: "denied" });
    const reply = await poll(w, denied.enrollmentId);
    expect(reply.status).toBe(410);
    expect(reply.body.error.code).toBe("enrollment-denied");
    const late = await start(w);
    w.clock.advance(901_000);
    expect((await poll(w, late.enrollmentId)).body.error.code).toBe("enrollment-expired");
    expect((await poll(w, "enr_unknown")).status).toBe(404);
  });

  test("a second enrollment of the same GitHub user is the same owner", async () => {
    const w = world();
    const first = await w.enroll("alice", 501);
    const second = await w.enroll("alice", 501);
    expect(second.ownerId).toBe(first.ownerId);
    expect(second.deviceId).not.toBe(first.deviceId);
  });
});

describe("devices", () => {
  test("a device creates another device, lists them, and revokes one; the revoked credential is refused and its sessions retire", async () => {
    const w = world();
    const laptop = await w.enroll("alice");
    const box = await w.addDevice(laptop, "fsn1");
    const list = await w.ok("GET", "/v1/devices", undefined, laptop, 200, DeviceList);
    expect(list.devices.map((entry) => entry.id).sort()).toEqual([laptop.deviceId, box.deviceId].sort());
    const session = (await w.register(box)).me;
    const revoked = await w.ok("POST", `/v1/devices/${box.deviceId}/revoke`, undefined, laptop);
    expect(revoked.device.id).toBe(box.deviceId);
    const refused = await w.call("GET", "/v1/me", { device: box });
    expect(refused.status).toBe(401);
    expect(refused.body.error.code).toBe("device-revoked");
    expect(w.store.db.query("SELECT state, ended_reason FROM sessions WHERE id = ?").get(session.id)).toEqual({ state: "retired", ended_reason: "device-revoked" });
    const events = await w.ok("GET", "/v1/worker/events?cursor=0", undefined, laptop);
    expect(events.events.some((event: any) => event.type === "device.revoked")).toBe(false);
  });

  test("a device of another owner cannot be revoked, and a used credential hash is refused", async () => {
    const w = world();
    const alice = await w.enroll("alice");
    const bob = await w.enroll("bob");
    expect((await w.call("POST", `/v1/devices/${bob.deviceId}/revoke`, { device: alice })).status).toBe(404);
    const reused = await w.call("POST", "/v1/devices", { body: { name: "copy", platform: "linux", credentialSha256: credentialSha256(alice.credential) }, device: alice });
    expect(reused.status).toBe(400);
  });
});

describe("requests to the relay", () => {
  test("health needs no headers; other calls need the protocol header and a known credential", async () => {
    const w = world();
    const health = await w.call("GET", "/v1/health", { headers: { [HEADERS.protocol]: "" } });
    expect(health.status).toBe(200);
    expect(validate(Health, health.body).ok).toBe(true);
    const device = await w.enroll("alice");
    const old = await w.call("GET", "/v1/me", { device, headers: { [HEADERS.protocol]: "2" } });
    expect(old.status).toBe(426);
    expect(old.body.error.code).toBe("upgrade-required");
    expect((await w.call("GET", "/v1/me")).status).toBe(401);
    const unknown = await w.call("GET", "/v1/me", { device: { ...device, credential: newDeviceCredential() } });
    expect(unknown.status).toBe(401);
    expect(validate(ErrorBody, unknown.body).ok).toBe(true);
    expect(unknown.body.error.code).toBe("unauthenticated");
    expect((await w.call("GET", "/v1/nothing", { device })).status).toBe(404);
  });

  test("a Ferry below minClientVersion gets 426", async () => {
    const dir = tempDir();
    const w = world({ dir });
    const device = await w.enroll("alice");
    const { createRelay } = await import("../../../src/messaging/relay/server.ts");
    const strict = createRelay(w.store, { github: w.github, clock: w.clock, log: () => {}, allowedOwners: ["acme"], minClientVersion: "0.14.0" });
    const response = await strict.handle(
      new Request("http://relay.test/v1/me", { headers: { [HEADERS.protocol]: "1", [HEADERS.version]: "0.13.0", authorization: `Bearer ${device.credential}` } }),
    );
    expect(response.status).toBe(426);
    strict.close();
  });

  test("a body above 64 KiB is too-large, a body that is not JSON or not valid is invalid-request", async () => {
    const { w, alice, conversation } = await pair();
    const big = await w.call("POST", `/v1/conversations/${conversation}/messages`, { body: { sessionId: alice.id, kind: "update", body: "x".repeat(70_000) }, device: alice.device });
    expect(big.status).toBe(413);
    expect(big.body.error.code).toBe("too-large");
    const notJson = await w.call("POST", `/v1/conversations/${conversation}/messages`, { body: "{", device: alice.device });
    expect(notJson.body.error.code).toBe("invalid-request");
    const invalid = await w.call("POST", `/v1/conversations/${conversation}/messages`, { body: { sessionId: alice.id, kind: "shout", body: "x" }, device: alice.device });
    expect(invalid.status).toBe(400);
    expect(invalid.body.error.details.issues.length).toBeGreaterThan(0);
  });

  test("a mutating call needs an idempotency key; a replay returns the stored response; another body with the key is a mismatch", async () => {
    const { w, alice, conversation } = await pair();
    const path = `/v1/conversations/${conversation}/messages`;
    const body = { sessionId: alice.id, kind: "update", body: "The apply finished." };
    expect((await w.call("POST", path, { body, device: alice.device, key: "" })).body.error.code).toBe("invalid-request");
    const key = newId("idempotencyKey", w.clock.now());
    const first = await w.call("POST", path, { body, device: alice.device, key });
    const again = await w.call("POST", path, { body, device: alice.device, key });
    expect(again.status).toBe(201);
    expect(again.headers.get(HEADERS.idempotentReplay)).toBe("true");
    expect(again.body).toEqual(first.body);
    expect(w.store.db.query("SELECT count(*) AS n FROM messages WHERE body = ?").get(body.body)).toEqual({ n: 1 });
    const other = await w.call("POST", path, { body: { ...body, body: "Something else." }, device: alice.device, key });
    expect(other.status).toBe(409);
    expect(other.body.error.code).toBe("idempotency-mismatch");
  });

  test("a refusal is stored for its key", async () => {
    const { w, conversation } = await pair();
    const carol = (await w.register(await w.enroll("carol"))).me;
    const key = newId("idempotencyKey", w.clock.now());
    const body = { sessionId: carol.id, kind: "update", body: "Hello" };
    const refused = await w.call("POST", `/v1/conversations/${conversation}/messages`, { body, device: carol.device, key });
    expect(refused.body.error.code).toBe("not-member");
    await w.join(carol, conversation);
    const replay = await w.call("POST", `/v1/conversations/${conversation}/messages`, { body, device: carol.device, key });
    expect(replay.headers.get(HEADERS.idempotentReplay)).toBe("true");
    expect(replay.body.error.code).toBe("not-member");
  });

  test("an internal error is 503 unavailable without details, and the log has no credential", async () => {
    const { w, alice } = await pair();
    w.store.db.run("DROP TABLE idempotency");
    const broken = await w.call("POST", "/v1/worker/heartbeat", { body: { sessions: [] }, device: alice.device });
    expect(broken.status).toBe(503);
    expect(broken.body.error).toEqual({ code: "unavailable", message: "The relay had an internal error.", hint: null });
    expect(w.logs.join("\n")).not.toContain(alice.device.credential);
  });
});

describe("worker events", () => {
  test("a long poll returns when an event comes, and the cursor moves on", async () => {
    const { w, alice, bob, conversation } = await pair();
    const first = await w.ok("GET", "/v1/worker/events?cursor=0", undefined, bob.device);
    const waiting = w.ok("GET", `/v1/worker/events?cursor=${first.cursor}&waitMs=20000`, undefined, bob.device);
    const startedAt = performance.now();
    await Bun.sleep(20);
    await w.send(alice, conversation, { kind: "request", body: "Status?", to: bob.address });
    const woken = await waiting;
    expect(performance.now() - startedAt).toBeLessThan(5_000);
    expect(woken.events.map((event: any) => event.type)).toContain("delivery.ready");
    expect(woken.cursor).toBeGreaterThan(first.cursor);
    const empty = await w.ok("GET", `/v1/worker/events?cursor=${woken.cursor}&waitMs=10`, undefined, bob.device);
    expect(empty).toEqual({ cursor: woken.cursor, events: [], resync: false });
  });

  test("a cursor that is pruned or ahead of the relay asks for a resync", async () => {
    const { w, bob } = await pair();
    const ahead = await w.ok("GET", "/v1/worker/events?cursor=999999", undefined, bob.device);
    expect(ahead.resync).toBe(true);
    await w.tick(31 * 24 * 3_600_000);
    const pruned = await w.ok("GET", "/v1/worker/events?cursor=1", undefined, bob.device);
    expect(pruned).toMatchObject({ events: [], resync: true });
    expect((await w.ok("GET", `/v1/worker/events?cursor=${pruned.cursor}`, undefined, bob.device)).resync).toBe(false);
  });

  test("a worker sees only the events of its device", async () => {
    const { w, alice, bob, conversation } = await pair();
    await w.send(alice, conversation, { kind: "request", body: "Status?", to: bob.address });
    const events = await w.ok("GET", "/v1/worker/events?cursor=0", undefined, alice.device);
    expect(events.events.filter((event: any) => event.type === "delivery.ready" && event.sessionId === bob.id)).toEqual([]);
  });
});

describe("startRelay", () => {
  test("serves on 127.0.0.1, refuses a second relay on the same store, and stops", async () => {
    const dir = tempDir();
    const options = { dbPath: join(dir, "relay.db"), listen: "127.0.0.1:0", github: new FakeGitHub(), clock: new FakeClock(), log: () => {}, allowedOwners: ["acme"] };
    const relay = await startRelay(options);
    try {
      expect(relay.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
      const health = await fetch(`${relay.url}/v1/health`);
      expect(await health.json()).toMatchObject({ ok: true, protocol: 1 });
      await expect(startRelay(options)).rejects.toThrow(/Another relay/);
    } finally {
      await relay.stop();
    }
    const again = await startRelay(options);
    await again.stop();
  });
});
