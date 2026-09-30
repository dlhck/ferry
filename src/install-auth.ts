import * as prompts from "@clack/prompts";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  AuthStart,
  authTools,
  LOGIN_LIFETIME_S,
  type AuthLink,
  type AuthStartResult,
} from "./auth-start.ts";
import { planBoxFerry } from "./box-ferry.ts";
import { hasNoBox, missingBoxMessage } from "./boxes.ts";
import { readConfig, resolveLinkOptions, type PartialOperatorConfig, type ToolsConfig } from "./config.ts";
import {
  readOperatorGitIdentity,
  setBoxGitIdentityCommand,
  type GitIdentity,
} from "./git-identity.ts";
import { Install, outputLines, type InstallProgress, type InstallResult } from "./install.ts";
import { FerryError } from "./errors.ts";
import { Link, type LinkError, type LinkOptions } from "./link.ts";
import type { OutputEvent } from "./output.ts";
import { noProgress, step, type Progress } from "./progress.ts";
import { BUILTIN_TOOLS } from "./registry/builtin.ts";
import type { ToolDescriptor } from "./registry/types.ts";
import { RealGitRunner } from "./store.ts";
import { describeStep, effectivePolicy, ToolPlanError, type ToolStep } from "./tools/resolve.ts";
import { VERSION } from "./version.ts";

const STORE_RELATIVE_PATH = ".ferry/store";
/** The number of lines of stderr, and of stdout, that a failed install command shows. */
const OUTPUT_TAIL_LINES = 20;

export type InstallCommandInput = { readonly yes: boolean };
export type AuthCommandInput = {
  readonly provider?: string;
  /** An MCP server on the box. The provider names the tool whose MCP login starts. */
  readonly mcp?: string;
};

type CommandLink = AuthLink;
type InstallCommand = {
  plan(): Promise<readonly ToolStep[]>;
  run(
    confirmed: boolean,
    plan: readonly ToolStep[],
    reportProgress?: (progress: InstallProgress) => void,
  ): Promise<InstallResult>;
};
type AuthCommand = Pick<AuthStart, "start" | "finish" | "startMcp" | "finishMcp">;

export type InstallCommandDependencies = {
  /** The tools this ferry manages. The CLI resolves the registry once. */
  readonly tools: readonly ToolDescriptor[];
  readonly readConfig: () => PartialOperatorConfig | null;
  readonly createLink: (options: LinkOptions) => CommandLink;
  readonly readOperatorGitIdentity: () => Promise<GitIdentity>;
  readonly createInstall: (
    link: CommandLink,
    tools: readonly ToolDescriptor[],
    config: ToolsConfig | undefined,
  ) => InstallCommand;
  readonly progress: Progress;
  readonly confirm: () => Promise<boolean | symbol | undefined>;
  readonly writeLine: (line: string) => void;
  /** The Ferry version to put on the box: the version of this Ferry. */
  readonly ferryVersion: string;
};

export type AuthCommandDependencies = {
  /** The tools this ferry manages. The CLI resolves the registry once. */
  readonly tools: readonly ToolDescriptor[];
  readonly readConfig: () => PartialOperatorConfig | null;
  readonly createLink: (options: LinkOptions) => CommandLink;
  readonly createAuthStart: (link: CommandLink, tools: readonly ToolDescriptor[]) => AuthCommand;
  /** Asks the operator for the code that the browser shows after a login. */
  readonly readLoginCode: () => Promise<string | symbol | undefined>;
  readonly writeLine: (line: string) => void;
  readonly progress: Progress;
  /** Calls `stop` when the operator presses Ctrl-C. Returns a function that removes the handler. */
  readonly onInterrupt: (stop: () => void) => () => void;
  /** With --json, prints the `login` event when the login waits for the browser. */
  readonly emit?: (event: OutputEvent) => void;
};

/** The plan of `ferry install`, and the git identity that it set on the box. */
export type InstallCommandResult = {
  readonly plan: readonly ToolStep[];
  readonly gitIdentity: { readonly name: string; readonly email: string } | null;
};

