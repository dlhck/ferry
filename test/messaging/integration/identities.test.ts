/**
 * Layer 4 on one host (design 15.4): separate `HOME` directories, each enrolled as
 * another fake GitHub user against one relay. This covers identity separation,
 * cross-owner requests, and the access rules. It does not cover the real GitHub API,
 * the real device flow, or two hosts. Those are operator-run checks
 * (docs/agent-messaging-runtimes.md).
 */

import { describe, expect, test } from "bun:test";
import { ALICE, BOB, type TestIdentity } from "../harness/homes.ts";
import { suiteTitle } from "../harness/lanes.ts";
import { openConversation, receiptsOf, sendRequest, systemReady, useSystem, waitFor } from "../harness/system.ts";

const TIMEOUT = 30_000;
const CAROL: TestIdentity = { login: "carol", githubUserId: 1003, deviceName: "carol-box" };

describe.skipIf(!systemReady)(suiteTitle("two identities on one host"), () => {
  const system = useSystem({ identities: [ALICE, BOB, { ...CAROL, permission: "read" }] });

  test(
    "each home is its own owner, by the numeric GitHub user id",
    async () => {
      const owners = [];
      for (const login of ["alice", "bob", "carol"]) {
        const me = await system().participant(login).http.get<{ owner: { githubUserId: number; login: string } }>("/v1/me");
        expect(me.status).toBe(200);
        owners.push(me.body.owner);
      }
      expect(owners).toEqual([
        expect.objectContaining({ githubUserId: 1001, login: "alice" }),
        expect.objectContaining({ githubUserId: 1002, login: "bob" }),
        expect.objectContaining({ githubUserId: 1003, login: "carol" }),
      ]);
    },
    TIMEOUT,
  );

  test(
    "read permission does not qualify: the session does not participate",
    async () => {
      const carol = await system().startSession("carol", "claude");
      expect(carol.startContext.trim().split("\n")).toHaveLength(1);
      const result = await carol.tool("ferry_conversations", {});
      expect(result.ok).toBe(false);
      expect(result.error!.code).toBe("not-participating");

      const project = await system().participant("carol").http.get<{ error: { code: string } }>("/v1/projects?key=github.com/acme/app");
      expect(project.status).toBe(403);
      expect(project.body.error.code).toBe("no-project-access");
    },
    TIMEOUT,
  );

  test(
    "a request to an owner login with two live sessions fails with the candidates",
    async () => {
      const alice = await system().startSession("alice", "claude");
      const bobClaude = await system().startSession("bob", "claude");
      const bobCodex = await system().startSession("bob", "codex", { where: "linked" });
      const conversation = await openConversation(alice, [bobClaude, bobCodex]);

      const ambiguous = await alice.tool("ferry_send", { conversation: conversation.slug, kind: "request", to: "bob", body: "Who owns the example job?" });
      expect(ambiguous.ok).toBe(false);
      expect(ambiguous.error!.code).toBe("ambiguous-recipient");

      await bobCodex.fake.exit();
      await bobCodex.hook("SessionEnd", { reason: "exit" });
      const id = await sendRequest(alice, conversation.slug, "bob", "Who owns the example job?");
      await waitFor(() => bobClaude.envelopes().find((envelope) => envelope.id === id), { what: "the request at the one live session" });
    },
    TIMEOUT,
  );

  test(
    "another owner cannot claim a request, and the sender can reassign it",
    async () => {
      const aliceFirst = await system().startSession("alice", "claude");
      const aliceSecond = await system().startSession("alice", "codex", { where: "linked" });
      const bob = await system().startSession("bob", "codex");
      const conversation = await openConversation(bob, [aliceFirst, aliceSecond]);
      const id = await sendRequest(bob, conversation.slug, aliceFirst.address, "Please run the example migration.");

      const bobOther = await system().startSession("bob", "claude", { where: "linked" });
      const claim = await bobOther.tool("ferry_request_action", { request: id, action: "claim", expectedGeneration: 1 });
      expect(claim.ok).toBe(false);
      expect(claim.error!.code).toBe("forbidden");

      const reassign = await bob.tool("ferry_request_action", { request: id, action: "reassign", expectedGeneration: 1, to: aliceSecond.address });
      expect(reassign.ok).toBe(true);
      expect(reassign.result!.message.request).toMatchObject({ generation: 2, assignee: { address: aliceSecond.address } });
      await waitFor(() => aliceSecond.envelopes().find((envelope) => envelope.id === id && envelope.generation === 2), {
        what: "the reassigned request",
      });
      const receipts = await receiptsOf(bob, id);
      expect(receipts.find((receipt) => receipt.recipient.address === aliceFirst.address && receipt.generation === 1)?.state).toBe("superseded");
    },
    TIMEOUT,
  );
});
