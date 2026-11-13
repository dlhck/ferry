/**
 * The relay protocol of agent messaging (design section 7): the request and
 * response types of each endpoint, their runtime validators, the error codes, and
 * the protocol headers.
 *
 * One source gives three things. Each type is a schema value below. Its TypeScript
 * type comes from the schema with `Infer`, its validator is `validate`, and its JSON
 * Schema is in `JSON_SCHEMAS`. Each object is closed: a validator refuses an
 * unknown field. String limits count Unicode code points, except a limit that says bytes.
 *
 * This module has no state and imports only `ids.ts`.
 */

import { LOGIN, REPO_KEY, RUNTIMES, SESSION_ADDRESS, SLUG, idPattern, type IdKind } from "./ids.ts";

// ---------------------------------------------------------------------------
// Schema builder

export type JsonSchema = { readonly [key: string]: unknown };

export interface Schema<T> {
  readonly json: JsonSchema;
  /** Add one line `<path>: <problem>` to `issues` for each problem. */
  check(value: unknown, path: string, issues: string[]): void;
  /** Type only. It has no value. */
  readonly type?: T;
}

export type Infer<S> = S extends Schema<infer T> ? T : never;

interface Optional<T> {
  readonly optional: Schema<T>;
}

type Field = Schema<unknown> | Optional<unknown>;
type Shape = { readonly [key: string]: Field };
type Simplify<T> = { [K in keyof T]: T[K] } & {};
type InferShape<S extends Shape> = Simplify<
  { readonly [K in keyof S as S[K] extends Optional<unknown> ? never : K]: Infer<S[K]> } & {
    readonly [K in keyof S as S[K] extends Optional<unknown> ? K : never]?: S[K] extends Optional<infer T> ? T : never;
  }
>;

export interface ObjectSchema<S extends Shape> extends Schema<InferShape<S>> {
  readonly shape: S;
}

/** A field that can be absent. */
export function optional<T>(schema: Schema<T>): Optional<T> {
  return { optional: schema };
}

function isOptional(field: Field): field is Optional<unknown> {
  return "optional" in field;
}

function describe(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "an array";
  return typeof value === "object" ? "an object" : typeof value;
}

export function str(
  options: { readonly min?: number; readonly max?: number; readonly maxBytes?: number; readonly pattern?: RegExp } = {},
): Schema<string> {
  const { min, max, maxBytes, pattern } = options;
  const json: Record<string, unknown> = { type: "string" };
  if (min !== undefined) json.minLength = min;
  if (max !== undefined) json.maxLength = max;
  if (pattern !== undefined) json.pattern = pattern.source;
  if (maxBytes !== undefined) json.description = `At most ${maxBytes} bytes in UTF-8.`;
  return {
    json,
    check(value, path, issues) {
      if (typeof value !== "string") return void issues.push(`${path}: expected a string, got ${describe(value)}`);
      const length = [...value].length;
      if (min !== undefined && length < min) issues.push(`${path}: shorter than ${min} characters`);
      if (max !== undefined && length > max) issues.push(`${path}: longer than ${max} characters`);
      if (maxBytes !== undefined && Buffer.byteLength(value, "utf8") > maxBytes) issues.push(`${path}: larger than ${maxBytes} bytes`);
      if (pattern !== undefined && !pattern.test(value)) issues.push(`${path}: does not match ${pattern.source}`);
    },
  };
}

export function int(options: { readonly min?: number; readonly max?: number } = {}): Schema<number> {
  const { min, max } = options;
  const json: Record<string, unknown> = { type: "integer" };
  if (min !== undefined) json.minimum = min;
  if (max !== undefined) json.maximum = max;
  return {
    json,
    check(value, path, issues) {
      if (typeof value !== "number" || !Number.isSafeInteger(value)) return void issues.push(`${path}: expected an integer, got ${describe(value)}`);
      if (min !== undefined && value < min) issues.push(`${path}: less than ${min}`);
      if (max !== undefined && value > max) issues.push(`${path}: more than ${max}`);
    },
  };
}

export function bool(): Schema<boolean> {
  return {
    json: { type: "boolean" },
    check(value, path, issues) {
      if (typeof value !== "boolean") issues.push(`${path}: expected a boolean, got ${describe(value)}`);
    },
  };
}

