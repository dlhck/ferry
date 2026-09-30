/** `ferry box list`, `ferry box add`, `ferry box remove`, and `ferry box default`. */

import { boxUninstallLines, commitBoxUninstall, planBoxUninstall, type BoxUninstallPlan } from "./box-uninstall.ts";
import { resolveBoxes, resolveTargetBox, type ResolvedBox } from "./boxes.ts";
import {
  ConfigError,
  ConfigMissingError,
  isBoxName,
  resolveLinkOptions,
  withBoxes,
  type BoxConfig,
  type BoxesOperatorConfig,
  type GitAuth,
  type OperatorHostConfig,
  type PartialOperatorConfig,
} from "./config.ts";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { boxInstructionsSource } from "./box-identity.ts";
import { FerryError } from "./errors.ts";
import { boxCheckSteps, checkBoxAccess, type InitDependencies, type InitLink } from "./init.ts";
import type { LinkOptions } from "./link.ts";
import { step, type Progress } from "./progress.ts";
import type { HarnessDescriptor } from "./registry/types.ts";

export type BoxCommandDependencies = {
  /** The operator home, for the per-box instruction file of `ferry box add`. */
  readonly home: string;
  readonly readConfig: () => PartialOperatorConfig | null;
  readonly writeConfig: (config: BoxesOperatorConfig) => void;
  readonly createLink: (options: LinkOptions) => InitLink;
  readonly checkAgent?: InitDependencies["checkAgent"];
  readonly approveHostKeys?: InitDependencies["approveHostKeys"];
  readonly confirm: (message: string) => Promise<boolean | symbol | undefined>;
  readonly writeLine: (line: string) => void;
  /** Records a warning for the --json envelope. The warning line also goes to `writeLine`. */
  readonly warn?: (line: string) => void;
  readonly progress: Progress;
};

/** A box of `ferry box list`. `default` is true for the box of a command without --box. */
export type BoxListEntry = {
  readonly name: string;
  readonly transport: "tailscale" | "ssh";
  readonly destination: string;
  readonly default: boolean;
};

export type BoxListResult = { readonly boxes: readonly BoxListEntry[] };

/**
 * The box that `ferry box add` added. `migrated` is true when the `[host]` table
 * moved to `[box.default]`. `instructionFile` is the per-box instruction file on
 * the operator machine.
 */
export type BoxAddResult = {
  readonly name: string;
  readonly transport: "tailscale" | "ssh";
  readonly destination: string;
  readonly gitAuth: GitAuth;
  readonly migrated: boolean;
  readonly instructionFile: string;
};

export type BoxAddInput = {
  readonly name: string;
  readonly host?: string;
  readonly sshUser?: string;
  readonly sshDestination?: string;
  /** `git_auth` of the new box. Without it, the box forwards the operator agent. */
  readonly gitAuth?: GitAuth;
  /** Change a `[host]` config to box tables without a question. */
  readonly yes: boolean;
};

export type BoxRemoveResult = { readonly name: string; readonly defaultBoxRemoved: boolean };

export type BoxUninstallDependencies = Pick<
  BoxCommandDependencies,
  "readConfig" | "writeConfig" | "createLink" | "writeLine" | "warn" | "progress"
> & {
  /** The harnesses of the registry. Ferry reads their skill roots, instruction files, and extra roots on the box. */
  readonly harnesses: readonly HarnessDescriptor[];
  /** Asks the operator to type the box name. Returns the text. */
  readonly confirmName: (message: string) => Promise<string | symbol | undefined>;
};

/**
 * The result of `ferry box remove --uninstall`. `remaining` has the names that
 * stay in `~/.ferry` on the box. A dry run changes nothing, so its
 * `defaultBoxRemoved` is false and its `remaining` is empty.
 */
export type BoxUninstallResult = BoxRemoveResult & {
  readonly uninstall: { readonly dryRun: boolean; readonly plan: BoxUninstallPlan; readonly remaining: readonly string[] };
};

/** The name of the `[host]` box after `ferry box add` moves it to a box table. */
const MIGRATED_BOX = "default";

type Dependencies<Keys extends keyof BoxCommandDependencies> = Pick<BoxCommandDependencies, Keys>;

/** Each box: name, transport, destination, and whether a command without --box uses it. */
export function runBoxList(dependencies: Dependencies<"readConfig">): BoxListResult {
  const config = readComplete(dependencies.readConfig);
  const boxes = resolveBoxes(config);
  const target = boxes.length === 1 ? boxes[0]?.name : config.defaultBox;
  return {
    boxes: boxes.map((box) => ({
      name: box.name,
      transport: transport(box.host),
      destination: destination(box.host),
      default: box.name === target,
    })),
  };
}

