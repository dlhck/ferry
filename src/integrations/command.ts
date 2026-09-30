/** `ferry integrations enable` and `ferry integrations disable`. */

import * as prompts from "@clack/prompts";
import {
  completeHostConfig,
  ConfigMissingError,
  configPath,
  readConfig,
  resolveLinkOptions,
  setIntegration,
  type PartialOperatorConfig,
} from "../config.ts";
import { Link, type LinkOptions } from "../link.ts";
import { noProgress, type Progress } from "../progress.ts";
import { boxLockError, type BoxLockRefusal } from "../sync.ts";
import { INTEGRATIONS } from "./index.ts";
import type { Integration, IntegrationId, IntegrationLink } from "./types.ts";

export type IntegrationCommandInput =
  | { readonly action: "enable"; readonly name: string; readonly yes: boolean; readonly dryRun: boolean }
  | { readonly action: "disable"; readonly name: string; readonly yes: boolean; readonly purge: boolean };

export type IntegrationCommandDependencies = {
  readonly integrations: readonly Integration[];
  readonly readConfig: () => PartialOperatorConfig | null;
  /** Sets the key in `[integrations]`, or in `[box.<box>.integrations]` when `box` is set. */
  readonly setIntegration: (id: IntegrationId, enabled: boolean) => void;
  /** The box whose table `setIntegration` writes. Undefined for `[integrations]`. */
  readonly box?: string;
  readonly createLink: (options: LinkOptions) => IntegrationLink;
  readonly confirm: (message: string) => Promise<boolean | symbol | undefined>;
  readonly writeLine: (line: string) => void;
  readonly progress: Progress;
  /**
   * Takes the box lock of the box, from `boxLocker`. The command stops when
   * the box does not give the lock. Without it, the command takes no lock.
   */
  readonly lockBox?: () => (() => void) | BoxLockRefusal;
};

/** What `integrations enable|disable` did. `enabled` is the new config value, or null for a dry run. */
export type IntegrationCommandResult = {
  readonly integration: IntegrationId;
  readonly action: "enable" | "disable" | "purge";
  readonly dryRun: boolean;
  /** The plan lines, with the box commands. */
  readonly plan: readonly string[];
  /** The output lines of the box steps. */
  readonly output: readonly string[];
  readonly enabled: boolean | null;
  /** The steps to connect the local app to the box, after an enable. */
  readonly connectSteps: readonly string[];
};

export class IntegrationCommandError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "IntegrationCommandError";
  }
}

/**
 * With `lockBox`, a command with a box part holds the box lock from after the
 * confirmation until the config has the new flag. It fails before it changes
 * the box when a sync or another command holds the lock, or when the box left
 * the config or changed in it.
 */
export async function runIntegrationCommand(
  input: IntegrationCommandInput,
  dependencies: Partial<IntegrationCommandDependencies> = {},
): Promise<IntegrationCommandResult | null> {
  const locks: (() => void)[] = [];
  try {
    return await changeIntegration(input, dependencies, locks);
  } finally {
    for (const release of locks) release();
  }
}

/** `runIntegrationCommand`. It adds the box lock that it takes to `locks`, and the caller releases it. */
async function changeIntegration(
  input: IntegrationCommandInput,
  dependencies: Partial<IntegrationCommandDependencies>,
  locks: (() => void)[],
): Promise<IntegrationCommandResult | null> {
  const resolved = { ...defaultDependencies, ...dependencies };
  const integration = resolved.integrations.find((candidate) => candidate.id === input.name);
  if (!integration) {
    throw new IntegrationCommandError(
      `Unknown integration ${input.name}. Known integrations: ${resolved.integrations.map((known) => known.id).join(", ")}.`,
    );
  }
  const install = integration.operator?.install;
  if (input.action === "enable" && install !== undefined && !integration.operator!.available()) {
    throw new IntegrationCommandError(
      `${integration.name} is not available on this machine. Install it, then run ferry integrations enable ${integration.id} again:\n  ${install}`,
    );
  }
  const config = resolved.readConfig();
  const target = resolveLinkOptions(config?.host);
  const host = completeHostConfig(config?.host);
  if (!target || !host) throw new ConfigMissingError("Ferry config has no complete host. Run ferry init.");

  const enable = input.action === "enable";
  const action: IntegrationCommandResult["action"] = enable ? "enable" : input.purge ? "purge" : "disable";
  const box = integration.box;
  resolved.writeLine(`${enable ? "Enable" : "Disable"} ${integration.name}:`);
  const plan = box ? await box.plan(action, undefined, config?.integrations) : [];
  for (const line of plan) resolved.writeLine(line);
  const result = { integration: integration.id, action, plan };
  if (enable && input.dryRun) {
    resolved.writeLine("Dry run: Ferry made no changes.");
    return { ...result, dryRun: true, output: [], enabled: null, connectSteps: [] };
  }
  // Without a box part, the command changes only the config, so it asks nothing.
  if (box && !input.yes) {
    resolved.progress.pause();
    if ((await resolved.confirm(`${enable ? "Enable" : "Disable"} ${integration.name} on the box?`)) !== true) {
      resolved.writeLine(`${enable ? "Enable" : "Disable"} cancelled.`);
      return null;
    }
  }

  let lines: readonly string[] = [];
  if (box) {
    // The confirmation can take a long time, so the box can leave the config before this point.
    const lock = resolved.lockBox?.();
    if (typeof lock === "function") locks.push(lock);
    else if (lock !== undefined) throw boxLockError(lock);
    const link = resolved.createLink(target);
    lines = enable
      ? await box.enable(link, resolved.progress, config?.integrations)
      : await box.disable(link, resolved.progress, { purge: input.purge });
  }
  for (const line of lines) resolved.writeLine(line);
  // The flag changes only after the box steps succeed.
  resolved.setIntegration(integration.id, enable);
  const table = resolved.box === undefined ? "integrations" : `box.${resolved.box}.integrations`;
  resolved.writeLine(`Set [${table}] ${integration.id} = ${enable} in ${configPath()}.`);
  if (enable && integration.operator && !integration.operator.available()) {
    resolved.writeLine(`${integration.name} is not available on this machine. Ferry adds its commands when it is.`);
  }
  const done = { ...result, dryRun: false, output: lines, enabled: enable };
  if (!enable || !box) return { ...done, connectSteps: [] };
  resolved.writeLine(`Connect ${integration.name} to the box:`);
  const destination = host.transport === "ssh" ? host.destination : `${host.sshUser}@${host.tailscale}`;
  const connectSteps = box.connectSteps(destination);
  for (const step of connectSteps) resolved.writeLine(`  ${step}`);
  return { ...done, connectSteps };
}

const defaultDependencies: IntegrationCommandDependencies = {
  integrations: INTEGRATIONS,
  readConfig,
  setIntegration: (id, enabled) => setIntegration(id, enabled),
  createLink: (options) => new Link(options),
  confirm: (message) => prompts.confirm({ message }),
  writeLine: console.log,
  progress: noProgress,
};
