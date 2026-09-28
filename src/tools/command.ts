/**
 * `ferry tools` lists the builtin tools and the tools that the config defines,
 * with the policy of each one and the version on the operator machine. With box
 * tables or a box selection, it also shows the policy of each selected box. It
 * reads this machine only. The box state is a part of `ferry status`.
 */

import { resolveBoxes } from "../boxes.ts";
import { readConfig, toolPolicy, type PartialOperatorConfig } from "../config.ts";
import { BunHostAdapter, type HostAdapter } from "../link.ts";
import { toolDefaults, type ToolDescriptor } from "../registry/types.ts";
import { readLocalVersion } from "./version.ts";

export type ToolsCommandDependencies = {
  readonly readConfig: () => PartialOperatorConfig | null;
  /** The registry tools. The CLI resolves the registry once. */
  readonly tools: readonly ToolDescriptor[];
  /** Runs the version commands on the operator machine. Tests inject a fake. */
  readonly local: HostAdapter;
  /** The --box selection. */
  readonly boxes?: readonly string[];
};

/** A version policy. `default` is true when the config sets none, so the default of the tool kind applies. */
export type ToolPolicyEntry = { readonly policy: string; readonly default: boolean };

export type ToolsReport = {
  readonly tools: readonly {
    readonly id: string;
    readonly name: string;
    readonly kind: string;
    readonly install: string;
    readonly policy: ToolPolicyEntry;
    /** The policy of each box, with box tables or a box selection. */
    readonly boxes: readonly ({ readonly name: string } & ToolPolicyEntry)[];
    /** The version on this machine, or null when this machine does not have the tool. */
    readonly operatorVersion: string | null;
  }[];
};

export async function runToolsCommand(
  dependencies: Pick<ToolsCommandDependencies, "tools"> & Partial<ToolsCommandDependencies>,
): Promise<ToolsReport> {
  const resolved = { ...defaultDependencies, ...dependencies };
  const operatorConfig = resolved.readConfig();
  const config = operatorConfig?.tools;
  const selection = resolved.boxes ?? [];
  const boxes = operatorConfig?.boxes || selection.length > 0 ? resolveBoxes(operatorConfig ?? {}, selection) : [];
  const versions = await Promise.all(resolved.tools.map((tool) => readLocalVersion(tool, resolved.local)));

  return {
    tools: resolved.tools.map((tool, index) => {
      const defaults = toolDefaults(tool);
      const policy = (tools: typeof config): ToolPolicyEntry => {
        const set = toolPolicy(tools, tool.id);
        return set === undefined ? { policy: defaults.policy, default: true } : { policy: set, default: false };
      };
      return {
        id: tool.id,
        name: tool.name ?? tool.id,
        kind: tool.kind ?? "agent",
        install: defaults.mode,
        policy: policy(config),
        boxes: boxes.map((box) => ({ name: box.name, ...policy(box.tools) })),
        operatorVersion: versions[index] ?? null,
      };
    }),
  };
}

/** The `ferry tools` table and its notes. */
export function toolsLines(report: ToolsReport): string[] {
  const boxes = report.tools[0]?.boxes.map((box) => box.name) ?? [];
  const policy = (entry: ToolPolicyEntry) => (entry.default ? `${entry.policy} (default)` : entry.policy);
  const rows = report.tools.map((tool) => [
    tool.id,
    tool.kind,
    tool.install,
    policy(tool.policy),
    ...tool.boxes.map(policy),
    tool.operatorVersion === null ? "no" : "yes",
    tool.operatorVersion ?? "-",
    tool.name,
  ]);
  const header = ["TOOL", "KIND", "INSTALL", "POLICY", ...boxes.map((box) => `BOX ${box}`), "OPERATOR", "VERSION", "NAME"];
  const lines = ["Tools", ...table([header, ...rows]).map((line) => `  ${line}`), ""];
  if (boxes.length === 0) return [...lines, "ferry tools reads this machine only. It does not connect to the box."];
  return [
    ...lines,
    "A BOX column shows the version policy of that box, not the version on the box.",
    "ferry tools reads this machine only. It does not connect to a box.",
  ];
}

const defaultDependencies: Omit<ToolsCommandDependencies, "tools"> = {
  readConfig,
  local: new BunHostAdapter(),
};

/** Pad each column to its widest cell. The last column is not padded. */
function table(rows: readonly (readonly string[])[]): string[] {
  const widths = rows[0]?.map((_, column) => Math.max(...rows.map((row) => row[column]?.length ?? 0))) ?? [];
  return rows.map((row) =>
    row.map((cell, column) => (column === row.length - 1 ? cell : cell.padEnd(widths[column] ?? 0))).join("  "),
  );
}
