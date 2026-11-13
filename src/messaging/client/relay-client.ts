/**
 * The HTTP client of the relay protocol (design section 7). It has one typed
 * method for each endpoint.
 *
 * - Each call sends `Ferry-Protocol: 1` and `Ferry-Version`. Each call except
 *   `GET /v1/health` and `/v1/enroll/*` sends `Authorization: Bearer <credential>`.
 * - Each mutating call except `/v1/enroll/*` sends `Idempotency-Key`. The caller
 *   can give the key, as the worker outbox does, so a retry after a crash uses
 *   the same key. Else the client makes one for the call.
 * - The client checks the request body and the response body with the
 *   validators of `protocol.ts`.
 * - `request` is the untyped call of the worker outbox (`RelayTransport` of
 *   `worker/outbox.ts`). It makes one try, without a retry and without a check
 *   of the bodies, and gives the status and the JSON body of each answer. It
 *   sends the idempotency key of the caller and makes none.
 * - No answer, a timeout, and a 5xx answer without a relay error body (for
 *   example from the TLS front when the relay is down) get up to 2 retries
 *   with the same key. A relay error `unavailable` also gets them. Then the
 *   call throws `RelayUnreachableError`. Each other relay error throws `RelayError`.
 *
 * The relay URL must be `https://`, or `http://` for a loopback host only, so
 * a bearer credential never crosses a network without TLS. No error has the credential.
 */

import { newId } from "../ids.ts";
import {
  Ack,
  Acked,
  ConstraintAction,
  ConstraintActionResult,
  ConstraintCreate,
  ConstraintCreated,
  ConstraintList,
  ConversationCreate,
  ConversationCreated,
  ConversationList,
  DeliveryResult,
  DeviceCreate,
  DeviceCreated,
  DeviceList,
  DeviceRevoked,
  Dispatch,
  DispatchDecision,
  EnrollPoll,
  EnrollPolled,
  EnrollStart,
  EnrollStarted,
  ErrorBody,
  Events,
  HEADERS,
  Health,
  Heartbeat,
  HeartbeatAck,
  JoinContext,
  LIMITS,
  Left,
  Me,
  MessageCreate,
  MessageCreated,
  MessageDetail,
  MessagePage,
  Pending,
  PROTOCOL_VERSION,
  ProjectResult,
  ReceiptResult,
  RequestAction,
  RequestActionResult,
  RequestList,
  SessionCall,
  SessionEnd,
  SessionList,
  SessionRegister,
  SessionRegistered,
  SessionResult,
  SessionUpdate,
  validate,
  type ErrorCode,
  type Schema,
} from "../protocol.ts";

/** Check a relay URL and return it without a trailing slash. */
export function checkRelayUrl(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`${value} is not a URL. Give the relay URL, for example https://ferry-relay.example.ts.net:8443.`);
  }
  if (url.username !== "" || url.password !== "" || url.search !== "" || url.hash !== "") {
    throw new Error("The relay URL must not have a user, a password, a query, or a fragment.");
  }
  const loopback = ["127.0.0.1", "[::1]", "localhost"].includes(url.hostname);
  if (url.protocol !== "https:" && !(url.protocol === "http:" && loopback)) {
    throw new Error("The relay URL must use https://. Plain http:// is only for a relay on this machine (127.0.0.1).");
  }
  return url.toString().replace(/\/+$/, "");
}

/** The relay answered with an error body of the protocol. */
export class RelayError extends Error {
  readonly code: ErrorCode;
  readonly hint: string | null;
  readonly details: Readonly<Record<string, unknown>> | undefined;

  constructor(
    readonly status: number,
    body: ErrorBody["error"],
  ) {
    super(body.message);
    this.name = "RelayError";
    this.code = body.code;
    this.hint = body.hint;
    this.details = body.details;
  }
}

