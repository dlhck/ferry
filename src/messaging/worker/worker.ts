/**
 * The messaging worker: `ferry messaging worker` (design sections 8 and 9).
 *
 * One worker runs for each OS user on each agent host. It is the only process
 * with the device credential. It:
 *
 * - answers the hooks and the MCP server on the worker socket,
 * - registers each Claude Code and Codex session with the relay,
 * - sends each mutating call through the outbox,
 * - gets the relay events with a long poll, and delivers each wake message
 *   into its session through the adapter of the runtime, after a `go` from
 *   the relay,
 * - confirms each delivery with evidence, and reports the result,
 * - keeps the turn origin of each session for the hop limit, and the digest
 *   of updates for the next prompt.
 *
 * The worker never starts a runtime, and never changes a permission mode or
 * an approval policy. A stopped session stays stopped.
 *
 * Logs have ids, states, and codes. They never have a message body, a token,
 * or a credential.
 */

import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, readlinkSync, statSync } from "node:fs";
import type { Server } from "node:net";
import { basename, join } from "node:path";
import { holdsToken } from "../../manifest.ts";
import { VERSION } from "../../version.ts";
import { createClaudeAdapter } from "../adapters/claude.ts";
import { createCodexAdapter } from "../adapters/codex.ts";
import { transcriptSize } from "../adapters/transcript.ts";
import type { Adapter, Check } from "../adapters/types.ts";
import { addCause, buildDigest, MAX_CAUSES, OFFLINE_CONTEXT, peerMessageIds, refusalContext, sessionStartContext, type DigestItem, type StrandedItem } from "./digest.ts";
import { Outbox, type Method, type RelayAnswer, type RelayTransport, type Submitted } from "./outbox.ts";
import { newId } from "../ids.ts";
import type {
  Activity,
  ConversationSummary,
  DeliveryResult,
  DispatchDecision,
  Events,
  Message,
  Receipt,
  RelayEvent,
  Runtime,
  SessionRegister,
  SessionRegistered,
} from "../protocol.ts";
import { findProject, readOnlyGit, type GitRunner, type RemoteSelection } from "../client/remote.ts";
import { findRuntime, runtimeNames, runtimePrograms, systemProcesses, type ProcessTable } from "./registry.ts";
import { listenSocket, replaySpool, workerSocketPath, type Caller, type LocalRequest, type LocalResponse } from "./socket.ts";
import { WorkerStore, type StoredAttempt, type StoredSession } from "./store.ts";

type EvidenceKind = NonNullable<DeliveryResult["evidence"]>["kind"];

export type Clock = { now(): number };

/** The repository of a working directory, for the project of a session (design section 4). */
export type RepoInfo = {
  readonly root: string;
  readonly key: string | null;
  readonly refusal: { readonly code: string; readonly message: string } | null;
  readonly branch: string | null;
  readonly head: string | null;
  readonly worktree: string;
};

export type WorkerInput = {
  /** The home directory. The worker state is in `<home>/.ferry/messaging`. */
  readonly home: string;
  readonly client: RelayTransport;
  readonly adapters: readonly Adapter[];
  readonly clock: Clock;
  readonly processes?: ProcessTable;
  /** The repository of a directory. Null outside a repository. */
  readonly resolveRepo?: (cwd: string) => Promise<RepoInfo | null>;
  /** The output of `<program> --version`, or null when the program fails. */
  readonly runVersion?: (program: string) => string | null;
  readonly log?: (line: string) => void;
  /** The interval of the delivery timer. 0 turns the timers and the event poll off, and a test calls `tick` and `pollOnce`. Default 1000. */
  readonly tickMs?: number;
};

export type WorkerStatus = {
  readonly pid: number;
  readonly version: string;
  readonly startedAt: string;
  readonly revoked: boolean;
  readonly relay: { readonly reachable: boolean; readonly lastContactAt: string | null; readonly lastError: string | null };
  readonly sessions: readonly {
    readonly runtime: Runtime;
    readonly runtimeSessionId: string;
    readonly runtimeVersion: string;
    readonly address: string | null;
    readonly project: string | null;
    readonly state: "live" | "offline";
    readonly activity: Activity | null;
    readonly adapter: string;
    readonly adapterReason: string | null;
    readonly refusal: string | null;
  }[];
  readonly outbox: { readonly pending: number; readonly failed: readonly { key: string; method: string; path: string; createdAt: string; lastError: string | null }[] };
  readonly deliveries: { readonly held: number; readonly unconfirmed: number; readonly stranded: number; readonly failed: number };
  /** Live Codex processes in a participating repository with no registration: Codex has not trusted the Ferry hooks. Linux only. */
  readonly unregisteredCodex: readonly { readonly pid: number; readonly worktree: string }[];
};

export type RunningWorker = {
  readonly socketPath: string;
  readonly store: WorkerStore;
  handle(request: LocalRequest): Promise<LocalResponse>;
  /** One run of the delivery timer: outbox, confirmations, retries, re-injections, and every 30 seconds liveness and heartbeat. */
  tick(): Promise<void>;
  /** One long poll of the relay events. */
  pollOnce(waitMs?: number): Promise<void>;
  status(): Promise<WorkerStatus>;
  stop(): Promise<void>;
};

const TOOL_WAIT_MS = 5000;
const HOOK_BUDGET_MS = 1300;
const CONFIRM_MS = 60_000;
const WATCH_MS = 24 * 60 * 60 * 1000;
const REINJECT_AFTER_MS = 120_000;
const MAX_ATTEMPTS = 2;
const HEARTBEAT_MS = 30_000;
const POLL_WAIT_MS = 25_000;
const DISPATCH_RETRY_MS = 5000;
const FRAME_CHECK_STREAK = 3;
const MAX_BODY_BYTES = 16_384;
const WAKE_KINDS = new Set(["request", "answer", "notice"]);
const SOURCES = new Set(["startup", "resume", "clear", "compact", "fork"]);

/** The adapters of a real host. */
export function defaultAdapters(home: string, clock: Clock): Adapter[] {
  return [createClaudeAdapter({ workerSocket: workerSocketPath(home) }), createCodexAdapter({ now: () => clock.now() })];
}

/** The skill path that the `SessionStart` context names (design section 11.5). */
export function messagingSkillPath(home: string): string {
  return join(home, ".agents", "skills", "ferry-messaging", "SKILL.md");
}

/** The text of each remote selection refusal (design section 4.1). */
function remoteRefusal(code: Extract<RemoteSelection, { ok: false }>["code"], remotes: readonly string[]): string {
  switch (code) {
    case "no-remote":
      return "The checkout has no remote.";
    case "unknown-remote":
      return "The remote that ferry messaging remote set selected for this checkout does not exist. Ask your user to run ferry messaging remote set <name> or ferry messaging remote clear in it.";
    case "unsupported-host":
      return "The checkout has no GitHub.com remote.";
    case "invalid-remote":
      return "The URL of the selected remote is not a GitHub repository URL.";
    case "ambiguous-remote":
      return `The checkout has more than one GitHub remote (${remotes.join(", ")}). Ask your user to run ferry messaging remote set <name> in it.`;
  }
}

