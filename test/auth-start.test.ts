import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AuthStart, loopbackLoginUrl, mcpLoginCommand, type AuthLink } from "../src/auth-start.ts";
import { mcpCommand } from "../src/box-mcp.ts";
import type { ForwardOptions, LinkResult, RunOptions } from "../src/link.ts";
import { BUILTIN_TOOLS } from "../src/registry/builtin.ts";

type RunCall = {
  readonly command: string;
  readonly options: RunOptions | undefined;
};

class FakeLink implements AuthLink {
  readonly runs: RunCall[] = [];
  readonly forwards: ForwardOptions[] = [];

  constructor(
    private readonly runResults: LinkResult[] = [],
    private readonly forwardResults: LinkResult[] = [],
  ) {}

  async run(command: string, options?: RunOptions): Promise<LinkResult> {
    this.runs.push({ command, options });
    const result = this.runResults.shift();
    if (!result) throw new Error(`unexpected run: ${command}`);
    return result;
  }

  async forward(options: ForwardOptions): Promise<LinkResult> {
    this.forwards.push(options);
    const result = this.forwardResults.shift();
    if (!result) throw new Error(`unexpected forward: ${JSON.stringify(options)}`);
    return result;
  }
}

function success(stdout = ""): LinkResult {
  return { ok: true, address: "build-box.example.ts.net", stdout, stderr: "" };
}

function loggedOut(): LinkResult {
  return {
    ok: false,
    error: { code: "command-failed", origin: "box", message: "not logged in" },
  };
}

const providerCases: readonly {
  readonly provider: string;
  readonly probe: RegExp;
  readonly login: RegExp;
  readonly output: string;
  readonly action: "device-url" | "printed-url";
}[] = [
  {
    provider: "gh",
    probe: /^gh auth status --hostname github\.com$/,
    login: /^gh auth login .*--hostname github\.com.*--web/,
    output: "First copy your one-time code: A1B2-C3D4\nOpen https://github.com/login/device\n",
    action: "device-url",
  },
  {
    provider: "claude",
    probe: /^claude auth status$/,
    login: /^claude auth login$/,
    output: "Open https://claude.ai/oauth/authorize?state=opaque in your browser\n",
    action: "printed-url",
  },
  {
    provider: "codex",
    probe: /^codex login status$/,
    login: /^codex login --device-auth$/,
    output: "Open https://auth.openai.com/codex/device and enter ABCD-EFGH\n",
    action: "device-url",
  },
  {
    provider: "cursor",
    probe: /^cursor-agent status$/,
    login: /^cursor-agent login$/,
    output: "Open https://cursor.com/auth/cli?state=opaque in your browser\n",
    action: "printed-url",
  },
];

