import * as prompts from "@clack/prompts";
import { homedir } from "node:os";
import { join } from "node:path";
import { AuthStart, authTools, type AuthLink, type AuthStartResult } from "./auth-start.ts";
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
import { BUILTIN_TOOLS } from "./registry/builtin.ts";
import type { ToolDescriptor } from "./registry/types.ts";
import { RealGitRunner } from "./store.ts";

const STORE_RELATIVE_PATH = ".ferry/store";

export type InstallCommandInput = { readonly yes: boolean };
export type AuthCommandInput = { readonly provider?: string };

type CommandLink = AuthLink;
type InstallCommand = {
  plan(): readonly InstallRecipe[];
  run(
    confirmed: boolean,
    reportProgress?: (progress: InstallProgress) => void,
  ): Promise<InstallResult>;
};
type AuthCommand = { start(provider: string): Promise<AuthStartResult> };

export type InstallProgressIndicator = {
  start(message: string): void;
  message(message: string): void;
  advance(step: number, message: string): void;
  stop(message: string): void;
  error(message: string): void;
};

export type InstallCommandDependencies = {
  /** The tools this ferry manages. The CLI resolves the registry once. */
  readonly tools: readonly ToolDescriptor[];
  readonly readConfig: () => PartialOperatorConfig | null;
  readonly createLink: (options: LinkOptions) => CommandLink;
  readonly readOperatorGitIdentity: () => Promise<GitIdentity>;
  readonly createInstall: (link: CommandLink, tools: readonly ToolDescriptor[]) => InstallCommand;
  readonly createProgress: (total: number) => InstallProgressIndicator;
  readonly confirm: () => Promise<boolean | symbol | undefined>;
  readonly writeLine: (line: string) => void;
};

export type AuthCommandDependencies = {
  /** The tools this ferry manages. The CLI resolves the registry once. */
  readonly tools: readonly ToolDescriptor[];
  readonly readConfig: () => PartialOperatorConfig | null;
  readonly createLink: (options: LinkOptions) => CommandLink;
  readonly createAuthStart: (link: CommandLink, tools: readonly ToolDescriptor[]) => AuthCommand;
  readonly writeLine: (line: string) => void;
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
    const confirmed = await resolved.confirm();
    if (confirmed !== true) return;
  }

  const progress = plan.length > 0 ? resolved.createProgress(plan.length) : undefined;
  let active: InstallProgress | undefined;
  let result: InstallResult;
  try {
    result = await install.run(true, (update) => {
      active = update;
      const message = `${update.phase === "started" ? "Installing" : "Installed"} ${update.tool} (${update.current}/${update.total})`;
      if (update.phase === "completed") {
        progress?.advance(1, message);
      } else if (update.current === 1) {
        progress?.start(message);
      } else {
        progress?.message(message);
      }
    });
  } catch (error) {
    progress?.error(installFailureMessage(active));
    throw error;
  }
  if (!result.ok) {
    progress?.error(installFailureMessage(active));
    if (result.error.code === "confirmation-required") {
      fail(
        "operator/confirmation-required",
        "Install stopped because explicit confirmation was not accepted.",
        resolved.writeLine,
      );
    }
    failLink("Install", result.error, resolved.writeLine);
  }
  progress?.stop(`Installed ${plan.length} tools`);

  if (identityCommand) {
    const identity = await link.run(identityCommand);
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

  if (!isAuthProvider(input.provider, resolved.tools)) {
    fail(
      "operator/invalid-provider",
      `Unknown auth provider: ${input.provider}.`,
      resolved.writeLine,
    );
  }

  const target = loadTarget(resolved.readConfig, resolved.writeLine);
  const auth = resolved.createAuthStart(resolved.createLink(target), resolved.tools);
  reportAuth(await auth.start(input.provider), resolved.writeLine);
}

const defaultInstallDependencies: InstallCommandDependencies = {
  tools: BUILTIN_TOOLS,
  readConfig,
  createLink: (options) => new Link(options),
  readOperatorGitIdentity: () =>
    readOperatorGitIdentity(new RealGitRunner(), join(homedir(), STORE_RELATIVE_PATH)),
  createInstall: (link, tools) => new Install(link, tools),
  createProgress: (total) => prompts.progress({ max: total }),
  confirm: () => prompts.confirm({ message: "Run these commands on the box?" }),
  writeLine: console.log,
};

function installFailureMessage(progress: InstallProgress | undefined): string {
  return progress
    ? `Failed to install ${progress.tool} (${progress.current}/${progress.total})`
    : "Install failed";
}

const defaultAuthDependencies: AuthCommandDependencies = {
  tools: BUILTIN_TOOLS,
  readConfig,
  createLink: (options) => new Link(options),
  createAuthStart: (link, tools) => new AuthStart(link, tools),
  writeLine: console.log,
};

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

function isAuthProvider(provider: string, tools: readonly ToolDescriptor[]): boolean {
  return tools.some((tool) => tool.id === provider && tool.auth);
}

function reportAuth(result: AuthStartResult, writeLine: (line: string) => void): void {
  switch (result.kind) {
    case "already-done":
      writeLine(`${result.provider}: already authenticated`);
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
