/**
 * Layer 2 (design 15.2): the request lifecycle across sessions and workers. A claim
 * between two sessions of one owner, a stranded Codex delivery, a recipient host
 * that goes offline, and a request whose recipient never returns.
 */

import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { HOUR, SECOND } from "../harness/clock.ts";
import { suiteTitle } from "../harness/lanes.ts";
import {
  enterApproval,
  leaveApproval,
  openConversation,
  receiptsOf,
  sendRequest,
  startHumanTurn,
  systemReady,
  useSystem,
  waitFor,
  type Session,
} from "../harness/system.ts";

const TIMEOUT = 45_000;

/** The rows that wait in the fake Codex queue store for the thread of a session. */
function queuedRows(session: Session): number {
  const path = join(session.fake.hookEnv().CODEX_HOME ?? session.fake.home.codexHome, "queue_1.sqlite");
  if (!existsSync(path)) return 0;
  const db = new Database(path, { readonly: true });
  try {
    const row = db.query("SELECT count(*) AS n FROM queued_items WHERE thread_id = ?").get(session.fake.runtimeSessionId) as { n: number };
    return row.n;
  } finally {
    db.close();
  }
}

async function requestState(session: Session, id: string, role: "sent" | "assigned"): Promise<Record<string, any>> {
  const result = await session.tool("ferry_requests", { role, state: "all" });
  const message = (result.result!.requests as Record<string, any>[]).find((candidate) => candidate.id === id);
  if (message === undefined) throw new Error(`no ${role} request ${id} for ${session.address}`);
  return message.request as Record<string, any>;
}

