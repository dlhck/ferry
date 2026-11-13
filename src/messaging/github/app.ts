/**
 * The GitHub App of a team relay (design section 3): its files on the relay
 * host, the App JWT, and the installation tokens.
 *
 * Files in `~/.ferry/relay/` (mode 0700), outside the sync snapshot:
 *
 * - `config.json` (0600): `{ schemaVersion: 1, github: { appId, slug, clientId }, allowedOwners }`.
 *   The client ID is public.
 * - `github-app.pem` (0600): the App private key. It never leaves the relay host,
 *   and no log, error, or output has it.
 *
 * The relay keeps installation tokens in memory only. A token is renewed 5
 * minutes before it expires. No error message has a token or a JWT.
 */

import { createPrivateKey, randomBytes, sign, type KeyObject } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

/** Milliseconds since the Unix epoch. Tests give a fake clock. */
export type Clock = { now(): number };
export const systemClock: Clock = { now: () => Date.now() };

/** The two GitHub origins. A test gives the URLs of the fake GitHub for both. */
export type GitHubEndpoints = { readonly api: string; readonly web: string };
export const GITHUB_ENDPOINTS: GitHubEndpoints = { api: "https://api.github.com", web: "https://github.com" };

export type RelayConfig = {
  readonly schemaVersion: 1;
  readonly github: { readonly appId: number; readonly slug: string; readonly clientId: string };
  /** The repository owner accounts that this relay serves, in lower case. */
  readonly allowedOwners: readonly string[];
};

/** The App credentials that the relay needs for `createGitHubAccess`. */
export type AppCredentials = {
  readonly appId: number;
  readonly slug: string;
  readonly clientId: string;
  readonly privateKey: string;
};

export function relayDir(home: string): string {
  return join(home, ".ferry", "relay");
}

const CONFIG_FILE = "config.json";
const KEY_FILE = "github-app.pem";
/** A GitHub login or organization name. */
export const ACCOUNT_NAME = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/;
const SLUG = /^[a-z0-9][a-z0-9-]*$/;

/** Read `config.json`. Null when the relay has no App yet. An invalid file is an error. */
export function readRelayConfig(home: string): RelayConfig | null {
  const path = join(relayDir(home), CONFIG_FILE);
  if (!existsSync(path)) return null;
  return parseRelayConfig(readFileSync(path, "utf8"));
}

/** Check the text of `config.json`. */
export function parseRelayConfig(text: string): RelayConfig {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw new Error("~/.ferry/relay/config.json is not valid JSON.");
  }
  const config = value as { schemaVersion?: unknown; github?: { appId?: unknown; slug?: unknown; clientId?: unknown }; allowedOwners?: unknown };
  const github = config?.github;
  const owners = config?.allowedOwners;
  if (
    config?.schemaVersion !== 1 ||
    !Number.isSafeInteger(github?.appId) ||
    (github?.appId as number) <= 0 ||
    typeof github?.slug !== "string" ||
    !SLUG.test(github.slug) ||
    typeof github?.clientId !== "string" ||
    github.clientId === "" ||
    !Array.isArray(owners) ||
    !owners.every((owner) => typeof owner === "string" && ACCOUNT_NAME.test(owner))
  ) {
    throw new Error("~/.ferry/relay/config.json is not a valid relay config. Run ferry relay import-github-app again.");
  }
  return {
    schemaVersion: 1,
    github: { appId: github.appId as number, slug: github.slug, clientId: github.clientId },
    allowedOwners: [...new Set((owners as string[]).map((owner) => owner.toLowerCase()))],
  };
}

export function writeRelayConfig(home: string, config: RelayConfig): void {
  writePrivate(join(relayDir(home), CONFIG_FILE), `${JSON.stringify(config, null, 2)}\n`);
}

/** Read the App private key. The error names the file, never its content. */
export function readAppKey(home: string): string {
  const path = join(relayDir(home), KEY_FILE);
  if (!existsSync(path)) throw new Error("The relay has no GitHub App key in ~/.ferry/relay/github-app.pem. Run ferry relay setup github-app.");
  const pem = readFileSync(path, "utf8");
  checkAppKey(pem);
  return pem;
}

