/**
 * TEMPORARY. The part of the relay protocol (design section 7) and of the ID
 * helpers that the worker uses, until lane A merges `src/messaging/protocol.ts`
 * and `src/messaging/ids.ts`. Then the worker imports from those files, and
 * this file goes away. Do not import this file outside `src/messaging/worker`
 * and `src/messaging/adapters`.
 */

import { randomBytes } from "node:crypto";

export type Iso = string;
export type Runtime = "claude" | "codex";
export type AdapterState = "supported" | "untested" | "unconfirmed" | "unsupported";
export type Activity = "idle" | "busy" | "awaiting-approval";
export type Owner = { id: string; githubUserId: number; login: string };
export type SessionRef = { id: string; address: string; owner: Owner; runtime: Runtime };
export type SessionInfo = SessionRef & {
  state: "live" | "offline" | "unknown" | "retired";
  activity: Activity | null;
  adapter: AdapterState;
  task: string | null;
  branch: string | null;
  head: string | null;
  worktree: string | null;
  host: string;
  lastSeenAt: Iso;
  memberships?: string[];
};
export type Project = { id: string; key: string; repoId: number; access: "granted" | "unverifiable" };
export type ConversationSummary = {
  id: string;
  projectId: string;
  slug: string;
  name: string;
  purpose: string;
  links: { kind: "issue" | "branch"; ref: string }[];
  autoJoin: "none" | "all";
  participants: { live: number; total: number };
  openRequests: number;
  activeConstraints: number;
  lastMessageAt: Iso | null;
  createdAt: Iso;
};
export type MessageKind = "update" | "request" | "answer" | "constraint" | "notice";
export type RequestState = {
  status: "pending" | "delivered" | "acknowledged" | "answered" | "cancelled" | "closed";
  outcome: "resolved" | "unresolved" | "declined" | "superseded" | null;
  assignee: SessionRef;
  assigneeAccess: "granted" | "lost";
  original: SessionRef;
  generation: number;
  ageMs: number;
  answer: string | null;
  events: { kind: string; at: Iso; actor: SessionRef | null; from?: SessionRef; to?: SessionRef; generation: number }[];
};
export type Message = {
  id: string;
  conversationId: string;
  seq: number;
  kind: MessageKind;
  sender: SessionRef;
  body: string;
  truncated?: boolean;
  to: SessionRef[];
  answers: string | null;
  hop: number;
  createdAt: Iso;
  request?: RequestState;
};
export type Hold = "wake-rate" | "wake-hops" | "recipient-offline" | "worker-offline" | "awaiting-approval" | "runtime-unsupported" | "runtime-unconfirmed";
export type Receipt = {
  id: string;
  messageId: string;
  recipient: SessionRef;
  generation: number;
  state: "stored" | "delivered" | "acknowledged" | "answered" | "superseded";
  hold: Hold | null;
  display: string;
  evidence: { kind: string; at: Iso }[];
  recipientState: SessionInfo["state"];
};
export type Constraint = {
  id: string;
  conversationId: string;
  text: string;
  owner: Owner;
  responsible: SessionRef;
  sourceMessageId: string;
  state: "active" | "resolved";
  createdAt: Iso;
  ageMs: number;
  ownerAccess: "granted" | "lost";
  resolved: { at: Iso; by: SessionRef; as: "owner" | "admin"; note: string } | null;
};
export type SessionRegister = {
  runtime: Runtime;
  runtimeSessionId: string;
  runtimeVersion: string;
  adapter: AdapterState;
  repo: { key: string } | null;
  branch: string | null;
  head: string | null;
  worktree: string | null;
  task: string | null;
  source: "startup" | "resume" | "clear" | "compact" | "fork";
};
export type SessionRegistered = {
  session: SessionInfo;
  project: Project | null;
  refusal: { code: string; message: string } | null;
  autoJoined: ConversationSummary[];
  assigned: Message[];
  pendingUpdates: number;
};
export type RelayEvent =
  | { seq: number; type: "delivery.ready"; receiptId: string; sessionId: string; messageId: string; kind: MessageKind; wake: boolean }
  | { seq: number; type: "request.changed"; sessionId: string; request: string; state: RequestState }
  | { seq: number; type: "membership.changed"; sessionId: string; conversationId: string; state: "active" | "left" | "suspended" | "ended"; reason: string | null }
  | { seq: number; type: "constraint.changed"; sessionId: string; constraint: Constraint }
  | { seq: number; type: "session.access-lost"; sessionId: string; projectId: string }
  | { seq: number; type: "session.moved"; sessionId: string; toDeviceId: string }
  | { seq: number; type: "device.revoked" };
