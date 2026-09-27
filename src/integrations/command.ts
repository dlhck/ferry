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

export class IntegrationCommandError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "IntegrationCommandError";
  }
}

export async function runIntegrationCommand(
  input: IntegrationCommandInput,
  dependencies: Partial<IntegrationCommandDependencies> = {},
): Promise<void> {
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
  const action = enable ? "enable" : input.purge ? "purge" : "disable";
  resolved.writeLine(`${enable ? "Enable" : "Disable"} ${integration.name}:`);
  for (const line of await integration.plan(action)) resolved.writeLine(line);
  if (enable && input.dryRun) {
    resolved.writeLine("Dry run: Ferry made no changes.");
    return;
  }
  if (!input.yes) {
    resolved.progress.pause();
    if ((await resolved.confirm(`${enable ? "Enable" : "Disable"} ${integration.name} on the box?`)) !== true) {
      resolved.writeLine(`${enable ? "Enable" : "Disable"} cancelled.`);
      return;
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
  if (!enable) return;
  resolved.writeLine(`Connect ${integration.name} to the box:`);
  const destination = host.transport === "ssh" ? host.destination : `${host.sshUser}@${host.tailscale}`;
  for (const step of integration.connectSteps(destination)) resolved.writeLine(`  ${step}`);
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
