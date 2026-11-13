/**
 * Helpers of the relay tests: a fake clock, a fake `GitHubAccess`, and a client
 * that calls `relay.handle` with a `Request`, without a socket.
 *
 * Lane E's harness and lane B's fake GitHub server replace the fakes here when they merge.
 */

import { afterEach } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { credentialSha256, newDeviceCredential, newId } from "../../../src/messaging/ids.ts";
import { HEADERS, validate, type Schema, type SessionRegistered } from "../../../src/messaging/protocol.ts";
import type { GitHubAccess } from "../../../src/messaging/relay/access.ts";
import { createRelay, type Relay } from "../../../src/messaging/relay/server.ts";
import { openStore, type Store } from "../../../src/messaging/relay/store.ts";

export const START = Date.parse("2026-11-13T10:00:00.000Z");

export class FakeClock {
  ms: number;
  constructor(start = START) {
    this.ms = start;
  }
  now(): number {
    return this.ms;
  }
  advance(ms: number): void {
    this.ms += ms;
  }
}

/** An error with the `name` of one of lane B's error classes. */
export function namedError(name: string, message: string): Error {
  const error = new Error(message);
  error.name = name;
  return error;
}

type Repo = { repoId: number; installationId: number };

/** A fake of the GitHub calls of the relay. The test changes its maps to change GitHub. */
export class FakeGitHub implements GitHubAccess {
  users = new Map<string, number>();
  repos = new Map<string, Repo>();
  /** `<login>@<owner>/<repo>` to the permission. A missing entry is `none`. */
  permissions = new Map<string, "admin" | "write" | "read" | "none">();
  /** The next results of `pollDeviceFlow`, in order. */
  polls: ({ state: "pending" | "slow-down" | "expired" | "denied" } | { state: "complete"; user: { id: number; login: string } })[] = [];
  unavailable = false;
  /** An error that `startDeviceFlow` and `pollDeviceFlow` throw. Lane B's client tells its errors apart by `name`. */
  flowError: Error | null = null;
  uninstalled = new Set<string>();
  calls: string[] = [];
  private codes = 0;

  addUser(login: string, id: number): void {
    this.users.set(login, id);
  }

  addRepo(fullName: string, repoId: number, installationId = 77): void {
    this.repos.set(fullName.toLowerCase(), { repoId, installationId });
  }

  grant(login: string, fullName: string, permission: "admin" | "write" | "read" | "none"): void {
    this.permissions.set(`${login}@${fullName.toLowerCase()}`, permission);
  }

  async startDeviceFlow() {
    this.calls.push("startDeviceFlow");
    if (this.flowError !== null) throw this.flowError;
    if (this.unavailable) throw namedError("GitHubUnavailableError", "network");
    this.codes++;
    return { deviceCode: `device-code-${this.codes}`, userCode: `ABCD-${1000 + this.codes}`, verificationUri: "https://github.com/login/device", expiresInS: 900, intervalS: 5 };
  }

  async pollDeviceFlow(deviceCode: string) {
    this.calls.push(`pollDeviceFlow ${deviceCode}`);
    if (this.flowError !== null) throw this.flowError;
    return this.polls.shift() ?? { state: "pending" as const };
  }

  async resolveRepository(owner: string, repo: string) {
    this.calls.push(`resolveRepository ${owner}/${repo}`);
    if (this.unavailable) return { state: "unavailable" as const };
    const fullName = `${owner}/${repo}`.toLowerCase();
    const found = this.repos.get(fullName);
    if (found === undefined) return { state: "not-found" as const };
    if (this.uninstalled.has(owner.toLowerCase())) return { state: "app-not-installed" as const };
    return { state: "ok" as const, repoId: found.repoId, fullName, installationId: found.installationId };
  }

  async permission(installationId: number, fullName: string, login: string) {
    this.calls.push(`permission ${installationId} ${fullName} ${login}`);
    if (this.unavailable || this.uninstalled.has(fullName.split("/")[0] ?? "")) return { state: "unavailable" as const };
    return { state: "ok" as const, permission: this.permissions.get(`${login}@${fullName}`) ?? "none", roleName: null };
  }

  async currentLogin(userId: number) {
    if (this.unavailable) return null;
    for (const [login, id] of this.users) if (id === userId) return login;
    return null;
  }

  appSlug(): string {
    return "acme-ferry-relay";
  }
}

export type Reply<T = any> = { status: number; body: T; headers: Headers };

export type Device = { credential: string; deviceId: string; ownerId: string; login: string };

export type Session = { id: string; address: string; device: Device };

export const REPO = "github.com/acme/vendure-cloud";

