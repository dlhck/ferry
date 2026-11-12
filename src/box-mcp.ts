/**
 * Declare the carried MCP servers on the box, and check what their stdio
 * servers need there.
 *
 * Ferry adds a carried server or updates it. It never removes a box server
 * that the operator does not carry, with one exception: an entry of an earlier
 * sync that runs from a macOS app bundle. A login stays on the box: ferry declares
 * servers here and `AuthStart` starts their logins. The environment values of
 * a stdio server stay on the box too. The box merges its own entry with jq or
 * the harness CLI, and prints back only a status letter or key names, so an
 * env value never reaches Ferry.
 *
 * On a box with the MCP gateway, a remote server that the gateway serves gets
 * an entry with the gateway URL and the client key of the box in place of
 * its direct entry. The box reads the key from its file and writes it only
 * into the harness entry, so the key never reaches Ferry. When the gateway
 * goes off, the direct path declares the carried URL again, and so replaces
 * each gateway entry of a carried server. `gatewayCleanupCommand` removes a
 * gateway entry of a server that Ferry no longer carries.
 *
 * A stdio server in `mcp_gateway_shared` gets a gateway entry too. Before
 * that, `sharedEnvScript` gives the box the `env` values of its harness
 * entries, and the box copies them into the gateway file. When the server is
 * no longer shared, `gatewayCleanupCommand` writes the direct entry again,
 * with the `env` values of the gateway file. The direct path leaves a gateway
 * entry of a stdio server as it is, so that the cleanup can do this.
 */

import { posix } from "node:path";
import {
  BoxSettingsError,
  checked,
  quoteShell,
  type BoxSettingsLink,
} from "./box-settings.ts";
import { APP_BUNDLE_PATH, type McpSource, type NonPortableMcp, type RemoteMcpServer, type SeedMcp, type StdioMcpServer } from "./manifest.ts";
import type { Progress } from "./progress.ts";
import type { HarnessDescriptor, ToolDescriptor, ToolMcp } from "./registry/types.ts";
import { GATEWAY_URL_PREFIX, gatewayUrl } from "./mcp-gateway/url.ts";

/** Codex waits in `mcp add` for a login callback, so each server gets more time than one command. */
const REGISTER_TIMEOUT_MS = 600_000;

/** A jq filter: `$e`, the box entry, has the command and arguments of `$c`, the carried entry. */
const SAME_COMMAND = '($e | type) == "object" and $e.command == $c.command and ($e.args // []) == $c.args';
/** A jq filter: the box entry `$e` points at the MCP gateway. `$p` is `GATEWAY_URL_PREFIX`. */
const IS_GATEWAY = '($e | type) == "object" and (($e.url // "") | type == "string" and startswith($p))';
/** A jq filter: the carried entry `$c` with the `env` of the box entry `$e`, when it has one. */
const WITH_BOX_ENV = '$c + (if ($e | type) == "object" and ($e | has("env")) then {env: $e.env} else {} end)';
/**
 * A jq filter for a JSON MCP file: set each carried entry of `$s` under the
 * key `$k`, and keep the `env` and `env_vars` of the box entry. A gateway
 * entry stays as it is.
 */
const MERGE_FILE =
  `.[$k] = ((.[$k] // {}) as $b | $b + ($s | with_entries(.key as $n | ($b[$n] // null) as $e | if ${IS_GATEWAY} then .value = $e else .value += (($e // {}) | ` +
  'if type == "object" then with_entries(select(.key == "env" or .key == "env_vars")) else {} end) end)))';
/** A jq filter for a JSON MCP file: set each carried entry of `$s` under the key `$k`. */
const REPLACE_FILE = '.[$k] = ((.[$k] // {}) + $s)';
/** The client key of the MCP gateway on the box, as a shell word. */
const CLIENT_KEY = '"$HOME/.ferry/mcp-gateway/client-key"';
/** A jq expression: the `Authorization` header value for the client key in `$g`, the text of its file. */
const BEARER = '("Bearer " + ($g | rtrimstr("\\n")))';
/** A jq filter for a JSON MCP file: set each gateway entry of `$s` under the key `$k`, with the client key header. */
const GATEWAY_FILE = `.[$k] = ((.[$k] // {}) + ($s | map_values(. + {headers: {Authorization: ${BEARER}}})))`;
/** A jq filter: the command or an argument of the box entry `$e` is a path in a macOS app bundle. `$r` is `APP_BUNDLE_PATH`. */
const IN_APP_BUNDLE =
  '($e | type) == "object" and ([$e.command, ($e.args // [])[]?] | any(type == "string" and test($r; "i")))';
/**
 * A jq filter on one `{key, value}` item of an MCP map: the value is a gateway
 * entry, and the name is not in `$keep`. `$p` is `GATEWAY_URL_PREFIX`.
 */
const STALE_GATEWAY_ENTRY =
  '(.value | type) == "object" and ((.value.url // .value.transport.url // "") | type == "string" and startswith($p))' +
  ' and (.key | test("^[A-Za-z0-9._-]+$")) and (.key as $n | $keep | any(. == $n) | not)';
/** A jq prefix: `$sv` is the gateway file that `--slurpfile svs` read, or `{}`. */
const GATEWAY_FILE_VALUE = '($svs[0] // {}) as $sv | ';
/** A jq expression: with `$restore`, the direct URL of the server `$n` in the gateway file `$sv`, or null. */
const DIRECT_URL =
  '($sv.servers[$n].url // null) as $r | if $restore and ($r | type) == "string" and ($r | startswith("https://")) then $r else null end';
/** A jq expression: the direct entry of the shared stdio server `$n` in the gateway file `$sv`, with its `env`, or null. */
const SHARED_ENTRY =
  '($sv.servers[$n] // null) | if type == "object" and (.command | type) == "string" then ' +
  '{command, args: (.args // []), env: ((.env // {}) | with_entries(select(.value | type == "string")))} else null end';