export type Events = { cursor: number; events: RelayEvent[]; resync: boolean };
export type DispatchDecision =
  | { decision: "go"; leaseUntil: Iso; envelope: string }
  | { decision: "hold"; hold: Hold }
  | { decision: "drop"; reason: string };
export type DeliveryOutcome = "delivered" | "unconfirmed" | "failed" | "stranded" | "offline";
export type EvidenceKind = "transcript" | "codex-queue-consumed" | "context-digest";
export type ErrorBody = { error: { code: string; message: string; hint: string | null; details?: Record<string, unknown> } };

const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

/** `<prefix>_<ULID>`: 10 characters of time in ms, then 16 random characters. */
export function newId(prefix: string, now = Date.now()): string {
  let time = "";
  for (let rest = now, i = 0; i < 10; i++, rest = Math.floor(rest / 32)) time = CROCKFORD[rest % 32] + time;
  const bytes = randomBytes(16);
  let random = "";
  for (const byte of bytes) random += CROCKFORD[byte % 32];
  return `${prefix}_${time}${random}`;
}

/**
 * TEMPORARY, until lane B merges `src/messaging/client/remote.ts` (design
 * section 4). The types and the signature of `findProject` are the same as
 * there, so the swap is one import. This copy has no `remotes.json` override,
 * no SSH host alias, and no `invalid-remote`: `origin` when it is a GitHub
 * URL, else the only GitHub remote.
 */
export type GitRunner = (args: readonly string[], cwd: string) => Promise<string | null>;
export type SshHostName = (alias: string) => Promise<string | null>;
export type RemoteSelection =
  | { readonly ok: true; readonly remote: string; readonly key: string }
  | { readonly ok: false; readonly code: "no-remote" | "unknown-remote" | "unsupported-host" | "invalid-remote" | "ambiguous-remote"; readonly remotes: readonly string[] };
export type CheckoutProject = { readonly root: string } & RemoteSelection;

/** Git with no optional locks and no fsmonitor, so a read writes nothing into `.git`. */
export const readOnlyGit: GitRunner = async (args, cwd) => {
  const child = Bun.spawn(["git", "-c", "core.fsmonitor=false", ...args], {
    cwd,
    env: { ...process.env, GIT_OPTIONAL_LOCKS: "0", GIT_TERMINAL_PROMPT: "0" },
    stdin: "ignore",
    stdout: "pipe",
    stderr: "ignore",
  });
  const [stdout, code] = await Promise.all([new Response(child.stdout).text(), child.exited]);
  return code === 0 ? stdout : null;
};

export async function findProject(
  cwd: string,
  options: { readonly home: string; readonly git?: GitRunner; readonly sshHostName?: SshHostName },
): Promise<CheckoutProject | null> {
  const git = options.git ?? readOnlyGit;
  const root = (await git(["rev-parse", "--show-toplevel"], cwd))?.trim();
  if (!root) return null;
  const github = (url: string): string | null => {
    const match = /^(?:https?:\/\/(?:[^@/]+@)?|ssh:\/\/(?:[^@/]+@)?|git:\/\/|[^@/]+@)(?:ssh\.)?github\.com(?::443)?[:/]([^/]+)\/([^/]+?)(?:\.git)?\/*$/i.exec(url.trim());
    return match ? `github.com/${match[1]!.toLowerCase()}/${match[2]!.toLowerCase()}` : null;
  };
  const names = ((await git(["remote"], root)) ?? "").split("\n").filter((name) => name !== "");
  if (names.length === 0) return { root, ok: false, code: "no-remote", remotes: names };
  const keys = new Map<string, string>();
  for (const name of names) {
    const key = github((await git(["remote", "get-url", name], root)) ?? "");
    if (key) keys.set(name, key);
  }
  const origin = keys.get("origin");
  if (origin) return { root, ok: true, remote: "origin", key: origin };
  if (keys.size === 1) {
    const [remote, key] = [...keys][0]!;
    return { root, ok: true, remote, key };
  }
  return { root, ok: false, code: keys.size === 0 ? "unsupported-host" : "ambiguous-remote", remotes: names };
}
