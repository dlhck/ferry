/** Read and write operator-only Ferry configuration. */

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { LinkOptions } from "./link.ts";
import { BUILTIN_TOOLS } from "./registry/builtin.ts";
import type { ToolPolicy } from "./registry/types.ts";

export const CONFIG_RELATIVE_PATH = ".ferry/config.toml";

export type OperatorConfig = {
  readonly version: 1;
  readonly publisher: string;
  readonly snapshotUrl: string;
  readonly host: OperatorHostConfig;
  readonly harness?: readonly unknown[];
  readonly update?: UpdateConfig;
  readonly integrations?: IntegrationsConfig;
  readonly tools?: ToolsConfig;
};

/** The version policy of each tool, by tool id. A tool that is not here uses the default of its kind. */
export type ToolsConfig = { readonly [id: string]: ToolPolicy };

/** Each key turns on one integration. A missing key means that the integration is off. */
export type IntegrationsConfig = { readonly paseo?: boolean };

/** `watch` turns on the daily tool update in `ferry watch`. */
export type UpdateConfig = { readonly watch?: boolean };

export type OperatorHostConfig =
  | {
      readonly transport?: "tailscale";
      readonly tailscale: string;
      readonly sshUser: string;
    }
  | {
      readonly transport: "ssh";
      readonly destination: string;
    };

export type PartialOperatorConfig = {
  readonly version?: 1;
  readonly publisher?: string;
  readonly snapshotUrl?: string;
  readonly host?: {
    readonly transport?: "tailscale" | "ssh";
    readonly tailscale?: string;
    readonly sshUser?: string;
    readonly destination?: string;
  };
  readonly harness?: readonly unknown[];
  readonly update?: UpdateConfig;
  readonly integrations?: IntegrationsConfig;
  readonly tools?: ToolsConfig;
};

/** TOML key to parsed property for each `[[harness]]` entry. */
const HARNESS_KEYS = {
  id: "id",
  name: "name",
  skill_root: "skillRoot",
  instruction_file: "instructionFile",
} as const;

const SECTION_KEYS: Record<string, readonly string[]> = {
  "": ["version", "publisher", "snapshot_url"],
  "[host]": ["transport", "tailscale", "ssh_user", "destination"],
  "[[harness]]": Object.keys(HARNESS_KEYS),
  "[update]": ["watch"],
  "[integrations]": ["paseo"],
  "[tools]": BUILTIN_TOOLS.map((tool) => tool.id),
};

/** An exact version, such as 1.4.2 or 2026.09.15-d2fe57e. It goes into box commands, so the characters stay few. */
const EXACT_VERSION = /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/;

export class ConfigError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "ConfigError";
  }
}

export function configPath(home = homedir()): string {
  return join(home, CONFIG_RELATIVE_PATH);
}

export function readConfig(home = homedir()): PartialOperatorConfig | null {
  const path = configPath(home);
  if (!existsSync(path)) return null;

  const config: {
    version?: 1;
    publisher?: string;
    snapshotUrl?: string;
    host: {
      transport?: "tailscale" | "ssh";
      tailscale?: string;
      sshUser?: string;
      destination?: string;
    };
    harness: Record<string, string>[];
    update?: { watch?: boolean };
    integrations?: { paseo?: boolean };
    tools?: Record<string, ToolPolicy>;
  } = { host: {}, harness: [] };
  let section = "";
  let harness: Record<string, string> | null = null;

  for (const sourceLine of readFileSync(path, "utf8").split(/\r?\n/)) {
    const line = sourceLine.trim();
    if (line === "" || line.startsWith("#")) continue;
    if (line === "[host]") {
      section = "[host]";
      harness = null;
      continue;
    }
    if (line === "[update]" || line === "[integrations]" || line === "[tools]") {
      section = line;
      harness = null;
      continue;
    }
    if (line === "[[harness]]") {
      section = "[[harness]]";
      harness = {};
      config.harness.push(harness);
      continue;
    }

    const match = /^([A-Za-z0-9_-]+)\s*=\s*(.+)$/.exec(line);
    if (!match) throw new ConfigError(`unsupported line ${line} in ${path}`);
    const [, key = "", encoded] = match;
    if (section === "[tools]" && !SECTION_KEYS[section]?.includes(key)) {
      throw new ConfigError(
        `unknown tool ${key} in [tools] of ${path}. Known tools: ${SECTION_KEYS["[tools]"]?.join(", ")}`,
      );
    }
    if (!SECTION_KEYS[section]?.includes(key)) {
      throw new ConfigError(`unknown key ${key} in ${section || "the top level"} of ${path}`);
    }
    if (key === "version") {
      if (section !== "" || encoded !== "1") throw new ConfigError(`unsupported config at ${path}`);
      config.version = 1;
      continue;
    }
    if (section === "[update]" || section === "[integrations]") {
      if (encoded !== "true" && encoded !== "false") {
        throw new ConfigError(`invalid boolean for ${key} in ${section} of ${path}`);
      }
      if (section === "[update]") config.update = { watch: encoded === "true" };
      else config.integrations = { paseo: encoded === "true" };
      continue;
    }

    if (section === "[tools]") {
      const policy = /^"[^"]*"$/.test(encoded ?? "") ? parseString(encoded ?? "", path) : "";
      if (policy !== "operator" && policy !== "latest" && !EXACT_VERSION.test(policy)) {
        throw new ConfigError(
          `invalid policy for ${key} in [tools] of ${path}. Use "operator", "latest", or an exact version such as 1.4.2.`,
        );
      }
      config.tools = { ...config.tools, [key]: policy };
      continue;
    }

    const value = parseString(encoded ?? "", path);
    if (section === "" && key === "publisher") config.publisher = value;
    else if (section === "" && key === "snapshot_url") config.snapshotUrl = value;
    else if (section === "[host]" && key === "transport") {
      if (value !== "tailscale" && value !== "ssh") {
        throw new ConfigError(`unsupported host transport in ${path}`);
      }
      config.host.transport = value;
    } else if (section === "[host]" && key === "tailscale") config.host.tailscale = value;
    else if (section === "[host]" && key === "ssh_user") config.host.sshUser = value;
    else if (section === "[host]" && key === "destination") config.host.destination = value;
    else if (harness) harness[HARNESS_KEYS[key as keyof typeof HARNESS_KEYS]] = value;
  }

  if (config.harness.length === 0) delete (config as { harness?: unknown }).harness;
  return config;
}

