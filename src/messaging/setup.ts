/**
 * The services of agent messaging, the box steps of sync, and `ferry
 * messaging setup` and `teardown` on the operator machine (section 11 of the
 * agent messaging design).
 *
 * A box with `messaging = true` gets the hooks, the MCP entry
 * `ferry-messaging`, the relay URL in `~/.ferry/messaging/client.json`, and
 * the worker service. A box with `relay = true` also runs the team relay.
 * When a key goes off, sync removes the hooks, the MCP entry, and the unit,
 * and keeps `~/.ferry/messaging` and `~/.ferry/relay`: the first has the
 * device credential, and the second has the data of the team.
 *
 * Ferry writes nothing into a checkout or its Git metadata. This module loads
 * no relay, worker, or MCP SDK module.
 */

import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";
import { quoteShell } from "../box-settings.ts";
import { installMessagingSkill, type SkillInstallResult } from "../bundled-skill.ts";
import { FerryError } from "../errors.ts";
import type { LinkResult, RunOptions } from "../link.ts";
import type { SeedMcp } from "../manifest.ts";
import type { HarnessDescriptor } from "../registry/types.ts";
import { linkPathDirs, unitPath } from "../tools/path.ts";
import {
  installUserService,
  systemdService,
  uninstallUserService,
  type UserService,
  type WatchServiceInput,
  type WatchServiceResult,
} from "../watch-service.ts";
import { MESSAGING_DIR } from "./hook.ts";
import {
  addCodexHooksScript,
  addMessagingHooks,
  CODEX_HOOKS_FILE,
  MESSAGING_MCP_ARGS,
  MESSAGING_MCP_SERVER,
  removeMessagingHooks,
  removeMessagingHooksScript,
} from "./hooks.ts";

export const MESSAGING_SERVICE: UserService = {
  command: "messaging worker",
  label: "dev.ferry.messaging",
  log: "ferry-messaging.log",
  unit: "ferry-messaging.service",
  description: "Ferry agent messaging worker",
  args: ["messaging", "worker"],
  restart: "always",
};

export const RELAY_SERVICE: UserService = {
  command: "relay serve",
  label: "dev.ferry.relay",
  log: "ferry-relay.log",
  unit: "ferry-relay.service",
  description: "Ferry agent messaging relay",
  args: ["relay", "serve"],
  restart: "always",
};

/** The relay state directory, relative to the home. Box uninstall keeps it, because it is the data of the team. */
export const RELAY_DIR = ".ferry/relay";

const BOX_FERRY = '"$HOME/.local/bin/ferry"';
const UNIT_DIR = '"$HOME/.config/systemd/user"';
const HAS_JQ = "command -v jq >/dev/null 2>&1";

type BoxLink = { run(command: string, options?: RunOptions): Promise<LinkResult> };

/** Prints `missing` without a box install of Ferry, and `old` for a Ferry without `ferry <command>`. */
function needsBoxFerry(command: string): string[] {
  return [
    `[ -f "$HOME/.ferry/box.json" ] && [ -x ${BOX_FERRY} ] || { echo missing; exit 0; }`,
    `${BOX_FERRY} ${command} --help 2>/dev/null | grep -q '^Usage: ferry ${command}' || { echo old; exit 0; }`,
  ];
}

/** Write the unit from `$1`, enable it, and restart it when it changed. Prints `unit` for a change, then `running` or `stopped`. */
function startUnit(service: UserService, unit: string): string[] {
  return [
    `u=${UNIT_DIR}/${service.unit}`,
    'mkdir -p "${u%/*}" || exit 1',
    `printf '%s' ${quoteShell(unit)} > "$u.tmp" || exit 1`,
    'if cmp -s "$u.tmp" "$u"; then rm -f "$u.tmp"; changed=0; else mv -f "$u.tmp" "$u" || exit 1; changed=1; echo unit; fi',
    'if [ "$changed" = 1 ]; then',
    "  systemctl --user daemon-reload >/dev/null || exit 1",
    `  systemctl --user enable ${service.unit} >/dev/null 2>&1 && systemctl --user restart ${service.unit} >/dev/null || exit 1`,
    "else",
    `  systemctl --user enable --now ${service.unit} >/dev/null 2>&1 || exit 1`,
    "fi",
    `systemctl --user is-active --quiet ${service.unit} && echo running || echo stopped`,
  ];
}

