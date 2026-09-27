/**
 * AuthStart starts a vendor login on the box and returns the step the operator
 * finishes here. It reads its recipes from the tool registry and never accepts
 * or reads a credential file from the operator machine.
 */

import type {
  ForwardOptions,
  LinkError,
  LinkErrorCode,
  LinkFailure,
  LinkOrigin,
  LinkResult,
  RunOptions,
} from "./link.ts";
import { mcpBinary, mcpCommand } from "./box-mcp.ts";
import { quoteShell } from "./box-settings.ts";
import type { AuthFallback, ToolAuth, ToolDescriptor } from "./registry/types.ts";

/** Same rule as Manifest: an MCP server name reaches a remote shell command. */
const MCP_SERVER_NAME = /^[A-Za-z0-9._-]+$/;
/** `mcp list` checks the health of every server, so it gets more time than one command. */
const MCP_LIST_TIMEOUT_MS = 120_000;
/** How long ferry keeps the callback forward open. */
const MCP_FORWARD_TIMEOUT_MS = 300_000;
/** The box login outlives the forward a little, then stops. */
const MCP_LOGIN_LIFETIME_S = 330;
/** The box polls this long for the login URL. */
const MCP_URL_WAIT_S = 30;
/** A vendor login and its device code stop after this time on the box. */
const LOGIN_LIFETIME_S = 900;
/** How often ferry probes the login state while the operator finishes the login. */
const LOGIN_POLL_MS = 5_000;
/** The setup command talks to the vendor, so it gets more time than one command. */
const SETUP_TIMEOUT_MS = 120_000;
/** The last line of a setup command when all its steps passed. */
const SETUP_OK = "ferry-setup-ok";
/** The first line of the login command output names the login directory on the box. */
const LOGIN_DIR_LINE = /^ferry-login-dir (\/[A-Za-z0-9._\/-]+)$/;

/** A tool ferry has a login recipe for. */
export type AuthTool = ToolDescriptor & { readonly auth: ToolAuth };

/**
 * The tools with a login recipe, in report order: the ones ferry can probe
 * first, then the manual ones, which carry guidance rather than a state.
 */
export function authTools(tools: readonly ToolDescriptor[]): readonly AuthTool[] {
  const withAuth = tools.filter((tool): tool is AuthTool => tool.auth !== undefined);
  return [
    ...withAuth.filter((tool) => tool.auth.completion.kind !== "manual"),
    ...withAuth.filter((tool) => tool.auth.completion.kind === "manual"),
  ];
}

export type AuthProviderStatus =
  | { readonly provider: string; readonly status: "authenticated" }
  | { readonly provider: string; readonly status: "login-required" }
  | {
      readonly provider: string;
      readonly status: "manual";
      readonly instruction: string;
    }
  | {
      readonly provider: string;
      readonly status: "unavailable";
      readonly error: LinkError;
    };

export type AuthStatusReport = { readonly providers: readonly AuthProviderStatus[] };

/** The MCP servers on the box that need a login, for one tool. */
export type McpLoginStatus =
  | { readonly tool: string; readonly loginRequired: readonly string[] }
  | { readonly tool: string; readonly error: LinkError };

export interface AuthLink {
  run(command: string, options?: RunOptions): Promise<LinkResult>;
  forward(options: ForwardOptions): Promise<LinkResult>;
}

export type AuthStartResult =
  | { readonly kind: "already-done"; readonly provider: string; readonly notes?: readonly string[] }
  | { readonly kind: "logged-in"; readonly provider: string; readonly notes?: readonly string[] }
  | {
      readonly kind: "device-url";
      readonly provider: string;
      readonly url: string;
      readonly userCode?: string;
    }
  | {
      readonly kind: "printed-url";
      readonly provider: string;
      readonly url: string;
      /** The input of the login on the box. Set when the login waits for a pasted code. */
      readonly codeInput?: string;
    }
  | {
      readonly kind: "local-port-forward";
      readonly provider: string;
      readonly url: string;
      readonly localPort: number;
      readonly remotePort: number;
      readonly timeoutMs: number;
    }
  | {
      readonly kind: "manual-ssh";
      readonly provider: string;
      readonly command: string;
      readonly instruction: string;
    }
  | {
      readonly kind: "link-failure";
      readonly provider: string;
      readonly result: LinkFailure;
    }
  | {
      readonly kind: "failed";
      readonly provider: string;
      readonly code: "login-output" | "login-unfinished" | "login-setup";
      readonly message: string;
    }
  | {
      readonly kind: "refused";
      readonly code: "credential-input" | "invalid-provider" | "invalid-server" | "invalid-code";
      readonly message: string;
    };

