/**
 * The files of the MCP gateway on a box, in `~/.ferry/mcp-gateway/`:
 *
 * - `servers.json`: the servers of the gateway. This is the input of
 *   `ferry mcp serve`. Sync writes it from the carried MCP entries: a remote
 *   server as `{"url":"https://..."}`, and a shared stdio server as
 *   `{"command":"...","args":[...],"env":{...}}`. The box copies the `env`
 *   values from the harness entries. They never leave the box.
 * - `client-key`: the key that a harness sends as `Authorization: Bearer <key>`.
 *   Ferry makes it on the box. It never leaves the box.
 * - `tokens/<server>.json`: the OAuth client registration and the tokens of one server.
 * - `state.json`: the pid and port of the running gateway, and the servers
 *   whose login expired.
 * - `cache/<server>.json`: the last good tool list of one server.
 *
 * Each file that holds a key, a token, or an `env` value has mode 0600.
 */

import { randomBytes } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { OAuthDiscoveryState, StoredOAuthClientInformation, StoredOAuthTokens } from "@modelcontextprotocol/client";
import { redactTokens, redactUrlCredentials } from "../manifest.ts";

export { DEFAULT_GATEWAY_PORT } from "./url.ts";

/** A server name is also a file name and a URL path segment. It does not start with a dot. */
export const SERVER_NAME = /^[A-Za-z0-9_:-][A-Za-z0-9._:-]*$/;

export type RemoteGatewayServer = { readonly name: string; readonly url: string };

/** A shared stdio server. The gateway runs one process of it for all agents of the box. */
export type StdioGatewayServer = {
  readonly name: string;
  readonly command: string;
  readonly args: readonly string[];
  readonly env: Readonly<Record<string, string>>;
};

export type GatewayServer = RemoteGatewayServer | StdioGatewayServer;

export type TokenFile = {
  readonly clientInformation?: StoredOAuthClientInformation;
  readonly tokens?: StoredOAuthTokens;
  readonly discoveryState?: OAuthDiscoveryState;
};

export type GatewayState = {
  readonly pid?: number;
  readonly port?: number;
  /** The servers whose refresh failed. A new login removes the server. */
  readonly loginRequired?: readonly string[];
  /** The shared stdio servers that sent a request to the client. The gateway cannot share them. */
  readonly cannotShare?: readonly string[];
};

export type ToolCache = { readonly tools: readonly unknown[] };

export function gatewayDir(home: string): string {
  return join(home, ".ferry", "mcp-gateway");
}

/**
 * Read `servers.json`. A missing file is no servers. An invalid name, URL, or
 * stdio entry is an error. The error has no `env` value.
 */
export function readServers(home: string): GatewayServer[] {
  const path = join(gatewayDir(home), "servers.json");
  if (!existsSync(path)) return [];
  const parsed = readJson(path) as { servers?: Record<string, { url?: unknown; command?: unknown; args?: unknown; env?: unknown }> };
  const servers: GatewayServer[] = [];
  for (const [name, entry] of Object.entries(parsed.servers ?? {})) {
    if (!SERVER_NAME.test(name)) throw new Error(`servers.json has an invalid server name: ${name}`);
    if (typeof entry?.command === "string") {
      const { command, args = [], env = {} } = entry;
      const strings = (value: unknown) => Array.isArray(value) && value.every((item) => typeof item === "string");
      const record = typeof env === "object" && env !== null && !Array.isArray(env) && strings(Object.values(env));
      if (command === "" || !strings(args) || !record) throw new Error(`servers.json has an invalid stdio server ${name}`);
      servers.push({ name, command, args: args as string[], env: env as Record<string, string> });
      continue;
    }
    const url = typeof entry?.url === "string" ? new URL(entry.url) : null;
    if (!url || (url.protocol !== "https:" && !isLoopback(url))) {
      throw new Error(`servers.json needs an https URL for ${name}`);
    }
    servers.push({ name, url: url.toString() });
  }
  return servers;
}

/** Read the client key. `create` makes a new key when there is none. */
export function clientKey(home: string, create = false): string | null {
  const path = join(gatewayDir(home), "client-key");
  if (existsSync(path)) return readFileSync(path, "utf8").trim();
  if (!create) return null;
  const key = randomBytes(32).toString("hex");
  writePrivate(path, `${key}\n`);
  return key;
}