describe("AuthStart", () => {
  test("reports every provider without starting a login", async () => {
    const link = new FakeLink([success(), loggedOut(), loggedOut(), success()]);

    const result = await new AuthStart(link, BUILTIN_TOOLS).status();

    expect(result).toEqual({
      providers: [
        { provider: "gh", status: "authenticated" },
        { provider: "claude", status: "login-required" },
        { provider: "codex", status: "login-required" },
        { provider: "cursor", status: "authenticated" },
        {
          provider: "pi",
          status: "manual",
          instruction: "SSH to the box, run pi, then use /login in its interactive session.",
        },
      ],
    });
    expect(link.runs.map((call) => call.command)).toEqual([
      "gh auth status --hostname github.com",
      "claude auth status",
      "codex login status",
      "cursor-agent status",
    ]);
    expect(link.forwards).toHaveLength(0);
  });

  test("starts each documented provider with its remote command recipe", async () => {
    expect(new AuthStart(new FakeLink(), BUILTIN_TOOLS).startableProviders()).toEqual([
      "gh",
      "claude",
      "codex",
      "cursor",
    ]);

    for (const providerCase of providerCases) {
      const link = new FakeLink([loggedOut(), success(providerCase.output)]);

      const result = await new AuthStart(link, BUILTIN_TOOLS).start(providerCase.provider);

      expect(link.runs).toHaveLength(2);
      expect(link.runs[0]?.command).toMatch(providerCase.probe);
      expect(link.runs[1]?.command).toMatch(providerCase.login);
      expect(result.kind).toBe(providerCase.action);
    }
  });

  test("returns already-done without starting another login", async () => {
    const link = new FakeLink([success()]);

    const result = await new AuthStart(link, BUILTIN_TOOLS).start("gh");

    expect(result).toEqual({ kind: "already-done", provider: "gh" });
    expect(link.runs).toHaveLength(1);
    expect(link.forwards).toHaveLength(0);
  });

  test("refuses compatibility credential input before any Link call", async () => {
    const link = new FakeLink();
    const startWithLegacyInput = new AuthStart(link, BUILTIN_TOOLS).start as unknown as (
      provider: string,
      input: unknown,
    ) => Promise<unknown>;

    const result = await startWithLegacyInput("claude", {
      credentialPath: "/Users/operator/.claude/.credentials.json",
      bytes: new Uint8Array([1, 2, 3]),
    });

    expect(result).toEqual({
      kind: "refused",
      code: "credential-input",
      message: "AuthStart accepts only a provider. Logins are not copied.",
    });
    expect(link.runs).toHaveLength(0);
    expect(link.forwards).toHaveLength(0);
  });

  test("does not expose token-like command output", async () => {
    const token = "sk-test-secret-value";
    const link = new FakeLink([
      loggedOut(),
      success(`Open https://cursor.com/auth/cli?state=opaque\nAccess token: ${token}\n`),
    ]);

    const result = await new AuthStart(link, BUILTIN_TOOLS).start("cursor");

    expect(result).toEqual({
      kind: "printed-url",
      provider: "cursor",
      url: "https://cursor.com/auth/cli?state=opaque",
    });
    expect(JSON.stringify(result)).not.toContain(token);
  });

  test("preserves a Link forward-timeout on the Codex callback fallback", async () => {
    const timeout: LinkResult = {
      ok: false,
      error: {
        code: "forward-timeout",
        origin: "network",
        message: "the port forward timed out after 120000 ms",
      },
    };
    const link = new FakeLink(
      [
        loggedOut(),
        loggedOut(),
        success(
          "Starting local login server on http://localhost:1455.\nOpen https://auth.openai.com/oauth/authorize?state=opaque\n",
        ),
      ],
      [timeout],
    );

    const result = await new AuthStart(link, BUILTIN_TOOLS).start("codex");

    expect(link.runs.map((call) => call.command)).toEqual([
      "codex login status",
      "codex login --device-auth",
      "codex login",
    ]);
    expect(link.forwards).toEqual([
      { localPort: 1455, remotePort: 1455, remoteHost: "127.0.0.1", timeoutMs: 120_000 },
    ]);
    expect(result).toEqual({ kind: "link-failure", provider: "codex", result: timeout });
  });

  test("returns manual SSH guidance for Pi without starting an interactive TTY", async () => {
    const link = new FakeLink();

    const result = await new AuthStart(link, BUILTIN_TOOLS).start("pi");

    expect(result).toEqual({
      kind: "manual-ssh",
      provider: "pi",
      command: "pi",
      instruction: "SSH to the box, run pi, then use /login in its interactive session.",
    });
    expect(link.runs).toHaveLength(0);
    expect(link.forwards).toHaveLength(0);
  });
});

const AUTHORIZE_URL =
  "https://auth.example/authorize?client_id=c&redirect_uri=http%3A%2F%2Flocalhost%3A3118%2Fcallback&state=s";

/** Claude prints the URL inside an OSC 8 hyperlink and ends lines with CR LF. */
const CLAUDE_LOGIN_OUTPUT = `Visit this URL to authorize:\r\n  \x1b]8;;${AUTHORIZE_URL}\x07${AUTHORIZE_URL}\x1b]8;;\x07\r\nOr paste the redirect URL here: `;

