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

/**
 * The `[tools]` table, by tool id. A string sets the policy of a builtin tool.
 * A `[tools.<id>]` table defines a tool. A tool without a policy uses the
 * default of its kind.
 */
export type ToolsConfig = { readonly [id: string]: ToolPolicy | ToolDefinition };

/**
 * A tool that the operator defines in a `[tools.<id>]` table. `version` is the
 * policy. `local` and `box` print the version on this machine and on the box.
 * `latest` prints the newest version on this machine, for the `latest` policy.
 * `install` and `update` run on the box, and `update` defaults to `install`.
 * `path` holds directories relative to the home for the box `PATH`, and
 * `depends` names the tools to install first.
 */
export type ToolDefinition = {
  readonly version?: ToolPolicy;
  readonly local: string;
  readonly box?: string;
  readonly latest?: string;
  readonly install: string;
  readonly update?: string;
  readonly path?: readonly string[];
  readonly depends?: readonly string[];
};

/** The policy that the config sets for a tool, or undefined for the default of its kind. */
export function toolPolicy(tools: ToolsConfig | undefined, id: string): ToolPolicy | undefined {
  const entry = tools?.[id];
  return typeof entry === "string" ? entry : entry?.version;
}

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

/** The keys of a `[tools.<id>]` table, in the order that writeConfig writes them. */
const TOOL_KEYS = ["version", "local", "box", "latest", "install", "update", "path", "depends"] as const;

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
    tools?: Record<string, ToolPolicy | Record<string, unknown>>;
  } = { host: {}, harness: [] };
  let section = "";
  let harness: Record<string, string> | null = null;
  let tool: Record<string, unknown> | null = null;
  const definitions: [string, Record<string, unknown>][] = [];

  for (const sourceLine of readFileSync(path, "utf8").split(/\r?\n/)) {
    const line = sourceLine.trim();
    if (line === "" || line.startsWith("#")) continue;
    if (line === "[host]") {
      section = "[host]";
      harness = null;
      tool = null;
      continue;
    }
    if (line === "[update]" || line === "[integrations]" || line === "[tools]") {
      section = line;
      harness = null;
      tool = null;
      continue;
    }
    if (line === "[[harness]]") {
      section = "[[harness]]";
      harness = {};
      tool = null;
      config.harness.push(harness);
      continue;
    }
    const toolHeader = /^\[tools\.([A-Za-z0-9_-]+)\]$/.exec(line);
    if (toolHeader) {
      const id = toolHeader[1] ?? "";
      if (config.tools?.[id] !== undefined) throw new ConfigError(`duplicate tool ${id} in [tools] of ${path}`);
      section = line;
      harness = null;
      tool = {};
      config.tools = { ...config.tools, [id]: tool };
      definitions.push([section, tool]);
      continue;
    }

    const match = /^([A-Za-z0-9_-]+)\s*=\s*(.+)$/.exec(line);
    if (!match) throw new ConfigError(`unsupported line ${line} in ${path}`);
    const [, key = "", encoded = ""] = match;
    if (tool) {
      readToolKey(tool, key, encoded, section, path);
      continue;
    }
    if (section === "[tools]" && !SECTION_KEYS[section]?.includes(key)) {
      throw new ConfigError(
        `unknown tool ${key} in [tools] of ${path}. Known tools: ${SECTION_KEYS["[tools]"]?.join(", ")}. ` +
          `To define a tool, add a [tools.${key}] table.`,
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
      if (config.tools?.[key] !== undefined) throw new ConfigError(`duplicate tool ${key} in [tools] of ${path}`);
      config.tools = { ...config.tools, [key]: parsePolicy(encoded, `${key} in [tools]`, path) };
      continue;
    }

    const value = parseString(encoded, path);
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

  for (const [table, definition] of definitions) {
    for (const key of ["local", "install"]) {
      if (definition[key] === undefined) {
        throw new ConfigError(`missing ${key} in ${table} of ${path}. A tool table needs local and install.`);
      }
    }
  }

  if (config.harness.length === 0) delete (config as { harness?: unknown }).harness;
  return config as PartialOperatorConfig;
}

/** Read one key of a `[tools.<id>]` table. Each error names the table and the key. */
function readToolKey(tool: Record<string, unknown>, key: string, encoded: string, section: string, path: string): void {
  if (!(TOOL_KEYS as readonly string[]).includes(key)) {
    throw new ConfigError(`unknown key ${key} in ${section} of ${path}. Known keys: ${TOOL_KEYS.join(", ")}`);
  }
  if (key === "version") {
    tool.version = parsePolicy(encoded, `version in ${section}`, path);
    return;
  }
  if (key === "path" || key === "depends") {
    const list = parseJson(encoded);
    if (!Array.isArray(list) || list.some((item) => typeof item !== "string" || item === "")) {
      throw new ConfigError(`invalid value for ${key} in ${section} of ${path}. Use a list of strings, such as [".local/bin"].`);
    }
    tool[key] = list;
    return;
  }
  const value = tomlString(encoded);
  if (!value) throw new ConfigError(`invalid value for ${key} in ${section} of ${path}. Use a string.`);
  // A `{...}` after `$` is a shell expansion, not a placeholder.
  const allowed = key === "install" || key === "update" ? ["{version}"] : [];
  for (const [token] of value.matchAll(/(?<!\$)\{[^{}]*\}/g)) {
    if (!allowed.includes(token)) {
      throw new ConfigError(
        `unknown placeholder ${token} in ${key} of ${section} of ${path}. {version} in install and update is the only placeholder.`,
      );
    }
  }
  tool[key] = value;
}

function parsePolicy(encoded: string, label: string, path: string): ToolPolicy {
  const policy = /^"[^"]*"$/.test(encoded) ? parseString(encoded, path) : "";
  if (policy !== "operator" && policy !== "latest" && !EXACT_VERSION.test(policy)) {
    throw new ConfigError(
      `invalid policy for ${label} of ${path}. Use "operator", "latest", or an exact version such as 1.4.2.`,
    );
  }
  return policy;
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
      ...toolLines(config.tools ?? {}),
    ].join("\n"),
    { mode: 0o600 },
  );
  renameSync(temporaryPath, path);
}

