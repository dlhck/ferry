/**
 * Update puts each managed tool on the box at the version that its policy
 * selects, with the same rules as install. It changes a tool only when the box
 * version differs. On the operator machine it runs the own update command of
 * an agent CLI that is already there. It never installs a tool there.
 */

import * as prompts from "@clack/prompts";
import { readConfig, resolveLinkOptions, type PartialOperatorConfig, type ToolsConfig } from "./config.ts";
import { INTEGRATIONS, type Integration } from "./integrations/index.ts";
import { BunHostAdapter, Link, type HostAdapter, type LinkOptions } from "./link.ts";
import { noProgress, plural, step, type Progress } from "./progress.ts";
import { loadRegistry } from "./registry/load.ts";
import type { ToolDescriptor } from "./registry/types.ts";
import { outputLines } from "./install.ts";
import { describeStep, effectivePolicy, planTools, ToolPlanError, type ToolStep } from "./tools/resolve.ts";

const UPDATE_COMMAND_TIMEOUT_MS = 30 * 60 * 1_000;
const PROBE_TIMEOUT_MS = 10_000;

export type UpdateTarget = "box" | "operator";

/** A tool on the operator machine: its update command, or why ferry skips it. */
export type OperatorUpdate =
  | { readonly tool: string; readonly command: string }
  | { readonly tool: string; readonly reason: "no own update command" | "not installed" };

export type UpdatePlan = {
  /** Each tool on the box, in `depends` order. */
  readonly box: readonly ToolStep[];
  /** Each tool on the operator machine, in registry order. */
  readonly operator: readonly OperatorUpdate[];
};

export type UpdateCommandInput = {
  readonly yes: boolean;
  readonly dryRun: boolean;
  /**
   * Also update the enabled integrations. A restart stops the agents on the
   * box, so only `ferry update` sets it. `ferry watch` never does.
   */
  readonly includeIntegrations?: boolean;
  /**
   * Update only the tools whose policy is `latest`. `ferry watch` sets it, so
   * an `operator` or exact version changes only with `ferry update`.
   */
  readonly latestOnly?: boolean;
};

export type UpdateCommandDependencies = {
  /** The tools this ferry manages. Without them, update reads the registry of the config. */
  readonly tools?: readonly ToolDescriptor[];
  readonly integrations: readonly Integration[];
  readonly readConfig: () => PartialOperatorConfig | null;
  readonly createLink: (options: LinkOptions) => Pick<Link, "run">;
  /** Runs commands on the operator machine. Tests inject a recording fake. */
  readonly local: HostAdapter;
  readonly confirm: () => Promise<boolean | symbol | undefined>;
  readonly writeLine: (line: string) => void;
  readonly progress: Progress;
};

export class UpdateError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UpdateError";
  }
}

/**
 * The box gets the tools whose box version differs from the resolved version.
 * The operator machine gets only the installed agent CLIs. Throws
 * ToolPlanError when the box plan cannot run.
 */
export async function planUpdate(
  tools: readonly ToolDescriptor[],
  config: ToolsConfig | undefined,
  local: HostAdapter,
  box: Pick<Link, "run">,
): Promise<UpdatePlan> {
  const boxPlan = await planTools("update", tools, config, local, box);
  const operator: OperatorUpdate[] = [];
  for (const tool of tools) {
    if (tool.update?.binary === undefined) {
      operator.push({ tool: tool.id, reason: "no own update command" });
    } else if (!(await isInstalled(local, tool.update.binary))) {
      operator.push({ tool: tool.id, reason: "not installed" });
    } else {
      operator.push({ tool: tool.id, command: tool.update.command });
    }
  }
  return { box: boxPlan, operator };
}

