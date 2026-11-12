/**
 * The MCP gateway of a box: `ferry mcp serve`. It listens on 127.0.0.1 and
 * gives each server of `servers.json` the path `/mcp/<server>`. It is the
 * only OAuth client of each remote server on the box, and each harness on the
 * box connects to it with the client key.
 *
 * A shared stdio server runs as one process for all agents of the box. The
 * gateway is its only client. It sends empty client capabilities, and its own
 * JSON-RPC ids and progress tokens, so the ids of two agents cannot collide.
 * A cancel reaches the process when the harness closes its request. When the
 * process sends a request to the client, such as `roots/list`, the gateway
 * answers with an error and records `cannot-share` for the server. A process
 * that stopped starts again at the next call.
 *
 * The gateway never sends 401 to a harness, so a harness never starts its own
 * login. A request with no key, a wrong key, a wrong `Host`, or a wrong
 * `Origin` gets 403. When the login of a server expired, a tool call returns
 * `isError` with the command that fixes it, and the tool list is the last
 * good list, because Codex reads the list one time for each connection.
 *
 * The gateway forwards the tools of a server. It does not forward prompts or
 * resources.
 */

import { createHash, timingSafeEqual } from "node:crypto";
import { Client, OAuthError, ProtocolError, ProtocolErrorCode, StreamableHTTPClientTransport, UnauthorizedError } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { createMcpHandler, Server, type McpHttpHandler } from "@modelcontextprotocol/server";
import { VERSION } from "../version.ts";
import { GatewayOAuthProvider, LoginRequiredError } from "./oauth.ts";
import {
  clientKey,
  knownSecrets,
  readServers,
  readTokenFile,
  readToolCache,
  scrub,
  setCannotShare,
  setLoginRequired,
  tokenVersion,
  updateState,
  writeToolCache,
  type GatewayServer,
  type RemoteGatewayServer,
  type StdioGatewayServer,
} from "./store.ts";

export type GatewayInput = {
  readonly home: string;
  readonly port: number;
  /** The box name for the fix text of an expired login. Null when the box does not know its name. */
  readonly box: string | null;
  /** Receives a log line. Ferry takes each known secret and token out of it first. */
  readonly log: (line: string) => void;
};

export type RunningGateway = {
  readonly port: number;
  stop(): Promise<void>;
};

export function loginFixText(server: string, box: string | null): string {
  const target = box ? ` --box ${box}` : "";
  return `The login of ${server} on this box expired. On the operator machine, run \`ferry auth --mcp ${server}${target}\`.`;
}

/** Start the gateway. It writes its pid and port to `state.json` and makes the client key when there is none. */
export function startGateway(input: GatewayInput): RunningGateway {
  clientKey(input.home, true);
  const routes = new Map<string, { identity: string; upstream: Upstream; handler: McpHttpHandler }>();
  const log = (line: string, servers: readonly string[] = []) => input.log(scrub(line, knownSecrets(input.home, servers)));
  let port = input.port;

  const route = (server: GatewayServer) => {
    // A changed URL, command, argument, or env value gives a new connection.
    const identity = JSON.stringify(server);
    const known = routes.get(server.name);
    if (known?.identity === identity) return known;
    void known?.upstream.close();
    void known?.handler.close();
    const upstream =
      "url" in server ? new RemoteUpstream(input.home, server) : new StdioUpstream(input.home, server, (line) => log(`${server.name}: ${line}`, [server.name]));
    const handler = createMcpHandler(() => gatewayServer(input, server.name, upstream, log), {
      onerror: (error) => log(`${server.name}: ${error.message}`, [server.name]),
    });
    const created = { identity, upstream, handler };
    routes.set(server.name, created);
    return created;
  };

  const http = Bun.serve({
    hostname: "127.0.0.1",
    port: input.port,
    // A tool call can stream for longer than the default of 10 seconds.
    idleTimeout: 0,
    async fetch(request) {
      const refused = refusal(request, port, input.home);
      if (refused) {
        log(`Refused ${request.method} ${new URL(request.url).pathname}: ${refused}`);
        return forbidden(refused);
      }
      const name = /^\/mcp\/([^/]+)$/.exec(new URL(request.url).pathname)?.[1];
      let servers: GatewayServer[];
      try {
        servers = readServers(input.home);
      } catch (error) {
        log(`Cannot read servers.json: ${errorText(error)}`);
        return Response.json({ error: "servers.json is not valid" }, { status: 500 });
      }
      const server = servers.find((candidate) => candidate.name === name);
      if (!server) return Response.json({ error: "not found" }, { status: 404 });
      try {
        return await route(server).handler.fetch(request);
      } catch (error) {
        log(`${server.name}: ${errorText(error)}`, [server.name]);
        return Response.json({ error: "internal error" }, { status: 500 });
      }
    },
  });
  port = http.port ?? input.port;
  updateState(input.home, (state) => ({ ...state, pid: process.pid, port }));
  log(`Ferry MCP gateway on 127.0.0.1:${port}`);
  return {
    port,
    async stop() {
      await http.stop(true);
      for (const { upstream, handler } of routes.values()) {
        await upstream.close();
        await handler.close();
      }
      updateState(input.home, ({ pid: _pid, ...state }) => state);
    },
  };
}