/** A jq filter: `<server>\t<key>` for each key of `$w` that the env `$e` of the server `$n` does not set. */
const MISSING_KEYS = '$w[] | select(($e[.] // "") | type != "string" or . == "") | "\\($n)\\t\\(.)"';
/** The gateway file on the box, relative to the home. It has the `env` values of the shared stdio servers. */
const GATEWAY_SERVERS_FILE = ".ferry/mcp-gateway/servers.json";
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
  /** The names of the servers that the MCP gateway of the box serves. Absent on a box without the gateway. */
  readonly gateway?: readonly string[];
  /** The names of the stdio servers that the MCP gateway shares, also in `gateway`. Their `env` values are in the gateway file. */
  readonly shared?: readonly string[];
}): Promise<readonly string[]> {
  const served = new Set(input.gateway ?? []);
  const shared = new Set((input.shared ?? []).filter((name) => served.has(name)));
  const entries = declared(input.mcp, input.tools);
  const total = entries.reduce((sum, { entry }) => sum + entry.servers.length, 0);
  let current = 0;
  const advance = (servers: number) => {
    current += servers;
    input.progress?.count(current, total);
  };
  const warnings: string[] = [];
  if (input.gateway) {
    const command = gatewayCleanupCommand(input.harnesses, input.tools, input.remoteHome, input.mcp, false);
    if (command !== null) warnings.push(...gatewayCleanupLines((await checked(input.link, command)).stdout));
  }
  for (const { entry, recipe } of entries) {
    const file = input.harnesses.find((harness) => harness.id === entry.harness)?.mcp;
    const path = file ? posix.join(input.remoteHome, file.file) : null;
    const box = path && file ? { path, file } : null;
    for (const name of entry.appBundle ?? []) warnings.push(...(await removeAppBundle(entry.harness, name, recipe, box, input.link)));
    const remotes = entry.servers.filter((server): server is RemoteMcpServer => server.type !== "stdio");
    const remote = remotes.filter((server) => !served.has(server.name));
    const stdio = entry.servers.filter((server): server is StdioMcpServer => server.type === "stdio" && !shared.has(server.name));
    const gateway = entry.servers.filter((server) => (server.type === "stdio" ? shared.has(server.name) : served.has(server.name)));
    if (gateway.length > 0) warnings.push(...(await registerGateway(entry.harness, gateway, recipe, box, input.link, advance)));
    if (remote.length > 0 && recipe.register) {
      warnings.push(...(await registerWithCli({ harness: entry.harness, servers: remote }, recipe, input.link, advance)));
    } else if (remote.length > 0) {
      advance(remote.length);
      const entries = Object.fromEntries(
        remote.map((server) => [server.name, server.type === "sse" ? { type: "sse", url: server.url } : { url: server.url }]),
      );
      const names = remote.map((server) => server.name).join(", ");
      warnings.push(...(await mergeFileOnBox(entry.harness, names, entries, REPLACE_FILE, box, input.link)));
    }
    if (stdio.length === 0) continue;
    warnings.push(...(await registerStdio(entry.harness, stdio, recipe, box, input.link, advance)));
  }
  return warnings;
}

/**
 * Something a carried stdio server lacks on the box. `env-missing`: the box
 * entry sets no value for `keys`. `env-unchecked`: the box has no jq, so Ferry
 * cannot check `keys`. `command-missing`: `command` is not on the box PATH and
 * no registry tool supplies it. `not-portable`: ferry does not carry the
 * server, because it refers to a path in the operator home or runs an inline
 * script. `reason` says which. A server that Ferry skips for a path in a macOS
 * app bundle gives no issue, because the operator has nothing to do.
 */