describe.skipIf(!systemReady)(suiteTitle("request lifecycle"), () => {
  const system = useSystem();

  test(
    "a claim moves a request to another session of the owner, and the old session cannot act on it",
    async () => {
      const first = await system().startSession("alice", "claude");
      const second = await system().startSession("alice", "codex", { where: "linked" });
      const bob = await system().startSession("bob", "claude");
      const conversation = await openConversation(bob, [first, second]);

      await enterApproval(first);
      const id = await sendRequest(bob, conversation.slug, first.address, "Please finish the schema change.");
      await waitFor(async () => (await receiptsOf(bob, id))[0]!.hold === "awaiting-approval", { what: "the held receipt" });

      const claim = await second.tool("ferry_request_action", { request: id, action: "claim", expectedGeneration: 1 });
      expect(claim.ok).toBe(true);
      expect(claim.result!.message.request).toMatchObject({ generation: 2, assignee: { address: second.address } });

      const late = await first.tool("ferry_request_action", { request: id, action: "claim", expectedGeneration: 1 });
      expect(late.ok).toBe(false);
      expect(late.error!.code).toBe("generation-conflict");

      await leaveApproval(first);
      const envelope = await waitFor(() => second.envelopes().find((candidate) => candidate.id === id), { what: "the request at the claimer" });
      expect(envelope.generation).toBe(2);
      await Bun.sleep(500);
      expect(first.envelopes().map((candidate) => candidate.id)).not.toContain(id);

      const stale = await first.tool("ferry_ack", { items: [{ id, generation: 1 }] });
      expect(["stale-generation", "request-reassigned"]).toContain(stale.result!.items[0].result);
      const valid = await second.tool("ferry_ack", { items: [{ id, generation: 2 }] });
      expect(valid.result!.items[0].result).toBe("acknowledged");

      const request = await requestState(bob, id, "sent");
      expect(request.original.address).toBe(first.address);
      const claimed = (request.events as Record<string, any>[]).find((event) => event.kind === "claimed")!;
      expect(claimed).toMatchObject({ from: { address: first.address }, to: { address: second.address }, generation: 2 });
    },
    TIMEOUT,
  );

  test(
    "a stranded Codex delivery that runs after a cancel and a resume is refused at the ack",
    async () => {
      const alice = await system().startSession("alice", "claude");
      const bob = await system().startSession("bob", "codex");
      const conversation = await openConversation(alice, [bob]);
      await startHumanTurn(bob);

      const id = await sendRequest(alice, conversation.slug, bob.address, "Deploy the example service.");
      await waitFor(() => queuedRows(bob) > 0, { what: "the queue row" });
      await bob.fake.crash();
      const stranded = await waitFor(async () => (await receiptsOf(alice, id)).find((receipt) => receipt.hold === "recipient-offline"), {
        clock: system().clock,
        advanceMs: SECOND,
        what: "the stranded receipt",
      });
      expect(stranded.state).toBe("stored");

      const cancel = await alice.tool("ferry_request_action", { request: id, action: "cancel", expectedGeneration: 1, note: "Not needed any more." });
      expect(cancel.ok).toBe(true);
      expect(cancel.result!.message.request.status).toBe("cancelled");

      const resumed = await system().resumeSession(bob);
      expect(resumed.address).toBe(bob.address);
      expect(resumed.startContext).toContain(id);
      const late = await waitFor(() => resumed.envelopes().find((candidate) => candidate.id === id), { what: "the stale queue row at resume" });
      expect(late.generation).toBe(1);

      const ack = await resumed.tool("ferry_ack", { items: [{ id, generation: 1 }] });
      expect(["request-closed", "stale-generation"]).toContain(ack.result!.items[0].result);
      expect(ack.guidance).toBeString();
      const answer = await resumed.tool("ferry_send", { conversation: conversation.slug, kind: "answer", answers: id, generation: 1, body: "Deployed." });
      expect(answer.ok).toBe(false);
      expect(["request-closed", "stale-generation"]).toContain(answer.error!.code);
    },
    TIMEOUT,
  );

  test(
    "a request to a host whose worker stopped holds as worker-offline and arrives when the worker returns",
    async () => {
      const alice = await system().startSession("alice", "claude");
      const bob = await system().startSession("bob", "codex");
      const conversation = await openConversation(alice, [bob]);

      await system().stopWorker("bob");
      await waitFor(
        async () => {
          const peers = await alice.tool("ferry_peers", { conversation: conversation.slug });
          return (peers.result!.sessions as { address: string; state: string }[]).find((peer) => peer.address === bob.address && peer.state === "unknown");
        },
        { clock: system().clock, advanceMs: 10 * SECOND, what: "bob's session in state unknown" },
      );

      const id = await sendRequest(alice, conversation.slug, bob.address, "Is the example queue drained?");
      const held = await waitFor(async () => (await receiptsOf(alice, id)).find((receipt) => receipt.hold === "worker-offline"), {
        what: "the worker-offline hold",
      });
      expect(held.display).toBe("held: recipient host offline");

      await system().startWorker("bob");
      await waitFor(() => bob.envelopes().find((candidate) => candidate.id === id), {
        clock: system().clock,
        advanceMs: SECOND,
        what: "the request after the worker returns",
      });
    },
    TIMEOUT,
  );

  test(
    "a request whose recipient never returns stays open, and the sender closes it as unresolved",
    async () => {
      const alice = await system().startSession("alice", "claude");
      const bob = await system().startSession("bob", "codex");
      const conversation = await openConversation(alice, [bob]);
      await bob.fake.exit();
      await bob.hook("SessionEnd", { reason: "exit" });

      const id = await sendRequest(alice, conversation.slug, bob.address, "Can you review the example change?");
      const held = await waitFor(async () => (await receiptsOf(alice, id)).find((receipt) => receipt.hold === "recipient-offline"), {
        what: "the recipient-offline hold",
      });
      expect(held.display).toBe("held: recipient offline");

      system().clock.advance(30 * 24 * HOUR);
      const open = await requestState(alice, id, "sent");
      expect(open.status).toBe("pending");
      expect(open.ageMs).toBeGreaterThanOrEqual(30 * 24 * HOUR);

      const close = await alice.tool("ferry_request_action", {
        request: id,
        action: "close",
        expectedGeneration: 1,
        outcome: "unresolved",
        note: "The recipient did not return.",
      });
      expect(close.result!.message.request).toMatchObject({ status: "closed", outcome: "unresolved", generation: 2 });

      const history = await alice.tool("ferry_history", { conversation: conversation.slug, message: id });
      expect(history.result!.message.request.status).toBe("closed");
    },
    TIMEOUT,
  );
});