/** The auth tools without a provider, else the last login result. */
export type AuthCommandResult =
  | { readonly providers: readonly { readonly id: string; readonly login: "startable" | "manual" | "off" }[] }
  | Exclude<AuthStartResult, { readonly kind: "link-failure" | "failed" | "refused" }>;

export class InstallAuthCommandError extends Error {
  constructor(
    message: string,
    /** `<origin>/<code>`, such as `network/host-offline` or `box/login-unfinished`. */
    readonly code: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "InstallAuthCommandError";
  }
}

/** Returns null when the operator does not confirm. */
export async function runInstallCommand(
  input: InstallCommandInput,
  dependencies: Partial<InstallCommandDependencies> = {},
): Promise<InstallCommandResult | null> {
  const resolved = { ...defaultInstallDependencies, ...dependencies };
  const { target, config } = loadTarget(resolved.readConfig, resolved.writeLine);
  const link = resolved.createLink(target);
  const install = resolved.createInstall(link, resolved.tools, config?.tools);

  let plan: readonly ToolStep[];
  try {
    plan = await step(resolved.progress, "Checking the tool versions", async () => [
      ...(await install.plan()),
      await planBoxFerry("install", link, resolved.ferryVersion),
    ]);
  } catch (error) {
    if (!(error instanceof ToolPlanError)) throw error;
    fail("operator/tool-plan", `Install stopped before it changed the box. ${error.message}`, resolved.writeLine);
  }
  // The version check, each tool change, and the box git identity.
  resolved.progress.plan(plan.filter((entry) => entry.command !== undefined).length + 2);
  for (const entry of plan) {
    resolved.writeLine(`${entry.tool}: ${describeStep(entry)}`);
  }
  const { name, email } = await resolved.readOperatorGitIdentity();
  const identityCommand =
    name !== null && email !== null ? setBoxGitIdentityCommand({ name, email }) : null;
  resolved.writeLine(
    identityCommand
      ? `git identity: ${identityCommand}`
      : "git identity: skipped, the operator machine has no git user.name and user.email",
  );

  if (!input.yes) {
    resolved.progress.pause();
    const confirmed = await resolved.confirm();
    if (confirmed !== true) return null;
  }

  const progress = resolved.progress;
  let active = false;
  let tool = "";
  let result: InstallResult;
  try {
    result = await install.run(true, plan, (update) => {
      active = update.phase === "started";
      tool = update.tool;
      if (update.phase === "started") {
        progress.start(`Installing ${update.tool} (${update.current}/${update.total})`);
      } else {
        progress.done();
        // The installer output can hold a warning, such as the gh fallback to the latest version.
        for (const line of outputLines(update.stdout)) resolved.writeLine(`  ${line}`);
      }
    });
  } catch (error) {
    if (active) progress.fail();
    throw error;
  }
  if (!result.ok) {
    if (active) progress.fail();
    if (result.error.code === "confirmation-required") {
      fail(
        "operator/confirmation-required",
        "Install stopped because explicit confirmation was not accepted.",
        resolved.writeLine,
      );
    }
    failInstaller(tool, result.error, resolved.writeLine);
  }

  if (!identityCommand) {
    progress.skip("Setting the box git identity", "no operator git identity");
  } else {
    const identity = await step(
      progress,
      "Setting the box git identity",
      () => link.run(identityCommand),
      (outcome) => !outcome.ok,
    );
    if (!identity.ok) failLink("Install", identity.error, resolved.writeLine);
  }
  return { plan, gitIdentity: identityCommand && name !== null && email !== null ? { name, email } : null };
}

