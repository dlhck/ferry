/**
 * Messages, acknowledgements, and the request lifecycle (design sections 6.4, 6.5, and 7.7).
 *
 * | From | To | Who |
 * | --- | --- | --- |
 * | (none) | pending | the sender session, generation 1 |
 * | pending | delivered | the worker of the assignee, when the receipt is delivered |
 * | pending, delivered | acknowledged | the assignee session, with the current generation |
 * | pending, delivered, acknowledged | answered | the assignee session, with the current generation |
 * | open | pending, new assignee (claim) | a session of the assignee's owner |
 * | open | pending, new assignee (reassign) | a session of the sender's or the assignee's owner |
 * | open | cancelled | a session of the sender's owner |
 * | open | closed | the sender's owner (any outcome), or the assignee's owner (declined, unresolved) |
 *
 * Claim, reassign, cancel, and close raise the generation with one
 * compare-and-swap, so one of two concurrent claims wins.
 */

import { LOGIN, isId, newId, parseSessionAddress } from "../ids.ts";
import {
  OPEN_REQUEST_STATUSES,
  type Ack,
  type Acked,
  type AckResult,
  type Message,
  type MessageCreate,
  type MessageCreated,
  type RequestAction,
} from "../protocol.ts";
import { checkAccess, type Access } from "./access.ts";
import { joinConversation, requireMember } from "./conversations.ts";
import {
  getConversation,
  getMessage,
  getRequest,
  getSession,
  messageView,
  receiptsOf,
  sessionInfo,
  sessionRef,
  type ConversationRow,
  type MessageRow,
  type ReceiptRow,
  type RequestRow,
  type SessionRow,
} from "./context.ts";
import { PAGE_LIMIT, checkSendRate } from "./limits.ts";
import { createReceipt, requestChanged, requestEvent, supersedeRequestReceipts } from "./receipts.ts";
import { RelayError, type Store } from "./store.ts";

const OPEN: readonly string[] = OPEN_REQUEST_STATUSES;

export function isOpen(request: RequestRow): boolean {
  return OPEN.includes(request.status);
}

