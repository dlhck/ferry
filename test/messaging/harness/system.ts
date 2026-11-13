/**
 * The layer 2 system of design 15.2 in one test process: the fake GitHub, the relay
 * behind a fault proxy, one enrolled home and worker for each identity, and the fake
 * runtimes.
 *
 * The suites drive it through the two wire protocols: the worker socket, as hooks
 * and the MCP server do, and the relay HTTP API for assertions. Only this file and
 * `lanes.ts` call the TypeScript interfaces of the other lanes.
 */

import { afterEach, beforeEach } from "bun:test";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { changedPaths, createCheckout, treeState, type Checkout, type TreeState } from "./checkout.ts";
import { FakeClock, type Clock } from "./clock.ts";
import type {
  FakeGitHub,
  FakeHookEvent,
  FakePermission,
  FakeRepository,
  FakeRuntime,
  FakeRuntimes,
  FakeRuntimeSession,
} from "./contracts.ts";
import { startFaultProxy, type FaultProxy } from "./fault-proxy.ts";
import { ALICE, BOB, createHomes, type TestHome, type TestHomes, type TestIdentity } from "./homes.ts";
import { lanes, waitingFor, SYSTEM_PARTS } from "./lanes.ts";
import { callWorker, newCredential, RelayHttp, type WorkerReply } from "./wire.ts";

export const REPO_ROOT = join(import.meta.dir, "..", "..", "..");
export const ACME_APP: FakeRepository = { owner: "acme", name: "app", id: 5001 };
export const TEST_FERRY_VERSION = "0.0.0-test";

/** The JSON result of each `ferry_*` tool (design 8.4). */
export type ToolResult = {
  readonly ok: boolean;
  readonly result?: Record<string, any>;
  readonly error?: { readonly code: string; readonly message?: string };
  readonly guidance?: string;
};

/** The attributes of one envelope (design 9.1) that reached a fake runtime. */
export type Envelope = {
  readonly id: string;
  readonly kind: string;
  readonly generation: number | null;
  readonly conversation: string;
  readonly from: string;
  readonly hop: number;
  readonly text: string;
};

export type Participant = {
  readonly home: TestHome;
  readonly checkout: Checkout;
  readonly before: TreeState;
  readonly credential: string;
  readonly deviceId: string;
  /** The relay API with this device's credential, direct, without the fault proxy. */
  readonly http: RelayHttp;
  readonly socketPath: string;
};

export type Session = {
  readonly login: string;
  readonly runtime: FakeRuntime;
  readonly fake: FakeRuntimeSession;
  /** The `additionalContext` of the `SessionStart` hook. */
  readonly startContext: string;
  /** The address from `ferry_whoami`, and the relay session id from the relay API. Empty when the session does not participate. */
  readonly id: string;
  readonly address: string;
  hook(event: FakeHookEvent, fields?: Readonly<Record<string, unknown>>): Promise<WorkerReply>;
  tool(name: string, args?: Readonly<Record<string, unknown>>): Promise<ToolResult>;
  /** The envelopes that reached this runtime, in order. */
  envelopes(): Envelope[];
};

export type SystemIdentity = TestIdentity & { readonly permission?: FakePermission };

export type MessagingSystem = {
  readonly clock: FakeClock;
  readonly homes: TestHomes;
  readonly github: FakeGitHub;
  readonly proxy: FaultProxy;
  readonly runtimes: FakeRuntimes;
  /** The relay URL that the workers use: the fault proxy. */
  readonly relayUrl: string;
  participant(login: string): Participant;
  startSession(login: string, runtime: FakeRuntime, options?: { readonly where?: "main" | "linked"; readonly source?: string }): Promise<Session>;
  /** Resumes a session in a new fake process and runs its `SessionStart` hook with `source = resume`. */
  resumeSession(session: Session): Promise<Session>;
  stopRelay(): Promise<void>;
  /** Starts the relay again on the same port and database. */
  startRelay(): Promise<void>;
  stopWorker(login: string): Promise<void>;
  /** Starts the worker of a login. `wrap` can change the adapters, for fault injection. */
  startWorker(login: string, options?: { readonly wrap?: (adapter: unknown) => unknown }): Promise<void>;
  /** The relay log lines so far. */
  logs(): readonly string[];
  /** Throws when a file in a checkout or its Git metadata changed since the system started. */
  expectCheckoutsUnchanged(): void;
  stop(): Promise<void>;
};