/** Returns null when the operator gives no login code. */
export async function runAuthCommand(
  given: AuthCommandInput,
  dependencies: Partial<AuthCommandDependencies> = {},
): Promise<AuthCommandResult | null> {
  const resolved = { ...defaultAuthDependencies, ...dependencies };
  const input = mcpProvider(given, resolved.tools, resolved.writeLine);
  if (input.provider === undefined) {
    const tools = resolved.readConfig()?.tools;
    const providers = authTools(resolved.tools).map((tool) => ({
      id: tool.id,
      login:
        effectivePolicy(tool, tools) === "off"
          ? ("off" as const)
          : tool.auth.completion.kind === "manual"
            ? ("manual" as const)
            : ("startable" as const),
    }));
    for (const provider of providers) {
      resolved.writeLine(`${provider.id}: ${provider.login === "manual" ? "manual SSH flow" : provider.login}`);
    }
    return { providers };
  }

  if (input.mcp !== undefined) {
    if (!resolved.tools.some((tool) => tool.id === input.provider && tool.mcp)) {
      fail(
        "operator/invalid-provider",
        `The ${input.provider} tool has no MCP login. Use claude, codex, or cursor.`,
        resolved.writeLine,
      );
    }
    const { target, config } = loadTarget(resolved.readConfig, resolved.writeLine);
    refuseOff(input.provider, resolved.tools, config, resolved.writeLine);
    const auth = resolved.createAuthStart(resolved.createLink(target), resolved.tools);
    const { provider, mcp } = input;
    const started = await step(
      resolved.progress,
      `Starting the ${provider}/${mcp} MCP login on the box`,
      () => auth.startMcp(provider, mcp),
      authFailed,
    );
    if (started.kind !== "local-port-forward") return reportAuth(started, resolved.writeLine);
    resolved.emit?.(loginEvent(started, { server: mcp }));
    resolved.writeLine(`URL: ${started.url}`);
    resolved.writeLine("Open the URL in a browser on this machine.");
    resolved.writeLine(forwardLine(started));
    const result = await step(
      resolved.progress,
      waitingStep(started.timeoutMs / 1000),
      () => untilInterrupt(resolved.onInterrupt, (signal) => auth.finishMcp(started, signal)),
      authFailed,
    );
    return reportAuth(result, resolved.writeLine);
  }

  if (!isAuthProvider(input.provider, resolved.tools)) {
    fail(
      "operator/invalid-provider",
      `Unknown auth provider: ${input.provider}.`,
      resolved.writeLine,
    );
  }

  const { target, config } = loadTarget(resolved.readConfig, resolved.writeLine);
  refuseOff(input.provider, resolved.tools, config, resolved.writeLine);
  const auth = resolved.createAuthStart(resolved.createLink(target), resolved.tools);
  const provider = input.provider;
  const started = await step(
    resolved.progress,
    `Starting the ${provider} login on the box`,
    () => auth.start(provider),
    authFailed,
  );
  const hasSetup = resolved.tools.some((tool) => tool.id === provider && tool.auth?.setup);
  if (
    started.kind !== "device-url" &&
    started.kind !== "printed-url" &&
    started.kind !== "local-port-forward" &&
    !(started.kind === "already-done" && hasSetup)
  ) {
    return reportAuth(started, resolved.writeLine);
  }
  let code: string | undefined;
  let waiting = `Checking the ${provider} setup on the box`;
  if (
    started.kind === "device-url" ||
    started.kind === "printed-url" ||
    started.kind === "local-port-forward"
  ) {
    resolved.emit?.(loginEvent(started));
    resolved.writeLine(`URL: ${started.url}`);
    if (started.kind === "device-url" && started.userCode) {
      resolved.writeLine(`Code: ${started.userCode}`);
      resolved.writeLine("Open the URL in a browser on this machine and enter the code.");
    } else if (started.kind === "local-port-forward") {
      resolved.writeLine("Open the URL in a browser on this machine.");
      resolved.writeLine(forwardLine(started));
    } else if (started.kind === "printed-url" && started.codeInput) {
      resolved.writeLine(
        "Open the URL in a browser on this machine. After the login, paste the code that the browser shows.",
      );
      // The prompt runs between steps, and pause() clears the progress line first.
      resolved.progress.pause();
      const answer = await resolved.readLoginCode();
      if (typeof answer !== "string") return null;
      code = answer.trim();
    } else {
      resolved.writeLine("Open the URL in a browser on this machine.");
    }
    const limit =
      started.kind === "local-port-forward" ? started.timeoutMs / 1000 : LOGIN_LIFETIME_S;
    waiting = waitingStep(limit);
  }
  const result = await step(
    resolved.progress,
    waiting,
    () =>
      started.kind === "local-port-forward"
        ? untilInterrupt(resolved.onInterrupt, (signal) => auth.finish(started, code, signal))
        : auth.finish(started, code),
    authFailed,
  );
  return reportAuth(result, resolved.writeLine);
}

