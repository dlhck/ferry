/** Read and write operator-only Ferry configuration. */

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { LinkOptions } from "./link.ts";

export const CONFIG_RELATIVE_PATH = ".ferry/config.toml";

export type OperatorConfig = {
  readonly version: 1;
  readonly publisher: string;
  readonly snapshotUrl: string;
  readonly host: OperatorHostConfig;
  readonly harness?: readonly unknown[];
};

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
};

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
    if (line === "[[harness]]") {
      section = "[[harness]]";
      harness = {};
      config.harness.push(harness);
      continue;
    }

    const match = /^([A-Za-z0-9_-]+)\s*=\s*(.+)$/.exec(line);
    if (!match) throw new ConfigError(`unsupported line ${line} in ${path}`);
    const [, key = "", encoded] = match;
    if (!SECTION_KEYS[section]?.includes(key)) {
      throw new ConfigError(`unknown key ${key} in ${section || "the top level"} of ${path}`);
    }
    if (key === "version") {
      if (section !== "" || encoded !== "1") throw new ConfigError(`unsupported config at ${path}`);
      config.version = 1;
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
    ].join("\n"),
    { mode: 0o600 },
  );
  renameSync(temporaryPath, path);
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
