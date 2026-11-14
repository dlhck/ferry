import { afterEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createConnection } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RelayClient } from "../../../src/messaging/client/relay-client.ts";
import { credentialSha256, newDeviceCredential, newId } from "../../../src/messaging/ids.ts";
import { startRelay } from "../../../src/messaging/relay/server.ts";
import { OFFLINE_CONTEXT } from "../../../src/messaging/worker/digest.ts";
import type { RelayTransport } from "../../../src/messaging/worker/outbox.ts";
import { spoolDir, type LocalRequest } from "../../../src/messaging/worker/socket.ts";
import { runWorker, type RunningWorker } from "../../../src/messaging/worker/worker.ts";
import { createFakeRuntimes } from "../fakes/runtimes.ts";
import type { Adapter } from "../../../src/messaging/adapters/types.ts";
import type { FakeRuntimes, FakeRuntimeSession } from "../harness/contracts.ts";
import type { TestHome } from "../harness/homes.ts";
import { VERSION } from "../../../src/version.ts";
import { FakeGitHub } from "../relay/helpers.ts";
import { CONVERSATION, FakeRelay, message, messageId } from "./fake-relay.ts";

const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

class Clock {
  ms = Date.parse("2026-01-05T09:00:00.000Z");
  now(): number {
    return this.ms;
  }
  advance(ms: number): void {
    this.ms += ms;
  }
}

async function waitFor(condition: () => boolean | Promise<boolean>, what: string, ms = 5000): Promise<void> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await condition()) return;
    await Bun.sleep(20);
  }
  throw new Error(`Timed out: ${what}`);
}

