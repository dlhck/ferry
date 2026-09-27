/**
 * Update puts each managed tool on each selected box at the version that the
 * policy of that box selects, with the same rules as install. It changes a
 * tool only when the box version differs. On the operator machine it runs the
 * own update command of an agent CLI that is already there, once for all
 * boxes. It never installs a tool there.
 */

import * as prompts from "@clack/prompts";
import { resolveBoxes, type ResolvedBox } from "./boxes.ts";
import {
  completeHostConfig,
  readConfig,
  resolveLinkOptions,
  type PartialOperatorConfig,
  type ToolsConfig,
} from "./config.ts";
import { INTEGRATIONS, type Integration } from "./integrations/index.ts";
import { BunHostAdapter, Link, type HostAdapter, type LinkOptions } from "./link.ts";
import { noProgress, plural, step, type Progress } from "./progress.ts";
import { loadRegistry } from "./registry/load.ts";
import type { ToolDescriptor } from "./registry/types.ts";
import { outputLines } from "./install.ts";
import { describeStep, effectivePolicy, planTools, ToolPlanError, type ToolStep } from "./tools/resolve.ts";

const UPDATE_COMMAND_TIMEOUT_MS = 30 * 60 * 1_000;
const PROBE_TIMEOUT_MS = 10_000;

/** A tool on the operator machine: its update command, or why ferry skips it. */
export type OperatorUpdate =
  | { readonly tool: string; readonly command: string }
  | { readonly tool: string; readonly reason: "no own update command" | "not installed" };

