import * as prompts from "@clack/prompts";
import { AuthStart, authTools, type AuthLink, type AuthStartResult } from "./auth-start.ts";
import { readConfig, type PartialOperatorConfig } from "./config.ts";
import { Install, type InstallRecipe, type InstallResult } from "./install.ts";
import { Link, type LinkError } from "./link.ts";
import { BUILTIN_TOOLS } from "./registry/builtin.ts";
import type { ToolDescriptor } from "./registry/types.ts";

export type InstallCommandInput = { readonly yes: boolean };
export type AuthCommandInput = { readonly provider?: string };

type CommandTarget = { readonly host: string; readonly user: string };
type CommandLink = AuthLink;
type InstallCommand = {
  plan(): readonly InstallRecipe[];
  run(confirmed: boolean): Promise<InstallResult>;
};
type AuthCommand = { start(provider: string): Promise<AuthStartResult> };

export type InstallCommandDependencies = {
  /** The tools this ferry manages. The CLI resolves the registry once. */
  readonly tools: readonly ToolDescriptor[];
  readonly readConfig: () => PartialOperatorConfig | null;
  readonly createLink: (options: CommandTarget) => CommandLink;
  readonly createInstall: (link: CommandLink, tools: readonly ToolDescriptor[]) => InstallCommand;
  readonly confirm: () => Promise<boolean | symbol | undefined>;
  readonly writeLine: (line: string) => void;
};

export type AuthCommandDependencies = {
  /** The tools this ferry manages. The CLI resolves the registry once. */
  readonly tools: readonly ToolDescriptor[];
  readonly readConfig: () => PartialOperatorConfig | null;
  readonly createLink: (options: CommandTarget) => CommandLink;
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
  const install = resolved.createInstall(resolved.createLink(target), resolved.tools);

  for (const recipe of install.plan()) {
    resolved.writeLine(`${recipe.tool}: ${recipe.command}`);
  }

  if (!input.yes) {
    const confirmed = await resolved.confirm();
    if (confirmed !== true) return;
  }

  const result = await install.run(true);
  if (!result.ok) {
    if (result.error.code === "confirmation-required") {
      fail(
        "operator/confirmation-required",
        "Install stopped because explicit confirmation was not accepted.",
        resolved.writeLine,
      );
    }
    failLink("Install", result.error, resolved.writeLine);
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
  createInstall: (link, tools) => new Install(link, tools),
  confirm: () => prompts.confirm({ message: "Run these commands on the box?" }),
  writeLine: console.log,
};

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
): CommandTarget {
  let config: PartialOperatorConfig | null;
  try {
    config = read();
  } catch {
    fail("operator/invalid-config", "Could not read Ferry config. Run ferry init.", writeLine);
  }

  const host = config?.host?.tailscale;
  const user = config?.host?.sshUser;
  if (!host || !user) {
    fail("operator/invalid-config", "Ferry config has no complete host. Run ferry init.", writeLine);
  }
  return { host, user };
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
