import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AuthStart, loopbackLoginUrl, mcpLoginCommand, type AuthLink } from "../src/auth-start.ts";
import { mcpCommand } from "../src/box-mcp.ts";
import type { ForwardOptions, ForwardResult, LinkFailure, LinkResult, LinkSuccess, RunOptions } from "../src/link.ts";
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
    login: /gh auth login .*--hostname github\.com.*--git-protocol ssh.*--web/,
    output: "First copy your one-time code: A1B2-C3D4\nOpen https://github.com/login/device\n",
    action: "device-url",
  },
  {
    provider: "claude",
    probe: /^claude auth status$/,
    login: /exec claude auth login'/,
    output: "Open https://claude.ai/oauth/authorize?state=opaque in your browser\n",
    action: "printed-url",
  },
  {
    provider: "codex",
    probe: /^codex login status$/,
    login: /exec codex login --device-auth'/,
    output: "Open https://auth.openai.com/codex/device and enter ABCD-EFGH\n",
    action: "device-url",
  },
  {
    provider: "cursor",
    probe: /^cursor-agent status$/,
    login: /exec cursor-agent login'/,
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
      const prepare = providerCase.provider === "gh" ? [success()] : [];
      const link = new FakeLink([
        loggedOut(),
        ...prepare,
        success(`ferry-login-dir /tmp/ferry-login.abc\n${providerCase.output}`),
      ]);

      const result = await new AuthStart(link, BUILTIN_TOOLS).start(providerCase.provider);

      expect(link.runs).toHaveLength(2 + prepare.length);
      expect(link.runs[0]?.command).toMatch(providerCase.probe);
      expect(link.runs.at(-1)?.command).toMatch(providerCase.login);
      expect(link.runs.at(-1)?.command).toContain("setsid nohup");
      expect(result.kind).toBe(providerCase.action);
    }
  });

  test("returns already-done without starting another login", async () => {
    const link = new FakeLink([success()]);

    const result = await new AuthStart(link, BUILTIN_TOOLS).start("cursor");

    expect(result).toEqual({ kind: "already-done", provider: "cursor" });
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
      success(`ferry-login-dir /tmp/ferry-login.abc\nOpen https://cursor.com/auth/cli?state=opaque\nAccess token: ${token}\n`),
    ]);

    const result = await new AuthStart(link, BUILTIN_TOOLS).start("cursor");

    expect(result).toEqual({
      kind: "printed-url",
      provider: "cursor",
      url: "https://cursor.com/auth/cli?state=opaque",
    });
    expect(JSON.stringify(result)).not.toContain(token);
  });

  test("returns the Codex fallback URL before the callback forward opens, then forwards and probes", async () => {
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
        success("ferry-login-dir /tmp/ferry-login.a\nError logging in with device code: status 404\n"),
        success(
          "ferry-login-dir /tmp/ferry-login.b\nStarting local login server on http://localhost:1455.\nOpen https://auth.openai.com/oauth/authorize?state=opaque\n",
        ),
        success(),
      ],
      [timeout],
    );
    const auth = new AuthStart(link, BUILTIN_TOOLS);

    const started = await auth.start("codex");

    expect(link.runs.map((call) => call.command)[1]).toContain("exec codex login --device-auth'");
    expect(link.runs.map((call) => call.command)[2]).toContain("exec codex login'");
    expect(link.forwards).toEqual([]);
    expect(started).toEqual({
      kind: "local-port-forward",
      provider: "codex",
      url: "https://auth.openai.com/oauth/authorize?state=opaque",
      localPort: 1455,
      remotePort: 1455,
      timeoutMs: 120_000,
    });

    expect(await auth.finish(started)).toEqual({ kind: "logged-in", provider: "codex" });
    expect(link.forwards).toEqual([
      { localPort: 1455, remotePort: 1455, remoteHost: "127.0.0.1", timeoutMs: 120_000, signal: expect.any(AbortSignal) },
    ]);
    expect(link.runs.at(-1)?.command).toBe("codex login status");
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
    const link = new FakeLink([success("docs: https://docs.example/mcp (HTTP) - ✓ Connected\n")], [timeout]);
    const auth = new AuthStart(link, BUILTIN_TOOLS);

    const result = await auth.finishMcp({
      kind: "local-port-forward",
      provider: "claude/linear",
      url: AUTHORIZE_URL,
      localPort: 3118,
      remotePort: 3118,
      timeoutMs: 300_000,
    });

    expect(link.forwards).toEqual([
      { localPort: 3118, remotePort: 3118, remoteHost: "127.0.0.1", timeoutMs: 300_000, signal: expect.any(AbortSignal) },
    ]);
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

    const pending = new FakeLink([success(MCP_LISTS.claude)], [timeout]);
    expect(await new AuthStart(pending, BUILTIN_TOOLS).finishMcp(started)).toMatchObject({ kind: "failed", code: "login-output" });

    const failed = new FakeLink([success(MCP_LISTS.claude)], [busy]);
    expect(await new AuthStart(failed, BUILTIN_TOOLS).finishMcp(started)).toMatchObject({
      kind: "link-failure",
      result: { error: { code: "forward-failed" } },
    });
  });
});