/** The MCP server that answers one request of a harness. */
function gatewayServer(
  input: GatewayInput,
  name: string,
  upstream: Upstream,
  log: (line: string, servers?: readonly string[]) => void,
): Server {
  const server = new Server({ name: `ferry-mcp-gateway/${name}`, version: VERSION }, { capabilities: { tools: {} } });
  // A tool result comes from the remote server. It must not carry a token or the client key.
  const clean = <T>(value: T): T => JSON.parse(scrub(JSON.stringify(value), knownSecrets(input.home, [name]))) as T;
  server.setRequestHandler("tools/list", async (request) => {
    try {
      const result = await upstream.use((client) => client.listTools(request.params));
      if (!request.params?.cursor) writeToolCache(input.home, name, { tools: result.tools });
      return clean(result);
    } catch (error) {
      if (!(error instanceof LoginRequiredError)) log(`${name}: tools/list failed: ${errorText(error)}`, [name]);
      const cache = request.params?.cursor ? null : readToolCache(input.home, name);
      return clean({ tools: (cache?.tools ?? []) as never[] });
    }
  });
  server.setRequestHandler("tools/call", async (request, ctx) => {
    // The gateway gives the call its own progress token, and maps each progress notice back to the token of the harness.
    const { progressToken, ...meta } = request.params._meta ?? {};
    const params = { ...request.params, _meta: meta };
    const onprogress =
      progressToken === undefined
        ? undefined
        : (progress: object) => void ctx.mcpReq.notify({ method: "notifications/progress", params: { ...clean(progress), progressToken } }).catch(() => {});
    try {
      return clean(await upstream.use((client) => client.callTool(params, { signal: ctx.mcpReq.signal, ...(onprogress ? { onprogress } : {}) })));
    } catch (error) {
      if (error instanceof LoginRequiredError) {
        return { isError: true, content: [{ type: "text", text: loginFixText(name, input.box) }] };
      }
      log(`${name}: tools/call failed: ${errorText(error)}`, [name]);
      return {
        isError: true,
        content: [{ type: "text", text: `The MCP gateway on this box cannot reach ${name}. Try again later.` }],
      };
    }
  });
  return server;
}

/** The connection of the gateway to one server. */
type Upstream = {
  use<T>(run: (client: Client) => Promise<T>): Promise<T>;
  close(): Promise<void>;
};

/**
 * The connection of the gateway to one remote server. The SDK refreshes an
 * expired access token on a 401. When the refresh fails, the gateway records
 * `login-required` and does not call the server again until the token file changes.
 */
class RemoteUpstream implements Upstream {
  private client: Promise<Client> | null = null;
  /** The token of the last failed login, so that the gateway does not retry the same token. */
  private failedToken: string | null = null;
  private marked = false;

  constructor(
    private readonly home: string,
    private readonly server: RemoteGatewayServer,
  ) {}

  async use<T>(run: (client: Client) => Promise<T>): Promise<T> {
    const { name } = this.server;
    const file = readTokenFile(this.home, name);
    const token = tokenVersion(this.home, name);
    if (!file?.clientInformation || token === null || token === this.failedToken) {
      this.mark(true);
      throw new LoginRequiredError(name);
    }
    try {
      const result = await run(await this.connect());
      this.mark(false);
      return result;
    } catch (error) {
      await this.close();
      if (!isLoginFailure(error)) throw error;
      this.failedToken = tokenVersion(this.home, name);
      this.mark(true);
      throw new LoginRequiredError(name);
    }
  }

