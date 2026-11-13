/**
 * The protocol views of stored records, and the join context of a conversation
 * (design section 7.6).
 *
 * Join context selection:
 *
 * 1. Purpose, participants (at most 50, live ones first), all open requests (at
 *    most 50, newest first, each body cut at 1,500 characters), and all active constraints.
 * 2. Then recent messages, newest first, each body cut at 1,500 characters, until
 *    20 messages or the 24,000-character limit. An open request is not repeated there.
 * 3. If the parts of step 1 exceed the limit, constraint texts are cut to 500
 *    characters and request bodies to 300, and no recent message is added. An
 *    active constraint is never left out.
 *
 * The size is the length of the JSON text of the context.
 */

import { LIMITS, receiptDisplay, type Constraint, type ConversationSummary, type JoinContext, type Message, type Owner, type Receipt, type RequestState, type SessionInfo, type SessionRef } from "../protocol.ts";
import { accessLost } from "./access.ts";
import { PAGE_LIMIT } from "./limits.ts";
import { RelayError, type Store } from "./store.ts";

export type SessionRow = {
  id: string;
  address: string;
  owner_id: string;
  device_id: string;
  runtime: "claude" | "codex";
  runtime_session_id: string;
  runtime_version: string;
  adapter: SessionInfo["adapter"];
  project_id: string | null;
  branch: string | null;
  head: string | null;
  worktree: string | null;
  task: string | null;
  state: SessionInfo["state"];
  activity: SessionInfo["activity"];
  registered_at: string;
  last_seen_at: string;
  ended_at: string | null;
  ended_reason: string | null;
};

export type MessageRow = {
  id: string;
  conversation_id: string;
  seq: number;
  kind: Message["kind"];
  sender_session_id: string;
  sender_owner_id: string;
  body: string;
  answers_id: string | null;
  hop: number;
  created_at: string;
};

export type RequestRow = {
  message_id: string;
  status: RequestState["status"];
  outcome: RequestState["outcome"];
  original_session_id: string;
  assignee_session_id: string;
  generation: number;
  answer_message_id: string | null;
  updated_at: string;
  closed_at: string | null;
};

export type ReceiptRow = {
  id: string;
  message_id: string;
  recipient_session_id: string;
  generation: number;
  wake: 0 | 1;
  state: Receipt["state"];
  hold: Receipt["hold"];
  stored_at: string;
  delivered_at: string | null;
  delivered_evidence: string | null;
  acknowledged_at: string | null;
  answered_at: string | null;
  attempts: number;
  lease_until: string | null;
  failures: number;
  retry_at: string | null;
};

export type ConversationRow = {
  id: string;
  project_id: string;
  slug: string;
  name: string;
  purpose: string;
  auto_join: "none" | "all";
  created_by_session_id: string;
  created_at: string;
  next_seq: number;
};

export type ConstraintRow = {
  id: string;
  conversation_id: string;
  text: string;
  owner_id: string;
  responsible_session_id: string;
  source_message_id: string;
  state: "active" | "resolved";
  created_at: string;
  resolved_at: string | null;
  resolved_by_session_id: string | null;
  resolved_as: "owner" | "admin" | null;
  resolution_note: string | null;
};

export const BODY_CUT = 1_500;
export const TIGHT_BODY_CUT = 300;
export const TIGHT_CONSTRAINT_CUT = 500;
export const RECENT_MESSAGES = 20;
export const CONTEXT_PARTICIPANTS = 50;
export const CONTEXT_OPEN_REQUESTS = 50;

export function getSession(store: Store, sessionId: string): SessionRow {
  const row = store.db.query<SessionRow, [string]>("SELECT * FROM sessions WHERE id = ?").get(sessionId);
  if (row === null) throw new RelayError("not-found", `Session ${sessionId} does not exist.`);
  return row;
}

