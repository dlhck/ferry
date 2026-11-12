/**
 * The MCP gateway as a user service on a box, for a box with
 * `mcp_gateway = true` in `[box.<name>]`. The operator machine runs this code.
 *
 * - Sync writes `~/.ferry/mcp-gateway/servers.json` from the carried remote
 *   servers and the stdio servers of `mcp_gateway_shared`, makes the client
 *   key on the box when it is missing, and installs and starts
 *   `ferry-mcp-gateway.service`, which runs `ferry mcp serve`. The box copies
 *   the `env` values of a shared server from its harness entries into
 *   `servers.json` with jq, so they never reach Ferry.
 * - When the key goes off, sync stops and removes the unit and deletes
 *   `~/.ferry/mcp-gateway/`, with the tokens.
 * - `ferry status` reads `ferry mcp list --json` on the box.
 * - `ferry auth --mcp <server>` logs in the gateway with `MCP_GATEWAY_TOOL`.
 *
 * No command prints the client key or a token. The key never leaves the box.
 * This module does not load the gateway or the MCP SDK.
 */

import { quoteShell } from "../box-settings.ts";
import type { LinkResult, RunOptions } from "../link.ts";
import type { RemoteMcpServer, SeedMcp } from "../manifest.ts";
import type { ToolDescriptor } from "../registry/types.ts";
import { linkPathDirs, unitPath } from "../tools/path.ts";
import { systemdService, type UserService } from "../watch-service.ts";
import type { GatewayServerState } from "./login.ts";
import { SERVER_NAME } from "./store.ts";

/** The Ferry binary of a box install. `ferry install` and `ferry update` put it there. */
const BOX_FERRY = '"$HOME/.local/bin/ferry"';
const GATEWAY_DIR = '"$HOME/.ferry/mcp-gateway"';
const UNIT_FILE = '"$HOME/.config/systemd/user/ferry-mcp-gateway.service"';

export const MCP_GATEWAY_SERVICE: UserService = {
  command: "mcp serve",
  label: "dev.ferry.mcp-gateway",
  log: "ferry-mcp-gateway.log",
  unit: "ferry-mcp-gateway.service",
  description: "Ferry MCP gateway",
  args: ["mcp", "serve"],
  restart: "on-failure",
};

/**
 * The login recipe of the gateway for `AuthStart`. `ferry status` shows a
 * gateway login as `gateway/<server>`. The list prints `<server> login-required`
 * for a server without a valid login.
 */
export const MCP_GATEWAY_TOOL: ToolDescriptor = {
  id: "gateway",
  mcp: {
    list: `${BOX_FERRY} mcp list`,
    loginRequired: "^(\\S+)\\s+login-required$",
    login: `${BOX_FERRY} mcp login {name}`,
  },
};

type GatewayLink = { run(command: string, options?: RunOptions): Promise<LinkResult> };

/** One server of `servers.json` as Ferry sends it: a remote server, or a shared stdio server without its `env` values. */
export type GatewayServerEntry = { readonly url: string } | { readonly command: string; readonly args: readonly string[] };

/**
 * The `servers.json` of the gateway: the remote servers of the harnesses that
 * are on for the box, and the stdio servers of `shared`. It has only names,
 * URLs, commands, and arguments. A carried remote server has no headers,
 * because Manifest refuses a server with headers. `envKeys` has the env key
 * names of each shared server, from all harnesses.
 */
