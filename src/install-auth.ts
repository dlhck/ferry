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
import { readConfig, resolveLinkOptions, type PartialOperatorConfig } from "./config.ts";
import {
  readOperatorGitIdentity,
  setBoxGitIdentityCommand,
  type GitIdentity,
} from "./git-identity.ts";
import {
  Install,
  type InstallProgress,
  type InstallRecipe,
  type InstallResult,
} from "./install.ts";
import { Link, type LinkError, type LinkOptions } from "./link.ts";
import { noProgress, step, type Progress } from "./progress.ts";
import { BUILTIN_TOOLS } from "./registry/builtin.ts";
import type { ToolDescriptor } from "./registry/types.ts";
import { RealGitRunner } from "./store.ts";

const STORE_RELATIVE_PATH = ".ferry/store";

export type InstallCommandInput = { readonly yes: boolean };
export type AuthCommandInput = {
  readonly provider?: string;
  /** An MCP server on the box. The provider names the tool whose MCP login starts. */
  readonly mcp?: string;
};

type CommandLink = AuthLink;
type InstallCommand = {
  plan(): readonly InstallRecipe[];
  run(
    confirmed: boolean,
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
  readonly createInstall: (link: CommandLink, tools: readonly ToolDescriptor[]) => InstallCommand;
  readonly progress: Progress;
  readonly confirm: () => Promise<boolean | symbol | undefined>;
  readonly writeLine: (line: string) => void;
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
};

export class InstallAuthCommandError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InstallAuthCommandError";
  }
}

export async function runInstallCommand(
  input: InstallCommandInput,
  dependencies: Partial<InstallCommandDependencies> = {},
): Promise<void> {
  const resolved = { ...defaultInstallDependencies, ...dependencies };
  const target = loadTarget(resolved.readConfig, resolved.writeLine);
  const link = resolved.createLink(target);
  const install = resolved.createInstall(link, resolved.tools);

  const plan = install.plan();
  resolved.progress.plan(plan.length + 1);
  for (const recipe of plan) {
    resolved.writeLine(`${recipe.tool}: ${recipe.command}`);
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
    if (confirmed !== true) return;
  }

  const progress = resolved.progress;
  let active = false;
  let result: InstallResult;
  try {
    result = await install.run(true, (update) => {
      active = update.phase === "started";
      if (update.phase === "started") {
        progress.start(`Installing ${update.tool} (${update.current}/${update.total})`);
      } else {
        progress.done();
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
    failLink("Install", result.error, resolved.writeLine);
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
}

export async function runAuthCommand(
  input: AuthCommandInput,
  dependencies: Partial<AuthCommandDependencies> = {},
): Promise<void> {
  const resolved = { ...defaultAuthDependencies, ...dependencies };
  if (input.provider === undefined) {
    for (const tool of authTools(resolved.tools)) {
      const manual = tool.auth.completion.kind === "manual";
      resolved.writeLine(`${tool.id}: ${manual ? "manual SSH flow" : "startable"}`);
    }
    return;
  }

  if (input.mcp !== undefined) {
    if (!resolved.tools.some((tool) => tool.id === input.provider && tool.mcp)) {
      fail(
        "operator/invalid-provider",
        `The ${input.provider} tool has no MCP login. Use claude, codex, or cursor.`,
        resolved.writeLine,
      );
    }
    const target = loadTarget(resolved.readConfig, resolved.writeLine);
    const auth = resolved.createAuthStart(resolved.createLink(target), resolved.tools);
    const { provider, mcp } = input;
    const started = await step(
      resolved.progress,
      `Starting the ${provider}/${mcp} MCP login on the box`,
      () => auth.startMcp(provider, mcp),
      authFailed,
    );
    if (started.kind !== "local-port-forward") return reportAuth(started, resolved.writeLine);
    resolved.writeLine(`URL: ${started.url}`);
    resolved.writeLine("Open the URL in a browser on this machine.");
    resolved.writeLine(forwardLine(started));
    const result = await step(
      resolved.progress,
      waitingStep(started.timeoutMs / 1000),
      () => untilInterrupt(resolved.onInterrupt, (signal) => auth.finishMcp(started, signal)),
      authFailed,
    );
    reportAuth(result, resolved.writeLine);
    return;
  }

  if (!isAuthProvider(input.provider, resolved.tools)) {
    fail(
      "operator/invalid-provider",
      `Unknown auth provider: ${input.provider}.`,
      resolved.writeLine,
    );
  }

  const target = loadTarget(resolved.readConfig, resolved.writeLine);
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
      if (typeof answer !== "string") return;
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
  reportAuth(result, resolved.writeLine);
}

const defaultInstallDependencies: InstallCommandDependencies = {
  tools: BUILTIN_TOOLS,
  readConfig,
  createLink: (options) => new Link(options),
  readOperatorGitIdentity: () =>
    readOperatorGitIdentity(new RealGitRunner(), join(homedir(), STORE_RELATIVE_PATH)),
  createInstall: (link, tools) => new Install(link, tools),
  progress: noProgress,
  confirm: () => prompts.confirm({ message: "Run these commands on the box?" }),
  writeLine: console.log,
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
): LinkOptions {
  let config: PartialOperatorConfig | null;
  try {
    config = read();
  } catch {
    fail("operator/invalid-config", "Could not read Ferry config. Run ferry init.", writeLine);
  }

  const target = resolveLinkOptions(config?.host);
  if (!target) {
    fail("operator/invalid-config", "Ferry config has no complete host. Run ferry init.", writeLine);
  }
  return target;
}

function authFailed(result: AuthStartResult): boolean {
  return result.kind === "link-failure" || result.kind === "failed" || result.kind === "refused";
}

function isAuthProvider(provider: string, tools: readonly ToolDescriptor[]): boolean {
  return tools.some((tool) => tool.id === provider && tool.auth);
}

function reportAuth(result: AuthStartResult, writeLine: (line: string) => void): void {
  switch (result.kind) {
    case "already-done":
      writeLine(`${result.provider}: already authenticated`);
      for (const note of result.notes ?? []) writeLine(note);
      return;
    case "logged-in":
      writeLine(`${result.provider}: logged in`);
      for (const note of result.notes ?? []) writeLine(note);
      return;
    case "device-url":
      writeLine(`URL: ${result.url}`);
      if (result.userCode) writeLine(`Code: ${result.userCode}`);
      return;
    case "printed-url":
      writeLine(`URL: ${result.url}`);
      return;
    case "local-port-forward":
      writeLine(`URL: ${result.url}`);
      writeLine(`Local port: ${result.localPort}`);
      writeLine(`Timeout: ${result.timeoutMs} ms`);
      return;
    case "manual-ssh":
      writeLine("pi: manual SSH flow");
      writeLine(result.instruction);
      return;
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

function fail(code: string, message: string, writeLine: (line: string) => void): never {
  const safeMessage = `${code}: ${message}`;
  writeLine(safeMessage);
  throw new InstallAuthCommandError(safeMessage);
}
