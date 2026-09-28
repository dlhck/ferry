/**
 * Resolve the version policy of each tool and plan what `ferry install` and
 * `ferry update` do on the box.
 *
 * `off` skips the tool. `operator` is the version on the operator machine. A mirror tool that the
 * operator machine does not have is skipped, and an always tool falls back to
 * its latest recipe. `latest` is the latest recipe of a builtin tool, or the
 * output of the `latest` command of a tool that the config defines. Any other
 * policy is an exact version.
 */

import { toolPolicy, type ToolsConfig } from "../config.ts";
import type { HostAdapter, Link } from "../link.ts";
import { toolDefaults, type ToolDescriptor, type ToolPolicy } from "../registry/types.ts";
import { readBoxVersion, readLocalVersion } from "./version.ts";

/**
 * `version` is the version to put on the box. It is null when ferry runs the
 * latest recipe of a builtin tool and does not know the version first.
 */
export type ResolvedVersion =
  | { readonly kind: "version"; readonly policy: ToolPolicy; readonly version: string | null }
  | { readonly kind: "skip"; readonly policy: ToolPolicy; readonly reason: "not on the operator machine" | "off" }
  | { readonly kind: "refused"; readonly policy: ToolPolicy; readonly reason: string };

/**
 * `skip-off`: the policy is `off`, so Ferry does not manage the tool.
 * `skip-dev-build`: this Ferry is a development build, so Ferry puts no Ferry on the box.
 */
export type ToolAction = "install" | "update" | "skip-same" | "skip-not-on-operator" | "skip-off" | "skip-dev-build";

/** One tool in the plan. `command` is set for `install` and `update`. */
export type ToolStep = {
  readonly tool: string;
  readonly policy: ToolPolicy;
  readonly version: string | null;
  readonly action: ToolAction;
  readonly command?: string;
  readonly dependsOn: readonly string[];
};

/** The plan cannot run. The message names each tool and what to change. */
export class ToolPlanError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ToolPlanError";
  }
}

/** The policy that the config sets for the tool, or the default of its kind. */
export function effectivePolicy(tool: ToolDescriptor, config: ToolsConfig | undefined): ToolPolicy {
  return toolPolicy(config, tool.id) ?? toolDefaults(tool).policy;
}

export async function resolveToolVersion(
  tool: ToolDescriptor,
  config: ToolsConfig | undefined,
  local: HostAdapter,
): Promise<ResolvedVersion> {
  const policy = effectivePolicy(tool, config);
  if (policy === "off") return { kind: "skip", policy, reason: "off" };
  if (policy === "operator") {
    const version = await readLocalVersion(tool, local);
    if (version !== null) return { kind: "version", policy, version };
    if (toolDefaults(tool).mode === "mirror") return { kind: "skip", policy, reason: "not on the operator machine" };
    return latest(tool, policy, local);
  }
  if (policy === "latest") return latest(tool, policy, local);
  return { kind: "version", policy, version: policy };
}

async function latest(tool: ToolDescriptor, policy: ToolPolicy, local: HostAdapter): Promise<ResolvedVersion> {
  if (tool.latestVersion !== undefined) {
    const version = await readLocalVersion({ localVersion: tool.latestVersion }, local);
    if (version !== null) return { kind: "version", policy, version };
    return {
      kind: "refused",
      policy,
      reason: `the latest command of ${tool.id} printed no version on this machine: ${tool.latestVersion}`,
    };
  }
  if (tool.install !== undefined) return { kind: "version", policy, version: null };
  return {
    kind: "refused",
    policy,
    reason: `${tool.id} has the policy "latest" but no latest command. Add latest = "<command that prints the newest version>" to [tools.${tool.id}], or use another policy.`,
  };
}

/**
 * Plan each tool in `depends` order. A tool whose box version equals the
 * resolved version is skipped. `update` updates a tool that the box has and
 * installs a tool that the box lacks. The plan is refused when a tool is
 * refused, or when a tool to change depends on a tool that the operator
 * machine does not have.
 */
