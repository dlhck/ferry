/**
 * Update runs the update command of every managed tool on the box and on the
 * operator machine. On the operator machine it updates only a tool that is
 * already there. It never installs one.
 */

import * as prompts from "@clack/prompts";
import { readConfig, resolveLinkOptions, type PartialOperatorConfig } from "./config.ts";
import { BunHostAdapter, Link, type HostAdapter, type LinkOptions } from "./link.ts";
import { BUILTIN_TOOLS } from "./registry/builtin.ts";
import type { ToolDescriptor } from "./registry/types.ts";

const UPDATE_COMMAND_TIMEOUT_MS = 30 * 60 * 1_000;
const PROBE_TIMEOUT_MS = 10_000;

export type UpdateTarget = "box" | "operator";

export type UpdateStep = {
  readonly target: UpdateTarget;
  readonly tool: string;
  readonly command: string;
};

export type UpdateSkip = {
  readonly target: UpdateTarget;
  readonly tool: string;
  readonly reason: "no update command" | "no own update command" | "not installed";
};

export type UpdatePlan = {
  readonly steps: readonly UpdateStep[];
  readonly skipped: readonly UpdateSkip[];
};

export type UpdateCommandInput = { readonly yes: boolean; readonly dryRun: boolean };

export type UpdateCommandDependencies = {
  /** The tools this ferry manages. */
  readonly tools: readonly ToolDescriptor[];
  readonly readConfig: () => PartialOperatorConfig | null;
  readonly createLink: (options: LinkOptions) => Pick<Link, "run">;
  /** Runs commands on the operator machine. Tests inject a recording fake. */
  readonly local: HostAdapter;
  readonly confirm: () => Promise<boolean | symbol | undefined>;
  readonly writeLine: (line: string) => void;
};

export class UpdateError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UpdateError";
  }
}

/** The box gets every update command. The operator machine gets only the installed tools. */
export async function planUpdate(
  tools: readonly ToolDescriptor[],
  local: HostAdapter,
): Promise<UpdatePlan> {
  const steps: UpdateStep[] = [];
  const skipped: UpdateSkip[] = [];
  for (const tool of tools) {
    if (tool.update) steps.push({ target: "box", tool: tool.id, command: tool.update.command });
    else skipped.push({ target: "box", tool: tool.id, reason: "no update command" });
  }
  for (const tool of tools) {
    if (!tool.update) {
      skipped.push({ target: "operator", tool: tool.id, reason: "no update command" });
    } else if (tool.update.binary === undefined) {
      skipped.push({ target: "operator", tool: tool.id, reason: "no own update command" });
    } else if (!(await isInstalled(local, tool.update.binary))) {
      skipped.push({ target: "operator", tool: tool.id, reason: "not installed" });
    } else {
      steps.push({ target: "operator", tool: tool.id, command: tool.update.command });
    }
  }
  return { steps, skipped };
}

export async function runUpdateCommand(
  input: UpdateCommandInput,
  dependencies: Partial<UpdateCommandDependencies> = {},
): Promise<void> {
  const resolved = { ...defaultDependencies, ...dependencies };
  const target = loadTarget(resolved.readConfig);
  const plan = await planUpdate(resolved.tools, resolved.local);

  // One line for each tool on each side, in registry order.
  for (const side of ["box", "operator"] as const) {
    for (const tool of resolved.tools) {
      const step = plan.steps.find((entry) => entry.target === side && entry.tool === tool.id);
      const skip = plan.skipped.find((entry) => entry.target === side && entry.tool === tool.id);
      if (step) resolved.writeLine(`${label(side)} ${tool.id}: ${step.command}`);
      if (skip) resolved.writeLine(`${label(side)} ${tool.id}: skipped, ${skip.reason}`);
    }
  }
  if (input.dryRun) return;
  if (!input.yes && (await resolved.confirm()) !== true) {
    resolved.writeLine("Update cancelled.");
    return;
  }

  const link = resolved.createLink(target);
  const failed: UpdateStep[] = [];
  for (const step of plan.steps) {
    const failure =
      step.target === "box"
        ? await runOnBox(link, step.command)
        : await runOnOperator(resolved.local, step.command);
    if (failure === null) {
      resolved.writeLine(`Updated ${step.target} ${step.tool}.`);
    } else {
      failed.push(step);
      resolved.writeLine(`Failed to update ${step.target} ${step.tool}: ${failure}`);
    }
  }
  if (failed.length > 0) {
    throw new UpdateError(
      `${failed.length} of ${plan.steps.length} updates failed: ${failed
        .map((step) => `${step.target} ${step.tool}`)
        .join(", ")}`,
    );
  }
}

const defaultDependencies: UpdateCommandDependencies = {
  tools: BUILTIN_TOOLS,
  readConfig,
  createLink: (options) => new Link(options),
  local: new BunHostAdapter(),
  confirm: () => prompts.confirm({ message: "Run these updates?" }),
  writeLine: console.log,
};

function label(target: UpdateTarget): string {
  return target === "box" ? "Box" : "Operator";
}

function loadTarget(read: () => PartialOperatorConfig | null): LinkOptions {
  let config: PartialOperatorConfig | null;
  try {
    config = read();
  } catch {
    throw new UpdateError("Could not read Ferry config. Run ferry init.");
  }
  const target = resolveLinkOptions(config?.host);
  if (!target) throw new UpdateError("Ferry config has no complete host. Run ferry init.");
  return target;
}

async function isInstalled(local: HostAdapter, binary: string): Promise<boolean> {
  try {
    const result = await local.run({ argv: ["sh", "-c", `command -v ${binary}`], timeoutMs: PROBE_TIMEOUT_MS });
    return result.exitCode === 0;
  } catch {
    return false;
  }
}

/** Returns null on success, or the failure message. */
async function runOnBox(link: Pick<Link, "run">, command: string): Promise<string | null> {
  const result = await link.run(command, { timeoutMs: UPDATE_COMMAND_TIMEOUT_MS });
  return result.ok ? null : result.error.message;
}

/** Returns null on success, or the failure message. */
async function runOnOperator(local: HostAdapter, command: string): Promise<string | null> {
  try {
    const result = await local.run({ argv: ["sh", "-c", command], timeoutMs: UPDATE_COMMAND_TIMEOUT_MS });
    if (result.timedOut) return "the command timed out";
    if (result.exitCode === 0) return null;
    return result.stderr.trim() || result.stdout.trim() || `the command exited with ${result.exitCode}`;
  } catch (error) {
    return error instanceof Error && error.message ? error.message : String(error);
  }
}