/** How ferry waits for the operator to finish a login. */
export type LoginWait = { readonly pollMs: number; readonly timeoutMs: number };

export class AuthStart {
  constructor(
    private readonly link: AuthLink,
    private readonly tools: readonly ToolDescriptor[],
    private readonly wait: LoginWait = { pollMs: LOGIN_POLL_MS, timeoutMs: LOGIN_LIFETIME_S * 1000 },
  ) {}

  /** The providers a login can be started for. Manual providers are not listed. */
  startableProviders(): readonly string[] {
    return authTools(this.tools)
      .filter((tool) => tool.auth.completion.kind !== "manual")
      .map((tool) => tool.id);
  }

  /** Run authentication probes only. This method never starts a login or forward. */
  async status(): Promise<AuthStatusReport> {
    const providers: AuthProviderStatus[] = [];

    for (const tool of authTools(this.tools)) {
      const completion = tool.auth.completion;
      if (completion.kind === "manual") {
        providers.push({
          provider: tool.id,
          status: "manual",
          instruction: completion.instruction,
        });
        continue;
      }
      if (!tool.auth.probe) continue;

      const probe = await this.link.run(tool.auth.probe);
      if (probe.ok) {
        providers.push({ provider: tool.id, status: "authenticated" });
      } else if (probe.error.code === "command-failed") {
        providers.push({ provider: tool.id, status: "login-required" });
      } else {
        providers.push({
          provider: tool.id,
          status: "unavailable",
          error: {
            code: probe.error.code,
            origin: probe.error.origin,
            message: safeLinkMessage(probe.error.code, probe.error.origin),
          },
        });
      }
    }
    return { providers };
  }

  async start(provider: string): Promise<AuthStartResult> {
    if (arguments.length !== 1) {
      return {
        kind: "refused",
        code: "credential-input",
        message: "AuthStart accepts only a provider. Logins are not copied.",
      };
    }

    const auth = this.tools.find((tool) => tool.id === provider)?.auth;
    if (!auth) {
      return {
        kind: "refused",
        code: "invalid-provider",
        message: "AuthStart received an unknown provider.",
      };
    }

    const completion = auth.completion;
    if (completion.kind === "manual") {
      return {
        kind: "manual-ssh",
        provider,
        command: completion.command,
        instruction: completion.instruction,
      };
    }
    if (!auth.probe || !auth.login) {
      return {
        kind: "refused",
        code: "invalid-provider",
        message: `The ${provider} provider has no login recipe.`,
      };
    }

    const probe = await this.link.run(auth.probe);
    if (!probe.ok && probe.error.code !== "command-failed") return linkFailure(provider, probe);
    if (auth.prepare) {
      const prepared = await this.link.run(auth.prepare);
      if (!prepared.ok) return linkFailure(provider, prepared);
    }
    if (probe.ok) return { kind: "already-done", provider };

    const login = await this.startLogin(auth.login);
    if (!login.ok) return linkFailure(provider, login);

    if (completion.kind === "device-url") {
      if (!completion.codePattern) return { kind: "device-url", provider, url: completion.url };
      const userCode = login.output.match(new RegExp(completion.codePattern))?.[0];
      if (userCode) return { kind: "device-url", provider, url: completion.url, userCode };
      if (auth.fallback) return this.startFallback(provider, auth.fallback);
      return missingUrl(provider);
    }
    const url = safeUrl(login.output, completion.allowedHosts);
    if (!url) return missingUrl(provider);
    if (!completion.pastedCode) return { kind: "printed-url", provider, url };
    return login.dir ? { kind: "printed-url", provider, url, codeInput: `${login.dir}/in` } : missingUrl(provider);
  }