export function getMessage(store: Store, messageId: string): MessageRow {
  const row = store.db.query<MessageRow, [string]>("SELECT * FROM messages WHERE id = ?").get(messageId);
  if (row === null) throw new RelayError("not-found", `Message ${messageId} does not exist.`);
  return row;
}

export function getConversation(store: Store, conversationId: string): ConversationRow {
  const row = store.db.query<ConversationRow, [string]>("SELECT * FROM conversations WHERE id = ?").get(conversationId);
  if (row === null) throw new RelayError("not-found", `Conversation ${conversationId} does not exist.`);
  return row;
}

export function getRequest(store: Store, messageId: string): RequestRow | null {
  return store.db.query<RequestRow, [string]>("SELECT * FROM requests WHERE message_id = ?").get(messageId);
}

export function ownerView(store: Store, ownerId: string): Owner {
  const row = store.db
    .query<{ id: string; github_user_id: number; login: string }, [string]>("SELECT id, github_user_id, login FROM owners WHERE id = ?")
    .get(ownerId);
  if (row === null) throw new RelayError("not-found", `Owner ${ownerId} does not exist.`);
  return { id: row.id, githubUserId: row.github_user_id, login: row.login };
}

export function sessionRef(store: Store, sessionId: string): SessionRef {
  const row = getSession(store, sessionId);
  return { id: row.id, address: row.address, owner: ownerView(store, row.owner_id), runtime: row.runtime };
}

export function sessionInfo(store: Store, sessionId: string, withMemberships = false): SessionInfo {
  const row = getSession(store, sessionId);
  const host = store.db.query<{ name: string }, [string]>("SELECT name FROM devices WHERE id = ?").get(row.device_id)?.name ?? "";
  const info: SessionInfo = {
    id: row.id,
    address: row.address,
    owner: ownerView(store, row.owner_id),
    runtime: row.runtime,
    state: row.state,
    activity: row.state === "live" ? row.activity : null,
    adapter: row.adapter,
    task: row.task,
    branch: row.branch,
    head: row.head,
    worktree: row.worktree,
    host,
    lastSeenAt: row.last_seen_at,
  };
  if (!withMemberships) return info;
  const memberships = store.db
    .query<{ conversation_id: string }, [string]>("SELECT conversation_id FROM memberships WHERE session_id = ? AND state = 'active' ORDER BY joined_at")
    .all(sessionId)
    .map((membership) => membership.conversation_id);
  return { ...info, memberships };
}

/** `<repo>/<slug>`, for example `vendure-cloud/production-applies`. */
export function conversationRef(store: Store, conversation: ConversationRow): string {
  const fullName = store.db.query<{ full_name: string }, [string]>("SELECT full_name FROM projects WHERE id = ?").get(conversation.project_id)?.full_name;
  return `${fullName?.split("/")[1] ?? ""}/${conversation.slug}`;
}

export function conversationSummary(store: Store, conversationId: string): ConversationSummary {
  const row = getConversation(store, conversationId);
  const links = store.db
    .query<{ kind: "issue" | "branch"; ref: string }, [string]>("SELECT kind, ref FROM conversation_links WHERE conversation_id = ? ORDER BY kind, ref")
    .all(conversationId);
  const participants = store.db
    .query<{ live: number; total: number }, [string]>(
      `SELECT coalesce(sum(s.state = 'live'), 0) AS live, count(*) AS total FROM memberships m JOIN sessions s ON s.id = m.session_id
       WHERE m.conversation_id = ? AND m.state = 'active'`,
    )
    .get(conversationId) ?? { live: 0, total: 0 };
  const counts = store.db
    .query<{ open_requests: number; active_constraints: number; last_message_at: string | null }, [string, string, string]>(
      `SELECT
         (SELECT count(*) FROM requests r JOIN messages m ON m.id = r.message_id
          WHERE m.conversation_id = ? AND r.status IN ('pending','delivered','acknowledged')) AS open_requests,
         (SELECT count(*) FROM constraints WHERE conversation_id = ? AND state = 'active') AS active_constraints,
         (SELECT max(created_at) FROM messages WHERE conversation_id = ?) AS last_message_at`,
    )
    .get(conversationId, conversationId, conversationId);
  return {
    id: row.id,
    projectId: row.project_id,
    slug: row.slug,
    name: row.name,
    purpose: row.purpose,
    links,
    autoJoin: row.auto_join,
    participants: { live: participants.live, total: participants.total },
    openRequests: counts?.open_requests ?? 0,
    activeConstraints: counts?.active_constraints ?? 0,
    lastMessageAt: counts?.last_message_at ?? null,
    createdAt: row.created_at,
  };
}

