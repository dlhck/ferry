/**
 * A fake GitHub for the messaging tests (design section 14.2). It serves on
 * `127.0.0.1` with plain HTTP, and implements `FakeGitHub` of
 * `test/messaging/harness/contracts.ts`.
 *
 * Use:
 *
 * ```ts
 * const github = await startFakeGitHub({ users: [ALICE], repositories: [{ owner: "acme", name: "app", id: 501 }] });
 * github.install("acme");
 * github.setPermission("acme/app", "alice", "write");
 * const access = createGitHubAccess({ ...github.app, privateKey: github.app.privateKeyPem,
 *   endpoints: { api: github.apiUrl, web: github.webUrl }, clock });
 * // ...
 * await github.stop();
 * ```
 *
 * Endpoints. `JWT` means an App JWT that the fake checks against its own key
 * (RS256, `iss` the App id, not expired, at most 10 minutes long).
 * `installation` means a token from `POST /app/installations/{id}/access_tokens`.
 *
 * | Endpoint | Auth | Answer |
 * | --- | --- | --- |
 * | `POST /login/device/code` | form `client_id` | a device code, or `device_flow_disabled` |
 * | `POST /login/oauth/access_token` | form `client_id`, `device_code`, `grant_type` | `authorization_pending`, `slow_down`, `expired_token`, `access_denied`, `incorrect_device_code`, or a user token |
 * | `GET /user` | user token | `{ id, login }` |
 * | `GET /user/{id}` | none, or any token | `{ id, login }`, or 404 |
 * | `GET /app` | JWT | `{ id, slug, client_id, name, owner }` |
 * | `GET /repos/{o}/{r}/installation` | JWT | the installation that covers the repository, or 404 |
 * | `POST /app/installations/{id}/access_tokens` | JWT | 201 `{ token, expires_at }` (1 hour), or 404 |
 * | `GET /repos/{o}/{r}` | installation | `{ id, full_name, owner }`, or 404 when the installation does not cover it |
 * | `GET /repos/{o}/{r}/collaborators/{u}/permission` | installation | `{ permission, role_name, user }`, or 404 for `none` |
 * | `POST /app-manifests/{code}/conversions` | none | 201 with the App credentials, for a code from `manifestCode` |
 *
 * Controls beyond the contract:
 *
 * - `manifestCode(owner)`: a one-time code for the manifest conversion. The conversion
 *   returns this fake's App (its key included), owned by `owner`.
 * - `setDeviceFlow(enabled)`: "Enable Device Flow" in the App settings. Default: on.
 *
 * Faults (`setFault`) apply to each later request, the request log included:
 * `server-error` answers 503, `rate-limit` answers 403 with `x-ratelimit-remaining: 0`,
 * and `drop` closes the connection without an answer.
 *
 * Owner, repository, and login names compare without case. All data is example data,
 * and the key is generated for each start.
 */

import { generateKeyPairSync, randomBytes, verify, type KeyObject } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

export type FakePermission = "admin" | "write" | "read" | "none";
export type FakeRepository = { readonly owner: string; readonly name: string; readonly id: number };
export type FakeGitHubFault = "server-error" | "rate-limit" | "drop";
type FakeUser = { readonly login: string; readonly githubUserId: number };

export type StartFakeGitHubOptions = {
  readonly users?: readonly FakeUser[];
  readonly repositories?: readonly FakeRepository[];
  readonly clock?: { now(): number };
};

export interface FakeGitHub {
  readonly apiUrl: string;
  readonly webUrl: string;
  readonly app: { readonly appId: number; readonly clientId: string; readonly slug: string; readonly privateKeyPem: string };
  addUser(user: FakeUser): void;
  renameUser(githubUserId: number, login: string): void;
  addRepository(repository: FakeRepository): void;
  install(owner: string, repositories?: readonly string[]): number;
  uninstall(owner: string): void;
  setPermission(fullName: string, login: string, permission: FakePermission, roleName?: string | null): void;
  pendingUserCodes(): string[];
  authorizeDevice(userCode: string, githubUserId: number): void;
  denyDevice(userCode: string): void;
  expireDevice(userCode: string): void;
  slowDownDevice(userCode: string): void;
  setFault(fault: FakeGitHubFault | null): void;
  requests(): readonly { readonly method: string; readonly path: string }[];
  stop(): Promise<void>;
  manifestCode(owner: string): string;
  setDeviceFlow(enabled: boolean): void;
}

export type StartFakeGitHub = (options?: StartFakeGitHubOptions) => Promise<FakeGitHub>;

