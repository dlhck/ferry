/** The built-in integrations and the `ferry integrations` list. */

import { resolveBoxes } from "../boxes.ts";
import { completeHostConfig, type IntegrationsConfig, type PartialOperatorConfig } from "../config.ts";
import { paseo } from "./paseo.ts";
import type { Integration, LocalVersion } from "./types.ts";

export type { Integration } from "./types.ts";

export const INTEGRATIONS: readonly Integration[] = [paseo];

/**
 * Lines for `ferry integrations`. It reads the local app versions and makes no
 * changes. A config with box tables, or a `--box` selection, gets one block per
 * selected box with the effective state of that box.
 */
export async function integrationLines(
  config: PartialOperatorConfig,
  integrations: readonly Integration[] = INTEGRATIONS,
  selection: readonly string[] = [],
): Promise<string[]> {
  const versions = await Promise.all(integrations.map((integration) => integration.localVersion()));
  if (!config.boxes && selection.length === 0) {
    return boxLines(config.host, config.integrations, integrations, versions);
  }
  return resolveBoxes(config, selection).flatMap((box) => [
    `Box ${box.name}`,
    ...boxLines(box.host, box.integrations, integrations, versions).map((line) => `  ${line}`),
  ]);
}

function boxLines(
  host: PartialOperatorConfig["host"],
  enabled: IntegrationsConfig | undefined,
  integrations: readonly Integration[],
  versions: readonly LocalVersion[],
): string[] {
  const complete = completeHostConfig(host);
  const destination =
    complete === null ? null : complete.transport === "ssh" ? complete.destination : `${complete.sshUser}@${complete.tailscale}`;
  const lines: string[] = [];
  for (const [index, integration] of integrations.entries()) {
    const on = enabled?.[integration.id] === true;
    const local = versions[index];
    lines.push(`${integration.id}  ${on ? "enabled" : "disabled"}  ${integration.description}`);
    lines.push(
      local === undefined || local.version === null
        ? "  Local app: not found. The box version is not pinned."
        : `  Local app: ${local.version} (${local.source})`,
    );
    if (on && destination !== null) {
      lines.push("  Connect to the box:");
      for (const step of integration.connectSteps(destination)) lines.push(`    ${step}`);
    }
  }
  return lines;
}