/** The repository of a directory with read-only Git commands. */
export async function gitRepo(cwd: string, home: string, git: GitRunner = readOnlyGit): Promise<RepoInfo | null> {
  if (!existsSync(cwd)) return null;
  const project = await findProject(cwd, { home, git });
  if (!project) return null;
  const { root } = project;
  const head = (await git(["rev-parse", "--verify", "-q", "HEAD"], root))?.trim();
  return {
    root,
    key: project.ok ? project.key : null,
    refusal: project.ok ? null : { code: project.code, message: remoteRefusal(project.code, project.remotes) },
    branch: (await git(["symbolic-ref", "--short", "-q", "HEAD"], root))?.trim() || null,
    head: head && /^[0-9a-f]{40}$/.test(head) ? head : null,
    worktree: basename(root).slice(0, 128),
  };
}

function defaultRunVersion(program: string): string | null {
  const result = spawnSync(program, ["--version"], { encoding: "utf8", timeout: 5000, stdio: ["ignore", "pipe", "ignore"] });
  return result.status === 0 ? result.stdout : null;
}

const GUIDANCE: Record<string, string> = {
  "relay-offline": "The relay is not reachable now. Continue your own work and try again later.",
  "not-participating": "This session does not take part in messaging. Do not use the other ferry_* tools in it.",
  "stale-generation": "This request was reassigned or closed. Do not act on it.",
  "request-reassigned": "This request moved to another session. Do not act on it.",
  "request-closed": "This request is closed. Do not act on it.",
  "already-acknowledged": "You already acknowledged this message. Do not act on it again.",
  "not-recipient": "This message is not for this session. Do not act on it.",
  "not-assignee": "This session is not the assignee of the request. Do not answer it.",
  "ambiguous-recipient": "Pick one session from error.details.candidates, and send again with its address in to.",
  "conversation-exists": "Join the conversation in error.details.conversation with ferry_membership.",
  "conversation-similar": "Read error.details.candidates. Join one of them, or create again with force true when none fits.",
  "generation-conflict": "Another session changed this request first. Read error.details, and do not repeat the action without a new check.",
  "in-progress": "The assignee works on this request now. Claim it with takeover true only when your user asks for it.",
  "secret-in-message": "Remove the token from the text, and send again.",
  "no-project-access": "This session has no access to the project now. Stop messaging in it and tell your user.",
  "access-unverifiable": "The relay cannot check your access to the project now. Try again later.",
  "not-found": "Check the id or the slug with ferry_conversations or ferry_requests.",
  "not-member": "Join the conversation with ferry_membership first.",
  "rate-limited": "Wait some minutes before the next call.",
  "limit-reached": "The conversation is at a limit. Resolve or remove something first, or tell your user.",
  "too-large": "Make the text shorter. The limit is 16,384 bytes.",
  "invalid-request": "Check the arguments of the tool, and call it again.",
  "device-revoked": "The credential of this host was revoked. Tell your user.",
  "upgrade-required": "This Ferry version is too old for the relay. Tell your user to update Ferry.",
};

const DEFAULT_GUIDANCE = "Read the error, and do not repeat the call without a change.";

type ToolResult =
  | { ok: true; result: unknown; guidance: string }
  | { ok: false; error: { code: string; message: string; details?: Record<string, unknown> }; guidance: string };

function success(result: unknown, guidance: string): ToolResult {
  return { ok: true, result, guidance };
}

function failure(code: string, message: string, details?: Record<string, unknown>): ToolResult {
  return { ok: false, error: details ? { code, message, details } : { code, message }, guidance: GUIDANCE[code] ?? DEFAULT_GUIDANCE };
}

/** A tool result from a relay answer. */
function fromAnswer(answer: RelayAnswer, guidance: string): ToolResult {
  if (answer.status < 300) return success(answer.body, guidance);
  const error = (answer.body as { error?: { code?: string; message?: string; hint?: string | null; details?: Record<string, unknown> } } | null)?.error;
  const code = error?.code ?? "unavailable";
  const result = failure(code, error?.message ?? `The relay answered with HTTP ${answer.status}.`, error?.details);
  if (!GUIDANCE[code] && error?.hint) result.guidance = error.hint;
  return result;
}

const QUEUED_GUIDANCE = "The relay is offline. Ferry keeps this call and sends it when the relay is back. It is not stored on the relay yet. Check it later with ferry_receipts.";

function str(value: unknown): string | null {
  return typeof value === "string" && value !== "" ? value : null;
}

function query(params: Record<string, string | number | undefined | null>): string {
  const entries = Object.entries(params).filter((entry): entry is [string, string | number] => entry[1] !== undefined && entry[1] !== null && entry[1] !== "");
  return entries.length === 0 ? "" : `?${new URLSearchParams(entries.map(([key, value]): [string, string] => [key, String(value)])).toString()}`;
}

const id = encodeURIComponent;

