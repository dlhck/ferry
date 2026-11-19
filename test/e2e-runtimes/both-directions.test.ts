/**
 * Layer 3 (design 15.3 and 16): a request and its correlated answer between real
 * Claude Code and Codex sessions, in both directions, with the recipient idle and
 * busy. The answer route is the relay. The suite reads no transcript for it.
 */

import { afterAll, beforeAll, describe, expect } from "bun:test";
import { e2eTitle, ready, requestOutcome, startE2E, waitFor, type E2E, type RealSession } from "./harness.ts";
import { caseTest, writeRuntimeTable } from "./results.ts";

describe.skipIf(!ready)(e2eTitle("real runtimes: both directions"), () => {
  let e2e: E2E;
  let claude: RealSession;
  let codex: RealSession;
  let conversation: string;

  beforeAll(async () => {
    e2e = await startE2E();
    // Busy turns run `sleep`. Claude gets the narrowest allow rule for it, as a CLI option.
    claude = await e2e.launch("alice", "claude", { allowedTools: "Bash(sleep:*)" });
    codex = await e2e.launch("bob", "codex");
    const created = await claude.tool("ferry_create_conversation", { name: "Runtime check", purpose: "The real-CLI suite of Ferry messaging." });
    conversation = created.result!.conversation.slug as string;
    await codex.tool("ferry_membership", { conversation, action: "join" });
  }, 300_000);

  afterAll(async () => {
    e2e?.stack.expectCheckoutsUnchanged();
    await e2e?.stop();
    writeRuntimeTable();
  }, 60_000);

  async function exchange(sender: RealSession, recipient: RealSession, busy: boolean): Promise<void> {
    await waitFor(async () => (await recipient.peer())?.activity === "idle", { timeoutMs: 120_000, what: "an idle recipient" });
    if (busy) {
      await recipient.type("Run the shell command `sleep 45`, then reply with the word done.");
      await waitFor(async () => (await recipient.peer())?.activity === "busy", { timeoutMs: 60_000, what: "a busy recipient" });
    }
    const sent = await sender.tool("ferry_send", {
      conversation,
      kind: "request",
      to: recipient.address,
      body: "What is the name of the default branch of this repository? Answer through Ferry.",
    });
    expect(sent.ok).toBe(true);
    const id = sent.result!.message.id as string;

    const outcome = await waitFor(
      async () => {
        const result = await requestOutcome(e2e, sender, id);
        return result.answer !== null ? result : null;
      },
      { timeoutMs: 300_000, what: `the answer to ${id}` },
    );
    expect(outcome.request.message.request?.status).toBe("answered");
    expect(outcome.answer!.message.answers).toBe(id);
    expect(outcome.answer!.message.body).toContain(e2e.marker);
    // The answer woke the sender: its receipt has evidence from the sender's runtime.
    await waitFor(
      async () => {
        const again = await requestOutcome(e2e, sender, id);
        return again.answer?.receipts.some((receipt) => receipt.state !== "stored");
      },
      { timeoutMs: 120_000, what: "the answer at the sender" },
    );
  }

  caseTest("Claude to idle Codex", ["claude", "codex"], () => e2e, () => exchange(claude, codex, false));
  caseTest("Codex to idle Claude", ["claude", "codex"], () => e2e, () => exchange(codex, claude, false));
  caseTest("Claude to busy Codex", ["claude", "codex"], () => e2e, () => exchange(claude, codex, true));
  caseTest("Codex to busy Claude", ["claude", "codex"], () => e2e, () => exchange(codex, claude, true));
});
