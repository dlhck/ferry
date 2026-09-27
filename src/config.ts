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

/** A complete config with `[box.<name>]` tables instead of `[host]`. */
export type BoxesOperatorConfig = Omit<OperatorConfig, "host"> & {
  readonly defaultBox?: string;
  readonly boxes: readonly BoxConfig[];
};

/** A `[box.<name>]` table, with its `[box.<name>.integrations]` and `[box.<name>.tools]` overrides. */
export type BoxConfig = {
  readonly name: string;
  readonly host: OperatorHostConfig;
  readonly integrations?: IntegrationsConfig;
  /** Policies by tool id. A policy replaces the `[tools]` policy or the `version` of a `[tools.<id>]` table. */
  readonly tools?: { readonly [id: string]: ToolPolicy };
};

/** A box name goes into flags, lock file names, JSON, and output prefixes, so the characters stay few. */
const BOX_NAME = /^[a-z0-9][a-z0-9-]{0,31}$/;

/** True for a name that a `[box.<name>]` table can use. The name `all` is reserved. */
export function isBoxName(name: string): boolean {
  return BOX_NAME.test(name) && name !== "all";
}

/**
 * The `[tools]` table, by tool id. A string sets the policy of a builtin tool.
 * A `[tools.<id>]` table defines a tool. A tool without a policy uses the
 * default of its kind.
 */
export type ToolsConfig = { readonly [id: string]: ToolPolicy | ToolDefinition };

/**
 * A tool that the operator defines in a `[tools.<id>]` table. `version` is the
 * policy. `local` and `box` print the version on this machine and on the box.
 * `install` and `update` run on the box, and `update` defaults to `install`.
 * `path` holds directories relative to the home for the box `PATH`, and
 * `depends` names the tools to install first.
 */
export type ToolDefinition = {
  readonly version?: ToolPolicy;
  readonly local: string;
  readonly box?: string;
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
  /** The box of a single-target command without `--box`. Only a config with `[box.<name>]` tables has it. */
  readonly defaultBox?: string;
  /** The `[box.<name>]` tables in config order. A config with boxes has no `host`. */
  readonly boxes?: readonly BoxConfig[];
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
  "": ["version", "publisher", "snapshot_url", "default_box"],
  "[host]": ["transport", "tailscale", "ssh_user", "destination"],
  "[[harness]]": Object.keys(HARNESS_KEYS),
  "[update]": ["watch"],
  "[integrations]": ["paseo"],
  "[tools]": BUILTIN_TOOLS.map((tool) => tool.id),
};

