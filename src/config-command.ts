/** `ferry config get|set|unset`: read and change some keys of `~/.ferry/config.toml`. */

import { resolveBoxes, resolveTargetBox, type ResolvedBox } from "./boxes.ts";
import {
  completeHostConfig,
  ConfigError,
  ConfigMissingError,
  isHomeRelative,
  isMemoryLimit,
  isServerName,
  MEMORY_LIMIT_RULE,
  withBoxes,
  type BoxConfig,
  type BoxesOperatorConfig,
  type OperatorConfig,
  type PartialOperatorConfig,
} from "./config.ts";
import { FerryError } from "./errors.ts";

/** The keys that `ferry config set|unset` changes. Only `notifications.agents` is global. */
export const CONFIG_KEYS = ["notifications.agents", "mcp_gateway", "mcp_gateway_shared", "agent_memory_max", "projects"] as const;
export type ConfigKey = (typeof CONFIG_KEYS)[number];

export type ConfigBoxEntry = {
  readonly name: string;
  readonly mcpGateway: boolean;
  readonly mcpGatewayShared: readonly string[];
  readonly agentMemoryMax: string | null;
  readonly projects: readonly string[];
  /** The carried stdio MCP servers that the box can share, sorted. Empty when the read failed. */
  readonly stdioServers: readonly string[];
};

export type ConfigGetResult = {
  readonly schemaVersion: 1;
  readonly notifications: { readonly agents: boolean };
  readonly boxes: readonly ConfigBoxEntry[];
};

export type ConfigSetResult = {
  readonly changed: boolean;
  /** The box of a box key, or null for `notifications.agents`. */
  readonly box: string | null;
  readonly key: ConfigKey;
  /** True when the value changed. Each key goes to the box at the next sync. */
  readonly syncNeeded: boolean;
};

export type ConfigCommandDependencies = {
  readonly readConfig: () => PartialOperatorConfig | null;
  readonly writeConfig: (config: OperatorConfig | BoxesOperatorConfig) => void;
};

/**
 * The keys of each box, and the stdio MCP servers that it can share.
 * `stdioServers` gives the server names of the operator MCP files for the box.
 * When it throws, each box gets no names, and `warn` gets the reason.
 */
export function runConfigGet(
  dependencies: Pick<ConfigCommandDependencies, "readConfig"> & {
    readonly stdioServers: (box: ResolvedBox) => readonly string[];
    readonly warn: (line: string) => void;
  },
): ConfigGetResult {
  const config = readComplete(dependencies.readConfig);
  let failed = false;
  const boxes = resolveBoxes(config).map((box): ConfigBoxEntry => {
    let names: readonly string[] = [];
    if (!failed) {
      try {
        names = [...new Set(dependencies.stdioServers(box))].sort();
      } catch (cause) {
        failed = true;
        dependencies.warn(`Ferry could not read the MCP servers of this machine: ${cause instanceof Error ? cause.message : String(cause)}`);
      }
    }
    return {
      name: box.name,
      mcpGateway: box.mcpGateway,
      mcpGatewayShared: box.mcpGatewayShared,
      agentMemoryMax: box.agentMemoryMax,
      projects: box.projects,
      stdioServers: names,
    };
  });
  return { schemaVersion: 1, notifications: { agents: config.notifications?.agents === true }, boxes };
}

export function configGetLines(result: ConfigGetResult): string[] {
  const list = (values: readonly string[]) => (values.length === 0 ? "none" : values.join(", "));
  return [
    `notifications.agents: ${result.notifications.agents}`,
    ...result.boxes.flatMap((box) => [
      "",
      `Box ${box.name}:`,
      `  mcp_gateway: ${box.mcpGateway}`,
      `  mcp_gateway_shared: ${list(box.mcpGatewayShared)}`,
      `  agent_memory_max: ${box.agentMemoryMax ?? "none"}`,
      `  projects: ${list(box.projects)}`,
      `  stdio MCP servers: ${list(box.stdioServers)}`,
    ]),
  ];
}

/**
 * Set or remove one key, and write the config only when the value changes.
 * A box key without a box name uses `default_box`, then the only box.
 * A value that is not valid throws, and the config does not change.
 */
export function runConfigSet(
  input: { readonly key: string; readonly values: readonly string[]; readonly unset: boolean; readonly box?: string },
  dependencies: ConfigCommandDependencies,
): ConfigSetResult {
  const key = configKey(input.key);
  const config = readComplete(dependencies.readConfig);

  if (key === "notifications.agents") {
    if (input.box !== undefined) throw new FerryError("usage", "notifications.agents is for all boxes. Remove --box.");
    const agents = input.unset ? undefined : parseBoolean(key, input.values);
    const changed = (agents === true) !== (config.notifications?.agents === true);
    if (changed) dependencies.writeConfig({ ...complete(config), notifications: agents === undefined ? {} : { agents } });
    return { changed, box: null, key, syncNeeded: changed };
  }

  const target = resolveTargetBox(config, input.box);
  if (!config.boxes) {
    throw new ConfigError(`The config has one [host] box, and ${key} needs a [box.<name>] table. Add a box with ferry box add <name> first.`);
  }
  const current = config.boxes.find((box) => box.name === target.name)!;
  const next = withKey(current, key, input.unset ? undefined : parseValue(key, input.values));
  const changed = JSON.stringify(boxKeys(current)) !== JSON.stringify(boxKeys(next));
  if (changed) {
    const boxes = config.boxes.map((box) => (box.name === target.name ? next : box));
    dependencies.writeConfig(withBoxes(config, boxes, config.defaultBox));
  }
  return { changed, box: target.name, key, syncNeeded: changed };
}

