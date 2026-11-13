/**
 * Sessions and workers (design sections 6.8 and 7.5).
 *
 * Session states: `live`, `offline`, `unknown` (no heartbeat of its device for
 * 90 seconds), and `retired`. The key of a session is the owner, the runtime,
 * and the runtime session id. A registration of the same key from another device
 * of the owner moves the session to that device. The address stays the same.
 */

import { newAddressSuffix, newId, sessionAddress } from "../ids.ts";
import type { Heartbeat, HeartbeatAck, Hold, RefusalCode, SessionEnd, SessionRegister, SessionRegistered, SessionUpdate } from "../protocol.ts";
import { checkAccess, resolveProject, type Access, type ProjectRow } from "./access.ts";
import { autoJoin } from "./conversations.ts";
import { getSession, messageView, ownerView, sessionInfo, type MessageRow, type SessionRow } from "./context.ts";
import { HEARTBEAT_STALE_MS } from "./limits.ts";
import { holdAll, releaseHolds } from "./receipts.ts";
import { RelayError, emit, iso, type Store } from "./store.ts";

export type DeviceRow = {
  id: string;
  owner_id: string;
  name: string;
  platform: "linux" | "darwin";
  created_at: string;
  last_seen_at: string | null;
  revoked_at: string | null;
};

const REFUSALS: readonly string[] = ["no-project-access", "app-not-installed", "owner-not-allowed", "access-unverifiable", "github-unavailable"];

/**
 * The session of a session-scoped call. Throws `forbidden` when it belongs to
 * another device or is retired.
 */
export function ownSession(store: Store, device: DeviceRow, sessionId: string): SessionRow {
  const session = getSession(store, sessionId);
  if (session.device_id !== device.id) throw new RelayError("forbidden", "This session belongs to another device.");
  if (session.state === "retired") throw new RelayError("forbidden", "This session is retired.");
  return session;
}

/** The holds that the adapter state of a session lifts. */
function adapterReleases(adapter: SessionRow["adapter"]): Hold[] {
  if (adapter === "supported" || adapter === "untested") return ["runtime-unsupported", "runtime-unconfirmed"];
  if (adapter === "unconfirmed") return ["runtime-unsupported"];
  return ["runtime-unconfirmed"];
}

/** `POST /v1/sessions`. */
export async function registerSession(store: Store, access: Access, device: DeviceRow, body: SessionRegister): Promise<() => SessionRegistered> {
  const existing = store.db
    .query<SessionRow, [string, string, string]>("SELECT * FROM sessions WHERE owner_id = ? AND runtime = ? AND runtime_session_id = ?")
    .get(device.owner_id, body.runtime, body.runtimeSessionId);
  let project: ProjectRow | null = null;
  let projectAccess: "granted" | "unverifiable" | null = null;
  let refusal: { code: RefusalCode; message: string } | null = null;
  if (body.repo !== null) {
    try {
      project = await resolveProject(store, access, body.repo.key);
      projectAccess = await checkAccess(store, access, device.owner_id, project.id, existing?.project_id === project.id ? "cached" : "fresh");
    } catch (error) {
      if (!(error instanceof RelayError) || !REFUSALS.includes(error.code)) throw error;
      refusal = { code: error.code as RefusalCode, message: error.message };
    }
  }
  return () => store.tx(() => {
    const now = store.iso();
    const projectId = refusal === null && project !== null ? project.id : null;
    let sessionId: string;
    if (existing === null) {
      sessionId = newId("session", store.now());
      const login = ownerView(store, device.owner_id).login;
      let address = sessionAddress(login, body.runtime, newAddressSuffix());
      while (store.db.query("SELECT 1 FROM sessions WHERE address = ?").get(address) !== null) {
        address = sessionAddress(login, body.runtime, newAddressSuffix());
      }
      store.db
        .query(
          `INSERT INTO sessions (id, address, owner_id, device_id, runtime, runtime_session_id, runtime_version, adapter, project_id,
             branch, head, worktree, task, state, activity, registered_at, last_seen_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'live', 'idle', ?, ?)`,
        )
        .run(
          sessionId,
          address,
          device.owner_id,
          device.id,
          body.runtime,
          body.runtimeSessionId,
          body.runtimeVersion,
          body.adapter,
          projectId,
          body.branch,
          body.head,
          body.worktree,
          body.task,
          now,
          now,
        );
    } else {
      sessionId = existing.id;
      if (existing.device_id !== device.id) {
        emit(store, { type: "session.moved", sessionId, toDeviceId: device.id }, [existing.device_id]);
      }
      store.db
        .query(
          `UPDATE sessions SET device_id = ?, runtime_version = ?, adapter = ?, project_id = ?, branch = ?, head = ?, worktree = ?,
             task = coalesce(?, task), state = 'live', activity = 'idle', last_seen_at = ?, ended_at = NULL, ended_reason = NULL WHERE id = ?`,
        )
        .run(device.id, body.runtimeVersion, body.adapter, projectId, body.branch, body.head, body.worktree, body.task, now, sessionId);
      releaseHolds(store, sessionId, ["recipient-offline", "worker-offline", "awaiting-approval"]);
    }
    store.db.query("UPDATE devices SET last_seen_at = ? WHERE id = ?").run(now, device.id);
    releaseHolds(store, sessionId, adapterReleases(body.adapter));
    const session = getSession(store, sessionId);
    const autoJoined = autoJoin(store, session);
    const assigned = store.db
      .query<MessageRow, [string]>(
        `SELECT m.* FROM messages m JOIN requests r ON r.message_id = m.id
         WHERE r.assignee_session_id = ? AND r.status IN ('pending','delivered','acknowledged') ORDER BY m.created_at DESC`,
      )
      .all(sessionId)
      .map((row) => messageView(store, row));
    const pendingUpdates =
      store.db
        .query<{ n: number }, [string]>("SELECT count(*) AS n FROM receipts WHERE recipient_session_id = ? AND state = 'stored' AND wake = 0")
        .get(sessionId)?.n ?? 0;
    return {
      session: sessionInfo(store, sessionId, true),
      project:
        project === null || projectId === null
          ? null
          : { id: project.id, key: body.repo?.key ?? "", repoId: project.provider_repo_id, access: projectAccess ?? "granted" },
      refusal,
      autoJoined,
      assigned,
      pendingUpdates,
    };
  });
}