/** The unit file of a service on a box with the home `remoteHome`. The PATH has the box PATH directories, as the agents have. */
export function boxUnit(service: UserService, remoteHome: string, pathDirs: readonly string[]): string {
  return systemdService(service, [`${remoteHome}/.local/bin/ferry`], unitPath(pathDirs), undefined);
}

/**
 * The box command of a box with `messaging = true`. Stdin has the relay URL
 * on one line. The command writes it into `client.json`, merges the Codex
 * hooks into `codexHooks` when it is set, and starts the worker. Without the
 * device credential or `client.json`, it prints `enroll` and does not start
 * the worker. Other output: `missing`, `old`, `nojq` (no jq for
 * `client.json`), `client-failed`, `hooks-nojq`, `hooks-failed`, then the
 * lines of the unit start.
 */
export function enableMessagingCommand(unit: string, codexHooks: string | null): string {
  return [
    ...needsBoxFerry("messaging worker"),
    `d="$HOME/${MESSAGING_DIR}"`,
    "umask 077",
    'mkdir -p "$d" && chmod 700 "$d" || exit 1',
    'IFS= read -r url || exit 1',
    ...(codexHooks === null
      ? []
      : [
          `o=$(sh -c ${quoteShell(addCodexHooksScript(codexHooks))})`,
          'case "$o" in J*) echo hooks-nojq;; E*|S*) echo hooks-failed;; esac',
        ]),
    'if [ ! -s "$d/credential" ] || [ ! -f "$d/client.json" ]; then echo enroll; exit 0; fi',
    `if ${HAS_JQ}; then`,
    `  jq -e --arg u "$url" '.relayUrl == $u' "$d/client.json" >/dev/null 2>&1 || { jq --arg u "$url" '.relayUrl = $u' "$d/client.json" > "$d/client.json.tmp" 2>/dev/null && mv -f "$d/client.json.tmp" "$d/client.json"; } || { rm -f "$d/client.json.tmp"; echo client-failed; }`,
    "else",
    "  echo nojq",
    "fi",
    ...startUnit(MESSAGING_SERVICE, unit),
  ].join("\n");
}

/**
 * The box command part for a box without `messaging = true`. It does nothing
 * on a box without the worker unit. Else it removes the Claude hooks from
 * `claudeSettings` and the Codex hooks from `codexHooks` (each when set), the
 * MCP entries of these harnesses, and the unit, and prints
 * `messaging-removed`. `~/.ferry/messaging` stays, with the device credential.
 */
export function disableMessagingCommand(claudeSettings: string | null, codexHooks: string | null): string {
  return [
    `u=${UNIT_DIR}/${MESSAGING_SERVICE.unit}`,
    '[ -e "$u" ] || exit 0',
    ...(claudeSettings === null
      ? []
      : [
          `sh -c ${quoteShell(removeMessagingHooksScript(claudeSettings, "claude"))} >/dev/null 2>&1`,
          `! command -v claude >/dev/null 2>&1 || claude mcp remove --scope user ${MESSAGING_MCP_SERVER} >/dev/null 2>&1`,
        ]),
    ...(codexHooks === null
      ? []
      : [
          `sh -c ${quoteShell(removeMessagingHooksScript(codexHooks, "codex"))} >/dev/null 2>&1`,
          `! command -v codex >/dev/null 2>&1 || codex mcp remove ${MESSAGING_MCP_SERVER} >/dev/null 2>&1`,
        ]),
    `systemctl --user disable --now ${MESSAGING_SERVICE.unit} >/dev/null 2>&1`,
    'rm -f "$u" || exit 1',
    "systemctl --user daemon-reload >/dev/null 2>&1",
    "echo messaging-removed",
  ].join("\n");
}