/** One line per box, as a table. */
export function boxListLines(result: BoxListResult): string[] {
  const rows = [
    ["Box", "Transport", "Destination", "Default"],
    ...result.boxes.map((box) => [box.name, box.transport, box.destination, box.default ? "yes" : ""]),
  ];
  const widths = rows[0]?.map((_, column) => Math.max(...rows.map((row) => row[column]?.length ?? 0))) ?? [];
  return rows.map((row) => row.map((cell, column) => cell.padEnd(widths[column] ?? 0)).join("  ").trimEnd());
}

/**
 * Check a new box like `ferry init` does, then write its `[box.<name>]` table.
 * A `[host]` config becomes `[box.default]` plus the new box, with
 * `default_box = "default"`, so single-target commands still reach the old host.
 * Returns null when the operator cancels at the prompt.
 */
export async function runBoxAdd(input: BoxAddInput, dependencies: BoxCommandDependencies): Promise<BoxAddResult | null> {
  if (!isBoxName(input.name)) throw new ConfigError(invalidName(input.name));
  const host = hostOf(input);
  const config = readComplete(dependencies.readConfig);
  const existing = resolveBoxes(config);
  if (existing.some((box) => box.name === input.name)) {
    throw new ConfigError(`box ${input.name} is already in the config. Use another name, or ferry box remove ${input.name} first.`);
  }
  const migrate = config.boxes === undefined;
  dependencies.writeLine(`Add box ${input.name}: ${transport(host)} ${destination(host)}`);
  if (migrate) {
    dependencies.writeLine(
      `The config has a [host] table. Ferry moves it to [box.${MIGRATED_BOX}], adds [box.${input.name}], and sets default_box = "${MIGRATED_BOX}".`,
    );
    dependencies.writeLine(
      "install, auth, move, tunnel, and integrations enable|disable still use the old host when you give no --box.",
    );
    if (!input.yes) {
      dependencies.progress.pause();
      if ((await dependencies.confirm(`Change the config and add box ${input.name}?`)) !== true) {
        dependencies.writeLine("Box add cancelled.");
        return null;
      }
    }
  }

  const snapshotUrl = config.snapshotUrl as string;
  dependencies.progress.plan(boxCheckSteps(snapshotUrl, input.gitAuth));
  await checkBoxAccess(dependencies.createLink(resolveLinkOptions(host)), snapshotUrl, dependencies, input.gitAuth);

  const boxes: BoxConfig[] = [
    ...(config.boxes ?? existing.map(({ name, host }) => ({ name, host }))),
    { name: input.name, host, ...(input.gitAuth !== undefined ? { gitAuth: input.gitAuth } : {}) },
  ];
  dependencies.writeConfig(withBoxes(config, boxes, migrate ? MIGRATED_BOX : config.defaultBox));
  dependencies.writeLine(`Added box ${input.name}.`);
  const instructionFile = join(dependencies.home, boxInstructionsSource(input.name));
  mkdirSync(dirname(instructionFile), { recursive: true });
  // A file from before, for example of a removed box with this name, keeps its text.
  writeFileSync(instructionFile, "", { flag: "a" });
  dependencies.writeLine(
    `Instructions for this box only: ${instructionFile}. Ferry puts its text into the instruction file of the box, after the Ferry header and before your ~/AGENTS.md.`,
  );
  return {
    name: input.name,
    transport: transport(host),
    destination: destination(host),
    gitAuth: input.gitAuth ?? "agent",
    migrated: migrate,
    instructionFile,
  };
}

/** Write the config without the box. Ferry does not connect to the box and does not change it. */
export function runBoxRemove(
  input: { readonly name: string },
  dependencies: Dependencies<"readConfig" | "writeConfig" | "writeLine" | "warn">,
): BoxRemoveResult {
  const config = readComplete(dependencies.readConfig);
  removableBox(config, input.name);
  return removeFromConfig(config, input.name, dependencies, "Ferry did not change the box.");
}

/**
 * `ferry box remove <name> --uninstall`: read the box, print the plan, ask for
 * the box name, remove Ferry from the box, then write the config without the
 * box. A box that Ferry cannot read, or a failed removal, leaves the config as
 * it is. Returns null when the operator does not type the box name.
 */