export function writeAppKey(home: string, pem: string): void {
  checkAppKey(pem);
  writePrivate(join(relayDir(home), KEY_FILE), pem.endsWith("\n") ? pem : `${pem}\n`);
}

/** The App credentials from the two relay files. */
export function readAppCredentials(home: string): AppCredentials {
  const config = readRelayConfig(home);
  if (!config) throw new Error("The relay has no GitHub App. Run ferry relay setup github-app.");
  return { ...config.github, privateKey: readAppKey(home) };
}

/** Refuse a value that is not an RSA private key. The error has no part of the value. */
export function checkAppKey(pem: string): void {
  let key: KeyObject;
  try {
    key = createPrivateKey(pem);
  } catch {
    throw new Error("The GitHub App key is not a PEM private key.");
  }
  if (key.asymmetricKeyType !== "rsa") throw new Error("The GitHub App key is not an RSA private key.");
}

/** Write a file with mode 0600 in a directory with mode 0700, by a rename. */
export function writePrivate(path: string, text: string): void {
  const dir = dirname(path);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  chmodSync(dir, 0o700);
  const temporary = `${path}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
  writeFileSync(temporary, text, { mode: 0o600 });
  chmodSync(temporary, 0o600);
  renameSync(temporary, path);
}

/** The App JWT is valid this long after its issue time. GitHub allows at most 10 minutes. */
export const APP_JWT_TTL_MS = 9 * 60_000;
/** The issue time is this much in the past, so a small clock difference to GitHub does not refuse the JWT. */
const APP_JWT_SKEW_MS = 60_000;

/** An App JWT (RS256) for `iss = appId`. */
export function appJwt(appId: number, privateKey: string | KeyObject, now: number): string {
  const seconds = (ms: number) => Math.floor(ms / 1000);
  const part = (value: object) => Buffer.from(JSON.stringify(value)).toString("base64url");
  const body = `${part({ alg: "RS256", typ: "JWT" })}.${part({ iat: seconds(now - APP_JWT_SKEW_MS), exp: seconds(now + APP_JWT_TTL_MS), iss: String(appId) })}`;
  const key = typeof privateKey === "string" ? createPrivateKey(privateKey) : privateKey;
  return `${body}.${sign("sha256", Buffer.from(body), key).toString("base64url")}`;
}

/** GitHub did not answer, answered 5xx, or refused for the rate limit. */
export class GitHubUnavailableError extends Error {
  constructor(readonly detail: string) {
    super(`GitHub is unavailable: ${detail}`);
    this.name = "GitHubUnavailableError";
  }
}

export type GitHubResponse = { readonly status: number; readonly body: unknown };

export type GitHubRequest = {
  readonly method?: "GET" | "POST";
  /** The `Authorization` value without the scheme: a JWT, an installation token, or a user token. */
  readonly bearer?: string;
  /** A JSON body. */
  readonly json?: unknown;
  /** A form body, for the OAuth endpoints of `github.com`. */
  readonly form?: Readonly<Record<string, string>>;
};

export type Fetch = (input: string, init: RequestInit) => Promise<Response>;

/** A request to GitHub gets an answer within this time, or counts as unavailable. */
const REQUEST_TIMEOUT_MS = 15_000;

/**
 * One request to GitHub. A network error, a 5xx answer, a 429, and a 403 for
 * the rate limit throw `GitHubUnavailableError`. The caller handles the other
 * statuses. The error has the method, path, and status, never a header.
 */
export async function githubRequest(fetcher: Fetch, url: string, request: GitHubRequest = {}): Promise<GitHubResponse> {
  const method = request.method ?? "GET";
  const headers: Record<string, string> = {
    Accept: "application/vnd.github+json",
    "User-Agent": "ferry-relay",
    "X-GitHub-Api-Version": "2022-11-28",
  };
  if (request.bearer !== undefined) headers.Authorization = `Bearer ${request.bearer}`;
  let body: string | undefined;
  if (request.json !== undefined) {
    headers["Content-Type"] = "application/json";
    body = JSON.stringify(request.json);
  } else if (request.form !== undefined) {
    // The OAuth endpoints answer in JSON only with this Accept value.
    headers.Accept = "application/json";
    headers["Content-Type"] = "application/x-www-form-urlencoded";
    body = new URLSearchParams(request.form).toString();
  }
  const where = `${method} ${new URL(url).pathname}`;
  let response: Response;
  try {
    response = await fetcher(url, { method, headers, body, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
  } catch {
    throw new GitHubUnavailableError(`${where} got no answer`);
  }
  const rateLimited = response.status === 429 || (response.status === 403 && response.headers.get("x-ratelimit-remaining") === "0");
  if (response.status >= 500 || rateLimited) {
    await response.body?.cancel();
    throw new GitHubUnavailableError(`${where} answered ${response.status}${rateLimited ? " (rate limit)" : ""}`);
  }
  const text = await response.text().catch(() => {
    throw new GitHubUnavailableError(`${where} broke off the answer`);
  });
  let parsed: unknown = null;
  if (text !== "") {
    try {
      parsed = JSON.parse(text);
    } catch {
      throw new GitHubUnavailableError(`${where} answered ${response.status} without JSON`);
    }
  }
  return { status: response.status, body: parsed };
}

/** An installation token is renewed this long before it expires. */
export const TOKEN_RENEW_MS = 5 * 60_000;

/** An installation that GitHub does not know, for example after an uninstall. */
export class InstallationGoneError extends Error {
  constructor(readonly installationId: number) {
    super(`GitHub has no installation ${installationId} of the App.`);
    this.name = "InstallationGoneError";
  }
}

export type InstallationTokensOptions = {
  readonly appId: number;
  readonly privateKey: string;
  readonly api: string;
  readonly clock: Clock;
  readonly fetch: Fetch;
};

/** The App JWT and the installation tokens, in memory. */
export class InstallationTokens {
  readonly #options: InstallationTokensOptions;
  readonly #key: KeyObject;
  readonly #tokens = new Map<number, { readonly token: string; readonly expiresAt: number }>();
  readonly #minting = new Map<number, Promise<string>>();

  constructor(options: InstallationTokensOptions) {
    this.#options = options;
    this.#key = createPrivateKey(options.privateKey);
  }

  /** A new App JWT. */
  jwt(): string {
    return appJwt(this.#options.appId, this.#key, this.#options.clock.now());
  }

  /** A token of the installation: the cached one, or a new one 5 minutes before the cached one expires. */
  async token(installationId: number): Promise<string> {
    const cached = this.#tokens.get(installationId);
    if (cached && this.#options.clock.now() < cached.expiresAt - TOKEN_RENEW_MS) return cached.token;
    const running = this.#minting.get(installationId);
    if (running) return running;
    const minting = this.#mint(installationId).finally(() => this.#minting.delete(installationId));
    this.#minting.set(installationId, minting);
    return minting;
  }

  /** Forget the token of an installation, for example after GitHub refused it. */
  forget(installationId: number): void {
    this.#tokens.delete(installationId);
  }

  async #mint(installationId: number): Promise<string> {
    const response = await githubRequest(this.#options.fetch, `${this.#options.api}/app/installations/${installationId}/access_tokens`, {
      method: "POST",
      bearer: this.jwt(),
    });
    if (response.status === 404) {
      this.#tokens.delete(installationId);
      throw new InstallationGoneError(installationId);
    }
    const body = response.body as { token?: unknown; expires_at?: unknown } | null;
    const expiresAt = typeof body?.expires_at === "string" ? Date.parse(body.expires_at) : Number.NaN;
    if (response.status !== 201 || typeof body?.token !== "string" || Number.isNaN(expiresAt)) {
      throw new GitHubUnavailableError(`POST /app/installations/${installationId}/access_tokens answered ${response.status}`);
    }
    this.#tokens.set(installationId, { token: body.token, expiresAt });
    return body.token;
  }
}
