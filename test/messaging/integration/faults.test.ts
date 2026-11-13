/**
 * Layer 2 (design 15.2): fault injection. The relay dies during a send, a worker
 * stops during an injection, a key repeats, the network drops, and access ends
 * during an active membership.
 */

import { describe, expect, test } from "bun:test";
import { MINUTE, SECOND } from "../harness/clock.ts";
import { suiteTitle } from "../harness/lanes.ts";
import {
  enterApproval,
  openConversation,
  receiptsOf,
  sendRequest,
  systemReady,
  useSystem,
  waitFor,
  type Session,
} from "../harness/system.ts";
import { newIdempotencyKey } from "../harness/wire.ts";

const TIMEOUT = 45_000;

/** The messages of a conversation in the relay store, through the relay API. */
async function storedMessages(session: Session, http: { get<T>(path: string): Promise<{ status: number; body: T }> }, conversationId: string) {
  const page = await http.get<{ messages: { id: string; body: string; kind: string }[] }>(
    `/v1/conversations/${conversationId}/messages?sessionId=${session.id}&limit=50`,
  );
  expect(page.status).toBe(200);
  return page.body.messages;
}

/**
 * An adapter whose first `inject` reaches the runtime and then never returns, as a
 * worker that dies after the write and before it records the result.
 */
function hangAfterFirstInject(adapter: unknown): unknown {
  let first = true;
  return new Proxy(adapter as object, {
    get(target, property, receiver) {
      const value = Reflect.get(target, property, receiver);
      if (property !== "inject" || typeof value !== "function") return typeof value === "function" ? value.bind(target) : value;
      return async (...args: unknown[]) => {
        const result = await value.apply(target, args);
        if (!first) return result;
        first = false;
        return new Promise(() => {});
      };
    },
  });
}

