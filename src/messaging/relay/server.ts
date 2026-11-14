/**
 * The relay server: the HTTP endpoints of design section 7 on one SQLite store.
 *
 * - `startRelay` takes the relay lock, opens the store, listens on
 *   `127.0.0.1:47830` by default with plain HTTP (a TLS front gives the team
 *   URL), and runs the background work every 5 seconds.
 * - `createRelay` is the same relay without a socket and without timers. Tests
 *   call `handle` with a `Request` and `maintain` with a fake clock.
 *
 * Each mutating call, except `/v1/enroll/*`, has an `Idempotency-Key`. The
 * domain modules check access first (that can ask GitHub), then return a
 * synchronous step. The relay runs that step and stores the response for the
 * key in one transaction, so a retry after a crash never applies a change twice.
 *
 * Logs have the method, the path, the status, and ids. They never have a body,
 * a credential, or a token.
 */

import { createHash, randomBytes } from "node:crypto";
import { dirname } from "node:path";
import { credentialSha256, isDeviceCredential, isId, newId } from "../ids.ts";
import {
  Ack,
  ConstraintAction,
  ConstraintCreate,
  ConversationCreate,
  DeliveryResult,
  DeviceCreate,
  Dispatch,
  ERROR_STATUS,
  EnrollPoll,
  EnrollStart,
  HEADERS,
  Heartbeat,
  LIMITS,
  MessageCreate,
  PROTOCOL_VERSION,
  RequestAction,
  SessionCall,
  SessionEnd,
  SessionRegister,
  SessionUpdate,
  errorBody,
  validate,
  type EnrollPolled,
  type RelayEvent,
  type Schema,
} from "../protocol.ts";
import { checkAccess, getProject, recheckGrants, resolveProject, type Access, type GitHubAccess } from "./access.ts";
import { backupStore } from "./backup.ts";
import { constraintAction, createConstraint, listConstraints } from "./constraints.ts";
import {
  getConversation,
  getMessage,
  joinContext,
  messageView,
  messagesPage,
  ownerView,
  receiptView,
  receiptsOf,
  sessionInfo,
  type SessionRow,
} from "./context.ts";
import { createConversation, join, leave, listConversations, listSessions } from "./conversations.ts";
import { EVENTS_PER_POLL, LONG_POLL_MAX_MS, PAGE_LIMIT, RETENTION } from "./limits.ts";
import { dispatch, maintainReceipts, pending, recordResult } from "./receipts.ts";
import { ack, listRequests, requestAction, sendMessage } from "./requests.ts";
import { endSession, heartbeat, markStaleWorkers, ownSession, registerSession, retireMemberships, updateSession, type DeviceRow } from "./sessions.ts";
import { RelayError, acquireRelayLock, emit, getMeta, iso, openStore, setMeta, type Clock, type Store } from "./store.ts";

export type { GitHubAccess } from "./access.ts";

export type RelayLog = (event: string, fields?: Readonly<Record<string, string | number | boolean | null>>) => void;

export type RelayOptions = {
  readonly github: GitHubAccess;
  readonly clock: Clock;
  readonly log: RelayLog;
  /** The repository owners that this relay serves (`allowedOwners` of `config.json`). */
  readonly allowedOwners: readonly string[];
  readonly relayVersion?: string;
  /** Clients with a lower `Ferry-Version` get `426 upgrade-required`. */
  readonly minClientVersion?: string;
};

export type Relay = {
  handle(request: Request): Promise<Response>;
  /** The background work: stale workers, retries, wake-rate releases, access rechecks, retention, and the daily backup. */
  maintain(): Promise<void>;
  /** End the waiting long polls. */
  close(): void;
};

export const DEFAULT_LISTEN = "127.0.0.1:47830";
const MAINTAIN_MS = 5_000;
const ENROLLMENT_DONE_MS = 10 * 60_000;

type Reply = { status: number; apply: () => unknown };
type Route = {
  method: "GET" | "POST" | "PATCH";
  pattern: RegExp;
  auth: boolean;
  handler: (call: Call) => Promise<Reply> | Reply;
};
type Call = {
  params: string[];
  query: URLSearchParams;
  body: unknown;
  device: DeviceRow | null;
  signal: AbortSignal;
};

type Enrollment = {
  deviceCode: string;
  deviceName: string;
  platform: "linux" | "darwin";
  credentialSha256: string;
  intervalMs: number;
  expiresAt: number;
  done: { result: Extract<EnrollPolled, { state: "complete" }>; at: number } | null;
};

function reply(status: number, value: unknown): Reply {
  return { status, apply: () => value };
}

function parse<T>(schema: Schema<T>, value: unknown): T {
  const result = validate(schema, value);
  if (!result.ok) throw new RelayError("invalid-request", "The request body is not valid.", null, { issues: result.issues });
  return result.value;
}

