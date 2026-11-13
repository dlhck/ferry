/**
 * Constraints (design section 6.7).
 *
 * | From | To | Who |
 * | --- | --- | --- |
 * | (none) | active | any member |
 * | active | active (adopted) | a session of the constraint's owner |
 * | active | resolved (owner) | a session of the constraint's owner |
 * | active | resolved (admin) | a session of an owner with `admin` on the repository, only when the constraint's owner lost access |
 *
 * Other members ask for a resolution, which makes a request to the responsible
 * session. Each create, adopt, and resolve writes a message of kind `constraint`
 * with receipts that do not wake, so the members get it in their next context digest.
 */

import { newId } from "../ids.ts";
import type { Constraint, ConstraintAction, ConstraintActionResult, ConstraintCreate } from "../protocol.ts";
import { accessLost, checkAccess, isAdmin, type Access } from "./access.ts";
import { joinConversation, members, requireMember } from "./conversations.ts";
import { constraintView, getConversation, getMessage, getSession, messageView, type ConstraintRow, type SessionRow } from "./context.ts";
import { MAX_ACTIVE_CONSTRAINTS } from "./limits.ts";
import { createReceipt, requestEvent } from "./receipts.ts";
import { insertMessage } from "./requests.ts";
import { RelayError, emit, type Store } from "./store.ts";

function getConstraint(store: Store, constraintId: string): ConstraintRow {
  const row = store.db.query<ConstraintRow, [string]>("SELECT * FROM constraints WHERE id = ?").get(constraintId);
  if (row === null) throw new RelayError("not-found", `Constraint ${constraintId} does not exist.`);
  return row;
}

function constraintEvent(
  store: Store,
  constraintId: string,
  kind: "created" | "adopted" | "resolution-requested" | "resolved",
  actor: string,
  from: string | null = null,
  to: string | null = null,
  requestId: string | null = null,
): void {
  store.db
    .query("INSERT INTO constraint_events (constraint_id, kind, actor_session_id, from_session_id, to_session_id, request_id, at) VALUES (?, ?, ?, ?, ?, ?, ?)")
    .run(constraintId, kind, actor, from, to, requestId, store.iso());
}

/** Write a `constraint` message from the session with receipts that do not wake, and tell the workers of the members. */
function announce(store: Store, session: SessionRow, constraintId: string, body: string): string {
  const constraint = getConstraint(store, constraintId);
  const message = insertMessage(store, constraint.conversation_id, session, "constraint", body, 1);
  const view = constraintView(store, constraintId);
  for (const member of members(store, constraint.conversation_id)) {
    if (member.id !== session.id) createReceipt(store, message, member.id, 0, false, newId("receipt", store.now()));
    emit(store, { type: "constraint.changed", sessionId: member.id, constraint: view }, [member.device_id]);
  }
  return message.id;
}

async function memberAccess(store: Store, access: Access, session: SessionRow, conversationId: string): Promise<string> {
  const conversation = getConversation(store, conversationId);
  if (session.project_id !== conversation.project_id) throw new RelayError("no-project-access", "This session does not take part in this project.");
  await checkAccess(store, access, session.owner_id, conversation.project_id, "cached");
  return conversation.project_id;
}

/** `POST /v1/conversations/{id}/constraints`. */
export async function createConstraint(store: Store, access: Access, session: SessionRow, conversationId: string, body: ConstraintCreate): Promise<() => Constraint> {
  await memberAccess(store, access, session, conversationId);
  return () => store.tx(() => {
    requireMember(store, conversationId, session.id);
    const active =
      store.db
        .query<{ n: number }, [string]>("SELECT count(*) AS n FROM constraints WHERE conversation_id = ? AND state = 'active'")
        .get(conversationId)?.n ?? 0;
    if (active >= MAX_ACTIVE_CONSTRAINTS) {
      throw new RelayError("limit-reached", `The conversation has ${MAX_ACTIVE_CONSTRAINTS} active constraints, the limit.`, "Resolve one first.");
    }
    if (body.sourceMessageId !== undefined && getMessage(store, body.sourceMessageId).conversation_id !== conversationId) {
      throw new RelayError("invalid-request", `Message ${body.sourceMessageId} is not in this conversation.`);
    }
    const id = newId("constraint", store.now());
    // Without a source, the constraint message of the create is the source.
    const message = insertMessage(store, conversationId, session, "constraint", body.text, 1);
    store.db
      .query(
        `INSERT INTO constraints (id, conversation_id, text, owner_id, responsible_session_id, source_message_id, state, created_at)
         VALUES (?, ?, ?, ?, ?, ?, 'active', ?)`,
      )
      .run(id, conversationId, body.text, session.owner_id, session.id, body.sourceMessageId ?? message.id, store.iso());
    constraintEvent(store, id, "created", session.id);
    const view = constraintView(store, id);
    for (const member of members(store, conversationId)) {
      if (member.id !== session.id) createReceipt(store, message, member.id, 0, false, newId("receipt", store.now()));
      emit(store, { type: "constraint.changed", sessionId: member.id, constraint: view }, [member.device_id]);
    }
    return view;
  });
}

