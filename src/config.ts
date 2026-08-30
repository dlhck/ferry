/** Read and write operator-only Ferry configuration. */

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export const CONFIG_RELATIVE_PATH = ".ferry/config.toml";

export type OperatorConfig = {
  readonly version: 1;
  readonly publisher: string;
  readonly snapshotUrl: string;
  readonly host: {
    readonly tailscale: string;
    readonly sshUser: string;
  };
};

export type PartialOperatorConfig = {
  readonly version?: 1;
  readonly publisher?: string;
  readonly snapshotUrl?: string;
  readonly host?: {
    readonly tailscale?: string;
    readonly sshUser?: string;
  };
  readonly harness?: readonly Record<string, string>[];
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
    host: { tailscale?: string; sshUser?: string };
    harness: Record<string, string>[];
  } = { host: {}, harness: [] };
  let section = "";
  let harness: Record<string, string> | null = null;

  for (const sourceLine of readFileSync(path, "utf8").split(/\r?\n/)) {
    const line = sourceLine.trim();
    if (line === "" || line.startsWith("#")) continue;
    if (line === "[host]") {
      section = "host";
      harness = null;
      continue;
    }
    if (line === "[[harness]]") {
      section = "harness";
      harness = {};
      config.harness.push(harness);
      continue;
    }

    const match = /^(version|publisher|snapshot_url|tailscale|ssh_user|id|name|skill_root|instruction_file)\s*=\s*(.+)$/.exec(line);
    if (!match) continue;
    const [, key, encoded] = match;
    if (key === "version") {
      if (section !== "" || encoded !== "1") throw new ConfigError(`unsupported config at ${path}`);
      config.version = 1;
      continue;
    }

    const value = parseString(encoded ?? "", path);
    if (section === "" && key === "publisher") config.publisher = value;
    else if (section === "" && key === "snapshot_url") config.snapshotUrl = value;
    else if (section === "host" && key === "tailscale") config.host.tailscale = value;
    else if (section === "host" && key === "ssh_user") config.host.sshUser = value;
    else if (section === "harness" && harness && key === "id") harness.id = value;
    else if (section === "harness" && harness && key === "name") harness.name = value;
    else if (section === "harness" && harness && key === "skill_root") harness.skillRoot = value;
    else if (section === "harness" && harness && key === "instruction_file") harness.instructionFile = value;
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
      `tailscale = ${JSON.stringify(config.host.tailscale)}`,
      `ssh_user = ${JSON.stringify(config.host.sshUser)}`,
      "",
    ].join("\n"),
    { mode: 0o600 },
  );
  renameSync(temporaryPath, path);
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
