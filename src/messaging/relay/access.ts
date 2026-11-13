/**
 * Projects and repository access (design sections 3.4, 3.6, and 4.2).
 *
 * The project identity is the numeric GitHub repository id. A repository key
 * such as `github.com/acme/app` is only a lookup hint. Access is a grant of
 * `write` or `admin` from the collaborator permission endpoint, for the owner
 * and the project:
 *
 * - A fresh check on each join and on the first registration of a session in a project.
 * - A background check every 15 minutes while the owner has a membership in the project.
 * - When GitHub is unavailable, the last good grant stays valid for 1 hour. Then
 *   the relay refuses with `access-unverifiable` and suspends the memberships.
 * - When the permission is lost, the memberships end and the open receipts are superseded.
 */

import { newId } from "../ids.ts";
import { RECHECK_MS, OUTAGE_GRACE_MS } from "./limits.ts";
import { RelayError, deviceOf, emit, type Store } from "./store.ts";

/** The GitHub calls of the relay. Lane B implements it in `src/messaging/github/access.ts`. Tests use a fake. */
export interface GitHubAccess {
  startDeviceFlow(): Promise<{ deviceCode: string; userCode: string; verificationUri: string; expiresInS: number; intervalS: number }>;
  pollDeviceFlow(
    deviceCode: string,
  ): Promise<{ state: "pending" | "slow-down" | "expired" | "denied" } | { state: "complete"; user: { id: number; login: string } }>;
  resolveRepository(
    owner: string,
    repo: string,
  ): Promise<{ state: "ok"; repoId: number; fullName: string; installationId: number } | { state: "app-not-installed" | "not-found" | "unavailable" }>;
  permission(
    installationId: number,
    fullName: string,
    login: string,
  ): Promise<{ state: "ok"; permission: "admin" | "write" | "read" | "none"; roleName: string | null } | { state: "unavailable" }>;
  currentLogin(userId: number): Promise<string | null>;
  appSlug(): string;
}

export type Access = { readonly github: GitHubAccess; readonly allowedOwners: () => readonly string[] };

export type ProjectRow = { id: string; provider_repo_id: number; full_name: string };

type GrantRow = {
  permission: "admin" | "write" | "read" | "none";
  state: "granted" | "lost" | "unverifiable";
  last_success_at: string | null;
  last_attempt_at: string;
};

/**
 * The project of a repository key. Throws `owner-not-allowed`, `app-not-installed`,
 * `no-project-access` (no such repository for the App), or `github-unavailable`.
 */
export async function resolveProject(store: Store, access: Access, key: string): Promise<ProjectRow> {
  const [, owner = "", repo = ""] = key.split("/");
  if (!access.allowedOwners().some((allowed) => allowed.toLowerCase() === owner)) {
    throw new RelayError(
      "owner-not-allowed",
      `This relay does not serve repositories of ${owner}. The relay operator adds it with ferry relay owners add ${owner}.`,
    );
  }
  const known = store.db
    .query<ProjectRow, [string]>(
      "SELECT p.id, p.provider_repo_id, p.full_name FROM project_keys k JOIN projects p ON p.id = k.project_id WHERE k.key = ?",
    )
    .get(key);
  if (known !== null) return known;
  const resolved = await access.github.resolveRepository(owner, repo);
  if (resolved.state !== "ok") {
    if (resolved.state === "app-not-installed") throw appNotInstalled(access, owner, `${owner}/${repo}`);
    if (resolved.state === "not-found") {
      throw new RelayError("no-project-access", `The repository ${owner}/${repo} does not exist, or the GitHub App cannot see it.`);
    }
    throw new RelayError("github-unavailable", "GitHub is not available now. Try again later.");
  }
  const result = resolved;
  return store.tx(() => {
    const now = store.iso();
    const project =
      store.db
        .query<ProjectRow, [string, number]>("SELECT id, provider_repo_id, full_name FROM projects WHERE provider = ? AND provider_repo_id = ?")
        .get("github", result.repoId) ??
      store.db
        .query<ProjectRow, [string, number, string, string, string]>(
          `INSERT INTO projects (id, provider, provider_repo_id, full_name, created_at, updated_at) VALUES (?, 'github', ?, ?, ?, ?)
           RETURNING id, provider_repo_id, full_name`,
        )
        .get(newId("project", store.now()), result.repoId, result.fullName, now, now);
    if (project === null) throw new Error("The project insert returned no row.");
    store.db.query("UPDATE projects SET full_name = ?, updated_at = ? WHERE id = ?").run(result.fullName, now, project.id);
    store.db
      .query("INSERT INTO project_keys (key, project_id, seen_at) VALUES (?, ?, ?) ON CONFLICT (key) DO UPDATE SET project_id = excluded.project_id, seen_at = excluded.seen_at")
      .run(key, project.id, now);
    cacheInstallation(store, result.fullName, result.installationId);
    return { ...project, full_name: result.fullName };
  });
}

