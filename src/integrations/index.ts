/** The built-in integrations and the `ferry integrations` list. */

import { completeHostConfig, type PartialOperatorConfig } from "../config.ts";
import { paseo } from "./paseo.ts";
import type { Integration } from "./types.ts";

export type { Integration } from "./types.ts";

export const INTEGRATIONS: readonly Integration[] = [paseo];

/** Lines for `ferry integrations`. It reads the local app versions and makes no changes. */
export async function integrationLines(
  config: PartialOperatorConfig,
  integrations: readonly Integration[] = INTEGRATIONS,
): Promise<string[]> {
  const host = completeHostConfig(config.host);
  const destination =
    host === null ? null : host.transport === "ssh" ? host.destination : `${host.sshUser}@${host.tailscale}`;
  const lines: string[] = [];
  for (const integration of integrations) {
    const enabled = config.integrations?.[integration.id] === true;
    const local = await integration.localVersion();
    lines.push(`${integration.id}  ${enabled ? "enabled" : "disabled"}  ${integration.description}`);
    lines.push(
      local.version === null
        ? "  Local app: not found. The box version is not pinned."
        : `  Local app: ${local.version} (${local.source})`,
    );
    if (enabled && destination !== null) {
      lines.push("  Connect to the box:");
      for (const step of integration.connectSteps(destination)) lines.push(`    ${step}`);
    }
  }
  return lines;
}