export async function runUpdateCommand(
  input: UpdateCommandInput,
  dependencies: Partial<UpdateCommandDependencies> = {},
): Promise<void> {
  const resolved = { ...defaultDependencies, ...dependencies };
  const { target, config } = loadTarget(resolved.readConfig);
  const registered = resolved.tools ?? registryTools(config);
  const tools = input.latestOnly === true
    ? registered.filter((tool) => effectivePolicy(tool, config?.tools) === "latest")
    : registered;
  const integrations = input.includeIntegrations === true
    ? resolved.integrations.filter((integration) => config?.integrations?.[integration.id] === true)
    : [];
  const link = resolved.createLink(target);
  let plan: UpdatePlan;
  try {
    plan = await step(
      resolved.progress,
      "Checking the tool versions",
      () => planUpdate(tools, config?.tools, resolved.local, link),
      undefined,
      (plan) => `${plural(runnable(plan).length, "update")}, ${plan.box.length + plan.operator.length - runnable(plan).length} skipped`,
    );
  } catch (error) {
    if (error instanceof ToolPlanError) throw new UpdateError(`Update stopped before it changed anything. ${error.message}`);
    throw error;
  }
  const steps = runnable(plan);
  resolved.progress.plan(input.dryRun ? 1 : 1 + steps.length + integrations.length);

  for (const entry of plan.box) resolved.writeLine(`Box ${entry.tool}: ${describeStep(entry)}`);
  for (const entry of plan.operator) {
    resolved.writeLine(
      "command" in entry ? `Operator ${entry.tool}: ${entry.command}` : `Operator ${entry.tool}: skipped, ${entry.reason}`,
    );
  }
  for (const integration of integrations) {
    resolved.writeLine(`Box ${integration.id}:`);
    for (const line of await integration.plan("update")) resolved.writeLine(`  ${line}`);
  }
  if (input.dryRun) return;
  if (!input.yes) {
    resolved.progress.pause();
    if ((await resolved.confirm()) !== true) {
      resolved.writeLine("Update cancelled.");
      return;
    }
  }

  const failed: string[] = [];
  const failedOnBox = new Set<string>();
  for (const [index, step] of steps.entries()) {
    const name = `${step.target} ${step.tool}`;
    const failedDependency = step.dependsOn.find((dependency) => failedOnBox.has(dependency));
    if (failedDependency !== undefined) {
      resolved.progress.skip(`Updating ${name} (${index + 1}/${steps.length})`, `${failedDependency} failed`);
      failed.push(name);
      failedOnBox.add(step.tool);
      resolved.writeLine(`Skipped ${name}: it depends on ${failedDependency}, which failed.`);
      continue;
    }
    resolved.progress.start(`Updating ${name} (${index + 1}/${steps.length})`);
    const { failure, stdout } =
      step.target === "box"
        ? await runOnBox(link, step.command)
        : await runOnOperator(resolved.local, step.command);
    if (failure === null) {
      resolved.progress.done();
      // The update output can hold a warning, such as the gh fallback to the latest version.
      for (const line of outputLines(stdout)) resolved.writeLine(`  ${line}`);
      resolved.writeLine(`Updated ${name}.`);
    } else {
      resolved.progress.fail(failure);
      failed.push(name);
      if (step.target === "box") failedOnBox.add(step.tool);
      resolved.writeLine(`Failed to update ${name}: ${failure}`);
    }
  }
  for (const integration of integrations) {
    try {
      for (const line of await integration.update(link, resolved.progress)) resolved.writeLine(line);
    } catch (error) {
      failed.push(`box ${integration.id}`);
      resolved.writeLine(`Failed to update box ${integration.id}: ${messageOf(error)}`);
    }
  }
  if (failed.length > 0) {
    throw new UpdateError(
      `${failed.length} of ${steps.length + integrations.length} updates failed: ${failed.join(", ")}`,
    );
  }
}

/** The commands to run: the box changes in `depends` order, then the operator updates. */
function runnable(plan: UpdatePlan): {
  readonly target: UpdateTarget;
  readonly tool: string;
  readonly command: string;
  readonly dependsOn: readonly string[];
}[] {
  return [
    ...plan.box.flatMap(({ tool, command, dependsOn }) =>
      command === undefined ? [] : [{ target: "box" as const, tool, command, dependsOn }],
    ),
    ...plan.operator.flatMap((entry) =>
      "command" in entry ? [{ target: "operator" as const, tool: entry.tool, command: entry.command, dependsOn: [] }] : [],
    ),
  ];
}

const defaultDependencies: UpdateCommandDependencies = {
  integrations: INTEGRATIONS,
  readConfig,
  createLink: (options) => new Link(options),
  local: new BunHostAdapter(),
  confirm: () => prompts.confirm({ message: "Run these updates?" }),
  writeLine: console.log,
  progress: noProgress,
};

function loadTarget(read: () => PartialOperatorConfig | null): {
  target: LinkOptions;
  config: PartialOperatorConfig | null;
} {
  let config: PartialOperatorConfig | null;
  try {
    config = read();
  } catch {
    throw new UpdateError("Could not read Ferry config. Run ferry init.");
  }
  const target = resolveLinkOptions(config?.host);
  if (!target) throw new UpdateError("Ferry config has no complete host. Run ferry init.");
  return { target, config };
}

/** The builtin tools and the `[tools.<id>]` tables of the config, as `ferry update` in the CLI resolves them. */
function registryTools(config: PartialOperatorConfig | null): readonly ToolDescriptor[] {
  const registry = loadRegistry(config ?? {});
  if (!registry.ok) {
    throw new UpdateError(
      `ferry refused the registry: ${registry.problems.map((problem) => problem.reason).join("; ")}`,
    );
  }
  return registry.tools;
}

async function isInstalled(local: HostAdapter, binary: string): Promise<boolean> {
  try {
    const result = await local.run({ argv: ["sh", "-c", `command -v ${binary}`], timeoutMs: PROBE_TIMEOUT_MS });
    return result.exitCode === 0;
  } catch {
    return false;
  }
}

/** The failure message, or null on success, and the standard output. */
type CommandOutcome = { readonly failure: string | null; readonly stdout: string };

async function runOnBox(link: Pick<Link, "run">, command: string): Promise<CommandOutcome> {
  const result = await link.run(command, { timeoutMs: UPDATE_COMMAND_TIMEOUT_MS });
  return result.ok ? { failure: null, stdout: result.stdout } : { failure: result.error.message, stdout: "" };
}

async function runOnOperator(local: HostAdapter, command: string): Promise<CommandOutcome> {
  try {
    const result = await local.run({ argv: ["sh", "-c", command], timeoutMs: UPDATE_COMMAND_TIMEOUT_MS });
    if (result.timedOut) return { failure: "the command timed out", stdout: "" };
    if (result.exitCode === 0) return { failure: null, stdout: result.stdout };
    return {
      failure: result.stderr.trim() || result.stdout.trim() || `the command exited with ${result.exitCode}`,
      stdout: "",
    };
  } catch (error) {
    return { failure: messageOf(error), stdout: "" };
  }
}

function messageOf(error: unknown): string {
  return error instanceof Error && error.message ? error.message : String(error);
}