  /**
   * Wait until the operator finishes a started login, then run the setup of
   * the tool. A login that waits for a pasted code gets `pastedCode` first.
   * An already-done login only runs the setup. Other results pass through.
   */
  async finish(started: AuthStartResult, pastedCode?: string): Promise<AuthStartResult> {
    if (started.kind === "local-port-forward") {
      const forward = await this.link.forward({
        localPort: started.localPort,
        remotePort: started.remotePort,
        remoteHost: "127.0.0.1",
        timeoutMs: started.timeoutMs,
      });
      // The forward holds until its timeout, so a timeout is the usual end.
      if (!forward.ok && forward.error.code !== "forward-timeout") {
        return linkFailure(started.provider, forward);
      }
    }
    if (
      started.kind !== "already-done" &&
      started.kind !== "device-url" &&
      started.kind !== "printed-url" &&
      started.kind !== "local-port-forward"
    ) {
      return started;
    }
    const provider = started.provider;
    const auth = this.tools.find((tool) => tool.id === provider)?.auth;
    if (!auth?.probe) return started;

    if (started.kind === "printed-url" && started.codeInput) {
      const pattern = auth.completion.kind === "printed-url" ? auth.completion.pastedCode : undefined;
      if (!pattern || pastedCode === undefined || !new RegExp(pattern).test(pastedCode)) {
        return {
          kind: "refused",
          code: "invalid-code",
          message: `The ${provider} login code does not have the expected form.`,
        };
      }
      const sent = await this.link.run(
        `[ -p ${quoteShell(started.codeInput)} ] && printf '%s\\n' ${quoteShell(pastedCode)} > ${quoteShell(started.codeInput)}`,
      );
      if (!sent.ok) return linkFailure(provider, sent);
    }

    if (started.kind !== "already-done") {
      const done = await this.waitForLogin(auth.probe);
      if (done !== true) return done ? linkFailure(provider, done) : unfinished(provider, auth, this.wait);
    }
    const kind = started.kind === "already-done" ? "already-done" : "logged-in";
    if (!auth.setup) return { kind, provider };

    const setup = await this.link.run(auth.setup, { timeoutMs: SETUP_TIMEOUT_MS });
    if (!setup.ok) return linkFailure(provider, setup);
    const lines = plainText(setup.stdout).split("\n").filter((line) => line.trim() !== "");
    if (lines.at(-1) !== SETUP_OK) {
      return {
        kind: "failed",
        provider,
        code: "login-setup",
        message: `The ${provider} login is complete, but a setup step failed: ${lines.at(-1) ?? "no output"}`,
      };
    }
    return { kind, provider, notes: lines.slice(0, -1) };
  }

  /**
   * List the MCP servers on the box that need a login. Only the list command
   * of each tool runs. A tool whose CLI is not on the box lists no servers.
   */
  async mcpStatus(): Promise<readonly McpLoginStatus[]> {
    const statuses: McpLoginStatus[] = [];
    for (const tool of this.tools) {
      if (!tool.mcp) continue;
      const result = await this.link.run(
        `command -v ${mcpBinary(tool.mcp)} >/dev/null 2>&1 || exit 0; ${tool.mcp.list} 2>/dev/null || true`,
        { timeoutMs: MCP_LIST_TIMEOUT_MS },
      );
      if (!result.ok) {
        statuses.push({ tool: tool.id, error: safeError(result.error) });
        continue;
      }
      const pattern = new RegExp(tool.mcp.loginRequired);
      const loginRequired = plainText(result.stdout)
        .split("\n")
        .flatMap((line) => line.match(pattern)?.[1] ?? []);
      statuses.push({ tool: tool.id, loginRequired });
    }
    return statuses;
  }

  /**
   * Start the MCP login of `server` on the box and return its authorize URL
   * and callback port. The login runs detached under a pseudo terminal and
   * stops by itself. Call `finishMcp` after the operator has the URL.
   */
  async startMcp(tool: string, server: string): Promise<AuthStartResult> {
    if (arguments.length !== 2) {
      return {
        kind: "refused",
        code: "credential-input",
        message: "AuthStart accepts only a tool and a server. Logins are not copied.",
      };
    }
    const recipe = this.tools.find((candidate) => candidate.id === tool)?.mcp;
    if (!recipe) {
      return {
        kind: "refused",
        code: "invalid-provider",
        message: "AuthStart received a tool without MCP support.",
      };
    }
    if (!MCP_SERVER_NAME.test(server)) {
      return {
        kind: "refused",
        code: "invalid-server",
        message: "An MCP server name has only letters, digits, dot, underscore, and hyphen.",
      };
    }

    const provider = `${tool}/${server}`;
    const login = await this.link.run(
      mcpLoginCommand(mcpCommand(recipe.login, { name: server }), MCP_LOGIN_LIFETIME_S),
      { timeoutMs: (MCP_URL_WAIT_S + 30) * 1000 },
    );
    if (!login.ok) return linkFailure(provider, login);

    const callback = loopbackLoginUrl(login.stdout);
    if (!callback) return missingUrl(provider);
    return {
      kind: "local-port-forward",
      provider,
      url: callback.url,
      localPort: callback.port,
      remotePort: callback.port,
      timeoutMs: MCP_FORWARD_TIMEOUT_MS,
    };
  }