export async function runWorker(input: WorkerInput): Promise<RunningWorker> {
  const { home, clock } = input;
  const processes = input.processes ?? systemProcesses;
  const resolveRepo = input.resolveRepo ?? ((cwd: string) => gitRepo(cwd, home));
  const runVersion = input.runVersion ?? defaultRunVersion;
  const log = input.log ?? (() => {});
  const tickMs = input.tickMs ?? 1000;
  const names = runtimeNames();
  const dir = join(home, ".ferry", "messaging");
  const store = new WorkerStore(join(dir, "worker.sqlite"));
  const socketPath = workerSocketPath(home);
  const startedAt = new Date(clock.now()).toISOString();
  const iso = (ms = clock.now()) => new Date(ms).toISOString();
  const adapters = new Map(input.adapters.map((adapter) => [adapter.runtime, adapter]));

  let revoked = false;
  let stopped = false;
  let lastContactAt: string | null = null;
  let lastError: string | null = null;
  let reachable = false;
  let lastPeriodic = 0;
  const versions = new Map<string, { mtimeMs: number; output: string | null }>();
  const slugs = new Map<string, string>(); // conversation id -> slug
  const conversationProjects = new Map<string, string>(); // conversation id -> project id
  const inFlight = new Set<string>(); // receipt ids
  const waitingReady = new Map<string, Extract<RelayEvent, { type: "delivery.ready" }>>();
  const pollAbort = new AbortController();

  // The relay transport, with the reachability that `status` reports.
  const client: RelayTransport = {
    async request(call) {
      try {
        const answer = await input.client.request(call);
        reachable = true;
        lastContactAt = iso();
        lastError = null;
        if (answer.status === 401 && (answer.body as { error?: { code?: string } } | null)?.error?.code === "device-revoked") revoked = true;
        return answer;
      } catch (error) {
        reachable = false;
        lastError = error instanceof Error ? error.name : "error";
        throw error;
      }
    },
  };

  const outbox = new Outbox({ store, transport: client, clock, log, onAnswer: (entry, answer) => onAnswer(entry.method, entry.path, JSON.parse(entry.body), answer) });

  // ---------------------------------------------------------------------------
  // Relay answers that change the local state, also for a call that the outbox sent later.

  function onAnswer(method: string, path: string, body: Record<string, unknown>, answer: RelayAnswer): void {
    if (answer.status >= 300) return;
    if (method === "POST" && path === "/v1/sessions") {
      applyRegistration(body as unknown as SessionRegister, answer.body as SessionRegistered);
      return;
    }
    const sessionId = str(body.sessionId);
    if (path === "/v1/messages/ack" && sessionId) {
      for (const item of (answer.body as { items?: { id: string; result: string }[] }).items ?? []) {
        if (item.result === "acknowledged" || item.result === "already-acknowledged") store.addAck(sessionId, item.id, iso());
      }
      return;
    }
    if (/^\/v1\/conversations\/[^/]+\/messages$/.test(path) && body.kind === "answer" && sessionId && typeof body.answers === "string") {
      store.addAck(sessionId, body.answers, iso());
    }
    if (method === "POST" && /^\/v1\/projects\/[^/]+\/conversations$/.test(path)) {
      const conversation = (answer.body as { conversation?: ConversationSummary }).conversation;
      if (conversation) {
        slugs.set(conversation.id, conversation.slug);
        conversationProjects.set(conversation.id, conversation.projectId);
      }
    }
  }

  function applyRegistration(body: SessionRegister, registered: SessionRegistered): void {
    const session = store.session(body.runtime, body.runtimeSessionId);
    if (!session) return;
    store.updateSession(body.runtime, body.runtimeSessionId, {
      relaySessionId: registered.session.id,
      address: registered.session.address,
      ownerLogin: registered.session.owner.login,
      projectId: registered.project?.id ?? null,
      projectKey: registered.project?.key ?? session.projectKey,
      refusal: registered.refusal ? { code: registered.refusal.code, message: registered.refusal.message } : null,
    });
    for (const conversation of registered.autoJoined) {
      slugs.set(conversation.id, conversation.slug);
      conversationProjects.set(conversation.id, conversation.projectId);
    }
  }

  // ---------------------------------------------------------------------------
  // Sessions

  function adapterOf(runtime: Runtime): Adapter | null {
    return adapters.get(runtime) ?? null;
  }

  function cachedVersion(program: string): string | null {
    let mtimeMs = 0;
    try {
      mtimeMs = statSync(program).mtimeMs;
    } catch {
      return null;
    }
    const known = versions.get(program);
    if (known?.mtimeMs === mtimeMs) return known.output;
    const output = runVersion(program);
    versions.set(program, { mtimeMs, output });
    return output;
  }

  /** The program of the runtime process and its version: the first candidate whose `--version` output is of this runtime. */
  function runtimeProgram(pid: number, adapter: Adapter): { exe: string; version: string } | null {
    for (const program of runtimePrograms(pid, adapter.runtime, processes)) {
      const output = cachedVersion(program);
      const version = output ? adapter.version(output) : null;
      if (version) return { exe: program, version };
    }
    return null;
  }

  /** The adapter check, with the mark of the frame check. */
  async function check(session: StoredSession): Promise<Check> {
    const adapter = adapterOf(session.runtime);
    if (!adapter) return { adapter: "unsupported", reason: `This worker has no adapter for ${session.runtime}.` };
    const result = await adapter.check(session);
    if (result.adapter !== "unsupported" && store.isUnconfirmed(session.runtime, session.runtimeVersion, VERSION)) {
      return { adapter: "unconfirmed", reason: `${session.runtime} ${session.runtimeVersion} did not confirm ${FRAME_CHECK_STREAK} deliveries in a row on idle sessions.` };
    }
    return result;
  }

  /** The current session of the runtime process of a caller. */
  function sessionOf(caller: unknown, runtimeSessionId: string | null = null): StoredSession | null {
    const ancestors = (caller as Caller | null)?.ancestors;
    const found = Array.isArray(ancestors) ? findRuntime(ancestors, processes, names) : null;
    if (found) {
      const sessions = store.sessionsOfProcess(found.pid, found.start);
      return sessions.find((session) => session.runtimeSessionId === runtimeSessionId) ?? sessions[0] ?? null;
    }
    return null;
  }

  function endSession(session: StoredSession, reason: "exit" | "crash" | "replaced"): void {
    store.updateSession(session.runtime, session.runtimeSessionId, { state: "offline", activity: null, endedAt: iso() });
    if (session.relaySessionId) {
      outbox.enqueue({ method: "POST", path: `/v1/sessions/${id(session.relaySessionId)}/end`, body: { reason }, sessionId: session.relaySessionId });
      void outbox.flush();
    }
    log(`Session ${session.runtime} ${session.relaySessionId ?? session.runtimeSessionId} ended: ${reason}.`);
  }

  async function setActivity(session: StoredSession, activity: Activity, change: Parameters<WorkerStore["updateSession"]>[2] = {}): Promise<void> {
    const approval = session.activity === "awaiting-approval" || activity === "awaiting-approval";
    store.updateSession(session.runtime, session.runtimeSessionId, { ...change, activity });
    // The relay holds a delivery while a session waits for approval. It learns of the end at once, not at the next heartbeat.
    if (approval && session.activity !== activity) void heartbeat();
  }

  // ---------------------------------------------------------------------------
  // Hooks

  async function hookSessionStart(params: Record<string, unknown>): Promise<{ additionalContext: string }> {
    const started = Date.now();
    const runtime = params.runtime as Runtime;
    const event = (params.event ?? {}) as Record<string, unknown>;
    const env = (params.env ?? {}) as Record<string, unknown>;
    const ancestors = (params.caller as Caller | null)?.ancestors;
    const found = Array.isArray(ancestors) ? findRuntime(ancestors, processes, names) : null;
    const runtimeSessionId = str(event.session_id);
    const adapter = adapterOf(runtime);
    if (!found || found.runtime !== runtime || !runtimeSessionId || !adapter) return { additionalContext: "" };
    // `/clear` and `/new` give a new session in the same process. The old one is replaced.
    for (const old of store.sessionsOfProcess(found.pid, found.start)) if (old.runtimeSessionId !== runtimeSessionId) endSession(old, "replaced");

    const cwd = str(event.cwd) ?? "";
    const repo = cwd ? await resolveRepo(cwd) : null;
    const program = runtimeProgram(found.pid, adapter);
    const existing = store.session(runtime, runtimeSessionId);
    const source = SOURCES.has(String(event.source)) ? (event.source as SessionRegister["source"]) : "startup";
    const base: StoredSession = {
      runtime,
      runtimeSessionId,
      runtimeVersion: program?.version ?? "unknown",
      runtimeExe: program?.exe ?? "",
      runtimePid: found.pid,
      runtimePidStart: found.start,
      relaySessionId: existing?.relaySessionId ?? null,
      transcriptPath: str(event.transcript_path),
      claudeSocket: runtime === "claude" ? str(env.messagingSocket) : null,
      claudeToken: runtime === "claude" ? str(env.messagingToken) : null,
      codexHome: runtime === "codex" ? (str(env.codexHome) ?? join(home, ".codex")) : null,
      state: "live",
      activity: "idle",
      turnOrigin: "human",
      turnCauses: [],
      turnEndedAt: null,
      registeredAt: iso(),
      endedAt: null,
      address: existing?.address ?? null,
      ownerLogin: existing?.ownerLogin ?? null,
      projectId: existing?.projectId ?? null,
      projectKey: repo?.key ?? null,
      refusal: repo ? repo.refusal : { code: "no-repository", message: "The working directory is not in a Git repository." },
      adapter: "unsupported",
      adapterReason: null,
    };
    const checked = await check(base);
    store.insertSession({ ...base, adapter: checked.adapter, adapterReason: checked.reason });
    if (!repo) return { additionalContext: "" };
    if (repo.refusal || !repo.key) return { additionalContext: refusalContext(repo.refusal?.message ?? "The checkout has no GitHub remote.") };

    const body: SessionRegister = {
      runtime,
      runtimeSessionId,
      runtimeVersion: base.runtimeVersion,
      adapter: checked.adapter,
      repo: { key: repo.key },
      branch: repo.branch,
      head: repo.head,
      worktree: repo.worktree,
      task: null,
      source,
    };
    const submitted = await outbox.submit({ method: "POST", path: "/v1/sessions", body, sessionId: null }, Math.max(0, HOOK_BUDGET_MS - (Date.now() - started)));
    if (submitted.state === "queued-offline") return { additionalContext: OFFLINE_CONTEXT };
    const { answer } = submitted;
    if (answer.status >= 300) {
      const error = (answer.body as { error?: { message?: string } } | null)?.error;
      return { additionalContext: refusalContext(error?.message ?? `The relay refused the registration with HTTP ${answer.status}.`) };
    }
    const registered = answer.body as SessionRegistered;
    if (!registered.project || registered.refusal) return { additionalContext: refusalContext(registered.refusal?.message ?? "The relay gave no project.") };
    const stranded: StrandedItem[] = store.attemptsOfSession(registered.session.id, ["stranded"]).map((attempt) => {
      const open = registered.assigned.find((message) => message.id === attempt.messageId);
      return { messageId: attempt.messageId, open: open?.request ? { generation: open.request.generation } : null };
    });
    return {
      additionalContext: sessionStartContext({
        session: registered.session,
        projectKey: registered.project.key,
        skillPath: messagingSkillPath(home),
        autoJoined: registered.autoJoined,
        assigned: registered.assigned,
        stranded,
        now: clock.now(),
      }),
    };
  }

  async function hookUserPromptSubmit(params: Record<string, unknown>): Promise<{ additionalContext: string | null }> {
    const event = (params.event ?? {}) as Record<string, unknown>;
    const session = sessionOf(params.caller, str(event.session_id));
    if (!session) return { additionalContext: null };
    // Only the envelope marks are read. The prompt text is not stored.
    const ids = peerMessageIds(typeof event.prompt === "string" ? event.prompt : "");
    const human = ids.length === 0;
    await setActivity(session, "busy", { turnOrigin: human ? "human" : "peer", turnCauses: human ? [] : ids.slice(-MAX_CAUSES) });
    if (!session.relaySessionId) return { additionalContext: null };
    const rows = store.digest(session.relaySessionId);
    const { text, included } = buildDigest(
      rows.map((row) => row.item as DigestItem),
      human,
      (conversation) => slugs.get(conversation) ?? conversation,
    );
    for (const item of included) {
      const key = digestKey(item);
      store.removeDigest(session.relaySessionId, key);
      if (item.type === "message") report(item.receiptId, item.generation, "delivered", "context-digest", null);
    }
    void outbox.flush();
    return { additionalContext: text };
  }

  function digestKey(item: DigestItem): string {
    return item.type === "message" ? item.receiptId : `request:${item.request}:${item.state.generation}`;
  }

  async function hookStop(params: Record<string, unknown>): Promise<Record<string, never>> {
    const session = sessionOf(params.caller, str((params.event as Record<string, unknown> | undefined)?.session_id));
    if (session) await setActivity(session, "idle", { turnEndedAt: iso() });
    return {};
  }

  async function hookPermissionRequest(params: Record<string, unknown>): Promise<Record<string, never>> {
    const session = sessionOf(params.caller, str((params.event as Record<string, unknown> | undefined)?.session_id));
    if (session) await setActivity(session, "awaiting-approval");
    return {};
  }

  async function hookPostToolUse(params: Record<string, unknown>): Promise<Record<string, never>> {
    const session = sessionOf(params.caller, str((params.event as Record<string, unknown> | undefined)?.session_id));
    if (session) await setActivity(session, "busy");
    return {};
  }

  async function hookSessionEnd(params: Record<string, unknown>): Promise<Record<string, never>> {
    const event = (params.event ?? {}) as Record<string, unknown>;
    const session = sessionOf(params.caller, str(event.session_id));
    if (session && session.state === "live") endSession(session, event.reason === "clear" ? "replaced" : "exit");
    return {};
  }

  // ---------------------------------------------------------------------------
  // Tools

  async function read(path: string): Promise<RelayAnswer | null> {
    try {
      return await client.request({ method: "GET", path, signal: AbortSignal.timeout(TOOL_WAIT_MS) });
    } catch {
      return null;
    }
  }

  async function readTool(path: string, guidance: string): Promise<ToolResult> {
    const answer = await read(path);
    return answer ? fromAnswer(answer, guidance) : failure("relay-offline", "The relay is not reachable.");
  }

  async function writeTool(method: Method, path: string, body: Record<string, unknown>, sessionId: string, guidance: (answer: RelayAnswer) => string): Promise<ToolResult> {
    const submitted: Submitted = await outbox.submit({ method, path, body, sessionId }, TOOL_WAIT_MS);
    if (submitted.state === "queued-offline") return { ok: true, result: { state: "queued-offline", key: submitted.key }, guidance: QUEUED_GUIDANCE };
    return fromAnswer(submitted.answer, guidance(submitted.answer));
  }

  /** The conversation id of an argument: an id, a slug, or `<repo>/<slug>` of the project of the session. */
  async function conversationId(session: Participating, value: unknown): Promise<string | ToolResult> {
    const ref = str(value);
    if (!ref) return failure("invalid-request", "The tool needs a conversation id or slug.");
    if (/^cnv_[0-9A-Z]{26}$/.test(ref)) return ref;
    const slug = ref.split("/").pop()!.toLowerCase();
    for (const [known, knownSlug] of slugs) if (knownSlug === slug && conversationProjects.get(known) === session.projectId) return known;
    const answer = await read(`/v1/projects/${id(session.projectId)}/conversations${query({ query: slug, state: "all" })}`);
    if (!answer) return failure("relay-offline", "The relay is not reachable.");
    if (answer.status >= 300) return fromAnswer(answer, "");
    for (const conversation of (answer.body as { conversations: ConversationSummary[] }).conversations) {
      slugs.set(conversation.id, conversation.slug);
      conversationProjects.set(conversation.id, conversation.projectId);
      if (conversation.slug === slug) return conversation.id;
    }
    return failure("not-found", `No conversation ${ref} in this project.`);
  }
  type Participating = StoredSession & { relaySessionId: string; projectId: string };

  function participating(session: StoredSession | null): Participating | ToolResult {
    if (!session) return failure("not-participating", "This process is not a registered Claude Code or Codex session.");
    if (session.refusal) return failure("not-participating", session.refusal.message);
    if (!session.relaySessionId) return failure("relay-offline", "The registration of this session waits for the relay.");
    if (!session.projectId) return failure("not-participating", "The session has no project.");
    return session as Participating;
  }

  const tools: Record<string, (session: Participating, args: Record<string, unknown>) => Promise<ToolResult>> = {
    async ferry_whoami(session, args) {
      const task = typeof args.task === "string" ? args.task : null;
      const info = {
        address: session.address,
        owner: session.ownerLogin,
        runtime: session.runtime,
        runtimeVersion: session.runtimeVersion,
        project: session.projectKey,
        adapter: session.adapter,
        adapterReason: session.adapterReason,
      };
      if (task === null) return success(info, "Use the address when other sessions need to reach you.");
      const result = await writeTool("PATCH", `/v1/sessions/${id(session.relaySessionId)}`, { task }, session.relaySessionId, () => "The task is set. Other sessions see it in ferry_peers.");
      return result.ok ? success({ ...info, task, relay: result.result }, result.guidance) : result;
    },

    async ferry_conversations(session, args) {
      const result = await readTool(
        `/v1/projects/${id(session.projectId)}/conversations${query({ query: str(args.query), state: args.state === "all" ? "all" : "open" })}`,
        "Join each conversation whose purpose, links, or subjects overlap your task, with ferry_membership.",
      );
      if (result.ok) {
        for (const conversation of (result.result as { conversations?: ConversationSummary[] }).conversations ?? []) {
          slugs.set(conversation.id, conversation.slug);
          conversationProjects.set(conversation.id, conversation.projectId);
        }
      }
      return result;
    },

    async ferry_create_conversation(session, args) {
      const name = str(args.name);
      const purpose = str(args.purpose);
      if (!name || !purpose) return failure("invalid-request", "The tool needs name and purpose.");
      const links = [
        ...(str(args.issue) ? [{ kind: "issue", ref: str(args.issue)! }] : []),
        ...(str(args.branch) ? [{ kind: "branch", ref: str(args.branch)! }] : []),
      ];
      const body = {
        sessionId: session.relaySessionId,
        name,
        purpose,
        ...(str(args.slug) ? { slug: str(args.slug) } : {}),
        ...(links.length > 0 ? { links } : {}),
        ...(args.autoJoin === "all" || args.autoJoin === "none" ? { autoJoin: args.autoJoin } : {}),
        ...(args.force === true ? { force: true } : {}),
      };
      return await writeTool("POST", `/v1/projects/${id(session.projectId)}/conversations`, body, session.relaySessionId, () => "You created the conversation and joined it. Post an update with your task.");
    },

    async ferry_membership(session, args) {
      const action = args.action === "leave" ? "leave" : args.action === "join" ? "join" : null;
      if (!action) return failure("invalid-request", "The action is join or leave.");
      const conversation = await conversationId(session, args.conversation);
      if (typeof conversation !== "string") return conversation;
      return await writeTool("POST", `/v1/conversations/${id(conversation)}/${action}`, { sessionId: session.relaySessionId }, session.relaySessionId, () =>
        action === "join" ? "Read the context: open requests and active constraints apply to your work." : "You left the conversation. You get no more updates from it.",
      );
    },

    async ferry_peers(session, args) {
      let conversation: string | undefined;
      if (args.conversation !== undefined) {
        const resolved = await conversationId(session, args.conversation);
        if (typeof resolved !== "string") return resolved;
        conversation = resolved;
      }
      return await readTool(
        `/v1/projects/${id(session.projectId)}/sessions${query({ query: str(args.query), conversationId: conversation })}`,
        "Send a request to one session by its address. A login works only when that owner has one live session in the conversation.",
      );
    },

    async ferry_send(session, args) {
      const kind = args.kind;
      if (kind !== "update" && kind !== "request" && kind !== "answer") return failure("invalid-request", "The kind is update, request, or answer.");
      const text = typeof args.body === "string" ? args.body : "";
      if (text === "") return failure("invalid-request", "The tool needs a body.");
      if (Buffer.byteLength(text) > MAX_BODY_BYTES) return failure("too-large", `The body has ${Buffer.byteLength(text)} bytes. The limit is ${MAX_BODY_BYTES}.`);
      // The check runs before the text leaves this host (design section 12).
      if (holdsToken(text)) return failure("secret-in-message", "The body has a text that looks like a token.");
      const conversation = await conversationId(session, args.conversation);
      if (typeof conversation !== "string") return conversation;
      if (kind === "request" && !str(args.to)) return failure("invalid-request", "A request needs to: a session address or an owner login.");
      if (kind === "answer" && (!str(args.answers) || typeof args.generation !== "number")) return failure("invalid-request", "An answer needs answers (the request id) and generation.");
      const current = store.session(session.runtime, session.runtimeSessionId)!;
      const body = {
        sessionId: session.relaySessionId,
        kind,
        body: text,
        ...(str(args.to) ? { to: str(args.to) } : {}),
        ...(kind === "answer" ? { answers: str(args.answers), generation: args.generation } : {}),
        ...(current.turnOrigin === "peer" && current.turnCauses.length > 0 ? { causeIds: current.turnCauses.slice(-MAX_CAUSES) } : {}),
      };
      return await writeTool("POST", `/v1/conversations/${id(conversation)}/messages`, body, session.relaySessionId, (answer) => {
        const held = ((answer.body as { receipts?: Receipt[] } | null)?.receipts ?? []).find((receipt) => receipt.hold !== null);
        if (held) return `The message is stored, but ${held.display}. Storage does not promise an answer. Check it later with ferry_receipts.`;
        if (kind === "request") return "The request is stored. The answer comes as a new message. Check the state with ferry_receipts.";
        if (kind === "answer") return "The answer is stored.";
        return "The update is stored. Do not wait for an answer.";
      });
    },

    async ferry_ack(session, args) {
      const items = Array.isArray(args.items) ? args.items : [];
      const valid = items
        .filter((item): item is { id: string; generation?: number } => typeof (item as { id?: unknown })?.id === "string")
        .map((item) => (typeof item.generation === "number" ? { id: item.id, generation: item.generation } : { id: item.id }));
      if (valid.length === 0 || valid.length > 50) return failure("invalid-request", "The tool needs 1 to 50 items with an id.");
      return await writeTool("POST", "/v1/messages/ack", { sessionId: session.relaySessionId, items: valid }, session.relaySessionId, (answer) => {
        const results = (answer.body as { items?: { id: string; result: string }[] } | null)?.items ?? [];
        const stop = results.filter((item) => item.result !== "acknowledged");
        if (stop.length === 0) return "Acknowledged. Act on the message now.";
        return stop.map((item) => `${item.id}: ${GUIDANCE[item.result] ?? DEFAULT_GUIDANCE}`).join(" ");
      });
    },

    async ferry_requests(session, args) {
      const role = args.role === "sent" ? "sent" : "assigned";
      return await readTool(
        `/v1/sessions/${id(session.relaySessionId)}/requests${query({ role, state: args.state === "all" ? "all" : "open" })}`,
        "A request with another assignee or a closed status is not your work. Answer your open requests with ferry_send kind=answer.",
      );
    },

    async ferry_request_action(session, args) {
      const request = str(args.request);
      const action = args.action;
      const expectedGeneration = args.expectedGeneration;
      if (!request || typeof expectedGeneration !== "number") return failure("invalid-request", "The tool needs request and expectedGeneration.");
      let body: Record<string, unknown>;
      if (action === "claim") body = { action, expectedGeneration, ...(args.takeover === true ? { takeover: true } : {}) };
      else if (action === "reassign" && str(args.to)) body = { action, expectedGeneration, to: str(args.to) };
      else if (action === "cancel") body = { action, expectedGeneration, note: typeof args.note === "string" ? args.note : "" };
      else if (action === "close" && typeof args.outcome === "string") body = { action, expectedGeneration, outcome: args.outcome, note: typeof args.note === "string" ? args.note : "" };
      else return failure("invalid-request", "The action is claim, reassign (with to), cancel, or close (with outcome).");
      return await writeTool("POST", `/v1/requests/${id(request)}/action`, { sessionId: session.relaySessionId, ...body }, session.relaySessionId, () =>
        action === "claim" && args.takeover === true
          ? "You took over the request. The old session gets a notice to stop, but an action that it started can still run."
          : "Done. The request has a new generation. Use it in the next ack or answer.",
      );
    },

    async ferry_history(session, args) {
      if (str(args.message)) {
        return await readTool(`/v1/messages/${id(str(args.message)!)}${query({ sessionId: session.relaySessionId })}`, "The request status in the result is current. Do not act on a closed or reassigned request.");
      }
      const conversation = await conversationId(session, args.conversation);
      if (typeof conversation !== "string") return conversation;
      const limit = typeof args.limit === "number" ? Math.max(1, Math.min(50, Math.floor(args.limit))) : undefined;
      return await readTool(
        `/v1/conversations/${id(conversation)}/messages${query({ sessionId: session.relaySessionId, before: str(args.before), limit })}`,
        "The request status in each message is current. Do not act on a closed or reassigned request. Use next as before for older messages.",
      );
    },

    async ferry_constraint(session, args) {
      const action = args.action;
      if (action === "list" || action === "create") {
        const conversation = await conversationId(session, args.conversation);
        if (typeof conversation !== "string") return conversation;
        if (action === "list") {
          return await readTool(`/v1/conversations/${id(conversation)}/constraints${query({ sessionId: session.relaySessionId, state: "active" })}`, "Each active constraint applies to your work until its owner resolves it.");
        }
        const text = str(args.text);
        if (!text) return failure("invalid-request", "A constraint needs text.");
        if (holdsToken(text)) return failure("secret-in-message", "The text has a text that looks like a token.");
        return await writeTool(
          "POST",
          `/v1/conversations/${id(conversation)}/constraints`,
          { sessionId: session.relaySessionId, text, ...(str(args.source) ? { sourceMessageId: str(args.source) } : {}) },
          session.relaySessionId,
          () => "The constraint is active. Resolve it when it no longer applies.",
        );
      }
      const constraint = str(args.constraint);
      if (!constraint) return failure("invalid-request", "The action needs constraint.");
      let body: Record<string, unknown>;
      if (action === "adopt") body = { action };
      else if (action === "resolve") body = { action, note: typeof args.note === "string" ? args.note : "" };
      else if (action === "request-resolution" && str(args.evidence)) body = { action, evidence: str(args.evidence) };
      else return failure("invalid-request", "The action is list, create, adopt, resolve, or request-resolution (with evidence).");
      return await writeTool("POST", `/v1/constraints/${id(constraint)}/action`, { sessionId: session.relaySessionId, ...body }, session.relaySessionId, () =>
        action === "request-resolution" ? "The responsible session got a request. It decides." : "Done.",
      );
    },

    async ferry_receipts(session, args) {
      if (str(args.message)) {
        return await readTool(`/v1/messages/${id(str(args.message)!)}${query({ sessionId: session.relaySessionId })}`, "Each receipt shows its state and hold. A held message is stored, not delivered.");
      }
      const entries = (state: "pending" | "failed") =>
        store.outboxEntries(state, session.relaySessionId).map((entry) => ({ key: entry.key, method: entry.method, path: entry.path, createdAt: entry.createdAt, attempts: entry.attempts, lastError: entry.lastError }));
      return success({ queued: entries("pending"), failed: entries("failed") }, "A queued call is not on the relay yet. A failed one never reached it. Send it again when you still need it.");
    },
  };

  async function toolCall(params: Record<string, unknown>): Promise<ToolResult> {
    const tool = str(params.tool);
    const run = tool ? tools[tool] : undefined;
    if (!run) return failure("invalid-request", `Unknown tool ${tool ?? ""}.`);
    if (revoked) return failure("device-revoked", "The credential of this host was revoked.");
    const session = participating(sessionOf(params.caller));
    if ("ok" in session) return session;
    const args = typeof params.arguments === "object" && params.arguments !== null ? (params.arguments as Record<string, unknown>) : {};
    return await run(session, args);
  }

  // ---------------------------------------------------------------------------
  // Delivery

  /** Report a delivery result through the outbox. The relay must get it, also after a restart. */
  function report(receiptId: string, generation: number, outcome: DeliveryResult["outcome"], evidence: EvidenceKind | null, detail: string | null): void {
    outbox.enqueue({
      method: "POST",
      path: `/v1/deliveries/${id(receiptId)}/result`,
      body: { generation, outcome, evidence: evidence ? { kind: evidence, at: iso() } : null, detail: detail?.slice(0, 500) ?? null },
      sessionId: null,
    });
    void outbox.flush();
  }

  async function fetchMessage(relaySessionId: string, messageId: string): Promise<{ message: Message; receipts: Receipt[] } | null> {
    const answer = await read(`/v1/messages/${id(messageId)}${query({ sessionId: relaySessionId })}`);
    return answer && answer.status < 300 ? (answer.body as { message: Message; receipts: Receipt[] }) : null;
  }

  async function onDeliveryReady(event: Extract<RelayEvent, { type: "delivery.ready" }>): Promise<void> {
    if (inFlight.has(event.receiptId)) return;
    const session = store.sessionByRelayId(event.sessionId);
    if (!session) return;
    inFlight.add(event.receiptId);
    try {
      const fetched = await fetchMessage(event.sessionId, event.messageId);
      if (!fetched) {
        waitingReady.set(event.receiptId, event);
        return;
      }
      waitingReady.delete(event.receiptId);
      const generation = fetched.receipts.find((receipt) => receipt.id === event.receiptId)?.generation ?? fetched.message.request?.generation ?? 0;
      if (!event.wake) {
        store.addDigest(event.sessionId, event.receiptId, { type: "message", receiptId: event.receiptId, generation, heldByHops: false, message: fetched.message } satisfies DigestItem, iso());
        return;
      }
      const attempt = store.insertAttempt(event.receiptId, generation, event.sessionId, event.messageId, iso());
      await dispatch(attempt, fetched.message);
    } finally {
      inFlight.delete(event.receiptId);
    }
  }

  /** Dispatch and inject one attempt (design section 6.3). */
  async function dispatch(attempt: StoredAttempt, message: Message | null): Promise<void> {
    const set = (change: Parameters<WorkerStore["updateAttempt"]>[2]) => store.updateAttempt(attempt.receiptId, attempt.attempt, change, iso());
    const session = store.sessionByRelayId(attempt.sessionId);
    const adapter = session ? adapterOf(session.runtime) : null;
    if (!session || !adapter) {
      set({ state: "dropped" });
      return;
    }
    if (session.state !== "live" || !(await adapter.live(session))) {
      set({ state: "held" });
      if (session.state === "live") endSession(session, "crash");
      report(attempt.receiptId, attempt.generation, "offline", null, null);
      return;
    }
    set({ state: "dispatching" });
    let answer: RelayAnswer;
    try {
      answer = await client.request({
        method: "POST",
        path: `/v1/deliveries/${id(attempt.receiptId)}/dispatch`,
        body: { generation: attempt.generation, activity: session.activity ?? "idle" },
        idempotencyKey: newId("idempotencyKey", clock.now()),
        signal: AbortSignal.timeout(TOOL_WAIT_MS),
      });
    } catch {
      // No answer: the tick tries again. Without a `go`, nothing is injected.
      set({ state: "queued" });
      return;
    }
    if (answer.status >= 300) {
      set({ state: "dropped" });
      log(`Dispatch of ${attempt.receiptId} refused: HTTP ${answer.status}.`);
      return;
    }
    const decision = answer.body as DispatchDecision;
    if (decision.decision === "hold") {
      set({ state: "held" });
      if (decision.hold === "wake-hops") {
        const held = message ?? (await fetchMessage(attempt.sessionId, attempt.messageId))?.message ?? null;
        if (held) {
          store.addDigest(attempt.sessionId, attempt.receiptId, { type: "message", receiptId: attempt.receiptId, generation: attempt.generation, heldByHops: true, message: held } satisfies DigestItem, iso());
        }
      }
      return;
    }
    if (decision.decision === "drop") {
      set({ state: "dropped" });
      return;
    }
    const offset = transcriptSize(session.transcriptPath);
    set({ state: "injecting", transcriptOffset: offset });
    // A message that comes into a busy turn adds to its causes. In an idle session it starts a peer turn.
    const busy = session.activity === "busy" || session.activity === "awaiting-approval";
    store.updateSession(session.runtime, session.runtimeSessionId, busy ? { turnCauses: addCause(session.turnCauses, attempt.messageId) } : { turnOrigin: "peer", turnCauses: [attempt.messageId] });
    const injected = await adapter.inject(session, decision.envelope, attempt.messageId);
    if (!injected.ok) {
      set({ state: "failed" });
      log(`Injection of ${attempt.receiptId} failed: ${injected.error}`);
      report(attempt.receiptId, attempt.generation, "failed", null, injected.error);
      return;
    }
    const now = clock.now();
    set({ state: "injected", runtimeRef: injected.runtimeRef, injectedAt: iso(now), watchUntil: iso(now + CONFIRM_MS), activity: session.activity });
  }

  async function confirmAttempts(): Promise<void> {
    const now = clock.now();
    for (const attempt of store.latestAttempts(["injected", "unconfirmed"])) {
      if (attempt.state === "unconfirmed" && (!attempt.watchUntil || now > Date.parse(attempt.watchUntil))) continue;
      const session = store.sessionByRelayId(attempt.sessionId);
      const adapter = session ? adapterOf(session.runtime) : null;
      if (!session || !adapter) continue;
      const set = (change: Parameters<WorkerStore["updateAttempt"]>[2]) => store.updateAttempt(attempt.receiptId, attempt.attempt, change, iso());
      const confirmation = await adapter.confirm(session, attempt);
      if (confirmation.state === "delivered") {
        set({ state: "confirmed", watchUntil: null });
        store.resetStreak(session.runtime, session.runtimeVersion);
        report(attempt.receiptId, attempt.generation, "delivered", confirmation.evidence, null);
      } else if (confirmation.state === "stranded") {
        set({ state: "stranded", watchUntil: null });
        report(attempt.receiptId, attempt.generation, "stranded", null, null);
      } else if (attempt.state === "injected" && attempt.injectedAt && now - Date.parse(attempt.injectedAt) >= CONFIRM_MS) {
        set({ state: "unconfirmed", watchUntil: iso(Date.parse(attempt.injectedAt) + WATCH_MS) });
        report(attempt.receiptId, attempt.generation, "unconfirmed", null, null);
        if (session.runtime === "claude" && attempt.activity === "idle") await frameCheck(session);
      }
    }
  }

  /** The frame check of design section 9.2: three unconfirmed attempts in a row on idle sessions mark the version. */
  async function frameCheck(session: StoredSession): Promise<void> {
    if (store.addUnconfirmed(session.runtime, session.runtimeVersion) < FRAME_CHECK_STREAK) return;
    store.markUnconfirmed(session.runtime, session.runtimeVersion, VERSION);
    log(`${session.runtime} ${session.runtimeVersion} is unconfirmed: ${FRAME_CHECK_STREAK} deliveries in a row had no evidence.`);
    for (const other of store.sessions()) {
      if (other.runtime === session.runtime && other.runtimeVersion === session.runtimeVersion && other.state === "live") await recheck(other);
    }
  }

  /** Run the adapter check again, and tell the relay when the result changed. */
  async function recheck(session: StoredSession): Promise<void> {
    const result = await check(session);
    if (result.adapter === session.adapter && result.reason === session.adapterReason) return;
    store.updateSession(session.runtime, session.runtimeSessionId, { adapter: result.adapter, adapterReason: result.reason });
    if (session.relaySessionId) {
      outbox.enqueue({ method: "PATCH", path: `/v1/sessions/${id(session.relaySessionId)}`, body: { adapter: result.adapter, adapterReason: result.reason?.slice(0, 200) ?? null }, sessionId: session.relaySessionId });
      void outbox.flush();
    }
  }

  async function retryAndReinject(): Promise<void> {
    const now = clock.now();
    for (const attempt of store.latestAttempts(["queued"])) {
      if (now - Date.parse(attempt.updatedAt) >= DISPATCH_RETRY_MS && !inFlight.has(attempt.receiptId)) await guarded(attempt.receiptId, () => dispatch(attempt, null));
    }
    // One re-injection at most: after the session ended a turn, and 120 seconds passed with no ack.
    for (const attempt of store.latestAttempts(["confirmed"])) {
      if (attempt.attempt >= MAX_ATTEMPTS || !attempt.injectedAt || store.acked(attempt.sessionId, attempt.messageId)) continue;
      const session = store.sessionByRelayId(attempt.sessionId);
      const ended = session?.turnEndedAt ? Date.parse(session.turnEndedAt) : null;
      if (!session || ended === null || ended < Date.parse(attempt.injectedAt) || now - ended < REINJECT_AFTER_MS) continue;
      const next = store.insertAttempt(attempt.receiptId, attempt.generation, attempt.sessionId, attempt.messageId, iso());
      await guarded(attempt.receiptId, () => dispatch(next, null));
    }
    for (const event of waitingReady.values()) await onDeliveryReady(event);
  }

  async function guarded(receiptId: string, run: () => Promise<void>): Promise<void> {
    if (inFlight.has(receiptId)) return;
    inFlight.add(receiptId);
    try {
      await run();
    } finally {
      inFlight.delete(receiptId);
    }
  }

  async function heartbeat(): Promise<void> {
    const cutoff = clock.now() - 2 * HEARTBEAT_MS;
    const sessions = store
      .sessions()
      .filter((session) => session.relaySessionId && (session.state === "live" || (session.endedAt && Date.parse(session.endedAt) >= cutoff)))
      .map((session) => ({ id: session.relaySessionId!, state: session.state, activity: session.state === "live" ? session.activity : null }));
    try {
      await client.request({ method: "POST", path: "/v1/worker/heartbeat", body: { sessions }, idempotencyKey: newId("idempotencyKey", clock.now()), signal: AbortSignal.timeout(TOOL_WAIT_MS) });
    } catch {
      // The next heartbeat tries again. A late heartbeat has no value.
    }
  }

  async function periodic(): Promise<void> {
    for (const session of store.sessions()) {
      if (session.state !== "live") continue;
      const adapter = adapterOf(session.runtime);
      if (!adapter) continue;
      if (!(await adapter.live(session))) {
        endSession(session, "crash");
        continue;
      }
      if (!session.refusal) await recheck(session);
    }
    await heartbeat();
  }

  let ticking = false;
  async function tick(): Promise<void> {
    if (ticking || stopped) return;
    ticking = true;
    try {
      await outbox.flush();
      await confirmAttempts();
      await retryAndReinject();
      if (clock.now() - lastPeriodic >= HEARTBEAT_MS) {
        lastPeriodic = clock.now();
        await periodic();
      }
      await outbox.flush();
    } catch (error) {
      log(`Worker tick failed: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      ticking = false;
    }
  }

  // ---------------------------------------------------------------------------
  // Events

  async function handleEvent(event: RelayEvent): Promise<void> {
    switch (event.type) {
      case "delivery.ready":
        void onDeliveryReady(event).catch((error) => log(`Delivery of ${event.receiptId} failed: ${error instanceof Error ? error.message : String(error)}`));
        return;
      case "request.changed": {
        if (!store.sessionByRelayId(event.sessionId)) return;
        const item: DigestItem = { type: "request-changed", request: event.request, state: event.state };
        store.addDigest(event.sessionId, digestKey(item), item, iso());
        return;
      }
      case "session.moved": {
        // The session runs on another device of the owner now. This worker stops delivery for it.
        const session = store.sessionByRelayId(event.sessionId);
        if (session) store.updateSession(session.runtime, session.runtimeSessionId, { relaySessionId: null, state: "offline", activity: null, endedAt: iso() });
        return;
      }
      case "device.revoked":
        revoked = true;
        log("The relay revoked the credential of this device.");
        return;
      default:
        log(`Event ${event.type} for ${"sessionId" in event ? event.sessionId : "the device"}.`);
    }
  }

  /** Load the open receipts of each session again, after the relay dropped the events since the cursor. */
  async function resync(): Promise<void> {
    for (const session of store.sessions()) {
      if (!session.relaySessionId || session.state !== "live") continue;
      const answer = await read(`/v1/sessions/${id(session.relaySessionId)}/pending`);
      if (!answer || answer.status >= 300) continue;
      const pending = answer.body as { receipts: (Receipt & { message: Message })[]; heldByHops: (Receipt & { message: Message })[] };
      for (const receipt of pending.receipts) {
        await handleEvent({ seq: 0, type: "delivery.ready", receiptId: receipt.id, sessionId: session.relaySessionId, messageId: receipt.messageId, kind: receipt.message.kind, wake: WAKE_KINDS.has(receipt.message.kind) });
      }
      for (const receipt of pending.heldByHops) {
        const item: DigestItem = { type: "message", receiptId: receipt.id, generation: receipt.generation, heldByHops: true, message: receipt.message };
        store.addDigest(session.relaySessionId, receipt.id, item, iso());
      }
    }
  }

  async function pollOnce(waitMs = POLL_WAIT_MS): Promise<void> {
    const answer = await client.request({
      method: "GET",
      path: `/v1/worker/events${query({ cursor: store.cursor(), waitMs })}`,
      signal: AbortSignal.any([pollAbort.signal, AbortSignal.timeout(waitMs + 10_000)]),
    });
    if (answer.status >= 300) throw new Error(`events: HTTP ${answer.status}`);
    const events = answer.body as Events;
    if (events.resync) await resync();
    for (const event of events.events) await handleEvent(event);
    store.setCursor(events.cursor);
  }

  async function pollLoop(): Promise<void> {
    let failures = 0;
    while (!stopped && !revoked) {
      try {
        await pollOnce();
        failures = 0;
      } catch {
        if (stopped) return;
        failures++;
        await Bun.sleep(Math.min(60_000, 1000 * 2 ** Math.min(failures - 1, 6)));
      }
    }
  }

  // ---------------------------------------------------------------------------
  // Status

  /** Live Codex processes in a participating repository that did not register: Codex does not run the Ferry hooks. */
  async function unregisteredCodex(): Promise<{ pid: number; worktree: string }[]> {
    if (process.platform !== "linux") return [];
    const sessions = store.sessions();
    const keys = new Set(sessions.filter((session) => session.projectId !== null && session.projectKey !== null).map((session) => session.projectKey!));
    if (keys.size === 0) return [];
    const registered = new Set(sessions.filter((session) => session.state === "live").map((session) => session.runtimePid));
    const found: { pid: number; worktree: string }[] = [];
    let pids: number[] = [];
    try {
      pids = readdirSync("/proc").filter((name) => /^\d+$/.test(name)).map(Number);
    } catch {
      return [];
    }
    for (const pid of pids) {
      if (registered.has(pid) || processes.name(pid) !== "codex") continue;
      // An app server, a queue command, or an MCP server is not an interactive thread.
      const args = processes.argv(pid) ?? [];
      if (args.some((arg) => arg === "app-server" || arg === "queue" || arg === "mcp" || arg === "mcp-server")) continue;
      let cwd: string;
      try {
        cwd = readlinkSync(`/proc/${pid}/cwd`);
      } catch {
        continue;
      }
      const repo = await resolveRepo(cwd);
      if (repo?.key && keys.has(repo.key)) found.push({ pid, worktree: repo.worktree });
    }
    return found;
  }

  async function status(): Promise<WorkerStatus> {
    const count = (state: Parameters<WorkerStore["latestAttempts"]>[0][number]) => store.latestAttempts([state]).length;
    return {
      pid: process.pid,
      version: VERSION,
      startedAt,
      revoked,
      relay: { reachable, lastContactAt, lastError },
      sessions: store.sessions().map((session) => ({
        runtime: session.runtime,
        runtimeSessionId: session.runtimeSessionId,
        runtimeVersion: session.runtimeVersion,
        address: session.address,
        project: session.projectKey,
        state: session.state,
        activity: session.activity,
        adapter: session.adapter,
        adapterReason: session.adapterReason,
        refusal: session.refusal?.message ?? null,
      })),
      outbox: {
        pending: store.outboxEntries("pending").length,
        failed: store.outboxEntries("failed").map((entry) => ({ key: entry.key, method: entry.method, path: entry.path, createdAt: entry.createdAt, lastError: entry.lastError })),
      },
      deliveries: { held: count("held"), unconfirmed: count("unconfirmed"), stranded: count("stranded"), failed: count("failed") },
      unregisteredCodex: await unregisteredCodex(),
    };
  }

  // ---------------------------------------------------------------------------
  // Socket

  async function handle(request: LocalRequest): Promise<LocalResponse> {
    const { params } = request;
    const done = (result: unknown): LocalResponse => ({ v: 1, id: request.id, ok: true, result });
    switch (request.op) {
      case "hook.sessionStart":
        return done(await hookSessionStart(params));
      case "hook.userPromptSubmit":
        return done(await hookUserPromptSubmit(params));
      case "hook.stop":
        return done(await hookStop(params));
      case "hook.permissionRequest":
        return done(await hookPermissionRequest(params));
      case "hook.postToolUse":
        return done(await hookPostToolUse(params));
      case "hook.sessionEnd":
        return done(await hookSessionEnd(params));
      case "tool.call":
        return done(await toolCall(params));
      case "status":
        return done(await status());
      default:
        return { v: 1, id: request.id, ok: false, error: { code: "invalid-request", message: `Unknown op ${String(request.op)}.` } };
    }
  }

  // A hook that ran while the worker was down. Its process can be gone, and then the hook changes nothing.
  await replaySpool(home, handle);
  const server: Server = await listenSocket(socketPath, handle);
  const timer = tickMs > 0 ? setInterval(() => void tick(), tickMs) : null;
  const polling = tickMs > 0 ? pollLoop() : Promise.resolve();
  log(`Ferry messaging worker on ${socketPath}`);

  return {
    socketPath,
    store,
    handle,
    tick,
    pollOnce,
    status,
    async stop() {
      stopped = true;
      if (timer) clearInterval(timer);
      pollAbort.abort();
      await polling;
      await new Promise<void>((resolve) => server.close(() => resolve()));
      store.close();
    },
  };
}

