/**
 * Conversations and memberships (design sections 6.6 and 7.6).
 *
 * Membership states: `active`, `left`, `suspended`, `ended`. A join needs a fresh
 * access check. An automatic join at registration happens by link match or by
 * `auto_join = all`. It does not join again a conversation that the session left.
 */

import { newId } from "../ids.ts";
import type { ConversationCreate, ConversationSummary, JoinContext, SessionInfo } from "../protocol.ts";
import { checkAccess, type Access } from "./access.ts";
import { conversationSummary, getConversation, joinContext, sessionInfo, type ConversationRow, type SessionRow } from "./context.ts";
import { MAX_MEMBERS, checkCreateRate } from "./limits.ts";
import { RelayError, emit, type Store } from "./store.ts";

export type JoinedVia = "agent" | "auto-link" | "auto-all" | "request" | "claim" | "create";

/**
 * Make the session an active member of the conversation. No change when it is
 * one. Throws `limit-reached` at 100 members. Call it in a transaction, after
 * the access check.
 */
export function joinConversation(store: Store, conversationId: string, session: SessionRow, via: JoinedVia): boolean {
  const current = store.db
    .query<{ state: string }, [string, string]>("SELECT state FROM memberships WHERE conversation_id = ? AND session_id = ?")
    .get(conversationId, session.id);
  if (current?.state === "active") return false;
  const members =
    store.db
      .query<{ n: number }, [string]>("SELECT count(*) AS n FROM memberships WHERE conversation_id = ? AND state = 'active'")
      .get(conversationId)?.n ?? 0;
  if (members >= MAX_MEMBERS) throw new RelayError("limit-reached", `The conversation has ${MAX_MEMBERS} members, the limit.`);
  store.db
    .query(
      `INSERT INTO memberships (conversation_id, session_id, state, joined_via, joined_at) VALUES (?, ?, 'active', ?, ?)
       ON CONFLICT (conversation_id, session_id) DO UPDATE SET state = 'active', joined_via = excluded.joined_via,
         joined_at = excluded.joined_at, ended_at = NULL, ended_reason = NULL`,
    )
    .run(conversationId, session.id, via, store.iso());
  emit(store, { type: "membership.changed", sessionId: session.id, conversationId, state: "active", reason: null }, [session.device_id]);
  return true;
}

export function isMember(store: Store, conversationId: string, sessionId: string): boolean {
  return (
    store.db
      .query<{ state: string }, [string, string]>("SELECT state FROM memberships WHERE conversation_id = ? AND session_id = ?")
      .get(conversationId, sessionId)?.state === "active"
  );
}

/** Throw `not-member` when the session is not an active member. */
export function requireMember(store: Store, conversationId: string, sessionId: string): void {
  if (!isMember(store, conversationId, sessionId)) {
    throw new RelayError("not-member", "This session is not a member of the conversation.", "Join it with ferry_membership action=join.");
  }
}

/** The active member sessions of a conversation. */
export function members(store: Store, conversationId: string): SessionRow[] {
  return store.db
    .query<SessionRow, [string]>(
      "SELECT s.* FROM memberships m JOIN sessions s ON s.id = m.session_id WHERE m.conversation_id = ? AND m.state = 'active' ORDER BY m.joined_at",
    )
    .all(conversationId);
}