/** The keys of a `[tools.<id>]` table, in the order that writeConfig writes them. */
const TOOL_KEYS = ["version", "local", "box", "install", "update", "path", "depends"] as const;

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
    defaultBox?: string;
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
  const boxes: ParsedBox[] = [];
  const boxTables = new Set<string>();
  let box: { entry: ParsedBox; part: BoxPart } | null = null;
  let hasHost = false;

  for (const sourceLine of readFileSync(path, "utf8").split(/\r?\n/)) {
    const line = sourceLine.trim();
    if (line === "" || line.startsWith("#")) continue;
    if (line === "[host]") {
      section = "[host]";
      harness = null;
      tool = null;
      box = null;
      hasHost = true;
      continue;
    }
    if (line === "[update]" || line === "[integrations]" || line === "[tools]") {
      section = line;
      harness = null;
      tool = null;
      box = null;
      continue;
    }
    if (line === "[[harness]]") {
      section = "[[harness]]";
      harness = {};
      tool = null;
      box = null;
      config.harness.push(harness);
      continue;
    }
    const boxHeader = /^\[box\.([^.\]]*)(?:\.([^\]]*))?\]$/.exec(line);
    if (boxHeader) {
      const [, name = "", part] = boxHeader;
      if (!isBoxName(name)) {
        throw new ConfigError(
          `invalid box name ${name} in ${path}. Use 1 to 32 characters from a-z, 0-9, and -, with no - at the start. The name all is reserved.`,
        );
      }
      if (part !== undefined && part !== "integrations" && part !== "tools") {
        throw new ConfigError(`unknown table ${line} in ${path}. A box has [box.${name}], [box.${name}.integrations], and [box.${name}.tools].`);
      }
      if (boxTables.has(line)) throw new ConfigError(`duplicate table ${line} in ${path}`);
      boxTables.add(line);
      let entry = boxes.find((known) => known.name === name);
      if (!entry) {
        entry = { name, host: {} };
        boxes.push(entry);
      }
      section = line;
      harness = null;
      tool = null;
      box = { entry, part: part ?? "host" };
      continue;
    }
    const toolHeader = /^\[tools\.([A-Za-z0-9_-]+)\]$/.exec(line);
    if (toolHeader) {
      const id = toolHeader[1] ?? "";
      if (config.tools?.[id] !== undefined) throw new ConfigError(`duplicate tool ${id} in [tools] of ${path}`);
      section = line;
      harness = null;
      box = null;
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
    if (box) {
      readBoxKey(box.entry, box.part, key, encoded, section, path);
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
    else if (section === "" && key === "default_box") config.defaultBox = value;
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

  if (hasHost && boxes.length > 0) {
    throw new ConfigError(`${path} has both [host] and [box.${boxes[0]?.name}]. Move [host] to a [box.<name>] table.`);
  }
  const names = boxes.map((entry) => entry.name);
  if (config.defaultBox !== undefined && boxes.length === 0) {
    throw new ConfigError(`default_box in ${path} needs [box.<name>] tables. A [host] config has one box only.`);
  }
  if (config.defaultBox !== undefined && !names.includes(config.defaultBox)) {
    throw new ConfigError(`default_box ${config.defaultBox} in ${path} names no box. Known boxes: ${names.join(", ")}.`);
  }
  const toolIds = [...new Set([...BUILTIN_TOOLS.map((known) => known.id), ...Object.keys(config.tools ?? {})])];
  const completeBoxes = boxes.map((entry): BoxConfig => {
    const host = completeHostConfig(entry.host);
    if (!host) {
      throw new ConfigError(
        `box ${entry.name} in ${path} is not complete. [box.${entry.name}] needs transport = "ssh" with destination, or tailscale and ssh_user.`,
      );
    }
    const unknown = Object.keys(entry.tools ?? {}).find((id) => !toolIds.includes(id));
    if (unknown !== undefined) {
      throw new ConfigError(`unknown tool ${unknown} in [box.${entry.name}.tools] of ${path}. Known tools: ${toolIds.join(", ")}.`);
    }
    return {
      name: entry.name,
      host,
      ...(entry.integrations ? { integrations: entry.integrations } : {}),
      ...(entry.tools ? { tools: entry.tools } : {}),
    };
  });

  if (config.harness.length === 0) delete (config as { harness?: unknown }).harness;
  if (completeBoxes.length > 0) {
    delete (config as { host?: unknown }).host;
    return { ...config, boxes: completeBoxes } as PartialOperatorConfig;
  }
  return config as PartialOperatorConfig;
}

type BoxPart = "host" | "integrations" | "tools";

type ParsedBox = {
  name: string;
  host: { transport?: "tailscale" | "ssh"; tailscale?: string; sshUser?: string; destination?: string };
  integrations?: Record<string, boolean>;
  tools?: Record<string, ToolPolicy>;
};

/** Read one key of a `[box.<name>]`, `[box.<name>.integrations]`, or `[box.<name>.tools]` table. */
function readBoxKey(entry: ParsedBox, part: BoxPart, key: string, encoded: string, section: string, path: string): void {
  if (part === "tools") {
    if (entry.tools?.[key] !== undefined) throw new ConfigError(`duplicate tool ${key} in ${section} of ${path}`);
    entry.tools = { ...entry.tools, [key]: parsePolicy(encoded, `${key} in ${section}`, path) };
    return;
  }
  if (!SECTION_KEYS[part === "host" ? "[host]" : "[integrations]"]?.includes(key)) {
    throw new ConfigError(`unknown key ${key} in ${section} of ${path}`);
  }
  if (part === "integrations") {
    if (encoded !== "true" && encoded !== "false") throw new ConfigError(`invalid boolean for ${key} in ${section} of ${path}`);
    entry.integrations = { ...entry.integrations, [key]: encoded === "true" };
    return;
  }
  const value = parseString(encoded, path);
  if (key === "transport") {
    if (value !== "tailscale" && value !== "ssh") throw new ConfigError(`unsupported transport in ${section} of ${path}`);
    entry.host.transport = value;
  } else if (key === "ssh_user") entry.host.sshUser = value;
  else if (key === "tailscale") entry.host.tailscale = value;
  else entry.host.destination = value;
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

export function writeConfig(config: OperatorConfig | BoxesOperatorConfig, home = homedir()): void {
  const path = configPath(home);
  const temporaryPath = `${path}.tmp`;
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(
    temporaryPath,
    [
      `version = ${config.version}`,
      `publisher = ${JSON.stringify(config.publisher)}`,
      `snapshot_url = ${JSON.stringify(config.snapshotUrl)}`,
      ...("boxes" in config && config.defaultBox !== undefined ? [`default_box = ${JSON.stringify(config.defaultBox)}`] : []),
      "",
      ...("host" in config ? ["[host]", ...hostLines(config.host), ""] : []),
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
      ...("boxes" in config ? config.boxes.flatMap(boxLines) : []),
    ].join("\n"),
    { mode: 0o600 },
  );
  renameSync(temporaryPath, path);
}

function hostLines(host: OperatorHostConfig): string[] {
  return host.transport === "ssh"
    ? ['transport = "ssh"', `destination = ${JSON.stringify(host.destination)}`]
    : [`tailscale = ${JSON.stringify(host.tailscale)}`, `ssh_user = ${JSON.stringify(host.sshUser)}`];
}

/** One `[box.<name>]` table, then its overrides. An override table without keys is not written. */
function boxLines(box: BoxConfig): string[] {
  const tools = Object.entries(box.tools ?? {});
  return [
    `[box.${box.name}]`,
    ...hostLines(box.host),
    "",
    ...(box.integrations?.paseo !== undefined
      ? [`[box.${box.name}.integrations]`, `paseo = ${box.integrations.paseo}`, ""]
      : []),
    ...(tools.length > 0
      ? [`[box.${box.name}.tools]`, ...tools.map(([id, policy]) => `${id} = ${JSON.stringify(policy)}`), ""]
      : []),
  ];
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
  const target = config?.boxes ? { boxes: config.boxes } : host ? { host } : null;
  if (config?.version !== 1 || config.publisher === undefined || config.snapshotUrl === undefined || target === null) {
    throw new ConfigError(`Ferry config at ${configPath(home)} is not complete. Run ferry init.`);
  }
  const { host: _host, boxes: _boxes, ...rest } = config;
  writeConfig(
    {
      ...rest,
      version: 1,
      publisher: config.publisher,
      snapshotUrl: config.snapshotUrl,
      ...target,
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