function projectOfConversation(store: Store, conversationId: string): string {
  return getConversation(store, conversationId).project_id;
}

export function requestState(store: Store, messageId: string): RequestState {
  const request = getRequest(store, messageId);
  if (request === null) throw new RelayError("not-found", `Request ${messageId} does not exist.`);
  const message = getMessage(store, messageId);
  const assignee = getSession(store, request.assignee_session_id);
  const projectId = projectOfConversation(store, message.conversation_id);
  const events = store.db
    .query<
      { kind: string; at: string; actor_session_id: string | null; from_session_id: string | null; to_session_id: string | null; generation: number },
      [string]
    >("SELECT kind, at, actor_session_id, from_session_id, to_session_id, generation FROM request_events WHERE request_id = ? ORDER BY id")
    .all(messageId)
    .map((event) => ({
      kind: event.kind,
      at: event.at,
      actor: event.actor_session_id === null ? null : sessionRef(store, event.actor_session_id),
      ...(event.from_session_id === null ? {} : { from: sessionRef(store, event.from_session_id) }),
      ...(event.to_session_id === null ? {} : { to: sessionRef(store, event.to_session_id) }),
      generation: event.generation,
    }));
  return {
    status: request.status,
    outcome: request.outcome,
    assignee: sessionRef(store, assignee.id),
    assigneeAccess: accessLost(store, assignee.owner_id, projectId) ? "lost" : "granted",
    original: sessionRef(store, request.original_session_id),
    generation: request.generation,
    ageMs: Math.max(0, store.now() - Date.parse(message.created_at)),
    answer: request.answer_message_id,
    events,
  };
}

/** Cut `text` to `limit` code points. */
export function cut(text: string, limit: number): { text: string; truncated: boolean } {
  const points = [...text];
  return points.length <= limit ? { text, truncated: false } : { text: points.slice(0, limit).join(""), truncated: true };
}

function recipients(store: Store, row: MessageRow): SessionRef[] {
  if (row.kind === "request") {
    const request = getRequest(store, row.id);
    return request === null ? [] : [sessionRef(store, request.original_session_id)];
  }
  if (row.kind === "answer" && row.answers_id !== null) return [sessionRef(store, getMessage(store, row.answers_id).sender_session_id)];
  if (row.kind === "notice") {
    return store.db
      .query<{ recipient_session_id: string }, [string]>("SELECT DISTINCT recipient_session_id FROM receipts WHERE message_id = ? ORDER BY recipient_session_id")
      .all(row.id)
      .map((receipt) => sessionRef(store, receipt.recipient_session_id));
  }
  return [];
}

/** The message view. With `bodyLimit`, the body is cut and `truncated` is set. A request always has its current state. */
export function messageView(store: Store, rowOrId: MessageRow | string, bodyLimit?: number): Message {
  const row = typeof rowOrId === "string" ? getMessage(store, rowOrId) : rowOrId;
  const body = bodyLimit === undefined ? { text: row.body, truncated: false } : cut(row.body, bodyLimit);
  const message: Message = {
    id: row.id,
    conversationId: row.conversation_id,
    seq: row.seq,
    kind: row.kind,
    sender: sessionRef(store, row.sender_session_id),
    body: body.text,
    ...(body.truncated ? { truncated: true } : {}),
    to: recipients(store, row),
    answers: row.answers_id,
    hop: row.hop,
    createdAt: row.created_at,
  };
  return row.kind === "request" ? { ...message, request: requestState(store, row.id) } : message;
}