/**
 * A Link whose forward holds until its signal aborts, then reports
 * `forward-stopped`, or until its timeout, then reports `forward-timeout`.
 * Each run takes its result from `probe`, which gets the number of runs so far.
 */
class HeldForwardLink implements AuthLink {
  readonly runs: string[] = [];
  readonly forwards: ForwardOptions[] = [];
  forwardEnd: "stopped" | "timeout" | null = null;

  constructor(
    private readonly probe: (runs: number) => LinkResult,
    private readonly forwardFailure?: LinkFailure,
  ) {}

  async run(command: string): Promise<LinkResult> {
    this.runs.push(command);
    return this.probe(this.runs.length);
  }

  forward(options: ForwardOptions): Promise<ForwardResult> {
    this.forwards.push(options);
    if (this.forwardFailure) return Promise.resolve(this.forwardFailure);
    return new Promise((resolve) => {
      const stop = () => {
        clearTimeout(timer);
        this.forwardEnd ??= "stopped";
        resolve({ ...(success() as LinkSuccess), stopped: true });
      };
      const timer = setTimeout(() => {
        this.forwardEnd = "timeout";
        resolve({ ok: false, error: { code: "forward-timeout", origin: "network", message: "t" } });
      }, options.timeoutMs);
      if (options.signal?.aborted) stop();
      options.signal?.addEventListener("abort", stop);
    });
  }
}