/** One of fixed values. */
export function oneOf<const V extends readonly (string | number | boolean)[]>(...values: V): Schema<V[number]> {
  return {
    json: values.length === 1 ? { const: values[0] } : { enum: values },
    check(value, path, issues) {
      if (!values.includes(value as V[number])) issues.push(`${path}: expected one of ${values.map((item) => JSON.stringify(item)).join(", ")}`);
    },
  };
}

export function nullable<T>(schema: Schema<T>): Schema<T | null> {
  return {
    json: { anyOf: [schema.json, { type: "null" }] },
    check(value, path, issues) {
      if (value !== null) schema.check(value, path, issues);
    },
  };
}

export function array<T>(item: Schema<T>, options: { readonly min?: number; readonly max?: number } = {}): Schema<readonly T[]> {
  const { min, max } = options;
  const json: Record<string, unknown> = { type: "array", items: item.json };
  if (min !== undefined) json.minItems = min;
  if (max !== undefined) json.maxItems = max;
  return {
    json,
    check(value, path, issues) {
      if (!Array.isArray(value)) return void issues.push(`${path}: expected an array, got ${describe(value)}`);
      if (min !== undefined && value.length < min) issues.push(`${path}: fewer than ${min} items`);
      if (max !== undefined && value.length > max) issues.push(`${path}: more than ${max} items`);
      value.forEach((entry, index) => item.check(entry, `${path}[${index}]`, issues));
    },
  };
}