export function receiptView(store: Store, rowOrId: ReceiptRow | string): Receipt {
  const row =
    typeof rowOrId === "string" ? store.db.query<ReceiptRow, [string]>("SELECT * FROM receipts WHERE id = ?").get(rowOrId) : rowOrId;
  if (row === null) throw new RelayError("not-found", `Receipt ${String(rowOrId)} does not exist.`);
  const evidence = [{ kind: "relay-commit", at: row.stored_at }];
  if (row.delivered_at !== null) evidence.push({ kind: row.delivered_evidence ?? "transcript", at: row.delivered_at });
  if (row.acknowledged_at !== null) evidence.push({ kind: "ferry-ack", at: row.acknowledged_at });
  if (row.answered_at !== null) evidence.push({ kind: "ferry-answer", at: row.answered_at });
  return {
    id: row.id,
    messageId: row.message_id,
    recipient: sessionRef(store, row.recipient_session_id),
    generation: row.generation,
    state: row.state,
    hold: row.hold,
    display: receiptDisplay(row.state, row.hold),
    evidence,
    recipientState: getSession(store, row.recipient_session_id).state,
  };
}

export function receiptsOf(store: Store, messageId: string): Receipt[] {
  return store.db
    .query<ReceiptRow, [string]>("SELECT * FROM receipts WHERE message_id = ? ORDER BY stored_at, id")
    .all(messageId)
    .map((row) => receiptView(store, row));
}

export function constraintView(store: Store, rowOrId: ConstraintRow | string, textLimit?: number): Constraint {
  const row =
    typeof rowOrId === "string" ? store.db.query<ConstraintRow, [string]>("SELECT * FROM constraints WHERE id = ?").get(rowOrId) : rowOrId;
  if (row === null) throw new RelayError("not-found", `Constraint ${String(rowOrId)} does not exist.`);
  const projectId = projectOfConversation(store, row.conversation_id);
  return {
    id: row.id,
    conversationId: row.conversation_id,
    text: textLimit === undefined ? row.text : cut(row.text, textLimit).text,
    owner: ownerView(store, row.owner_id),
    responsible: sessionRef(store, row.responsible_session_id),
    sourceMessageId: row.source_message_id,
    state: row.state,
    createdAt: row.created_at,
    ageMs: Math.max(0, store.now() - Date.parse(row.created_at)),
    ownerAccess: accessLost(store, row.owner_id, projectId) ? "lost" : "granted",
    resolved:
      row.state === "resolved" && row.resolved_at !== null && row.resolved_by_session_id !== null && row.resolved_as !== null
        ? { at: row.resolved_at, by: sessionRef(store, row.resolved_by_session_id), as: row.resolved_as, note: row.resolution_note ?? "" }
        : null,
  };
}