/** True when the link `ref` of kind `kind` matches the branch name (design section 6.6). */
export function linkMatches(kind: "issue" | "branch", ref: string, branch: string): boolean {
  if (kind === "branch") return ref.toLowerCase() === branch.toLowerCase();
  const key = ref.replace(/^#/, "").toLowerCase();
  if (key.length === 0) return false;
  const escaped = key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(^|[^a-z0-9])${escaped}($|[^a-z0-9])`).test(branch.toLowerCase());
}

/**
 * The automatic joins of a session at registration. Returns the conversations
 * that it joined now.
 */
export function autoJoin(store: Store, session: SessionRow): ConversationSummary[] {
  if (session.project_id === null) return [];
  const conversations = store.db
    .query<ConversationRow & { membership: string | null }, [string, string]>(
      `SELECT c.*, m.state AS membership FROM conversations c
       LEFT JOIN memberships m ON m.conversation_id = c.id AND m.session_id = ?
       WHERE c.project_id = ? ORDER BY c.created_at`,
    )
    .all(session.id, session.project_id);
  const joined: ConversationSummary[] = [];
  for (const conversation of conversations) {
    if (conversation.membership === "active" || conversation.membership === "left") continue;
    let via: JoinedVia | null = conversation.auto_join === "all" ? "auto-all" : null;
    if (via === null && session.branch !== null) {
      const branch = session.branch;
      const links = store.db
        .query<{ kind: "issue" | "branch"; ref: string }, [string]>("SELECT kind, ref FROM conversation_links WHERE conversation_id = ?")
        .all(conversation.id);
      if (links.some((link) => linkMatches(link.kind, link.ref, branch))) via = "auto-link";
    }
    if (via === null) continue;
    try {
      if (joinConversation(store, conversation.id, session, via)) joined.push(conversationSummary(store, conversation.id));
    } catch (error) {
      if (!(error instanceof RelayError && error.code === "limit-reached")) throw error;
    }
  }
  return joined;
}

export function listConversations(store: Store, projectId: string, query: string | null): ConversationSummary[] {
  const rows = store.db
    .query<{ id: string; slug: string; name: string; purpose: string }, [string]>(
      "SELECT id, slug, name, purpose FROM conversations WHERE project_id = ? ORDER BY created_at DESC",
    )
    .all(projectId);
  const words = query === null ? [] : query.toLowerCase().split(/\s+/).filter(Boolean);
  return rows
    .filter((row) => words.every((word) => `${row.slug} ${row.name} ${row.purpose}`.toLowerCase().includes(word)))
    .map((row) => conversationSummary(store, row.id));
}

/** A slug from a conversation name. */
export function slugFor(name: string): string {
  const slug = name
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+/, "")
    .slice(0, 48)
    .replace(/-+$/, "");
  return slug.length === 0 ? "conversation" : slug;
}

export function editDistance(a: string, b: string): number {
  let previous = Array.from({ length: b.length + 1 }, (_, index) => index);
  for (let i = 1; i <= a.length; i++) {
    const current = [i];
    for (let j = 1; j <= b.length; j++) {
      current[j] = Math.min((previous[j] ?? 0) + 1, (current[j - 1] ?? 0) + 1, (previous[j - 1] ?? 0) + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
    previous = current;
  }
  return previous[b.length] ?? 0;
}

function wordSet(text: string): Set<string> {
  return new Set(text.toLowerCase().match(/[a-z]{3,}/g) ?? []);
}

export function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 && b.size === 0) return 0;
  let shared = 0;
  for (const word of a) if (b.has(word)) shared++;
  return shared / (a.size + b.size - shared);
}

/**
 * Create a conversation and join the creator. Throws `conversation-exists` for
 * the same slug, and `conversation-similar` for a similar conversation unless `force`.
 */
export async function createConversation(
  store: Store,
  access: Access,
  session: SessionRow,
  projectId: string,
  body: ConversationCreate,
): Promise<() => { conversation: ConversationSummary; context: JoinContext }> {
  if (session.project_id !== projectId) throw new RelayError("no-project-access", "This session does not take part in this project.");
  await checkAccess(store, access, session.owner_id, projectId, "cached");
  const slug = body.slug ?? slugFor(body.name);
  const links = body.links ?? [];
  return () => store.tx(() => {
    const existing = store.db.query<{ id: string }, [string, string]>("SELECT id FROM conversations WHERE project_id = ? AND slug = ?").get(projectId, slug);
    if (existing !== null) {
      throw new RelayError("conversation-exists", `The conversation ${slug} exists.`, "Join the existing conversation.", {
        conversation: conversationSummary(store, existing.id),
      });
    }
    if (body.force !== true) {
      const candidates = similarConversations(store, projectId, slug, body.name, body.purpose, links);
      if (candidates.length > 0) {
        throw new RelayError(
          "conversation-similar",
          "Similar conversations exist.",
          "Join one of the candidates, or create again with force: true.",
          { candidates },
        );
      }
    }
    checkCreateRate(store, session.owner_id);
    const id = newId("conversation", store.now());
    store.db
      .query(
        `INSERT INTO conversations (id, project_id, slug, name, purpose, auto_join, created_by_session_id, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(id, projectId, slug, body.name, body.purpose, body.autoJoin ?? "none", session.id, store.iso());
    const link = store.db.query("INSERT OR IGNORE INTO conversation_links (conversation_id, kind, ref) VALUES (?, ?, ?)");
    for (const entry of links) link.run(id, entry.kind, entry.ref);
    joinConversation(store, id, session, "create");
    return { conversation: conversationSummary(store, id), context: joinContext(store, id) };
  });
}