const defaultInstallDependencies: InstallCommandDependencies = {
  tools: BUILTIN_TOOLS,
  readConfig,
  createLink: (options) => new Link(options),
  readOperatorGitIdentity: () =>
    readOperatorGitIdentity(new RealGitRunner(), join(homedir(), STORE_RELATIVE_PATH)),
  createInstall: (link, tools, config) => new Install(link, tools, config),
  progress: noProgress,
  confirm: () => prompts.confirm({ message: "Run these commands on the box?" }),
  writeLine: console.log,
  ferryVersion: VERSION,
};

const defaultAuthDependencies: AuthCommandDependencies = {
  tools: BUILTIN_TOOLS,
  readConfig,
  createLink: (options) => new Link(options),
  createAuthStart: (link, tools) => new AuthStart(link, tools),
  readLoginCode: () => prompts.password({ message: "Code from the browser" }),
  writeLine: console.log,
  progress: noProgress,
  onInterrupt: (stop) => {
    process.once("SIGINT", stop);
    return () => process.off("SIGINT", stop);
  },
};

/** The `login` event: the URL to open, and the code to enter or to write on stdin. */
function loginEvent(
  started: Extract<AuthStartResult, { kind: "device-url" | "printed-url" | "local-port-forward" }>,
  fields: { readonly server?: string } = {},
): OutputEvent {
  return {
    type: "login",
    provider: started.provider,
    ...fields,
    url: started.url,
    userCode: started.kind === "device-url" ? (started.userCode ?? null) : null,
    // The login waits for the code that the browser shows, as one line on stdin.
    codeRequired: started.kind === "printed-url" && started.codeInput !== undefined,
    localPort: started.kind === "local-port-forward" ? started.localPort : null,
    timeoutMs: started.kind === "local-port-forward" ? started.timeoutMs : null,
  };
}

function waitingStep(limitSeconds: number): string {
  return `Waiting for you to finish the login in the browser (up to ${Math.ceil(limitSeconds / 60)} min)`;
}

function forwardLine(started: Extract<AuthStartResult, { kind: "local-port-forward" }>): string {
  return `Ferry forwards local port ${started.localPort} to the box for up to ${started.timeoutMs / 1000} s and closes it when the login is done. Press Ctrl-C to stop early.`;
}

/** Run `work` with a signal that Ctrl-C aborts. Ctrl-C does not stop ferry during `work`. */
async function untilInterrupt<T>(
  onInterrupt: AuthCommandDependencies["onInterrupt"],
  work: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
  const controller = new AbortController();
  const stopListening = onInterrupt(() => controller.abort());
  try {
    return await work(controller.signal);
  } finally {
    stopListening();
  }
}

function loadTarget(
  read: () => PartialOperatorConfig | null,
  writeLine: (line: string) => void,
): { target: LinkOptions; config: PartialOperatorConfig | null } {
  let config: PartialOperatorConfig | null;
  try {
    config = read();
  } catch {
    fail("operator/invalid-config", "Could not read Ferry config. Run ferry init.", writeLine);
  }

  const target = resolveLinkOptions(config?.host);
  if (!target) {
    fail("operator/invalid-config", hasNoBox(config) ? missingBoxMessage(config) : "Ferry config has no complete host. Run ferry init.", writeLine);
  }
  return { target, config };
}

/**
 * `--mcp <provider>/<server>`, the name that `ferry status` shows, gives the
 * provider. `--mcp <server>` needs the provider argument.
 */
function mcpProvider(
  input: AuthCommandInput,
  tools: readonly ToolDescriptor[],
  writeLine: (line: string) => void,
): AuthCommandInput {
  if (input.mcp === undefined) return input;
  const slash = input.mcp.indexOf("/");
  const provider = input.mcp.slice(0, slash);
  if (slash !== -1 && (input.provider ?? provider) === provider && tools.some((tool) => tool.id === provider && tool.mcp)) {
    return { provider, mcp: input.mcp.slice(slash + 1) };
  }
  if (input.provider === undefined) {
    const providers = tools.filter((tool) => tool.mcp).map((tool) => tool.id).join(", ");
    fail(
      "operator/usage",
      `Give the provider: ferry auth <provider> --mcp ${input.mcp}, or ferry auth --mcp <provider>/${input.mcp}. The providers with an MCP login are ${providers}.`,
      writeLine,
    );
  }
  return input;
}