/** The relay did not answer, after the retries. The worker outbox keeps a mutating call for later. */
export class RelayUnreachableError extends Error {
  constructor(
    readonly detail: string,
    /** The cause without the call: `no answer`, an HTTP status, or the message of the relay. */
    readonly problem: string = detail,
  ) {
    super(`The relay is not reachable: ${detail}`);
    this.name = "RelayUnreachableError";
  }
}

/** The relay answered with a body that the protocol does not allow. */
export class RelayProtocolError extends Error {
  constructor(where: string, issues: readonly string[]) {
    super(`The relay answered ${where} with an invalid body: ${issues.slice(0, 3).join("; ")}`);
    this.name = "RelayProtocolError";
  }
}

export type Fetch = (input: string, init: RequestInit) => Promise<Response>;

/** One untyped call. `path` starts with `/v1/` and can have a query. */
export type RelayRequest = {
  readonly method: "GET" | "POST" | "PATCH";
  readonly path: string;
  readonly body?: unknown;
  readonly idempotencyKey?: string;
  readonly signal?: AbortSignal;
};
export type RelayAnswer = { readonly status: number; readonly body: unknown };

export type RelayClientOptions = {
  /** The relay URL, for example `https://ferry-relay.example.ts.net:8443`. */
  readonly url: string;
  /** The device credential. Null for enrollment and health only. */
  readonly credential: string | null;
  readonly ferryVersion: string;
  readonly fetch?: Fetch;
  /** The wait for one answer. Default: 30 seconds. The long poll waits `waitMs` plus this time. */
  readonly timeoutMs?: number;
  /** Retries after no answer. Default: 2. */
  readonly retries?: number;
  readonly sleep?: (ms: number) => Promise<void>;
  readonly clock?: { now(): number };
};

/** A mutating call can carry the idempotency key of the worker outbox. */
export type CallOptions = { readonly idempotencyKey?: string };

type Query = Readonly<Record<string, string | number | undefined>>;

type Call<T> = {
  readonly method: "GET" | "POST" | "PATCH";
  readonly path: string;
  readonly response: Schema<T>;
  readonly query?: Query;
  readonly body?: { readonly schema: Schema<unknown>; readonly value: unknown };
  readonly key?: string;
};

const RETRY_DELAYS_MS = [500, 2_000];
const segment = (value: string) => encodeURIComponent(value);

export class RelayClient {
  readonly #root: string;
  readonly #options: RelayClientOptions;
  readonly #fetch: Fetch;
  readonly #sleep: (ms: number) => Promise<void>;

  constructor(options: RelayClientOptions) {
    this.#root = checkRelayUrl(options.url);
    this.#options = options;
    this.#fetch = options.fetch ?? ((input, init) => fetch(input, init));
    this.#sleep = options.sleep ?? ((ms) => Bun.sleep(ms));
  }

  // 7.3 Health and identity

  health(): Promise<Health> {
    return this.#call({ method: "GET", path: "/health", response: Health });
  }

  me(): Promise<Me> {
    return this.#call({ method: "GET", path: "/me", response: Me });
  }

  // 7.4 Enrollment and devices

  enrollStart(body: EnrollStart): Promise<EnrollStarted> {
    return this.#call({ method: "POST", path: "/enroll/start", response: EnrollStarted, body: { schema: EnrollStart, value: body } });
  }

  /** `pending` (HTTP 202) or `complete` (HTTP 200). `enrollment-expired`, `enrollment-denied`, and `enrollment-unknown` throw `RelayError`. */
  enrollPoll(body: EnrollPoll): Promise<EnrollPolled> {
    return this.#call({ method: "POST", path: "/enroll/poll", response: EnrollPolled, body: { schema: EnrollPoll, value: body } });
  }

  createDevice(body: DeviceCreate, options: CallOptions = {}): Promise<DeviceCreated> {
    return this.#mutate("POST", "/devices", DeviceCreated, DeviceCreate, body, options);
  }

  devices(): Promise<DeviceList> {
    return this.#call({ method: "GET", path: "/devices", response: DeviceList });
  }

