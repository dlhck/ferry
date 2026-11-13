/**
 * The GitHub access checks of the relay (design sections 3.4 and 3.6), and
 * the rules for revalidation.
 *
 * `createGitHubAccess` implements `GitHubAccess`, the interface that the relay
 * server (lane A) consumes. It uses the App JWT for the installation lookup
 * and an installation token for the repository and permission lookups.
 *
 * The revalidation rules are pure functions of a grant and a time, so the
 * relay store applies them with its clock:
 *
 * - A grant needs a recheck 15 minutes after the last attempt.
 * - `write` or `admin` qualifies. `read`, `none`, and a 404 do not.
 * - When GitHub is unavailable, the last successful grant stays valid until 1
 *   hour after it. Then the grant is `unverifiable` and the memberships are suspended.
 * - A successful check after that restores them. A permission that does not
 *   qualify ends them.
 */

import {
  GITHUB_ENDPOINTS,
  GitHubUnavailableError,
  githubRequest,
  InstallationGoneError,
  InstallationTokens,
  systemClock,
  type AppCredentials,
  type Clock,
  type Fetch,
  type GitHubEndpoints,
} from "./app.ts";
import { pollDeviceFlow, startDeviceFlow, type DeviceCode, type DevicePoll } from "./device-flow.ts";

export type Permission = "admin" | "write" | "read" | "none";

export type RepositoryLookup =
  | { readonly state: "ok"; readonly repoId: number; readonly fullName: string; readonly installationId: number }
  | { readonly state: "app-not-installed" | "not-found" | "unavailable" };

export type PermissionLookup =
  | { readonly state: "ok"; readonly permission: Permission; readonly roleName: string | null }
  | { readonly state: "unavailable" };

/**
 * GitHub for the relay. `startDeviceFlow` and `pollDeviceFlow` reject with
 * `GitHubUnavailableError` when GitHub does not answer, and with
 * `DeviceFlowDisabledError` when the App has the device flow off. The other
 * methods do not reject for GitHub problems: they return `unavailable`.
 */
export interface GitHubAccess {
  startDeviceFlow(): Promise<DeviceCode>;
  pollDeviceFlow(deviceCode: string): Promise<DevicePoll>;
  /** The repository id, canonical name, and installation of `<owner>/<repo>`. Redirects of a renamed repository are followed. */
  resolveRepository(owner: string, repo: string): Promise<RepositoryLookup>;
  /**
   * The `permission` field of the collaborator permission endpoint. A 404 is `none`.
   * A removed installation is `unavailable`, because the caller can have a stale
   * installation id after a new install. The caller then calls `resolveRepository`:
   * `app-not-installed` is the loss of access, and `ok` gives the new installation.
   */
  permission(installationId: number, fullName: string, login: string): Promise<PermissionLookup>;
  /** The current login of a GitHub user id. Null when GitHub does not answer or has no such user. */
  currentLogin(userId: number): Promise<string | null>;
  appSlug(): string;
}

export type GitHubAccessConfig = AppCredentials & {
  /** Default: `https://api.github.com`. */
  readonly apiUrl?: string;
  /** Default: `https://github.com`. */
  readonly webUrl?: string;
  readonly clock?: Clock;
  readonly fetch?: Fetch;
};

export function createGitHubAccess(config: GitHubAccessConfig): GitHubAccess {
  const endpoints: GitHubEndpoints = { api: config.apiUrl ?? GITHUB_ENDPOINTS.api, web: config.webUrl ?? GITHUB_ENDPOINTS.web };
  const fetcher = config.fetch ?? ((input, init) => fetch(input, init));
  const tokens = new InstallationTokens({
    appId: config.appId,
    privateKey: config.privateKeyPem,
    api: endpoints.api,
    clock: config.clock ?? systemClock,
    fetch: fetcher,
  });
  const deviceFlow = { clientId: config.clientId, web: endpoints.web, api: endpoints.api, fetch: fetcher };
  const path = (...parts: string[]) => parts.map(encodeURIComponent).join("/");
  // `GET /user/{id}` needs a token for the higher rate limit. Any installation token does.
  let lastInstallation: number | null = null;
  // GitHub revokes the tokens of a removed installation. A refused token gets one retry with a new token,
  // so the retry finds that the installation is gone.
  const withToken = async (installationId: number, apiPath: string) => {
    const response = await githubRequest(fetcher, `${endpoints.api}${apiPath}`, { bearer: await tokens.token(installationId) });
    if (response.status !== 401) return response;
    tokens.forget(installationId);
    return githubRequest(fetcher, `${endpoints.api}${apiPath}`, { bearer: await tokens.token(installationId) });
  };

  return {
    startDeviceFlow: () => startDeviceFlow(deviceFlow),
    pollDeviceFlow: (deviceCode) => pollDeviceFlow(deviceFlow, deviceCode),
    appSlug: () => config.slug,

    async resolveRepository(owner, repo) {
      try {
        const installation = await githubRequest(fetcher, `${endpoints.api}/repos/${path(owner, repo)}/installation`, { bearer: tokens.jwt() });
        if (installation.status === 404) return { state: "app-not-installed" };
        const installationId = (installation.body as { id?: unknown } | null)?.id;
        if (installation.status !== 200 || !Number.isSafeInteger(installationId)) return { state: "unavailable" };
        const repository = await withToken(installationId as number, `/repos/${path(owner, repo)}`);
        // The installation covers the repository, so a 404 here means that it is gone.
        if (repository.status === 404) return { state: "not-found" };
        const body = repository.body as { id?: unknown; full_name?: unknown } | null;
        if (repository.status !== 200 || !Number.isSafeInteger(body?.id) || typeof body?.full_name !== "string") return { state: "unavailable" };
        lastInstallation = installationId as number;
        return { state: "ok", repoId: body.id as number, fullName: body.full_name, installationId: installationId as number };
      } catch (error) {
        if (error instanceof InstallationGoneError) return { state: "app-not-installed" };
        if (error instanceof GitHubUnavailableError) return { state: "unavailable" };
        throw error;
      }
    },

    async permission(installationId, fullName, login) {
      const [owner = "", repo = ""] = fullName.split("/");
      try {
        const response = await withToken(installationId, `/repos/${path(owner, repo)}/collaborators/${path(login)}/permission`);
        if (response.status === 404) return { state: "ok", permission: "none", roleName: null };
        const body = response.body as { permission?: unknown; role_name?: unknown } | null;
        if (response.status !== 200 || typeof body?.permission !== "string") return { state: "unavailable" };
        lastInstallation = installationId;
        return {
          state: "ok",
          permission: toPermission(body.permission),
          roleName: typeof body.role_name === "string" ? body.role_name : null,
        };
      } catch (error) {
        // The installation id is stale or the App is gone. Only `resolveRepository` can tell which.
        if (error instanceof InstallationGoneError) return { state: "unavailable" };
        if (error instanceof GitHubUnavailableError) return { state: "unavailable" };
        throw error;
      }
    },

    async currentLogin(userId) {
      try {
        const bearer = lastInstallation === null ? undefined : await tokens.token(lastInstallation);
        const response = await githubRequest(fetcher, `${endpoints.api}/user/${userId}`, { bearer });
        const login = (response.body as { login?: unknown } | null)?.login;
        return response.status === 200 && typeof login === "string" ? login : null;
      } catch (error) {
        if (error instanceof InstallationGoneError || error instanceof GitHubUnavailableError) return null;
        throw error;
      }
    },
  };
}