/** `POST /v1/constraints/{id}/action`. */
export async function constraintAction(store: Store, access: Access, session: SessionRow, constraintId: string, body: ConstraintAction): Promise<() => ConstraintActionResult> {
  const before = getConstraint(store, constraintId);
  const projectId = await memberAccess(store, access, session, before.conversation_id);
  return () => store.tx(() => {
    const constraint = getConstraint(store, constraintId);
    if (constraint.state !== "active") throw new RelayError("invalid-request", "This constraint is resolved.");
    const responsible = getSession(store, constraint.responsible_session_id);
    switch (body.action) {
      case "adopt": {
        if (session.owner_id !== constraint.owner_id) {
          throw new RelayError("not-constraint-owner", "Only a session of the constraint's owner can adopt it.", "Ask for a resolution instead.");
        }
        if (session.id === responsible.id) return { constraint: constraintView(store, constraintId) };
        store.db.query("UPDATE constraints SET responsible_session_id = ? WHERE id = ?").run(session.id, constraintId);
        constraintEvent(store, constraintId, "adopted", session.id, responsible.id, session.id);
        announce(store, session, constraintId, `Constraint ${constraintId} now has the responsible session ${session.address}: ${constraint.text}`);
        return { constraint: constraintView(store, constraintId) };
      }
      case "resolve": {
        let as: "owner" | "admin";
        if (session.owner_id === constraint.owner_id) as = "owner";
        else if (accessLost(store, constraint.owner_id, projectId) && isAdmin(store, session.owner_id, projectId)) as = "admin";
        else {
          throw new RelayError(
            "not-constraint-owner",
            "Only a session of the constraint's owner can resolve it.",
            "Ask for a resolution with action request-resolution.",
          );
        }
        store.db
          .query("UPDATE constraints SET state = 'resolved', resolved_at = ?, resolved_by_session_id = ?, resolved_as = ?, resolution_note = ? WHERE id = ?")
          .run(store.iso(), session.id, as, body.note, constraintId);
        constraintEvent(store, constraintId, "resolved", session.id);
        announce(store, session, constraintId, `Constraint ${constraintId} is resolved by ${session.address}: ${constraint.text}\nNote: ${body.note}`);
        return { constraint: constraintView(store, constraintId) };
      }
      case "request-resolution": {
        requireMember(store, constraint.conversation_id, session.id);
        if (responsible.id === session.id) throw new RelayError("invalid-request", "This session is the responsible session. Resolve the constraint.");
        const message = insertMessage(
          store,
          constraint.conversation_id,
          session,
          "request",
          `Please resolve constraint ${constraintId}: ${constraint.text}\nEvidence: ${body.evidence}`,
          1,
        );
        const now = store.iso();
        store.db
          .query(
            "INSERT INTO requests (message_id, status, original_session_id, assignee_session_id, generation, updated_at) VALUES (?, 'pending', ?, ?, 1, ?)",
          )
          .run(message.id, responsible.id, responsible.id, now);
        requestEvent(store, message.id, "created", session.id, 1, `constraint ${constraintId}`, null, responsible.id);
        joinConversation(store, constraint.conversation_id, responsible, "request");
        createReceipt(store, message, responsible.id, 1, true, newId("receipt", store.now()));
        constraintEvent(store, constraintId, "resolution-requested", session.id, null, null, message.id);
        return { constraint: constraintView(store, constraintId), request: messageView(store, message.id) };
      }
    }
  });
}

/** `GET /v1/conversations/{id}/constraints`. */
export function listConstraints(store: Store, conversationId: string, state: "active" | "resolved" | "all"): Constraint[] {
  getConversation(store, conversationId);
  const filter = state === "all" ? "" : "AND state = ?";
  return store.db
    .query<ConstraintRow, string[]>(`SELECT * FROM constraints WHERE conversation_id = ? ${filter} ORDER BY created_at`)
    .all(conversationId, ...(state === "all" ? [] : [state]))
    .map((row) => constraintView(store, row));
}
