import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { runCli } from "../src/cli.ts";
import { startGateway, type RunningGateway } from "../src/mcp-gateway/gateway.ts";
import { listGateway, loginServer } from "../src/mcp-gateway/login.ts";
import { startTestOAuthServer, type TestOAuthServer } from "./mcp-oauth-server.ts";

let home: string;
let remote: TestOAuthServer;
let gateway: RunningGateway | null;
/** Each line that Ferry printed or logged, and each tool result, for the check that no secret leaves the gateway. */
let output: string[];

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), "ferry-mcp-gateway-"));
  remote = startTestOAuthServer();
  gateway = null;
  output = [];
  await mkdir(join(home, ".ferry/mcp-gateway"), { recursive: true });
  await writeFile(join(home, ".ferry/mcp-gateway/servers.json"), JSON.stringify({ servers: { remote: { url: remote.mcpUrl } } }));
});

afterEach(async () => {
  await gateway?.stop();
  await remote.stop();
  // Each test proves that no token and no client key is in an output, a log, an error, or a tool result.
  const key = await readFile(join(home, ".ferry/mcp-gateway/client-key"), "utf8").catch(() => "");
  for (const secret of [...remote.secrets, key.trim()].filter(Boolean)) {
    for (const line of output) expect(line).not.toContain(secret);
  }
  await rm(home, { recursive: true, force: true });
});

async function login(): Promise<string> {
  let authorizeUrl = "";
  const done = loginServer({
    home,
    server: "remote",
    print: (line) => {
      output.push(line);
      const url = /https?:\/\/\S+/.exec(line)?.[0];
      if (line.startsWith("Open this URL") && url) authorizeUrl = url;
    },
  });
  while (!authorizeUrl) await Bun.sleep(5);
  const page = await remote.approve(authorizeUrl);
  output.push(await page.text());
  await done;
  return authorizeUrl;
}

function serve(): RunningGateway {
  gateway = startGateway({ home, port: 0, box: "dev", log: (line) => output.push(line) });
  return gateway;
}

async function key(): Promise<string> {
  return (await readFile(join(home, ".ferry/mcp-gateway/client-key"), "utf8")).trim();
}