/** `PATCH /v1/sessions/{id}`. */
export function updateSession(store: Store, session: SessionRow, body: SessionUpdate): void {
  store.tx(() => {
    const fields: string[] = [];
    const values: (string | null)[] = [];
    for (const [key, column] of [
      ["task", "task"],
      ["branch", "branch"],
      ["head", "head"],
      ["adapter", "adapter"],
    ] as const) {
      const value = body[key];
      if (value !== undefined) {
        fields.push(`${column} = ?`);
        values.push(value);
      }
    }
    if (fields.length > 0) store.db.query(`UPDATE sessions SET ${fields.join(", ")} WHERE id = ?`).run(...values, session.id);
    if (body.adapter !== undefined) releaseHolds(store, session.id, adapterReleases(body.adapter));
  });
}

/** `POST /v1/sessions/{id}/end`. A retired session ends its memberships. Its assigned requests stay open. */
export function endSession(store: Store, session: SessionRow, body: SessionEnd): void {
  store.tx(() => {
    const now = store.iso();
    const state = body.reason === "retired" ? "retired" : "offline";
    store.db.query("UPDATE sessions SET state = ?, activity = NULL, ended_at = ?, ended_reason = ? WHERE id = ?").run(state, now, body.reason, session.id);
    if (state === "offline") {
      holdAll(store, session.id, "recipient-offline");
      return;
    }
    retireMemberships(store, session, "retired");
  });
}

/** End the memberships of a retired session. */
export function retireMemberships(store: Store, session: SessionRow, reason: string): void {
  const rows = store.db
    .query<{ conversation_id: string }, [string]>("SELECT conversation_id FROM memberships WHERE session_id = ? AND state IN ('active','suspended')")
    .all(session.id);
  const now = store.iso();
  for (const row of rows) {
    store.db
      .query("UPDATE memberships SET state = 'ended', ended_at = ?, ended_reason = ? WHERE conversation_id = ? AND session_id = ?")
      .run(now, reason, row.conversation_id, session.id);
    emit(store, { type: "membership.changed", sessionId: session.id, conversationId: row.conversation_id, state: "ended", reason }, [
      session.device_id,
    ]);
  }
}

/** `POST /v1/worker/heartbeat`. */
export function heartbeat(store: Store, device: DeviceRow, body: Heartbeat): HeartbeatAck {
  return store.tx(() => {
    const now = store.iso();
    store.db.query("UPDATE devices SET last_seen_at = ? WHERE id = ?").run(now, device.id);
    for (const entry of body.sessions) {
      const session = store.db.query<SessionRow, [string]>("SELECT * FROM sessions WHERE id = ?").get(entry.id);
      if (session === null || session.device_id !== device.id || session.state === "retired") continue;
      if (entry.state === "live") {
        store.db
          .query("UPDATE sessions SET state = 'live', activity = ?, last_seen_at = ?, ended_at = NULL, ended_reason = NULL WHERE id = ?")
          .run(entry.activity, now, session.id);
        const releases: Hold[] = ["worker-offline"];
        if (session.state !== "live") releases.push("recipient-offline");
        if (entry.activity !== "awaiting-approval") releases.push("awaiting-approval");
        releaseHolds(store, session.id, releases);
      } else {
        markOffline(store, session.id, now);
      }
    }
    // A session in the state unknown that the worker does not name is not running on the device any more.
    const others = store.db.query<{ id: string }, [string]>("SELECT id FROM sessions WHERE device_id = ? AND state = 'unknown'").all(device.id);
    for (const other of others) markOffline(store, other.id, now);
    return { serverTime: now };
  });
}

/** The session is offline: its receipts that wait for its worker now wait for the session. */
function markOffline(store: Store, sessionId: string, now: string): void {
  store.db
    .query("UPDATE sessions SET state = 'offline', activity = NULL, ended_at = ?, ended_reason = 'crash' WHERE id = ? AND state IN ('live','unknown')")
    .run(now, sessionId);
  store.db.query("UPDATE receipts SET hold = 'recipient-offline' WHERE recipient_session_id = ? AND state = 'stored' AND hold = 'worker-offline'").run(sessionId);
  holdAll(store, sessionId, "recipient-offline");
}

/**
 * The timer of design section 6.8: the live sessions of a device without a
 * heartbeat for 90 seconds become `unknown`, and their stored receipts without
 * a hold get `worker-offline`.
 */
export function markStaleWorkers(store: Store): void {
  store.tx(() => {
    const cutoff = iso(store.now() - HEARTBEAT_STALE_MS);
    const stale = store.db
      .query<SessionRow, [string]>(
        `SELECT s.* FROM sessions s JOIN devices d ON d.id = s.device_id
         WHERE s.state = 'live' AND (d.last_seen_at IS NULL OR d.last_seen_at < ?)`,
      )
      .all(cutoff);
    for (const session of stale) {
      store.db.query("UPDATE sessions SET state = 'unknown' WHERE id = ?").run(session.id);
      holdAll(store, session.id, "worker-offline");
    }
  });
}
