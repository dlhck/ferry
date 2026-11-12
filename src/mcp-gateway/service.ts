/**
 * The MCP gateway as a user service on a box, for a box with
 * `mcp_gateway = true` in `[box.<name>]`. The operator machine runs this code.
 *
 * - Sync writes `~/.ferry/mcp-gateway/servers.json` from the carried remote
 *   servers, makes the client key on the box when it is missing, and installs
 *   and starts `ferry-mcp-gateway.service`, which runs `ferry mcp serve`.
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
import { systemdService, type UserService } from "../watch-service.ts";
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

/**
 * The `servers.json` of the gateway: the remote servers of the harnesses that
 * are on for the box. It has only names and URLs. A carried remote server has
 * no headers, because Manifest refuses a server with headers.
 */
export function gatewayServers(
  mcp: readonly SeedMcp[],
  harnesses: readonly string[],
): { readonly servers: Readonly<Record<string, { readonly url: string }>>; readonly warnings: readonly string[] } {
  const servers: Record<string, { url: string }> = {};
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
      } else if (servers[remote.name]!.url !== remote.url) {
        warnings.push(`The MCP gateway serves ${remote.name} with the URL of the first harness. ${name} has another URL.`);
      }
    }
  }
  const sorted = Object.fromEntries(Object.entries(servers).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
  return { servers: sorted, warnings };
}

/** The unit file of the gateway on a box with the home `remoteHome`. */
export function gatewayUnit(remoteHome: string): string {
  return systemdService(MCP_GATEWAY_SERVICE, [`${remoteHome}/.local/bin/ferry`], "/usr/local/bin:/usr/bin:/bin", undefined);
}

/**
 * Write `servers.json` from stdin, make the client key when it is missing,
 * write the unit, and start it. A changed unit restarts the service. The
 * gateway reads `servers.json` at each request, so a server change needs no
 * restart. The command prints `missing` when the box has no Ferry, else
 * `unit` when the unit changed, then `running` or `stopped`. It never prints the key.
 */
export function enableGatewayCommand(unit: string): string {
  const name = MCP_GATEWAY_SERVICE.unit;
  return [
    `[ -f "$HOME/.ferry/box.json" ] && [ -x ${BOX_FERRY} ] || { echo missing; exit 0; }`,
    `d=${GATEWAY_DIR}`,
    `u=${UNIT_FILE}`,
    'mkdir -p "${u%/*}" || exit 1',
    `printf '%s' ${quoteShell(unit)} > "$u.tmp" || exit 1`,
    'if cmp -s "$u.tmp" "$u"; then rm -f "$u.tmp"; changed=0; else mv -f "$u.tmp" "$u" || exit 1; changed=1; echo unit; fi',
    "umask 077",
    'mkdir -p "$d" && chmod 700 "$d" || exit 1',
    'cat > "$d/servers.json.tmp" && mv -f "$d/servers.json.tmp" "$d/servers.json" || exit 1',
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
 * Stop and remove the unit and delete the gateway directory, with the tokens
 * and the client key. The command prints `removed` when it removed
 * something, and nothing on a box without the gateway.
 */
export const DISABLE_GATEWAY_COMMAND = [
  `d=${GATEWAY_DIR}`,
  `u=${UNIT_FILE}`,
  '[ -e "$u" ] || [ -e "$d" ] || exit 0',
  `systemctl --user disable --now ${MCP_GATEWAY_SERVICE.unit} >/dev/null 2>&1`,
  'rm -f "$u" || exit 1',
  "systemctl --user daemon-reload >/dev/null 2>&1",
  'rm -rf "$d" || exit 1',
  "echo removed",
].join("\n");

/**
 * The command that `ferry update` runs after it changes the Ferry binary of a
 * box with the gateway, so that the gateway runs the new binary. A stopped
 * service stays stopped, and the next sync starts it.
 */
export const RESTART_GATEWAY_COMMAND = `systemctl --user try-restart ${MCP_GATEWAY_SERVICE.unit}`;

export type GatewaySyncResult =
  | { readonly state: "missing" }
  | { readonly state: "running" | "stopped"; readonly servers: number; readonly unitChanged: boolean };

/** Write the gateway files on the box and start the service. */
export async function enableGateway(
  link: GatewayLink,
  remoteHome: string,
  servers: Readonly<Record<string, { readonly url: string }>>,
): Promise<GatewaySyncResult> {
  const result = await link.run(enableGatewayCommand(gatewayUnit(remoteHome)), {
    input: new TextEncoder().encode(`${JSON.stringify({ servers })}\n`),
  });
  if (!result.ok) throw new Error(`${result.error.origin}/${result.error.code}: ${result.error.message}`);
  const lines = result.stdout.split("\n").map((line) => line.trim());
  if (lines.includes("missing")) return { state: "missing" };
  return {
    state: lines.includes("running") ? "running" : "stopped",
    servers: Object.keys(servers).length,
    unitChanged: lines.includes("unit"),
  };
}

/** Remove the gateway from the box. True when the box had it. */
export async function disableGateway(link: GatewayLink): Promise<boolean> {
  const result = await link.run(DISABLE_GATEWAY_COMMAND);
  if (!result.ok) throw new Error(`${result.error.origin}/${result.error.code}: ${result.error.message}`);
  return result.stdout.trim() === "removed";
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
  readonly servers: readonly { readonly name: string; readonly state: "ready" | "login-required" }[];
};

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
      typeof server.name === "string" && (server.state === "ready" || server.state === "login-required")
        ? [{ name: server.name, state: server.state }]
        : [],
    ),
  };
}