async function connect(running: RunningGateway): Promise<Client> {
  const client = new Client({ name: "harness", version: "1.0.0" });
  await client.connect(
    new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${running.port}/mcp/remote`), {
      requestInit: { headers: { Authorization: `Bearer ${await key()}` } },
    }),
  );
  return client;
}

async function call(client: Client, text: string) {
  const result = await client.callTool({ name: "echo", arguments: { text } });
  output.push(JSON.stringify(result));
  return result;
}

async function list(): Promise<{ gateway: { state: string }; servers: { name: string; state: string }[] }> {
  const lines: string[] = [];
  await runCli(["--json", "mcp", "list"], { isBoxMode: () => true, home: () => home, writeLine: (line) => lines.push(line) });
  output.push(...lines);
  return JSON.parse(lines[0] ?? "{}").result;
}

describe("ferry mcp login", () => {
  test("prints an authorize URL with a loopback redirect_uri, and the callback writes a 0600 token file", async () => {
    const authorizeUrl = await login();

    const redirect = new URL(new URL(authorizeUrl).searchParams.get("redirect_uri") ?? "");
    expect(redirect.protocol).toBe("http:");
    expect(redirect.hostname).toBe("127.0.0.1");
    expect(Number(redirect.port)).toBeGreaterThan(0);
    expect(new URL(authorizeUrl).searchParams.get("code_challenge_method")).toBe("S256");
    const file = join(home, ".ferry/mcp-gateway/tokens/remote.json");
    expect((await stat(file)).mode & 0o777).toBe(0o600);
    expect(JSON.parse(await readFile(file, "utf8")).tokens.access_token).toBe(remote.secrets[0]);
    expect(output).toContain("Logged in remote.");
    expect((await list()).servers).toEqual([{ name: "remote", state: "ready" }]);
  });

  test("a server that is not in servers.json fails with a clear error", async () => {
    const errors: string[] = [];
    await runCli(["mcp", "login", "other"], { isBoxMode: () => true, home: () => home }, { renderError: (line) => errors.push(line), setExitCode: () => {} });
    output.push(...errors);
    expect(errors).toEqual(["The MCP gateway has no server other. Add it to ~/.ferry/mcp-gateway/servers.json."]);
  });
});

describe("ferry mcp serve", () => {
  test("forwards a tool call with the gateway token, and makes a 0600 client key", async () => {
    await login();
    const running = serve();
    expect((await stat(join(home, ".ferry/mcp-gateway/client-key"))).mode & 0o777).toBe(0o600);
    const client = await connect(running);

    expect((await client.listTools()).tools.map((tool) => tool.name)).toEqual(["echo"]);
    expect((await call(client, "hi")).content).toEqual([{ type: "text", text: "echo hi" }]);
    expect(remote.used.every((token) => token === remote.secrets[0])).toBe(true);
    expect((await list()).gateway.state).toBe("running");
    await client.close();
  });

  test("refreshes an expired access token", async () => {
    await login();
    const client = await connect(serve());
    await call(client, "one");
    remote.expireAccessTokens();

    expect((await call(client, "two")).content).toEqual([{ type: "text", text: "echo two" }]);
    expect(remote.refreshes).toBe(1);
    expect((await list()).servers).toEqual([{ name: "remote", state: "ready" }]);
    await client.close();
  });

  test("a failed refresh gives login-required, a tool error with the fix, and the last good tool list", async () => {
    await login();
    const client = await connect(serve());
    await client.listTools();
    remote.expireAccessTokens();
    remote.refreshFails = true;

    const result = await call(client, "two");
    expect(result.isError).toBe(true);
    expect(result.content).toEqual([
      {
        type: "text",
        text: "The login of remote on this box expired. On the operator machine, run `ferry auth --mcp remote --box dev`.",
      },
    ]);
    expect((await list()).servers).toEqual([{ name: "remote", state: "login-required" }]);
    expect((await client.listTools()).tools.map((tool) => tool.name)).toEqual(["echo"]);
    // The gateway does not ask the remote server again with the same failed token.
    const refreshes = remote.refreshes;
    await call(client, "three");
    expect(remote.refreshes).toBe(refreshes);
    await client.close();
  });

  test("uses a new login with no restart", async () => {
    await login();
    const client = await connect(serve());
    remote.expireAccessTokens();
    remote.refreshFails = true;
    expect((await call(client, "one")).isError).toBe(true);

    remote.refreshFails = false;
    await login();

    expect((await call(client, "two")).content).toEqual([{ type: "text", text: "echo two" }]);
    expect(remote.used.at(-1)).toBe(remote.secrets.at(-2));
    expect((await list()).servers).toEqual([{ name: "remote", state: "ready" }]);
    await client.close();
  });

  test("a server with no login gives the fix text, not a 401", async () => {
    const running = serve();
    const response = await post(running, await key(), { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "echo", arguments: {} } });
    const text = await response.text();
    output.push(text);

    expect(response.status).toBe(200);
    expect(text).toContain("The login of remote on this box expired.");
  });

  test("refuses a request with no key, a wrong key, a wrong Origin, or a wrong Host with 403, never 401", async () => {
    await login();
    const running = serve();
    const body = { jsonrpc: "2.0", id: 1, method: "tools/list", params: {} };
    const good = await key();
    const cases: [string | null, Record<string, string>][] = [
      [null, {}],
      ["wrong-key-0000000000", {}],
      [good, { Origin: "http://evil.example" }],
      [good, { Origin: "http://localhost:1" }],
      [good, { Host: "evil.example" }],
    ];
    for (const [given, headers] of cases) {
      const response = await post(running, given, body, headers);
      const text = await response.text();
      output.push(text);
      expect(response.status).toBe(403);
      expect(text).not.toContain("echo");
    }
    expect((await post(running, good, body, { Origin: `http://127.0.0.1:${running.port}` })).status).toBe(200);
  });

  test("takes a token and the client key out of a tool result and a log line", async () => {
    await login();
    const client = await connect(serve());
    remote.echoSuffix = ` ${remote.secrets[0]} ${await key()}`;

    expect((await call(client, "hi")).content).toEqual([{ type: "text", text: "echo hi [token] [token]" }]);
    await client.close();
  });

  test("a token file that is not valid JSON gives a tool error, and no text of the file is in the log", async () => {
    await login();
    const client = await connect(serve());
    await writeFile(join(home, ".ferry/mcp-gateway/tokens/remote.json"), '{"tokens":{"access_token":"broken-file-secret');
    remote.secrets.push("broken-file-secret");

    expect((await call(client, "hi")).isError).toBe(true);
    expect(output.some((line) => line.includes("tokens/remote.json is not valid JSON."))).toBe(true);
    await client.close();
  });

  test("a remote server that does not answer gives a tool error with no secret", async () => {
    await login();
    const client = await connect(serve());
    await remote.stop();

    const result = await call(client, "hi");
    expect(result.isError).toBe(true);
    expect(result.content).toEqual([{ type: "text", text: "The MCP gateway on this box cannot reach remote. Try again later." }]);
    expect(output.some((line) => line.includes("tools/call failed"))).toBe(true);
    await client.close();
    remote = startTestOAuthServer();
  });
});

describe("ferry mcp list", () => {
  test("shows each server with no login as login-required, and a stopped gateway", async () => {
    const lines: string[] = [];
    await runCli(["mcp", "list"], { isBoxMode: () => true, home: () => home, writeLine: (line) => lines.push(line) });

    expect(lines).toEqual(["Gateway: stopped", "remote login-required"]);
    expect(listGateway(home)).toEqual({ gateway: { state: "stopped", port: null }, servers: [{ name: "remote", state: "login-required" }] });
  });
});

function post(running: RunningGateway, key: string | null, body: unknown, headers: Record<string, string> = {}): Promise<Response> {
  return fetch(`http://127.0.0.1:${running.port}/mcp/remote`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      "mcp-protocol-version": "2025-06-18",
      ...(key ? { authorization: `Bearer ${key}` } : {}),
      ...headers,
    },
    body: JSON.stringify(body),
  });
}
