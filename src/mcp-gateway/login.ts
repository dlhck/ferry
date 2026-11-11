/**
 * `ferry mcp login <server>` and `ferry mcp list`.
 *
 * The login registers a client (DCR), starts PKCE with a redirect to a
 * loopback port, and prints the authorize URL. `ferry auth` on the operator
 * machine reads the URL and forwards the port. The callback writes the token
 * file. The running gateway reads it at the next request.
 */

import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { auth } from "@modelcontextprotocol/client";
import { LoginOAuthProvider } from "./oauth.ts";
import { gatewayDir, readServers, readState, setLoginRequired, writePrivate } from "./store.ts";

/** The login stops after this time. `ferry auth` holds the port forward for 5 minutes. */
export const LOGIN_TIMEOUT_MS = 300_000;

export type LoginInput = {
  readonly home: string;
  readonly server: string;
  /** Prints a line of the login. */
  readonly print: (line: string) => void;
  readonly timeoutMs?: number;
};

export async function loginServer(input: LoginInput): Promise<void> {
  const server = readServers(input.home).find((candidate) => candidate.name === input.server);
  if (!server) throw new Error(`The MCP gateway has no server ${input.server}. Add it to ~/.ferry/mcp-gateway/servers.json.`);

  const state = randomBytes(16).toString("hex");
  let answer: (callback: { code: string; iss?: string }) => void = () => {};
  let fail: (error: Error) => void = () => {};
  const callback = new Promise<{ code: string; iss?: string }>((resolve, reject) => {
    answer = resolve;
    fail = reject;
  });
  // The login awaits the callback only after the redirect. A timeout before that must not be an unhandled rejection.
  callback.catch(() => {});
  const http = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(request) {
      const url = new URL(request.url);
      if (url.pathname !== "/callback") return new Response("Not found.", { status: 404 });
      if (url.searchParams.get("state") !== state) return new Response("The login state does not match.", { status: 400 });
      const code = url.searchParams.get("code");
      if (!code) {
        fail(new Error(`The authorization server refused the login of ${server.name}.`));
        return new Response("The login failed. Run ferry auth again.", { status: 400 });
      }
      answer({ code, iss: url.searchParams.get("iss") ?? undefined });
      return new Response("Ferry has the login. You can close this tab.");
    },
  });
  const timer = setTimeout(() => fail(new Error(`The login of ${server.name} did not finish in time.`)), input.timeoutMs ?? LOGIN_TIMEOUT_MS);
  try {
    const provider = new LoginOAuthProvider(`http://127.0.0.1:${http.port}/callback`, state, (url) =>
      input.print(`Open this URL to log in ${server.name}: ${url.toString()}`),
    );
    if ((await auth(provider, { serverUrl: server.url })) === "REDIRECT") {
      const { code, iss } = await callback;
      await auth(provider, { serverUrl: server.url, authorizationCode: code, iss });
    }
    const result = provider.result();
    if (!result.tokens) throw new Error(`The login of ${server.name} returned no token.`);
    writePrivate(join(gatewayDir(input.home), "tokens", `${server.name}.json`), JSON.stringify(result));
    setLoginRequired(input.home, server.name, false);
    input.print(`Logged in ${server.name}.`);
  } finally {
    clearTimeout(timer);
    await http.stop(true);
  }
}

export type GatewayList = {
  readonly gateway: { readonly state: "running" | "stopped"; readonly port: number | null };
  readonly servers: readonly { readonly name: string; readonly state: "ready" | "login-required" }[];
};

/** The state of the gateway and of each server. It has no URL, token, or key. */
export function listGateway(home: string): GatewayList {
  const state = readState(home);
  const running = state.pid !== undefined && isRunning(state.pid);
  const expired = new Set(state.loginRequired ?? []);
  return {
    gateway: { state: running ? "running" : "stopped", port: running ? (state.port ?? null) : null },
    servers: readServers(home).map(({ name }) => ({
      name,
      state: expired.has(name) || !existsSync(join(gatewayDir(home), "tokens", `${name}.json`)) ? "login-required" : "ready",
    })),
  };
}

/** One line for the gateway, then `<server> <state>` for each server. */
export function gatewayListLines(list: GatewayList): string[] {
  const gateway = list.gateway.port === null ? list.gateway.state : `${list.gateway.state} on 127.0.0.1:${list.gateway.port}`;
  return [`Gateway: ${gateway}`, ...list.servers.map((server) => `${server.name} ${server.state}`)];
}

function isRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}