function versionBelow(version: string, minimum: string): boolean {
  const parts = (text: string) => (text.split("-")[0] ?? "").split(".").map((part) => Number.parseInt(part, 10) || 0);
  const a = parts(version);
  const b = parts(minimum);
  for (let index = 0; index < 3; index++) {
    if ((a[index] ?? 0) !== (b[index] ?? 0)) return (a[index] ?? 0) < (b[index] ?? 0);
  }
  return false;
}

function json(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json; charset=utf-8", ...headers } });
}

function errorResponse(error: RelayError): Response {
  const status = ERROR_STATUS[error.code];
  const headers: Record<string, string> = {};
  const retry = error.details?.retryAfterMs;
  if (error.code === "rate-limited" && typeof retry === "number") headers["retry-after"] = String(Math.ceil(retry / 1000));
  return json(status, errorBody(error.code, error.message, error.hint, error.details), headers);
}

/**
 * The relay error for an error of the GitHub device flow. The GitHub client
 * throws `GitHubUnavailableError` when GitHub does not answer,
 * `DeviceFlowDisabledError` when the App has the device flow off, and a plain
 * `Error` for an OAuth error that a poll cannot fix. Other errors are bugs, and
 * the caller gets them unchanged. The relay tells them apart by `name`.
 */
function deviceFlowError(error: unknown): RelayError {
  if (!(error instanceof Error)) throw error;
  if (error.name === "GitHubUnavailableError") return new RelayError("github-unavailable", "GitHub is not available now. Try again later.");
  if (error.name === "DeviceFlowDisabledError") {
    return new RelayError(
      "device-flow-disabled",
      'The GitHub App has the device flow off. The relay operator turns on "Enable Device Flow" in the App settings.',
    );
  }
  if (error.name === "Error") {
    return new RelayError("enrollment-failed", "GitHub refused the device flow of the relay's GitHub App.", "The relay operator checks the App settings.");
  }
  throw error;
}