function git(cwd: string, ...args: string[]): void {
  const result = Bun.spawnSync(["git", ...args], { cwd, env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" } });
  if (result.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${result.stderr.toString()}`);
}

/** A hash of each file and directory under `root`, `.git` and ignored files included. */
function treeHash(root: string): string {
  const hash = createHash("sha256");
  const walk = (path: string) => {
    for (const name of readdirSync(path).sort()) {
      const child = join(path, name);
      const stat = statSync(child);
      hash.update(`${child}\0${stat.mode}\0${stat.mtimeMs}\0`);
      if (stat.isDirectory()) walk(child);
      else hash.update(readFileSync(child));
    }
  };
  walk(root);
  return hash.digest("hex");
}

type Setup = {
  clock: Clock;
  /** The fake relay. A test that gives its own `client` does not use it. */
  relay: FakeRelay;
  worker: RunningWorker;
  runtimes: FakeRuntimes<Adapter>;
  home: TestHome;
  checkout: string;
  outside: string;
  start(runtime: "claude" | "codex", cwd?: string): Promise<{ session: FakeRuntimeSession; context: string; relayId: string | null }>;
  hook(session: FakeRuntimeSession, op: LocalRequest["op"], event: Parameters<FakeRuntimeSession["hookInput"]>[0], fields?: Record<string, unknown>): Promise<unknown>;
  tool(session: FakeRuntimeSession, tool: string, args: Record<string, unknown>): Promise<{ ok: boolean; result?: unknown; error?: { code: string }; guidance: string }>;
};

let requestCount = 0;

async function setup(options: { offline?: boolean; clock?: Clock; client?: RelayTransport } = {}): Promise<Setup> {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "ferry-worker-")));
  cleanups.push(() => rmSync(root, { recursive: true, force: true }));
  const homeDir = join(root, "alice");
  const codexHome = join(homeDir, ".codex");
  mkdirSync(join(homeDir, ".ferry", "messaging"), { recursive: true, mode: 0o700 });
  mkdirSync(codexHome, { recursive: true });
  const home = {
    login: "alice",
    githubUserId: 1001,
    deviceName: "alice-box",
    home: homeDir,
    messagingDir: join(homeDir, ".ferry", "messaging"),
    relayDir: join(homeDir, ".ferry", "relay"),
    claudeDir: join(homeDir, ".claude"),
    codexHome,
    env: { ...(process.env as Record<string, string>), HOME: homeDir, CODEX_HOME: codexHome },
  };
  const checkout = join(homeDir, "app");
  mkdirSync(checkout);
  git(checkout, "init", "-q");
  git(checkout, "remote", "add", "origin", "git@github.com:Acme/App.git");
  writeFileSync(join(checkout, ".gitignore"), "ignored.txt\n");
  writeFileSync(join(checkout, "ignored.txt"), "local\n");
  git(checkout, "add", ".gitignore");
  git(checkout, "-c", "user.name=Example", "-c", "user.email=operator@example.com", "commit", "-q", "-m", "init");
  git(checkout, "worktree", "add", "-q", join(homeDir, "app-feature"), "-b", "feat/clo-1442-key");
  const outside = join(homeDir, "notes");
  mkdirSync(outside);

  const clock = options.clock ?? new Clock();
  const relay = new FakeRelay(clock);
  relay.offline = options.offline ?? false;
  const runtimes = await createFakeRuntimes({ root: join(root, "rt"), clock });
  cleanups.push(() => runtimes.stop());
  const worker = await runWorker({ home: homeDir, client: options.client ?? relay, adapters: runtimes.adapters(home), clock, tickMs: 0 });
  cleanups.push(() => worker.stop());

  const hook: Setup["hook"] = async (session, op, event, fields) => {
    const env = session.hookEnv();
    const response = await worker.handle({
      v: 1,
      id: String(++requestCount),
      op,
      params: {
        runtime: session.runtime,
        event: session.hookInput(event, fields),
        caller: session.caller(),
        env: { messagingSocket: env.CLAUDE_CODE_MESSAGING_SOCKET, messagingToken: env.CLAUDE_CODE_MESSAGING_TOKEN, codexHome: env.CODEX_HOME },
      },
    });
    if (!response.ok) throw new Error(response.error.message);
    return response.result;
  };
  return {
    clock,
    relay,
    worker,
    runtimes,
    home,
    checkout,
    outside,
    hook,
    async start(runtime, cwd = checkout) {
      const session = await runtimes.start(runtime, { home, cwd });
      const result = (await hook(session, "hook.sessionStart", "SessionStart")) as { additionalContext: string };
      const relayId = worker.store.session(runtime, session.runtimeSessionId)?.relaySessionId ?? null;
      return { session, context: result.additionalContext, relayId };
    },
    async tool(session, tool, args) {
      const response = await worker.handle({ v: 1, id: String(++requestCount), op: "tool.call", params: { tool, arguments: args, caller: session.caller() } });
      if (!response.ok) throw new Error(response.error.message);
      return response.result as Awaited<ReturnType<Setup["tool"]>>;
    },
  };
}

describe("registration", () => {
  test("SessionStart registers the session with the project key and gives the context, and changes nothing in the checkout", async () => {
    const t = await setup();
    const before = treeHash(t.checkout);
    const { context, relayId } = await t.start("claude");
    const registration = t.relay.find("POST", /^\/v1\/sessions$/)[0]!;
    expect(registration.body).toMatchObject({ runtime: "claude", runtimeVersion: "2.1.323", adapter: "supported", repo: { key: "github.com/acme/app" }, source: "startup", worktree: "app" });
    expect(registration.idempotencyKey).toMatch(/^idk_/);
    expect(relayId).toMatch(/^ses_/);
    expect(context).toContain("in project github.com/acme/app");
    expect(context).toContain(join(t.home.home, ".agents", "skills", "ferry-messaging", "SKILL.md"));
    expect(context).toContain("app/production-applies (auto-joined)");
    expect(treeHash(t.checkout)).toBe(before);
    // The token stays in the worker store and never goes to the relay.
    expect(JSON.stringify(t.relay.calls)).not.toContain(t.worker.store.sessions()[0]!.claudeToken!);
  });

  test("a session outside a repository gets no context, and its tools return not-participating", async () => {
    const t = await setup();
    const { session, context } = await t.start("codex", t.outside);
    expect(context).toBe("");
    expect(t.relay.find("POST", /^\/v1\/sessions$/)).toEqual([]);
    const result = await t.tool(session, "ferry_conversations", {});
    expect(result.error?.code).toBe("not-participating");
  });

  test("a second SessionStart in the same process replaces the old session", async () => {
    const t = await setup();
    const { session, relayId } = await t.start("claude");
    await t.hook(session, "hook.sessionStart", "SessionStart", { session_id: "0b9f6a52-0000-4000-8000-00000000c1ea", source: "clear" });
    await waitFor(() => t.relay.find("POST", /\/end$/).length > 0, "end call");
    expect(t.relay.find("POST", /\/end$/)[0]).toMatchObject({ path: `/v1/sessions/${relayId}/end`, body: { reason: "replaced" } });
  });

  test("with the relay offline, the context says so, and the registration arrives later with the same key", async () => {
    const t = await setup({ offline: true });
    const { session, context } = await t.start("codex");
    expect(context).toBe(OFFLINE_CONTEXT);
    expect((await t.tool(session, "ferry_conversations", {})).error?.code).toBe("relay-offline");
    t.relay.offline = false;
    t.clock.advance(2000);
    await t.worker.tick();
    expect(t.relay.find("POST", /^\/v1\/sessions$/)).toHaveLength(1);
    expect((await t.tool(session, "ferry_conversations", {})).ok).toBe(true);
  });
});

describe("tools", () => {
  test("resolves a conversation slug, sends with the causes of a peer turn, and drops them in a human turn", async () => {
    const t = await setup();
    const { session } = await t.start("claude");
    await t.hook(session, "hook.userPromptSubmit", "UserPromptSubmit", { prompt: `<ferry-message id="${messageId(7)}" kind="request">x</ferry-message>` });
    const sent = await t.tool(session, "ferry_send", { conversation: "app/production-applies", kind: "update", body: "The apply finished." });
    expect(sent.ok).toBe(true);
    const calls = t.relay.find("POST", /\/messages$/);
    expect(calls[0]!.path).toBe(`/v1/conversations/${CONVERSATION.id}/messages`);
    expect(calls[0]!.body).toMatchObject({ kind: "update", causeIds: [messageId(7)] });
    await t.hook(session, "hook.userPromptSubmit", "UserPromptSubmit", { prompt: "Thanks, go on." });
    await t.tool(session, "ferry_send", { conversation: CONVERSATION.id, kind: "update", body: "Next step." });
    expect(t.relay.find("POST", /\/messages$/)[1]!.body).not.toHaveProperty("causeIds");
    // The prompt text is not stored.
    expect(JSON.stringify(t.worker.store.sessions())).not.toContain("Thanks, go on.");
  });

  test("refuses a body with a token before it leaves the host", async () => {
    const t = await setup();
    const { session } = await t.start("claude");
    const result = await t.tool(session, "ferry_send", { conversation: CONVERSATION.id, kind: "update", body: `Use ghp_${"a".repeat(36)} for it.` });
    expect(result.error?.code).toBe("secret-in-message");
    const credential = await t.tool(session, "ferry_send", { conversation: CONVERSATION.id, kind: "update", body: `The device key is ${newDeviceCredential()}.` });
    expect(credential.error?.code).toBe("secret-in-message");
    expect(t.relay.find("POST", /\/messages$/)).toEqual([]);
  });

  test("a send while the relay is offline returns queued-offline, and arrives once later", async () => {
    const t = await setup();
    const { session } = await t.start("codex");
    await t.tool(session, "ferry_conversations", {});
    t.relay.offline = true;
    const result = await t.tool(session, "ferry_send", { conversation: CONVERSATION.id, kind: "update", body: "Offline update." });
    expect(result.result).toMatchObject({ state: "queued-offline" });
    expect(result.guidance).toContain("not stored on the relay yet");
    expect(((await t.tool(session, "ferry_receipts", {})).result as { queued: unknown[] }).queued).toHaveLength(1);
    t.relay.offline = false;
    t.clock.advance(1000);
    await t.worker.tick();
    t.clock.advance(60_000);
    await t.worker.tick();
    expect(t.relay.find("POST", /\/messages$/)).toHaveLength(1);
    expect(((await t.tool(session, "ferry_receipts", {})).result as { queued: unknown[] }).queued).toHaveLength(0);
  });

  test("gives the guidance for a stale generation", async () => {
    const t = await setup();
    const { session } = await t.start("claude");
    t.relay.on("POST", /^\/v1\/messages\/ack$/, () => ({ status: 200, body: { items: [{ id: messageId(1), result: "stale-generation" }] } }));
    const result = await t.tool(session, "ferry_ack", { items: [{ id: messageId(1), generation: 2 }] });
    expect(result.guidance).toBe(`${messageId(1)}: This request was reassigned or closed. Do not act on it.`);
  });
});

describe("delivery", () => {
  test("Claude idle: the envelope reaches the session, and the transcript confirms it", async () => {
    const t = await setup();
    const { session, relayId } = await t.start("claude");
    t.relay.deliver(relayId!, message(1, "request"), "dlv_1");
    await t.worker.pollOnce(0);
    await waitFor(() => session.received().length === 1, "envelope");
    expect(session.received()[0]).toContain(`id="${messageId(1)}"`);
    expect(t.relay.find("POST", /\/dispatch$/)[0]!.body).toEqual({ generation: 1, activity: "idle" });
    await t.worker.tick();
    expect(t.relay.results()).toEqual([{ receiptId: "dlv_1", generation: 1, outcome: "delivered", evidence: { kind: "transcript", at: new Date(t.clock.ms).toISOString() }, detail: null } as never]);
    // An idle injection starts a peer turn with the message as cause.
    expect(t.worker.store.session("claude", session.runtimeSessionId)).toMatchObject({ turnOrigin: "peer", turnCauses: [messageId(1)] });
  });

  test("a drop decision injects nothing", async () => {
    const t = await setup();
    const { session, relayId } = await t.start("claude");
    t.relay.decide = () => ({ decision: "drop", reason: "request-reassigned" });
    t.relay.deliver(relayId!, message(1, "request"), "dlv_1");
    await t.worker.pollOnce(0);
    await waitFor(() => t.worker.store.latestAttempt("dlv_1")?.state === "dropped", "dropped");
    await Bun.sleep(60);
    expect(session.received()).toEqual([]);
  });

  test("one re-injection after a turn end and 120 seconds without an ack, and none after an ack", async () => {
    const t = await setup();
    const { session, relayId } = await t.start("claude");
    t.relay.deliver(relayId!, message(1, "request"), "dlv_1");
    t.relay.deliver(relayId!, message(2, "request"), "dlv_2");
    await t.worker.pollOnce(0);
    await waitFor(() => session.received().length === 2, "envelopes");
    await t.worker.tick();
    await t.tool(session, "ferry_ack", { items: [{ id: messageId(2), generation: 1 }] });
    await t.hook(session, "hook.stop", "Stop");
    t.clock.advance(119_000);
    await t.worker.tick();
    expect(t.relay.find("POST", /\/dispatch$/)).toHaveLength(2);
    t.clock.advance(2000);
    await t.worker.tick();
    await waitFor(() => session.received().length === 3, "re-injection");
    expect(session.received()[2]).toContain(messageId(1));
    await t.worker.tick();
    await t.hook(session, "hook.stop", "Stop");
    t.clock.advance(200_000);
    await t.worker.tick();
    expect(t.relay.find("POST", /\/dispatch$/).map((call) => call.path)).toEqual(["/v1/deliveries/dlv_1/dispatch", "/v1/deliveries/dlv_2/dispatch", "/v1/deliveries/dlv_1/dispatch"]);
  });

  test("Codex: the queued envelope runs when the thread is idle", async () => {
    const t = await setup();
    const { session, relayId } = await t.start("codex");
    session.setActivity("busy");
    t.relay.deliver(relayId!, message(1, "request"), "dlv_1");
    await t.worker.pollOnce(0);
    await waitFor(() => t.worker.store.latestAttempt("dlv_1")?.state === "injected", "queued");
    await Bun.sleep(60);
    expect(session.received()).toEqual([]);
    session.setActivity("idle");
    await waitFor(() => session.received().length === 1, "consumed");
    await t.worker.tick();
    expect(t.relay.results().map((result) => [result.outcome, result.evidence?.kind])).toEqual([["delivered", "transcript"]]);
  });

  test("Codex stranded: the thread stops with the row queued, the resume context says not to act, and the row runs on resume", async () => {
    const t = await setup();
    const { session, relayId } = await t.start("codex");
    session.setActivity("busy");
    t.relay.deliver(relayId!, message(1, "request"), "dlv_1");
    await t.worker.pollOnce(0);
    await waitFor(() => t.worker.store.latestAttempt("dlv_1")?.state === "injected", "queued");
    await session.crash();
    await t.worker.tick();
    expect(t.relay.results().map((result) => result.outcome)).toEqual(["stranded"]);
    const resumed = await session.resume();
    const context = (await t.hook(resumed, "hook.sessionStart", "SessionStart", { source: "resume" })) as { additionalContext: string };
    expect(context.additionalContext).toContain(`${messageId(1)} (closed or moved to another session: do not act on it)`);
    await waitFor(() => resumed.received().length === 1, "late row");
  });

  test("a delivery to a stopped session reports offline and does not start it", async () => {
    const t = await setup();
    const { session, relayId } = await t.start("claude");
    await session.crash();
    t.relay.deliver(relayId!, message(1, "request"), "dlv_1");
    await t.worker.pollOnce(0);
    await waitFor(() => t.relay.results().length > 0, "result");
    expect(t.relay.results()[0]!.outcome).toBe("offline");
    expect(t.relay.find("POST", /\/dispatch$/)).toEqual([]);
    await waitFor(() => t.relay.find("POST", /\/end$/).length > 0, "end");
    expect(t.relay.find("POST", /\/end$/)[0]!.body).toEqual({ reason: "crash" });
  });

  test("an update goes into the next prompt digest and is reported with context-digest", async () => {
    const t = await setup();
    const { session, relayId } = await t.start("claude");
    t.relay.deliver(relayId!, message(1, "update", "The apply started."), "dlv_1");
    await t.worker.pollOnce(0);
    await waitFor(() => t.worker.store.digest(relayId!).length === 1, "digest");
    expect(t.relay.find("POST", /\/dispatch$/)).toEqual([]);
    const result = (await t.hook(session, "hook.userPromptSubmit", "UserPromptSubmit", { prompt: "Go on." })) as { additionalContext: string };
    expect(result.additionalContext).toContain(`Update ${messageId(1)} in production-applies from @bob/claude-q8w2er: "The apply started."`);
    await waitFor(() => t.relay.results().length === 1, "result");
    expect(t.relay.results()[0]).toMatchObject({ receiptId: "dlv_1", outcome: "delivered", evidence: { kind: "context-digest" }, generation: 0 });
    expect(((await t.hook(session, "hook.userPromptSubmit", "UserPromptSubmit", { prompt: "Again." })) as { additionalContext: string | null }).additionalContext).toBeNull();
  });

  test("a request that the hop limit holds goes into the digest of the next human turn only", async () => {
    const t = await setup();
    const { session, relayId } = await t.start("claude");
    t.relay.decide = () => ({ decision: "hold", hold: "wake-hops" });
    t.relay.deliver(relayId!, message(1, "request"), "dlv_1");
    await t.worker.pollOnce(0);
    await waitFor(() => t.worker.store.digest(relayId!).length === 1, "digest");
    const peer = (await t.hook(session, "hook.userPromptSubmit", "UserPromptSubmit", { prompt: `<ferry-message id="${messageId(5)}">` })) as { additionalContext: string | null };
    expect(peer.additionalContext).toBeNull();
    const human = (await t.hook(session, "hook.userPromptSubmit", "UserPromptSubmit", { prompt: "What is next?" })) as { additionalContext: string };
    expect(human.additionalContext).toContain(`Request ${messageId(1)}`);
    expect(human.additionalContext).toContain("held by the hop limit");
    expect(session.received()).toEqual([]);
  });

  test("the frame check marks a Claude version unconfirmed after three unconfirmed idle deliveries", async () => {
    const t = await setup();
    const { session, relayId } = await t.start("claude");
    // The fake holds each frame, so no id reaches the transcript. The worker sees an idle session.
    session.setActivity("awaiting-approval");
    for (const n of [1, 2, 3]) t.relay.deliver(relayId!, message(n, "request"), `dlv_${n}`);
    await t.worker.pollOnce(0);
    await waitFor(() => ["dlv_1", "dlv_2", "dlv_3"].every((id) => t.worker.store.latestAttempt(id)?.state === "injected"), "injected");
    t.clock.advance(60_000);
    await t.worker.tick();
    expect(t.relay.results().map((result) => result.outcome)).toEqual(["unconfirmed", "unconfirmed", "unconfirmed"]);
    expect(t.relay.find("PATCH", /^\/v1\/sessions\//)[0]!.body).toMatchObject({ adapter: "unconfirmed" });
    expect((await t.worker.status()).sessions[0]!.adapter).toBe("unconfirmed");
    // A later arrival in the 24-hour watch still counts as delivered.
    session.setActivity("idle");
    await waitFor(() => session.received().length === 3, "late frames");
    t.clock.advance(3600_000);
    await t.worker.tick();
    expect(t.relay.results().filter((result) => result.outcome === "delivered")).toHaveLength(3);
  });

  test("the approval state goes to the relay in the dispatch and at once in a heartbeat", async () => {
    const t = await setup();
    const { session, relayId } = await t.start("claude");
    await t.hook(session, "hook.permissionRequest", "PermissionRequest");
    await waitFor(() => t.relay.find("POST", /heartbeat$/).length === 1, "heartbeat");
    expect(t.relay.find("POST", /heartbeat$/)[0]!.body).toEqual({ sessions: [{ id: relayId, state: "live", activity: "awaiting-approval" }] });
    t.relay.decide = () => ({ decision: "hold", hold: "awaiting-approval" });
    t.relay.deliver(relayId!, message(1, "request"), "dlv_1");
    await t.worker.pollOnce(0);
    await waitFor(() => t.worker.store.latestAttempt("dlv_1")?.state === "held", "held");
    expect(t.relay.find("POST", /\/dispatch$/)[0]!.body).toEqual({ generation: 1, activity: "awaiting-approval" });
    await t.hook(session, "hook.postToolUse", "PostToolUse");
    await waitFor(() => t.relay.find("POST", /heartbeat$/).length === 2, "heartbeat after the approval");
  });
});

describe("liveness and socket", () => {
  test("a crashed session goes offline at the next periodic check", async () => {
    const t = await setup();
    const { session, relayId } = await t.start("codex");
    await session.crash();
    t.clock.advance(30_000);
    await t.worker.tick();
    await waitFor(() => t.relay.find("POST", /\/end$/).length === 1, "end");
    expect(t.relay.find("POST", /\/end$/)[0]).toMatchObject({ path: `/v1/sessions/${relayId}/end`, body: { reason: "crash" } });
    expect(t.worker.store.session("codex", session.runtimeSessionId)?.state).toBe("offline");
  });

  test("a normal Codex exit removes the lock, and SessionEnd reports exit", async () => {
    const t = await setup();
    const { session } = await t.start("codex");
    await t.hook(session, "hook.sessionEnd", "SessionEnd", { reason: "exit" });
    await session.exit();
    expect(existsSync(join(t.home.codexHome, "thread-writer-locks", `${session.runtimeSessionId}.lock`))).toBe(false);
    await waitFor(() => t.relay.find("POST", /\/end$/).length === 1, "end");
    expect(t.relay.find("POST", /\/end$/)[0]!.body).toEqual({ reason: "exit" });
  });

  test("answers line requests on the socket, and replays the spool at start", async () => {
    const t = await setup();
    const session = await t.runtimes.start("claude", { home: t.home, cwd: t.checkout });
    await t.worker.stop();
    cleanups.pop();
    const env = session.hookEnv();
    mkdirSync(spoolDir(t.home.home), { recursive: true });
    const spooled: LocalRequest = {
      v: 1,
      id: "spool-1",
      op: "hook.sessionStart",
      params: { runtime: "claude", event: session.hookInput("SessionStart"), caller: session.caller(), env: { messagingSocket: env.CLAUDE_CODE_MESSAGING_SOCKET, messagingToken: env.CLAUDE_CODE_MESSAGING_TOKEN } },
    };
    writeFileSync(join(spoolDir(t.home.home), `${t.clock.ms}-123.json`), JSON.stringify(spooled), { mode: 0o600 });
    const worker = await runWorker({ home: t.home.home, client: t.relay, adapters: t.runtimes.adapters(t.home), clock: t.clock, tickMs: 0 });
    cleanups.push(() => worker.stop());
    expect(readdirSync(spoolDir(t.home.home))).toEqual([]);
    expect(worker.store.session("claude", session.runtimeSessionId)?.relaySessionId).toMatch(/^ses_/);
    const lines = await new Promise<string[]>((resolve, reject) => {
      const connection = createConnection({ path: worker.socketPath });
      let buffer = "";
      connection.setEncoding("utf8");
      connection.on("connect", () => connection.write(`${JSON.stringify({ v: 1, id: "a", op: "status", params: {} })}\nnot json\n`));
      connection.on("data", (chunk: string) => {
        buffer += chunk;
        const done = buffer.split("\n").filter(Boolean);
        if (done.length === 2) {
          connection.end();
          resolve(done);
        }
      });
      connection.on("error", reject);
    });
    const status = JSON.parse(lines[0]!);
    expect(status).toMatchObject({ v: 1, id: "a", ok: true, result: { revoked: false, sessions: [{ runtime: "claude", state: "live", adapter: "supported" }] } });
    expect(JSON.parse(lines[1]!)).toMatchObject({ ok: false, error: { code: "invalid-request" } });
    expect(statSync(join(t.home.home, ".ferry", "messaging", "worker.sqlite")).mode & 0o777).toBe(0o600);
  });
});

// ---------------------------------------------------------------------------
// Layer 2 with lane A's relay: a real relay on a free port, with a fake GitHub,
// and lane B's RelayClient.

/** Send one call. Throw when the relay answers with an error. */
async function ok(client: RelayTransport, method: "GET" | "POST", path: string, body?: unknown): Promise<any> {
  const idempotencyKey = method === "POST" && !path.startsWith("/v1/enroll/") ? newId("idempotencyKey") : undefined;
  const answer = await client.request({ method, path, body, idempotencyKey });
  if (answer.status >= 300) throw new Error(`${method} ${path}: HTTP ${answer.status} ${JSON.stringify(answer.body)}`);
  return answer.body;
}

async function relayWorld() {
  const clock = new Clock();
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "ferry-worker-relay-")));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  const github = new FakeGitHub();
  github.addRepo("acme/app", 4242);
  const relay = await startRelay({ github, clock, log: () => {}, allowedOwners: ["acme"], dbPath: join(dir, "relay.db"), listen: "127.0.0.1:0" });
  cleanups.push(() => relay.stop());

  const client = (credential: string | null): RelayTransport => new RelayClient({ url: relay.url, credential, ferryVersion: VERSION });
  const enroll = async (login: string, githubUserId: number): Promise<RelayTransport> => {
    github.addUser(login, githubUserId);
    github.grant(login, "acme/app", "write");
    const credential = newDeviceCredential();
    const started = await ok(client(null), "POST", "/v1/enroll/start", { deviceName: `${login}-box`, platform: "linux", ferryVersion: VERSION, credentialSha256: credentialSha256(credential) });
    github.polls.push({ state: "complete", user: { id: githubUserId, login } });
    await ok(client(null), "POST", "/v1/enroll/poll", { enrollmentId: started.enrollmentId });
    return client(credential);
  };

  const alice = await enroll("alice", 1001);
  const bob = await enroll("bob", 1002);
  const registered = await ok(bob, "POST", "/v1/sessions", {
    runtime: "codex",
    runtimeSessionId: "bob-thread",
    runtimeVersion: "0.169.0",
    adapter: "supported",
    repo: { key: "github.com/acme/app" },
    branch: "main",
    head: null,
    worktree: "app",
    task: null,
    source: "startup",
  });
  const bobSession = registered.session as { id: string };
  const conversation = (await ok(bob, "POST", `/v1/projects/${registered.project.id}/conversations`, { sessionId: bobSession.id, name: "Production applies", purpose: "Coordinate applies to production.", autoJoin: "all", force: true })).conversation as { id: string };
  const t = await setup({ clock, client: alice });
  const send = (body: Record<string, unknown>) => ok(bob, "POST", `/v1/conversations/${conversation.id}/messages`, { sessionId: bobSession.id, ...body });
  return { t, bob, conversation, send };
}

describe("with lane A's relay", () => {
  test("SessionStart registers through the relay and auto-joins the conversation", async () => {
    const r = await relayWorld();
    const { session, context, relayId } = await r.t.start("claude");
    expect(relayId).toMatch(/^ses_/);
    expect(context).toContain("in project github.com/acme/app");
    expect(context).toContain("app/production-applies (auto-joined)");
    const listed = await r.t.tool(session, "ferry_conversations", {});
    expect(listed.ok).toBe(true);
    expect(JSON.stringify(listed.result)).toContain(r.conversation.id);
  });

  test("a request of another owner reaches an idle Claude session, the transcript confirms it, and the ack and the answer close it", async () => {
    const r = await relayWorld();
    const { session } = await r.t.start("claude");
    const address = r.t.worker.store.session("claude", session.runtimeSessionId)!.address!;
    const request = (await r.send({ kind: "request", body: "Has the apply finished?", to: address })).message as { id: string };
    await r.t.worker.pollOnce(0);
    await waitFor(() => session.received().length === 1, "envelope");
    expect(session.received()[0]).toContain(`id="${request.id}"`);
    await r.t.worker.tick();
    const delivered = await ok(r.bob, "GET", `/v1/messages/${request.id}`);
    expect(delivered.receipts).toMatchObject([{ state: "delivered" }]);
    expect(delivered.receipts[0].evidence.map((evidence: { kind: string }) => evidence.kind)).toContain("transcript");

    const acked = await r.t.tool(session, "ferry_ack", { items: [{ id: request.id, generation: 1 }] });
    expect(acked.result).toMatchObject({ items: [{ id: request.id, result: "acknowledged" }] });
    const answered = await r.t.tool(session, "ferry_send", { conversation: r.conversation.id, kind: "answer", answers: request.id, generation: 1, body: "Yes, it finished." });
    expect(answered.ok).toBe(true);
    expect((await ok(r.bob, "GET", `/v1/messages/${request.id}`)).message.request).toMatchObject({ status: "answered" });
  });

  test("an update goes into the next prompt digest of a Codex thread, and the relay records context-digest", async () => {
    const r = await relayWorld();
    const { session, relayId } = await r.t.start("codex");
    const update = (await r.send({ kind: "update", body: "The apply finished." })).message as { id: string };
    await r.t.worker.pollOnce(0);
    await waitFor(() => r.t.worker.store.digest(relayId!).length === 1, "digest");
    expect(session.received()).toEqual([]);
    const digest = (await r.t.hook(session, "hook.userPromptSubmit", "UserPromptSubmit", { prompt: "Go on." })) as { additionalContext: string };
    expect(digest.additionalContext).toContain(`Update ${update.id} in production-applies`);
    expect(digest.additionalContext).toContain("The apply finished.");
    await r.t.worker.tick();
    const receipts = (await ok(r.bob, "GET", `/v1/messages/${update.id}`)).receipts;
    expect(receipts).toMatchObject([{ state: "delivered" }]);
    expect(receipts[0].evidence.map((evidence: { kind: string }) => evidence.kind)).toContain("context-digest");
  });
});