  /**
   * Forward the callback port of a started MCP login until the forward times
   * out, then report whether the box still lists the server as needing a login.
   */
  async finishMcp(
    started: Extract<AuthStartResult, { kind: "local-port-forward" }>,
  ): Promise<AuthStartResult> {
    const forward = await this.link.forward({
      localPort: started.localPort,
      remotePort: started.remotePort,
      remoteHost: "127.0.0.1",
      timeoutMs: started.timeoutMs,
    });
    // The forward holds until its timeout, so a timeout is the usual end.
    if (!forward.ok && forward.error.code !== "forward-timeout") {
      return linkFailure(started.provider, forward);
    }

    const [tool, server] = started.provider.split("/");
    const status = (await this.mcpStatus()).find((entry) => entry.tool === tool);
    if (status && "loginRequired" in status && !status.loginRequired.includes(server as string)) {
      return { kind: "logged-in", provider: started.provider };
    }
    return {
      kind: "failed",
      provider: started.provider,
      code: "login-output",
      message: `The ${started.provider} MCP login did not finish before the port forward closed.`,
    };
  }

  /**
   * The declared callback path: a second login, whose URL returns at once.
   * `finish` holds the local forward after the operator has the URL.
   */
  private async startFallback(
    provider: string,
    fallback: AuthFallback,
  ): Promise<AuthStartResult> {
    const login = await this.startLogin(fallback.login);
    if (!login.ok) return linkFailure(provider, login);

    const url = safeUrl(login.output, fallback.allowedHosts);
    if (!url) return missingUrl(provider);

    return {
      kind: "local-port-forward",
      provider,
      url,
      localPort: fallback.forward.localPort,
      remotePort: fallback.forward.remotePort,
      timeoutMs: fallback.forward.timeoutMs,
    };
  }

  /** Start a login detached on the box and read its first output. */
  private async startLogin(
    login: string,
  ): Promise<LinkFailure | { readonly ok: true; readonly output: string; readonly dir?: string }> {
    const result = await this.link.run(vendorLoginCommand(login, LOGIN_LIFETIME_S), {
      timeoutMs: (MCP_URL_WAIT_S + 30) * 1000,
    });
    if (!result.ok) return result;
    const [first = "", ...rest] = plainText(result.stdout).split("\n");
    const dir = first.match(LOGIN_DIR_LINE)?.[1];
    return dir ? { ok: true, output: rest.join("\n"), dir } : { ok: true, output: plainText(result.stdout) };
  }

  /** Probe until the login is done, a probe fails for another reason, or the wait ends. */
  private async waitForLogin(probe: string): Promise<true | false | LinkFailure> {
    const deadline = Date.now() + this.wait.timeoutMs;
    for (;;) {
      const result = await this.link.run(probe);
      if (result.ok) return true;
      if (result.error.code !== "command-failed") return result;
      if (Date.now() >= deadline) return false;
      await new Promise((resolve) => setTimeout(resolve, this.wait.pollMs));
    }
  }
}