/** The box command of a box with `relay = true`: make `~/.ferry/relay` (0700) and start the relay. */
export function enableRelayCommand(unit: string): string {
  return [
    ...needsBoxFerry("relay serve"),
    "umask 077",
    `mkdir -p "$HOME/${RELAY_DIR}" && chmod 700 "$HOME/${RELAY_DIR}" || exit 1`,
    ...startUnit(RELAY_SERVICE, unit),
  ].join("\n");
}

/** The box command part for a box without `relay = true`. It stops and removes the relay unit, prints `relay-removed`, and keeps `~/.ferry/relay`. */
export const DISABLE_RELAY_COMMAND = [
  `u=${UNIT_DIR}/${RELAY_SERVICE.unit}`,
  '[ -e "$u" ] || exit 0',
  `systemctl --user disable --now ${RELAY_SERVICE.unit} >/dev/null 2>&1`,
  'rm -f "$u" || exit 1',
  "systemctl --user daemon-reload >/dev/null 2>&1",
  "echo relay-removed",
].join("\n");

/**
 * The command that `ferry update` runs after it changes the Ferry binary of a
 * box, so that the worker and the relay run the new binary. A stopped service
 * stays stopped. A box without the units has nothing to restart.
 */
export const RESTART_MESSAGING_COMMAND = [MESSAGING_SERVICE, RELAY_SERVICE]
  .map((service) => `{ [ ! -f ${UNIT_DIR}/${service.unit} ] || systemctl --user try-restart ${service.unit}; }`)
  .join(" && ");

/** The MCP entry of each harness that has one, for `registerBoxMcp`. The Ferry path is absolute, so the entry works without the box PATH. */
export function messagingMcpEntries(ferry: string, harnesses: readonly HarnessDescriptor[]): SeedMcp[] {
  return harnesses
    .filter((harness) => harness.id === "claude" || harness.id === "codex")
    .map((harness) => ({
      harness: harness.id,
      servers: [{ name: MESSAGING_MCP_SERVER, type: "stdio" as const, command: ferry, args: [...MESSAGING_MCP_ARGS], env: [] }],
    }));
}

export type BoxMessagingResult =
  | { readonly state: "missing" }
  | { readonly state: "old" }
  | { readonly state: "enroll"; readonly warnings: readonly string[] }
  | { readonly state: "running" | "stopped"; readonly unitChanged: boolean; readonly warnings: readonly string[] };

/** Run `enableMessagingCommand` on the box and read its output. `enroll` can come with hook warnings. */
export async function enableBoxMessaging(
  link: BoxLink,
  remoteHome: string,
  relayUrl: string,
  codexOn: boolean,
): Promise<BoxMessagingResult> {
  const command = enableMessagingCommand(boxUnit(MESSAGING_SERVICE, remoteHome, linkPathDirs(link)), codexOn ? `${remoteHome}/${CODEX_HOOKS_FILE}` : null);
  const result = await link.run(command, { input: new TextEncoder().encode(`${relayUrl}\n`) });
  if (!result.ok) throw new Error(`${result.error.origin}/${result.error.code}: ${result.error.message}`);
  const lines = result.stdout.split("\n").map((line) => line.trim());
  if (lines.includes("missing")) return { state: "missing" };
  if (lines.includes("old")) return { state: "old" };
  const warnings = [
    ...(lines.includes("hooks-nojq") ? [`jq is not on the box, so ~/${CODEX_HOOKS_FILE} has no messaging hooks. Run ferry update to install jq.`] : []),
    ...(lines.includes("hooks-failed") ? [`Ferry could not add the messaging hooks to ~/${CODEX_HOOKS_FILE}. Check that the file is valid JSON.`] : []),
    ...(lines.includes("nojq") ? ["jq is not on the box, so Ferry did not write the relay URL to ~/.ferry/messaging/client.json. Run ferry update to install jq."] : []),
    ...(lines.includes("client-failed") ? ["Ferry could not write the relay URL to ~/.ferry/messaging/client.json."] : []),
  ];
  if (lines.includes("enroll")) return { state: "enroll", warnings };
  return { state: lines.includes("running") ? "running" : "stopped", unitChanged: lines.includes("unit"), warnings };
}

