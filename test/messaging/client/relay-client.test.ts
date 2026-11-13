import { afterEach, describe, expect, test } from "bun:test";
import { checkRelayUrl, RelayClient, RelayError, RelayProtocolError, RelayUnreachableError } from "../../../src/messaging/client/relay-client.ts";
import { isId, newId } from "../../../src/messaging/ids.ts";

type Seen = { method: string; path: string; headers: Headers; body: string };
type Reply = Response | "drop";


/** A relay that answers from a list, and records each request. */
function fakeRelay(replies: Reply[]) {
  const seen: Seen[] = [];
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      const url = new URL(request.url);
      seen.push({ method: request.method, path: `${url.pathname}${url.search}`, headers: request.headers, body: await request.text() });
      const reply = replies.shift() ?? new Response("no reply left", { status: 500 });
      // No answer: the client times out.
      if (reply === "drop") return new Promise<Response>(() => {});
      return reply;
    },
  });
  servers.push(server);
  return { url: `http://127.0.0.1:${server.port}`, seen };
}
const servers: ReturnType<typeof Bun.serve>[] = [];
afterEach(async () => {
  for (const server of servers.splice(0)) await server.stop(true);
});

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
const CREDENTIAL = `fmr_${"a".repeat(43)}`;
const DEVICE = newId("device");
const ISO = "2026-01-05T09:00:00.000Z";
const health = { ok: true, protocol: 1, minClientVersion: "0.12.0", relayVersion: "0.12.0" } as const;
const client = (url: string, extra: Partial<ConstructorParameters<typeof RelayClient>[0]> = {}) =>
  new RelayClient({ url, credential: CREDENTIAL, ferryVersion: "0.12.0", sleep: async () => {}, timeoutMs: 2_000, ...extra });

describe("the relay URL", () => {
  test.each([
    ["https://ferry-relay.example.ts.net:8443/", "https://ferry-relay.example.ts.net:8443"],
    ["https://relay.example.com/ferry/", "https://relay.example.com/ferry"],
    ["http://127.0.0.1:47830", "http://127.0.0.1:47830"],
    ["http://localhost:47830", "http://localhost:47830"],
  ])("%s is accepted as %s", (url, base) => {
    expect(checkRelayUrl(url)).toBe(base);
  });

  test.each([
    ["http://ferry-relay.example.ts.net:8443", "must use https://"],
    ["https://user:secret@relay.example.com", "must not have a user"],
    ["https://relay.example.com/?token=x", "must not have a user, a password, a query"],
    ["relay.example.com", "is not a URL"],
  ])("%s is refused", (url, message) => {
    expect(() => checkRelayUrl(url)).toThrow(message);
  });
});