/** The field has only these four values. Any other value does not qualify. */
function toPermission(value: string): Permission {
  return value === "admin" || value === "write" || value === "read" ? value : "none";
}

/** Write, maintain (reported as `write`), and admin qualify for read and post. */
export function qualifies(permission: Permission): boolean {
  return permission === "admin" || permission === "write";
}

/** The time after the last attempt at which a grant needs a new check. */
export const ACCESS_RECHECK_MS = 15 * 60_000;
/** The time after the last successful check for which a grant stays valid while GitHub is unavailable. */
export const ACCESS_GRACE_MS = 60 * 60_000;

/** One row of `access_grants` (design 10.2), with the times as ISO strings. */
export type AccessGrant = {
  readonly permission: Permission;
  readonly roleName: string | null;
  readonly state: "granted" | "lost" | "unverifiable";
  readonly lastSuccessAt: string | null;
  readonly lastAttemptAt: string;
  readonly lastError: string | null;
};

/**
 * What the relay does with the memberships of the owner in the project after a check:
 * `suspend` them (`unverifiable`), `restore` the suspended ones, `end` them (`access-lost`), or nothing.
 */
export type AccessEffect = "none" | "suspend" | "restore" | "end";

/** True when the grant allows access at `now`: granted, and the last success is less than 1 hour old. */
export function grantValid(grant: AccessGrant | null, now: number): boolean {
  if (grant?.state !== "granted" || grant.lastSuccessAt === null) return false;
  return now - Date.parse(grant.lastSuccessAt) < ACCESS_GRACE_MS;
}

/** True when the background check must check the grant again at `now`. */
export function recheckDue(grant: AccessGrant | null, now: number): boolean {
  return grant === null || now - Date.parse(grant.lastAttemptAt) >= ACCESS_RECHECK_MS;
}

/** The grant after a permission lookup at `now`, and the effect on the memberships. */
export function applyPermissionCheck(
  previous: AccessGrant | null,
  check: PermissionLookup,
  now: number,
): { readonly grant: AccessGrant; readonly effect: AccessEffect } {
  const at = new Date(now).toISOString();
  if (check.state === "ok") {
    const granted = qualifies(check.permission);
    const grant: AccessGrant = {
      permission: check.permission,
      roleName: check.roleName,
      state: granted ? "granted" : "lost",
      lastSuccessAt: at,
      lastAttemptAt: at,
      lastError: null,
    };
    if (granted) return { grant, effect: previous?.state === "unverifiable" ? "restore" : "none" };
    return { grant, effect: previous !== null && previous.state !== "lost" ? "end" : "none" };
  }
  const lastError = "GitHub unavailable";
  if (previous === null) {
    return { grant: { permission: "none", roleName: null, state: "unverifiable", lastSuccessAt: null, lastAttemptAt: at, lastError }, effect: "none" };
  }
  // No new answer: a lost grant stays lost, and a granted one stays granted within the grace time.
  if (previous.state === "lost" || grantValid(previous, now)) return { grant: { ...previous, lastAttemptAt: at, lastError }, effect: "none" };
  return {
    grant: { ...previous, state: "unverifiable", lastAttemptAt: at, lastError },
    effect: previous.state === "granted" ? "suspend" : "none",
  };
}

/** Look up the permission of `login` and apply it to the previous grant. */
export async function checkAccess(
  access: Pick<GitHubAccess, "permission">,
  target: { readonly installationId: number; readonly fullName: string; readonly login: string },
  previous: AccessGrant | null,
  clock: Clock,
): Promise<{ readonly grant: AccessGrant; readonly effect: AccessEffect }> {
  const check = await access.permission(target.installationId, target.fullName, target.login);
  return applyPermissionCheck(previous, check, clock.now());
}