export async function runBoxUninstall(
  input: { readonly name: string; readonly yes: boolean; readonly dryRun: boolean },
  dependencies: BoxUninstallDependencies,
): Promise<BoxUninstallResult | null> {
  const { name } = input;
  const box = removableBox(readComplete(dependencies.readConfig), name);
  const link = dependencies.createLink(resolveLinkOptions(box.host));
  const keep = `To remove the box from the config only, run ferry box remove ${name}.`;
  dependencies.writeLine(`Remove Ferry from box ${name}: ${transport(box.host)} ${destination(box.host)}`);
  const plan = await step(dependencies.progress, "Reading the box", () => planBoxUninstall(dependencies.harnesses, link)).catch(
    (cause) => {
      // A refusal of the plan has its own message and hint.
      if (cause instanceof FerryError) throw cause;
      throw new Error(`Ferry could not read box ${name}: ${messageOf(cause)}. Ferry changed nothing. ${keep}`, { cause });
    },
  );
  for (const line of boxUninstallLines(plan)) dependencies.writeLine(line);
  if (input.dryRun) {
    dependencies.writeLine("Dry run: Ferry made no changes.");
    return { name, defaultBoxRemoved: false, uninstall: { dryRun: true, plan, remaining: [] } };
  }
  if (!input.yes) {
    dependencies.progress.pause();
    if ((await dependencies.confirmName(`Type ${name} to remove Ferry from the box.`)) !== name) {
      dependencies.writeLine("Box remove cancelled.");
      return null;
    }
  }
  const remaining = await step(dependencies.progress, "Removing Ferry from the box", () => commitBoxUninstall(plan, link)).catch(
    (cause) => {
      throw new Error(
        `Ferry could not remove Ferry from box ${name}: ${messageOf(cause)}. The box stays in the config. Correct the problem, then run the command again. ${keep}`,
        { cause },
      );
    },
  );
  dependencies.writeLine(
    remaining.length === 0
      ? `Removed Ferry from box ${name}.`
      : `Removed Ferry from box ${name}. ~/.ferry stays on the box with: ${remaining.join(", ")}.`,
  );
  const removed = removeFromConfig(readComplete(dependencies.readConfig), name, dependencies, "");
  return { ...removed, uninstall: { dryRun: false, plan, remaining } };
}

/** The box, when the config can lose it. Throws for an unknown box and for the last box. */
function removableBox(config: PartialOperatorConfig, name: string): ResolvedBox {
  const box = resolveBoxes(config, [name])[0]!;
  if ((config.boxes ?? []).length <= 1) {
    throw new ConfigError(`box ${box.name} is the last box. Ferry needs one box at least. Add another box first.`);
  }
  return box;
}

function removeFromConfig(
  config: PartialOperatorConfig,
  name: string,
  dependencies: Dependencies<"writeConfig" | "writeLine" | "warn">,
  note: string,
): BoxRemoveResult {
  const wasDefault = config.defaultBox === name;
  dependencies.writeConfig(
    withBoxes(config, (config.boxes ?? []).filter((entry) => entry.name !== name), wasDefault ? undefined : config.defaultBox),
  );
  dependencies.writeLine(`Removed box ${name} from the config.${note === "" ? "" : ` ${note}`}`);
  if (wasDefault) {
    const warning = `Warning: box ${name} was the default_box. Ferry removed default_box. Set a new one with ferry box default <name>.`;
    dependencies.warn?.(warning);
    dependencies.writeLine(warning);
  }
  return { name, defaultBoxRemoved: wasDefault };
}

/** Set `default_box`, the box of `install`, `auth`, `move`, `tunnel`, and `integrations enable|disable` without --box. */
export function runBoxDefault(
  input: { readonly name: string },
  dependencies: Dependencies<"readConfig" | "writeConfig" | "writeLine">,
): { readonly defaultBox: string } {
  const config = readComplete(dependencies.readConfig);
  const box = resolveTargetBox(config, input.name);
  if (!config.boxes) {
    throw new ConfigError("The config has one [host] box, so default_box has no use. Add a box with ferry box add first.");
  }
  dependencies.writeConfig(withBoxes(config, config.boxes, box.name));
  dependencies.writeLine(`Set default_box = "${box.name}".`);
  return { defaultBox: box.name };
}

function readComplete(read: () => PartialOperatorConfig | null): PartialOperatorConfig {
  const config = read();
  if (config?.version !== 1 || config.publisher === undefined || config.snapshotUrl === undefined) {
    throw new ConfigMissingError("Ferry config is not complete. Run ferry init.");
  }
  return config;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function hostOf(input: BoxAddInput): OperatorHostConfig {
  const destination = input.sshDestination?.trim();
  const host = input.host?.trim();
  const sshUser = input.sshUser?.trim();
  if (destination && (host || sshUser)) {
    throw new ConfigError("--ssh-destination cannot be combined with --host or --ssh-user.");
  }
  if (destination) return { transport: "ssh", destination };
  if (host && sshUser) return { tailscale: host, sshUser };
  throw new ConfigError("Name the box host with --ssh-destination <destination>, or --host <host> with --ssh-user <user>.");
}

function invalidName(name: string): string {
  return `invalid box name ${name}. Use 1 to 32 characters from a-z, 0-9, and -, with no - at the start. The name all is reserved.`;
}

function transport(host: OperatorHostConfig): "tailscale" | "ssh" {
  return host.transport === "ssh" ? "ssh" : "tailscale";
}

function destination(host: OperatorHostConfig): string {
  return host.transport === "ssh" ? host.destination : `${host.sshUser}@${host.tailscale}`;
}