describe("the relay client", () => {
  test("sends the protocol headers, the bearer credential, and an idempotency key on a mutating call only", async () => {
    const relay = fakeRelay([
      json(200, health),
      json(200, { serverTime: ISO }),
      json(200, { device: { id: DEVICE, revokedAt: ISO } }),
      json(202, { state: "pending", intervalMs: 5000 }),
    ]);
    const relayClient = client(relay.url);

    expect(await relayClient.health()).toEqual(health);
    expect(await relayClient.heartbeat({ sessions: [] }, { idempotencyKey: "idk_01JC9Z8K4Q2M7T5V3X6Y1A2B3C" })).toEqual({ serverTime: ISO });
    await relayClient.revokeDevice(DEVICE);
    expect(await relayClient.enrollPoll({ enrollmentId: "enr-example" })).toEqual({ state: "pending", intervalMs: 5000 });

    const [get, post, revoke, enroll] = relay.seen;
    for (const request of relay.seen) {
      expect(request.headers.get("ferry-protocol")).toBe("1");
      expect(request.headers.get("ferry-version")).toBe("0.12.0");
    }
    expect(get).toMatchObject({ method: "GET", path: "/v1/health" });
    expect(get!.headers.get("authorization")).toBeNull();
    expect(get!.headers.get("idempotency-key")).toBeNull();
    expect(post).toMatchObject({ method: "POST", path: "/v1/worker/heartbeat", body: '{"sessions":[]}' });
    expect(post!.headers.get("authorization")).toBe(`Bearer ${CREDENTIAL}`);
    expect(post!.headers.get("idempotency-key")).toBe("idk_01JC9Z8K4Q2M7T5V3X6Y1A2B3C");
    expect(revoke).toMatchObject({ path: `/v1/devices/${DEVICE}/revoke`, body: "{}" });
    expect(isId("idempotencyKey", revoke!.headers.get("idempotency-key"))).toBe(true);
    expect(enroll!.headers.get("authorization")).toBeNull();
    expect(enroll!.headers.get("idempotency-key")).toBeNull();
  });

  test("puts the query parameters in the URL and leaves out absent ones", async () => {
    const relay = fakeRelay([json(200, { requests: [], next: null }), json(200, { cursor: 4, events: [], resync: false })]);
    const relayClient = client(relay.url);

    await relayClient.sessionRequests("ses_01JC9Z8K4Q2M7T5V3X6Y1A2B3C", { role: "assigned", state: "open" });
    await relayClient.events(3, 10);

    expect(relay.seen.map((request) => request.path)).toEqual([
      "/v1/sessions/ses_01JC9Z8K4Q2M7T5V3X6Y1A2B3C/requests?role=assigned&state=open",
      "/v1/worker/events?cursor=3&waitMs=10",
    ]);
  });

  test("retries a call without an answer with the same idempotency key", async () => {
    const relay = fakeRelay(["drop", new Response("Bad Gateway", { status: 502 }), json(200, { serverTime: ISO })]);
    const relayClient = client(relay.url, { timeoutMs: 200 });

    expect(await relayClient.heartbeat({ sessions: [] })).toEqual({ serverTime: ISO });
    const keys = relay.seen.map((request) => request.headers.get("idempotency-key"));
    expect(keys).toHaveLength(3);
    expect(new Set(keys).size).toBe(1);
  });

  test("a relay error unavailable is retried, and after the retries the relay is unreachable", async () => {
    const unavailable = () => json(503, { error: { code: "unavailable", message: "The relay is starting.", hint: null } });
    const relay = fakeRelay([unavailable(), unavailable(), unavailable()]);

    const error = await client(relay.url).heartbeat({ sessions: [] }).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(RelayUnreachableError);
    expect((error as Error).message).toBe("The relay is not reachable: POST /v1/worker/heartbeat: The relay is starting.");
    expect(relay.seen).toHaveLength(3);
  });

  test("another relay error is a RelayError with its code, hint, and details, without a retry", async () => {
    const relay = fakeRelay([
      json(409, { error: { code: "generation-conflict", message: "The request has a newer generation.", hint: "Read it again.", details: { generation: 3 } } }),
    ]);

    const error = (await client(relay.url)
      .requestAction("msg_01JC9Z8K4Q2M7T5V3X6Y1A2B3C", { action: "claim", sessionId: "ses_01JC9Z8K4Q2M7T5V3X6Y1A2B3C", expectedGeneration: 2 })
      .catch((caught: unknown) => caught)) as RelayError;

    expect(error).toBeInstanceOf(RelayError);
    expect({ status: error.status, code: error.code, hint: error.hint, details: error.details }).toEqual({
      status: 409,
      code: "generation-conflict",
      hint: "Read it again.",
      details: { generation: 3 },
    });
    expect(relay.seen).toHaveLength(1);
  });

  test("refuses an invalid request body before it sends it", async () => {
    const relay = fakeRelay([]);
    const body = { sessions: [], extra: true } as unknown as Parameters<RelayClient["heartbeat"]>[0];

    const error = (await client(relay.url).heartbeat(body).catch((caught: unknown) => caught)) as RelayError;

    expect(error).toBeInstanceOf(RelayError);
    expect(error.code).toBe("invalid-request");
    expect(error.message).toContain("$.extra: unknown field");
    expect(relay.seen).toHaveLength(0);
  });

  test("an answer that the protocol does not allow is a RelayProtocolError", async () => {
    const relay = fakeRelay([json(200, { ...health, extra: 1 })]);

    await expect(client(relay.url).health()).rejects.toBeInstanceOf(RelayProtocolError);
  });

  test("an authenticated call without a credential fails before it sends", async () => {
    const relay = fakeRelay([]);

    await expect(client(relay.url, { credential: null }).me()).rejects.toThrow("needs a device credential");
    expect(relay.seen).toHaveLength(0);
  });
});

describe("the transport of the worker outbox", () => {
  test("request makes one try and gives the status and the JSON body of each answer", async () => {
    const conflict = { error: { code: "generation-conflict", message: "The request has a newer generation.", hint: null } };
    const relay = fakeRelay([json(409, conflict), new Response("Bad Gateway", { status: 502 }), json(200, { cursor: 4, events: [], resync: false })]);
    const relayClient = client(relay.url);

    expect(await relayClient.request({ method: "POST", path: "/v1/worker/heartbeat", body: { sessions: [] }, idempotencyKey: "idk_01JC9Z8K4Q2M7T5V3X6Y1A2B3C" })).toEqual({
      status: 409,
      body: conflict,
    });
    expect(await relayClient.request({ method: "POST", path: "/v1/sessions/ses_01JC9Z8K4Q2M7T5V3X6Y1A2B3C/end", body: { reason: "exit" } })).toEqual({ status: 502, body: null });
    expect(await relayClient.request({ method: "GET", path: "/v1/worker/events?cursor=3&waitMs=10" })).toEqual({ status: 200, body: { cursor: 4, events: [], resync: false } });

    const [first, second, third] = relay.seen;
    expect(relay.seen).toHaveLength(3);
    expect(first!.headers.get("idempotency-key")).toBe("idk_01JC9Z8K4Q2M7T5V3X6Y1A2B3C");
    expect(first!.headers.get("authorization")).toBe(`Bearer ${CREDENTIAL}`);
    expect(first!.headers.get("ferry-protocol")).toBe("1");
    // The outbox gives the key. request makes none.
    expect(second!.headers.get("idempotency-key")).toBeNull();
    expect(third).toMatchObject({ method: "GET", path: "/v1/worker/events?cursor=3&waitMs=10", body: "" });
    expect(third!.headers.get("idempotency-key")).toBeNull();
  });

  test("request throws RelayUnreachableError when the signal stops the call, and it does not retry", async () => {
    const relay = fakeRelay(["drop"]);
    const controller = new AbortController();
    const call = client(relay.url).request({ method: "POST", path: "/v1/worker/heartbeat", body: { sessions: [] }, signal: controller.signal });
    controller.abort();

    const error = await call.catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(RelayUnreachableError);
    expect((error as Error).message).toBe("The relay is not reachable: POST /v1/worker/heartbeat: the call was stopped");
    expect(relay.seen.length).toBeLessThanOrEqual(1);
  });

  test("request refuses a path outside /v1/", () => {
    expect(() => client("http://127.0.0.1:9").request({ method: "GET", path: "/health" })).toThrow("does not start with /v1/");
  });
});