export function createRelay(store: Store, options: RelayOptions): Relay {
  const access: Access = { github: options.github, allowedOwners: () => options.allowedOwners };
  const enrollments = new Map<string, Enrollment>();
  const closing = new AbortController();
  const log = options.log;

  const query = (call: Call, name: string): string | null => call.query.get(name);
  const oneOfQuery = <V extends string>(call: Call, name: string, values: readonly V[], fallback: V): V => {
    const value = query(call, name) ?? fallback;
    if (!(values as readonly string[]).includes(value)) throw new RelayError("invalid-request", `${name} must be one of ${values.join(", ")}.`);
    return value as V;
  };
  const limitQuery = (call: Call): number => {
    const text = query(call, "limit");
    if (text === null) return PAGE_LIMIT;
    const value = Number(text);
    if (!Number.isInteger(value) || value < 1 || value > PAGE_LIMIT) throw new RelayError("invalid-request", `limit must be 1 to ${PAGE_LIMIT}.`);
    return value;
  };
  const device = (call: Call): DeviceRow => {
    if (call.device === null) throw new RelayError("unauthenticated", "This call needs a device credential.");
    return call.device;
  };
  const session = (call: Call, sessionId: unknown): SessionRow => {
    if (typeof sessionId !== "string" || !isId("session", sessionId)) throw new RelayError("invalid-request", "sessionId is missing or not valid.");
    return ownSession(store, device(call), sessionId);
  };
  /** The access check of a project-scoped read: of the session when the call names one, else of the device's owner. */
  const readAccess = async (call: Call, projectId: string): Promise<SessionRow | null> => {
    const sessionId = query(call, "sessionId");
    if (sessionId !== null) {
      const own = session(call, sessionId);
      if (own.project_id !== projectId) throw new RelayError("no-project-access", "This session does not take part in this project.");
      await checkAccess(store, access, own.owner_id, projectId, "cached");
      return own;
    }
    await checkAccess(store, access, device(call).owner_id, projectId, "cached");
    return null;
  };
  /** The project of a mutating session call, with its access check. */
  const sessionAccess = async (call: Call, sessionId: unknown): Promise<SessionRow> => {
    const own = session(call, sessionId);
    if (own.project_id === null) throw new RelayError("no-project-access", "This session takes part in no project.");
    await checkAccess(store, access, own.owner_id, own.project_id, "cached");
    return own;
  };

  const routes: Route[] = [
    {
      method: "GET",
      pattern: /^\/v1\/health$/,
      auth: false,
      handler: () =>
        reply(200, { ok: true, protocol: PROTOCOL_VERSION, minClientVersion: options.minClientVersion ?? "0.0.0", relayVersion: options.relayVersion ?? "0.0.0" }),
    },
    {
      method: "GET",
      pattern: /^\/v1\/me$/,
      auth: true,
      handler: (call) => {
        const own = device(call);
        return reply(200, {
          owner: ownerView(store, own.owner_id),
          device: { id: own.id, name: own.name, platform: own.platform, createdAt: own.created_at },
        });
      },
    },
    { method: "POST", pattern: /^\/v1\/enroll\/start$/, auth: false, handler: (call) => enrollStart(parse(EnrollStart, call.body)) },
    { method: "POST", pattern: /^\/v1\/enroll\/poll$/, auth: false, handler: (call) => enrollPoll(parse(EnrollPoll, call.body).enrollmentId) },
    {
      method: "POST",
      pattern: /^\/v1\/devices$/,
      auth: true,
      handler: (call) => {
        const body = parse(DeviceCreate, call.body);
        const own = device(call);
        return {
          status: 201,
          apply: () => ({ device: createDevice(own.owner_id, body.name, body.platform, body.credentialSha256, own.id) }),
        };
      },
    },
    {
      method: "GET",
      pattern: /^\/v1\/devices$/,
      auth: true,
      handler: (call) => {
        const rows = store.db
          .query<DeviceRow, [string]>("SELECT * FROM devices WHERE owner_id = ? ORDER BY created_at")
          .all(device(call).owner_id);
        return reply(200, {
          devices: rows.map((row) => ({
            id: row.id,
            name: row.name,
            platform: row.platform,
            createdAt: row.created_at,
            lastSeenAt: row.last_seen_at,
            revokedAt: row.revoked_at,
          })),
        });
      },
    },
    {
      method: "POST",
      pattern: /^\/v1\/devices\/([^/]+)\/revoke$/,
      auth: true,
      handler: (call) => ({ status: 200, apply: () => ({ device: revokeDevice(device(call), call.params[0] ?? "") }) }),
    },
    {
      method: "POST",
      pattern: /^\/v1\/sessions$/,
      auth: true,
      handler: async (call) => ({ status: 200, apply: await registerSession(store, access, device(call), parse(SessionRegister, call.body)) }),
    },
    {
      method: "PATCH",
      pattern: /^\/v1\/sessions\/([^/]+)$/,
      auth: true,
      handler: (call) => {
        const own = session(call, call.params[0]);
        const body = parse(SessionUpdate, call.body);
        return {
          status: 200,
          apply: () => {
            updateSession(store, own, body);
            return { session: sessionInfo(store, own.id) };
          },
        };
      },
    },
    {
      method: "POST",
      pattern: /^\/v1\/sessions\/([^/]+)\/end$/,
      auth: true,
      handler: (call) => {
        const own = session(call, call.params[0]);
        const body = parse(SessionEnd, call.body);
        return {
          status: 200,
          apply: () => {
            endSession(store, own, body);
            return { session: sessionInfo(store, own.id) };
          },
        };
      },
    },
    {
      method: "POST",
      pattern: /^\/v1\/worker\/heartbeat$/,
      auth: true,
      handler: (call) => {
        const body = parse(Heartbeat, call.body);
        return { status: 200, apply: () => heartbeat(store, device(call), body) };
      },
    },
    { method: "GET", pattern: /^\/v1\/worker\/events$/, auth: true, handler: async (call) => reply(200, await events(call)) },
    {
      method: "GET",
      pattern: /^\/v1\/sessions\/([^/]+)\/pending$/,
      auth: true,
      handler: (call) => {
        const own = session(call, call.params[0]);
        const rows = pending(store, own.id);
        const view = (row: (typeof rows.receipts)[number]) => ({ ...receiptView(store, row), message: messageView(store, row.message_id) });
        return reply(200, { receipts: rows.receipts.map(view), heldByHops: rows.heldByHops.map(view) });
      },
    },
    {
      method: "GET",
      pattern: /^\/v1\/sessions\/([^/]+)\/requests$/,
      auth: true,
      handler: (call) => {
        const own = session(call, call.params[0]);
        const role = oneOfQuery(call, "role", ["assigned", "sent"], "assigned");
        const state = oneOfQuery(call, "state", ["open", "all"], "open");
        return reply(200, listRequests(store, [own.id], role, state, query(call, "cursor"), limitQuery(call)));
      },
    },
    {
      method: "POST",
      pattern: /^\/v1\/deliveries\/([^/]+)\/dispatch$/,
      auth: true,
      handler: (call) => {
        const body = parse(Dispatch, call.body);
        return { status: 200, apply: () => dispatch(store, device(call).id, call.params[0] ?? "", body) };
      },
    },
    {
      method: "POST",
      pattern: /^\/v1\/deliveries\/([^/]+)\/result$/,
      auth: true,
      handler: (call) => {
        const body = parse(DeliveryResult, call.body);
        return { status: 200, apply: () => ({ receipt: recordResult(store, device(call).id, call.params[0] ?? "", body) }) };
      },
    },
    {
      method: "GET",
      pattern: /^\/v1\/projects$/,
      auth: true,
      handler: async (call) => {
        const key = query(call, "key") ?? "";
        if (!/^github\.com\/[a-z0-9][a-z0-9-]*\/[a-z0-9._-]+$/.test(key)) throw new RelayError("invalid-request", "key must be github.com/<owner>/<repo>.");
        const project = await resolveProject(store, access, key);
        const state = await checkAccess(store, access, device(call).owner_id, project.id, "cached");
        return reply(200, { project: { id: project.id, key, repoId: project.provider_repo_id, access: state } });
      },
    },
    {
      method: "GET",
      pattern: /^\/v1\/projects\/([^/]+)\/requests$/,
      auth: true,
      handler: async (call) => {
        const projectId = getProject(store, call.params[0] ?? "").id;
        const own = device(call);
        await checkAccess(store, access, own.owner_id, projectId, "cached");
        const sessions = store.db
          .query<{ id: string }, [string, string]>("SELECT id FROM sessions WHERE owner_id = ? AND project_id = ?")
          .all(own.owner_id, projectId)
          .map((row) => row.id);
        const role = oneOfQuery(call, "role", ["assigned", "sent"], "assigned");
        const state = oneOfQuery(call, "state", ["open", "all"], "open");
        return reply(200, listRequests(store, sessions, role, state, query(call, "cursor"), limitQuery(call)));
      },
    },
    {
      method: "GET",
      pattern: /^\/v1\/projects\/([^/]+)\/conversations$/,
      auth: true,
      handler: async (call) => {
        const projectId = getProject(store, call.params[0] ?? "").id;
        await readAccess(call, projectId);
        oneOfQuery(call, "state", ["open", "all"], "open");
        return reply(200, { conversations: listConversations(store, projectId, query(call, "query")) });
      },
    },
    {
      method: "POST",
      pattern: /^\/v1\/projects\/([^/]+)\/conversations$/,
      auth: true,
      handler: async (call) => {
        const body = parse(ConversationCreate, call.body);
        const projectId = getProject(store, call.params[0] ?? "").id;
        return { status: 201, apply: await createConversation(store, access, session(call, body.sessionId), projectId, body) };
      },
    },
    {
      method: "GET",
      pattern: /^\/v1\/projects\/([^/]+)\/sessions$/,
      auth: true,
      handler: async (call) => {
        const projectId = getProject(store, call.params[0] ?? "").id;
        await readAccess(call, projectId);
        const state = oneOfQuery(call, "state", ["live", "all"], "all");
        const conversationId = query(call, "conversationId");
        if (conversationId !== null && getConversation(store, conversationId).project_id !== projectId) {
          throw new RelayError("invalid-request", "The conversation is not in this project.");
        }
        return reply(200, { sessions: listSessions(store, projectId, query(call, "query"), conversationId, state) });
      },
    },
    {
      method: "POST",
      pattern: /^\/v1\/conversations\/([^/]+)\/join$/,
      auth: true,
      handler: async (call) => {
        const body = parse(SessionCall, call.body);
        return { status: 200, apply: await join(store, access, session(call, body.sessionId), call.params[0] ?? "") };
      },
    },
    {
      method: "POST",
      pattern: /^\/v1\/conversations\/([^/]+)\/leave$/,
      auth: true,
      handler: (call) => {
        const own = session(call, parse(SessionCall, call.body).sessionId);
        return { status: 200, apply: () => leave(store, own, call.params[0] ?? "") };
      },
    },
    {
      method: "GET",
      pattern: /^\/v1\/conversations\/([^/]+)\/context$/,
      auth: true,
      handler: async (call) => {
        const conversation = getConversation(store, call.params[0] ?? "");
        await readAccess(call, conversation.project_id);
        return reply(200, joinContext(store, conversation.id));
      },
    },
    {
      method: "GET",
      pattern: /^\/v1\/conversations\/([^/]+)\/messages$/,
      auth: true,
      handler: async (call) => {
        const conversation = getConversation(store, call.params[0] ?? "");
        await readAccess(call, conversation.project_id);
        return reply(200, messagesPage(store, conversation.id, query(call, "before"), limitQuery(call)));
      },
    },
    {
      method: "POST",
      pattern: /^\/v1\/conversations\/([^/]+)\/messages$/,
      auth: true,
      handler: async (call) => {
        const body = parse(MessageCreate, call.body);
        return { status: 201, apply: await sendMessage(store, access, session(call, body.sessionId), call.params[0] ?? "", body) };
      },
    },
    {
      method: "POST",
      pattern: /^\/v1\/messages\/ack$/,
      auth: true,
      handler: async (call) => {
        const body = parse(Ack, call.body);
        const own = await sessionAccess(call, body.sessionId);
        return { status: 200, apply: () => ack(store, own, body) };
      },
    },
    {
      method: "GET",
      pattern: /^\/v1\/messages\/([^/]+)$/,
      auth: true,
      handler: async (call) => {
        const message = getMessage(store, call.params[0] ?? "");
        await readAccess(call, getConversation(store, message.conversation_id).project_id);
        return reply(200, { message: messageView(store, message), receipts: receiptsOf(store, message.id) });
      },
    },
    {
      method: "POST",
      pattern: /^\/v1\/requests\/([^/]+)\/action$/,
      auth: true,
      handler: async (call) => {
        const body = parse(RequestAction, call.body);
        const apply = await requestAction(store, access, session(call, body.sessionId), call.params[0] ?? "", body);
        return { status: 200, apply: () => ({ message: apply() }) };
      },
    },
    {
      method: "GET",
      pattern: /^\/v1\/conversations\/([^/]+)\/constraints$/,
      auth: true,
      handler: async (call) => {
        const conversation = getConversation(store, call.params[0] ?? "");
        await readAccess(call, conversation.project_id);
        const state = oneOfQuery(call, "state", ["active", "resolved", "all"], "active");
        return reply(200, { constraints: listConstraints(store, conversation.id, state) });
      },
    },
    {
      method: "POST",
      pattern: /^\/v1\/conversations\/([^/]+)\/constraints$/,
      auth: true,
      handler: async (call) => {
        const body = parse(ConstraintCreate, call.body);
        const apply = await createConstraint(store, access, session(call, body.sessionId), call.params[0] ?? "", body);
        return { status: 201, apply: () => ({ constraint: apply() }) };
      },
    },
    {
      method: "POST",
      pattern: /^\/v1\/constraints\/([^/]+)\/action$/,
      auth: true,
      handler: async (call) => {
        const body = parse(ConstraintAction, call.body);
        return { status: 200, apply: await constraintAction(store, access, session(call, body.sessionId), call.params[0] ?? "", body) };
      },
    },
  ];

  async function enrollStart(body: EnrollStart): Promise<Reply> {
    const flow = await options.github.startDeviceFlow().catch((error: unknown) => {
      throw deviceFlowError(error);
    });
    const enrollmentId = `enr_${randomBytes(18).toString("base64url")}`;
    const intervalMs = flow.intervalS * 1000;
    const expiresAt = store.now() + flow.expiresInS * 1000;
    enrollments.set(enrollmentId, {
      deviceCode: flow.deviceCode,
      deviceName: body.deviceName,
      platform: body.platform,
      credentialSha256: body.credentialSha256,
      intervalMs,
      expiresAt,
      done: null,
    });
    log("relay.enroll-start", { enrollment: enrollmentId });
    return reply(200, { enrollmentId, userCode: flow.userCode, verificationUri: flow.verificationUri, intervalMs, expiresAt: iso(expiresAt) });
  }

  async function enrollPoll(enrollmentId: string): Promise<Reply> {
    const enrollment = enrollments.get(enrollmentId);
    if (enrollment === undefined) {
      throw new RelayError("enrollment-unknown", "The relay does not know this enrollment.", "Start the enrollment again.");
    }
    if (enrollment.done !== null) return reply(200, enrollment.done.result);
    if (store.now() >= enrollment.expiresAt) {
      enrollments.delete(enrollmentId);
      throw new RelayError("enrollment-expired", "The enrollment code expired.", "Start the enrollment again.");
    }
    const result = await options.github.pollDeviceFlow(enrollment.deviceCode).catch((error: unknown) => {
      const refusal = deviceFlowError(error);
      if (refusal.code !== "github-unavailable") enrollments.delete(enrollmentId);
      throw refusal;
    });
    if (result.state === "pending") return reply(202, { state: "pending", intervalMs: enrollment.intervalMs });
    if (result.state === "slow-down") {
      enrollment.intervalMs += 5_000;
      return reply(202, { state: "pending", intervalMs: enrollment.intervalMs });
    }
    if (result.state === "expired") {
      enrollments.delete(enrollmentId);
      throw new RelayError("enrollment-expired", "The enrollment code expired.", "Start the enrollment again.");
    }
    if (result.state !== "complete") {
      enrollments.delete(enrollmentId);
      throw new RelayError("enrollment-denied", "The GitHub user denied the enrollment.");
    }
    const user = result.user;
    const complete = store.tx(() => {
      const now = store.iso();
      const ownerId =
        store.db.query<{ id: string }, [number]>("SELECT id FROM owners WHERE github_user_id = ?").get(user.id)?.id ?? newId("owner", store.now());
      store.db
        .query(
          `INSERT INTO owners (id, github_user_id, login, created_at, login_checked_at) VALUES (?, ?, ?, ?, ?)
           ON CONFLICT (github_user_id) DO UPDATE SET login = excluded.login, login_checked_at = excluded.login_checked_at`,
        )
        .run(ownerId, user.id, user.login, now, now);
      const created = createDevice(ownerId, enrollment.deviceName, enrollment.platform, enrollment.credentialSha256, null);
      return { state: "complete" as const, owner: ownerView(store, ownerId), device: created };
    });
    enrollment.done = { result: complete, at: store.now() };
    log("relay.enroll-complete", { enrollment: enrollmentId, owner: complete.owner.id, device: complete.device.id });
    return reply(200, complete);
  }

  function createDevice(ownerId: string, name: string, platform: "linux" | "darwin", sha256: string, by: string | null): { id: string; name: string } {
    return store.tx(() => {
      const hash = Buffer.from(sha256, "hex");
      if (store.db.query("SELECT 1 FROM devices WHERE credential_sha256 = ?").get(hash) !== null) {
        throw new RelayError("invalid-request", "A device with this credential exists.", "Make a new credential.");
      }
      const id = newId("device", store.now());
      store.db
        .query("INSERT INTO devices (id, owner_id, name, platform, credential_sha256, created_by_device_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)")
        .run(id, ownerId, name, platform, hash, by, store.iso());
      return { id, name };
    });
  }

  function revokeDevice(caller: DeviceRow, deviceId: string): { id: string; revokedAt: string } {
    return store.tx(() => {
      const target = store.db.query<DeviceRow, [string]>("SELECT * FROM devices WHERE id = ?").get(deviceId);
      if (target === null || target.owner_id !== caller.owner_id) throw new RelayError("not-found", `No device ${deviceId} of this owner.`);
      const revokedAt = target.revoked_at ?? store.iso();
      store.db.query("UPDATE devices SET revoked_at = ? WHERE id = ?").run(revokedAt, deviceId);
      const sessions = store.db.query<SessionRow, [string]>("SELECT * FROM sessions WHERE device_id = ? AND state != 'retired'").all(deviceId);
      for (const row of sessions) {
        store.db.query("UPDATE sessions SET state = 'retired', activity = NULL, ended_at = ?, ended_reason = 'device-revoked' WHERE id = ?").run(revokedAt, row.id);
        retireMemberships(store, row, "device-revoked");
      }
      emit(store, { type: "device.revoked" }, [deviceId]);
      log("relay.device-revoked", { device: deviceId });
      return { id: deviceId, revokedAt };
    });
  }

  async function events(call: Call): Promise<{ cursor: number; events: RelayEvent[]; resync: boolean }> {
    const own = device(call);
    const cursor = Number(query(call, "cursor") ?? "0");
    const waitMs = Math.min(Number(query(call, "waitMs") ?? "0"), LONG_POLL_MAX_MS);
    if (!Number.isSafeInteger(cursor) || cursor < 0 || !Number.isFinite(waitMs) || waitMs < 0) {
      throw new RelayError("invalid-request", "cursor and waitMs must be numbers of 0 or more.");
    }
    const last = store.db.query<{ seq: number }, []>("SELECT seq FROM sqlite_sequence WHERE name = 'events'").get()?.seq ?? 0;
    const pruned = Number(getMeta(store, "events_pruned_through") ?? "0");
    if (cursor > last || (cursor < pruned && cursor > 0) || (cursor === 0 && pruned > 0)) return { cursor: last, events: [], resync: true };
    const read = () =>
      store.db
        .query<{ seq: number; type: string; payload: string }, [string, number, number]>(
          "SELECT e.seq, e.type, e.payload FROM event_targets t JOIN events e ON e.seq = t.seq WHERE t.device_id = ? AND t.seq > ? ORDER BY t.seq LIMIT ?",
        )
        .all(own.id, cursor, EVENTS_PER_POLL);
    let rows = read();
    if (rows.length === 0 && waitMs > 0) {
      await new Promise<void>((resolve) => {
        const done = () => {
          clearTimeout(timer);
          unsubscribe();
          call.signal.removeEventListener("abort", done);
          closing.signal.removeEventListener("abort", done);
          resolve();
        };
        const timer = setTimeout(done, waitMs);
        const unsubscribe = store.subscribe(own.id, done);
        call.signal.addEventListener("abort", done);
        closing.signal.addEventListener("abort", done);
      });
      rows = read();
    }
    const list = rows.map((row) => ({ seq: row.seq, type: row.type, ...JSON.parse(row.payload) }) as RelayEvent);
    return { cursor: rows.at(-1)?.seq ?? cursor, events: list, resync: false };
  }

  function authenticate(request: Request): DeviceRow {
    const header = request.headers.get("authorization") ?? "";
    const credential = header.startsWith("Bearer ") ? header.slice(7) : "";
    if (!isDeviceCredential(credential)) throw new RelayError("unauthenticated", "This call needs a device credential.");
    const row = store.db
      .query<DeviceRow, [Buffer]>("SELECT * FROM devices WHERE credential_sha256 = ?")
      .get(Buffer.from(credentialSha256(credential), "hex"));
    if (row === null) throw new RelayError("unauthenticated", "The relay does not know this device credential.", "Enroll this device again.");
    if (row.revoked_at !== null) throw new RelayError("device-revoked", "This device credential is revoked.", "Enroll this device again.");
    return row;
  }

  async function handle(request: Request): Promise<Response> {
    const started = performance.now();
    const url = new URL(request.url);
    let status = 500;
    let deviceId: string | null = null;
    try {
      const response = await route(request, url, (id) => (deviceId = id));
      status = response.status;
      return response;
    } catch (error) {
      if (error instanceof RelayError) {
        status = ERROR_STATUS[error.code];
        return errorResponse(error);
      }
      status = 503;
      log("relay.error", { method: request.method, path: url.pathname, error: error instanceof Error ? error.name : "unknown" });
      return json(503, errorBody("unavailable", "The relay had an internal error."));
    } finally {
      log("relay.request", { method: request.method, path: url.pathname, status, device: deviceId, ms: Math.round(performance.now() - started) });
    }
  }

  async function route(request: Request, url: URL, seen: (deviceId: string) => void): Promise<Response> {
    const candidates = routes.filter((entry) => entry.pattern.test(url.pathname));
    const entry = candidates.find((candidate) => candidate.method === request.method);
    if (entry === undefined) throw new RelayError("not-found", `No endpoint ${request.method} ${url.pathname}.`);
    const params = (entry.pattern.exec(url.pathname) ?? []).slice(1).map((part) => decodeURIComponent(part));
    const health = url.pathname === "/v1/health";
    if (!health) {
      const protocol = request.headers.get(HEADERS.protocol);
      if (protocol !== String(PROTOCOL_VERSION)) {
        throw new RelayError("upgrade-required", `This relay speaks protocol ${PROTOCOL_VERSION}.`, "Update Ferry.");
      }
      const version = request.headers.get(HEADERS.version);
      if (options.minClientVersion !== undefined && (version === null || versionBelow(version, options.minClientVersion))) {
        throw new RelayError("upgrade-required", `This relay needs Ferry ${options.minClientVersion} or later.`, "Update Ferry.");
      }
    }
    let text = "";
    if (request.method !== "GET") {
      const length = Number(request.headers.get("content-length") ?? "0");
      if (length > LIMITS.requestBytes) throw new RelayError("too-large", `A request body has at most ${LIMITS.requestBytes} bytes.`);
      text = await request.text();
      if (Buffer.byteLength(text, "utf8") > LIMITS.requestBytes) throw new RelayError("too-large", `A request body has at most ${LIMITS.requestBytes} bytes.`);
    }
    let body: unknown = undefined;
    if (text.length > 0) {
      try {
        body = JSON.parse(text);
      } catch {
        throw new RelayError("invalid-request", "The request body is not JSON.");
      }
    }
    const caller = entry.auth ? authenticate(request) : null;
    if (caller !== null) seen(caller.id);
    const call: Call = { params, query: url.searchParams, body, device: caller, signal: request.signal };
    const mutating = request.method !== "GET" && !url.pathname.startsWith("/v1/enroll/");
    if (!mutating || caller === null) {
      const result = await entry.handler(call);
      return json(result.status, store.tx(() => result.apply()));
    }
    const key = request.headers.get(HEADERS.idempotencyKey) ?? "";
    if (!isId("idempotencyKey", key)) throw new RelayError("invalid-request", `A mutating call needs the header ${HEADERS.idempotencyKey}: idk_<ULID>.`);
    const hash = createHash("sha256").update(`${request.method} ${url.pathname}${url.search}\n${text}`).digest();
    const stored = () =>
      store.db
        .query<{ request_sha256: Uint8Array; status: number; response: string }, [string, string]>(
          "SELECT request_sha256, status, response FROM idempotency WHERE device_id = ? AND key = ?",
        )
        .get(caller.id, key);
    const replay = (row: NonNullable<ReturnType<typeof stored>>): Response => {
      if (!Buffer.from(row.request_sha256).equals(hash)) {
        throw new RelayError("idempotency-mismatch", "This idempotency key was used for another request.", "Make a new key for a new request.");
      }
      return new Response(row.response, { status: row.status, headers: { "content-type": "application/json; charset=utf-8", [HEADERS.idempotentReplay]: "true" } });
    };
    const record = (status: number, response: string) =>
      store.db
        .query("INSERT OR IGNORE INTO idempotency (device_id, key, request_sha256, status, response, created_at) VALUES (?, ?, ?, ?, ?, ?)")
        .run(caller.id, key, hash, status, response, store.iso());
    const before = stored();
    if (before !== null) return replay(before);
    try {
      const result = await entry.handler(call);
      const outcome = store.tx(() => {
        const raced = stored();
        if (raced !== null) return { raced };
        const response = JSON.stringify(result.apply());
        record(result.status, response);
        return { status: result.status, response };
      });
      if ("raced" in outcome && outcome.raced !== undefined) return replay(outcome.raced);
      return new Response(outcome.response, { status: outcome.status, headers: { "content-type": "application/json; charset=utf-8" } });
    } catch (error) {
      // A refusal is the answer to this key, so a retry gets the same answer. An outage or a rate limit is not.
      if (error instanceof RelayError && ERROR_STATUS[error.code] < 500 && error.code !== "rate-limited") {
        const response = errorResponse(error);
        const text = await response.clone().text();
        store.tx(() => {
          if (stored() === null) record(response.status, text);
        });
      }
      throw error;
    }
  }

  async function maintain(): Promise<void> {
    markStaleWorkers(store);
    maintainReceipts(store);
    await recheckGrants(store, access);
    prune();
    dailyBackup();
    const now = store.now();
    for (const [id, enrollment] of enrollments) {
      if ((enrollment.done !== null && enrollment.done.at + ENROLLMENT_DONE_MS < now) || (enrollment.done === null && enrollment.expiresAt < now)) {
        enrollments.delete(id);
      }
    }
  }

  function prune(): void {
    store.tx(() => {
      const now = store.now();
      store.db.query("DELETE FROM idempotency WHERE created_at < ?").run(iso(now - RETENTION.idempotencyMs));
      store.db.query("DELETE FROM wake_log WHERE at < ?").run(iso(now - RETENTION.wakeLogMs));
      const through = store.db.query<{ seq: number | null }, [string]>("SELECT max(seq) AS seq FROM events WHERE at < ?").get(iso(now - RETENTION.eventsMs))?.seq;
      if (through !== null && through !== undefined) {
        store.db.query("DELETE FROM event_targets WHERE seq <= ?").run(through);
        store.db.query("DELETE FROM events WHERE seq <= ?").run(through);
        setMeta(store, "events_pruned_through", String(through));
      }
    });
  }

  function dailyBackup(): void {
    const local = new Date(store.now());
    if (local.getHours() !== 3) return;
    const day = `${local.getFullYear()}-${String(local.getMonth() + 1).padStart(2, "0")}-${String(local.getDate()).padStart(2, "0")}`;
    if (getMeta(store, "daily_backup_day") === day) return;
    const file = backupStore(store.path, undefined, store.clock);
    store.tx(() => setMeta(store, "daily_backup_day", day));
    log("relay.backup", { file });
  }

  return { handle, maintain, close: () => closing.abort() };
}