  revokeDevice(deviceId: string, options: CallOptions = {}): Promise<DeviceRevoked> {
    return this.#mutate("POST", `/devices/${segment(deviceId)}/revoke`, DeviceRevoked, null, {}, options);
  }

  // 7.5 Sessions and workers

  registerSession(body: SessionRegister, options: CallOptions = {}): Promise<SessionRegistered> {
    return this.#mutate("POST", "/sessions", SessionRegistered, SessionRegister, body, options);
  }

  updateSession(sessionId: string, body: SessionUpdate, options: CallOptions = {}): Promise<SessionResult> {
    return this.#mutate("PATCH", `/sessions/${segment(sessionId)}`, SessionResult, SessionUpdate, body, options);
  }

  endSession(sessionId: string, body: SessionEnd, options: CallOptions = {}): Promise<SessionResult> {
    return this.#mutate("POST", `/sessions/${segment(sessionId)}/end`, SessionResult, SessionEnd, body, options);
  }

  heartbeat(body: Heartbeat, options: CallOptions = {}): Promise<HeartbeatAck> {
    return this.#mutate("POST", "/worker/heartbeat", HeartbeatAck, Heartbeat, body, options);
  }

  /** The long poll. The relay answers within `waitMs` (default 25 seconds). */
  events(cursor: number, waitMs: number = LIMITS.longPollMs): Promise<Events> {
    return this.#call({ method: "GET", path: "/worker/events", query: { cursor, waitMs }, response: Events });
  }

  pending(sessionId: string): Promise<Pending> {
    return this.#call({ method: "GET", path: `/sessions/${segment(sessionId)}/pending`, response: Pending });
  }

  sessionRequests(sessionId: string, query: RequestQuery): Promise<RequestList> {
    return this.#call({ method: "GET", path: `/sessions/${segment(sessionId)}/requests`, query, response: RequestList });
  }

  dispatch(receiptId: string, body: Dispatch, options: CallOptions = {}): Promise<DispatchDecision> {
    return this.#mutate("POST", `/deliveries/${segment(receiptId)}/dispatch`, DispatchDecision, Dispatch, body, options);
  }

  deliveryResult(receiptId: string, body: DeliveryResult, options: CallOptions = {}): Promise<ReceiptResult> {
    return this.#mutate("POST", `/deliveries/${segment(receiptId)}/result`, ReceiptResult, DeliveryResult, body, options);
  }

  // 7.6 Conversations

  project(key: string): Promise<ProjectResult> {
    return this.#call({ method: "GET", path: "/projects", query: { key }, response: ProjectResult });
  }

  projectRequests(projectId: string, query: RequestQuery): Promise<RequestList> {
    return this.#call({ method: "GET", path: `/projects/${segment(projectId)}/requests`, query, response: RequestList });
  }

  conversations(projectId: string, query: { readonly query?: string; readonly state?: "open" | "all" } = {}): Promise<ConversationList> {
    return this.#call({ method: "GET", path: `/projects/${segment(projectId)}/conversations`, query, response: ConversationList });
  }

  createConversation(projectId: string, body: ConversationCreate, options: CallOptions = {}): Promise<ConversationCreated> {
    return this.#mutate("POST", `/projects/${segment(projectId)}/conversations`, ConversationCreated, ConversationCreate, body, options);
  }

  join(conversationId: string, body: SessionCall, options: CallOptions = {}): Promise<JoinContext> {
    return this.#mutate("POST", `/conversations/${segment(conversationId)}/join`, JoinContext, SessionCall, body, options);
  }

  leave(conversationId: string, body: SessionCall, options: CallOptions = {}): Promise<Left> {
    return this.#mutate("POST", `/conversations/${segment(conversationId)}/leave`, Left, SessionCall, body, options);
  }

  context(conversationId: string, sessionId?: string): Promise<JoinContext> {
    return this.#call({ method: "GET", path: `/conversations/${segment(conversationId)}/context`, query: { sessionId }, response: JoinContext });
  }

