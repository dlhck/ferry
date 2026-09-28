/** `ferry integrations enable` and `ferry integrations disable`. */

import * as prompts from "@clack/prompts";
import {
  completeHostConfig,
  configPath,
  readConfig,
  resolveLinkOptions,
  setIntegration,
  type PartialOperatorConfig,
} from "../config.ts";
import { Link, type LinkOptions } from "../link.ts";
import { noProgress, type Progress } from "../progress.ts";
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

export async function runIntegrationCommand(
  input: IntegrationCommandInput,
  dependencies: Partial<IntegrationCommandDependencies> = {},
): Promise<IntegrationCommandResult | null> {
  const resolved = { ...defaultDependencies, ...dependencies };
  const integration = resolved.integrations.find((candidate) => candidate.id === input.name);
  if (!integration) {
    throw new IntegrationCommandError(
      `Unknown integration ${input.name}. Known integrations: ${resolved.integrations.map((known) => known.id).join(", ")}.`,
    );
  }
  const config = resolved.readConfig();
  const target = resolveLinkOptions(config?.host);
  const host = completeHostConfig(config?.host);
  if (!target || !host) throw new IntegrationCommandError("Ferry config has no complete host. Run ferry init.");

  const enable = input.action === "enable";
  const action: IntegrationCommandResult["action"] = enable ? "enable" : input.purge ? "purge" : "disable";
  resolved.writeLine(`${enable ? "Enable" : "Disable"} ${integration.name}:`);
  const plan = await integration.plan(action);
  for (const line of plan) resolved.writeLine(line);
  const result = { integration: integration.id, action, plan };
  if (enable && input.dryRun) {
    resolved.writeLine("Dry run: Ferry made no changes.");
    return { ...result, dryRun: true, output: [], enabled: null, connectSteps: [] };
  }
  if (!input.yes) {
    resolved.progress.pause();
    if ((await resolved.confirm(`${enable ? "Enable" : "Disable"} ${integration.name} on the box?`)) !== true) {
      resolved.writeLine(`${enable ? "Enable" : "Disable"} cancelled.`);
      return null;
    }
  }

  const link = resolved.createLink(target);
  const lines = enable
    ? await integration.enable(link, resolved.progress)
    : await integration.disable(link, resolved.progress, { purge: input.purge });
  for (const line of lines) resolved.writeLine(line);
  // The flag changes only after the box steps succeed.
  resolved.setIntegration(integration.id, enable);
  const table = resolved.box === undefined ? "integrations" : `box.${resolved.box}.integrations`;
  resolved.writeLine(`Set [${table}] ${integration.id} = ${enable} in ${configPath()}.`);
  const done = { ...result, dryRun: false, output: lines, enabled: enable };
  if (!enable) return { ...done, connectSteps: [] };
  resolved.writeLine(`Connect ${integration.name} to the box:`);
  const destination = host.transport === "ssh" ? host.destination : `${host.sshUser}@${host.tailscale}`;
  const connectSteps = integration.connectSteps(destination);
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