const MCP_LISTS: Record<string, string> = {
  claude: [
    "Checking MCP server health…",
    "",
    "linear: https://mcp.linear.app/mcp (HTTP) - ! Needs authentication",
    "docs: https://docs.example/mcp (HTTP) - ✓ Connected",
  ].join("\n"),
  codex: [
    "Name    Url                         Bearer Token Env Var  Status   Auth",
    "linear  https://mcp.linear.app/mcp  -                     enabled  Not logged in",
    "docs    https://docs.example/mcp    -                     enabled  Unsupported",
  ].join("\n"),
  cursor: "linear: requires_authentication\ndocs: ready\n",
};

describe("AuthStart MCP logins", () => {
  test("lists the MCP servers that need a login for each tool with MCP support", async () => {
    const link = new FakeLink([success(MCP_LISTS.claude), success(MCP_LISTS.codex), success(MCP_LISTS.cursor)]);

    const statuses = await new AuthStart(link, BUILTIN_TOOLS).mcpStatus();

    expect(statuses).toEqual([
      { tool: "claude", loginRequired: ["linear"] },
      { tool: "codex", loginRequired: ["linear"] },
      { tool: "cursor", loginRequired: ["linear"] },
    ]);
    expect(link.runs.map((call) => call.command)).toEqual([
      "command -v claude >/dev/null 2>&1 || exit 0; claude mcp list 2>/dev/null || true",
      "command -v codex >/dev/null 2>&1 || exit 0; codex mcp list 2>/dev/null || true",
      "command -v cursor-agent >/dev/null 2>&1 || exit 0; cursor-agent mcp list 2>/dev/null || true",
    ]);
  });

  test("reports a tool whose list the box could not run", async () => {
    const failure: LinkResult = { ok: false, error: { code: "command-timeout", origin: "box", message: "raw" } };
    const link = new FakeLink([failure, success(""), success("")]);

    const statuses = await new AuthStart(link, BUILTIN_TOOLS).mcpStatus();

    expect(statuses[0]).toEqual({
      tool: "claude",
      error: {
        code: "command-timeout",
        origin: "box",
        message: "AuthStart stopped because Link reported command-timeout from box.",
      },
    });
  });

  test("starts the login detached on the box and returns the URL and callback port without a forward", async () => {
    const link = new FakeLink([success(CLAUDE_LOGIN_OUTPUT)]);

    const result = await new AuthStart(link, BUILTIN_TOOLS).startMcp("claude", "linear");

    expect(result).toEqual({
      kind: "local-port-forward",
      provider: "claude/linear",
      url: AUTHORIZE_URL,
      localPort: 3118,
      remotePort: 3118,
      timeoutMs: 300_000,
    });
    expect(link.runs[0]!.command).toBe(
      mcpLoginCommand(mcpCommand("claude mcp login {name} --no-browser", { name: "linear" }), 330),
    );
    expect(link.runs[0]!.command).toContain("setsid nohup");
    expect(link.runs[0]!.command).toContain("script -qfec");
    expect(link.forwards).toEqual([]);
  });

  test("refuses a server name with shell metacharacters before it runs anything", async () => {
    const link = new FakeLink();

    const result = await new AuthStart(link, BUILTIN_TOOLS).startMcp("claude", "x';touch pwned;'");

    expect(result).toMatchObject({ kind: "refused", code: "invalid-server" });
    expect(link.runs).toEqual([]);
  });

  test("refuses a tool without MCP support and extra credential input", async () => {
    const auth = new AuthStart(new FakeLink(), BUILTIN_TOOLS);

    expect(await auth.startMcp("gh", "linear")).toMatchObject({ kind: "refused", code: "invalid-provider" });
    expect(await (auth.startMcp as (...args: string[]) => Promise<unknown>)("claude", "linear", "token")).toMatchObject({
      kind: "refused",
      code: "credential-input",
    });
  });

  test("fails when the login prints no URL with a loopback callback", async () => {
    const other = "Open https://auth.example/authorize?redirect_uri=https%3A%2F%2Fevil.example%2Fcb";
    const link = new FakeLink([success(other)]);

    const result = await new AuthStart(link, BUILTIN_TOOLS).startMcp("codex", "linear");

    expect(result).toMatchObject({ kind: "failed", provider: "codex/linear", code: "login-output" });
    expect(link.forwards).toEqual([]);
  });

  test("forwards the callback port until the timeout, then reports the login", async () => {
    const timeout: LinkResult = { ok: false, error: { code: "forward-timeout", origin: "network", message: "t" } };
    const link = new FakeLink([success("docs: https://docs.example/mcp (HTTP) - ✓ Connected\n"), success(""), success("")], [timeout]);
    const auth = new AuthStart(link, BUILTIN_TOOLS);

    const result = await auth.finishMcp({
      kind: "local-port-forward",
      provider: "claude/linear",
      url: AUTHORIZE_URL,
      localPort: 3118,
      remotePort: 3118,
      timeoutMs: 300_000,
    });

    expect(link.forwards).toEqual([{ localPort: 3118, remotePort: 3118, remoteHost: "127.0.0.1", timeoutMs: 300_000 }]);
    expect(result).toEqual({ kind: "logged-in", provider: "claude/linear" });
  });

  test("reports a login that did not finish, and a forward that failed", async () => {
    const started = {
      kind: "local-port-forward",
      provider: "claude/linear",
      url: AUTHORIZE_URL,
      localPort: 3118,
      remotePort: 3118,
      timeoutMs: 300_000,
    } as const;
    const timeout: LinkResult = { ok: false, error: { code: "forward-timeout", origin: "network", message: "t" } };
    const busy: LinkResult = { ok: false, error: { code: "forward-failed", origin: "network", message: "port in use" } };

    const pending = new FakeLink([success(MCP_LISTS.claude), success(""), success("")], [timeout]);
    expect(await new AuthStart(pending, BUILTIN_TOOLS).finishMcp(started)).toMatchObject({ kind: "failed", code: "login-output" });

    const failed = new FakeLink([], [busy]);
    expect(await new AuthStart(failed, BUILTIN_TOOLS).finishMcp(started)).toMatchObject({
      kind: "link-failure",
      result: { error: { code: "forward-failed" } },
    });
  });
});