const homes: string[] = [];
const closers: (() => void)[] = [];

afterEach(() => {
  for (const close of closers.splice(0)) close();
  for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true });
});

export function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "ferry-relay-"));
  homes.push(dir);
  return dir;
}

export type World = {
  clock: FakeClock;
  github: FakeGitHub;
  store: Store;
  relay: Relay;
  dir: string;
  logs: string[];
  call<T = any>(method: string, path: string, options?: { body?: unknown; device?: Device; key?: string; headers?: Record<string, string> }): Promise<Reply<T>>;
  /** Like `call`, but fail the test when the status is not `status`. With a schema, the body must match it. */
  ok<T = any>(method: string, path: string, body?: unknown, device?: Device, status?: number, schema?: Schema<T>): Promise<T>;
  enroll(login: string, id?: number): Promise<Device>;
  /** A second device for the owner of `device`. */
  addDevice(device: Device, name?: string): Promise<Device>;
  register(device: Device, options?: Partial<{ runtime: "claude" | "codex"; runtimeSessionId: string; branch: string | null; repo: string | null; adapter: string }>): Promise<SessionRegistered & { me: Session }>;
  heartbeat(device: Device, sessions?: { id: string; state?: "live" | "offline"; activity?: "idle" | "busy" | "awaiting-approval" | null }[]): Promise<void>;
  conversation(session: Session, name: string, extra?: Record<string, unknown>): Promise<string>;
  join(session: Session, conversationId: string): Promise<void>;
  send(session: Session, conversationId: string, body: Record<string, unknown>): Promise<Reply>;
  receiptOf(messageId: string, sessionId: string): any;
  /** `maintain` of the relay. */
  tick(ms?: number): Promise<void>;
};

let runtimeIds = 0;

export function world(options: { allowedOwners?: string[]; dir?: string; clock?: FakeClock; github?: FakeGitHub } = {}): World {
  const dir = options.dir ?? tempDir();
  const clock = options.clock ?? new FakeClock();
  const github = options.github ?? new FakeGitHub();
  if (!github.repos.has("acme/vendure-cloud")) github.addRepo("acme/vendure-cloud", 4242);
  const store = openStore(join(dir, "relay.db"), clock);
  const logs: string[] = [];
  const relay = createRelay(store, {
    github,
    clock,
    log: (event, fields) => logs.push(`${event} ${JSON.stringify(fields ?? {})}`),
    allowedOwners: options.allowedOwners ?? ["acme"],
    relayVersion: "0.13.0",
  });
  closers.push(() => {
    relay.close();
    store.close();
  });

  const call: World["call"] = async (method, path, callOptions = {}) => {
    const headers: Record<string, string> = { [HEADERS.protocol]: "1", [HEADERS.version]: "0.13.0", ...callOptions.headers };
    if (callOptions.device !== undefined) headers.authorization = `Bearer ${callOptions.device.credential}`;
    if (method !== "GET" && !path.startsWith("/v1/enroll/") && callOptions.key !== "") {
      headers[HEADERS.idempotencyKey] = callOptions.key ?? newId("idempotencyKey", clock.now());
    }
    const init: RequestInit = { method, headers };
    if (callOptions.body !== undefined) {
      init.body = typeof callOptions.body === "string" ? callOptions.body : JSON.stringify(callOptions.body);
      headers["content-type"] = "application/json";
    }
    const response = await relay.handle(new Request(`http://relay.test${path}`, init));
    const text = await response.text();
    return { status: response.status, body: text.length > 0 ? JSON.parse(text) : null, headers: response.headers };
  };

  const ok: World["ok"] = async (method, path, body, device, status = 200, schema) => {
    const reply = await call(method, path, { body, device });
    if (reply.status !== status) throw new Error(`${method} ${path}: expected ${status}, got ${reply.status}: ${JSON.stringify(reply.body)}`);
    if (schema !== undefined) {
      const result = validate(schema, reply.body);
      if (!result.ok) throw new Error(`${method} ${path}: the response does not match the schema: ${result.issues.join("; ")}`);
    }
    return reply.body;
  };

  const self: World = {
    clock,
    github,
    store,
    relay,
    dir,
    logs,
    call,
    ok,
    async enroll(login, id) {
      const userId = id ?? 1000 + github.users.size + 1;
      github.addUser(login, userId);
      github.grant(login, "acme/vendure-cloud", "write");
      const credential = newDeviceCredential();
      const started = await ok("POST", "/v1/enroll/start", {
        deviceName: `${login}-laptop`,
        platform: "linux",
        ferryVersion: "0.13.0",
        credentialSha256: credentialSha256(credential),
      });
      github.polls.push({ state: "complete", user: { id: userId, login } });
      const done = await ok("POST", "/v1/enroll/poll", { enrollmentId: started.enrollmentId });
      return { credential, deviceId: done.device.id, ownerId: done.owner.id, login };
    },
    async addDevice(device, name = "box") {
      const credential = newDeviceCredential();
      const created = await ok("POST", "/v1/devices", { name, platform: "linux", credentialSha256: credentialSha256(credential) }, device, 201);
      return { credential, deviceId: created.device.id, ownerId: device.ownerId, login: device.login };
    },
    async register(device, registerOptions = {}) {
      const runtime = registerOptions.runtime ?? "claude";
      const body = {
        runtime,
        runtimeSessionId: registerOptions.runtimeSessionId ?? `runtime-${++runtimeIds}`,
        runtimeVersion: runtime === "claude" ? "2.1.323" : "0.169.0",
        adapter: registerOptions.adapter ?? "supported",
        repo: registerOptions.repo === null ? null : { key: registerOptions.repo ?? REPO },
        branch: registerOptions.branch === undefined ? "main" : registerOptions.branch,
        head: null,
        worktree: "vendure-cloud",
        task: null,
        source: "startup",
      };
      const registered = await ok("POST", "/v1/sessions", body, device);
      return { ...registered, me: { id: registered.session.id, address: registered.session.address, device } };
    },
    async heartbeat(device, sessions = []) {
      await ok(
        "POST",
        "/v1/worker/heartbeat",
        { sessions: sessions.map((entry) => ({ id: entry.id, state: entry.state ?? "live", activity: entry.activity === undefined ? "idle" : entry.activity })) },
        device,
      );
    },
    async conversation(session, name, extra = {}) {
      const project = store.db.query<{ project_id: string }, [string]>("SELECT project_id FROM sessions WHERE id = ?").get(session.id)?.project_id;
      const created = await ok(
        "POST",
        `/v1/projects/${project}/conversations`,
        { sessionId: session.id, name, purpose: `Coordinate ${name}.`, force: true, ...extra },
        session.device,
        201,
      );
      return created.conversation.id;
    },
    async join(session, conversationId) {
      await ok("POST", `/v1/conversations/${conversationId}/join`, { sessionId: session.id }, session.device);
    },
    async send(session, conversationId, body) {
      return call("POST", `/v1/conversations/${conversationId}/messages`, { body: { sessionId: session.id, ...body }, device: session.device });
    },
    receiptOf(messageId, sessionId) {
      return store.db
        .query("SELECT * FROM receipts WHERE message_id = ? AND recipient_session_id = ? ORDER BY generation DESC LIMIT 1")
        .get(messageId, sessionId);
    },
    async tick(ms = 0) {
      clock.advance(ms);
      await relay.maintain();
    },
  };
  return self;
}