export function writeConfig(config: OperatorConfig, home = homedir()): void {
  const path = configPath(home);
  const temporaryPath = `${path}.tmp`;
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(
    temporaryPath,
    [
      `version = ${config.version}`,
      `publisher = ${JSON.stringify(config.publisher)}`,
      `snapshot_url = ${JSON.stringify(config.snapshotUrl)}`,
      "",
      "[host]",
      ...(config.host.transport === "ssh"
        ? [
            'transport = "ssh"',
            `destination = ${JSON.stringify(config.host.destination)}`,
          ]
        : [
            `tailscale = ${JSON.stringify(config.host.tailscale)}`,
            `ssh_user = ${JSON.stringify(config.host.sshUser)}`,
          ]),
      "",
      ...(config.harness ?? []).flatMap((entry) => [
        "[[harness]]",
        ...Object.entries(HARNESS_KEYS).flatMap(([key, property]) => {
          const value = (entry as Record<string, unknown>)[property];
          return typeof value === "string" ? [`${key} = ${JSON.stringify(value)}`] : [];
        }),
        "",
      ]),
      ...(config.update?.watch !== undefined
        ? ["[update]", `watch = ${config.update.watch}`, ""]
        : []),
      ...(config.integrations?.paseo !== undefined
        ? ["[integrations]", `paseo = ${config.integrations.paseo}`, ""]
        : []),
      ...(config.tools && Object.keys(config.tools).length > 0
        ? [
            "[tools]",
            ...Object.entries(config.tools).map(([id, policy]) => `${id} = ${JSON.stringify(policy)}`),
            "",
          ]
        : []),
    ].join("\n"),
    { mode: 0o600 },
  );
  renameSync(temporaryPath, path);
}

/** Set one `[integrations]` key and keep the rest of the config. The config must be complete. */
export function setIntegration(id: keyof IntegrationsConfig, enabled: boolean, home = homedir()): void {
  const config = readConfig(home);
  const host = completeHostConfig(config?.host);
  if (config?.version !== 1 || config.publisher === undefined || config.snapshotUrl === undefined || host === null) {
    throw new ConfigError(`Ferry config at ${configPath(home)} is not complete. Run ferry init.`);
  }
  writeConfig(
    {
      ...config,
      version: 1,
      publisher: config.publisher,
      snapshotUrl: config.snapshotUrl,
      host,
      integrations: { ...config.integrations, [id]: enabled },
    },
    home,
  );
}

export function resolveLinkOptions(host: OperatorHostConfig): LinkOptions;
export function resolveLinkOptions(
  host: PartialOperatorConfig["host"],
): LinkOptions | null;
export function resolveLinkOptions(
  host: PartialOperatorConfig["host"],
): LinkOptions | null {
  const complete = completeHostConfig(host);
  if (!complete) return null;
  if (complete.transport === "ssh") return { destination: complete.destination };
  return { host: complete.tailscale, user: complete.sshUser };
}

export function completeHostConfig(
  host: PartialOperatorConfig["host"],
): OperatorHostConfig | null {
  if (host?.transport === "ssh") {
    return nonempty(host.destination)
      ? { transport: "ssh", destination: host.destination.trim() }
      : null;
  }
  if (!nonempty(host?.tailscale) || !nonempty(host.sshUser)) return null;
  return { tailscale: host.tailscale.trim(), sshUser: host.sshUser.trim() };
}

function parseString(encoded: string, path: string): string {
  try {
    const value: unknown = JSON.parse(encoded);
    if (typeof value === "string") return value;
  } catch {
    // Report one config error below.
  }
  throw new ConfigError(`invalid string in ${path}`);
}

function nonempty(value: string | undefined): value is string {
  return value !== undefined && value.trim() !== "";
}
