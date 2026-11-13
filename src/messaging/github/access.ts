/**
 * The GitHub access checks of the relay (design sections 3.4 and 3.6).
 *
 * `createGitHubAccess` implements `GitHubAccess`, the interface that the relay
 * server (lane A) consumes. It uses the App JWT for the installation lookup
 * and an installation token for the repository and permission lookups. The
 * relay store applies the revalidation rules of section 3.6 to the results.
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
