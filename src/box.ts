/** `ferry box list`, `ferry box add`, `ferry box remove`, and `ferry box default`. */

import { resolveBoxes, resolveTargetBox } from "./boxes.ts";
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
import { boxCheckSteps, checkBoxAccess, type InitDependencies, type InitLink } from "./init.ts";
import type { LinkOptions } from "./link.ts";
import type { Progress } from "./progress.ts";

export type BoxCommandDependencies = {
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

/** The box that `ferry box add` added. `migrated` is true when the `[host]` table moved to `[box.default]`. */
export type BoxAddResult = {
  readonly name: string;
  readonly transport: "tailscale" | "ssh";
  readonly destination: string;
  readonly gitAuth: GitAuth;
  readonly migrated: boolean;
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
  return {
    name: input.name,
    transport: transport(host),
    destination: destination(host),
    gitAuth: input.gitAuth ?? "agent",
    migrated: migrate,
  };
}

/** Write the config without the box. Ferry does not connect to the box and does not change it. */
export function runBoxRemove(
  input: { readonly name: string },
  dependencies: Dependencies<"readConfig" | "writeConfig" | "writeLine" | "warn">,
): { readonly name: string; readonly defaultBoxRemoved: boolean } {
  const config = readComplete(dependencies.readConfig);
  const [box] = resolveBoxes(config, [input.name]);
  const boxes = config.boxes ?? [];
  if (boxes.length <= 1) {
    throw new ConfigError(`box ${box?.name} is the last box. Ferry needs one box at least. Add another box first.`);
  }
  const wasDefault = config.defaultBox === input.name;
  dependencies.writeConfig(
    withBoxes(config, boxes.filter((entry) => entry.name !== input.name), wasDefault ? undefined : config.defaultBox),
  );
  dependencies.writeLine(`Removed box ${input.name} from the config. Ferry did not change the box.`);
  if (wasDefault) {
    const warning = `Warning: box ${input.name} was the default_box. Ferry removed default_box. Set a new one with ferry box default <name>.`;
    dependencies.warn?.(warning);
    dependencies.writeLine(warning);
  }
  return { name: input.name, defaultBoxRemoved: wasDefault };
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