/**
 * Start the relay. Throws when another relay holds the lock of the store
 * directory. `listen` is `host:port`, default `127.0.0.1:47830`. Port 0 takes a
 * free port.
 */
export async function startRelay(
  options: RelayOptions & { readonly dbPath: string; readonly listen?: string },
): Promise<{ url: string; stop(): Promise<void> }> {
  const release = acquireRelayLock(dirname(options.dbPath));
  if (release === null) throw new Error(`Another relay runs on the store in ${dirname(options.dbPath)}.`);
  let store: Store;
  try {
    store = openStore(options.dbPath, options.clock);
  } catch (error) {
    release();
    throw error;
  }
  const relay = createRelay(store, options);
  const listen = options.listen ?? DEFAULT_LISTEN;
  const split = listen.lastIndexOf(":");
  const hostname = listen.slice(0, split);
  const port = Number(listen.slice(split + 1));
  const server = Bun.serve({ hostname, port, idleTimeout: 60, maxRequestBodySize: 4 * LIMITS.requestBytes, fetch: (request) => relay.handle(request) });
  let running = false;
  const timer = setInterval(() => {
    if (running) return;
    running = true;
    relay
      .maintain()
      .catch((error: unknown) => options.log("relay.maintain-failed", { error: error instanceof Error ? error.name : "unknown" }))
      .finally(() => (running = false));
  }, MAINTAIN_MS);
  options.log("relay.started", { url: `http://${hostname}:${server.port}` });
  return {
    url: `http://${hostname}:${server.port}`,
    async stop() {
      clearInterval(timer);
      relay.close();
      await server.stop(true);
      store.close();
      release();
    },
  };
}
