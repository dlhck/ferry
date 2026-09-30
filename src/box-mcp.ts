/**
 * Declare the carried MCP servers on the box, and check what their stdio
 * servers need there.
 *
 * Ferry adds a carried server or updates it. It never removes a box server
 * that the operator does not carry. A login stays on the box: ferry declares
 * servers here and `AuthStart` starts their logins. The environment values of
 * a stdio server stay on the box too. The box merges its own entry with jq or
 * the harness CLI, and prints back only a status letter or key names, so an
 * env value never reaches Ferry.
 */

import { posix } from "node:path";
import {
  BoxSettingsError,
  checked,
  quoteShell,
  type BoxSettingsLink,
} from "./box-settings.ts";
import type { McpSource, RemoteMcpServer, SeedMcp, StdioMcpServer } from "./manifest.ts";
import type { Progress } from "./progress.ts";
import type { HarnessDescriptor, ToolDescriptor, ToolMcp } from "./registry/types.ts";

/** Codex waits in `mcp add` for a login callback, so each server gets more time than one command. */
const REGISTER_TIMEOUT_MS = 600_000;

/** A jq filter: `$e`, the box entry, has the command and arguments of `$c`, the carried entry. */
const SAME_COMMAND = '($e | type) == "object" and $e.command == $c.command and ($e.args // []) == $c.args';
/** A jq filter: the carried entry `$c` with the `env` of the box entry `$e`, when it has one. */
const WITH_BOX_ENV = '$c + (if ($e | type) == "object" and ($e | has("env")) then {env: $e.env} else {} end)';
/**
 * A jq filter for a JSON MCP file: set each carried entry of `$s` under the
 * key `$k`, and keep the `env` and `env_vars` of the box entry.
 */
const MERGE_FILE =
  '.[$k] = ((.[$k] // {}) as $b | $b + ($s | with_entries(.key as $n | .value += (($b[$n] // {}) | ' +
  'if type == "object" then with_entries(select(.key == "env" or .key == "env_vars")) else {} end))))';
/** A jq filter for a JSON MCP file: set each carried entry of `$s` under the key `$k`. */
const REPLACE_FILE = '.[$k] = ((.[$k] // {}) + $s)';
/** A shell test that fails when jq is not on the box. */
const HAS_JQ = "command -v jq >/dev/null 2>&1";

type McpCommandValues = Partial<Record<"name" | "url" | "type", string>>;

/** Replace `{name}`, `{url}`, and `{type}` in an MCP command with shell-quoted values. */
export function mcpCommand(template: string, server: McpCommandValues): string {
  return template.replace(/\{(name|url|type)\}/g, (_, key: keyof McpCommandValues) =>
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
    const path = file ? posix.join(input.remoteHome, file.file) : null;
    const remote = entry.servers.filter((server): server is RemoteMcpServer => server.type !== "stdio");
    const stdio = entry.servers.filter((server): server is StdioMcpServer => server.type === "stdio");
    if (remote.length > 0 && recipe.register) {
      warnings.push(...(await registerWithCli({ harness: entry.harness, servers: remote }, recipe, input.link, advance)));
    } else if (remote.length > 0) {
      advance(remote.length);
      const entries = Object.fromEntries(
        remote.map((server) => [server.name, server.type === "sse" ? { type: "sse", url: server.url } : { url: server.url }]),
      );
      const names = remote.map((server) => server.name).join(", ");
      warnings.push(...(await mergeFileOnBox(entry.harness, names, entries, REPLACE_FILE, path && file ? { path, file } : null, input.link)));
    }
    if (stdio.length === 0) continue;
    const box = path && file ? { path, file } : null;
    warnings.push(...(await registerStdio(entry.harness, stdio, recipe, box, input.link, advance)));
  }
  return warnings;
}