/** An object with any fields, for `details` of an error. */
export function anyObject(): Schema<Readonly<Record<string, unknown>>> {
  return {
    json: { type: "object" },
    check(value, path, issues) {
      if (typeof value !== "object" || value === null || Array.isArray(value)) issues.push(`${path}: expected an object, got ${describe(value)}`);
    },
  };
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** A closed object. A field with the value `undefined` counts as absent. */
export function object<S extends Shape>(shape: S): ObjectSchema<S> {
  const properties: Record<string, JsonSchema> = {};
  const required: string[] = [];
  for (const [key, field] of Object.entries(shape)) {
    properties[key] = isOptional(field) ? field.optional.json : field.json;
    if (!isOptional(field)) required.push(key);
  }
  return {
    shape,
    json: { type: "object", properties, required, additionalProperties: false },
    check(value, path, issues) {
      if (!isPlainObject(value)) return void issues.push(`${path}: expected an object, got ${describe(value)}`);
      for (const key of Object.keys(value)) {
        if (!Object.hasOwn(shape, key) && value[key] !== undefined) issues.push(`${path}.${key}: unknown field`);
      }
      for (const [key, field] of Object.entries(shape)) {
        const entry = value[key];
        if (entry === undefined) {
          if (!isOptional(field)) issues.push(`${path}.${key}: missing`);
          continue;
        }
        (isOptional(field) ? field.optional : field).check(entry, `${path}.${key}`, issues);
      }
    },
  };
}

type Variants = { readonly [tag: string]: ObjectSchema<Shape> };
type InferTagged<K extends string, V extends Variants> = {
  [T in keyof V & string]: Simplify<{ readonly [P in K]: T } & Infer<V[T]>>;
}[keyof V & string];

/** A union of closed objects. The field `key` names the variant. */
export function tagged<const K extends string, const V extends Variants>(key: K, variants: V): Schema<InferTagged<K, V>> {
  const full = Object.fromEntries(
    Object.entries(variants).map(([tag, variant]) => [tag, object({ [key]: oneOf(tag), ...variant.shape })]),
  ) as Record<string, ObjectSchema<Shape>>;
  return {
    json: { oneOf: Object.values(full).map((variant) => variant.json) },
    check(value, path, issues) {
      if (!isPlainObject(value)) return void issues.push(`${path}: expected an object, got ${describe(value)}`);
      const tag = value[key];
      const variant = typeof tag === "string" && Object.hasOwn(full, tag) ? full[tag] : undefined;
      if (variant === undefined) return void issues.push(`${path}.${key}: expected one of ${Object.keys(full).map((item) => JSON.stringify(item)).join(", ")}`);
      variant.check(value, path, issues);
    },
  };
}

export type Validation<T> = { readonly ok: true; readonly value: T } | { readonly ok: false; readonly issues: readonly string[] };

/** Check a value against a schema. The issues name the path of each problem, from `$`. */
export function validate<T>(schema: Schema<T>, value: unknown): Validation<T> {
  const issues: string[] = [];
  schema.check(value, "$", issues);
  return issues.length === 0 ? { ok: true, value: value as T } : { ok: false, issues };
}

// ---------------------------------------------------------------------------
// Headers and limits

export const PROTOCOL_VERSION = 1;

export const HEADERS = {
  protocol: "Ferry-Protocol",
  version: "Ferry-Version",
  idempotencyKey: "Idempotency-Key",
  idempotentReplay: "Idempotent-Replay",
} as const;

/** The limits that the validators apply (design section 13). The relay applies the other limits. */
export const LIMITS = {
  requestBytes: 64 * 1024,
  bodyBytes: 16_384,
  task: 280,
  worktree: 128,
  host: 64,
  adapterReason: 200,
  deliveryDetail: 500,
  conversationName: 80,
  conversationSlug: 48,
  conversationPurpose: 500,
  links: 5,
  causeIds: 20,
  ackItems: 50,
  constraintText: 1_000,
  note: 1_000,
  evidence: 2_000,
  historyPage: 50,
  joinContextChars: 24_000,
  longPollMs: 25_000,
} as const;

/** The start of the envelope of design section 9.1. A prompt that contains it starts a peer turn. */
export const ENVELOPE_MARKER = '<ferry-message id="msg_';

// ---------------------------------------------------------------------------
// Errors

export const ERROR_STATUS = {
  "invalid-request": 400,
  unauthenticated: 401,
  "device-revoked": 401,
  "no-project-access": 403,
  "owner-not-allowed": 403,
  "app-not-installed": 403,
  "not-assignee": 403,
  "not-member": 403,
  "not-constraint-owner": 403,
  forbidden: 403,
  "not-found": 404,
  "enrollment-unknown": 404,
  "idempotency-mismatch": 409,
  "generation-conflict": 409,
  "stale-generation": 409,
  "request-closed": 409,
  "request-reassigned": 409,
  "in-progress": 409,
  "conversation-exists": 409,
  "conversation-similar": 409,
  "ambiguous-recipient": 409,
  "limit-reached": 409,
  "enrollment-expired": 410,
  "enrollment-denied": 410,
  "too-large": 413,
  "upgrade-required": 426,
  "rate-limited": 429,
  "access-unverifiable": 503,
  "github-unavailable": 503,
  unavailable: 503,
} as const;

export type ErrorCode = keyof typeof ERROR_STATUS;

export const ERROR_CODES = Object.keys(ERROR_STATUS) as ErrorCode[];

export const ErrorBody = object({
  error: object({
    code: oneOf(...ERROR_CODES),
    message: str(),
    hint: nullable(str()),
    details: optional(anyObject()),
  }),
});
export type ErrorBody = Infer<typeof ErrorBody>;

export function errorBody(code: ErrorCode, message: string, hint: string | null = null, details?: Readonly<Record<string, unknown>>): ErrorBody {
  return { error: details === undefined ? { code, message, hint } : { code, message, hint, details } };
}

// ---------------------------------------------------------------------------
// Shared types (design section 7.2)

const id = (kind: IdKind) => str({ pattern: idPattern(kind) });
const generation = () => int({ min: 0 });
const count = () => int({ min: 0 });

export const Iso = str({ pattern: /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/ });
export type Iso = Infer<typeof Iso>;

export const Runtime = oneOf(...RUNTIMES);
export type Runtime = Infer<typeof Runtime>;

export const Platform = oneOf("linux", "darwin");
export type Platform = Infer<typeof Platform>;

export const AdapterState = oneOf("supported", "untested", "unconfirmed", "unsupported");
export type AdapterState = Infer<typeof AdapterState>;

export const Activity = oneOf("idle", "busy", "awaiting-approval");
export type Activity = Infer<typeof Activity>;

export const SessionState = oneOf("live", "offline", "unknown", "retired");
export type SessionState = Infer<typeof SessionState>;

export const MessageKind = oneOf("update", "request", "answer", "constraint", "notice");
export type MessageKind = Infer<typeof MessageKind>;

export const RequestStatus = oneOf("pending", "delivered", "acknowledged", "answered", "cancelled", "closed");
export type RequestStatus = Infer<typeof RequestStatus>;

export const OPEN_REQUEST_STATUSES = ["pending", "delivered", "acknowledged"] as const satisfies readonly RequestStatus[];

export const RequestOutcome = oneOf("resolved", "unresolved", "declined", "superseded");
export type RequestOutcome = Infer<typeof RequestOutcome>;

export const Hold = oneOf(
  "wake-rate",
  "wake-hops",
  "recipient-offline",
  "worker-offline",
  "awaiting-approval",
  "runtime-unsupported",
  "runtime-unconfirmed",
);
export type Hold = Infer<typeof Hold>;

export const ReceiptState = oneOf("stored", "delivered", "acknowledged", "answered", "superseded");
export type ReceiptState = Infer<typeof ReceiptState>;

/** The text that the sender sees for each hold (design section 6.2). */
export const HOLD_DISPLAY: Readonly<Record<Hold, string>> = {
  "wake-rate": "held: wake limit",
  "wake-hops": "held: wake limit",
  "recipient-offline": "held: recipient offline",
  "worker-offline": "held: recipient host offline",
  "awaiting-approval": "held: recipient waiting for approval",
  "runtime-unsupported": "held: recipient runtime not supported",
  "runtime-unconfirmed": "held: delivery not confirmed",
};

/** The `display` text of a receipt: the hold text when the receipt has a hold, else the state. */
export function receiptDisplay(state: ReceiptState, hold: Hold | null): string {
  return hold === null ? state : HOLD_DISPLAY[hold];
}

export const Owner = object({ id: id("owner"), githubUserId: int({ min: 1 }), login: str({ pattern: LOGIN }) });
export type Owner = Infer<typeof Owner>;

export const SessionRef = object({
  id: id("session"),
  address: str({ pattern: SESSION_ADDRESS }),
  owner: Owner,
  runtime: Runtime,
});
export type SessionRef = Infer<typeof SessionRef>;

export const SessionInfo = object({
  ...SessionRef.shape,
  state: SessionState,
  activity: nullable(Activity),
  adapter: AdapterState,
  task: nullable(str({ max: LIMITS.task })),
  branch: nullable(str({ min: 1, max: 255 })),
  head: nullable(str({ pattern: /^[0-9a-f]{40}$/ })),
  worktree: nullable(str({ min: 1, max: LIMITS.worktree })),
  host: str({ max: LIMITS.host }),
  lastSeenAt: Iso,
  memberships: optional(array(id("conversation"))),
});
export type SessionInfo = Infer<typeof SessionInfo>;

export const Project = object({
  id: id("project"),
  key: str({ pattern: REPO_KEY }),
  repoId: int({ min: 1 }),
  access: oneOf("granted", "unverifiable"),
});
export type Project = Infer<typeof Project>;

export const Link = object({ kind: oneOf("issue", "branch"), ref: str({ min: 1, max: 255 }) });
export type Link = Infer<typeof Link>;

export const ConversationSummary = object({
  id: id("conversation"),
  projectId: id("project"),
  slug: str({ pattern: SLUG }),
  name: str({ min: 1, max: LIMITS.conversationName }),
  purpose: str({ min: 1, max: LIMITS.conversationPurpose }),
  links: array(Link, { max: LIMITS.links }),
  autoJoin: oneOf("none", "all"),
  participants: object({ live: count(), total: count() }),
  openRequests: count(),
  activeConstraints: count(),
  lastMessageAt: nullable(Iso),
  createdAt: Iso,
});
export type ConversationSummary = Infer<typeof ConversationSummary>;

export const RequestEvent = object({
  kind: str({ min: 1 }),
  at: Iso,
  actor: nullable(SessionRef),
  from: optional(SessionRef),
  to: optional(SessionRef),
  generation: generation(),
});
export type RequestEvent = Infer<typeof RequestEvent>;

export const RequestState = object({
  status: RequestStatus,
  outcome: nullable(RequestOutcome),
  assignee: SessionRef,
  assigneeAccess: oneOf("granted", "lost"),
  original: SessionRef,
  generation: int({ min: 1 }),
  ageMs: count(),
  answer: nullable(id("message")),
  events: array(RequestEvent),
});
export type RequestState = Infer<typeof RequestState>;

export const Message = object({
  id: id("message"),
  conversationId: id("conversation"),
  seq: int({ min: 1 }),
  kind: MessageKind,
  sender: SessionRef,
  body: str({ maxBytes: LIMITS.bodyBytes }),
  truncated: optional(bool()),
  to: array(SessionRef),
  answers: nullable(id("message")),
  hop: int({ min: 1 }),
  createdAt: Iso,
  request: optional(RequestState),
});
export type Message = Infer<typeof Message>;

export const Evidence = object({ kind: str({ min: 1 }), at: Iso });
export type Evidence = Infer<typeof Evidence>;

export const Receipt = object({
  id: id("receipt"),
  messageId: id("message"),
  recipient: SessionRef,
  generation: generation(),
  state: ReceiptState,
  hold: nullable(Hold),
  display: str(),
  evidence: array(Evidence),
  recipientState: SessionState,
});
export type Receipt = Infer<typeof Receipt>;

export const Constraint = object({
  id: id("constraint"),
  conversationId: id("conversation"),
  text: str({ min: 1, max: LIMITS.constraintText }),
  owner: Owner,
  responsible: SessionRef,
  sourceMessageId: id("message"),
  state: oneOf("active", "resolved"),
  createdAt: Iso,
  ageMs: count(),
  ownerAccess: oneOf("granted", "lost"),
  resolved: nullable(object({ at: Iso, by: SessionRef, as: oneOf("owner", "admin"), note: str({ max: LIMITS.note }) })),
});
export type Constraint = Infer<typeof Constraint>;

export const JoinContext = object({
  conversation: ConversationSummary,
  participants: array(SessionInfo),
  openRequests: array(Message),
  activeConstraints: array(Constraint),
  recent: array(Message),
  olderBefore: nullable(id("message")),
  size: object({ chars: count(), limit: oneOf(LIMITS.joinContextChars), omittedRecent: count() }),
});
export type JoinContext = Infer<typeof JoinContext>;

// ---------------------------------------------------------------------------
// Health and identity (design section 7.3)

export const Health = object({ ok: oneOf(true), protocol: oneOf(PROTOCOL_VERSION), minClientVersion: str(), relayVersion: str() });
export type Health = Infer<typeof Health>;

export const DeviceRef = object({ id: id("device"), name: str({ min: 1, max: LIMITS.host }) });
export type DeviceRef = Infer<typeof DeviceRef>;

export const Me = object({ owner: Owner, device: object({ ...DeviceRef.shape, platform: Platform, createdAt: Iso }) });
export type Me = Infer<typeof Me>;

// ---------------------------------------------------------------------------
// Enrollment and devices (design section 7.4)

const credentialSha256 = () => str({ pattern: /^[0-9a-f]{64}$/ });

export const EnrollStart = object({
  deviceName: str({ min: 1, max: LIMITS.host }),
  platform: Platform,
  ferryVersion: str({ min: 1, max: 64 }),
  credentialSha256: credentialSha256(),
});
export type EnrollStart = Infer<typeof EnrollStart>;

export const EnrollStarted = object({
  enrollmentId: str({ min: 1 }),
  userCode: str({ min: 1 }),
  verificationUri: str({ min: 1 }),
  intervalMs: int({ min: 0 }),
  expiresAt: Iso,
});
export type EnrollStarted = Infer<typeof EnrollStarted>;

export const EnrollPoll = object({ enrollmentId: str({ min: 1 }) });
export type EnrollPoll = Infer<typeof EnrollPoll>;

/** `pending` is HTTP 202, `complete` is HTTP 200. */
export const EnrollPolled = tagged("state", {
  pending: object({ intervalMs: int({ min: 0 }) }),
  complete: object({ owner: Owner, device: DeviceRef }),
});
export type EnrollPolled = Infer<typeof EnrollPolled>;

export const DeviceCreate = object({ name: str({ min: 1, max: LIMITS.host }), platform: Platform, credentialSha256: credentialSha256() });
export type DeviceCreate = Infer<typeof DeviceCreate>;

export const DeviceCreated = object({ device: DeviceRef });
export type DeviceCreated = Infer<typeof DeviceCreated>;

export const DeviceList = object({
  devices: array(
    object({ ...DeviceRef.shape, platform: Platform, createdAt: Iso, lastSeenAt: nullable(Iso), revokedAt: nullable(Iso) }),
  ),
});
export type DeviceList = Infer<typeof DeviceList>;

export const DeviceRevoked = object({ device: object({ id: id("device"), revokedAt: Iso }) });
export type DeviceRevoked = Infer<typeof DeviceRevoked>;

// ---------------------------------------------------------------------------
// Sessions and workers (design section 7.5)

export const SessionSource = oneOf("startup", "resume", "clear", "compact", "fork");
export type SessionSource = Infer<typeof SessionSource>;

export const SessionRegister = object({
  runtime: Runtime,
  runtimeSessionId: str({ min: 1, max: 200 }),
  runtimeVersion: str({ min: 1, max: 64 }),
  adapter: AdapterState,
  repo: nullable(object({ key: str({ pattern: REPO_KEY }) })),
  branch: nullable(str({ min: 1, max: 255 })),
  head: nullable(str({ pattern: /^[0-9a-f]{40}$/ })),
  worktree: nullable(str({ min: 1, max: LIMITS.worktree })),
  task: nullable(str({ max: LIMITS.task })),
  source: SessionSource,
});
export type SessionRegister = Infer<typeof SessionRegister>;

export const RefusalCode = oneOf("no-project-access", "app-not-installed", "owner-not-allowed", "access-unverifiable", "github-unavailable");
export type RefusalCode = Infer<typeof RefusalCode>;

export const SessionRegistered = object({
  session: SessionInfo,
  project: nullable(Project),
  refusal: nullable(object({ code: RefusalCode, message: str() })),
  autoJoined: array(ConversationSummary),
  assigned: array(Message),
  pendingUpdates: count(),
});
export type SessionRegistered = Infer<typeof SessionRegistered>;

export const SessionUpdate = object({
  task: optional(nullable(str({ max: LIMITS.task }))),
  branch: optional(nullable(str({ min: 1, max: 255 }))),
  head: optional(nullable(str({ pattern: /^[0-9a-f]{40}$/ }))),
  adapter: optional(AdapterState),
  adapterReason: optional(nullable(str({ max: LIMITS.adapterReason }))),
});
export type SessionUpdate = Infer<typeof SessionUpdate>;

/** The response of `PATCH /v1/sessions/{id}` and `POST /v1/sessions/{id}/end`. */
export const SessionResult = object({ session: SessionInfo });
export type SessionResult = Infer<typeof SessionResult>;

export const SessionEnd = object({ reason: oneOf("exit", "crash", "replaced", "retired") });
export type SessionEnd = Infer<typeof SessionEnd>;

export const Heartbeat = object({
  sessions: array(object({ id: id("session"), state: oneOf("live", "offline"), activity: nullable(Activity) })),
});
export type Heartbeat = Infer<typeof Heartbeat>;

export const HeartbeatAck = object({ serverTime: Iso });
export type HeartbeatAck = Infer<typeof HeartbeatAck>;

const seq = () => int({ min: 1 });

export const RelayEvent = tagged("type", {
  "delivery.ready": object({
    seq: seq(),
    receiptId: id("receipt"),
    sessionId: id("session"),
    messageId: id("message"),
    kind: MessageKind,
    wake: bool(),
  }),
  "request.changed": object({ seq: seq(), sessionId: id("session"), request: id("message"), state: RequestState }),
  "membership.changed": object({
    seq: seq(),
    sessionId: id("session"),
    conversationId: id("conversation"),
    state: oneOf("active", "left", "suspended", "ended"),
    reason: nullable(str()),
  }),
  "constraint.changed": object({ seq: seq(), sessionId: id("session"), constraint: Constraint }),
  "session.access-lost": object({ seq: seq(), sessionId: id("session"), projectId: id("project") }),
  "session.moved": object({ seq: seq(), sessionId: id("session"), toDeviceId: id("device") }),
  "device.revoked": object({ seq: seq() }),
});
export type RelayEvent = Infer<typeof RelayEvent>;
export type RelayEventType = RelayEvent["type"];

/** `resync: true`: the cursor is older than the kept events. The worker reloads its sessions. */
export const Events = object({ cursor: count(), events: array(RelayEvent), resync: bool() });
export type Events = Infer<typeof Events>;

export const PendingReceipt = object({ ...Receipt.shape, message: Message });
export type PendingReceipt = Infer<typeof PendingReceipt>;

export const Pending = object({ receipts: array(PendingReceipt), heldByHops: array(PendingReceipt) });
export type Pending = Infer<typeof Pending>;

export const RequestList = object({ requests: array(Message), next: nullable(str()) });
export type RequestList = Infer<typeof RequestList>;

export const Dispatch = object({ generation: generation(), activity: Activity });
export type Dispatch = Infer<typeof Dispatch>;

export const DropReason = oneOf("request-closed", "request-reassigned", "stale-generation", "already-acknowledged", "access-lost", "session-retired");
export type DropReason = Infer<typeof DropReason>;

export const DispatchDecision = tagged("decision", {
  go: object({ leaseUntil: Iso, envelope: str({ min: 1 }) }),
  hold: object({ hold: Hold }),
  drop: object({ reason: DropReason }),
});
export type DispatchDecision = Infer<typeof DispatchDecision>;

export const DeliveryResult = object({
  generation: generation(),
  outcome: oneOf("delivered", "unconfirmed", "failed", "stranded", "offline"),
  evidence: nullable(object({ kind: oneOf("transcript", "codex-queue-consumed", "context-digest"), at: Iso })),
  detail: nullable(str({ max: LIMITS.deliveryDetail })),
});
export type DeliveryResult = Infer<typeof DeliveryResult>;

/** The response of `POST /v1/deliveries/{receiptId}/result`. */
export const ReceiptResult = object({ receipt: Receipt });
export type ReceiptResult = Infer<typeof ReceiptResult>;

// ---------------------------------------------------------------------------
// Conversations (design section 7.6)

export const ProjectResult = object({ project: Project });
export type ProjectResult = Infer<typeof ProjectResult>;

export const ConversationList = object({ conversations: array(ConversationSummary) });
export type ConversationList = Infer<typeof ConversationList>;

export const ConversationCreate = object({
  sessionId: id("session"),
  name: str({ min: 1, max: LIMITS.conversationName }),
  slug: optional(str({ pattern: SLUG })),
  purpose: str({ min: 1, max: LIMITS.conversationPurpose }),
  links: optional(array(Link, { max: LIMITS.links })),
  autoJoin: optional(oneOf("none", "all")),
  force: optional(bool()),
});
export type ConversationCreate = Infer<typeof ConversationCreate>;

export const ConversationCreated = object({ conversation: ConversationSummary, context: JoinContext });
export type ConversationCreated = Infer<typeof ConversationCreated>;

/** The body of join and leave. */
export const SessionCall = object({ sessionId: id("session") });
export type SessionCall = Infer<typeof SessionCall>;

export const Left = object({ state: oneOf("left") });
export type Left = Infer<typeof Left>;

export const MessagePage = object({ messages: array(Message), next: nullable(id("message")) });
export type MessagePage = Infer<typeof MessagePage>;

export const SessionList = object({ sessions: array(SessionInfo) });
export type SessionList = Infer<typeof SessionList>;

// ---------------------------------------------------------------------------
// Messages, receipts, and requests (design section 7.7)

export const MessageCreate = object({
  sessionId: id("session"),
  kind: oneOf("update", "request", "answer"),
  body: str({ min: 1, maxBytes: LIMITS.bodyBytes }),
  to: optional(str({ min: 1, max: 200 })),
  answers: optional(id("message")),
  generation: optional(int({ min: 1 })),
  causeIds: optional(array(id("message"), { max: LIMITS.causeIds })),
});
export type MessageCreate = Infer<typeof MessageCreate>;

export const MessageCreated = object({ message: Message, receipts: array(Receipt) });
export type MessageCreated = Infer<typeof MessageCreated>;

/** The response of `GET /v1/messages/{id}`. */
export const MessageDetail = MessageCreated;
export type MessageDetail = MessageCreated;

export const Ack = object({
  sessionId: id("session"),
  items: array(object({ id: id("message"), generation: optional(int({ min: 1 })) }), { min: 1, max: LIMITS.ackItems }),
});
export type Ack = Infer<typeof Ack>;

export const AckResult = oneOf(
  "acknowledged",
  "already-acknowledged",
  "stale-generation",
  "request-reassigned",
  "request-closed",
  "not-recipient",
);
export type AckResult = Infer<typeof AckResult>;

export const Acked = object({ items: array(object({ id: id("message"), result: AckResult })) });
export type Acked = Infer<typeof Acked>;

const note = () => str({ max: LIMITS.note });

export const RequestAction = tagged("action", {
  claim: object({ sessionId: id("session"), expectedGeneration: int({ min: 1 }), takeover: optional(bool()) }),
  reassign: object({ sessionId: id("session"), expectedGeneration: int({ min: 1 }), to: str({ min: 1, max: 200 }) }),
  cancel: object({ sessionId: id("session"), expectedGeneration: int({ min: 1 }), note: note() }),
  close: object({ sessionId: id("session"), expectedGeneration: int({ min: 1 }), outcome: RequestOutcome, note: note() }),
});
export type RequestAction = Infer<typeof RequestAction>;

export const RequestActionResult = object({ message: Message });
export type RequestActionResult = Infer<typeof RequestActionResult>;

// ---------------------------------------------------------------------------
// Constraints (design section 7.8)

export const ConstraintList = object({ constraints: array(Constraint) });
export type ConstraintList = Infer<typeof ConstraintList>;

export const ConstraintCreate = object({
  sessionId: id("session"),
  text: str({ min: 1, max: LIMITS.constraintText }),
  sourceMessageId: optional(id("message")),
});
export type ConstraintCreate = Infer<typeof ConstraintCreate>;

/** The response of `POST /v1/conversations/{id}/constraints`. */
export const ConstraintCreated = object({ constraint: Constraint });
export type ConstraintCreated = Infer<typeof ConstraintCreated>;

export const ConstraintAction = tagged("action", {
  adopt: object({ sessionId: id("session") }),
  resolve: object({ sessionId: id("session"), note: note() }),
  "request-resolution": object({ sessionId: id("session"), evidence: str({ min: 1, max: LIMITS.evidence }) }),
});
export type ConstraintAction = Infer<typeof ConstraintAction>;

export const ConstraintActionResult = object({ constraint: Constraint, request: optional(Message) });
export type ConstraintActionResult = Infer<typeof ConstraintActionResult>;

// ---------------------------------------------------------------------------
// JSON Schemas

const SCHEMAS = {
  ErrorBody,
  Health,
  Me,
  EnrollStart,
  EnrollStarted,
  EnrollPoll,
  EnrollPolled,
  DeviceCreate,
  DeviceCreated,
  DeviceList,
  DeviceRevoked,
  SessionRegister,
  SessionRegistered,
  SessionUpdate,
  SessionResult,
  SessionEnd,
  Heartbeat,
  HeartbeatAck,
  Events,
  Pending,
  RequestList,
  Dispatch,
  DispatchDecision,
  DeliveryResult,
  ReceiptResult,
  ProjectResult,
  ConversationList,
  ConversationCreate,
  ConversationCreated,
  SessionCall,
  Left,
  JoinContext,
  MessagePage,
  SessionList,
  MessageCreate,
  MessageCreated,
  MessageDetail,
  Ack,
  Acked,
  RequestAction,
  RequestActionResult,
  ConstraintList,
  ConstraintCreate,
  ConstraintCreated,
  ConstraintAction,
  ConstraintActionResult,
} as const satisfies Record<string, Schema<unknown>>;

/** The JSON Schema of each request and response type, by type name. */
export const JSON_SCHEMAS: Readonly<Record<keyof typeof SCHEMAS, JsonSchema>> = Object.fromEntries(
  Object.entries(SCHEMAS).map(([name, schema]): [string, JsonSchema] => [
    name,
    { $schema: "https://json-schema.org/draft/2020-12/schema", title: name, ...schema.json },
  ]),
) as Record<keyof typeof SCHEMAS, JsonSchema>;
