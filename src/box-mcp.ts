/**
 * Declare the carried MCP servers on the box, and check what their stdio
 * servers need there.
 *
 * Ferry adds a carried server or updates it. It never removes a box server
 * that the operator does not carry. A login stays on the box: ferry declares
 * servers here and `AuthStart` starts their logins. The environment values of
 * a stdio server stay on the box too: ferry keeps the `env` of the box entry.
 */

import { posix } from "node:path";
import { parse as parseToml, stringify as stringifyToml } from "smol-toml";
import {
  BoxSettingsError,
  checked,
  quoteShell,
  readCommand,
  record,
  writeCommand,
  type BoxSettingsLink,
} from "./box-settings.ts";
import type { McpServer, McpSource, RemoteMcpServer, SeedMcp, StdioMcpServer } from "./manifest.ts";
import type { Progress } from "./progress.ts";
import type { HarnessDescriptor, ToolDescriptor, ToolMcp } from "./registry/types.ts";

/** The keys of a box stdio entry that ferry keeps: they hold the environment values. */
const BOX_ENV_KEYS = ["env", "env_vars"];

/** Codex waits in `mcp add` for a login callback, so each server gets more time than one command. */
const REGISTER_TIMEOUT_MS = 600_000;

type McpCommandValues = Partial<Record<"name" | "url" | "type" | "json", string>>;

/** Replace `{name}`, `{url}`, `{type}`, and `{json}` in an MCP command with shell-quoted values. */
export function mcpCommand(template: string, server: McpCommandValues): string {
  return template.replace(/\{(name|url|type|json)\}/g, (_, key: keyof McpCommandValues) =>
    quoteShell(String(server[key] ?? "")),
  );
}

/** The executable of an MCP recipe: the first word of its list command. */
export function mcpBinary(mcp: ToolMcp): string {
  return mcp.list.split(" ")[0] as string;
}

/**
 * Declare each carried server on the box. Progress counts the servers.
 * Return one warning for each server the box could not take.
 */
export async function registerBoxMcp(input: {
  readonly remoteHome: string;
  readonly harnesses: readonly HarnessDescriptor[];
  readonly tools: readonly ToolDescriptor[];
  readonly mcp: readonly SeedMcp[];
  readonly link: BoxSettingsLink;
  readonly progress?: Pick<Progress, "count">;
}): Promise<readonly string[]> {
  const entries = declared(input.mcp, input.tools);
  const total = entries.reduce((sum, { entry }) => sum + entry.servers.length, 0);
  let current = 0;
  const advance = (servers: number) => {
    current += servers;
    input.progress?.count(current, total);
  };
  const warnings: string[] = [];
  for (const { entry, recipe } of entries) {
    const file = input.harnesses.find((harness) => harness.id === entry.harness)?.mcp;
    let servers = entry.servers;
    if (recipe.register) {
      const remote = entry.servers.filter((server): server is RemoteMcpServer => server.type !== "stdio");
      warnings.push(...(await registerWithCli({ ...entry, servers: remote }, recipe, input.link, advance)));
      servers = entry.servers.filter((server) => server.type === "stdio");
    }
    if (servers.length === 0) continue;
    const path = file && posix.join(input.remoteHome, file.file);
    if (recipe.register?.addJson) {
      const stdio = servers.filter((server): server is StdioMcpServer => server.type === "stdio");
      warnings.push(...(await registerStdioWithCli(entry.harness, stdio, recipe, path && file ? { path, file } : null, input.link, advance)));
      continue;
    }
    advance(servers.length);
    if (path && file) await mergeMcpFile(path, file, servers, input.link);
  }
  return warnings;
}

/**
 * Something a carried stdio server lacks on the box. `env-missing`: the box
 * entry sets no value for `keys`. `command-missing`: `command` is not on the
 * box PATH and no registry tool supplies it. `not-portable`: ferry does not
 * carry the server, because it refers to a path in the operator home.
 */
export type BoxMcpIssue =
  | { readonly kind: "env-missing"; readonly harness: string; readonly server: string; readonly keys: readonly string[]; readonly file: string }
  | { readonly kind: "command-missing"; readonly harness: string; readonly server: string; readonly command: string }
  | { readonly kind: "not-portable"; readonly harness: string; readonly server: string };

/**
 * Check the carried stdio servers on the box, read-only. A command that a
 * registry tool supplies is left to the tool check, and ferry never installs
 * any other command.
 */