/**
 * Remove the parts of the keys that are off, in one box command: messaging
 * with `messaging` set, and the relay with `relay = true`. A box without the
 * units has nothing to remove. Each result is true when Ferry removed that part.
 */
export async function disableBoxParts(
  link: BoxLink,
  remoteHome: string,
  parts: { readonly messaging: { readonly claudeSettings: string | null; readonly codexOn: boolean } | null; readonly relay: boolean },
): Promise<{ readonly messaging: boolean; readonly relay: boolean }> {
  const { messaging } = parts;
  const commands = [
    ...(messaging === null
      ? []
      : [
          disableMessagingCommand(
            messaging.claudeSettings === null ? null : `${remoteHome}/${messaging.claudeSettings}`,
            messaging.codexOn ? `${remoteHome}/${CODEX_HOOKS_FILE}` : null,
          ),
        ]),
    ...(parts.relay ? [DISABLE_RELAY_COMMAND] : []),
  ];
  if (commands.length === 0) return { messaging: false, relay: false };
  // Each part runs in a subshell, so that its `exit` ends only that part.
  const result = await link.run(commands.map((command) => `(\n${command}\n)`).join(" && "));
  if (!result.ok) throw new Error(`${result.error.origin}/${result.error.code}: ${result.error.message}`);
  const lines = result.stdout.split("\n").map((line) => line.trim());
  return { messaging: lines.includes("messaging-removed"), relay: lines.includes("relay-removed") };
}

/** Start the relay on the box. */
export async function enableBoxRelay(link: BoxLink, remoteHome: string): Promise<"missing" | "old" | "running" | "stopped"> {
  const result = await link.run(enableRelayCommand(boxUnit(RELAY_SERVICE, remoteHome, linkPathDirs(link))));
  if (!result.ok) throw new Error(`${result.error.origin}/${result.error.code}: ${result.error.message}`);
  const lines = result.stdout.split("\n").map((line) => line.trim());
  for (const state of ["missing", "old", "running"] as const) if (lines.includes(state)) return state;
  return "stopped";
}

/**
 * The parts of the `status` result of the worker (`WorkerStatus` of
 * `src/messaging/worker/worker.ts`) that `ferry messaging status` and `ferry
 * status --brief` read.
 */
export type WorkerStatusView = {
  readonly revoked: boolean;
  readonly relay: { readonly reachable: boolean; readonly lastContactAt: string | null; readonly lastError: string | null };
  readonly sessions: readonly {
    readonly runtime: "claude" | "codex";
    readonly runtimeVersion: string;
    readonly state: "live" | "offline";
    /** `supported`, `untested`, `unconfirmed`, or `unsupported`. */
    readonly adapter: string;
  }[];
  readonly outbox: { readonly pending: number; readonly failed: readonly unknown[] };
  readonly deliveries: { readonly held: number; readonly unconfirmed: number; readonly stranded: number; readonly failed: number };
  /** Live Codex processes in a participating repository without a registration: Codex has not trusted the Ferry hooks. */
  readonly unregisteredCodex: readonly unknown[];
};

/**
 * The result of `ferry --json messaging status`. `worker` is `stopped` when
 * the worker does not answer on its socket. Then `status` is null.
 */
export type MessagingStatus = {
  readonly worker: "running" | "stopped";
  /** True when `~/.ferry/messaging` has the device credential and `client.json`. */
  readonly enrolled: boolean;
  readonly relayUrl: string | null;
  /** The `status` result of the worker, with all its fields. */
  readonly status: WorkerStatusView | null;
};

/** The messaging of a box for `ferry status --brief`. `unavailable`: the box has no Ferry with messaging. `reason` says why. */
export type BoxMessagingHealth = { readonly state: "unavailable"; readonly reason: string } | ({ readonly state: "read" } & MessagingStatus);

export const MESSAGING_STATUS_COMMAND = [...needsBoxFerry("messaging status"), `${BOX_FERRY} --json messaging status`].join("\n");