  messages(conversationId: string, query: { readonly sessionId?: string; readonly before?: string; readonly limit?: number } = {}): Promise<MessagePage> {
    return this.#call({ method: "GET", path: `/conversations/${segment(conversationId)}/messages`, query, response: MessagePage });
  }

  sessions(
    projectId: string,
    query: { readonly query?: string; readonly conversationId?: string; readonly state?: "live" | "all" } = {},
  ): Promise<SessionList> {
    return this.#call({ method: "GET", path: `/projects/${segment(projectId)}/sessions`, query, response: SessionList });
  }

  // 7.7 Messages, receipts, and requests

  sendMessage(conversationId: string, body: MessageCreate, options: CallOptions = {}): Promise<MessageCreated> {
    return this.#mutate("POST", `/conversations/${segment(conversationId)}/messages`, MessageCreated, MessageCreate, body, options);
  }

  message(messageId: string, sessionId?: string): Promise<MessageDetail> {
    return this.#call({ method: "GET", path: `/messages/${segment(messageId)}`, query: { sessionId }, response: MessageDetail });
  }

  ack(body: Ack, options: CallOptions = {}): Promise<Acked> {
    return this.#mutate("POST", "/messages/ack", Acked, Ack, body, options);
  }

  requestAction(requestId: string, body: RequestAction, options: CallOptions = {}): Promise<RequestActionResult> {
    return this.#mutate("POST", `/requests/${segment(requestId)}/action`, RequestActionResult, RequestAction, body, options);
  }

  // 7.8 Constraints

  constraints(conversationId: string, query: { readonly sessionId?: string; readonly state?: "active" | "resolved" | "all" } = {}): Promise<ConstraintList> {
    return this.#call({ method: "GET", path: `/conversations/${segment(conversationId)}/constraints`, query, response: ConstraintList });
  }

  createConstraint(conversationId: string, body: ConstraintCreate, options: CallOptions = {}): Promise<ConstraintCreated> {
    return this.#mutate("POST", `/conversations/${segment(conversationId)}/constraints`, ConstraintCreated, ConstraintCreate, body, options);
  }

  constraintAction(constraintId: string, body: ConstraintAction, options: CallOptions = {}): Promise<ConstraintActionResult> {
    return this.#mutate("POST", `/constraints/${segment(constraintId)}/action`, ConstraintActionResult, ConstraintAction, body, options);
  }

  // Transport

  /**
   * One call for the worker outbox. It sends no credential for `/v1/health` and
   * `/v1/enroll/*`. It keeps no state: the caller gives the idempotency key, so
   * a replay of a stored call after a restart sends the same request. The body
   * of the answer is its JSON, or null. Throws `RelayUnreachableError` on no
   * answer, a timeout, or the abort signal.
   */
  request(call: RelayRequest): Promise<RelayAnswer> {
    if (!call.path.startsWith("/v1/")) throw new Error(`The relay path ${call.path} does not start with /v1/.`);
    return this.#send(call.method, call.path, call.body, call.idempotencyKey, call.signal);
  }