/** The `[tools]` policies first, then one `[tools.<id>]` table for each defined tool. */
function toolLines(tools: ToolsConfig): string[] {
  const entries = Object.entries(tools);
  const policies = entries.filter(([, entry]) => typeof entry === "string");
  const definitions = entries.flatMap(([id, entry]) => (typeof entry === "string" ? [] : [[id, entry] as const]));
  return [
    ...(policies.length > 0
      ? ["[tools]", ...policies.map(([id, policy]) => `${id} = ${JSON.stringify(policy)}`), ""]
      : []),
    ...definitions.flatMap(([id, definition]) => [
      `[tools.${id}]`,
      ...TOOL_KEYS.flatMap((key) => (definition[key] === undefined ? [] : [`${key} = ${JSON.stringify(definition[key])}`])),
      "",
    ]),
  ];
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
  const value = tomlString(encoded);
  if (value !== undefined) return value;
  throw new ConfigError(`invalid string in ${path}`);
}

/**
 * A basic string in double quotes, or a literal string in single quotes. A
 * literal string keeps backslashes and double quotes, which suits shell commands.
 */
function tomlString(encoded: string): string | undefined {
  if (/^'[^'\n]*'$/.test(encoded)) return encoded.slice(1, -1);
  const value = parseJson(encoded);
  return typeof value === "string" ? value : undefined;
}

function parseJson(encoded: string): unknown {
  try {
    return JSON.parse(encoded);
  } catch {
    return undefined;
  }
}

function nonempty(value: string | undefined): value is string {
  return value !== undefined && value.trim() !== "";
}