describe("loopbackLoginUrl", () => {
  test("reads the URL and port from terminal output", () => {
    expect(loopbackLoginUrl(CLAUDE_LOGIN_OUTPUT)).toEqual({ url: AUTHORIZE_URL, port: 3118 });
  });

  test("refuses a URL that carries a token parameter", () => {
    expect(loopbackLoginUrl(`${AUTHORIZE_URL}&access_token=x`)).toBeNull();
  });
});

describe("mcpLoginCommand", () => {
  const directories: string[] = [];
  afterEach(() => {
    for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
  });

  test("passes a name with shell metacharacters through every quoting layer as one argument", async () => {
    const directory = mkdtempSync(join(tmpdir(), "ferry-mcp-login-"));
    directories.push(directory);
    const log = join(directory, "args");
    const stub = (name: string, body: string) => {
      writeFileSync(join(directory, name), `#!/bin/sh\n${body}\n`);
      chmodSync(join(directory, name), 0o755);
    };
    // Stand-ins for the Linux tools: each one runs the command it wraps.
    stub("setsid", 'exec "$@"');
    stub("nohup", 'exec "$@"');
    stub("timeout", 'shift; exec "$@"');
    stub("script", 'exec sh -c "$2"');
    stub("claude", `printf '%s\\n' "$@" > '${log}'; printf '%s\\n' '${AUTHORIZE_URL}'`);
    const name = "x'$(touch pwned)`touch pwned2`\"; touch pwned3";

    const child = Bun.spawn(["sh", "-c", mcpLoginCommand(mcpCommand("claude mcp login {name} --no-browser", { name }), 5)], {
      cwd: directory,
      env: { PATH: `${directory}:/usr/bin:/bin`, TMPDIR: directory },
      stdout: "pipe",
    });
    await child.exited;
    const output = await new Response(child.stdout).text();

    expect(loopbackLoginUrl(output)).toEqual({ url: AUTHORIZE_URL, port: 3118 });
    expect(readFileSync(log, "utf8").split("\n")).toEqual(["mcp", "login", name, "--no-browser", ""]);
    for (const file of ["pwned", "pwned2", "pwned3"]) expect(existsSync(join(directory, file))).toBe(false);
  });
});