export type BoxMcpIssue =
  | { readonly kind: "env-missing"; readonly harness: string; readonly server: string; readonly keys: readonly string[]; readonly file: string }
  | { readonly kind: "env-unchecked"; readonly harness: string; readonly server: string; readonly keys: readonly string[] }
  | { readonly kind: "command-missing"; readonly harness: string; readonly server: string; readonly command: string }
  | { readonly kind: "not-portable"; readonly harness: string; readonly server: string; readonly reason: Exclude<NonPortableMcp["reason"], "app-bundle"> };

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
  /** The stdio servers that the MCP gateway shares. Ferry checks their env keys in the gateway file, as the harness `gateway`. */
  readonly shared?: readonly string[];
}): Promise<readonly BoxMcpIssue[]> {
  const shared = new Set(input.shared ?? []);
  const issues: BoxMcpIssue[] = [];
  const stdio: { harness: string; server: StdioMcpServer }[] = [];
  const recipes = new Map<string, ToolMcp>();
  for (const { entry, recipe } of declared(input.sources, input.tools)) {
    recipes.set(entry.harness, recipe);
    for (const server of entry.nonPortable) {
      if (server.reason !== "app-bundle") issues.push({ kind: "not-portable", harness: entry.harness, server: server.name, reason: server.reason });
    }
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
    const needs = stdio
      .filter((item) => item.harness === harness.id && item.server.env.length > 0 && !shared.has(item.server.name))
      .map((item) => item.server);
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

  // A shared server has one env for all harnesses, in the gateway file. It needs each key that a harness carries.
  const want: Record<string, string[]> = {};
  for (const { server } of stdio) {
    if (shared.has(server.name) && server.env.length > 0) want[server.name] = [...new Set([...(want[server.name] ?? []), ...server.env])];
  }
  if (Object.keys(want).length > 0) {
    const filter = `.servers as $m | $want | to_entries[] | .key as $n | .value as $w | (($m[$n] // {}).env // {}) as $e | ${MISSING_KEYS}`;
    const script = [
      `${HAS_JQ} || { printf 'J\\n'; exit 0; }`,
      `f="$HOME/${GATEWAY_SERVERS_FILE}"`,
      `{ [ -e "$f" ] && cat "$f" || printf '{}'; } | jq -r --argjson want ${quoteShell(JSON.stringify(want))} ${quoteShell(filter)} 2>/dev/null || printf 'E\\n'`,
    ].join("\n");
    const lines = (await checked(input.link, `sh -c ${quoteShell(script)}`)).stdout.split("\n");
    if (lines.includes("E")) throw new BoxSettingsError("gateway: Ferry cannot read the MCP gateway file");
    for (const [name, env] of Object.entries(want)) {
      const keys = env.filter((key) => lines.includes(`${name}\t${key}`));
      if (lines.includes("J")) issues.push({ kind: "env-unchecked", harness: "gateway", server: name, keys: env });
      else if (keys.length > 0) issues.push({ kind: "env-missing", harness: "gateway", server: name, keys, file: GATEWAY_SERVERS_FILE });
    }
  }
  return issues;
}

/**
 * The box script that prints one JSON line `{"n": <server>, "env": <env>}`
 * for each harness entry of a shared stdio server, in harness order. `env` is
 * null for an entry without `env`, such as a gateway entry. The enable command
 * of the gateway reads these lines on the box, so no `env` value reaches Ferry.
 */
export function sharedEnvScript(
  harnesses: readonly HarnessDescriptor[],
  tools: readonly ToolDescriptor[],
  home: string,
  mcp: readonly SeedMcp[],
  shared: readonly string[],
): string {
  const lines = harnesses.flatMap((harness) => {
    const recipe = tools.find((tool) => tool.id === harness.id)?.mcp;
    const names =
      mcp
        .find((entry) => entry.harness === harness.id)
        ?.servers.filter((server) => server.type === "stdio" && shared.includes(server.name))
        .map((server) => server.name) ?? [];
    if (!recipe || !harness.mcp || names.length === 0) return [];
    const getJson = recipe.register?.getJson;
    if (getJson) {
      const line = (name: string) =>
        `  ${mcpCommand(getJson, { name })} </dev/null 2>/dev/null | jq -c --arg n ${quoteShell(name)} '{n: $n, env: ((.transport // .).env // null)}' 2>/dev/null`;
      return [`if command -v ${mcpBinary(recipe)} >/dev/null 2>&1; then`, ...names.map(line), "fi"];
    }
    if (harness.mcp.format !== "json") return [];
    const path = quoteShell(posix.join(home, harness.mcp.file));
    const filter = '(.[$k] // {}) | to_entries[] | select(.key as $x | $names | any(. == $x)) | {n: .key, env: (.value | if type == "object" then .env else null end)}';
    return [`[ ! -f ${path} ] || jq -c --arg k ${quoteShell(harness.mcp.key)} --argjson names ${quoteShell(JSON.stringify(names))} ${quoteShell(filter)} ${path} 2>/dev/null`];
  });
  return lines.length === 0 ? ":" : lines.join("\n");
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
  if (getJson) {
    const lines = servers.map((server) => {
      const read = `{ ${mcpCommand(getJson, server)} 2>/dev/null || printf '{}'; }`;
      const filter = `((.transport // .).env // {}) as $e | ${MISSING_KEYS}`;
      return `${read} | jq -r --arg n ${quoteShell(server.name)} --argjson w ${quoteShell(JSON.stringify(server.env))} ${quoteShell(filter)} 2>/dev/null || printf 'E\\n'`;
    });
    return [`${HAS_JQ} || { printf 'J\\n'; exit 0; }`, ...lines].join("\n");
  }
  if (file.format !== "json") return null;
  const want = Object.fromEntries(servers.map((server) => [server.name, server.env]));
  const filter = `.[$k] as $m | $want | to_entries[] | .key as $n | .value as $w | (($m[$n] // {}).env // {}) as $e | ${MISSING_KEYS}`;
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
 * `S` the merge failed. With `gateway`, jq reads the client key of the
 * gateway from its file into `$g`, and the box prints `K` when it has no key.
 */
async function mergeFileOnBox(
  harness: string,
  names: string,
  entries: Record<string, unknown>,
  filter: string,
  box: { readonly path: string; readonly file: McpFile } | null,
  link: BoxSettingsLink,
  gateway = false,
): Promise<string[]> {
  if (!box || box.file.format !== "json") return [`could not declare ${harness} MCP servers ${names}`];
  const created = `${JSON.stringify({ [box.file.key]: entries }, null, 2)}\n`;
  const prefix = filter === MERGE_FILE ? ` --arg p ${quoteShell(GATEWAY_URL_PREFIX)}` : "";
  const args = `--arg k ${quoteShell(box.file.key)} --argjson s ${quoteShell(JSON.stringify(entries))}${prefix}${gateway ? ` --rawfile g ${CLIENT_KEY}` : ""}`;
  const script = [
    `f=${quoteShell(box.path)}`,
    "umask 077",
    ...(gateway
      ? [
          `[ -s ${CLIENT_KEY} ] || { printf 'K\\n'; exit 0; }`,
          `${HAS_JQ} || { printf 'J\\n'; exit 0; }`,
          `[ -e "$f" ] || { mkdir -p "$(dirname "$f")" && printf '{}\\n' > "$f"; } || { printf 'S\\n'; exit 0; }`,
        ]
      : [
          `if [ ! -e "$f" ]; then mkdir -p "$(dirname "$f")" && printf '%s' ${quoteShell(created)} > "$f.ferry-tmp" && mv "$f.ferry-tmp" "$f" || printf 'S\\n'; exit 0; fi`,
          `${HAS_JQ} || { printf 'J\\n'; exit 0; }`,
        ]),
    `jq -e ${args} ${quoteShell(`(${filter}) == .`)} "$f" >/dev/null 2>&1 && exit 0`,
    `if jq ${args} ${quoteShell(filter)} "$f" > "$f.ferry-tmp" 2>/dev/null; then mv "$f.ferry-tmp" "$f"; else rm -f "$f.ferry-tmp"; printf 'S\\n'; fi`,
  ].join("\n");
  const { stdout } = await checked(link, `sh -c ${quoteShell(script)}`);
  if (stdout.startsWith("K")) return [noClientKey(harness, names)];
  if (stdout.startsWith("J")) {
    return [`jq is not on the box, so Ferry did not update ${harness} MCP servers ${names}. Run ferry update to install jq.`];
  }
  if (stdout.startsWith("S")) return [`could not declare ${harness} MCP servers ${names}`];
  return [];
}

function noClientKey(harness: string, names: string): string {
  return `the box has no MCP gateway client key, so Ferry did not point ${harness} MCP ${names} at the gateway. Sync again to make the key.`;
}

/**
 * Point remote servers and shared stdio servers at the MCP gateway: the URL `gatewayUrl(name)` and the
 * header `Authorization: Bearer <client key>`. The box reads the key from its
 * file, writes it only into the harness entry, and prints only a status
 * letter: `C` the harness CLI is missing, `K` the box has no client key, `J`
 * jq is missing, `S` the declaration failed. A harness with `addJson` gets
 * the entry with the header from the CLI. A harness with `headersTable` gets
 * the URL from `add`, and the box appends the header table to its TOML MCP
 * file. Else the box merges the entries into the JSON MCP file with jq. An
 * entry that already has the URL and the key stays as it is.
 */
async function registerGateway(
  harness: string,
  servers: readonly { readonly name: string }[],
  recipe: ToolMcp,
  box: { readonly path: string; readonly file: McpFile } | null,
  link: BoxSettingsLink,
  advance: (servers: number) => void,
): Promise<string[]> {
  const register = recipe.register;
  const names = servers.map((server) => server.name).join(", ");
  if (!register) {
    advance(servers.length);
    const entries = Object.fromEntries(servers.map((server) => [server.name, { url: gatewayUrl(server.name) }]));
    return mergeFileOnBox(harness, names, entries, GATEWAY_FILE, box, link, true);
  }
  const binary = mcpBinary(recipe);
  const warnings: string[] = [];
  for (const server of servers) {
    advance(1);
    const values = { name: server.name, url: gatewayUrl(server.name), type: "http" };
    const script = register.addJson
      ? gatewayJsonScript(register, values)
      : register.headersTable && register.getJson && box?.file.format === "toml"
        ? gatewayTomlScript(register, values, box)
        : null;
    if (script === null) {
      warnings.push(`could not point ${harness} MCP server ${server.name} at the gateway`);
      continue;
    }
    const { stdout } = await checked(
      link,
      `sh -c ${quoteShell(
        [
          `command -v ${binary} >/dev/null 2>&1 || { printf 'C\\n'; exit 0; }`,
          `[ -s ${CLIENT_KEY} ] || { printf 'K\\n'; exit 0; }`,
          `${HAS_JQ} || { printf 'J\\n'; exit 0; }`,
          `u=${quoteShell(values.url)}`,
          script,
        ].join("\n"),
      )}`,
      { timeoutMs: REGISTER_TIMEOUT_MS },
    );
    if (stdout.startsWith("C")) {
      warnings.push(`the ${binary} CLI is not on the box PATH; no ${harness} MCP server was declared`);
      return warnings;
    }
    if (stdout.startsWith("K")) {
      warnings.push(noClientKey(harness, names));
      return warnings;
    }
    if (stdout.startsWith("J")) {
      warnings.push(`jq is not on the box, so Ferry did not point ${harness} MCP ${names} at the gateway. Run ferry update to install jq.`);
      return warnings;
    }
    if (stdout.startsWith("S")) warnings.push(`could not point ${harness} MCP server ${server.name} at the gateway`);
  }
  return warnings;
}

/**
 * The box script for a gateway entry with `addJson`. jq reads the key from
 * its file and builds the declaration. The script compares the `get` output
 * with shell patterns only, so the key is in the arguments of no command but
 * the add command.
 */
function gatewayJsonScript(register: NonNullable<ToolMcp["register"]>, server: McpCommandValues): string {
  const declaration = `{type: "http", url: $u, headers: {Authorization: ${BEARER}}}`;
  const add = (register.addJson as string).replaceAll("{json}", '"$c"');
  return [
    `k=$(tr -d '\\n' < ${CLIENT_KEY})`,
    `o=$(${mcpCommand(register.get, server)} 2>/dev/null) && case "$o" in *"$u"*) case "$o" in *"Bearer $k"*) exit 0;; esac;; esac`,
    `c=$(jq -cn --arg u "$u" --rawfile g ${CLIENT_KEY} ${quoteShell(declaration)}) || { printf 'S\\n'; exit 0; }`,
    `${mcpCommand(register.remove, server)} >/dev/null 2>&1`,
    `${mcpCommand(add, server)} </dev/null >/dev/null 2>&1 || printf 'S\\n'`,
  ].join("\n");
}

/**
 * The box script for a gateway entry with `headersTable`. `add` writes the
 * entry with the URL, and the box appends the header table with the key to
 * the TOML MCP file and makes the file private. `remove` takes away an old
 * header table, so the file never has the table twice.
 */
function gatewayTomlScript(
  register: NonNullable<ToolMcp["register"]>,
  server: McpCommandValues,
  box: { readonly path: string; readonly file: McpFile },
): string {
  const same = `(.transport // .) as $t | $t.url == $u and ($t.${register.headersTable}.Authorization // "") == ${BEARER}`;
  const check = `${mcpCommand(register.getJson as string, server)} 2>/dev/null | jq -e --arg u "$u" --rawfile g ${CLIENT_KEY} ${quoteShell(same)} >/dev/null 2>&1`;
  const table = `[${box.file.key}.${JSON.stringify(server.name)}.${register.headersTable}]`;
  return [
    `${check} && exit 0`,
    `${mcpCommand(register.remove, server)} >/dev/null 2>&1`,
    `${mcpCommand(register.add, server)} </dev/null >/dev/null 2>&1`,
    `f=${quoteShell(box.path)}`,
    // A header table without its server entry is not a valid Codex server, so the box appends it only after a complete add.
    `${mcpCommand(register.get, server)} >/dev/null 2>&1 && [ -f "$f" ] || { printf 'S\\n'; exit 0; }`,
    `k=$(tr -d '\\n' < ${CLIENT_KEY})`,
    `printf '\\n%s\\nAuthorization = "Bearer %s"\\n' ${quoteShell(table)} "$k" >> "$f" && chmod 600 "$f" || { printf 'S\\n'; exit 0; }`,
    `${check} || printf 'S\\n'`,
  ].join("\n");
}

/**
 * Remove the box entry `name` of an earlier sync, only when its own command or
 * an argument is a path in a macOS app bundle. Such an entry cannot run on the
 * box. Another entry with that name stays. The box reads its entry from the
 * JSON MCP file or with `getJson`, compares it with jq, and removes it with
 * the harness CLI or from the JSON MCP file. It prints only a status letter:
 * `R` removed, `J` jq is missing, `S` the removal failed.
 */
async function removeAppBundle(
  harness: string,
  name: string,
  recipe: ToolMcp,
  box: { readonly path: string; readonly file: McpFile } | null,
  link: BoxSettingsLink,
): Promise<string[]> {
  const register = recipe.register;
  const file = box?.file.format === "json" ? box : null;
  const getJson = register?.getJson;
  if (!file && !(register && getJson)) return [];
  const args = `--arg k ${quoteShell(file?.file.key ?? "")} --arg n ${quoteShell(name)} --arg r ${quoteShell(APP_BUNDLE_PATH)}`;
  const script = [
    ...(register ? [`command -v ${mcpBinary(recipe)} >/dev/null 2>&1 || exit 0`] : []),
    ...(file
      ? [`f=${quoteShell(file.path)}`, `[ -f "$f" ] && grep -qF -- ${quoteShell(JSON.stringify(name))} "$f" || exit 0`]
      : [`${mcpCommand((register as NonNullable<ToolMcp["register"]>).get, { name })} >/dev/null 2>&1 || exit 0`]),
    `${HAS_JQ} || { printf 'J\\n'; exit 0; }`,
    file
      ? `jq -e ${args} ${quoteShell(`(.[$k][$n] // null) as $e | ${IN_APP_BUNDLE}`)} "$f" >/dev/null 2>&1 || exit 0`
      : `${mcpCommand(getJson as string, { name })} 2>/dev/null | jq -e ${args} ${quoteShell(`(.transport // .) as $e | ${IN_APP_BUNDLE}`)} >/dev/null 2>&1 || exit 0`,
    register
      ? `${mcpCommand(register.remove, { name })} >/dev/null 2>&1 && printf 'R\\n' || printf 'S\\n'`
      : `umask 077; if jq ${args} 'del(.[$k][$n])' "$f" > "$f.ferry-tmp" 2>/dev/null; then mv "$f.ferry-tmp" "$f" && printf 'R\\n'; else rm -f "$f.ferry-tmp"; printf 'S\\n'; fi`,
  ].join("\n");
  const { stdout } = await checked(link, `sh -c ${quoteShell(script)}`);
  if (stdout.startsWith("R")) {
    return [`Ferry removed ${harness} MCP server ${name} from the box, because it runs from a macOS app bundle, which the box does not have.`];
  }
  if (stdout.startsWith("J")) {
    return [
      `jq is not on the box, so Ferry cannot tell if ${harness} MCP server ${name} on the box runs from a macOS app bundle, and leaves it. Run ferry update to install jq.`,
    ];
  }
  if (stdout.startsWith("S")) return [`could not remove ${harness} MCP server ${name} from the box`];
  return [];
}

/**
 * Remove and add one server with `addJson`. When the box file names the
 * server, jq on the box keeps an entry with the carried command and arguments
 * or a gateway entry, or adds the `env` of the box entry to the declaration.
 * Without jq, only a server that the file does not name is added.
 */
function addJsonScript(
  register: NonNullable<ToolMcp["register"]>,
  server: StdioMcpServer,
  carried: string,
  box: { readonly path: string; readonly file: McpFile } | null,
): string {
  const entry = "(.[$k][$n] // null) as $e";
  const args = `--arg k ${quoteShell(box?.file.key ?? "")} --arg n ${quoteShell(server.name)} --arg p ${quoteShell(GATEWAY_URL_PREFIX)} --argjson c "$c"`;
  const add = (register.addJson as string).replaceAll("{json}", '"$c"');
  return [
    `c=${quoteShell(carried)}`,
    ...(box
      ? [
          `f=${quoteShell(box.path)}`,
          `if [ -f "$f" ] && grep -qF -- ${quoteShell(JSON.stringify(server.name))} "$f"; then`,
          `  ${HAS_JQ} || { printf 'J\\n'; exit 0; }`,
          `  jq -e ${args} ${quoteShell(`${entry} | (${SAME_COMMAND}) or (${IS_GATEWAY})`)} "$f" >/dev/null 2>&1 && exit 0`,
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
 * is: with the carried command and arguments or a gateway entry nothing is to
 * do, and else the box prints `U`, because the CLI would drop the env
 * settings of the entry.
 */
function addStdioScript(register: NonNullable<ToolMcp["register"]>, server: StdioMcpServer, carried: string): string {
  const command = [server.command, ...server.args].map(quoteShell).join(" ");
  const add = (register.addStdio as string).replaceAll("{command}", command);
  const getJson = register.getJson ? mcpCommand(register.getJson, server) : null;
  const same = `(.transport // .) as $e | (${SAME_COMMAND}) or (${IS_GATEWAY})`;
  return [
    `c=${quoteShell(carried)}`,
    `if ${mcpCommand(register.get, server)} >/dev/null 2>&1; then`,
    ...(getJson
      ? [
          `  ${HAS_JQ} || { printf 'J\\n'; exit 0; }`,
          `  ${getJson} 2>/dev/null | jq -e --argjson c "$c" --arg p ${quoteShell(GATEWAY_URL_PREFIX)} ${quoteShell(same)} >/dev/null 2>&1 && exit 0`,
        ]
      : []),
    "  printf 'U\\n'; exit 0",
    "fi",
    `${mcpCommand(add, server)} </dev/null >/dev/null 2>&1`,
    `${mcpCommand(register.get, server)} >/dev/null 2>&1 || printf 'S\\n'`,
  ].join("\n");
}

/**
 * One box command that cleans the gateway entries of each harness: each entry
 * whose URL starts with `GATEWAY_URL_PREFIX` and whose server is not in the
 * carried servers `mcp` of the harness. With `shared`, a carried stdio server
 * that is not in `shared` counts as not carried, so that its gateway entry
 * goes too. An entry of a stdio server in `~/.ferry/mcp-gateway/servers.json`
 * gets its direct entry back, with the `env` values of that file. With
 * `restore`, an entry of a remote server in that file gets the direct URL
 * from it. Ferry removes each other such entry. Ferry changes no entry
 * without the prefix. `null` when no harness has an MCP recipe. Read the
 * output with `gatewayCleanupLines`. The script never reads the client key,
 * and prints no `env` value.
 */
export function gatewayCleanupCommand(
  harnesses: readonly HarnessDescriptor[],
  tools: readonly ToolDescriptor[],
  home: string,
  mcp: readonly SeedMcp[],
  restore: boolean,
  shared?: readonly string[],
): string | null {
  const keep = (harness: string) =>
    mcp
      .find((entry) => entry.harness === harness)
      ?.servers.filter((server) => shared === undefined || server.type !== "stdio" || shared.includes(server.name))
      .map((server) => server.name) ?? [];
  const scripts = harnesses.flatMap((harness) => {
    const recipe = tools.find((tool) => tool.id === harness.id)?.mcp;
    const script = recipe && harness.mcp ? cleanupScript(harness.id, posix.join(home, harness.mcp.file), harness.mcp, recipe, keep(harness.id), restore) : null;
    return script === null ? [] : [`(\n${script}\n)`];
  });
  return scripts.length === 0 ? null : `sh -c ${quoteShell(scripts.join("\n"))}`;
}

/**
 * The lines of the output of `gatewayCleanupCommand` and
 * `sharedRestoreCommand`, one for each change or failure. The box prints `R`
 * removed, `D` direct again, `F` the change failed, `M` Ferry could not give
 * an entry its env values back, `J` jq is missing, `S` Ferry cannot read the
 * entries, each with the harness and the server name.
 */
export function gatewayCleanupLines(stdout: string): string[] {
  return stdout.split("\n").flatMap((line) => {
    const [kind, harness = "", name = ""] = line.split("\t");
    if (!/^[a-z0-9-]+$/.test(harness) || (name !== "" && !/^[A-Za-z0-9._-]+$/.test(name))) return [];
    if (kind === "R") return [`Ferry removed ${harness} MCP server ${name} from the box. It pointed at the MCP gateway, and Ferry does not carry it.`];
    if (kind === "D") return [`Ferry changed ${harness} MCP server ${name} on the box back to its direct entry.`];
    if (kind === "F") return [`could not change ${harness} MCP server ${name} on the box, which points at the MCP gateway`];
    if (kind === "M") return [`could not give ${harness} MCP server ${name} on the box its env values back from ~/.ferry/mcp-gateway/servers.json`];
    if (kind === "J") return [`jq is not on the box, so Ferry did not check the ${harness} MCP entries of the gateway. Run ferry update to install jq.`];
    if (kind === "S") return [`could not read the ${harness} MCP servers on the box to check the entries of the gateway`];
    return [];
  });
}

/** True when the output of `gatewayCleanupCommand` or `sharedRestoreCommand` has a failure: `F`, `M`, `J`, or `S`. */
export function gatewayCleanupFailed(stdout: string): boolean {
  return stdout.split("\n").some((line) => /^[FMJS]\t/.test(line));
}

/**
 * A jq filter on the harness entry `.` of the stdio server `$n`: a direct
 * entry that sets each `env` key of `$n` in the gateway file `$svs`.
 */
const HAS_SHARED_ENV =
  `${GATEWAY_FILE_VALUE}. as $e | (($sv.servers[$n] // {}).env // {}) as $w | ($e | type) == "object" and ((${IS_GATEWAY}) | not) and ` +
  '([$w | keys[] as $x | (($e.env // {})[$x] // "") | type == "string" and . != ""] | all)';

/**
 * One box command that runs after `gatewayCleanupCommand`, before the box
 * deletes `~/.ferry/mcp-gateway/` or drops a server from `servers.json`. For
 * each carried stdio server of a harness that is not in `shared`, and that
 * `servers.json` has with a command, the harness entry must set each `env`
 * key of `servers.json`. An entry that is missing or lacks a key gets the
 * direct entry of `servers.json` with its `env` values, as in the cleanup.
 * The box prints `D` for each such entry, and `M` when it could not write it.
 * So a failed restore in one sync, and a direct entry without `env` in the
 * next sync, cannot delete the only copy of the values. `null` when no
 * harness carries such a server. Read the output with `gatewayCleanupLines`.
 */
export function sharedRestoreCommand(
  harnesses: readonly HarnessDescriptor[],
  tools: readonly ToolDescriptor[],
  home: string,
  mcp: readonly SeedMcp[],
  shared: readonly string[] = [],
): string | null {
  const scripts = harnesses.flatMap((harness) => {
    const recipe = tools.find((tool) => tool.id === harness.id)?.mcp;
    const names =
      mcp
        .find((entry) => entry.harness === harness.id)
        ?.servers.filter((server) => server.type === "stdio" && !shared.includes(server.name))
        .map((server) => server.name) ?? [];
    const access = recipe && harness.mcp && names.length > 0 ? entryAccess(harness.id, posix.join(home, harness.mcp.file), harness.mcp, recipe) : null;
    if (access === null) return [];
    const script = [
      access.head,
      `${access.present} || exit 0`,
      `${HAS_JQ} || { printf 'J\\t%s\\n' "$h"; exit 0; }`,
      'svf="$HOME/.ferry/mcp-gateway/servers.json"',
      '[ -f "$svf" ] || exit 0',
      "umask 077",
      `for n in ${names.map(quoteShell).join(" ")}; do`,
      `  ${SHARED_FILE_ENTRY}`,
      '  [ -n "$e" ] || continue',
      `  c=$(${access.read})`,
      '  [ -n "$c" ] || c=null',
      `  printf '%s' "$c" | jq -e --arg n "$n" --arg p ${quoteShell(GATEWAY_URL_PREFIX)} --slurpfile svs "$svf" ${quoteShell(HAS_SHARED_ENV)} >/dev/null 2>&1`,
      "  s=$?",
      '  [ "$s" = 0 ] && continue',
      `  if [ "$s" = 1 ] && ${access.write}; then ${REPORT("D")}; else ${REPORT("M")}; fi`,
      "done",
    ].join("\n");
    return [`(\n${script}\n)`];
  });
  return scripts.length === 0 ? null : `sh -c ${quoteShell(scripts.join("\n"))}`;
}

/**
 * The box command of `ferry box remove --uninstall` for the harness entries
 * of the gateway: `gatewayCleanupCommand` with `restore`, then a check of
 * `servers.json` itself, because the box does not know the carried servers.
 * For each stdio server of `servers.json`, at least one harness must have a
 * direct entry that sets all its `env` keys. If none has, the box writes the
 * entry of `servers.json` into each harness that is on the box, and prints
 * `D` or `M` for each. So a failed restore in one run cannot delete the only
 * copy of the values in the next run. `null` when no harness has an MCP
 * recipe. Read the output with `gatewayCleanupLines`.
 */
export function uninstallCleanupCommand(
  harnesses: readonly HarnessDescriptor[],
  tools: readonly ToolDescriptor[],
  home: string,
): string | null {
  const cleanup = gatewayCleanupCommand(harnesses, tools, home, [], true);
  const access = harnesses.flatMap((harness) => {
    const recipe = tools.find((tool) => tool.id === harness.id)?.mcp;
    const found = recipe && harness.mcp ? entryAccess(harness.id, posix.join(home, harness.mcp.file), harness.mcp, recipe) : null;
    return found === null ? [] : [found];
  });
  if (access.length === 0) return cleanup;
  // Run `body` for each harness that is on the box, with `$h`, `$f`, and `$c`, the entry of `$n` or `null`.
  const each = (body: string) =>
    access.flatMap((harness) => [
      ...harness.head.split("\n").map((line) => `  ${line}`),
      `  if ${harness.present}; then`,
      `    c=$(${harness.read})`,
      '    [ -n "$c" ] || c=null',
      `    ${body.replaceAll("WRITE", harness.write)}`,
      "  fi",
    ]);
  const names =
    '.servers // {} | to_entries[] | select((.value | type) == "object" and (.value.command | type) == "string") | .key | select(test("^[A-Za-z0-9._-]+$"))';
  const check = [
    `${HAS_JQ} || { printf 'J\\tgateway\\n'; exit 0; }`,
    'svf="$HOME/.ferry/mcp-gateway/servers.json"',
    '[ -f "$svf" ] || exit 0',
    "umask 077",
    `names=$(jq -r ${quoteShell(names)} "$svf" 2>/dev/null) || { printf 'S\\tgateway\\n'; exit 0; }`,
    // The names have only the characters of the filter, so the shell splits them safely.
    "for n in $names; do",
    `  ${SHARED_FILE_ENTRY}`,
    '  [ -n "$e" ] || continue',
    "  ok=0",
    ...each(`printf '%s' "$c" | jq -e --arg n "$n" --arg p ${quoteShell(GATEWAY_URL_PREFIX)} --slurpfile svs "$svf" ${quoteShell(HAS_SHARED_ENV)} >/dev/null 2>&1 && ok=1`),
    '  [ "$ok" = 1 ] && continue',
    ...each(`if WRITE; then ${REPORT("D")}; else ${REPORT("M")}; fi`),
    "done",
  ].join("\n");
  return [cleanup, `sh -c ${quoteShell(check)}`].filter((command) => command !== null).join("\n");
}

/** A box line that sets `$e` to the direct entry of the stdio server `$n` in the gateway file `$svf`, with its `env`, or to nothing. */
const SHARED_FILE_ENTRY = `e=$(jq -cn --arg n "$n" --slurpfile svs "$svf" ${quoteShell(`${GATEWAY_FILE_VALUE}${SHARED_ENTRY} | values`)} 2>/dev/null)`;

/** A box command that prints one result line for the harness `$h` and the server `$n`. */
const REPORT = (kind: string) => `printf '${kind}\\t%s\\t%s\\n' "$h" "$n"`;

/**
 * The box parts that read and write the entry `$n` of one harness. `head`
 * sets `$h` and `$f`. `present` is a test for the harness on the box.
 * `read` prints the entry as JSON, or nothing. `write` writes `$e`, the
 * direct entry of `servers.json`, in place of the entry `$c`. `null` when
 * Ferry has no way to read or write the entries.
 */
function entryAccess(
  harness: string,
  path: string,
  file: McpFile,
  recipe: ToolMcp,
): { readonly head: string; readonly present: string; readonly read: string; readonly write: string } | null {
  const register = recipe.register;
  const read =
    file.format === "json"
      ? `[ ! -f "$f" ] || jq -c --arg k ${quoteShell(file.key)} --arg n "$n" '.[$k][$n] // null' "$f" 2>/dev/null`
      : register?.getJson
        ? `${register.getJson.replaceAll("{name}", '"$n"')} </dev/null 2>/dev/null | jq -c '(.transport // .)' 2>/dev/null`
        : null;
  if (read === null || (!register && file.format !== "json")) return null;
  const write = register
    ? `{ [ "$c" = null ] || ${register.remove.replaceAll("{name}", '"$n"')} </dev/null >/dev/null 2>&1; } && ${restoreStdio(register, file)}`
    : `{ jq --arg k ${quoteShell(file.key)} --arg n "$n" --slurpfile svs "$svf" ${quoteShell(`${GATEWAY_FILE_VALUE}.[$k][$n] = (${SHARED_ENTRY})`)} "$f" > "$f.ferry-tmp" 2>/dev/null && mv "$f.ferry-tmp" "$f" || { rm -f "$f.ferry-tmp"; false; }; }`;
  return {
    head: `h=${quoteShell(harness)}\nf=${quoteShell(path)}`,
    present: register ? `command -v ${mcpBinary(recipe)} >/dev/null 2>&1` : '[ -f "$f" ]',
    read,
    write,
  };
}

/**
 * The box script of one harness for `gatewayCleanupCommand`. A harness with
 * `register` changes its entries with the CLI. Else jq changes the JSON MCP
 * file. Ferry reads a JSON MCP file with jq and a TOML MCP file with
 * `listJson`. jq reads the gateway file with `--slurpfile`, so that no `env`
 * value is in the arguments of a command, except the `addJson` declaration.
 * `null` when Ferry has no way to read the entries.
 */
function cleanupScript(
  harness: string,
  path: string,
  file: McpFile,
  recipe: ToolMcp,
  keep: readonly string[],
  restore: boolean,
): string | null {
  const register = recipe.register;
  const args = `--arg k ${quoteShell(file.key)} --arg p ${quoteShell(GATEWAY_URL_PREFIX)} --argjson keep ${quoteShell(JSON.stringify(keep))}`;
  const list =
    file.format === "json"
      ? `[ ! -f "$f" ] || jq -r ${args} ${quoteShell(`(.[$k] // {}) | to_entries[] | select(${STALE_GATEWAY_ENTRY}) | .key`)} "$f"`
      : register?.listJson
        ? `${register.listJson} 2>/dev/null | jq -r ${args} ${quoteShell(`map({key: .name, value: .})[] | select(${STALE_GATEWAY_ENTRY}) | .key`)}`
        : null;
  if (list === null || (!register && file.format !== "json")) return null;
  const report = (kind: string) => `printf '${kind}\\t%s\\t%s\\n' "$h" "$n"`;
  const gatewayFile = `--slurpfile svs "$svf" --argjson restore ${restore}`;
  const head = [
    `h=${quoteShell(harness)}`,
    `f=${quoteShell(path)}`,
    ...(register ? [`command -v ${mcpBinary(recipe)} >/dev/null 2>&1 || exit 0`] : []),
    `${HAS_JQ} || { printf 'J\\t%s\\n' "$h"; exit 0; }`,
    'svf="$HOME/.ferry/mcp-gateway/servers.json"',
    '[ -f "$svf" ] || svf=/dev/null',
    `names=$(${list}) || { printf 'S\\t%s\\n' "$h"; exit 0; }`,
    '[ -n "$names" ] || exit 0',
  ];
  if (register) {
    const remove = register.remove.replaceAll("{name}", '"$n"');
    const add = register.add.replaceAll("{name}", '"$n"').replaceAll("{url}", '"$r"').replaceAll("{type}", "http");
    return [
      ...head,
      'printf \'%s\\n\' "$names" | while IFS= read -r n; do',
      `  ${remove} </dev/null >/dev/null 2>&1 || { ${report("F")}; continue; }`,
      `  e=$(jq -cn --arg n "$n" ${gatewayFile} ${quoteShell(`${GATEWAY_FILE_VALUE}${SHARED_ENTRY} | values`)} 2>/dev/null)`,
      `  r=$(jq -rn --arg n "$n" ${gatewayFile} ${quoteShell(`${GATEWAY_FILE_VALUE}${DIRECT_URL} | values`)} 2>/dev/null)`,
      `  if [ -n "$e" ]; then ${restoreStdio(register, file)} && ${report("D")} || ${report("F")}`,
      `  elif [ -n "$r" ]; then ${add} </dev/null >/dev/null 2>&1 && ${report("D")} || ${report("F")}`,
      `  else ${report("R")}; fi`,
      "done",
    ].join("\n");
  }
  const rewrite =
    `${GATEWAY_FILE_VALUE}.[$k] |= ((. // {}) | with_entries(if ${STALE_GATEWAY_ENTRY} then ` +
    `(.key as $n | {e: (${SHARED_ENTRY}), r: (${DIRECT_URL})}) as $x | if $x.e then .value = $x.e elif $x.r then .value = {url: $x.r} else empty end else . end))`;
  const direct = `${GATEWAY_FILE_VALUE}(${SHARED_ENTRY}) // (${DIRECT_URL})`;
  return [
    ...head,
    "umask 077",
    `if jq ${args} ${gatewayFile} ${quoteShell(rewrite)} "$f" > "$f.ferry-tmp" 2>/dev/null && mv "$f.ferry-tmp" "$f"; then ok=1; else rm -f "$f.ferry-tmp"; ok=0; fi`,
    'printf \'%s\\n\' "$names" | while IFS= read -r n; do',
    `  if [ "$ok" = 0 ]; then ${report("F")}; elif jq -en --arg n "$n" ${gatewayFile} ${quoteShell(direct)} >/dev/null 2>&1; then ${report("D")}; else ${report("R")}; fi`,
    "done",
  ].join("\n");
}

/**
 * The box command that adds the direct entry `$e` of a shared stdio server
 * `$n` again. `$e` is the JSON entry with the command, the arguments, and the
 * `env`. A harness with `addJson` gets it from the CLI. A harness with
 * `addStdio` gets the command and the arguments from the CLI, and the box
 * appends the `env` table to its TOML MCP file and makes the file private.
 */
function restoreStdio(register: NonNullable<ToolMcp["register"]>, file: McpFile): string {
  if (register.addJson) {
    const add = register.addJson.replaceAll("{name}", '"$n"').replaceAll("{json}", '"$c"');
    return `{ c=$(printf '%s' "$e" | jq -c '{type: "stdio"} + .') && ${add} </dev/null >/dev/null 2>&1; }`;
  }
  if (!register.addStdio) return "false";
  const add = register.addStdio.replaceAll("{name}", '"$n"').replaceAll("{command}", '"$@"');
  const get = register.get.replaceAll("{name}", '"$n"');
  const table =
    '.env | if length == 0 then empty else "\\n[" + $k + "." + ($n | tojson) + ".env]\\n" + ' +
    '(to_entries | map("\\(.key | tojson) = \\(.value | tojson)") | join("\\n")) end';
  const env =
    file.format === "toml"
      ? ` && t=$(printf '%s' "$e" | jq -r --arg k ${quoteShell(file.key)} --arg n "$n" ${quoteShell(table)}) && { [ -z "$t" ] || { printf '%s\\n' "$t" >> "$f" && chmod 600 "$f"; }; }`
      : "";
  return `{ a=$(printf '%s' "$e" | jq -r '[.command] + .args | @sh') && eval "set -- $a" && ${add} </dev/null >/dev/null 2>&1; ${get} >/dev/null 2>&1${env}; }`;
}

type McpFile = NonNullable<HarnessDescriptor["mcp"]>;