/** Insert a message with the next sequence number of its conversation. */
export function insertMessage(
  store: Store,
  conversationId: string,
  sender: SessionRow,
  kind: Message["kind"],
  body: string,
  hop: number,
  answers: string | null = null,
): MessageRow {
  const seq = store.db
    .query<{ seq: number }, [string]>("UPDATE conversations SET next_seq = next_seq + 1 WHERE id = ? RETURNING next_seq - 1 AS seq")
    .get(conversationId)?.seq;
  if (seq === undefined) throw new RelayError("not-found", `Conversation ${conversationId} does not exist.`);
  const id = newId("message", store.now());
  store.db
    .query(
      `INSERT INTO messages (id, conversation_id, seq, kind, sender_session_id, sender_owner_id, body, answers_id, hop, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(id, conversationId, seq, kind, sender.id, sender.owner_id, body, answers, hop, store.iso());
  return getMessage(store, id);
}

/** A new receipt id with the relay clock. */
function receiptId(store: Store): string {
  return newId("receipt", store.now());
}

/**
 * The hop of a message from the session (design section 6.5): 1 from a human
 * turn, else 1 plus the highest hop of the messages that started or entered the
 * turn. Only messages that the session received count.
 */
function hopOf(store: Store, sender: SessionRow, causeIds: readonly string[]): number {
  if (causeIds.length === 0) return 1;
  const rows = store.db
    .query<{ hop: number }, string[]>(
      `SELECT m.hop FROM messages m WHERE m.id IN (${causeIds.map(() => "?").join(",")})
       AND EXISTS (SELECT 1 FROM receipts r WHERE r.message_id = m.id AND r.recipient_session_id = ?)`,
    )
    .all(...causeIds, sender.id);
  return rows.length === 0 ? 1 : 1 + Math.max(...rows.map((row) => row.hop));
}

/**
 * The recipient of a request (design section 7.7). `to` is a session id, an
 * address, or an owner login. A login names the one live member session of that
 * owner. Throws `ambiguous-recipient` with the candidates when there is none or
 * more than one.
 */
export function resolveRecipient(store: Store, conversation: ConversationRow, sender: SessionRow, to: string): SessionRow {
  let target: SessionRow | null = null;
  if (isId("session", to as unknown)) {
    target = store.db.query<SessionRow, [string]>("SELECT * FROM sessions WHERE id = ?").get(to);
  } else if (parseSessionAddress(to) !== null) {
    target = store.db.query<SessionRow, [string]>("SELECT * FROM sessions WHERE address = ?").get(to);
  } else {
    const login = to.replace(/^@/, "");
    if (!LOGIN.test(login)) throw new RelayError("invalid-request", `${to} is not a session id, an address, or a login.`);
    const sessions = store.db
      .query<SessionRow, [string, string, string]>(
        `SELECT s.* FROM sessions s JOIN owners o ON o.id = s.owner_id
         JOIN memberships m ON m.session_id = s.id AND m.conversation_id = ? AND m.state = 'active'
         WHERE lower(o.login) = lower(?) AND s.id != ? ORDER BY s.last_seen_at DESC`,
      )
      .all(conversation.id, login, sender.id);
    const live = sessions.filter((session) => session.state === "live");
    if (live.length === 1) target = live[0] ?? null;
    else {
      const candidates = (live.length > 1 ? live : sessions).map((session) => sessionInfo(store, session.id));
      throw new RelayError(
        "ambiguous-recipient",
        live.length > 1
          ? `${login} has ${live.length} live sessions in this conversation.`
          : `${login} has no live session in this conversation.`,
        "Send to one session address from the candidates.",
        { candidates },
      );
    }
  }
  if (target === null) throw new RelayError("not-found", `No session ${to}.`);
  if (target.id === sender.id) throw new RelayError("invalid-request", "A session cannot send a request to itself.");
  if (target.state === "retired") throw new RelayError("invalid-request", `The session ${target.address} is retired.`);
  if (target.project_id !== conversation.project_id) {
    throw new RelayError("no-project-access", `The session ${target.address} does not take part in this project.`);
  }
  return target;
}

/** `POST /v1/conversations/{id}/messages`. */
export async function sendMessage(
  store: Store,
  access: Access,
  sender: SessionRow,
  conversationId: string,
  body: MessageCreate,
): Promise<() => MessageCreated> {
  const conversation = getConversation(store, conversationId);
  if (sender.project_id !== conversation.project_id) throw new RelayError("no-project-access", "This session does not take part in this project.");
  await checkAccess(store, access, sender.owner_id, conversation.project_id, "cached");
  let recipient: SessionRow | null = null;
  if (body.kind === "request") {
    if (body.to === undefined) throw new RelayError("invalid-request", "A request needs a recipient in to.");
    recipient = resolveRecipient(store, conversation, sender, body.to);
    await checkAccess(store, access, recipient.owner_id, conversation.project_id, "cached");
  } else if (body.to !== undefined) {
    throw new RelayError("invalid-request", `A message of kind ${body.kind} has no recipient.`);
  }
  if (body.kind === "answer" && (body.answers === undefined || body.generation === undefined)) {
    throw new RelayError("invalid-request", "An answer needs answers and generation.");
  }
  return () => store.tx(() => {
    requireMember(store, conversationId, sender.id);
    checkSendRate(store, sender.id);
    const causes = body.causeIds ?? [];
    let hop = hopOf(store, sender, causes);
    let message: MessageRow;
    if (body.kind === "update") {
      message = insertMessage(store, conversationId, sender, "update", body.body, hop);
      for (const member of memberIds(store, conversationId)) {
        if (member !== sender.id) createReceipt(store, message, member, 0, false, receiptId(store));
      }
    } else if (body.kind === "request" && recipient !== null) {
      message = insertMessage(store, conversationId, sender, "request", body.body, hop);
      const now = store.iso();
      store.db
        .query(
          "INSERT INTO requests (message_id, status, original_session_id, assignee_session_id, generation, updated_at) VALUES (?, 'pending', ?, ?, 1, ?)",
        )
        .run(message.id, recipient.id, recipient.id, now);
      requestEvent(store, message.id, "created", sender.id, 1, null, null, recipient.id);
      joinConversation(store, conversationId, recipient, "request");
      createReceipt(store, message, recipient.id, 1, true, receiptId(store));
    } else {
      const request = answerable(store, sender, conversationId, body.answers ?? "", body.generation ?? 0);
      hop = Math.max(hop, getMessage(store, request.message_id).hop + 1);
      message = insertMessage(store, conversationId, sender, "answer", body.body, hop, request.message_id);
      const now = store.iso();
      store.db
        .query("UPDATE requests SET status = 'answered', answer_message_id = ?, updated_at = ?, closed_at = ? WHERE message_id = ?")
        .run(message.id, now, now, request.message_id);
      const own = currentReceipt(store, request);
      if (own !== null && own.acknowledged_at === null) {
        requestEvent(store, request.message_id, "acknowledged", sender.id, request.generation, "with the answer");
      }
      if (own !== null) {
        store.db
          .query("UPDATE receipts SET state = 'answered', acknowledged_at = coalesce(acknowledged_at, ?), answered_at = ?, hold = NULL, lease_until = NULL WHERE id = ?")
          .run(now, now, own.id);
      }
      requestEvent(store, request.message_id, "answered", sender.id, request.generation, message.id);
      createReceipt(store, message, getMessage(store, request.message_id).sender_session_id, 0, true, receiptId(store));
      requestChanged(store, request.message_id);
    }
    const insertCause = store.db.query("INSERT OR IGNORE INTO message_causes (message_id, cause_id) VALUES (?, ?)");
    for (const cause of causes) {
      if (store.db.query("SELECT 1 FROM messages WHERE id = ?").get(cause) !== null) insertCause.run(message.id, cause);
    }
    return { message: messageView(store, message.id), receipts: receiptsOf(store, message.id) };
  });
}

/** Check that the session can answer the request now. */
function answerable(store: Store, sender: SessionRow, conversationId: string, requestId: string, generation: number): RequestRow {
  const request = getRequest(store, requestId);
  if (request === null || getMessage(store, requestId).conversation_id !== conversationId) {
    throw new RelayError("not-found", `No request ${requestId} in this conversation.`);
  }
  if (!isOpen(request)) throw new RelayError("request-closed", "This request is closed.", "Do not act on it.");
  if (request.assignee_session_id !== sender.id) {
    const had = store.db
      .query("SELECT 1 FROM receipts WHERE message_id = ? AND recipient_session_id = ?")
      .get(requestId, sender.id);
    if (had !== null) throw new RelayError("request-reassigned", "This request was reassigned.", "Do not act on it.");
    throw new RelayError("not-assignee", "This session is not the assignee of the request.");
  }
  if (request.generation !== generation) {
    throw new RelayError("stale-generation", `The request has generation ${request.generation}.`, "This request was reassigned or closed. Do not act on it.");
  }
  return request;
}

function memberIds(store: Store, conversationId: string): string[] {
  return store.db
    .query<{ session_id: string }, [string]>("SELECT session_id FROM memberships WHERE conversation_id = ? AND state = 'active' ORDER BY joined_at")
    .all(conversationId)
    .map((row) => row.session_id);
}

/** The receipt of the current assignee and generation of a request. */
function currentReceipt(store: Store, request: RequestRow): ReceiptRow | null {
  return store.db
    .query<ReceiptRow, [string, string, number]>("SELECT * FROM receipts WHERE message_id = ? AND recipient_session_id = ? AND generation = ?")
    .get(request.message_id, request.assignee_session_id, request.generation);
}

/** `POST /v1/messages/ack`. At most one acknowledged handling for each receipt. */
export function ack(store: Store, session: SessionRow, body: Ack): Acked {
  return store.tx(() => {
    const items = body.items.map((item) => ({ id: item.id, result: ackOne(store, session, item.id, item.generation) }));
    return { items };
  });
}

function ackOne(store: Store, session: SessionRow, messageId: string, generation: number | undefined): AckResult {
  const message = store.db.query<MessageRow, [string]>("SELECT * FROM messages WHERE id = ?").get(messageId);
  if (message === null) return "not-recipient";
  const now = store.iso();
  const request = message.kind === "request" ? getRequest(store, messageId) : null;
  if (request !== null) {
    const any = store.db.query("SELECT 1 FROM receipts WHERE message_id = ? AND recipient_session_id = ?").get(messageId, session.id);
    if (any === null) return "not-recipient";
    if (request.assignee_session_id !== session.id) return "request-reassigned";
    const own = currentReceipt(store, request);
    if (own !== null && (own.state === "acknowledged" || own.state === "answered")) return "already-acknowledged";
    if (!isOpen(request)) return "request-closed";
    if ((generation ?? request.generation) !== request.generation || own === null || own.state === "superseded") return "stale-generation";
    store.db.query("UPDATE receipts SET state = 'acknowledged', acknowledged_at = ?, hold = NULL, lease_until = NULL WHERE id = ?").run(now, own.id);
    if (request.status !== "acknowledged") {
      store.db.query("UPDATE requests SET status = 'acknowledged', updated_at = ? WHERE message_id = ?").run(now, messageId);
    }
    requestEvent(store, messageId, "acknowledged", session.id, request.generation);
    requestChanged(store, messageId);
    return "acknowledged";
  }
  const own = store.db
    .query<ReceiptRow, [string, string]>("SELECT * FROM receipts WHERE message_id = ? AND recipient_session_id = ? ORDER BY generation DESC LIMIT 1")
    .get(messageId, session.id);
  if (own === null) return "not-recipient";
  if (own.state === "acknowledged" || own.state === "answered") return "already-acknowledged";
  if (own.state === "superseded") return "stale-generation";
  store.db.query("UPDATE receipts SET state = 'acknowledged', acknowledged_at = ?, hold = NULL, lease_until = NULL WHERE id = ?").run(now, own.id);
  return "acknowledged";
}

/** `POST /v1/requests/{id}/action`. */
export async function requestAction(store: Store, access: Access, actor: SessionRow, requestId: string, body: RequestAction): Promise<() => Message> {
  const message = getMessage(store, requestId);
  const conversation = getConversation(store, message.conversation_id);
  if (getRequest(store, requestId) === null) throw new RelayError("not-found", `${requestId} is not a request.`);
  if (actor.project_id !== conversation.project_id) throw new RelayError("no-project-access", "This session does not take part in this project.");
  await checkAccess(store, access, actor.owner_id, conversation.project_id, "cached");
  let target: SessionRow | null = null;
  if (body.action === "reassign") {
    target = resolveRecipient(store, conversation, actor, body.to);
    await checkAccess(store, access, target.owner_id, conversation.project_id, "cached");
  }
  return () => store.tx(() => {
    const request = getRequest(store, requestId);
    if (request === null) throw new RelayError("not-found", `${requestId} is not a request.`);
    const assignee = getSession(store, request.assignee_session_id);
    const sender = getSession(store, message.sender_session_id);
    if (!isOpen(request)) throw new RelayError("request-closed", `This request is ${request.status}.`);
    const conflict = () =>
      new RelayError("generation-conflict", `The request has generation ${request.generation}.`, "Read the request again, then decide.", {
        assignee: sessionRef(store, request.assignee_session_id),
        generation: request.generation,
      });
    if (body.expectedGeneration !== request.generation) throw conflict();
    const next = request.generation + 1;
    const now = store.iso();
    switch (body.action) {
      case "claim": {
        if (actor.owner_id !== assignee.owner_id) throw new RelayError("forbidden", "Only a session of the assignee's owner can claim this request.");
        if (actor.id === assignee.id) throw new RelayError("invalid-request", "This session is the assignee already.");
        if (request.status === "acknowledged" && assignee.state === "live" && body.takeover !== true) {
          throw new RelayError("in-progress", `${assignee.address} works on this request now.`, "Claim again with takeover: true to move it.");
        }
        if (!swap(store, requestId, request.generation, actor.id, "pending", null, now)) throw conflict();
        supersedeRequestReceipts(store, requestId);
        joinConversation(store, conversation.id, actor, "claim");
        requestEvent(store, requestId, "claimed", actor.id, next, null, assignee.id, actor.id);
        createReceipt(store, message, actor.id, next, true, receiptId(store));
        if (body.takeover === true && request.status === "acknowledged" && assignee.state === "live") {
          const notice = insertMessage(
            store,
            conversation.id,
            actor,
            "notice",
            `Request ${requestId} moved to ${actor.address}. Stop your work on it. Do not answer it.`,
            1,
          );
          createReceipt(store, notice, assignee.id, 0, true, receiptId(store));
        }
        requestChanged(store, requestId, [assignee.id]);
        break;
      }
      case "reassign": {
        if (target === null) throw new Error("No reassign target.");
        if (actor.owner_id !== sender.owner_id && actor.owner_id !== assignee.owner_id) {
          throw new RelayError("forbidden", "Only a session of the sender's or the assignee's owner can reassign this request.");
        }
        if (target.id === assignee.id) throw new RelayError("invalid-request", `${target.address} is the assignee already.`);
        if (!swap(store, requestId, request.generation, target.id, "pending", null, now)) throw conflict();
        supersedeRequestReceipts(store, requestId);
        joinConversation(store, conversation.id, target, "request");
        requestEvent(store, requestId, "reassigned", actor.id, next, null, assignee.id, target.id);
        createReceipt(store, message, target.id, next, true, receiptId(store));
        requestChanged(store, requestId, [assignee.id]);
        break;
      }
      case "cancel": {
        if (actor.owner_id !== sender.owner_id) throw new RelayError("forbidden", "Only a session of the sender's owner can cancel this request.");
        if (!swap(store, requestId, request.generation, assignee.id, "cancelled", null, now)) throw conflict();
        supersedeRequestReceipts(store, requestId);
        requestEvent(store, requestId, "cancelled", actor.id, next, body.note);
        requestChanged(store, requestId);
        break;
      }
      case "close": {
        const allowed =
          actor.owner_id === sender.owner_id ||
          (actor.owner_id === assignee.owner_id && (body.outcome === "declined" || body.outcome === "unresolved"));
        if (!allowed) {
          throw new RelayError(
            "forbidden",
            "Only a session of the sender's owner can close this request, or a session of the assignee's owner as declined or unresolved.",
          );
        }
        if (!swap(store, requestId, request.generation, assignee.id, "closed", body.outcome, now)) throw conflict();
        supersedeRequestReceipts(store, requestId);
        requestEvent(store, requestId, "closed", actor.id, next, `${body.outcome}: ${body.note}`);
        requestChanged(store, requestId);
        break;
      }
    }
    return messageView(store, requestId);
  });
}

/** The compare-and-swap of design section 6.4. False when the generation or the status changed. */
function swap(
  store: Store,
  requestId: string,
  expected: number,
  assignee: string,
  status: "pending" | "cancelled" | "closed",
  outcome: string | null,
  now: string,
): boolean {
  return (
    store.db
      .query(
        `UPDATE requests SET assignee_session_id = ?, generation = generation + 1, status = ?, outcome = ?, updated_at = ?,
           closed_at = CASE WHEN ? = 'pending' THEN NULL ELSE ? END
         WHERE message_id = ? AND generation = ? AND status IN ('pending','delivered','acknowledged')`,
      )
      .run(assignee, status, outcome, now, status, now, requestId, expected).changes === 1
  );
}

/**
 * The requests that the sessions sent or that are assigned to them, newest
 * first. `cursor` is the id of the last request of the previous page.
 */
export function listRequests(
  store: Store,
  sessionIds: readonly string[],
  role: "assigned" | "sent",
  state: "open" | "all",
  cursor: string | null,
  limit: number = PAGE_LIMIT,
): { requests: Message[]; next: string | null } {
  if (sessionIds.length === 0) return { requests: [], next: null };
  const column = role === "assigned" ? "r.assignee_session_id" : "m.sender_session_id";
  const open = state === "open" ? "AND r.status IN ('pending','delivered','acknowledged')" : "";
  const after = cursor === null ? "" : "AND m.id < ?";
  const rows = store.db
    .query<MessageRow, (string | number)[]>(
      `SELECT m.* FROM requests r JOIN messages m ON m.id = r.message_id
       WHERE ${column} IN (${sessionIds.map(() => "?").join(",")}) ${open} ${after} ORDER BY m.id DESC LIMIT ?`,
    )
    .all(...sessionIds, ...(cursor === null ? [] : [cursor]), Math.min(limit, PAGE_LIMIT) + 1);
  const page = rows.slice(0, Math.min(limit, PAGE_LIMIT));
  return {
    requests: page.map((row) => messageView(store, row)),
    next: rows.length > page.length ? (page.at(-1)?.id ?? null) : null,
  };
}