/** Read the messaging status of a box. */
export async function readBoxMessaging(link: BoxLink, box: string): Promise<BoxMessagingHealth> {
  const result = await link.run(MESSAGING_STATUS_COMMAND);
  if (!result.ok) throw new Error(`Ferry could not read the agent messaging state: ${result.error.origin}/${result.error.code}`);
  const output = result.stdout.trim();
  if (output === "missing") return { state: "unavailable", reason: "Ferry is not on the box" };
  if (output === "old") return { state: "unavailable", reason: `the Ferry of the box has no agent messaging, run ferry update --box ${box}` };
  let envelope: { ok?: unknown; result?: unknown };
  try {
    envelope = JSON.parse(output.split("\n").at(-1) ?? "");
  } catch {
    throw new Error("ferry messaging status on the box gave no valid JSON");
  }
  const status = envelope.result as Partial<MessagingStatus> | undefined;
  if (envelope.ok !== true || (status?.worker !== "running" && status?.worker !== "stopped")) {
    throw new Error("ferry messaging status on the box gave an unexpected result");
  }
  return { state: "read", ...(status as MessagingStatus) };
}

/** The result of `ferry messaging setup` and `teardown`. Each part says what Ferry did. */
export type MessagingSetupResult = {
  readonly claude: "updated" | "unchanged" | "absent";
  readonly codex: "updated" | "unchanged" | "absent";
  readonly mcp: readonly { readonly harness: "claude" | "codex"; readonly action: "declared" | "removed" | "absent" | "failed" }[];
  readonly skill: SkillInstallResult | null;
  readonly service: WatchServiceResult | null;
};

export type MessagingSetupDependencies = {
  readonly home: string;
  readonly harnesses: readonly HarnessDescriptor[];
  /** The Ferry command of this process, for the MCP entry and the service. */
  readonly ferry: readonly string[];
  /** Runs a harness CLI command. */
  readonly run: (command: readonly string[]) => { readonly exitCode: number };
  /** True when the command is on the PATH. */
  readonly onPath: (command: string) => boolean;
  readonly installService: (service: UserService, input: WatchServiceInput) => Promise<WatchServiceResult>;
  readonly uninstallService: (service: UserService, input: Pick<WatchServiceInput, "home">) => Promise<WatchServiceResult & { removed: boolean }>;
};

/**
 * `ferry messaging setup`: the hooks in `~/.claude/settings.json` and
 * `~/.codex/hooks.json`, the MCP entries, the skill, and the worker service
 * on this machine. It needs an enrollment. A harness without its directory
 * in the home gets nothing.
 */
export async function runMessagingSetup(dependencies: Partial<MessagingSetupDependencies> = {}): Promise<MessagingSetupResult> {
  const resolved = { ...defaultSetupDependencies(), ...dependencies };
  if (!existsSync(join(resolved.home, MESSAGING_DIR, "credential")) || !existsSync(join(resolved.home, MESSAGING_DIR, "client.json"))) {
    throw new FerryError("usage", "This machine has no messaging enrollment.", { hint: "Run ferry messaging enroll --relay <url> first." });
  }
  const claude = editJson(resolved.home, ".claude", "settings.json", (settings) => addMessagingHooks(settings, "claude", true));
  const codex = editJson(resolved.home, ".codex", "hooks.json", (settings) => addMessagingHooks(settings, "codex"));
  const [command = "", ...args] = resolved.ferry;
  const mcp = mcpEntries(resolved, (harness) =>
    harness === "claude"
      ? ["claude", "mcp", "add-json", "--scope", "user", MESSAGING_MCP_SERVER, JSON.stringify({ type: "stdio", command, args: [...args, ...MESSAGING_MCP_ARGS] })]
      : ["codex", "mcp", "add", MESSAGING_MCP_SERVER, "--", command, ...args, ...MESSAGING_MCP_ARGS],
  );
  const skill = installMessagingSkill({ home: resolved.home, harnesses: resolved.harnesses });
  const service = await resolved.installService(MESSAGING_SERVICE, { home: resolved.home });
  return { claude, codex, mcp, skill, service };
}