function safeUrl(output: string, allowedHosts: readonly string[]): string | null {
  for (const match of output.matchAll(/https:\/\/[^\s<>"']+/g)) {
    const candidate = match[0].replace(/[),.;]+$/, "");
    try {
      const url = new URL(candidate);
      if (!allowedHosts.some((host) => url.hostname === host || url.hostname.endsWith(`.${host}`))) {
        continue;
      }
      if (carriesSecret(url)) continue;
      return url.toString();
    } catch {
      continue;
    }
  }
  return null;
}

function carriesSecret(url: URL): boolean {
  return (
    Boolean(url.hash) ||
    [...url.searchParams.keys()].some((key) => /token|secret|credential|api.?key/i.test(key))
  );
}

/**
 * The box command that starts a vendor login detached and prints its output
 * once a URL appears. The first line names the login directory. The login
 * reads its input from the FIFO `in` in that directory, and a `sleep` keeps
 * the FIFO open, so a code can be written to it later. The login gets no
 * terminal: gh then prints its code without questions. The login and its
 * directory end after `lifetimeSeconds`.
 */
export function vendorLoginCommand(login: string, lifetimeSeconds: number): string {
  const inner = `BROWSER=true NO_OPEN_BROWSER=1 exec ${login}`;
  const runner = [
    'sleep "$1" > "$3/in" & w=$!',
    'timeout "$1" sh -c "$2" < "$3/in" > "$3/log" 2>&1',
    'kill "$w" 2>/dev/null',
    'rm -rf "$3"',
  ].join("; ");
  return [
    'dir=$(mktemp -d "${TMPDIR:-/tmp}/ferry-login.XXXXXX") || exit 1',
    'mkfifo "$dir/in" || exit 1',
    `setsid nohup sh -c ${quoteShell(runner)} ferry-login ${lifetimeSeconds} ${quoteShell(inner)} "$dir" </dev/null >/dev/null 2>&1 &`,
    "i=0",
    `while [ "$i" -lt ${MCP_URL_WAIT_S} ] && [ -d "$dir" ] && ! grep -q https:// "$dir/log" 2>/dev/null; do sleep 1; i=$((i+1)); done`,
    "sleep 1",
    'echo "ferry-login-dir $dir"',
    'cat "$dir/log" 2>/dev/null',
    "exit 0",
  ].join("\n");
}

/**
 * The box command that starts an MCP login detached and prints its output
 * once the authorize URL appears. `script` gives the login a terminal, and a
 * `sleep` pipe keeps its input open. The login and its log end after
 * `lifetimeSeconds`.
 */
export function mcpLoginCommand(login: string, lifetimeSeconds: number): string {
  const inner = `stty cols 4096 2>/dev/null; BROWSER=true COLUMNS=4096 exec ${login}`;
  const runner = `sleep "$1" | timeout "$1" script -qfec "$2" /dev/null > "$3" 2>&1; rm -f "$3"`;
  return [
    'log=$(mktemp "${TMPDIR:-/tmp}/ferry-mcp-login.XXXXXX") || exit 1',
    `setsid nohup sh -c ${quoteShell(runner)} ferry-mcp-login ${lifetimeSeconds} ${quoteShell(inner)} "$log" </dev/null >/dev/null 2>&1 &`,
    "i=0",
    `while [ "$i" -lt ${MCP_URL_WAIT_S} ] && ! grep -q redirect_uri "$log" 2>/dev/null; do sleep 1; i=$((i+1)); done`,
    "sleep 1",
    'cat "$log"',
  ].join("\n");
}

/**
 * The first https URL in the login output whose `redirect_uri` is a loopback
 * callback, with the callback port. The URL goes to the operator browser and
 * the port is forwarded, so any other URL is refused.
 */
export function loopbackLoginUrl(output: string): { url: string; port: number } | null {
  for (const match of plainText(output).matchAll(/https:\/\/[^\s<>"']+/g)) {
    try {
      const url = new URL(match[0]);
      const redirect = new URL(url.searchParams.get("redirect_uri") ?? "");
      if (carriesSecret(url) || redirect.protocol !== "http:") continue;
      if (redirect.hostname !== "localhost" && redirect.hostname !== "127.0.0.1") continue;
      const port = Number(redirect.port);
      if (!Number.isInteger(port) || port <= 0) continue;
      return { url: url.toString(), port };
    } catch {
      continue;
    }
  }
  return null;
}

/** Terminal output without escape sequences and carriage returns. */
function plainText(output: string): string {
  return output
    .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, "")
    .replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, "")
    .replace(/\r/g, "");
}

function safeError(error: LinkError): LinkError {
  return {
    code: error.code,
    origin: error.origin,
    message: safeLinkMessage(error.code, error.origin),
  };
}

function missingUrl(provider: string): AuthStartResult {
  return {
    kind: "failed",
    provider,
    code: "login-output",
    message: `The ${provider} login did not return a safe operator URL.`,
  };
}

function unfinished(provider: string, auth: ToolAuth, wait: LoginWait): AuthStartResult {
  return {
    kind: "failed",
    provider,
    code: "login-unfinished",
    message: `The ${provider} login did not finish in ${Math.round(wait.timeoutMs / 1000)} s.${auth.setup ? " Ferry did not run the setup steps." : ""}`,
  };
}

function linkFailure(
  provider: string,
  result: LinkFailure,
  preserveForwardTimeout = false,
): AuthStartResult {
  if (preserveForwardTimeout && result.error.code === "forward-timeout") {
    return { kind: "link-failure", provider, result };
  }
  return {
    kind: "link-failure",
    provider,
    result: {
      ok: false,
      error: {
        code: result.error.code,
        origin: result.error.origin,
        message: safeLinkMessage(result.error.code, result.error.origin),
      },
    },
  };
}

function safeLinkMessage(code: LinkErrorCode, origin: LinkOrigin): string {
  return `AuthStart stopped because Link reported ${code} from ${origin}.`;
}
