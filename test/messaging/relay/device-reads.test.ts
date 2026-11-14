import { describe, expect, test } from "bun:test";
import { MINUTE } from "../../../src/messaging/relay/limits.ts";
import { storeCounts } from "../../../src/messaging/relay/store.ts";
import { pair, request, REPO, type Device, type World } from "./helpers.ts";

/** The reads of the CLI views (`ferry messaging conversations`, `show`, `requests`, `peers`, `devices`), with a device credential and no session. */
async function reads(w: World, device: Device, ids: { project: string; conversation: string; message: string }) {
  const paths = [
    `/v1/projects?key=${encodeURIComponent(REPO)}`,
    `/v1/projects/${ids.project}/conversations?state=all`,
    `/v1/conversations/${ids.conversation}/messages`,
    `/v1/conversations/${ids.conversation}/constraints`,
    `/v1/messages/${ids.message}`,
    `/v1/projects/${ids.project}/requests?role=sent&state=open`,
    `/v1/projects/${ids.project}/sessions?state=live`,
    "/v1/devices",
  ];
  const replies = [];
  for (const path of paths) replies.push({ path, ...(await w.call("GET", path, { device })) });
  return replies;
}

async function setup() {
  const { w, alice, bob, conversation } = await pair();
  const message = await request(w, alice, bob, conversation);
  const project = w.store.db.query<{ p: string }, [string]>("SELECT project_id AS p FROM sessions WHERE id = ?").get(alice.id)?.p ?? "";
  // The laptop of alice has no session: the CLI runs there.
  const laptop = await w.addDevice(alice.device, "laptop");
  return { w, alice, bob, laptop, ids: { project, conversation, message } };
}

describe("device-scoped reads", () => {
  test("a device without a session reads the views of its owner's project", async () => {
    const { w, alice, laptop, ids } = await setup();
    for (const reply of await reads(w, laptop, ids)) expect([reply.path, reply.status]).toEqual([reply.path, 200]);
    const sent = (await w.ok("GET", `/v1/projects/${ids.project}/requests?role=sent&state=open`, undefined, laptop)).requests;
    expect(sent.map((message: any) => message.id)).toEqual([ids.message]);
    expect(sent[0].sender.id).toBe(alice.id);
  });

  test("a device of an owner without write access reads nothing of the project", async () => {
    const { w, ids } = await setup();
    const device = await w.enroll("mallory");
    w.github.grant("mallory", "acme/vendure-cloud", "read");
    for (const reply of await reads(w, device, ids)) {
      if (reply.path === "/v1/devices") continue;
      expect([reply.path, reply.status, reply.body.error.code]).toEqual([reply.path, 403, "no-project-access"]);
    }
  });

  test("a device read checks the grant again when the last check is 15 minutes old, also for an owner without memberships", async () => {
    const { w, ids } = await setup();
    const device = await w.enroll("carol");
    const path = `/v1/conversations/${ids.conversation}/messages`;
    expect((await w.call("GET", path, { device })).status).toBe(200);
    const permissionCalls = () => w.github.calls.filter((call) => call.startsWith("permission") && call.endsWith("carol")).length;
    const before = permissionCalls();
    w.github.grant("carol", "acme/vendure-cloud", "read");
    await w.tick(10 * MINUTE);
    expect((await w.call("GET", path, { device })).status).toBe(200);
    expect(permissionCalls()).toBe(before);
    await w.tick(6 * MINUTE);
    const late = await w.call("GET", path, { device });
    expect(late.status).toBe(403);
    expect(late.body.error.code).toBe("no-project-access");
  });

  test("a device read keeps working during a GitHub outage within the grace hour", async () => {
    const { w, laptop, ids } = await setup();
    w.github.unavailable = true;
    await w.tick(20 * MINUTE);
    expect((await w.call("GET", `/v1/conversations/${ids.conversation}/messages`, { device: laptop })).status).toBe(200);
  });

  test("a mutating call without a session is refused, except the revoke of the owner's own device", async () => {
    const { w, alice, laptop, ids } = await setup();
    const send = await w.call("POST", `/v1/conversations/${ids.conversation}/messages`, { body: { kind: "update", body: "Hello" }, device: laptop });
    expect(send.status).toBe(400);
    const box = await w.addDevice(alice.device, "box");
    expect((await w.call("POST", `/v1/devices/${box.deviceId}/revoke`, { body: {}, device: laptop })).status).toBe(200);
  });
});

describe("store counts", () => {
  test("counts the rows of a store that a relay has open, and is null for a missing store", async () => {
    const { w } = await setup();
    expect(storeCounts(w.store.path)).toEqual({ owners: 2, devices: 3, liveSessions: 2, conversations: 1, openRequests: 1 });
    expect(storeCounts(`${w.store.path}.missing`)).toBeNull();
  });
});