describe.skipIf(!systemReady)(suiteTitle("faults"), () => {
  const system = useSystem();

  test(
    "the relay dies after it stored a send: the worker retries with the same key, and the message exists once",
    async () => {
      const alice = await system().startSession("alice", "claude");
      const bob = await system().startSession("bob", "codex");
      const conversation = await openConversation(alice, [bob]);

      const cut = system().proxy.cutNextResponse(/^POST \/v1\/conversations\/[^/ ]+\/messages /);
      const body = "Is the cache warm on the new nodes?";
      const sending = alice.tool("ferry_send", { conversation: conversation.slug, kind: "request", to: bob.address, body });
      await cut;
      await system().stopRelay();
      await system().startRelay();
      const sent = await sending;
      expect(sent.ok).toBe(true);

      await waitFor(() => bob.envelopes().find((envelope) => envelope.text.includes(body)), {
        clock: system().clock,
        advanceMs: SECOND,
        what: "the request after the relay restart",
      });
      const stored = (await storedMessages(alice, system().participant("alice").http, conversation.id)).filter((message) => message.body === body);
      expect(stored).toHaveLength(1);
      expect(bob.envelopes().filter((envelope) => envelope.text.includes(body))).toHaveLength(1);
    },
    TIMEOUT,
  );

  test(
    "a worker that stops during an injection injects at most once more, and the second ack is already-acknowledged",
    async () => {
      const alice = await system().startSession("alice", "claude");
      const bob = await system().startSession("bob", "codex");
      const conversation = await openConversation(alice, [bob]);
      await system().stopWorker("bob");
      await system().startWorker("bob", { wrap: hangAfterFirstInject });

      const id = await sendRequest(alice, conversation.slug, bob.address, "Did the backup run?");
      await waitFor(() => bob.envelopes().find((envelope) => envelope.id === id), { what: "the first injection" });
      await system().stopWorker("bob");
      await system().startWorker("bob");

      // Give the new worker the time of a confirmation window and a re-injection.
      for (let step = 0; step < 6; step++) {
        system().clock.advance(MINUTE);
        await Bun.sleep(100);
      }
      const injections = bob.envelopes().filter((envelope) => envelope.id === id);
      expect(injections.length).toBeGreaterThanOrEqual(1);
      expect(injections.length).toBeLessThanOrEqual(2);

      // The agent acts on each injection that it sees. Only the first ack counts.
      const results: string[] = [];
      for (let ack = 0; ack < 2; ack++) {
        const reply = await bob.tool("ferry_ack", { items: [{ id, generation: 1 }] });
        results.push(reply.result!.items[0].result as string);
      }
      expect(results).toEqual(["acknowledged", "already-acknowledged"]);
    },
    TIMEOUT,
  );

  test(
    "a repeated idempotency key returns the stored answer, and a changed body with that key fails",
    async () => {
      const alice = await system().startSession("alice", "claude");
      const bob = await system().startSession("bob", "codex");
      const conversation = await openConversation(alice, [bob]);
      const http = system().participant("alice").http;
      const key = newIdempotencyKey();
      const path = `/v1/conversations/${conversation.id}/messages`;
      const body = { sessionId: alice.id, kind: "update", body: "The release branch is cut." };

      const first = await http.post<{ message: { id: string } }>(path, body, key);
      expect(first.status).toBe(201);
      const replay = await http.post<{ message: { id: string } }>(path, body, key);
      expect(replay.status).toBe(201);
      expect(replay.headers.get("Idempotent-Replay")).toBe("true");
      expect(replay.body.message.id).toBe(first.body.message.id);

      const mismatch = await http.post<{ error: { code: string } }>(path, { ...body, body: "Another text." }, key);
      expect(mismatch.status).toBe(409);
      expect(mismatch.body.error.code).toBe("idempotency-mismatch");

      const stored = (await storedMessages(alice, http, conversation.id)).filter((message) => message.kind === "update");
      expect(stored.map((message) => message.id)).toEqual([first.body.message.id]);
    },
    TIMEOUT,
  );

  test(
    "a network drop keeps the send in the outbox, and it arrives after the network returns",
    async () => {
      const alice = await system().startSession("alice", "claude");
      const bob = await system().startSession("bob", "codex");
      const conversation = await openConversation(alice, [bob]);

      system().proxy.setMode("refuse");
      const body = "Hold the merge queue for ten minutes.";
      const sent = await alice.tool("ferry_send", { conversation: conversation.slug, kind: "request", to: bob.address, body });
      expect(sent.ok).toBe(true);
      expect(sent.result!.state).toBe("queued-offline");
      expect(String(sent.result!.key)).toMatch(/^idk_/);

      const offline = await alice.tool("ferry_conversations", {});
      expect(offline.ok).toBe(false);
      expect(offline.error!.code).toBe("relay-offline");

      system().proxy.setMode("pass");
      await waitFor(() => bob.envelopes().find((envelope) => envelope.text.includes(body)), {
        clock: system().clock,
        advanceMs: SECOND,
        timeoutMs: 30_000,
        what: "the queued send after the network returns",
      });
      const stored = (await storedMessages(alice, system().participant("alice").http, conversation.id)).filter((message) => message.body === body);
      expect(stored).toHaveLength(1);
    },
    TIMEOUT,
  );

  test(
    "lost access ends the membership within one recheck, supersedes open receipts, and refuses the next tool call",
    async () => {
      const alice = await system().startSession("alice", "claude");
      const bob = await system().startSession("bob", "codex");
      const conversation = await openConversation(alice, [bob]);
      await enterApproval(bob);
      const id = await sendRequest(alice, conversation.slug, bob.address, "Rotate the example key.");
      await waitFor(async () => (await receiptsOf(alice, id))[0]!.hold === "awaiting-approval", { what: "the held receipt" });

      system().github.setPermission("acme/app", "bob", "read", "triage");
      // One recheck period (design 3.6). The outage rule of 1 hour does not apply: GitHub answers.
      system().clock.advance(15 * MINUTE + SECOND);
      const refused = await waitFor(
        async () => {
          const result = await bob.tool("ferry_conversations", {});
          return !result.ok && result.error!.code === "no-project-access" ? result : null;
        },
        { what: "no-project-access for bob" },
      );
      expect(refused.guidance).toBeString();

      const receipt = await waitFor(async () => (await receiptsOf(alice, id)).find((candidate) => candidate.state === "superseded"), {
        what: "the superseded receipt",
      });
      expect(receipt.recipient.address).toBe(bob.address);
      const sentRequests = await alice.tool("ferry_requests", { role: "sent", state: "open" });
      const request = (sentRequests.result!.requests as Record<string, any>[]).find((message) => message.id === id)!;
      expect(request.request.assigneeAccess).toBe("lost");

      const peers = await alice.tool("ferry_peers", { conversation: conversation.slug });
      const addresses = (peers.result!.sessions as { address: string }[]).map((session) => session.address);
      expect(addresses).not.toContain(bob.address);
    },
    TIMEOUT,
  );
});