function tokenPath(home: string, server: string): string {
  return join(gatewayDir(home), "tokens", `${server}.json`);
}

export function readTokenFile(home: string, server: string): TokenFile | null {
  const path = tokenPath(home, server);
  if (!existsSync(path)) return null;
  return readJson(path) as TokenFile;
}

export function updateTokenFile(home: string, server: string, change: Partial<TokenFile>): void {
  writePrivate(tokenPath(home, server), JSON.stringify({ ...readTokenFile(home, server), ...change }));
}

/** A value that changes when a new token file replaces the old one. */
export function tokenVersion(home: string, server: string): string | null {
  const file = readTokenFile(home, server);
  return file?.tokens ? file.tokens.access_token : null;
}

export function readState(home: string): GatewayState {
  const path = join(gatewayDir(home), "state.json");
  if (!existsSync(path)) return {};
  return readJson(path) as GatewayState;
}

export function updateState(home: string, change: (state: GatewayState) => GatewayState): void {
  writePrivate(join(gatewayDir(home), "state.json"), JSON.stringify(change(readState(home))));
}

export function setLoginRequired(home: string, server: string, required: boolean): void {
  updateState(home, (state) => {
    const others = (state.loginRequired ?? []).filter((name) => name !== server);
    return { ...state, loginRequired: required ? [...others, server] : others };
  });
}

export function setCannotShare(home: string, server: string): void {
  updateState(home, (state) => {
    const others = (state.cannotShare ?? []).filter((name) => name !== server);
    return { ...state, cannotShare: [...others, server] };
  });
}

export function readToolCache(home: string, server: string): ToolCache | null {
  const path = join(gatewayDir(home), "cache", `${server}.json`);
  if (!existsSync(path)) return null;
  return readJson(path) as ToolCache;
}

export function writeToolCache(home: string, server: string, cache: ToolCache): void {
  writePrivate(join(gatewayDir(home), "cache", `${server}.json`), JSON.stringify(cache));
}

/**
 * The secrets that must not leave the gateway: the client key, the tokens
 * and client secret of each server, and the `env` values of each stdio server.
 */
export function knownSecrets(home: string, servers: readonly string[]): string[] {
  const secrets: string[] = [];
  const key = clientKey(home);
  if (key) secrets.push(key);
  let configured: GatewayServer[] = [];
  try {
    configured = readServers(home);
  } catch {
    // A servers.json that is not valid has no value to take out.
  }
  for (const server of configured) {
    if (!servers.includes(server.name) || !("env" in server)) continue;
    for (const value of Object.values(server.env)) if (value.length >= 8) secrets.push(value);
  }
  for (const server of servers) {
    let file: TokenFile | null = null;
    try {
      file = readTokenFile(home, server);
    } catch {
      continue;
    }
    for (const value of [file?.tokens?.access_token, file?.tokens?.refresh_token, file?.tokens?.id_token, file?.clientInformation?.client_secret]) {
      if (typeof value === "string" && value.length >= 8) secrets.push(value);
    }
  }
  return secrets;
}

/** Take each known secret, each token pattern, and each URL credential out of a text. */
export function scrub(text: string, secrets: readonly string[]): string {
  let clean = text;
  for (const secret of secrets) clean = clean.replaceAll(secret, "[token]");
  return redactUrlCredentials(redactTokens(clean));
}

/** Read a JSON file. The error of a file that is not valid JSON has no text of the file, because the file can hold a token. */
function readJson(path: string): unknown {
  const text = readFileSync(path, "utf8");
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`${path} is not valid JSON.`);
  }
}

/** Write a file with mode 0600 in a directory with mode 0700. The rename makes the change atomic. */
export function writePrivate(path: string, text: string): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
  writeFileSync(temporary, text, { mode: 0o600 });
  chmodSync(temporary, 0o600);
  renameSync(temporary, path);
}

export function isLoopback(url: URL): boolean {
  return url.protocol === "http:" && (url.hostname === "127.0.0.1" || url.hostname === "localhost");
}