export async function checkBoxMcp(input: {
  readonly remoteHome: string;
  readonly harnesses: readonly HarnessDescriptor[];
  readonly tools: readonly ToolDescriptor[];
  readonly sources: readonly McpSource[];
  readonly link: BoxSettingsLink;
}): Promise<readonly BoxMcpIssue[]> {
  const issues: BoxMcpIssue[] = [];
  const stdio: { harness: string; server: StdioMcpServer }[] = [];
  for (const { entry } of declared(input.sources, input.tools)) {
    for (const server of entry.nonPortable) issues.push({ kind: "not-portable", harness: entry.harness, server });
    for (const server of entry.servers) if (server.type === "stdio") stdio.push({ harness: entry.harness, server });
  }

  const supplied = new Set(input.tools.map((tool) => tool.binary));
  const commands = [...new Set(stdio.map(({ server }) => server.command))].filter((command) => !supplied.has(command));
  if (commands.length > 0) {
    const script = commands.map((command) => `command -v ${quoteShell(command)} >/dev/null 2>&1 || printf '%s\\n' ${quoteShell(command)}`);
    const missing = new Set((await checked(input.link, script.join("\n"))).stdout.split("\n"));
    for (const { harness, server } of stdio) {
      if (missing.has(server.command)) issues.push({ kind: "command-missing", harness, server: server.name, command: server.command });
    }
  }

  for (const harness of input.harnesses) {
    const needs = stdio.filter((item) => item.harness === harness.id && item.server.env.length > 0);
    if (!harness.mcp || needs.length === 0) continue;
    const path = posix.join(input.remoteHome, harness.mcp.file);
    const { servers } = await readMcpFile(path, harness.mcp, input.link);
    for (const { server } of needs) {
      const env = record(record(servers[server.name]).env);
      const keys = server.env.filter((key) => typeof env[key] !== "string" || env[key] === "");
      if (keys.length > 0) issues.push({ kind: "env-missing", harness: harness.id, server: server.name, keys, file: harness.mcp.file });
    }
  }
  return issues;
}

/** The entries whose harness tool has an MCP recipe. Ferry declares only these on the box. */
function declared<T extends SeedMcp>(mcp: readonly T[], tools: readonly ToolDescriptor[]) {
  return mcp.flatMap((entry) => {
    const recipe = tools.find((tool) => tool.id === entry.harness)?.mcp;
    return recipe ? [{ entry, recipe }] : [];
  });
}

/**
 * Run the add commands of the harness CLI, one box command for each server,
 * so progress can count them. A server whose `get` output already shows the
 * carried URL is left alone, so its login stays.
 */
async function registerWithCli(
  entry: { readonly harness: string; readonly servers: readonly RemoteMcpServer[] },
  recipe: ToolMcp,
  link: BoxSettingsLink,
  advance: (servers: number) => void,
): Promise<string[]> {
  const register = recipe.register as NonNullable<ToolMcp["register"]>;
  const binary = mcpBinary(recipe);
  const warnings: string[] = [];
  for (const server of entry.servers) {
    advance(1);
    const url = quoteShell(server.url);
    const declared = `${mcpCommand(register.get, server)} 2>/dev/null | grep -qF -- ${url}`;
    const script = [
      `command -v ${binary} >/dev/null 2>&1 || { printf 'C\\n'; exit 0; }`,
      [
        `if ! ${declared}; then`,
        `${mcpCommand(register.remove, server)} >/dev/null 2>&1;`,
        `${mcpCommand(register.add, server)} </dev/null >/dev/null 2>&1;`,
        `${declared} || printf 'S\\t%s\\n' ${quoteShell(server.name)};`,
        "fi",
      ].join(" "),
    ].join("\n");
    const result = await checked(link, `sh -c ${quoteShell(script)}`, { timeoutMs: REGISTER_TIMEOUT_MS });

    for (const line of result.stdout.split("\n")) {
      const [kind, name] = line.split("\t");
      if (kind === "C") {
        warnings.push(`the ${binary} CLI is not on the box PATH; no ${entry.harness} MCP server was declared`);
        return warnings;
      }
      if (kind === "S") warnings.push(`could not declare ${entry.harness} MCP server ${name}`);
    }
  }
  return warnings;
}