export async function planTools(
  purpose: "install" | "update",
  tools: readonly ToolDescriptor[],
  config: ToolsConfig | undefined,
  local: HostAdapter,
  box: Pick<Link, "run">,
): Promise<ToolStep[]> {
  const ordered = dependencyOrder(tools);
  const resolved = await Promise.all(ordered.map((tool) => resolveToolVersion(tool, config, local)));
  const refused = resolved.flatMap((entry) => (entry.kind === "refused" ? [entry.reason] : []));
  if (refused.length > 0) throw new ToolPlanError(refused.join(" "));

  const steps: ToolStep[] = [];
  for (const [index, tool] of ordered.entries()) {
    const entry = resolved[index];
    if (entry === undefined || entry.kind === "refused") continue;
    const base = { tool: tool.id, policy: entry.policy, dependsOn: tool.dependsOn ?? [] };
    if (entry.kind === "skip") {
      steps.push({ ...base, version: null, action: entry.reason === "off" ? "skip-off" : "skip-not-on-operator" });
      continue;
    }
    const { version } = entry;
    // The box is read in sequence, so a long plan does not open many SSH sessions at once.
    const onBox = await readBoxVersion(tool, box);
    if (version !== null && onBox === version) {
      steps.push({ ...base, version, action: "skip-same" });
      continue;
    }
    const action = purpose === "update" && onBox !== null ? "update" : "install";
    steps.push({ ...base, version, action, command: command(tool, action, version) });
  }

  const byId = new Map(steps.map((step) => [step.tool, step]));
  const blocked = steps.flatMap((step) =>
    step.command === undefined
      ? []
      : step.dependsOn.flatMap((dependency) => {
          const action = byId.get(dependency)?.action;
          if (action === "skip-not-on-operator") {
            return [
              `${step.tool} depends on ${dependency}, which is not on the operator machine. Install ${dependency} on this machine, or remove ${dependency} from depends of ${step.tool}.`,
            ];
          }
          if (action === "skip-off") {
            return [`${step.tool} depends on ${dependency}, which is off. Set another policy for ${dependency}, or remove ${dependency} from depends of ${step.tool}.`];
          }
          return [];
        }),
  );
  if (blocked.length > 0) throw new ToolPlanError(blocked.join(" "));
  return steps;
}

/**
 * A version recipe when the tool has one and the version is known. Else the
 * latest recipe: the update command, or the install command.
 */
function command(tool: ToolDescriptor, action: "install" | "update", version: string | null): string {
  if (version !== null && tool.recipe) return tool.recipe[action](version);
  const latestRecipe = action === "update" ? (tool.update ?? tool.install) : tool.install;
  // Each builtin tool has an install command, and each config tool has a version recipe.
  return latestRecipe?.command ?? "";
}

/** The tools with each dependency first. The registry refused cycles. Other tools keep their order. */
function dependencyOrder(tools: readonly ToolDescriptor[]): ToolDescriptor[] {
  const byId = new Map(tools.map((tool) => [tool.id, tool]));
  const ordered: ToolDescriptor[] = [];
  const seen = new Set<string>();
  const visit = (tool: ToolDescriptor): void => {
    if (seen.has(tool.id)) return;
    seen.add(tool.id);
    for (const dependency of tool.dependsOn ?? []) {
      const known = byId.get(dependency);
      if (known) visit(known);
    }
    ordered.push(tool);
  };
  for (const tool of tools) visit(tool);
  return ordered;
}

/** The plan line of one step, after the tool id. */
export function describeStep(step: ToolStep): string {
  const policy = `(policy ${step.policy})`;
  switch (step.action) {
    case "skip-same":
      return `skipped, the box has ${step.version} ${policy}`;
    case "skip-not-on-operator":
      return `skipped, not on the operator machine ${policy}`;
    case "skip-off":
      return `skipped, Ferry does not manage it ${policy}`;
    case "skip-dev-build":
      return `skipped, this Ferry is a development build without a release version ${policy}`;
    default:
      return `${step.action} ${step.version ?? "latest"} ${policy}: ${step.command}`;
  }
}
