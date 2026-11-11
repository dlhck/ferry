/**
 * A test OAuth server and a test MCP server in one process on 127.0.0.1.
 * The MCP server at /mcp needs a bearer token from the OAuth server, and
 * answers 401 for a missing or expired token, as a real remote server does.
 */

import { createHash, randomBytes } from "node:crypto";
import { createMcpHandler, Server } from "@modelcontextprotocol/server";

export type TestOAuthServer = {
  readonly url: string;
  readonly mcpUrl: string;
  /** Each access token, refresh token, and client secret that the server gave out. */
  readonly secrets: string[];
  /** The tokens that the MCP server saw. */
  readonly used: string[];
  /** Expire each access token that the server gave out. */
  expireAccessTokens(): void;
  /** When true, a refresh fails with invalid_grant. */
  refreshFails: boolean;
  refreshes: number;
  /** A tool result that has this text in it. */
  echoSuffix: string;
  /** Follow the authorize URL like a browser: get the redirect to the callback and open it. */
  approve(authorizeUrl: string): Promise<Response>;
  stop(): Promise<void>;
};

export function startTestOAuthServer(): TestOAuthServer {
  const access = new Map<string, { expired: boolean }>();
  const refresh = new Set<string>();
  const codes = new Map<string, { challenge: string; redirect: string; client: string }>();
  const clients = new Map<string, { redirect_uris: string[] }>();
  const token = (kind: string) => `${kind}-${randomBytes(12).toString("hex")}`;

  const mcp = createMcpHandler(() => {
    const server = new Server({ name: "test-remote", version: "1.0.0" }, { capabilities: { tools: {} } });
    server.setRequestHandler("tools/list", async () => ({
      tools: [{ name: "echo", description: "Echo a text", inputSchema: { type: "object", properties: { text: { type: "string" } } } }],
    }));
    server.setRequestHandler("tools/call", async (request) => ({
      content: [{ type: "text", text: `echo ${String(request.params.arguments?.text)}${fixture.echoSuffix}` }],
    }));
    return server;
  });

  const http = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request): Promise<Response> {
      const url = new URL(request.url);
      const base: string = `http://127.0.0.1:${http.port}`;
      if (url.pathname.startsWith("/.well-known/oauth-protected-resource")) {
        return Response.json({ resource: `${base}/mcp`, authorization_servers: [base] });
      }
      if (url.pathname === "/.well-known/oauth-authorization-server") {
        return Response.json({
          issuer: base,
          authorization_endpoint: `${base}/authorize`,
          token_endpoint: `${base}/token`,
          registration_endpoint: `${base}/register`,
          response_types_supported: ["code"],
          grant_types_supported: ["authorization_code", "refresh_token"],
          code_challenge_methods_supported: ["S256"],
          token_endpoint_auth_methods_supported: ["none"],
        });
      }
      if (url.pathname === "/register" && request.method === "POST") {
        const body = (await request.json()) as { redirect_uris: string[] };
        const id = `client-${clients.size + 1}`;
        clients.set(id, body);
        return Response.json({ ...body, client_id: id, token_endpoint_auth_method: "none" }, { status: 201 });
      }
      if (url.pathname === "/authorize") {
        const client = url.searchParams.get("client_id") ?? "";
        const redirect = url.searchParams.get("redirect_uri") ?? "";
        if (!clients.get(client)?.redirect_uris.includes(redirect)) return new Response("bad redirect", { status: 400 });
        const code = token("code");
        codes.set(code, { challenge: url.searchParams.get("code_challenge") ?? "", redirect, client });
        const target = new URL(redirect);
        target.searchParams.set("code", code);
        target.searchParams.set("state", url.searchParams.get("state") ?? "");
        return Response.redirect(target.toString(), 302);
      }
      if (url.pathname === "/token" && request.method === "POST") {
        const form = new URLSearchParams(await request.text());
        if (form.get("grant_type") === "authorization_code") {
          const entry = codes.get(form.get("code") ?? "");
          const verifier = form.get("code_verifier") ?? "";
          const challenge = createHash("sha256").update(verifier).digest("base64url");
          if (!entry || entry.challenge !== challenge || entry.redirect !== form.get("redirect_uri")) {
            return Response.json({ error: "invalid_grant" }, { status: 400 });
          }
          codes.delete(form.get("code") ?? "");
          return Response.json(issue());
        }
        if (form.get("grant_type") === "refresh_token") {
          fixture.refreshes += 1;
          const old = form.get("refresh_token") ?? "";
          if (fixture.refreshFails || !refresh.has(old)) return Response.json({ error: "invalid_grant" }, { status: 400 });
          refresh.delete(old);
          return Response.json(issue());
        }
        return Response.json({ error: "unsupported_grant_type" }, { status: 400 });
      }
      if (url.pathname === "/mcp") {
        const bearer = /^Bearer (.+)$/.exec(request.headers.get("authorization") ?? "")?.[1] ?? "";
        const entry = access.get(bearer);
        if (!entry || entry.expired) {
          return new Response("unauthorized", {
            status: 401,
            headers: { "www-authenticate": `Bearer resource_metadata="${base}/.well-known/oauth-protected-resource/mcp"` },
          });
        }
        fixture.used.push(bearer);
        return mcp.fetch(request);
      }
      return new Response("not found", { status: 404 });
    },
  });

  const issue = () => {
    const accessToken = token("access");
    const refreshToken = token("refresh");
    access.set(accessToken, { expired: false });
    refresh.add(refreshToken);
    fixture.secrets.push(accessToken, refreshToken);
    return { access_token: accessToken, refresh_token: refreshToken, token_type: "Bearer", expires_in: 3600 };
  };

  const fixture: TestOAuthServer = {
    url: `http://127.0.0.1:${http.port}`,
    mcpUrl: `http://127.0.0.1:${http.port}/mcp`,
    secrets: [],
    used: [],
    refreshFails: false,
    refreshes: 0,
    echoSuffix: "",
    expireAccessTokens() {
      for (const entry of access.values()) entry.expired = true;
    },
    async approve(authorizeUrl) {
      const redirect = await fetch(authorizeUrl, { redirect: "manual" });
      return fetch(redirect.headers.get("location") ?? "");
    },
    async stop() {
      await mcp.close();
      await http.stop(true);
    },
  };
  return fixture;
}