export type UpdateCommandInput = {
  readonly yes: boolean;
  readonly dryRun: boolean;
  /** The --box selection. Empty selects all boxes. */
  readonly boxes?: readonly string[];
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

/** The operator machine gets only the installed agent CLIs, in registry order. */
export async function planOperator(tools: readonly ToolDescriptor[], local: HostAdapter): Promise<OperatorUpdate[]> {
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
  return operator;
}

/** One selected box: its link, its enabled integrations, and its plan or why Ferry could not reach it. */
type BoxUpdate = {
  readonly name: string;
  /** `[<name>] ` in front of each box line when more than one box is selected, else empty. */
  readonly prefix: string;
  readonly link: Pick<Link, "run">;
  readonly integrations: readonly Integration[];
  readonly plan: readonly ToolStep[];
  /** The link error when the box did not answer. Ferry then skips the box. */
  readonly offline: string | null;
};

/**
 * Update each selected box, one after the other, and the operator machine
 * once. The box gets the tools whose box version differs from the version
 * of its policy. A box that does not answer fails alone. The other boxes and
 * the operator machine still update, and the command fails at the end.
 */
export async function runUpdateCommand(
  input: UpdateCommandInput,
  dependencies: Partial<UpdateCommandDependencies> = {},
): Promise<void> {
  const resolved = { ...defaultDependencies, ...dependencies };
  const { config, boxes: selected } = loadBoxes(resolved.readConfig, input.boxes ?? []);
  const registered = resolved.tools ?? registryTools(config);
  const selectTools = (policies: ToolsConfig | undefined) =>
    input.latestOnly === true
      ? registered.filter((tool) => effectivePolicy(tool, policies) === "latest")
      : registered;
  const several = selected.length > 1;

  let boxes: BoxUpdate[];
  let operator: OperatorUpdate[];
  try {
    ({ boxes, operator } = await step(
      resolved.progress,
      "Checking the tool versions",
      async () => {
        const boxes: BoxUpdate[] = [];
        for (const box of selected) {
          const link = resolved.createLink(resolveLinkOptions(box.host));
          const probe = await link.run("true");
          const offline = probe.ok ? null : probe.error.message;
          boxes.push({
            name: box.name,
            prefix: several ? `[${box.name}] ` : "",
            link,
            integrations: input.includeIntegrations === true
              ? resolved.integrations.filter((integration) => box.integrations[integration.id] === true)
              : [],
            plan: offline === null ? await planTools("update", selectTools(box.tools), box.tools, resolved.local, link) : [],
            offline,
          });
        }
        return { boxes, operator: await planOperator(selectTools(config.tools), resolved.local) };
      },
      (plan) => plan.boxes.some((box) => box.offline !== null),
      (plan) => {
        const count = runnable(plan.boxes, plan.operator).length;
        const planned = plan.boxes.reduce((total, box) => total + box.plan.length, plan.operator.length);
        const offline = plan.boxes.filter((box) => box.offline !== null).length;
        return `${plural(count, "update")}, ${planned - count} skipped${offline > 0 ? `, ${plural(offline, "box", "boxes")} offline` : ""}`;
      },
    ));
  } catch (error) {
    if (error instanceof ToolPlanError) throw new UpdateError(`Update stopped before it changed anything. ${error.message}`);
    throw error;
  }
  const reached = boxes.filter((box) => box.offline === null);
  const steps = runnable(boxes, operator);
  const integrationCount = reached.reduce((total, box) => total + box.integrations.length, 0);
  resolved.progress.plan(input.dryRun ? 1 : 1 + steps.length + integrationCount);

  for (const box of boxes) {
    if (box.offline !== null) resolved.writeLine(`${box.prefix}Box offline, Ferry skips it: ${box.offline}`);
    for (const entry of box.plan) resolved.writeLine(`${box.prefix}Box ${entry.tool}: ${describeStep(entry)}`);
  }
  for (const entry of operator) {
    resolved.writeLine(
      "command" in entry ? `Operator ${entry.tool}: ${entry.command}` : `Operator ${entry.tool}: skipped, ${entry.reason}`,
    );
  }
  for (const box of reached) {
    for (const integration of box.integrations) {
      resolved.writeLine(`${box.prefix}Box ${integration.id}:`);
      for (const line of await integration.plan("update", box.link)) resolved.writeLine(`${box.prefix}  ${line}`);
    }
  }
  if (input.dryRun) return;
  if (!input.yes) {
    resolved.progress.pause();
    if ((await resolved.confirm()) !== true) {
      resolved.writeLine("Update cancelled.");
      return;
    }
  }

  const failed: string[] = boxes.flatMap((box) => (box.offline === null ? [] : [`${box.prefix}box offline`]));
  const failedOnBox = new Map(boxes.map((box) => [box.name, new Set<string>()]));
  for (const [index, step] of steps.entries()) {
    const name = `${step.box?.prefix ?? ""}${step.box === undefined ? "operator" : "box"} ${step.tool}`;
    const failedTools = step.box === undefined ? undefined : failedOnBox.get(step.box.name);
    const failedDependency = step.dependsOn.find((dependency) => failedTools?.has(dependency));
    if (failedDependency !== undefined) {
      resolved.progress.skip(`Updating ${name} (${index + 1}/${steps.length})`, `${failedDependency} failed`);
      failed.push(name);
      failedTools?.add(step.tool);
      resolved.writeLine(`Skipped ${name}: it depends on ${failedDependency}, which failed.`);
      continue;
    }
    resolved.progress.start(`Updating ${name} (${index + 1}/${steps.length})`);
    const { failure, stdout } =
      step.box === undefined
        ? await runOnOperator(resolved.local, step.command)
        : await runOnBox(step.box.link, step.command);
    if (failure === null) {
      resolved.progress.done();
      // The update output can hold a warning, such as the gh fallback to the latest version.
      for (const line of outputLines(stdout)) resolved.writeLine(`  ${line}`);
      resolved.writeLine(`Updated ${name}.`);
    } else {
      resolved.progress.fail(failure);
      failed.push(name);
      failedTools?.add(step.tool);
      resolved.writeLine(`Failed to update ${name}: ${failure}`);
    }
  }
  for (const box of reached) {
    for (const integration of box.integrations) {
      try {
        for (const line of await integration.update(box.link, resolved.progress)) resolved.writeLine(`${box.prefix}${line}`);
      } catch (error) {
        failed.push(`${box.prefix}box ${integration.id}`);
        resolved.writeLine(`Failed to update ${box.prefix}box ${integration.id}: ${messageOf(error)}`);
      }
    }
  }
  if (several) {
    for (const box of boxes) {
      const count = failed.filter((name) => name.startsWith(box.prefix)).length;
      resolved.writeLine(
        box.offline !== null
          ? `Box ${box.name}: failed, the box is offline.`
          : count > 0
            ? `Box ${box.name}: failed, ${plural(count, "update")} failed.`
            : `Box ${box.name}: done.`,
      );
    }
  }
  if (failed.length > 0) {
    throw new UpdateError(
      `${failed.length} of ${steps.length + integrationCount + boxes.length - reached.length} updates failed: ${failed.join(", ")}`,
    );
  }
}

/** The commands to run: the box changes of each box in `depends` order, then the operator updates. */
function runnable(boxes: readonly BoxUpdate[], operator: readonly OperatorUpdate[]): {
  /** The box of a box command. Undefined for an operator command. */
  readonly box?: BoxUpdate;
  readonly tool: string;
  readonly command: string;
  readonly dependsOn: readonly string[];
}[] {
  return [
    ...boxes.flatMap((box) =>
      box.plan.flatMap(({ tool, command, dependsOn }) => (command === undefined ? [] : [{ box, tool, command, dependsOn }])),
    ),
    ...operator.flatMap((entry) =>
      "command" in entry ? [{ tool: entry.tool, command: entry.command, dependsOn: [] }] : [],
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

function loadBoxes(
  read: () => PartialOperatorConfig | null,
  selection: readonly string[],
): { config: PartialOperatorConfig; boxes: ResolvedBox[] } {
  let config: PartialOperatorConfig | null;
  try {
    config = read();
  } catch {
    throw new UpdateError("Could not read Ferry config. Run ferry init.");
  }
  if (!config || (!config.boxes && !completeHostConfig(config.host))) {
    throw new UpdateError("Ferry config has no complete host. Run ferry init.");
  }
  return { config, boxes: resolveBoxes(config, selection) };
}

/** The builtin tools and the `[tools.<id>]` tables of the config, as `ferry update` in the CLI resolves them. */
function registryTools(config: PartialOperatorConfig): readonly ToolDescriptor[] {
  const registry = loadRegistry(config);
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