/**
 * Something a carried stdio server lacks on the box. `env-missing`: the box
 * entry sets no value for `keys`. `env-unchecked`: the box has no jq, so Ferry
 * cannot check `keys`. `command-missing`: `command` is not on the box PATH and
 * no registry tool supplies it. `not-portable`: ferry does not carry the
 * server, because it refers to a path in the operator home.
 */
export type BoxMcpIssue =
  | { readonly kind: "env-missing"; readonly harness: string; readonly server: string; readonly keys: readonly string[]; readonly file: string }
  | { readonly kind: "env-unchecked"; readonly harness: string; readonly server: string; readonly keys: readonly string[] }
  | { readonly kind: "command-missing"; readonly harness: string; readonly server: string; readonly command: string }
  | { readonly kind: "not-portable"; readonly harness: string; readonly server: string };

/**
 * Check the carried stdio servers on the box, read-only. A command that a
 * registry tool supplies is left to the tool check, and ferry never installs
 * any other command. The box compares the env keys with jq and prints only
 * the names of the missing keys.
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
  const recipes = new Map<string, ToolMcp>();
  for (const { entry, recipe } of declared(input.sources, input.tools)) {
    recipes.set(entry.harness, recipe);
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
    const needs = stdio.filter((item) => item.harness === harness.id && item.server.env.length > 0).map((item) => item.server);
    if (!harness.mcp || needs.length === 0) continue;
    const getJson = recipes.get(harness.id)?.register?.getJson;
    const script = envCheckScript(posix.join(input.remoteHome, harness.mcp.file), harness.mcp, getJson, needs);
    if (script === null) continue;
    const { stdout } = await checked(input.link, `sh -c ${quoteShell(script)}`);
    const lines = stdout.split("\n");
    if (lines.includes("E")) throw new BoxSettingsError(`${harness.id}: Ferry cannot read the box MCP servers`);
    for (const server of needs) {
      if (lines.includes("J")) {
        issues.push({ kind: "env-unchecked", harness: harness.id, server: server.name, keys: server.env });
        continue;
      }
      const keys = server.env.filter((key) => lines.includes(`${server.name}\t${key}`));
      if (keys.length > 0) issues.push({ kind: "env-missing", harness: harness.id, server: server.name, keys, file: harness.mcp.file });
    }
  }
  return issues;
}

/**
 * The box script that prints `<server>\t<key>` for each carried env key that
 * the box entry does not set. It reads the entry with `getJson` of the harness
 * CLI, or from a JSON MCP file. It prints `J` without jq and `E` when jq fails.
 * `null` when Ferry has no way to read the entry.
 */