  #mutate<T>(method: "POST" | "PATCH", path: string, response: Schema<T>, schema: Schema<unknown> | null, value: unknown, options: CallOptions): Promise<T> {
    return this.#call({
      method,
      path,
      response,
      body: schema === null ? undefined : { schema, value },
      key: options.idempotencyKey ?? newId("idempotencyKey", (this.#options.clock ?? Date).now()),
    });
  }

  async #call<T>(call: Call<T>): Promise<T> {
    const where = `${call.method} /v1${call.path}`;
    if (call.body) {
      const checked = validate(call.body.schema, call.body.value);
      if (!checked.ok) {
        throw new RelayError(400, { code: "invalid-request", message: `The request ${where} is not valid: ${checked.issues.slice(0, 3).join("; ")}`, hint: null, details: { issues: checked.issues } });
      }
    }
    const query = new URLSearchParams();
    for (const [name, value] of Object.entries(call.query ?? {})) if (value !== undefined) query.set(name, String(value));
    const path = `/v1${call.path}${query.size > 0 ? `?${query}` : ""}`;
    const retries = this.#options.retries ?? RETRY_DELAYS_MS.length;

    let lastProblem = "no answer";
    for (let attempt = 0; ; attempt++) {
      if (attempt > 0) await this.#sleep(RETRY_DELAYS_MS[Math.min(attempt - 1, RETRY_DELAYS_MS.length - 1)]!);
      let answer: RelayAnswer;
      try {
        answer = await this.#send(call.method, path, call.body?.value, call.key);
      } catch (error) {
        if (!(error instanceof RelayUnreachableError)) throw error;
        lastProblem = error.problem;
        if (attempt >= retries) break;
        continue;
      }
      if (answer.status >= 200 && answer.status < 300) {
        const checked = validate(call.response, answer.body);
        if (!checked.ok) throw new RelayProtocolError(where, checked.issues);
        return checked.value;
      }
      const error = validate(ErrorBody, answer.body);
      if (!error.ok && answer.status < 500) throw new RelayProtocolError(where, error.issues);
      if (error.ok && error.value.error.code !== "unavailable") throw new RelayError(answer.status, error.value.error);
      lastProblem = error.ok ? error.value.error.message : `HTTP ${answer.status}`;
      if (attempt >= retries) break;
    }
    throw new RelayUnreachableError(`${where}: ${lastProblem}`, lastProblem);
  }

  /** One HTTP exchange. `path` has the `/v1` prefix and the query. */
  async #send(method: RelayRequest["method"], path: string, value: unknown, key: string | undefined, signal?: AbortSignal): Promise<RelayAnswer> {
    const url = new URL(`${this.#root}${path}`);
    const where = `${method} ${url.pathname}`;
    const headers: Record<string, string> = {
      Accept: "application/json",
      [HEADERS.protocol]: String(PROTOCOL_VERSION),
      [HEADERS.version]: this.#options.ferryVersion,
    };
    if (!isOpen(url.pathname)) {
      if (this.#options.credential === null) throw new Error(`The call ${where} needs a device credential. Run ferry messaging enroll.`);
      headers.Authorization = `Bearer ${this.#options.credential}`;
    }
    if (key !== undefined) headers[HEADERS.idempotencyKey] = key;
    // A mutating call without a body in the design sends `{}`, so the idempotency hash has a fixed input.
    const body = method === "GET" ? undefined : JSON.stringify(value ?? {});
    if (body !== undefined) headers["Content-Type"] = "application/json";
    // The long poll waits `waitMs` plus the normal time.
    const timeoutMs = (this.#options.timeoutMs ?? 30_000) + (Number(url.searchParams.get("waitMs")) || 0);
    const timeout = AbortSignal.timeout(timeoutMs);
    let response: Response;
    let text: string;
    try {
      response = await this.#fetch(url.toString(), { method, headers, body, signal: signal ? AbortSignal.any([signal, timeout]) : timeout });
      text = await response.text();
    } catch {
      const problem = timeout.aborted ? `no answer within ${timeoutMs} ms` : signal?.aborted ? "the call was stopped" : "no answer";
      throw new RelayUnreachableError(`${where}: ${problem}`, problem);
    }
    let parsed: unknown = null;
    try {
      parsed = text === "" ? null : JSON.parse(text);
    } catch {
      parsed = null;
    }
    return { status: response.status, body: parsed };
  }
}

/** `GET /v1/health` and `/v1/enroll/*` have no credential and no idempotency key. */
function isOpen(pathname: string): boolean {
  return pathname === "/v1/health" || pathname.startsWith("/v1/enroll/");
}

export type RequestQuery = {
  readonly role: "assigned" | "sent";
  readonly state?: "open" | "all";
  readonly cursor?: string;
  readonly limit?: number;
};