/** True when every lane that the system needs is on this branch. */
export const systemReady = waitingFor(SYSTEM_PARTS).length === 0;

/**
 * Polls `probe` until it returns a value that is not `undefined`, `null`, or `false`.
 * With `advanceMs`, it moves the fake clock forward by that much at each poll, so the
 * timers of the relay and the workers that read the clock make progress.
 */
export async function waitFor<T>(
  probe: () => T | Promise<T>,
  options: { readonly timeoutMs?: number; readonly clock?: FakeClock; readonly advanceMs?: number; readonly what?: string } = {},
): Promise<Exclude<T, undefined | null | false>> {
  const deadline = Date.now() + (options.timeoutMs ?? 10_000);
  let last: unknown;
  for (;;) {
    try {
      const value = await probe();
      if (value !== undefined && value !== null && value !== false) return value as Exclude<T, undefined | null | false>;
      last = value;
    } catch (error) {
      last = error;
    }
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${options.what ?? "a condition"}; last value: ${String(last)}`);
    if (options.clock !== undefined && options.advanceMs !== undefined) options.clock.advance(options.advanceMs);
    await Bun.sleep(25);
  }
}

/** Parses the envelopes of design 9.1 out of the texts that reached a runtime. */
export function parseEnvelopes(received: readonly string[]): Envelope[] {
  const result: Envelope[] = [];
  for (const text of received) {
    for (const match of text.matchAll(/<ferry-message ([^>]*)>([\s\S]*?)<\/ferry-message>/g)) {
      const attributes = Object.fromEntries([...(match[1] ?? "").matchAll(/(\w+)="([^"]*)"/g)].map((pair) => [pair[1], pair[2]]));
      result.push({
        id: attributes.id ?? "",
        kind: attributes.kind ?? "",
        generation: attributes.generation === undefined ? null : Number(attributes.generation),
        conversation: attributes.conversation ?? "",
        from: attributes.from ?? "",
        hop: Number(attributes.hop ?? "0"),
        text: match[2] ?? "",
      });
    }
  }
  return result;
}

const HOOK_OPS: Record<FakeHookEvent, string> = {
  SessionStart: "hook.sessionStart",
  UserPromptSubmit: "hook.userPromptSubmit",
  Stop: "hook.stop",
  PermissionRequest: "hook.permissionRequest",
  Notification: "hook.permissionRequest",
  PostToolUse: "hook.postToolUse",
  SessionEnd: "hook.sessionEnd",
};

/** The relay side of the system: the fake GitHub, the relay behind the fault proxy, and the enrolled homes. */
export type RelayStack = {
  readonly clock: Clock;
  readonly homes: TestHomes;
  readonly github: FakeGitHub;
  readonly proxy: FaultProxy;
  readonly participants: ReadonlyMap<string, Participant>;
  participant(login: string): Participant;
  stopRelay(): Promise<void>;
  startRelay(): Promise<void>;
  logs(): readonly string[];
  expectCheckoutsUnchanged(): void;
  stop(): Promise<void>;
};

export const RELAY_STACK_PARTS: readonly (keyof typeof lanes)[] = ["relay", "github", "fakeGitHub"];

/**
 * Starts the fake GitHub and the relay, and enrolls one home for each identity. Each
 * home gets a clone of the repository, and the state of the clone is taken before the
 * enrollment. With a `FakeClock`, the enrollment moves the clock instead of a wait.
 */
export async function startRelayStack(
  options: { readonly identities?: readonly SystemIdentity[]; readonly repository?: FakeRepository; readonly clock?: Clock } = {},
): Promise<RelayStack> {
  const missing = waitingFor(RELAY_STACK_PARTS);
  if (missing.length > 0) throw new Error(`the relay stack waits for ${missing.join(", ")}`);
  const relayModule = lanes.relay!;
  const identities: readonly SystemIdentity[] = options.identities ?? [ALICE, BOB];
  const repository = options.repository ?? ACME_APP;
  const fullName = `${repository.owner}/${repository.name}`;
  const clock = options.clock ?? new FakeClock();
  const homes = createHomes(identities);
  const relayLog: string[] = [];

  const github = await lanes.fakeGitHub!.startFakeGitHub({
    users: identities.map(({ login, githubUserId }) => ({ login, githubUserId })),
    repositories: [repository],
    clock,
  });
  github.install(repository.owner);
  for (const identity of identities) github.setPermission(fullName, identity.login, identity.permission ?? "write", null);

  const access = lanes.github!.createGitHubAccess({ ...github.app, apiUrl: github.apiUrl, webUrl: github.webUrl, clock });
  const dbDir = join(homes.root, "relay-host", ".ferry", "relay");
  mkdirSync(dbDir, { recursive: true, mode: 0o700 });
  const dbPath = join(dbDir, "relay.db");
  const relayOptions = (listen: string) => ({
    dbPath,
    listen,
    github: access,
    clock,
    log: (line: string) => relayLog.push(line),
    allowedOwners: [repository.owner],
  });
  let relay = await relayModule.startRelay(relayOptions("127.0.0.1:0"));
  const relayPort = Number(new URL(relay.url).port);
  let relayRunning = true;
  const proxy = await startFaultProxy(relayPort);
  const direct = relay.url.replace(/\/$/, "");

  const participants = new Map<string, Participant>();
  for (const home of homes.homes) {
    const src = join(home.home, "src");
    mkdirSync(src, { recursive: true });
    const checkout = createCheckout(src, { remoteUrl: `git@github.com:${fullName}.git`, key: `github.com/${fullName}` });
    const before = treeState(checkout.root);
    const { credential, deviceId } = await enroll(direct, github, clock, home);
    writeFileSync(join(home.messagingDir, "credential"), `${credential}\n`, { mode: 0o600 });
    writeFileSync(
      join(home.messagingDir, "client.json"),
      `${JSON.stringify({ schemaVersion: 1, relayUrl: proxy.url, deviceId, ownerLogin: home.login }, null, 2)}\n`,
      { mode: 0o600 },
    );
    participants.set(home.login, {
      home,
      checkout,
      before,
      credential,
      deviceId,
      http: new RelayHttp(direct, credential),
      socketPath: join(home.messagingDir, "worker.sock"),
    });
  }

  return {
    clock,
    homes,
    github,
    proxy,
    participants,
    participant(login) {
      const found = participants.get(login);
      if (found === undefined) throw new Error(`no participant ${login}`);
      return found;
    },
    async stopRelay() {
      if (!relayRunning) return;
      relayRunning = false;
      proxy.setMode("refuse");
      await relay.stop();
    },
    async startRelay() {
      if (relayRunning) return;
      relay = await relayModule.startRelay(relayOptions(`127.0.0.1:${relayPort}`));
      relayRunning = true;
      proxy.setMode("pass");
    },
    logs: () => relayLog,
    expectCheckoutsUnchanged() {
      for (const p of participants.values()) {
        const changed = changedPaths(p.before, treeState(p.checkout.root));
        if (changed.length > 0) throw new Error(`Ferry changed the checkout of ${p.home.login}: ${changed.join(", ")}`);
      }
    },
    async stop() {
      if (relayRunning) await relay.stop();
      await proxy.stop();
      await github.stop();
      homes.cleanup();
    },
  };
}

export async function startSystem(
  options: { readonly identities?: readonly SystemIdentity[]; readonly repository?: FakeRepository } = {},
): Promise<MessagingSystem> {
  const missing = waitingFor(SYSTEM_PARTS);
  if (missing.length > 0) throw new Error(`the messaging system waits for ${missing.join(", ")}`);
  const clientModule = lanes.client!;
  const workerModule = lanes.worker!;
  const clock = new FakeClock();
  const stack = await startRelayStack({ ...options, clock });
  const { homes, github, proxy, participant } = stack;

  const runtimes = await lanes.fakeRuntimes!.createFakeRuntimes({ root: join(homes.root, "runtimes"), clock });
  const workers = new Map<string, { stop(): Promise<void> }>();

  const startWorker: MessagingSystem["startWorker"] = async (login, workerOptions = {}) => {
    if (workers.has(login)) throw new Error(`the worker of ${login} runs already`);
    const p = participant(login);
    const client = new clientModule.RelayClient({ url: proxy.url, credential: p.credential, ferryVersion: TEST_FERRY_VERSION });
    const adapters = runtimes.adapters(p.home).map((adapter) => (workerOptions.wrap === undefined ? adapter : workerOptions.wrap(adapter)));
    workers.set(login, await workerModule.runWorker({ home: p.home.home, client, adapters, clock }));
    await waitFor(() => existsSync(p.socketPath), { what: `the worker socket of ${login}` });
  };

  const stopWorker: MessagingSystem["stopWorker"] = async (login) => {
    const worker = workers.get(login);
    workers.delete(login);
    await worker?.stop();
  };

  for (const login of stack.participants.keys()) await startWorker(login);

  const makeSession = async (login: string, fake: FakeRuntimeSession, source: string): Promise<Session> => {
    const p = participant(login);
    const call = async (op: string, params: Record<string, unknown>) => callWorker(p.socketPath, op, params);
    const hook: Session["hook"] = (event, fields) => {
      const params: Record<string, unknown> = { runtime: fake.runtime, event: fake.hookInput(event, fields), caller: fake.caller() };
      if (event === "SessionStart") {
        const env = fake.hookEnv();
        params.env = {
          messagingSocket: env.CLAUDE_CODE_MESSAGING_SOCKET,
          messagingToken: env.CLAUDE_CODE_MESSAGING_TOKEN,
          codexHome: env.CODEX_HOME,
        };
      }
      return call(HOOK_OPS[event], params);
    };
    const tool: Session["tool"] = async (name, args = {}) => {
      const reply = await call("tool.call", { tool: name, arguments: args, caller: fake.caller() });
      if (!reply.ok) throw new Error(`the worker refused ${name}: ${reply.error.code} ${reply.error.message}`);
      return reply.result as ToolResult;
    };
    const start = await hook("SessionStart", { source });
    if (!start.ok) throw new Error(`SessionStart failed: ${start.error.code} ${start.error.message}`);
    const startContext = String((start.result as { additionalContext?: unknown }).additionalContext ?? "");
    const whoami = await tool("ferry_whoami");
    const address = whoami.ok ? String(whoami.result!.address ?? "") : "";
    const relay = address === "" ? null : await relaySession(p.http, p.checkout.key, address);
    return {
      login,
      runtime: fake.runtime,
      fake,
      startContext,
      id: relay?.id ?? "",
      address,
      hook,
      tool,
      envelopes: () => parseEnvelopes(fake.received()),
    };
  };

  const system: MessagingSystem = {
    clock,
    homes,
    github,
    proxy,
    runtimes,
    relayUrl: proxy.url,
    participant,
    async startSession(login, runtime, sessionOptions = {}) {
      const p = participant(login);
      const cwd = sessionOptions.where === "linked" ? p.checkout.linked : p.checkout.main;
      const fake = await runtimes.start(runtime, { home: p.home, cwd });
      return makeSession(login, fake, sessionOptions.source ?? "startup");
    },
    async resumeSession(session) {
      return makeSession(session.login, await session.fake.resume(), "resume");
    },
    stopRelay: () => stack.stopRelay(),
    startRelay: () => stack.startRelay(),
    stopWorker,
    startWorker,
    logs: () => stack.logs(),
    expectCheckoutsUnchanged: () => stack.expectCheckoutsUnchanged(),
    async stop() {
      for (const login of [...workers.keys()]) await stopWorker(login);
      await runtimes.stop();
      await stack.stop();
    },
  };
  return system;
}

/** Enrollment through the relay API and the fake device flow (design 3.5). */
async function enroll(relayUrl: string, github: FakeGitHub, clock: Clock, home: TestHome): Promise<{ credential: string; deviceId: string }> {
  const anonymous = new RelayHttp(relayUrl, null);
  const { credential, sha256 } = newCredential();
  const started = await anonymous.post<{ enrollmentId: string; userCode: string; intervalMs: number }>("/v1/enroll/start", {
    deviceName: home.deviceName,
    platform: "linux",
    ferryVersion: TEST_FERRY_VERSION,
    credentialSha256: sha256,
  });
  if (started.status !== 200 && started.status !== 201) throw new Error(`enroll/start answered ${started.status}: ${JSON.stringify(started.body)}`);
  github.authorizeDevice(started.body.userCode, home.githubUserId);
  for (let poll = 0; poll < 20; poll++) {
    if (clock instanceof FakeClock) clock.advance(started.body.intervalMs);
    else await Bun.sleep(started.body.intervalMs);
    const polled = await anonymous.post<{ state: string; device?: { id: string } }>("/v1/enroll/poll", { enrollmentId: started.body.enrollmentId });
    if (polled.body.state === "complete" && polled.body.device !== undefined) return { credential, deviceId: polled.body.device.id };
    if (polled.status !== 202) throw new Error(`enroll/poll answered ${polled.status}: ${JSON.stringify(polled.body)}`);
  }
  throw new Error(`the enrollment of ${home.login} did not complete`);
}

/**
 * Starts a system before each test of the enclosing `describe`, and after each test
 * checks the checkouts and stops it. Returns a getter for the current system.
 */
export function useSystem(options?: Parameters<typeof startSystem>[0]): () => MessagingSystem {
  let current: MessagingSystem | null = null;
  beforeEach(async () => {
    current = await startSystem(options);
  });
  afterEach(async () => {
    const system = current;
    current = null;
    if (system === null) return;
    try {
      system.expectCheckoutsUnchanged();
    } finally {
      await system.stop();
    }
  });
  return () => {
    if (current === null) throw new Error("no messaging system runs");
    return current;
  };
}

/** `creator` makes a conversation, and each of `members` joins it. */
export async function openConversation(
  creator: Session,
  members: readonly Session[],
  args: Readonly<Record<string, unknown>> = {},
): Promise<{ readonly id: string; readonly slug: string }> {
  const created = await creator.tool("ferry_create_conversation", {
    name: "Release coordination",
    purpose: "Coordinate the release of the example app.",
    ...args,
  });
  if (!created.ok) throw new Error(`ferry_create_conversation failed: ${created.error?.code}`);
  const conversation = created.result!.conversation as { id: string; slug: string };
  for (const member of members) {
    const joined = await member.tool("ferry_membership", { conversation: conversation.id, action: "join" });
    if (!joined.ok) throw new Error(`ferry_membership join failed for ${member.address}: ${joined.error?.code}`);
  }
  return { id: conversation.id, slug: conversation.slug };
}

/** The receipts of a message, as the sender's `ferry_receipts` shows them. */
export async function receiptsOf(sender: Session, messageId: string): Promise<Record<string, any>[]> {
  const result = await sender.tool("ferry_receipts", { message: messageId });
  if (!result.ok) throw new Error(`ferry_receipts failed: ${result.error?.code}`);
  return result.result!.receipts as Record<string, any>[];
}

/** Sends a request and returns its message id. */
export async function sendRequest(sender: Session, conversation: string, to: string, body: string): Promise<string> {
  const sent = await sender.tool("ferry_send", { conversation, kind: "request", to, body });
  if (!sent.ok) throw new Error(`ferry_send failed: ${sent.error?.code}`);
  return (sent.result!.message as { id: string }).id;
}

/** Puts a session at an approval prompt, as the `PermissionRequest` hook reports it. */
export async function enterApproval(session: Session): Promise<void> {
  session.fake.setActivity("awaiting-approval");
  await session.hook("PermissionRequest", { tool_name: "Bash" });
}

/** Ends the approval prompt, as the `PostToolUse` hook reports it, and makes the session idle. */
export async function leaveApproval(session: Session): Promise<void> {
  await session.hook("PostToolUse", { tool_name: "Bash" });
  session.fake.setActivity("idle");
}

/** Starts a turn of the human, as `UserPromptSubmit` reports it, and makes the session busy. */
export async function startHumanTurn(session: Session, prompt = "Continue with the task."): Promise<WorkerReply> {
  const reply = await session.hook("UserPromptSubmit", { prompt });
  session.fake.setActivity("busy");
  return reply;
}

/** Ends the current turn, as `Stop` reports it, and makes the session idle. */
export async function endTurn(session: Session): Promise<void> {
  session.fake.setActivity("idle");
  await session.hook("Stop");
}

/** The relay record of a session, by its address, through the relay API (design 7.6). */
export async function relaySession(http: RelayHttp, projectKey: string, address: string): Promise<{ id: string; projectId: string } | null> {
  const project = await http.get<{ project?: { id: string } }>(`/v1/projects?key=${encodeURIComponent(projectKey)}`);
  const projectId = project.body.project?.id;
  if (projectId === undefined) return null;
  const sessions = await http.get<{ sessions?: { id: string; address: string }[] }>(`/v1/projects/${projectId}/sessions?state=all`);
  const found = sessions.body.sessions?.find((session) => session.address === address);
  return found === undefined ? null : { id: found.id, projectId };
}

/** The addresses of the member sessions of a conversation, through the relay API (design 7.6). */
export async function memberAddresses(http: RelayHttp, projectKey: string, conversationId: string): Promise<string[]> {
  const project = await http.get<{ project?: { id: string } }>(`/v1/projects?key=${encodeURIComponent(projectKey)}`);
  const projectId = project.body.project?.id;
  if (projectId === undefined) return [];
  const sessions = await http.get<{ sessions?: { address: string }[] }>(
    `/v1/projects/${projectId}/sessions?state=all&conversationId=${encodeURIComponent(conversationId)}`,
  );
  return (sessions.body.sessions ?? []).map((session) => session.address);
}