const APP = { appId: 424242, clientId: "Iv23liExampleClient01", slug: "example-ferry-relay", name: "Example Ferry relay" };
const DEVICE_CODE_TTL_MS = 15 * 60_000;
const DEVICE_INTERVAL_S = 5;
const INSTALLATION_TOKEN_TTL_MS = 60 * 60_000;
const JWT_MAX_SPAN_S = 600;

type Installation = { readonly id: number; readonly owner: string; readonly accountId: number; readonly repositories: ReadonlySet<string> | "all" };
type DeviceFlow = {
  readonly deviceCode: string;
  readonly userCode: string;
  readonly expiresAt: number;
  state: "pending" | "authorized" | "denied" | "expired" | "used";
  userId: number | null;
  slowDown: boolean;
  interval: number;
};

export const startFakeGitHub: StartFakeGitHub = async (options = {}) => {
  const clock = options.clock ?? { now: () => Date.now() };
  const keys = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const privateKeyPem = keys.privateKey.export({ type: "pkcs8", format: "pem" }).toString();
  const publicKey: KeyObject = keys.publicKey;

  const users = new Map<number, string>();
  const repositories = new Map<string, FakeRepository>();
  const installations = new Map<string, Installation>();
  const permissions = new Map<string, { permission: FakePermission; roleName: string | null }>();
  const devices = new Map<string, DeviceFlow>();
  const userTokens = new Map<string, number>();
  const installationTokens = new Map<string, { installationId: number; expiresAt: number }>();
  const manifestCodes = new Map<string, string>();
  const log: { method: string; path: string }[] = [];
  let fault: FakeGitHubFault | null = null;
  let deviceFlowEnabled = true;
  let nextInstallation = 7001;

  const lower = (value: string) => value.toLowerCase();
  const repoKey = (owner: string, name: string) => `${lower(owner)}/${lower(name)}`;
  const fullNameOf = (repository: FakeRepository) => `${repository.owner}/${repository.name}`;
  const random = (prefix: string) => `${prefix}${randomBytes(12).toString("hex")}`;
  const covers = (installation: Installation, repository: FakeRepository) =>
    lower(installation.owner) === lower(repository.owner) &&
    (installation.repositories === "all" || installation.repositories.has(lower(repository.name)));
  const installationById = (id: number) => [...installations.values()].find((installation) => installation.id === id) ?? null;
  const flowByUserCode = (userCode: string) => {
    const flow = [...devices.values()].find((candidate) => candidate.userCode === userCode);
    if (!flow) throw new Error(`The fake GitHub has no device flow with the user code ${userCode}.`);
    return flow;
  };

  for (const user of options.users ?? []) users.set(user.githubUserId, user.login);
  for (const repository of options.repositories ?? []) repositories.set(repoKey(repository.owner, repository.name), repository);

  /** The App JWT is valid: RS256, this App, signed with the fake's key, and within its time. */
  const validJwt = (bearer: string | null): boolean => {
    const parts = bearer?.split(".") ?? [];
    if (parts.length !== 3) return false;
    const [header = "", payload = "", signature = ""] = parts;
    try {
      const head = JSON.parse(Buffer.from(header, "base64url").toString()) as { alg?: unknown };
      const claims = JSON.parse(Buffer.from(payload, "base64url").toString()) as { iat?: unknown; exp?: unknown; iss?: unknown };
      if (head.alg !== "RS256") return false;
      if (!verify("sha256", Buffer.from(`${header}.${payload}`), publicKey, Buffer.from(signature, "base64url"))) return false;
      const now = Math.floor(clock.now() / 1000);
      if (typeof claims.iat !== "number" || typeof claims.exp !== "number") return false;
      if (String(claims.iss) !== String(APP.appId) && claims.iss !== APP.clientId) return false;
      return claims.iat <= now + 60 && claims.exp > now && claims.exp - claims.iat <= JWT_MAX_SPAN_S;
    } catch {
      return false;
    }
  };

  /** The installation of a valid installation token. */
  const tokenInstallation = (bearer: string | null): Installation | null => {
    const entry = bearer === null ? undefined : installationTokens.get(bearer);
    if (!entry || clock.now() >= entry.expiresAt) return null;
    return installationById(entry.installationId);
  };

  type Answer = { status: number; body?: unknown; headers?: Record<string, string> };
  const json = (status: number, body: unknown): Answer => ({ status, body });
  const notFound = json(404, { message: "Not Found" });
  const unauthorized = json(401, { message: "Bad credentials" });

  const route = (method: string, path: string, bearer: string | null, form: Record<string, string>): Answer => {
    const segments = path.split("/").slice(1).map(decodeURIComponent);
    const is = (verb: string, ...pattern: string[]) =>
      method === verb && segments.length === pattern.length && pattern.every((part, index) => part === "*" || part === segments[index]);

    if (is("POST", "login", "device", "code")) {
      if (form.client_id !== APP.clientId) return json(400, { error: "incorrect_client_credentials" });
      if (!deviceFlowEnabled) return json(400, { error: "device_flow_disabled" });
      const deviceCode = random("fake-device-");
      const userCode = `${randomBytes(2).toString("hex")}-${randomBytes(2).toString("hex")}`.toUpperCase();
      devices.set(deviceCode, {
        deviceCode,
        userCode,
        expiresAt: clock.now() + DEVICE_CODE_TTL_MS,
        state: "pending",
        userId: null,
        slowDown: false,
        interval: DEVICE_INTERVAL_S,
      });
      return json(200, {
        device_code: deviceCode,
        user_code: userCode,
        verification_uri: "https://github.com/login/device",
        expires_in: DEVICE_CODE_TTL_MS / 1000,
        interval: DEVICE_INTERVAL_S,
      });
    }
    if (is("POST", "login", "oauth", "access_token")) {
      if (form.client_id !== APP.clientId) return json(200, { error: "incorrect_client_credentials" });
      if (form.grant_type !== "urn:ietf:params:oauth:grant-type:device_code") return json(200, { error: "unsupported_grant_type" });
      if (!deviceFlowEnabled) return json(200, { error: "device_flow_disabled" });
      const flow = devices.get(form.device_code ?? "");
      if (!flow || flow.state === "used") return json(200, { error: "incorrect_device_code" });
      if (flow.state === "expired" || clock.now() >= flow.expiresAt) return json(200, { error: "expired_token" });
      if (flow.slowDown) {
        flow.slowDown = false;
        flow.interval += 5;
        return json(200, { error: "slow_down", interval: flow.interval });
      }
      if (flow.state === "denied") return json(200, { error: "access_denied" });
      if (flow.state === "pending") return json(200, { error: "authorization_pending" });
      flow.state = "used";
      const token = random("fake-user-token-");
      userTokens.set(token, flow.userId!);
      return json(200, { access_token: token, token_type: "bearer", scope: "" });
    }
    if (is("GET", "user")) {
      const id = bearer === null ? undefined : userTokens.get(bearer);
      const login = id === undefined ? undefined : users.get(id);
      return login === undefined ? unauthorized : json(200, { id, login });
    }
    if (is("GET", "user", "*")) {
      const id = Number(segments[1]);
      const login = users.get(id);
      return login === undefined ? notFound : json(200, { id, login });
    }
    if (is("GET", "app")) {
      if (!validJwt(bearer)) return unauthorized;
      return json(200, { id: APP.appId, slug: APP.slug, client_id: APP.clientId, name: APP.name, owner: { login: "example-org" } });
    }
    if (is("POST", "app-manifests", "*", "conversions")) {
      const owner = manifestCodes.get(segments[1]!);
      if (owner === undefined) return notFound;
      manifestCodes.delete(segments[1]!);
      return json(201, {
        id: APP.appId,
        slug: APP.slug,
        name: APP.name,
        client_id: APP.clientId,
        client_secret: random("fake-client-secret-"),
        webhook_secret: random("fake-webhook-secret-"),
        pem: privateKeyPem,
        owner: { login: owner },
      });
    }
    if (is("POST", "app", "installations", "*", "access_tokens")) {
      if (!validJwt(bearer)) return unauthorized;
      const installation = installationById(Number(segments[2]));
      if (!installation) return notFound;
      const token = random("fake-installation-token-");
      const expiresAt = clock.now() + INSTALLATION_TOKEN_TTL_MS;
      installationTokens.set(token, { installationId: installation.id, expiresAt });
      return json(201, { token, expires_at: new Date(expiresAt).toISOString() });
    }
    if (segments[0] === "repos" && segments.length >= 3) {
      const repository = repositories.get(repoKey(segments[1]!, segments[2]!));
      if (is("GET", "repos", "*", "*", "installation")) {
        if (!validJwt(bearer)) return unauthorized;
        const installation = repository ? [...installations.values()].find((candidate) => covers(candidate, repository)) : undefined;
        if (!installation) return notFound;
        return json(200, { id: installation.id, account: { login: installation.owner, id: installation.accountId } });
      }
      const installation = tokenInstallation(bearer);
      if (!installation) return unauthorized;
      if (!repository || !covers(installation, repository)) return notFound;
      if (is("GET", "repos", "*", "*")) {
        return json(200, { id: repository.id, full_name: fullNameOf(repository), owner: { login: repository.owner } });
      }
      if (is("GET", "repos", "*", "*", "collaborators", "*", "permission")) {
        const login = segments[4]!;
        const grant = permissions.get(`${repoKey(repository.owner, repository.name)}\n${lower(login)}`);
        if (!grant || grant.permission === "none") return notFound;
        const id = [...users.entries()].find(([, name]) => lower(name) === lower(login))?.[0] ?? null;
        return json(200, { permission: grant.permission, role_name: grant.roleName, user: { login, id } });
      }
    }
    return notFound;
  };

  const readBody = async (request: IncomingMessage): Promise<Record<string, string>> => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(chunk as Buffer);
    const text = Buffer.concat(chunks).toString();
    if (text === "") return {};
    if ((request.headers["content-type"] ?? "").includes("application/json")) {
      const parsed = JSON.parse(text) as Record<string, unknown>;
      return Object.fromEntries(Object.entries(parsed).map(([key, value]) => [key, String(value)]));
    }
    return Object.fromEntries(new URLSearchParams(text));
  };

  const handle = async (request: IncomingMessage, response: ServerResponse) => {
    const url = new URL(request.url ?? "/", "http://127.0.0.1");
    const method = request.method ?? "GET";
    log.push({ method, path: url.pathname });
    if (fault === "drop") {
      request.socket.destroy();
      return;
    }
    let answer: Answer;
    if (fault === "server-error") answer = json(503, { message: "Service Unavailable" });
    else if (fault === "rate-limit") answer = { status: 403, body: { message: "API rate limit exceeded" }, headers: { "x-ratelimit-remaining": "0" } };
    else {
      const authorization = request.headers.authorization ?? "";
      const bearer = /^(?:Bearer|token) (.+)$/.exec(authorization)?.[1] ?? null;
      try {
        answer = route(method, url.pathname, bearer, await readBody(request));
      } catch {
        answer = json(400, { message: "Problems parsing the body" });
      }
    }
    response.writeHead(answer.status, { "Content-Type": "application/json", ...answer.headers });
    response.end(answer.body === undefined ? "" : JSON.stringify(answer.body));
  };

  const server = createServer((request, response) => void handle(request, response));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  return {
    apiUrl: url,
    webUrl: url,
    app: { appId: APP.appId, clientId: APP.clientId, slug: APP.slug, privateKeyPem },
    addUser(user) {
      users.set(user.githubUserId, user.login);
    },
    renameUser(githubUserId, login) {
      if (!users.has(githubUserId)) throw new Error(`The fake GitHub has no user ${githubUserId}.`);
      const old = users.get(githubUserId)!;
      users.set(githubUserId, login);
      for (const [key, grant] of [...permissions]) {
        const [repository, name] = key.split("\n");
        if (name !== lower(old)) continue;
        permissions.delete(key);
        permissions.set(`${repository}\n${lower(login)}`, grant);
      }
    },
    addRepository(repository) {
      repositories.set(repoKey(repository.owner, repository.name), repository);
    },
    install(owner, names) {
      const existing = installations.get(lower(owner));
      const id = existing?.id ?? nextInstallation++;
      const accountId = [...users.entries()].find(([, login]) => lower(login) === lower(owner))?.[0] ?? 90_000 + id;
      installations.set(lower(owner), { id, owner, accountId, repositories: names === undefined ? "all" : new Set(names.map(lower)) });
      return id;
    },
    uninstall(owner) {
      const installation = installations.get(lower(owner));
      if (!installation) return;
      installations.delete(lower(owner));
      for (const [token, entry] of [...installationTokens]) if (entry.installationId === installation.id) installationTokens.delete(token);
    },
    setPermission(fullName, login, permission, roleName = null) {
      const [owner = "", name = ""] = fullName.split("/");
      permissions.set(`${repoKey(owner, name)}\n${lower(login)}`, { permission, roleName });
    },
    pendingUserCodes() {
      return [...devices.values()].filter((flow) => flow.state === "pending" && clock.now() < flow.expiresAt).map((flow) => flow.userCode);
    },
    authorizeDevice(userCode, githubUserId) {
      if (!users.has(githubUserId)) throw new Error(`The fake GitHub has no user ${githubUserId}.`);
      const flow = flowByUserCode(userCode);
      flow.state = "authorized";
      flow.userId = githubUserId;
    },
    denyDevice(userCode) {
      flowByUserCode(userCode).state = "denied";
    },
    expireDevice(userCode) {
      flowByUserCode(userCode).state = "expired";
    },
    slowDownDevice(userCode) {
      flowByUserCode(userCode).slowDown = true;
    },
    setFault(next) {
      fault = next;
    },
    requests() {
      return log.map((entry) => ({ ...entry }));
    },
    manifestCode(owner) {
      const code = random("fake-manifest-");
      manifestCodes.set(code, owner);
      return code;
    },
    setDeviceFlow(enabled) {
      deviceFlowEnabled = enabled;
    },
    async stop() {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
};