function appNotInstalled(access: Access, owner: string, fullName: string): RelayError {
  const slug = access.github.appSlug();
  return new RelayError(
    "app-not-installed",
    `Install the GitHub App ${slug} on ${owner}, with access to ${fullName}: https://github.com/apps/${slug}/installations/new`,
  );
}

function cacheInstallation(store: Store, fullName: string, installationId: number): void {
  store.db
    .query(
      `INSERT INTO github_installations (owner_login, installation_id, checked_at) VALUES (?, ?, ?)
       ON CONFLICT (owner_login) DO UPDATE SET installation_id = excluded.installation_id, checked_at = excluded.checked_at`,
    )
    .run(fullName.split("/")[0] ?? "", installationId, store.iso());
}

export function getProject(store: Store, projectId: string): ProjectRow {
  const project = store.db.query<ProjectRow, [string]>("SELECT id, provider_repo_id, full_name FROM projects WHERE id = ?").get(projectId);
  if (project === null) throw new RelayError("not-found", `Project ${projectId} does not exist.`);
  return project;
}

function grant(store: Store, ownerId: string, projectId: string): GrantRow | null {
  return store.db
    .query<GrantRow, [string, string]>(
      "SELECT permission, state, last_success_at, last_attempt_at FROM access_grants WHERE owner_id = ? AND project_id = ?",
    )
    .get(ownerId, projectId);
}

function withinGrace(store: Store, row: GrantRow): boolean {
  return row.last_success_at !== null && Date.parse(row.last_success_at) + OUTAGE_GRACE_MS > store.now();
}

/** The access of a stored grant, without a GitHub call. Null when the grant does not allow access now. */
export function storedAccess(store: Store, ownerId: string, projectId: string): "granted" | "unverifiable" | null {
  const row = grant(store, ownerId, projectId);
  if (row === null) return null;
  if (row.state === "granted") return "granted";
  if (row.state === "unverifiable" && withinGrace(store, row)) return "unverifiable";
  return null;
}

/** True when the owner lost access to the project. */
export function accessLost(store: Store, ownerId: string, projectId: string): boolean {
  return grant(store, ownerId, projectId)?.state === "lost";
}

/** True when the owner has a valid `admin` grant for the project. */
export function isAdmin(store: Store, ownerId: string, projectId: string): boolean {
  const row = grant(store, ownerId, projectId);
  return row !== null && row.permission === "admin" && storedAccess(store, ownerId, projectId) !== null;
}

/**
 * Check that the owner has access to the project. `fresh` asks GitHub. `cached`
 * uses a valid stored grant, and asks GitHub only when there is none. Throws
 * `no-project-access`, `app-not-installed`, or `access-unverifiable`.
 */
export async function checkAccess(
  store: Store,
  access: Access,
  ownerId: string,
  projectId: string,
  mode: "fresh" | "cached",
): Promise<"granted" | "unverifiable"> {
  if (mode === "cached") {
    const stored = storedAccess(store, ownerId, projectId);
    if (stored !== null) return stored;
  }
  const result = await askGitHub(store, access, ownerId, projectId);
  if (result.state === "granted") return "granted";
  if (result.state === "lost") {
    throw result.appMissing
      ? appNotInstalled(access, result.fullName.split("/")[0] ?? "", result.fullName)
      : new RelayError("no-project-access", `You need write access to ${result.fullName} to take part in its conversations.`);
  }
  if (result.state === "unverifiable") return "unverifiable";
  throw new RelayError(
    "access-unverifiable",
    `GitHub has not confirmed access to ${result.fullName} for more than 1 hour.`,
    "Messaging for this project continues when GitHub is available again.",
  );
}

type CheckResult =
  | { state: "granted"; fullName: string }
  | { state: "lost"; fullName: string; appMissing: boolean }
  | { state: "unverifiable"; fullName: string }
  | { state: "refused"; fullName: string };

