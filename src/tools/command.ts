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
  readonly writeLine: (line: string) => void;
  /** The --box selection. */
  readonly boxes?: readonly string[];
};

export async function runToolsCommand(
  dependencies: Pick<ToolsCommandDependencies, "tools"> & Partial<ToolsCommandDependencies>,
): Promise<void> {
  const resolved = { ...defaultDependencies, ...dependencies };
  const operatorConfig = resolved.readConfig();
  const config = operatorConfig?.tools;
  const selection = resolved.boxes ?? [];
  const boxes = operatorConfig?.boxes || selection.length > 0 ? resolveBoxes(operatorConfig ?? {}, selection) : [];
  const versions = await Promise.all(resolved.tools.map((tool) => readLocalVersion(tool, resolved.local)));

  const rows = resolved.tools.map((tool, index) => {
    const defaults = toolDefaults(tool);
    const policy = (tools: typeof config) => toolPolicy(tools, tool.id) ?? `${defaults.policy} (default)`;
    const version = versions[index] ?? null;
    return [
      tool.id,
      tool.kind ?? "agent",
      defaults.mode,
      policy(config),
      ...boxes.map((box) => policy(box.tools)),
      version === null ? "no" : "yes",
      version ?? "-",
      tool.name ?? tool.id,
    ];
  });
  resolved.writeLine("Tools");
  const header = ["TOOL", "KIND", "INSTALL", "POLICY", ...boxes.map((box) => `BOX ${box.name}`), "OPERATOR", "VERSION", "NAME"];
  for (const line of table([header, ...rows])) {
    resolved.writeLine(`  ${line}`);
  }

  resolved.writeLine("");
  if (boxes.length === 0) {
    resolved.writeLine("ferry tools reads this machine only. It does not connect to the box.");
    return;
  }
  resolved.writeLine("A BOX column shows the version policy of that box, not the version on the box.");
  resolved.writeLine("ferry tools reads this machine only. It does not connect to a box.");
}

const defaultDependencies: Omit<ToolsCommandDependencies, "tools"> = {
  readConfig,
  local: new BunHostAdapter(),
  writeLine: console.log,
};

/** Pad each column to its widest cell. The last column is not padded. */
function table(rows: readonly (readonly string[])[]): string[] {
  const widths = rows[0]?.map((_, column) => Math.max(...rows.map((row) => row[column]?.length ?? 0))) ?? [];
  return rows.map((row) =>
    row.map((cell, column) => (column === row.length - 1 ? cell : cell.padEnd(widths[column] ?? 0))).join("  "),
  );
}