/** `ferry messaging teardown`: remove what setup added. The credential, the skill, and `~/.ferry/messaging` stay. */
export async function runMessagingTeardown(dependencies: Partial<MessagingSetupDependencies> = {}): Promise<MessagingSetupResult> {
  const resolved = { ...defaultSetupDependencies(), ...dependencies };
  const claude = editJson(resolved.home, ".claude", "settings.json", removeMessagingHooks, false);
  const codex = editJson(resolved.home, ".codex", "hooks.json", removeMessagingHooks, false);
  const mcp = mcpEntries(resolved, null);
  const service = await resolved.uninstallService(MESSAGING_SERVICE, { home: resolved.home });
  return { claude, codex, mcp, skill: null, service };
}

/** Remove the entry of each harness CLI on the PATH, then add it again with `add` when it is set. */
function mcpEntries(
  resolved: MessagingSetupDependencies,
  add: ((harness: "claude" | "codex") => readonly string[]) | null,
): MessagingSetupResult["mcp"] {
  return (["claude", "codex"] as const).map((harness) => {
    if (!resolved.onPath(harness)) return { harness, action: "absent" as const };
    resolved.run(harness === "claude" ? ["claude", "mcp", "remove", "--scope", "user", MESSAGING_MCP_SERVER] : ["codex", "mcp", "remove", MESSAGING_MCP_SERVER]);
    if (add === null) return { harness, action: "removed" as const };
    return { harness, action: resolved.run(add(harness)).exitCode === 0 ? ("declared" as const) : ("failed" as const) };
  });
}

/**
 * Change the JSON file `<directory>/<file>` in the home with `change`. A home
 * without the directory gives `absent`. A missing file counts as `{}`, and
 * without `create` it stays missing. The file keeps its mode, and a new file
 * gets 0600.
 */
function editJson(
  home: string,
  directory: string,
  file: string,
  change: (settings: Record<string, unknown>) => Record<string, unknown>,
  create = true,
): "updated" | "unchanged" | "absent" {
  if (!existsSync(join(home, directory))) return "absent";
  const path = join(home, directory, file);
  const exists = existsSync(path);
  if (!exists && !create) return "unchanged";
  let current: unknown = {};
  if (exists) {
    const text = readFileSync(path, "utf8");
    try {
      current = text.trim() === "" ? {} : JSON.parse(text);
    } catch {
      throw new FerryError("failed", `~/${directory}/${file} is not valid JSON, so Ferry did not change it.`);
    }
  }
  if (typeof current !== "object" || current === null || Array.isArray(current)) {
    throw new FerryError("failed", `~/${directory}/${file} is not a JSON object, so Ferry did not change it.`);
  }
  const next = change(current as Record<string, unknown>);
  if (exists && JSON.stringify(next) === JSON.stringify(current)) return "unchanged";
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(`${path}.ferry-tmp`, `${JSON.stringify(next, null, 2)}\n`, { mode: 0o600 });
  if (exists) chmodSync(`${path}.ferry-tmp`, statSync(path).mode & 0o777);
  renameSync(`${path}.ferry-tmp`, path);
  return "updated";
}

/** The Ferry command of this process: the binary, or bun with the script. */
export function currentFerry(execPath = process.execPath, script = process.argv[1]): string[] {
  return basename(execPath) === "bun" && script !== undefined ? [execPath, script] : [execPath];
}

function defaultSetupDependencies(): MessagingSetupDependencies {
  return {
    home: homedir(),
    harnesses: [],
    ferry: currentFerry(),
    run: (command) => ({ exitCode: spawnSync(command[0]!, command.slice(1), { stdio: "ignore" }).status ?? 1 }),
    onPath: (command) => spawnSync("sh", ["-c", `command -v ${quoteShell(command)}`], { stdio: "ignore" }).status === 0,
    installService: (service, input) => installUserService(service, input),
    uninstallService: (service, input) => uninstallUserService(service, input),
  };
}