/**
 * Add stdio servers with the `addJson` command of the harness CLI, one box
 * command for each server. The harness owns its MCP file, so ferry only reads
 * it: a box entry with the carried command and arguments is left alone, and a
 * changed entry keeps the `env` of the box entry.
 */
async function registerStdioWithCli(
  harness: string,
  servers: readonly StdioMcpServer[],
  recipe: ToolMcp,
  box: { readonly path: string; readonly file: McpFile } | null,
  link: BoxSettingsLink,
  advance: (servers: number) => void,
): Promise<string[]> {
  const register = recipe.register as NonNullable<ToolMcp["register"]>;
  const binary = mcpBinary(recipe);
  const declared = box ? (await readMcpFile(box.path, box.file, link)).servers : {};
  const warnings: string[] = [];
  for (const server of servers) {
    advance(1);
    const current = record(declared[server.name]);
    const args = Array.isArray(current.args) ? current.args : [];
    if (current.command === server.command && Bun.deepEquals(args, server.args)) continue;
    const json = JSON.stringify({
      type: "stdio",
      command: server.command,
      args: server.args,
      ...(Object.hasOwn(current, "env") ? { env: current.env } : {}),
    });
    const script = [
      `command -v ${binary} >/dev/null 2>&1 || { printf 'C\\n'; exit 0; }`,
      `${mcpCommand(register.remove, server)} >/dev/null 2>&1`,
      `${mcpCommand(register.addJson as string, { name: server.name, json })} </dev/null >/dev/null 2>&1 || printf 'S\\n'`,
    ].join("\n");
    const result = await checked(link, `sh -c ${quoteShell(script)}`);
    if (result.stdout.startsWith("C")) {
      warnings.push(`the ${binary} CLI is not on the box PATH; no ${harness} MCP server was declared`);
      return warnings;
    }
    if (result.stdout.startsWith("S")) warnings.push(`could not declare ${harness} MCP server ${server.name}`);
  }
  return warnings;
}

type McpFile = NonNullable<HarnessDescriptor["mcp"]>;

/** Read a box MCP file. `current` is `null` when the file is missing. */
async function readMcpFile(
  path: string,
  file: McpFile,
  link: BoxSettingsLink,
): Promise<{ current: string | null; parsed: Record<string, unknown>; servers: Record<string, unknown> }> {
  const read = await checked(link, readCommand(path));
  const current = read.stdout.startsWith("F") ? read.stdout.slice(1) : null;
  let parsed: unknown = {};
  if (current !== null && current.trim() !== "") {
    try {
      parsed = file.format === "toml" ? parseToml(current) : JSON.parse(current);
    } catch {
      parsed = null;
    }
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new BoxSettingsError(`${path}: the box MCP file is not a ${file.format.toUpperCase()} object`);
  }
  const object = parsed as Record<string, unknown>;
  return { current, parsed: object, servers: { ...record(object[file.key]) } };
}

/**
 * Set each carried server under the MCP key of the box file. Keep all other
 * entries and keys, and the environment keys of a box stdio entry. Write only
 * when a server changes, so a TOML file keeps its comments.
 */
async function mergeMcpFile(
  path: string,
  file: McpFile,
  servers: readonly McpServer[],
  link: BoxSettingsLink,
): Promise<void> {
  const { current, parsed, servers: declared } = await readMcpFile(path, file, link);
  let changed = current === null;
  for (const server of servers) {
    const entry = boxEntry(server, record(declared[server.name]));
    if (Bun.deepEquals(declared[server.name], entry)) continue;
    declared[server.name] = entry;
    changed = true;
  }
  if (!changed) return;
  parsed[file.key] = declared;
  const text = file.format === "toml" ? `${stringifyToml(parsed).trimEnd()}\n` : `${JSON.stringify(parsed, null, 2)}\n`;
  if (text !== current) await checked(link, writeCommand(path, text));
}

/** The box entry of a carried server. A stdio entry keeps the environment keys of the box entry `box`. */
function boxEntry(server: McpServer, box: Record<string, unknown>): Record<string, unknown> {
  if (server.type !== "stdio") return server.type === "sse" ? { type: "sse", url: server.url } : { url: server.url };
  const kept = Object.fromEntries(BOX_ENV_KEYS.filter((key) => Object.hasOwn(box, key)).map((key) => [key, box[key]]));
  return { command: server.command, args: [...server.args], ...kept };
}