/** A tool with the policy `off` gets no login. The JSON code is `refused`. */
function refuseOff(
  provider: string,
  tools: readonly ToolDescriptor[],
  config: PartialOperatorConfig | null,
  writeLine: (line: string) => void,
): void {
  const tool = tools.find((candidate) => candidate.id === provider);
  if (tool === undefined || effectivePolicy(tool, config?.tools) !== "off") return;
  const message = `The ${provider} tool is off for this box, so Ferry does not log it in. Set another policy for ${provider} in [tools] or [box.<name>.tools] to turn it on.`;
  fail("operator/tool-off", message, writeLine, new FerryError("refused", message));
}

function authFailed(result: AuthStartResult): boolean {
  return result.kind === "link-failure" || result.kind === "failed" || result.kind === "refused";
}

function isAuthProvider(provider: string, tools: readonly ToolDescriptor[]): boolean {
  return tools.some((tool) => tool.id === provider && tool.auth);
}

function reportAuth(result: AuthStartResult, writeLine: (line: string) => void): AuthCommandResult {
  switch (result.kind) {
    case "already-done":
      writeLine(`${result.provider}: already authenticated`);
      for (const note of result.notes ?? []) writeLine(note);
      return result;
    case "logged-in":
      writeLine(`${result.provider}: logged in`);
      for (const note of result.notes ?? []) writeLine(note);
      return result;
    case "device-url":
      writeLine(`URL: ${result.url}`);
      if (result.userCode) writeLine(`Code: ${result.userCode}`);
      return result;
    case "printed-url":
      writeLine(`URL: ${result.url}`);
      return result;
    case "local-port-forward":
      writeLine(`URL: ${result.url}`);
      writeLine(`Local port: ${result.localPort}`);
      writeLine(`Timeout: ${result.timeoutMs} ms`);
      return result;
    case "manual-ssh":
      writeLine("pi: manual SSH flow");
      writeLine(result.instruction);
      return result;
    case "link-failure":
      failLink("AuthStart", result.result.error, writeLine);
    case "failed":
      fail(`box/${result.code}`, result.message, writeLine);
    case "refused":
      fail(`operator/${result.code}`, result.message, writeLine);
  }
}

function failLink(
  operation: "Install" | "AuthStart",
  error: LinkError,
  writeLine: (line: string) => void,
): never {
  fail(
    `${error.origin}/${error.code}`,
    `${operation} stopped because Link reported ${error.code} from ${error.origin}.`,
    writeLine,
  );
}

/**
 * Print the last lines of the output of a failed install command, such as
 * "unzip is required". The JSON error has them in `details`.
 */
function failInstaller(tool: string, error: LinkError, writeLine: (line: string) => void): never {
  if (error.output === undefined) failLink("Install", error, writeLine);
  const stderr = outputLines(error.output.stderr).slice(-OUTPUT_TAIL_LINES);
  const stdout = outputLines(error.output.stdout).slice(-OUTPUT_TAIL_LINES);
  for (const [name, lines] of [["stderr", stderr], ["stdout", stdout]] as const) {
    if (lines.length === 0) continue;
    writeLine(`The last lines of the ${tool} install ${name}:`);
    for (const line of lines) writeLine(`  ${line}`);
  }
  const message = `Install stopped because Link reported ${error.code} from ${error.origin}.`;
  fail(
    `${error.origin}/${error.code}`,
    message,
    writeLine,
    new FerryError("box-command-failed", message, { details: { tool, stderr, stdout } }),
  );
}

/** A `FerryError` in `cause` gives the JSON code. */
function fail(code: string, message: string, writeLine: (line: string) => void, cause?: FerryError): never {
  const safeMessage = `${code}: ${message}`;
  writeLine(safeMessage);
  throw new InstallAuthCommandError(safeMessage, code, cause ? { cause } : undefined);
}
