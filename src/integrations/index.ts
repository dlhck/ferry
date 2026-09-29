/** The built-in integrations and the `ferry integrations` list. */

import { resolveBoxes } from "../boxes.ts";
import { completeHostConfig, type IntegrationsConfig, type PartialOperatorConfig } from "../config.ts";
import { paseo } from "./paseo.ts";
import type { BoxIntegration, Integration, IntegrationId, LocalVersion, OperatorIntegration } from "./types.ts";

export type { BoxIntegration, Integration, OperatorIntegration } from "./types.ts";

export const INTEGRATIONS: readonly Integration[] = [paseo];

export function hasBoxPart(integration: Integration): integration is BoxIntegration {
  return integration.box !== undefined;
}

/** The parts of an integration. `box` runs a service on the box. `operator` adds commands and checks on this machine. */
export type IntegrationPart = "box" | "operator";

/** The integrations of one box. `name` is null for a `[host]` config without a `--box` selection. */
export type IntegrationBox = {
  readonly name: string | null;
  /** The SSH destination, or null when the config has no complete host. */
  readonly destination: string | null;
  readonly integrations: readonly {
    readonly id: IntegrationId;
    readonly description: string;
    readonly enabled: boolean;
    readonly parts: readonly IntegrationPart[];
    /** Whether the operator part can run on this machine. Null without an operator part. */
    readonly available: boolean | null;
    /** The version of the local app, or null when this machine does not have it. */
    readonly localVersion: string | null;
    readonly localSource: string | null;
    /** The steps to connect the local app to the box. Empty when the integration is off. */
    readonly connectSteps: readonly string[];
  }[];
};

export type IntegrationList = { readonly boxes: readonly IntegrationBox[] };

/**
 * The integrations of each box for `ferry integrations`. It reads the local
 * app versions and makes no changes. A config with box tables, or a `--box`
 * selection, gets one entry per selected box with the effective state of that box.
 */
export async function listIntegrations(
  config: PartialOperatorConfig,
  integrations: readonly Integration[] = INTEGRATIONS,
  selection: readonly string[] = [],
): Promise<IntegrationList> {
  const versions = await Promise.all(
    integrations.map((integration) => integration.box?.localVersion() ?? { version: null, source: null }),
  );
  if (!config.boxes && selection.length === 0) {
    return { boxes: [integrationBox(null, config.host, config.integrations, integrations, versions)] };
  }
  return {
    boxes: resolveBoxes(config, selection).map((box) =>
      integrationBox(box.name, box.host, box.integrations, integrations, versions),
    ),
  };
}

/** The `ferry integrations` lines. A named box gets a `Box <name>` block. */
export function integrationLines(list: IntegrationList): string[] {
  return list.boxes.flatMap((box) =>
    box.name === null ? boxLines(box) : [`Box ${box.name}`, ...boxLines(box).map((line) => `  ${line}`)],
  );
}

/**
 * The enabled integrations with an operator part. The operator part runs on
 * this machine, so it is on when `[integrations]` enables it, or with box
 * tables, when at least one box enables it.
 */
export function operatorIntegrations(
  config: PartialOperatorConfig,
  integrations: readonly Integration[] = INTEGRATIONS,
): OperatorIntegration[] {
  const tables = config.boxes
    ? config.boxes.map((box) => ({ ...config.integrations, ...box.integrations }))
    : [config.integrations ?? {}];
  return integrations.filter(
    (integration): integration is OperatorIntegration =>
      integration.operator !== undefined && tables.some((table) => table[integration.id] === true),
  );
}

function integrationParts(integration: Integration): IntegrationPart[] {
  return [...(integration.box ? ["box" as const] : []), ...(integration.operator ? ["operator" as const] : [])];
}

function integrationBox(
  name: string | null,
  host: PartialOperatorConfig["host"],
  enabled: IntegrationsConfig | undefined,
  integrations: readonly Integration[],
  versions: readonly LocalVersion[],
): IntegrationBox {
  const complete = completeHostConfig(host);
  const destination =
    complete === null ? null : complete.transport === "ssh" ? complete.destination : `${complete.sshUser}@${complete.tailscale}`;
  return {
    name,
    destination,
    integrations: integrations.map((integration, index) => {
      const on = enabled?.[integration.id] === true;
      const local = versions[index];
      return {
        id: integration.id,
        description: integration.description,
        enabled: on,
        parts: integrationParts(integration),
        available: integration.operator?.available() ?? null,
        localVersion: local?.version ?? null,
        localSource: local?.source ?? null,
        connectSteps: on && destination !== null && integration.box ? integration.box.connectSteps(destination) : [],
      };
    }),
  };
}

function boxLines(box: IntegrationBox): string[] {
  const lines: string[] = [];
  for (const integration of box.integrations) {
    lines.push(`${integration.id}  ${integration.enabled ? "enabled" : "disabled"}  ${integration.description}`);
    lines.push(`  Parts: ${integration.parts.join(", ")}`);
    if (integration.parts.includes("box")) {
      lines.push(
        integration.localVersion === null
          ? "  Local app: not found. The box version is not pinned."
          : `  Local app: ${integration.localVersion} (${integration.localSource})`,
      );
    }
    if (integration.available !== null) {
      lines.push(`  This machine: ${integration.available ? "available" : "not available"}`);
    }
    if (integration.connectSteps.length > 0) {
      lines.push("  Connect to the box:");
      for (const step of integration.connectSteps) lines.push(`    ${step}`);
    }
  }
  return lines;
}