/** Two owners, alice and bob, each with one live session in the project and in one conversation. */
export async function pair(w: World = world()) {
  const aliceDevice = await w.enroll("alice");
  const bobDevice = await w.enroll("bob");
  const alice = (await w.register(aliceDevice)).me;
  const bob = (await w.register(bobDevice, { runtime: "codex" })).me;
  const conversation = await w.conversation(alice, "production applies");
  await w.join(bob, conversation);
  return { w, alice, bob, aliceDevice, bobDevice, conversation };
}

/** Send a request from `from` to `to` and return the message id. */
export async function request(w: World, from: Session, to: Session, conversation: string, body = "Has the key-authority apply finished?"): Promise<string> {
  const reply = await w.send(from, conversation, { kind: "request", body, to: to.address });
  if (reply.status !== 201) throw new Error(`request: ${reply.status} ${JSON.stringify(reply.body)}`);
  return reply.body.message.id;
}

/** Dispatch the current receipt of a session for a message. */
export async function dispatchFor(w: World, session: Session, messageId: string, activity: "idle" | "busy" | "awaiting-approval" = "idle"): Promise<Reply> {
  const receipt = w.receiptOf(messageId, session.id);
  return w.call("POST", `/v1/deliveries/${receipt.id}/dispatch`, { body: { generation: receipt.generation, activity }, device: session.device });
}

export async function deliver(w: World, session: Session, messageId: string, kind: "transcript" | "codex-queue-consumed" | "context-digest" = "transcript"): Promise<Reply> {
  const receipt = w.receiptOf(messageId, session.id);
  return w.call("POST", `/v1/deliveries/${receipt.id}/result`, {
    body: { generation: receipt.generation, outcome: "delivered", evidence: { kind, at: new Date(w.clock.now()).toISOString() }, detail: null },
    device: session.device,
  });
}