async function askGitHub(store: Store, access: Access, ownerId: string, projectId: string): Promise<CheckResult> {
  const project = getProject(store, projectId);
  const owner = store.db
    .query<{ github_user_id: number; login: string }, [string]>("SELECT github_user_id, login FROM owners WHERE id = ?")
    .get(ownerId);
  if (owner === null) throw new RelayError("not-found", `Owner ${ownerId} does not exist.`);
  const login = await refreshLogin(store, access, ownerId, owner);
  const [repoOwner = "", repoName = ""] = project.full_name.split("/");
  let installationId =
    store.db
      .query<{ installation_id: number }, [string]>("SELECT installation_id FROM github_installations WHERE owner_login = ?")
      .get(repoOwner)?.installation_id ?? null;
  for (let attempt = 0; attempt < 2; attempt++) {
    if (installationId === null) {
      const resolved = await access.github.resolveRepository(repoOwner, repoName);
      if (resolved.state !== "ok") {
        if (resolved.state === "unavailable") break;
        recordLoss(store, ownerId, projectId, "none", null, resolved.state);
        return { state: "lost", fullName: project.full_name, appMissing: resolved.state === "app-not-installed" };
      }
      store.tx(() => cacheInstallation(store, resolved.fullName, resolved.installationId));
      installationId = resolved.installationId;
    }
    const result = await access.github.permission(installationId, project.full_name, login);
    if (result.state === "ok") {
      if (result.permission === "write" || result.permission === "admin") {
        recordGrant(store, ownerId, projectId, result.permission, result.roleName);
        return { state: "granted", fullName: project.full_name };
      }
      recordLoss(store, ownerId, projectId, result.permission, result.roleName, `permission ${result.permission}`);
      return { state: "lost", fullName: project.full_name, appMissing: false };
    }
    // The installation can be gone or new. Look it up once again, then count the failure as an outage.
    installationId = null;
  }
  return recordOutage(store, ownerId, projectId, project.full_name);
}

async function refreshLogin(store: Store, access: Access, ownerId: string, owner: { github_user_id: number; login: string }): Promise<string> {
  const login = await access.github.currentLogin(owner.github_user_id).catch(() => null);
  if (login === null) return owner.login;
  store.tx(() => store.db.query("UPDATE owners SET login = ?, login_checked_at = ? WHERE id = ?").run(login, store.iso(), ownerId));
  return login;
}

function recordGrant(store: Store, ownerId: string, projectId: string, permission: "admin" | "write", roleName: string | null): void {
  store.tx(() => {
    const now = store.iso();
    store.db
      .query(
        `INSERT INTO access_grants (owner_id, project_id, permission, role_name, state, last_success_at, last_attempt_at, last_error)
         VALUES (?, ?, ?, ?, 'granted', ?, ?, NULL)
         ON CONFLICT (owner_id, project_id) DO UPDATE SET permission = excluded.permission, role_name = excluded.role_name,
           state = 'granted', last_success_at = excluded.last_success_at, last_attempt_at = excluded.last_attempt_at, last_error = NULL`,
      )
      .run(ownerId, projectId, permission, roleName, now, now);
    setMemberships(store, ownerId, projectId, ["suspended"], "active", null);
  });
}

function recordOutage(store: Store, ownerId: string, projectId: string, fullName: string): CheckResult {
  return store.tx(() => {
    const now = store.iso();
    const row = grant(store, ownerId, projectId);
    if (row === null) {
      store.db
        .query(
          `INSERT INTO access_grants (owner_id, project_id, permission, state, last_attempt_at, last_error)
           VALUES (?, ?, 'none', 'unverifiable', ?, 'github-unavailable')`,
        )
        .run(ownerId, projectId, now);
      return { state: "refused", fullName };
    }
    if (row.state === "lost") {
      store.db.query("UPDATE access_grants SET last_attempt_at = ?, last_error = 'github-unavailable' WHERE owner_id = ? AND project_id = ?").run(now, ownerId, projectId);
      return { state: "lost", fullName, appMissing: false };
    }
    store.db
      .query("UPDATE access_grants SET state = 'unverifiable', last_attempt_at = ?, last_error = 'github-unavailable' WHERE owner_id = ? AND project_id = ?")
      .run(now, ownerId, projectId);
    if (withinGrace(store, row)) return { state: "unverifiable", fullName };
    setMemberships(store, ownerId, projectId, ["active"], "suspended", "access-unverifiable");
    return { state: "refused", fullName };
  });
}

/**
 * Record that the owner lost access: the grant is `lost`, the memberships of the
 * owner's sessions in the project end, their open receipts are superseded, and
 * the workers get `session.access-lost`. Requests assigned to those sessions stay open.
 */
