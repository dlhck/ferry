/**
 * Declare the carried remote MCP servers on the box.
 *
 * Ferry adds a carried server or updates its URL. It never removes a box
 * server that the operator does not carry. A login stays on the box: ferry
 * declares servers here and `AuthStart` starts their logins.
 */

import { posix } from "node:path";
import {
  BoxSettingsError,
  checked,
  quoteShell,
  readCommand,
  record,
  writeCommand,
  type BoxSettingsLink,
} from "./box-settings.ts";
import type { McpServer, SeedMcp } from "./manifest.ts";
import type { HarnessDescriptor, ToolDescriptor, ToolMcp } from "./registry/types.ts";

/** Codex waits in `mcp add` for a login callback, so each server gets more time than one command. */
const REGISTER_TIMEOUT_MS = 600_000;

/** Replace `{name}`, `{url}`, and `{type}` in an MCP command with shell-quoted values. */
export function mcpCommand(template: string, server: Partial<McpServer>): string {
  return template.replace(/\{(name|url|type)\}/g, (_, key: keyof McpServer) =>
    quoteShell(String(server[key] ?? "")),
  );
}

/** The executable of an MCP recipe: the first word of its list command. */
export function mcpBinary(mcp: ToolMcp): string {
  return mcp.list.split(" ")[0] as string;
}

/** Declare each carried server on the box. Return one warning for each server the box could not take. */
export async function registerBoxMcp(input: {
  readonly remoteHome: string;
  readonly harnesses: readonly HarnessDescriptor[];
  readonly tools: readonly ToolDescriptor[];
  readonly mcp: readonly SeedMcp[];
  readonly link: BoxSettingsLink;
}): Promise<readonly string[]> {
  const warnings: string[] = [];
  for (const entry of input.mcp) {
    const recipe = input.tools.find((tool) => tool.id === entry.harness)?.mcp;
    if (!recipe) continue;
    if (recipe.register) {
      warnings.push(...(await registerWithCli(entry, recipe, input.link)));
      continue;
    }
    const file = input.harnesses.find((harness) => harness.id === entry.harness)?.mcp?.file;
    if (file) await mergeMcpFile(posix.join(input.remoteHome, file), entry.servers, input.link);
  }
  return warnings;
}

/**
 * Run the add commands of the harness CLI in one box script. A server whose
 * `get` output already shows the carried URL is left alone, so its login stays.
 */
async function registerWithCli(
  entry: SeedMcp,
  recipe: ToolMcp,
  link: BoxSettingsLink,
): Promise<string[]> {
  const register = recipe.register as NonNullable<ToolMcp["register"]>;
  const binary = mcpBinary(recipe);
  const steps = entry.servers.map((server) => {
    const url = quoteShell(server.url);
    const declared = `${mcpCommand(register.get, server)} 2>/dev/null | grep -qF -- ${url}`;
    return [
      `if ! ${declared}; then`,
      `${mcpCommand(register.remove, server)} >/dev/null 2>&1;`,
      `${mcpCommand(register.add, server)} </dev/null >/dev/null 2>&1;`,
      `${declared} || printf 'S\\t%s\\n' ${quoteShell(server.name)};`,
      "fi",
    ].join(" ");
  });
  const script = [
    `command -v ${binary} >/dev/null 2>&1 || { printf 'C\\n'; exit 0; }`,
    ...steps,
  ].join("\n");
  const result = await checked(link, `sh -c ${quoteShell(script)}`, { timeoutMs: REGISTER_TIMEOUT_MS });

  const warnings: string[] = [];
  for (const line of result.stdout.split("\n")) {
    const [kind, name] = line.split("\t");
    if (kind === "C") {
      warnings.push(`the ${binary} CLI is not on the box PATH; no ${entry.harness} MCP server was declared`);
    }
    if (kind === "S") warnings.push(`could not declare ${entry.harness} MCP server ${name}`);
  }
  return warnings;
}

/** Set each carried server in the `mcpServers` object of a JSON file. Keep all other entries and keys. */
async function mergeMcpFile(
  path: string,
  servers: readonly McpServer[],
  link: BoxSettingsLink,
): Promise<void> {
  const read = await checked(link, readCommand(path));
  const current = read.stdout.startsWith("F") ? read.stdout.slice(1) : null;
  let file: unknown = {};
  if (current !== null && current.trim() !== "") {
    try {
      file = JSON.parse(current);
    } catch {
      file = null;
    }
  }
  if (typeof file !== "object" || file === null || Array.isArray(file)) {
    throw new BoxSettingsError(`${path}: the box MCP file is not a JSON object`);
  }
  const merged = file as Record<string, unknown>;
  const declared = { ...record(merged.mcpServers) };
  for (const server of servers) {
    declared[server.name] =
      server.type === "sse" ? { type: "sse", url: server.url } : { url: server.url };
  }
  merged.mcpServers = declared;
  const text = `${JSON.stringify(merged, null, 2)}\n`;
  if (text !== current) await checked(link, writeCommand(path, text));
}
