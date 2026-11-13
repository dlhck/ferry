/**
 * The Claude Code adapter (design section 9.2). It writes into the inbox
 * socket of the session (`CLAUDE_CODE_MESSAGING_SOCKET`), with the
 * documented auth line first. Claude Code reads the message between tool
 * calls in a busy session, and starts a turn in an idle one.
 *
 * Risk R1: the message frame is not documented. Ferry writes the frame that a
 * native `SendMessage` writes, captured on 2.1.322. `claudeFrame` is the only
 * place that knows it, so a change of the frame in a Claude Code release is
 * one edit there. The version gate here, and the frame check of the worker,
 * stop delivery to a version whose frame does not work.
 */

import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { createConnection } from "node:net";
import { alive, systemProcesses, type ProcessTable } from "../worker/registry.ts";
import { transcriptHas } from "./transcript.ts";
import { gate, type Adapter } from "./types.ts";

/** The first version with the inbox socket and the frame below that Ferry tested. */
export const CLAUDE_MINIMUM = "2.1.323";
/** The versions that passed the real-CLI suite. Lane E's suite keeps `docs/agent-messaging-runtimes.md` and this list the same. */
export const CLAUDE_PASSED: readonly string[] = ["2.1.323"];

const INJECT_TIMEOUT_MS = 5000;

/**
 * The frame for the inbox socket, as one JSON line. Not documented (R1).
 * `from-mode="prompting"` is the true permission class of the worker: it
 * never bypasses a prompt.
 */
export function claudeFrame(envelope: string, workerSocket: string, msgId: string = randomUUID()): string {
  const from = `uds:${workerSocket}`;
  const content = `<cross-session-message from="${from}" from-name="ferry" from-mode="prompting">\n${envelope}\n</cross-session-message>`;
  return JSON.stringify({ msgV: 1, msg_id: msgId, type: "user", message: { role: "user", content }, priority: "next", from });
}

/** The documented auth line. */
function authLine(token: string): string {
  return JSON.stringify({ type: "auth", token });
}

export type ClaudeAdapterInput = {
  /** The worker socket path. The frame names it as the sender. */
  readonly workerSocket: string;
  readonly processes?: ProcessTable;
};

export function createClaudeAdapter(input: ClaudeAdapterInput): Adapter {
  const processes = input.processes ?? systemProcesses;
  return {
    runtime: "claude",
    version(output) {
      return /^(\d+\.\d+\.\d+) \(Claude Code\)/m.exec(output.trim())?.[1] ?? null;
    },
    async check(session) {
      const result = gate("Claude Code", session.runtimeVersion, CLAUDE_MINIMUM, CLAUDE_PASSED);
      if (result.adapter === "unsupported") return result;
      if (!session.claudeSocket || !session.claudeToken) return { adapter: "unsupported", reason: "The session has no Claude Code messaging socket." };
      return result;
    },
    async live(session) {
      return alive(session.runtimePid, session.runtimePidStart, processes) && session.claudeSocket !== null && existsSync(session.claudeSocket);
    },
    async inject(session, envelope) {
      const socket = session.claudeSocket;
      const token = session.claudeToken;
      if (!socket || !token) return { ok: false, error: "The session has no Claude Code messaging socket." };
      const text = `${authLine(token)}\n${claudeFrame(envelope, input.workerSocket)}\n`;
      return await new Promise((resolve) => {
        const connection = createConnection({ path: socket });
        const timer = setTimeout(() => {
          connection.destroy();
          resolve({ ok: false, error: "The Claude Code messaging socket did not take the message in 5 seconds." });
        }, INJECT_TIMEOUT_MS);
        connection.on("error", (error: NodeJS.ErrnoException) => {
          clearTimeout(timer);
          resolve({ ok: false, error: `The Claude Code messaging socket refused the connection (${error.code ?? "error"}).` });
        });
        connection.on("connect", () => {
          connection.end(text, () => {
            clearTimeout(timer);
            resolve({ ok: true, runtimeRef: null });
          });
        });
      });
    },
    async confirm(session, attempt) {
      return transcriptHas(session.transcriptPath, attempt.transcriptOffset ?? 0, attempt.messageId)
        ? { state: "delivered", evidence: "transcript" }
        : { state: "pending" };
    },
  };
}