function recordLoss(
  store: Store,
  ownerId: string,
  projectId: string,
  permission: "read" | "none",
  roleName: string | null,
  reason: string,
): void {
  store.tx(() => {
    const now = store.iso();
    const before = grant(store, ownerId, projectId);
    store.db
      .query(
        `INSERT INTO access_grants (owner_id, project_id, permission, role_name, state, last_attempt_at, last_error)
         VALUES (?, ?, ?, ?, 'lost', ?, ?)
         ON CONFLICT (owner_id, project_id) DO UPDATE SET permission = excluded.permission, role_name = excluded.role_name,
           state = 'lost', last_attempt_at = excluded.last_attempt_at, last_error = excluded.last_error`,
      )
      .run(ownerId, projectId, permission, roleName, now, reason);
    const sessions = setMemberships(store, ownerId, projectId, ["active", "suspended"], "ended", "access-lost");
    const open = store.db
      .query<{ id: string; recipient_session_id: string }, [string, string]>(
        `SELECT r.id, r.recipient_session_id FROM receipts r
         JOIN messages m ON m.id = r.message_id JOIN conversations c ON c.id = m.conversation_id
         JOIN sessions s ON s.id = r.recipient_session_id
         WHERE s.owner_id = ? AND c.project_id = ? AND r.state IN ('stored','delivered','acknowledged')`,
      )
      .all(ownerId, projectId);
    const supersede = store.db.query("UPDATE receipts SET state = 'superseded', hold = NULL, lease_until = NULL, retry_at = NULL WHERE id = ?");
    for (const receipt of open) supersede.run(receipt.id);
    const affected = new Set([...sessions, ...open.map((receipt) => receipt.recipient_session_id)]);
    for (const row of store.db
      .query<{ id: string }, [string, string]>("SELECT id FROM sessions WHERE owner_id = ? AND project_id = ? AND state != 'retired'")
      .all(ownerId, projectId)) {
      affected.add(row.id);
    }
    for (const sessionId of affected) emit(store, { type: "session.access-lost", sessionId, projectId }, [deviceOf(store, sessionId)]);
    if (before?.state !== "lost") {
      const constraints = store.db
        .query<{ id: string }, [string, string]>(
          `SELECT k.id FROM constraints k JOIN conversations c ON c.id = k.conversation_id
           WHERE k.owner_id = ? AND c.project_id = ? AND k.state = 'active'`,
        )
        .all(ownerId, projectId);
      const event = store.db.query("INSERT INTO constraint_events (constraint_id, kind, at) VALUES (?, 'owner-lost-access', ?)");
      for (const constraint of constraints) event.run(constraint.id, now);
    }
  });
}

/**
 * Move the memberships of the owner's sessions in the project from one of the
 * states `from` to `to`, with a `membership.changed` event for each. Returns the
 * sessions that changed.
 */
function setMemberships(
  store: Store,
  ownerId: string,
  projectId: string,
  from: readonly ("active" | "suspended")[],
  to: "active" | "suspended" | "ended",
  reason: string | null,
): string[] {
  const rows = store.db
    .query<{ conversation_id: string; session_id: string; device_id: string }, [string, string]>(
      `SELECT m.conversation_id, m.session_id, s.device_id FROM memberships m
       JOIN conversations c ON c.id = m.conversation_id JOIN sessions s ON s.id = m.session_id
       WHERE s.owner_id = ? AND c.project_id = ? AND m.state IN (${from.map((state) => `'${state}'`).join(",")})`,
    )
    .all(ownerId, projectId);
  const now = store.iso();
  const update = store.db.query("UPDATE memberships SET state = ?, ended_at = ?, ended_reason = ? WHERE conversation_id = ? AND session_id = ?");
  for (const row of rows) {
    update.run(to, to === "active" ? null : now, reason, row.conversation_id, row.session_id);
    emit(store, { type: "membership.changed", sessionId: row.session_id, conversationId: row.conversation_id, state: to, reason }, [
      row.device_id,
    ]);
  }
  return [...new Set(rows.map((row) => row.session_id))];
}

/**
 * The background work of design section 3.6: a fresh check for each owner and
 * project pair with a membership whose last check is 15 minutes old, and the
 * suspension of memberships whose grant has been unverifiable for 1 hour.
 */
export async function recheckGrants(store: Store, access: Access): Promise<void> {
  const due = store.db
    .query<{ owner_id: string; project_id: string }, [string]>(
      `SELECT DISTINCT s.owner_id, c.project_id FROM memberships m
       JOIN conversations c ON c.id = m.conversation_id JOIN sessions s ON s.id = m.session_id
       LEFT JOIN access_grants g ON g.owner_id = s.owner_id AND g.project_id = c.project_id
       WHERE m.state IN ('active','suspended') AND (g.last_attempt_at IS NULL OR g.last_attempt_at <= ?)`,
    )
    .all(store.iso(store.now() - RECHECK_MS));
  for (const pair of due) {
    await askGitHub(store, access, pair.owner_id, pair.project_id).catch(() => undefined);
  }
  const expired = store.db
    .query<{ owner_id: string; project_id: string }, [string]>(
      "SELECT owner_id, project_id FROM access_grants WHERE state = 'unverifiable' AND (last_success_at IS NULL OR last_success_at <= ?)",
    )
    .all(store.iso(store.now() - OUTAGE_GRACE_MS));
  for (const pair of expired) {
    store.tx(() => setMemberships(store, pair.owner_id, pair.project_id, ["active"], "suspended", "access-unverifiable"));
  }
}
