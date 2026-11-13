/**
 * Layer 3 (design 16): a plain launch registers, gets the skill context, and joins
 * the conversation that its branch links to, with no instruction from the human.
 *
 * In CLI-option mode this proves the hooks and the context, not the global install
 * of `ferry messaging setup`. The global install is part of the operator-run box
 * check in docs/agent-messaging-runtimes.md.
 */

import { afterAll, beforeAll, describe, expect } from "bun:test";
import { e2eTitle, ready, requestOutcome, startE2E, waitFor, type E2E } from "./harness.ts";
import { caseTest, writeRuntimeTable } from "./results.ts";

describe.skipIf(!ready)(e2eTitle("real runtimes: normal launch"), () => {
  let e2e: E2E;

  beforeAll(async () => {
    e2e = await startE2E();
  }, 120_000);

  afterAll(async () => {
    e2e?.stack.expectCheckoutsUnchanged();
    await e2e?.stop();
    writeRuntimeTable();
  }, 60_000);

  for (const runtime of ["claude", "codex"] as const) {
    caseTest(`${runtime} on an issue branch joins the linked conversation and reads the skill`, [runtime], () => e2e, async () => {
      const creator = await e2e.launch("alice", runtime === "claude" ? "codex" : "claude");
      const created = await creator.tool("ferry_create_conversation", {
        name: `Key authority ${runtime}`,
        purpose: "The key authority work of CLO-1442.",
        issue: "CLO-1442",
        force: true,
      });
      const conversation = created.result!.conversation as { id: string; slug: string };

      // The linked worktree is on feat/clo-1442-example.
      const session = await e2e.launch("bob", runtime, { where: "linked" });
      const whoami = await session.tool("ferry_whoami");
      expect(whoami.result!.session.memberships).toContain(conversation.id);

      const sent = await creator.tool("ferry_send", {
        conversation: conversation.slug,
        kind: "request",
        to: session.address,
        body: "Which branch is your worktree on? Answer through Ferry.",
      });
      const id = sent.result!.message.id as string;
      const outcome = await waitFor(
        async () => {
          const result = await requestOutcome(e2e, creator, id);
          return result.answer !== null ? result : null;
        },
        { timeoutMs: 300_000, what: "the answer" },
      );
      // The marker is only in the skill file, so the answer proves that the model read it.
      expect(outcome.answer!.message.body).toContain(e2e.marker);
    });
  }
});