export function joinContext(store: Store, conversationId: string): JoinContext {
  const conversation = conversationSummary(store, conversationId);
  const participants = store.db
    .query<{ session_id: string }, [string, number]>(
      `SELECT m.session_id FROM memberships m JOIN sessions s ON s.id = m.session_id
       WHERE m.conversation_id = ? AND m.state = 'active' ORDER BY s.state = 'live' DESC, s.last_seen_at DESC LIMIT ?`,
    )
    .all(conversationId, CONTEXT_PARTICIPANTS)
    .map((row) => sessionInfo(store, row.session_id));
  const openRows = store.db
    .query<MessageRow, [string, number]>(
      `SELECT m.* FROM messages m JOIN requests r ON r.message_id = m.id
       WHERE m.conversation_id = ? AND r.status IN ('pending','delivered','acknowledged') ORDER BY m.seq DESC LIMIT ?`,
    )
    .all(conversationId, CONTEXT_OPEN_REQUESTS);
  const constraintRows = store.db
    .query<ConstraintRow, [string]>("SELECT * FROM constraints WHERE conversation_id = ? AND state = 'active' ORDER BY created_at")
    .all(conversationId);
  const openIds = new Set(openRows.map((row) => row.id));
  const others = store.db
    .query<{ n: number }, [string]>("SELECT count(*) AS n FROM messages WHERE conversation_id = ?")
    .get(conversationId)?.n ?? 0;
  const otherCount = others - openRows.length;

  const limit = LIMITS.joinContextChars;
  const context: JoinContext = {
    conversation,
    participants,
    openRequests: openRows.map((row) => messageView(store, row, BODY_CUT)),
    activeConstraints: constraintRows.map((row) => constraintView(store, row)),
    recent: [],
    olderBefore: null,
    size: { chars: 0, limit, omittedRecent: otherCount },
  };
  if (size(context) > limit) {
    const tight: JoinContext = {
      ...context,
      openRequests: openRows.map((row) => messageView(store, row, TIGHT_BODY_CUT)),
      activeConstraints: constraintRows.map((row) => constraintView(store, row, TIGHT_CONSTRAINT_CUT)),
    };
    return withSize(tight);
  }
  const recent: Message[] = [];
  let chars = size(context);
  const page = store.db.query<MessageRow, [string, number, number]>(
    "SELECT * FROM messages WHERE conversation_id = ? AND seq < ? ORDER BY seq DESC LIMIT ?",
  );
  let before = Number.MAX_SAFE_INTEGER;
  outer: while (recent.length < RECENT_MESSAGES) {
    const rows = page.all(conversationId, before, PAGE_LIMIT);
    if (rows.length === 0) break;
    for (const row of rows) {
      before = row.seq;
      if (openIds.has(row.id)) continue;
      const message = messageView(store, row, BODY_CUT);
      const added = JSON.stringify(message).length + (recent.length === 0 ? 0 : 1);
      if (chars + added > limit) break outer;
      recent.push(message);
      chars += added;
      if (recent.length === RECENT_MESSAGES) break outer;
    }
  }
  for (;;) {
    const omittedRecent = otherCount - recent.length;
    const oldest = recent.at(-1);
    const olderBefore = omittedRecent > 0 && oldest !== undefined ? oldest.id : null;
    const result = withSize({ ...context, recent, olderBefore, size: { chars: 0, limit, omittedRecent } });
    // The cursor and the size number add a few characters. Drop the oldest message when they pass the limit.
    if (result.size.chars <= limit || recent.length === 0) return result;
    recent.pop();
  }
}

function size(context: JoinContext): number {
  return JSON.stringify(context).length;
}

function withSize(context: JoinContext): JoinContext {
  // The size number is part of the text, so measure with the final number of digits.
  const first = size(context);
  const measured = size({ ...context, size: { ...context.size, chars: first } });
  return { ...context, size: { ...context.size, chars: measured } };
}

/** A page of history, newest first, before the message `before`. */
export function messagesPage(store: Store, conversationId: string, before: string | null, limit: number): { messages: Message[]; next: string | null } {
  let beforeSeq = Number.MAX_SAFE_INTEGER;
  if (before !== null) {
    const row = getMessage(store, before);
    if (row.conversation_id !== conversationId) throw new RelayError("invalid-request", `Message ${before} is not in this conversation.`);
    beforeSeq = row.seq;
  }
  const rows = store.db
    .query<MessageRow, [string, number, number]>("SELECT * FROM messages WHERE conversation_id = ? AND seq < ? ORDER BY seq DESC LIMIT ?")
    .all(conversationId, beforeSeq, limit + 1);
  const page = rows.slice(0, limit);
  return { messages: page.map((row) => messageView(store, row)), next: rows.length > limit ? (page.at(-1)?.id ?? null) : null };
}