export function gatewayServers(
  mcp: readonly SeedMcp[],
  harnesses: readonly string[],
  shared: readonly string[] = [],
): {
  readonly servers: Readonly<Record<string, GatewayServerEntry>>;
  readonly envKeys: Readonly<Record<string, readonly string[]>>;
  readonly warnings: readonly string[];
} {
  const servers: Record<string, GatewayServerEntry> = {};
  const envKeys: Record<string, string[]> = {};
  const warnings: string[] = [];
  for (const entry of mcp) {
    if (!harnesses.includes(entry.harness)) continue;
    for (const server of entry.servers) {
      if (server.type === "stdio") continue;
      const remote: RemoteMcpServer = server;
      const name = `${entry.harness}/${remote.name}`;
      if (remote.type === "sse") {
        warnings.push(`The MCP gateway does not serve ${name}, because the gateway supports Streamable HTTP only, not SSE.`);
      } else if (!SERVER_NAME.test(remote.name)) {
        warnings.push(`The MCP gateway does not serve ${name}, because a gateway server name cannot start with a dot.`);
      } else if (servers[remote.name] === undefined) {
        servers[remote.name] = { url: remote.url };
      } else if ((servers[remote.name] as { url: string }).url !== remote.url) {
        warnings.push(`The MCP gateway serves ${remote.name} with the URL of the first harness. ${name} has another URL.`);
      }
    }
  }
  // The stdio servers come after the remote servers, so that a remote server keeps its name on the gateway.
  for (const entry of mcp) {
    if (!harnesses.includes(entry.harness)) continue;
    for (const server of entry.servers) {
      if (server.type !== "stdio" || !shared.includes(server.name)) continue;
      const name = `${entry.harness}/${server.name}`;
      const known = servers[server.name];
      if (!SERVER_NAME.test(server.name)) {
        warnings.push(`The MCP gateway does not share ${name}, because a gateway server name cannot start with a dot.`);
      } else if (known !== undefined && "url" in known) {
        warnings.push(`The MCP gateway does not share ${name}, because it serves the remote server ${server.name} of another harness.`);
      } else if (known === undefined) {
        servers[server.name] = { command: server.command, args: server.args };
        envKeys[server.name] = [...server.env];
      } else if (known.command !== server.command || JSON.stringify(known.args) !== JSON.stringify(server.args)) {
        warnings.push(`The MCP gateway shares ${server.name} with the command of the first harness. ${name} has another command or other arguments.`);
      } else {
        envKeys[server.name] = [...new Set([...(envKeys[server.name] ?? []), ...server.env])];
      }
    }
  }
  const carried = new Set(mcp.filter((entry) => harnesses.includes(entry.harness)).flatMap((entry) => entry.servers.filter((server) => server.type === "stdio").map((server) => server.name)));
  for (const name of shared) {
    if (!carried.has(name)) warnings.push(`mcp_gateway_shared names ${name}, but Ferry carries no stdio MCP server ${name} to this box. Ferry ignores the name.`);
  }
  const sorted = Object.fromEntries(Object.entries(servers).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
  return { servers: sorted, envKeys, warnings };
}

/**
 * The unit file of the gateway on a box with the home `remoteHome`. It gets
 * the box PATH directories `pathDirs` in front of the system PATH, as the
 * Paseo unit, so a shared stdio server finds the same commands as an agent.
 */
export function gatewayUnit(remoteHome: string, pathDirs: readonly string[]): string {
  return systemdService(MCP_GATEWAY_SERVICE, [`${remoteHome}/.local/bin/ferry`], unitPath(pathDirs), undefined);
}

/**
 * A jq program for the new `servers.json`. `$new` is the file from Ferry,
 * with the env key names of each shared server in `envKeys`. `$old` is the
 * file on the box. The inputs are the lines of `sharedEnvScript`. A shared
 * server keeps the `env` of the old file when it has all keys, else gets the
 * `env` of the first harness entry with all keys, else the first `env` that
 * the box has.
 */
const MERGE_SERVERS = [
  "def full($k): type == \"object\" and ([$k[] as $x | .[$x] | type == \"string\" and . != \"\"] | all);",
  "$new[0] as $n | (($old[0] // {}).servers // {}) as $o | [inputs] as $h |",
  "{servers: ($n.servers | with_entries(if (.value | has(\"command\")) then",
  "  .key as $s | ($n.envKeys[$s] // []) as $k |",
  "  ([($o[$s] | if type == \"object\" and has(\"command\") then .env else null end)] + [$h[] | select(.n == $s) | .env]) as $c |",
  "  .value.env = (([$c[] | select(full($k))] + [$c[] | select(type == \"object\")] + [{}])[0] | with_entries(select(.value | type == \"string\")))",
  "else . end))}",
].join("\n");

/**
 * Write `servers.json`, make the client key when it is missing, write the
 * unit, and start it. A changed unit restarts the service. The gateway reads
 * `servers.json` at each request, so a server change needs no restart.
 *
 * Stdin has two lines: `servers.json` without the shared servers, then
 * `servers.json` with them and their env key names. `cleanup` runs first,
 * while the old `servers.json` is there, so that the entries of a server
 * that is no longer shared get their `env` values back. Then jq builds the
 * new file with the `env` values of the old file and of `envScript`. Without
 * jq, the box writes the first line, but keeps an old file that has a stdio
 * server, and prints `nojq` when Ferry asked to share a server.
 *
 * The command prints `missing` when the box has no Ferry, `old` when the
 * Ferry of the box has no `ferry mcp serve`, else the output of `cleanup`,
 * `unit` when the unit changed, then `running` or `stopped`. It never prints
 * the key or an `env` value.
 */
export function enableGatewayCommand(unit: string, cleanup: string | null = null, envScript = ":"): string {
  const name = MCP_GATEWAY_SERVICE.unit;
  return [
    `[ -f "$HOME/.ferry/box.json" ] && [ -x ${BOX_FERRY} ] || { echo missing; exit 0; }`,
    // A Ferry before the gateway prints the general help for `mcp serve --help`.
    `${BOX_FERRY} mcp serve --help 2>/dev/null | grep -q '^Usage: ferry mcp serve' || { echo old; exit 0; }`,
    `d=${GATEWAY_DIR}`,
    `u=${UNIT_FILE}`,
    'mkdir -p "${u%/*}" || exit 1',
    `printf '%s' ${quoteShell(unit)} > "$u.tmp" || exit 1`,
    'if cmp -s "$u.tmp" "$u"; then rm -f "$u.tmp"; changed=0; else mv -f "$u.tmp" "$u" || exit 1; changed=1; echo unit; fi',
    "umask 077",
    'mkdir -p "$d" && chmod 700 "$d" || exit 1',
    'IFS= read -r direct && IFS= read -r shared || exit 1',
    ...(cleanup === null ? [] : [cleanup]),
    `if command -v jq >/dev/null 2>&1; then`,
    `  printf '%s\\n' "$shared" > "$d/servers.json.new" || exit 1`,
    `  [ -f "$d/servers.json" ] || printf '{}\\n' > "$d/servers.json" || exit 1`,
    `  { ${envScript}\n} </dev/null | jq -n --slurpfile new "$d/servers.json.new" --slurpfile old "$d/servers.json" ${quoteShell(MERGE_SERVERS)} > "$d/servers.json.tmp" || { rm -f "$d/servers.json.new" "$d/servers.json.tmp"; exit 1; }`,
    `  rm -f "$d/servers.json.new"`,
    `else`,
    `  [ "$direct" = "$shared" ] || echo nojq`,
    `  if [ -f "$d/servers.json" ] && grep -qF '"command":' "$d/servers.json"; then :; else printf '%s\\n' "$direct" > "$d/servers.json.tmp" || exit 1; fi`,
    `fi`,
    '[ ! -f "$d/servers.json.tmp" ] || mv -f "$d/servers.json.tmp" "$d/servers.json" || exit 1',
    'if [ ! -s "$d/client-key" ]; then',
    "  k=$(od -An -N32 -tx1 /dev/urandom | tr -d ' \\n') || exit 1",
    '  [ "${#k}" -eq 64 ] || exit 1',
    `  printf '%s\\n' "$k" > "$d/client-key.tmp" && mv -f "$d/client-key.tmp" "$d/client-key" || exit 1`,
    "fi",
    'if [ "$changed" = 1 ]; then',
    "  systemctl --user daemon-reload >/dev/null || exit 1",
    `  systemctl --user enable ${name} >/dev/null 2>&1 && systemctl --user restart ${name} >/dev/null || exit 1`,
    "else",
    `  systemctl --user enable --now ${name} >/dev/null 2>&1 || exit 1`,
    "fi",
    `systemctl --user is-active --quiet ${name} && echo running || echo stopped`,
  ].join("\n");
}

/**
 * Run `cleanup` first, which changes the harness entries of the gateway. Then
 * stop and remove the unit and delete the gateway directory, with the tokens
 * and the client key. The command prints the output of `cleanup`, then
 * `removed` when it removed something. It prints nothing on a box without
 * the gateway, and then it does not run `cleanup`.
 *
 * When `cleanup` prints a failure (`F`, `J`, or `S`), the command keeps the
 * unit and the directory and prints `kept`. `servers.json` can be the only
 * copy of the `env` values of a shared server, and an entry that still
 * points at the gateway needs the running gateway. The next sync tries again.
 */
export function disableGatewayCommand(cleanup: string | null): string {
  return [
    `d=${GATEWAY_DIR}`,
    `u=${UNIT_FILE}`,
    '[ -e "$u" ] || [ -e "$d" ] || exit 0',
    ...(cleanup === null
      ? []
      : [`o=$(${cleanup})`, `[ -z "$o" ] || printf '%s\\n' "$o"`, `if printf '%s\\n' "$o" | grep -q "$(printf '^[FJS]\\t')"; then echo kept; exit 0; fi`]),
    `systemctl --user disable --now ${MCP_GATEWAY_SERVICE.unit} >/dev/null 2>&1`,
    'rm -f "$u" || exit 1',
    "systemctl --user daemon-reload >/dev/null 2>&1",
    'rm -rf "$d" || exit 1',
    "echo removed",
  ].join("\n");
}

/**
 * The command that `ferry update` runs after it changes the Ferry binary of a
 * box with the gateway, so that the gateway runs the new binary. A stopped
 * service stays stopped, and the next sync starts it. A box without the unit,
 * such as a box that updates from a Ferry before the gateway, has nothing to restart.
 */
export const RESTART_GATEWAY_COMMAND = `{ [ ! -f ${UNIT_FILE} ] || systemctl --user try-restart ${MCP_GATEWAY_SERVICE.unit}; }`;

/**
 * `sharing` is false when the box could not copy the `env` values of the
 * shared servers, because it has no jq. Then the harness entries of these
 * servers must stay direct. `output` has the output of `cleanup`.
 */
export type GatewaySyncResult =
  | { readonly state: "missing" }
  | { readonly state: "old" }
  | {
      readonly state: "running" | "stopped";
      readonly servers: number;
      readonly unitChanged: boolean;
      readonly sharing: boolean;
      readonly output: string;
    };

/**
 * Write the gateway files on the box and start the service. `envKeys` has
 * the env key names of each shared stdio server of `servers`. `cleanup` and
 * `envScript` are box scripts: see `enableGatewayCommand`.
 */
export async function enableGateway(
  link: GatewayLink,
  remoteHome: string,
  servers: Readonly<Record<string, GatewayServerEntry>>,
  shared: { readonly envKeys: Readonly<Record<string, readonly string[]>>; readonly cleanup: string | null; readonly envScript: string } = {
    envKeys: {},
    cleanup: null,
    envScript: ":",
  },
): Promise<GatewaySyncResult> {
  const direct = Object.fromEntries(Object.entries(servers).filter(([, server]) => "url" in server));
  const full = Object.keys(shared.envKeys).length > 0 ? { servers, envKeys: shared.envKeys } : { servers: direct };
  const result = await link.run(enableGatewayCommand(gatewayUnit(remoteHome, linkPathDirs(link)), shared.cleanup, shared.envScript), {
    input: new TextEncoder().encode(`${JSON.stringify({ servers: direct })}\n${JSON.stringify(full)}\n`),
  });
  if (!result.ok) throw new Error(`${result.error.origin}/${result.error.code}: ${result.error.message}`);
  const lines = result.stdout.split("\n").map((line) => line.trim());
  if (lines.includes("missing")) return { state: "missing" };
  if (lines.includes("old")) return { state: "old" };
  return {
    state: lines.includes("running") ? "running" : "stopped",
    servers: Object.keys(servers).length,
    unitChanged: lines.includes("unit"),
    sharing: !lines.includes("nojq"),
    output: result.stdout,
  };
}

/**
 * Remove the gateway from the box, after `cleanup`. `removed` is true when the
 * box had the gateway. `kept` is true when `cleanup` failed, so the box keeps
 * the gateway. `output` has the other output lines, from `cleanup`.
 */
export async function disableGateway(
  link: GatewayLink,
  cleanup: string | null,
): Promise<{ readonly removed: boolean; readonly kept: boolean; readonly output: string }> {
  const result = await link.run(disableGatewayCommand(cleanup));
  if (!result.ok) throw new Error(`${result.error.origin}/${result.error.code}: ${result.error.message}`);
  const lines = result.stdout.split("\n");
  return {
    removed: lines.includes("removed"),
    kept: lines.includes("kept"),
    output: lines.filter((line) => line !== "removed" && line !== "kept").join("\n"),
  };
}

/**
 * The gateway of one box in `ferry status`. `unavailable`: this Ferry is a
 * development build, or the box has no Ferry, so the gateway cannot run.
 * `reason` says which. `servers` has the login state of each server, and no
 * URL, token, or key.
 */
export type McpGatewayStatus = {
  readonly state: "running" | "stopped" | "unavailable";
  readonly reason: string | null;
  readonly port: number | null;
  readonly servers: readonly { readonly name: string; readonly state: GatewayServerState }[];
};

/** The fix of a shared stdio server that the gateway cannot share. */
export function cannotShareText(server: string, box: string): string {
  return `The stdio MCP server ${server} sent a request to the client, so the MCP gateway cannot share it between agents. On the operator machine, remove ${server} from mcp_gateway_shared in [box.${box}] of ~/.ferry/config.toml, then run ferry sync --box ${box}.`;
}

export const GATEWAY_STATUS_COMMAND = `[ -f "$HOME/.ferry/box.json" ] && [ -x ${BOX_FERRY} ] || { echo missing; exit 0; }\n${BOX_FERRY} --json mcp list`;

export const DEVELOPMENT_BUILD_REASON = "this Ferry is a development build, so the box has no Ferry";

/** Read the gateway state of the box. */
export async function readGatewayStatus(link: GatewayLink): Promise<McpGatewayStatus> {
  const result = await link.run(GATEWAY_STATUS_COMMAND);
  if (!result.ok) throw new Error(`Ferry could not read the MCP gateway state: ${result.error.origin}/${result.error.code}`);
  return parseGatewayStatus(result.stdout);
}

export function parseGatewayStatus(stdout: string): McpGatewayStatus {
  if (stdout.trim() === "missing") return { state: "unavailable", reason: "Ferry is not on the box", port: null, servers: [] };
  let envelope: { ok?: unknown; result?: { gateway?: { state?: unknown; port?: unknown }; servers?: unknown } };
  try {
    envelope = JSON.parse(stdout.trim().split("\n").at(-1) ?? "");
  } catch {
    throw new Error("ferry mcp list on the box gave no valid JSON");
  }
  const gateway = envelope.result?.gateway;
  const servers = envelope.result?.servers;
  if (envelope.ok !== true || (gateway?.state !== "running" && gateway?.state !== "stopped") || !Array.isArray(servers)) {
    throw new Error("ferry mcp list on the box gave an unexpected result");
  }
  return {
    state: gateway.state,
    reason: null,
    port: typeof gateway.port === "number" ? gateway.port : null,
    servers: servers.flatMap((server: { name?: unknown; state?: unknown }) =>
      typeof server.name === "string" && (server.state === "ready" || server.state === "login-required" || server.state === "cannot-share")
        ? [{ name: server.name, state: server.state }]
        : [],
    ),
  };
}