  private connect(): Promise<Client> {
    if (!this.client) {
      const client = new Client({ name: "ferry-mcp-gateway", version: VERSION });
      const transport = new StreamableHTTPClientTransport(new URL(this.server.url), {
        authProvider: new GatewayOAuthProvider(this.home, this.server.name),
      });
      this.client = client.connect(transport).then(() => client);
      this.client.catch(() => {
        this.client = null;
      });
    }
    return this.client;
  }

  async close(): Promise<void> {
    const client = this.client;
    this.client = null;
    await client?.then((connected) => connected.close()).catch(() => {});
  }

  /** Write `login-required` to `state.json` when it changes. */
  private mark(required: boolean): void {
    if (this.marked === required) return;
    this.marked = required;
    setLoginRequired(this.home, this.server.name, required);
  }
}

/**
 * The one process of a shared stdio server, for all agents of the box. The
 * process gets the `env` of `servers.json` and the working directory of the
 * gateway. Its stderr goes to the log of the gateway, without secrets.
 */
class StdioUpstream implements Upstream {
  private client: Promise<Client> | null = null;

  constructor(
    private readonly home: string,
    private readonly server: StdioGatewayServer,
    private readonly log: (line: string) => void,
  ) {}

  async use<T>(run: (client: Client) => Promise<T>): Promise<T> {
    return run(await this.connect());
  }

  private connect(): Promise<Client> {
    if (this.client) return this.client;
    // Empty capabilities: the gateway cannot answer roots, sampling, or elicitation for one agent.
    const client = new Client({ name: "ferry-mcp-gateway", version: VERSION }, { capabilities: {} });
    client.fallbackRequestHandler = async (request) => {
      setCannotShare(this.home, this.server.name);
      this.log(`sent ${request.method} to the client. The gateway cannot share this server. Remove it from mcp_gateway_shared.`);
      throw new ProtocolError(ProtocolErrorCode.MethodNotFound, `The Ferry MCP gateway shares this server between agents and cannot answer ${request.method}.`);
    };
    const transport = new StdioClientTransport({
      command: this.server.command,
      args: [...this.server.args],
      env: { ...this.server.env },
      stderr: "pipe",
    });
    transport.stderr?.on("data", (chunk: Buffer) => {
      for (const line of chunk.toString("utf8").split("\n")) if (line.trim() !== "") this.log(line);
    });
    const connected = client.connect(transport).then(() => client);
    this.client = connected;
    // A process that stops starts again at the next call.
    client.onclose = () => {
      if (this.client === connected) this.client = null;
    };
    connected.catch(() => {
      if (this.client === connected) this.client = null;
    });
    return connected;
  }

  async close(): Promise<void> {
    const client = this.client;
    this.client = null;
    await client?.then((connected) => connected.close()).catch(() => {});
  }
}

/** The OAuth errors of a refresh that only a new login fixes. */
const LOGIN_ERRORS = new Set(["invalid_grant", "invalid_client", "unauthorized_client", "invalid_token"]);

function isLoginFailure(error: unknown): boolean {
  for (let current = error; current; current = (current as { cause?: unknown }).cause) {
    if (current instanceof LoginRequiredError || UnauthorizedError.isInstance(current)) return true;
    if (OAuthError.isInstance(current) && LOGIN_ERRORS.has(current.code)) return true;
  }
  return false;
}

/** The reason to refuse a request, or null. */
function refusal(request: Request, port: number, home: string): string | null {
  const hosts = [`127.0.0.1:${port}`, `localhost:${port}`];
  if (!hosts.includes(request.headers.get("host") ?? "")) return "wrong Host header";
  const origin = request.headers.get("origin");
  if (origin !== null && !hosts.some((host) => origin === `http://${host}`)) return "wrong Origin header";
  const key = clientKey(home);
  const given = request.headers.get("authorization") ?? "";
  if (!key || !sameText(given, `Bearer ${key}`)) return "no client key or a wrong client key";
  return null;
}

function sameText(a: string, b: string): boolean {
  const digest = (text: string) => createHash("sha256").update(text).digest();
  return timingSafeEqual(digest(a), digest(b));
}

/** The gateway sends 403, never 401: a 401 starts the OAuth flow of the harness. */
function forbidden(reason: string): Response {
  return Response.json({ error: "forbidden", message: `The Ferry MCP gateway refused the request: ${reason}.` }, { status: 403 });
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