describe("AuthStart callback forward", () => {
  const codexStarted = {
    kind: "local-port-forward",
    provider: "codex",
    url: "https://auth.openai.com/oauth/authorize?state=opaque",
    localPort: 1455,
    remotePort: 1455,
    timeoutMs: 10_000,
  } as const;
  const mcpStarted = { ...codexStarted, provider: "claude/linear", url: AUTHORIZE_URL, localPort: 3118, remotePort: 3118 };
  const fast = { pollMs: 10, timeoutMs: 60_000 };
  const probeError: LinkFailure = { ok: false, error: { code: "ssh-failed", origin: "network", message: "raw" } };

  test("stops the Codex forward as soon as the probe reports the login, then reports success", async () => {
    const link = new HeldForwardLink((runs) => (runs < 3 ? loggedOut() : success()));

    const result = await new AuthStart(link, BUILTIN_TOOLS, fast).finish(codexStarted);

    expect(result).toEqual({ kind: "logged-in", provider: "codex" });
    expect(link.forwardEnd).toBe("stopped");
    expect(link.runs).toEqual(["codex login status", "codex login status", "codex login status"]);
    expect(link.forwards[0]?.timeoutMs).toBe(10_000);
  });

  test("stops the MCP forward as soon as the box no longer lists the server as needing a login", async () => {
    const link = new HeldForwardLink((runs) => success(runs < 2 ? MCP_LISTS.claude : "linear: ✓ Connected\n"));

    const result = await new AuthStart(link, BUILTIN_TOOLS, fast).finishMcp(mcpStarted);

    expect(result).toEqual({ kind: "logged-in", provider: "claude/linear" });
    expect(link.forwardEnd).toBe("stopped");
    expect(link.runs).toEqual([
      "command -v claude >/dev/null 2>&1 || exit 0; claude mcp list 2>/dev/null || true",
      "command -v claude >/dev/null 2>&1 || exit 0; claude mcp list 2>/dev/null || true",
    ]);
  });

  test("probes once more at the timeout and reports a login that did not finish", async () => {
    const codex = new HeldForwardLink(() => loggedOut());
    const mcp = new HeldForwardLink(() => success(MCP_LISTS.claude));

    const codexResult = await new AuthStart(codex, BUILTIN_TOOLS, { pollMs: 40, timeoutMs: 60_000 }).finish({
      ...codexStarted,
      timeoutMs: 100,
    });
    const mcpResult = await new AuthStart(mcp, BUILTIN_TOOLS, { pollMs: 40, timeoutMs: 60_000 }).finishMcp({
      ...mcpStarted,
      timeoutMs: 100,
    });

    expect(codex.forwardEnd).toBe("timeout");
    expect(codexResult).toEqual({
      kind: "failed",
      provider: "codex",
      code: "login-unfinished",
      message: "The codex login did not finish before the port forward closed.",
    });
    expect(mcp.forwardEnd).toBe("timeout");
    expect(mcpResult).toMatchObject({ kind: "failed", provider: "claude/linear", code: "login-output" });
  });

  test("on Ctrl-C stops the forward, probes once more, and reports the real state", async () => {
    const operator = new AbortController();
    const done = new HeldForwardLink((runs) => {
      if (runs === 1) operator.abort();
      return runs === 1 ? loggedOut() : success();
    });

    const result = await new AuthStart(done, BUILTIN_TOOLS, fast).finish(codexStarted, undefined, operator.signal);

    expect(result).toEqual({ kind: "logged-in", provider: "codex" });
    expect(done.forwardEnd).toBe("stopped");
    expect(done.runs).toHaveLength(2);

    const stopped = new AbortController();
    stopped.abort();
    const pending = new HeldForwardLink(() => success(MCP_LISTS.claude));
    const mcpResult = await new AuthStart(pending, BUILTIN_TOOLS, fast).finishMcp(mcpStarted, stopped.signal);

    expect(pending.forwardEnd).toBe("stopped");
    expect(pending.runs).toHaveLength(1);
    expect(mcpResult).toMatchObject({ kind: "failed", provider: "claude/linear", code: "login-output" });
  });

  test("on Ctrl-C does not report the forward failure when OpenSSH got the interrupt first", async () => {
    const operator = new AbortController();
    operator.abort();
    const interrupted: LinkFailure = { ok: false, error: { code: "forward-failed", origin: "network", message: "Killed by signal 2." } };
    const link = new HeldForwardLink(() => loggedOut(), interrupted);

    const result = await new AuthStart(link, BUILTIN_TOOLS, fast).finish(codexStarted, undefined, operator.signal);

    expect(result).toMatchObject({ kind: "failed", provider: "codex", code: "login-unfinished" });
  });

  test("stops the forward and reports a probe error", async () => {
    const codex = new HeldForwardLink((runs) => (runs < 2 ? loggedOut() : probeError));
    const mcp = new HeldForwardLink(() => probeError);

    const codexResult = await new AuthStart(codex, BUILTIN_TOOLS, fast).finish(codexStarted);
    const mcpResult = await new AuthStart(mcp, BUILTIN_TOOLS, fast).finishMcp(mcpStarted);

    for (const [link, result] of [[codex, codexResult], [mcp, mcpResult]] as const) {
      expect(link.forwardEnd).toBe("stopped");
      expect(result).toMatchObject({ kind: "link-failure", result: { error: { code: "ssh-failed", origin: "network" } } });
      expect(JSON.stringify(result)).not.toContain("raw");
    }
  });

  test("reports a forward that failed, after one probe", async () => {
    const busy: LinkFailure = { ok: false, error: { code: "forward-failed", origin: "network", message: "port in use" } };
    const link = new HeldForwardLink(() => loggedOut(), busy);

    const result = await new AuthStart(link, BUILTIN_TOOLS, fast).finish(codexStarted);

    expect(result).toMatchObject({ kind: "link-failure", result: { error: { code: "forward-failed" } } });
    expect(link.runs).toEqual(["codex login status"]);
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

/**
 * A Link that runs each box command in a local `sh`. Stub CLIs in `bin` stand
 * in for the vendor CLIs and the Linux tools, and `HOME` is a test directory.
 */
class ShellLink implements AuthLink {
  readonly commands: string[] = [];

  constructor(private readonly home: string) {}

  async run(command: string): Promise<LinkResult> {
    this.commands.push(command);
    const child = Bun.spawn(["sh", "-c", command], {
      cwd: this.home,
      env: { PATH: `${join(this.home, "bin")}:/usr/bin:/bin`, HOME: this.home, TMPDIR: this.home },
      stdout: "pipe",
      stderr: "pipe",
    });
    const [code, stdout] = await Promise.all([child.exited, new Response(child.stdout).text()]);
    if (code !== 0) {
      return { ok: false, error: { code: "command-failed", origin: "box", message: `exit ${code}` } };
    }
    return success(stdout);
  }

  async forward(options: ForwardOptions): Promise<LinkResult> {
    throw new Error(`unexpected forward: ${JSON.stringify(options)}`);
  }
}

const CLAUDE_AUTH_URL =
  "https://claude.com/cai/oauth/authorize?code=true&client_id=c&response_type=code&redirect_uri=https%3A%2F%2Fplatform.claude.com%2Foauth%2Fcode%2Fcallback&code_challenge=x&code_challenge_method=S256&state=s";
const CURSOR_AUTH_URL = "https://cursor.com/loginDeepControl?challenge=x&uuid=u&mode=login";

/**
 * Each stub login prints its code or URL, then holds for `LOGIN_HOLD_S`
 * seconds before it logs in (unless `$HOME/abandon` exists) and exits. The
 * file `$HOME/<tool>-exited` shows that the login has exited.
 */
const LOGIN_HOLD_S = 4;
const STUBS: Record<string, string> = {
  // Stand-ins for the Linux tools: each one runs the command it wraps.
  setsid: 'exec "$@"',
  nohup: 'exec "$@"',
  timeout: 'shift; exec "$@"',
  hostname: "echo box1",
  id: "echo agent",
  gh: `
echo "gh $*" >> "$HOME/calls"
case "$1 $2" in
  "auth status") [ -e "$HOME/gh-in" ] ;;
  "auth login")
    echo "! First copy your one-time code: A1B2-C3D4" >&2
    echo "Open this URL to continue in your web browser: https://github.com/login/device" >&2
    sleep ${LOGIN_HOLD_S}
    [ -e "$HOME/abandon" ] || touch "$HOME/gh-in"
    touch "$HOME/gh-exited" ;;
  "ssh-key list") cat "$HOME/github-keys" 2>/dev/null; true ;;
  "ssh-key add") printf 'box1 (ferry)\\t%s\\n' "$(cut -d' ' -f1,2 "$3")" >> "$HOME/github-keys" ;;
  "api meta") echo "SHA256:GHFP" ;;
  "config set") ;;
  *) exit 2 ;;
esac`,
  "ssh-keygen": `
echo "ssh-keygen $*" >> "$HOME/calls"
case "$1" in
  -F) grep -q "^github.com " "$HOME/.ssh/known_hosts" 2>/dev/null ;;
  -lf) read -r host type key; echo "256 SHA256:GHFP $host ($type)" ;;
  *) for f; do file=$f; done; echo private > "$file"; echo "ssh-ed25519 AAAABOXKEY agent@box1 ferry" > "$file.pub" ;;
esac`,
  "ssh-keyscan": "echo 'github.com ssh-ed25519 AAAAGITHUB'",
  ssh: `echo "ssh $*" >> "$HOME/calls"; echo "Hi op! You've successfully authenticated, but GitHub does not provide shell access." >&2; exit 1`,
  claude: `
case "$1 $2" in
  "auth status") [ -e "$HOME/claude-in" ] ;;
  "auth login")
    printf 'Opening browser to sign in\\342\\200\\246\\nIf the browser did not open, visit: \\033]8;;%s\\007%s\\033]8;;\\007\\nPaste code here if prompted > ' '${CLAUDE_AUTH_URL}' '${CLAUDE_AUTH_URL}'
    read -r code
    echo "$code" > "$HOME/claude-code"
    touch "$HOME/claude-in" "$HOME/claude-exited" ;;
esac`,
  codex: `
case "$1 $2" in
  "login status") [ -e "$HOME/codex-in" ] ;;
  "login --device-auth")
    printf '\\nFollow these steps to sign in with ChatGPT using device code authorization:\\n\\n1. Open this link in your browser and sign in to your account\\n   \\033[94mhttps://auth.openai.com/codex/device\\033[0m\\n\\n2. Enter this one-time code \\033[90m(expires in 15 minutes)\\033[0m\\n   \\033[94mABCD-EFGHJ\\033[0m\\n'
    sleep ${LOGIN_HOLD_S}
    touch "$HOME/codex-in" "$HOME/codex-exited" ;;
esac`,
  "cursor-agent": `
case "$1" in
  status) [ -e "$HOME/cursor-in" ] ;;
  login)
    [ -n "$NO_OPEN_BROWSER" ] || exit 3
    printf 'Waiting for browser authentication...\\nOpen a browser and navigate to this link: ${CURSOR_AUTH_URL}\\n'
    sleep ${LOGIN_HOLD_S}
    touch "$HOME/cursor-in" "$HOME/cursor-exited" ;;
esac`,
};

describe("AuthStart vendor logins against stub CLIs", () => {
  setDefaultTimeout(30_000);

  const homes: string[] = [];
  afterEach(() => {
    for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true });
  });

  function box(): string {
    const home = mkdtempSync(join(tmpdir(), "ferry-vendor-login-"));
    homes.push(home);
    mkdirSync(join(home, "bin"));
    for (const [name, body] of Object.entries(STUBS)) {
      writeFileSync(join(home, "bin", name), `#!/bin/sh\n${body}\n`);
      chmodSync(join(home, "bin", name), 0o755);
    }
    return home;
  }

  function calls(home: string): string[] {
    return existsSync(join(home, "calls")) ? readFileSync(join(home, "calls"), "utf8").trim().split("\n") : [];
  }

  const quick = { pollMs: 100, timeoutMs: 10_000 };

  test("returns the gh code before the login exits, then waits for the login and sets up SSH", async () => {
    const home = box();
    const auth = new AuthStart(new ShellLink(home), BUILTIN_TOOLS, quick);

    const started = await auth.start("gh");

    expect(started).toEqual({
      kind: "device-url",
      provider: "gh",
      url: "https://github.com/login/device",
      userCode: "A1B2-C3D4",
    });
    expect(existsSync(join(home, "gh-exited"))).toBe(false);
    expect(calls(home)).toContain(
      "gh auth login --hostname github.com --git-protocol ssh --skip-ssh-key --scopes admin:public_key --web",
    );
    expect(calls(home)).toContain(`ssh-keygen -q -t ed25519 -N  -C agent@box1 ferry -f ${home}/.ssh/id_ed25519`);

    const finished = await auth.finish(started);

    expect(existsSync(join(home, "gh-exited"))).toBe(true);
    expect(finished).toEqual({
      kind: "logged-in",
      provider: "gh",
      notes: [
        "SSH key: added to GitHub as box1 (ferry)",
        "known_hosts: added github.com",
        "git protocol: ssh",
        "ssh -T git@github.com: authenticated",
      ],
    });
    expect(readFileSync(join(home, "github-keys"), "utf8")).toBe("box1 (ferry)\tssh-ed25519 AAAABOXKEY\n");
    expect(readFileSync(join(home, ".ssh", "known_hosts"), "utf8")).toBe("github.com ssh-ed25519 AAAAGITHUB\n");
    expect(calls(home)).toContain("gh config set -h github.com git_protocol ssh");
    expect(calls(home)).toContain("ssh -T -o BatchMode=yes git@github.com");
  });

  test("keeps an existing box key and does not upload a key that GitHub already has", async () => {
    const home = box();
    mkdirSync(join(home, ".ssh"));
    writeFileSync(join(home, ".ssh", "id_ed25519"), "existing\n");
    writeFileSync(join(home, ".ssh", "id_ed25519.pub"), "ssh-ed25519 AAAAEXISTING old@laptop\n");
    writeFileSync(join(home, ".ssh", "known_hosts"), "github.com ssh-ed25519 AAAAGITHUB\n");
    writeFileSync(join(home, "github-keys"), "laptop\tssh-ed25519 AAAAEXISTING\t2026-01-01\t1\tauthentication\n");
    writeFileSync(join(home, "gh-in"), "");
    const auth = new AuthStart(new ShellLink(home), BUILTIN_TOOLS, quick);

    const started = await auth.start("gh");
    const finished = await auth.finish(started);

    expect(started).toEqual({ kind: "already-done", provider: "gh" });
    expect(finished).toEqual({
      kind: "already-done",
      provider: "gh",
      notes: ["SSH key: already on GitHub", "git protocol: ssh", "ssh -T git@github.com: authenticated"],
    });
    expect(readFileSync(join(home, ".ssh", "id_ed25519"), "utf8")).toBe("existing\n");
    expect(calls(home).filter((call) => call.startsWith("gh ssh-key add") || call.startsWith("ssh-keygen -q"))).toEqual([]);
    expect(calls(home).some((call) => call.startsWith("gh auth login"))).toBe(false);
  });

  test("refuses a github.com host key that does not match the GitHub fingerprint", async () => {
    const home = box();
    writeFileSync(join(home, "bin", "ssh-keyscan"), "#!/bin/sh\necho 'github.com ssh-rsa AAAAOTHER'\n");
    writeFileSync(join(home, "gh-in"), "");
    const keygen = STUBS["ssh-keygen"]!.replace("SHA256:GHFP $host", "SHA256:OTHER $host");
    writeFileSync(join(home, "bin", "ssh-keygen"), `#!/bin/sh\n${keygen}\n`);
    const auth = new AuthStart(new ShellLink(home), BUILTIN_TOOLS, quick);

    const finished = await auth.finish(await auth.start("gh"));

    expect(finished).toMatchObject({ kind: "failed", provider: "gh", code: "login-setup" });
    expect((finished as { message: string }).message).toContain("known_hosts");
    expect(existsSync(join(home, ".ssh", "known_hosts"))).toBe(false);
  });

  test("reports a login that the operator did not finish and uploads nothing", async () => {
    const home = box();
    writeFileSync(join(home, "abandon"), "");
    const auth = new AuthStart(new ShellLink(home), BUILTIN_TOOLS, { pollMs: 100, timeoutMs: 1_000 });

    const started = await auth.start("gh");
    const finished = await auth.finish(started);

    expect(started).toMatchObject({ kind: "device-url", userCode: "A1B2-C3D4" });
    expect(finished).toMatchObject({ kind: "failed", provider: "gh", code: "login-unfinished" });
    expect(calls(home).filter((call) => /^gh (ssh-key|config|api)|^ssh /.test(call))).toEqual([]);
    expect(existsSync(join(home, "github-keys"))).toBe(false);
  });

  test("returns the Claude URL, then gives the pasted code to the login on the box", async () => {
    const home = box();
    const auth = new AuthStart(new ShellLink(home), BUILTIN_TOOLS, quick);

    const started = await auth.start("claude");

    expect(started).toMatchObject({ kind: "printed-url", provider: "claude", url: CLAUDE_AUTH_URL });
    expect(started).toHaveProperty("codeInput");
    expect(existsSync(join(home, "claude-exited"))).toBe(false);

    expect(await auth.finish(started, "x'; touch pwned #")).toMatchObject({ kind: "refused", code: "invalid-code" });
    expect(await auth.finish(started, "auth-Code_1#state-2")).toEqual({ kind: "logged-in", provider: "claude" });
    expect(readFileSync(join(home, "claude-code"), "utf8")).toBe("auth-Code_1#state-2\n");
    expect(existsSync(join(home, "pwned"))).toBe(false);
  });

  test("returns the Codex device code before the login exits", async () => {
    const home = box();
    const auth = new AuthStart(new ShellLink(home), BUILTIN_TOOLS, quick);

    const started = await auth.start("codex");

    expect(started).toEqual({
      kind: "device-url",
      provider: "codex",
      url: "https://auth.openai.com/codex/device",
      userCode: "ABCD-EFGHJ",
    });
    expect(existsSync(join(home, "codex-exited"))).toBe(false);
    expect(await auth.finish(started)).toEqual({ kind: "logged-in", provider: "codex" });
  });

  test("returns the Cursor URL before the login exits, with browser opening turned off", async () => {
    const home = box();
    const auth = new AuthStart(new ShellLink(home), BUILTIN_TOOLS, quick);

    const started = await auth.start("cursor");

    expect(started).toEqual({ kind: "printed-url", provider: "cursor", url: CURSOR_AUTH_URL });
    expect(existsSync(join(home, "cursor-exited"))).toBe(false);
    expect(await auth.finish(started)).toEqual({ kind: "logged-in", provider: "cursor" });
  });
});