function envCheckScript(
  path: string,
  file: McpFile,
  getJson: string | undefined,
  servers: readonly StdioMcpServer[],
): string | null {
  const missing =
    '$w[] | select(($e[.] // "") | type != "string" or . == "") | "\\($n)\\t\\(.)"';
  if (getJson) {
    const lines = servers.map((server) => {
      const read = `{ ${mcpCommand(getJson, server)} 2>/dev/null || printf '{}'; }`;
      const filter = `((.transport // .).env // {}) as $e | ${missing}`;
      return `${read} | jq -r --arg n ${quoteShell(server.name)} --argjson w ${quoteShell(JSON.stringify(server.env))} ${quoteShell(filter)} 2>/dev/null || printf 'E\\n'`;
    });
    return [`${HAS_JQ} || { printf 'J\\n'; exit 0; }`, ...lines].join("\n");
  }
  if (file.format !== "json") return null;
  const want = Object.fromEntries(servers.map((server) => [server.name, server.env]));
  const filter = `.[$k] as $m | $want | to_entries[] | .key as $n | .value as $w | (($m[$n] // {}).env // {}) as $e | ${missing}`;
  return [
    `${HAS_JQ} || { printf 'J\\n'; exit 0; }`,
    `f=${quoteShell(path)}`,
    `{ [ -e "$f" ] && cat "$f" || printf '{}'; } | jq -r --arg k ${quoteShell(file.key)} --argjson want ${quoteShell(JSON.stringify(want))} ${quoteShell(filter)} 2>/dev/null || printf 'E\\n'`,
  ].join("\n");
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
 * Declare stdio servers on the box. The box merges each entry itself and
 * prints only a status letter: `C` the harness CLI is missing, `J` jq is
 * missing, `U` a Codex entry differs, `S` the declaration failed. A harness
 * with `addJson` gets one box command for each server; the harness CLI keeps
 * the `env` of a changed entry. A harness with `addStdio` gets new servers
 * only; a changed entry stays as it is. Else the box merges all servers into
 * the JSON MCP file with jq, in one command.
 */
async function registerStdio(
  harness: string,
  servers: readonly StdioMcpServer[],
  recipe: ToolMcp,
  box: { readonly path: string; readonly file: McpFile } | null,
  link: BoxSettingsLink,
  advance: (servers: number) => void,
): Promise<string[]> {
  const register = recipe.register;
  const binary = mcpBinary(recipe);
  const warnings: string[] = [];
  const noJq = (names: string) =>
    `jq is not on the box, so Ferry did not update ${harness} MCP ${names}. Run ferry update to install jq.`;
  if (register?.addJson || register?.addStdio) {
    for (const server of servers) {
      advance(1);
      const carried = JSON.stringify({ type: "stdio", command: server.command, args: server.args });
      const script = register.addJson
        ? addJsonScript(register, server, carried, box)
        : addStdioScript(register, server, carried);
      const { stdout } = await checked(link, `sh -c ${quoteShell(`command -v ${binary} >/dev/null 2>&1 || { printf 'C\\n'; exit 0; }\n${script}`)}`, {
        timeoutMs: REGISTER_TIMEOUT_MS,
      });
      if (stdout.startsWith("C")) {
        warnings.push(`the ${binary} CLI is not on the box PATH; no ${harness} MCP server was declared`);
        return warnings;
      }
      if (stdout.startsWith("J")) warnings.push(noJq(`server ${server.name}`));
      if (stdout.startsWith("U")) {
        warnings.push(
          `${harness} MCP server ${server.name} on the box has another command or arguments. Ferry leaves it as it is, so the box keeps its env settings. Remove it on the box, then sync again.`,
        );
      }
      if (stdout.startsWith("S")) warnings.push(`could not declare ${harness} MCP server ${server.name}`);
    }
    return warnings;
  }

  advance(servers.length);
  const names = servers.map((server) => server.name).join(", ");
  const entries = Object.fromEntries(servers.map((server) => [server.name, { command: server.command, args: server.args }]));
  return mergeFileOnBox(harness, names, entries, MERGE_FILE, box, link);
}

/**
 * Merge `entries` into the JSON MCP file of the box with the jq `filter`, in
 * one command. The box creates a missing file without jq, writes the file only
 * when an entry changes, and prints only a status letter: `J` jq is missing,
 * `S` the merge failed.
 */
async function mergeFileOnBox(
  harness: string,
  names: string,
  entries: Record<string, unknown>,
  filter: string,
  box: { readonly path: string; readonly file: McpFile } | null,
  link: BoxSettingsLink,
): Promise<string[]> {
  if (!box || box.file.format !== "json") return [`could not declare ${harness} MCP servers ${names}`];
  const created = `${JSON.stringify({ [box.file.key]: entries }, null, 2)}\n`;
  const args = `--arg k ${quoteShell(box.file.key)} --argjson s ${quoteShell(JSON.stringify(entries))}`;
  const script = [
    `f=${quoteShell(box.path)}`,
    "umask 077",
    `if [ ! -e "$f" ]; then mkdir -p "$(dirname "$f")" && printf '%s' ${quoteShell(created)} > "$f.ferry-tmp" && mv "$f.ferry-tmp" "$f" || printf 'S\\n'; exit 0; fi`,
    `${HAS_JQ} || { printf 'J\\n'; exit 0; }`,
    `jq -e ${args} ${quoteShell(`(${filter}) == .`)} "$f" >/dev/null 2>&1 && exit 0`,
    `if jq ${args} ${quoteShell(filter)} "$f" > "$f.ferry-tmp" 2>/dev/null; then mv "$f.ferry-tmp" "$f"; else rm -f "$f.ferry-tmp"; printf 'S\\n'; fi`,
  ].join("\n");
  const { stdout } = await checked(link, `sh -c ${quoteShell(script)}`);
  if (stdout.startsWith("J")) {
    return [`jq is not on the box, so Ferry did not update ${harness} MCP servers ${names}. Run ferry update to install jq.`];
  }
  if (stdout.startsWith("S")) return [`could not declare ${harness} MCP servers ${names}`];
  return [];
}

/**
 * Remove and add one server with `addJson`. When the box file names the
 * server, jq on the box keeps an entry with the carried command and arguments,
 * or adds the `env` of the box entry to the declaration. Without jq, only a
 * server that the file does not name is added.
 */
function addJsonScript(
  register: NonNullable<ToolMcp["register"]>,
  server: StdioMcpServer,
  carried: string,
  box: { readonly path: string; readonly file: McpFile } | null,
): string {
  const entry = "(.[$k][$n] // null) as $e";
  const args = `--arg k ${quoteShell(box?.file.key ?? "")} --arg n ${quoteShell(server.name)} --argjson c "$c"`;
  const add = (register.addJson as string).replaceAll("{json}", '"$c"');
  return [
    `c=${quoteShell(carried)}`,
    ...(box
      ? [
          `f=${quoteShell(box.path)}`,
          `if [ -f "$f" ] && grep -qF -- ${quoteShell(JSON.stringify(server.name))} "$f"; then`,
          `  ${HAS_JQ} || { printf 'J\\n'; exit 0; }`,
          `  jq -e ${args} ${quoteShell(`${entry} | ${SAME_COMMAND}`)} "$f" >/dev/null 2>&1 && exit 0`,
          `  c=$(jq -c ${args} ${quoteShell(`${entry} | ${WITH_BOX_ENV}`)} "$f" 2>/dev/null) || { printf 'S\\n'; exit 0; }`,
          "fi",
        ]
      : []),
    `${mcpCommand(register.remove, server)} >/dev/null 2>&1`,
    `${mcpCommand(add, server)} </dev/null >/dev/null 2>&1 || printf 'S\\n'`,
  ].join("\n");
}

/**
 * Add one new server with `addStdio`. A server that `get` finds stays as it
 * is: with the carried command and arguments nothing is to do, and else the
 * box prints `U`, because the CLI would drop the env settings of the entry.
 */
function addStdioScript(register: NonNullable<ToolMcp["register"]>, server: StdioMcpServer, carried: string): string {
  const command = [server.command, ...server.args].map(quoteShell).join(" ");
  const add = (register.addStdio as string).replaceAll("{command}", command);
  const getJson = register.getJson ? mcpCommand(register.getJson, server) : null;
  const same = `(.transport // .) as $e | ${SAME_COMMAND}`;
  return [
    `c=${quoteShell(carried)}`,
    `if ${mcpCommand(register.get, server)} >/dev/null 2>&1; then`,
    ...(getJson
      ? [
          `  ${HAS_JQ} || { printf 'J\\n'; exit 0; }`,
          `  ${getJson} 2>/dev/null | jq -e --argjson c "$c" ${quoteShell(same)} >/dev/null 2>&1 && exit 0`,
        ]
      : []),
    "  printf 'U\\n'; exit 0",
    "fi",
    `${mcpCommand(add, server)} </dev/null >/dev/null 2>&1`,
    `${mcpCommand(register.get, server)} >/dev/null 2>&1 || printf 'S\\n'`,
  ].join("\n");
}

type McpFile = NonNullable<HarnessDescriptor["mcp"]>;