export function configSetLines(result: ConfigSetResult, unset: boolean): string[] {
  const where = result.box === null ? "" : ` of box ${result.box}`;
  if (!result.changed) return [`${result.key}${where} did not change.`];
  return [
    `${unset ? "Removed" : "Set"} ${result.key}${where}.`,
    `Run ${result.box === null ? "ferry sync" : `ferry sync --box ${result.box}`} to apply it.`,
  ];
}

function configKey(key: string): ConfigKey {
  if ((CONFIG_KEYS as readonly string[]).includes(key)) return key as ConfigKey;
  throw new FerryError("usage", `unknown key ${key}. Known keys: ${CONFIG_KEYS.join(", ")}.`);
}

type BoxValue = boolean | string | readonly string[] | undefined;

function parseValue(key: Exclude<ConfigKey, "notifications.agents">, values: readonly string[]): BoxValue {
  switch (key) {
    case "mcp_gateway":
      return parseBoolean(key, values);
    case "agent_memory_max": {
      const value = values.length === 1 ? values[0]! : "";
      if (!isMemoryLimit(value)) throw new FerryError("usage", `invalid agent_memory_max. Use ${MEMORY_LIMIT_RULE}.`);
      return value;
    }
    case "mcp_gateway_shared":
      if (!values.every(isServerName)) throw new FerryError("usage", "invalid mcp_gateway_shared. Give stdio MCP server names, such as context7.");
      return [...new Set(values)];
    case "projects":
      if (!values.every(isHomeRelative)) throw new FerryError("usage", "invalid projects. Give paths relative to the box home, such as code/app.");
      return [...new Set(values)];
  }
}

function parseBoolean(key: ConfigKey, values: readonly string[]): boolean {
  if (values.length === 1 && (values[0] === "true" || values[0] === "false")) return values[0] === "true";
  throw new FerryError("usage", `invalid ${key}. Use true or false.`);
}

/** The box table with the key set to `value`. A false gateway, an empty list, and no value remove the key. */
function withKey(box: BoxConfig, key: Exclude<ConfigKey, "notifications.agents">, value: BoxValue): BoxConfig {
  const {
    mcpGateway: _mcpGateway,
    mcpGatewayShared: _mcpGatewayShared,
    agentMemoryMax: _agentMemoryMax,
    projects: _projects,
    ...rest
  } = box;
  const keys = { ...boxKeys(box), [PROPERTIES[key]]: value };
  return {
    ...rest,
    ...(keys.projects?.length ? { projects: keys.projects } : {}),
    ...(keys.agentMemoryMax ? { agentMemoryMax: keys.agentMemoryMax } : {}),
    ...(keys.mcpGateway ? { mcpGateway: true as const } : {}),
    ...(keys.mcpGatewayShared?.length ? { mcpGatewayShared: keys.mcpGatewayShared } : {}),
  };
}

const PROPERTIES = {
  mcp_gateway: "mcpGateway",
  mcp_gateway_shared: "mcpGatewayShared",
  agent_memory_max: "agentMemoryMax",
  projects: "projects",
} as const;

function boxKeys(box: BoxConfig): Pick<BoxConfig, (typeof PROPERTIES)[keyof typeof PROPERTIES]> {
  // An empty list in the file has the effect of no key.
  return {
    mcpGateway: box.mcpGateway,
    mcpGatewayShared: box.mcpGatewayShared?.length ? box.mcpGatewayShared : undefined,
    agentMemoryMax: box.agentMemoryMax,
    projects: box.projects?.length ? box.projects : undefined,
  };
}

function readComplete(read: () => PartialOperatorConfig | null): PartialOperatorConfig {
  const config = read();
  if (config?.version !== 1 || config.publisher === undefined || config.snapshotUrl === undefined) {
    throw new ConfigMissingError("Ferry config is not complete. Run ferry init.");
  }
  return config;
}

/** The config to write, with box tables or with the `[host]` table. */
function complete(config: PartialOperatorConfig): OperatorConfig | BoxesOperatorConfig {
  if (config.boxes) return withBoxes(config, config.boxes, config.defaultBox);
  const host = completeHostConfig(config.host);
  if (!host) throw new ConfigMissingError("Ferry config is not complete. Run ferry init.");
  const { host: _host, boxes: _boxes, defaultBox: _defaultBox, ...rest } = config;
  return { ...rest, version: 1, publisher: config.publisher!, snapshotUrl: config.snapshotUrl!, host };
}