function similarConversations(
  store: Store,
  projectId: string,
  slug: string,
  name: string,
  purpose: string,
  links: readonly { kind: "issue" | "branch"; ref: string }[],
): ConversationSummary[] {
  const words = wordSet(`${name} ${purpose}`);
  const issues = new Set(links.filter((link) => link.kind === "issue").map((link) => link.ref.toLowerCase()));
  const rows = store.db
    .query<{ id: string; slug: string; name: string; purpose: string }, [string]>("SELECT id, slug, name, purpose FROM conversations WHERE project_id = ?")
    .all(projectId);
  return rows
    .filter((row) => {
      if (editDistance(row.slug, slug) <= 2) return true;
      if (jaccard(words, wordSet(`${row.name} ${row.purpose}`)) >= 0.6) return true;
      const theirs = store.db
        .query<{ ref: string }, [string]>("SELECT ref FROM conversation_links WHERE conversation_id = ? AND kind = 'issue'")
        .all(row.id);
      return theirs.some((link) => issues.has(link.ref.toLowerCase()));
    })
    .map((row) => conversationSummary(store, row.id));
}

/** `POST /v1/conversations/{id}/join`: a fresh access check, then the join. */
export async function join(store: Store, access: Access, session: SessionRow, conversationId: string): Promise<() => JoinContext> {
  const conversation = getConversation(store, conversationId);
  if (session.project_id !== conversation.project_id) throw new RelayError("no-project-access", "This session does not take part in this project.");
  await checkAccess(store, access, session.owner_id, conversation.project_id, "fresh");
  return () => store.tx(() => {
    joinConversation(store, conversationId, session, "agent");
    return joinContext(store, conversationId);
  });
}

export function leave(store: Store, session: SessionRow, conversationId: string): { state: "left" } {
  getConversation(store, conversationId);
  return store.tx(() => {
    const changed = store.db
      .query("UPDATE memberships SET state = 'left', ended_at = ?, ended_reason = 'left' WHERE conversation_id = ? AND session_id = ? AND state = 'active'")
      .run(store.iso(), conversationId, session.id).changes;
    if (changed > 0) {
      emit(store, { type: "membership.changed", sessionId: session.id, conversationId, state: "left", reason: null }, [session.device_id]);
    }
    return { state: "left" as const };
  });
}

/** `GET /v1/projects/{id}/sessions`. */
export function listSessions(
  store: Store,
  projectId: string,
  query: string | null,
  conversationId: string | null,
  state: "live" | "all",
): SessionInfo[] {
  const rows = store.db
    .query<SessionRow, [string]>("SELECT * FROM sessions WHERE project_id = ? AND state != 'retired' ORDER BY state = 'live' DESC, last_seen_at DESC")
    .all(projectId)
    .filter((row) => state === "all" || row.state === "live")
    .filter((row) => conversationId === null || isMember(store, conversationId, row.id));
  const words = query === null ? [] : query.toLowerCase().split(/\s+/).filter(Boolean);
  return rows
    .map((row) => sessionInfo(store, row.id, true))
    .filter((info) =>
      words.every((word) => [info.address, info.owner.login, info.task ?? "", info.branch ?? "", info.worktree ?? ""].join(" ").toLowerCase().includes(word)),
    );
}
