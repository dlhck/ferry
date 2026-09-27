/** The Paseo integration. The Paseo daemon runs on the box, and Paseo Desktop connects to it over SSH. */

import { existsSync } from "node:fs";
import { join } from "node:path";
import { quoteShell, writeCommand } from "../box-settings.ts";
import { BOX_PATH_DIRS, BunHostAdapter, type HostAdapter } from "../link.ts";
import { step, type Progress } from "../progress.ts";
import { nodeBootstrap } from "../registry/builtin.ts";
import type {
  Integration,
  IntegrationAction,
  IntegrationHealth,
  IntegrationLink,
  LocalVersion,
} from "./types.ts";

export type PaseoOptions = {
  readonly platform?: NodeJS.Platform;
  /** The macOS app bundle. */
  readonly macApp?: string;
  /** The install directory of the Linux `.deb` and `.rpm` packages. */
  readonly linuxInstallDir?: string;
  readonly host?: HostAdapter;
  /** The wait between two daemon status checks after a start. */
  readonly pollIntervalMs?: number;
  /** The time limit for the daemon to report `running` after a start. */
  readonly startTimeoutMs?: number;
  readonly sleep?: (milliseconds: number) => Promise<void>;
};

export class PaseoError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PaseoError";
  }
}

const PACKAGE = "@getpaseo/cli";
const NODE_MAJOR = 22;
const UNIT = "ferry-paseo.service";
/** Relative to the home directory. A box command starts in the home directory. */
const UNIT_PATH = `.config/systemd/user/${UNIT}`;
/** A unit that the operator wrote by hand before Ferry managed Paseo. */
const OLD_UNIT = "paseo.service";
const LISTEN = "127.0.0.1:6767";
const SYSTEM_PATH = "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin";
const INSTALL_TIMEOUT_MS = 10 * 60 * 1_000;

/** The daemon gets the same PATH as a Ferry box command, so agents find the same tools. */
export const UNIT_FILE = [
  "# Managed by ferry. ferry integrations disable paseo removes this file.",
  "[Unit]",
  "Description=Paseo daemon (ferry)",
  "After=network-online.target",
  "",
  "[Service]",
  "Type=simple",
  "ExecStart=%h/.local/bin/paseo daemon run",
  `Environment=PATH=${[...BOX_PATH_DIRS.map((dir) => `%h/${dir}`), SYSTEM_PATH].join(":")}`,
  `Environment=PASEO_LISTEN=${LISTEN}`,
  "Environment=PASEO_RELAY_ENABLED=false",
  "Restart=on-failure",
  "RestartSec=5",
  "KillSignal=SIGTERM",
  "TimeoutStopSec=15",
  "",
  "[Install]",
  "WantedBy=default.target",
  "",
].join("\n");

const NODE_COMMAND = nodeBootstrap(NODE_MAJOR, 0);
const NODE_VERSION_COMMAND = "node --version";
/** Stop and disable a hand-written paseo.service, so two daemons never run. The file stays. */
const TAKEOVER_COMMAND = [
  `[ -f "$HOME/.config/systemd/user/${OLD_UNIT}" ] || { echo absent; exit 0; }`,
  `if systemctl --user is-active --quiet ${OLD_UNIT}; then`,
  `  systemctl --user disable --now ${OLD_UNIT} >/dev/null && echo stopped`,
  `elif systemctl --user is-enabled --quiet ${OLD_UNIT}; then`,
  `  systemctl --user disable ${OLD_UNIT} >/dev/null && echo disabled`,
  "else",
  "  echo inactive",
  "fi",
].join("\n");
const WRITE_UNIT_COMMAND = writeCommand(UNIT_PATH, UNIT_FILE);
const START_COMMAND = [
  "systemctl --user daemon-reload",
  `systemctl --user enable --now ${UNIT}`,
  'loginctl enable-linger "$USER"',
].join(" && ");
const STATUS_COMMAND = `systemctl --user is-active --quiet ${UNIT} && paseo daemon status --json`;
/**
 * Register each git clone under the home directory, to a depth of three
 * directories. Hidden directories such as ~/.paseo and ~/.ferry, and
 * node_modules, are not searched. `paseo project create` is idempotent.
 */
const PROJECTS_COMMAND = [
  "find \"$HOME\" -maxdepth 4 \\( -name node_modules -o -name '.?*' ! -name .git \\) -prune -o -name .git -type d -print -prune |",
  "while IFS= read -r git; do",
  '  dir="${git%/.git}"',
  '  [ "$dir" = "$HOME" ] && continue',
  '  if paseo project create "$dir" >/dev/null 2>&1; then echo "ok ${dir#"$HOME"/}"; else echo "failed ${dir#"$HOME"/}"; fi',
  "done",
].join("\n");
const RESTART_COMMAND = `systemctl --user restart ${UNIT}`;
const DISABLE_COMMAND = [
  "set -e",
  `if [ -f ${quoteShell(UNIT_PATH)} ]; then systemctl --user disable --now ${UNIT}; fi`,
  `rm -f ${quoteShell(UNIT_PATH)}`,
  "systemctl --user daemon-reload",
].join("\n");
const UNINSTALL_COMMAND = `npm uninstall -g --prefix "$HOME/.local" ${PACKAGE}`;
const KEEP_DATA = "Ferry keeps ~/.paseo on the box. It holds the Paseo config, agent state and worktrees.";

function installCommand(version: string | null): string {
  return `npm install -g --prefix "$HOME/.local" ${PACKAGE}@${version ?? "latest"}`;
}

const VERSION_PATTERN = /\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?/;
const SECTION = "ferry-section";
const BOX_TIMEOUT_MS = 30_000;
/**
 * Read the units and the daemon status in one box command. The command always
 * exits with 0. `paseo daemon status --json` also prints `serverId` and
 * `hostname`. `parseHealth` keeps only the fields that it names.
 */
const HEALTH_COMMAND = [
  `printf 'active=%s\\n' "$(systemctl --user is-active ${UNIT} 2>/dev/null)"`,
  `printf 'enabled=%s\\n' "$(systemctl --user is-enabled ${UNIT} 2>/dev/null)"`,
  `printf 'old=%s\\n' "$(systemctl --user is-active ${OLD_UNIT} 2>/dev/null)"`,
  `if command -v paseo >/dev/null 2>&1; then echo ${SECTION}; paseo daemon status --json 2>/dev/null; else echo missing; fi`,
  "true",
].join("; ");

export function createPaseo(options: PaseoOptions = {}): Integration {
  const platform = options.platform ?? process.platform;
  const macApp = options.macApp ?? "/Applications/Paseo.app";
  const linuxInstallDir = options.linuxInstallDir ?? "/opt/Paseo";
  const host = options.host ?? new BunHostAdapter();
  const pollIntervalMs = options.pollIntervalMs ?? 2_000;
  const startTimeoutMs = options.startTimeoutMs ?? 60_000;
  const sleep = options.sleep ?? ((milliseconds: number) => Bun.sleep(milliseconds));

  /** Poll the daemon status until the unit is active and the daemon reports `running`. Returns the daemon version. */
  const waitForDaemon = async (link: IntegrationLink): Promise<string> => {
    let last = "no status";
    for (let waited = 0; ; waited += pollIntervalMs) {
      const result = await link.run(STATUS_COMMAND, { timeoutMs: 15_000 });
      if (result.ok) {
        const status = parseDaemonStatus(result.stdout);
        if (status?.localDaemon === "running") return status.daemonVersion ?? "unknown version";
        last = `localDaemon is ${status?.localDaemon ?? "not in the status output"}`;
      } else {
        last = result.error.message;
      }
      if (waited >= startTimeoutMs) {
        throw new PaseoError(
          `The Paseo daemon did not report running within ${Math.round(startTimeoutMs / 1_000)} s (${last}). ` +
            `Run journalctl --user -u ${UNIT} on the box.`,
        );
      }
      await sleep(pollIntervalMs);
    }
  };

  const install = async (link: IntegrationLink, progress: Progress, version: string | null) => {
    await step(progress, `Installing Paseo ${version ?? "latest"} on the box`, () =>
      boxRun(link, installCommand(version), "The Paseo install failed", INSTALL_TIMEOUT_MS),
    );
  };

  const self: Integration = {
    id: "paseo",
    name: "Paseo",
    description: "Paseo daemon on the box",
    async localVersion(): Promise<LocalVersion> {
      if (platform === "darwin") {
        const cli = join(macApp, "Contents/Resources/bin/paseo");
        const fromCli = await cliVersion(host, cli);
        if (fromCli) return { version: fromCli, source: cli };
        const plist = join(macApp, "Contents/Info.plist");
        const fromPlist = await plistVersion(host, plist);
        if (fromPlist) return { version: fromPlist, source: plist };
      } else if (platform === "linux") {
        const cli = join(linuxInstallDir, "resources/bin/paseo");
        const fromCli = await cliVersion(host, cli);
        if (fromCli) return { version: fromCli, source: cli };
      }
      return { version: null, source: null };
    },
    async plan(action: IntegrationAction): Promise<readonly string[]> {
      if (action === "disable" || action === "purge") {
        return [
          "Box commands:",
          ...indent(DISABLE_COMMAND),
          ...(action === "purge" ? indent(UNINSTALL_COMMAND) : []),
          "Ferry keeps linger on for the box user.",
          KEEP_DATA,
        ];
      }
      const local = await self.localVersion();
      const lines = [
        local.version === null
          ? "Local app: not found. Ferry installs the npm latest tag. The version is not pinned."
          : `Local app: Paseo ${local.version} (${local.source})`,
        "Box commands:",
      ];
      if (action === "update") {
        lines.push(...indent(installCommand(local.version)), ...indent(RESTART_COMMAND), ...indent(STATUS_COMMAND));
        lines.push("The restart stops the agents that run on the box.");
        return lines;
      }
      lines.push(
        ...indent(NODE_COMMAND),
        ...indent(`${NODE_VERSION_COMMAND}   # stop if the major version is lower than ${NODE_MAJOR}`),
        ...indent(installCommand(local.version)),
        ...indent(TAKEOVER_COMMAND),
        `  # write ~/${UNIT_PATH}:`,
        ...UNIT_FILE.trimEnd().split("\n").map((line) => `  #   ${line}`),
        ...indent(START_COMMAND),
        ...indent(`${STATUS_COMMAND}   # repeat until localDaemon is running, for ${Math.round(startTimeoutMs / 1_000)} s`),
        ...indent(PROJECTS_COMMAND),
        "Config: set [integrations] paseo = true after the box steps succeed.",
      );
      return lines;
    },
    async enable(link: IntegrationLink, progress: Progress): Promise<readonly string[]> {
      const lines: string[] = [];
      const { version } = await self.localVersion();
      if (version === null) lines.push("No local Paseo app. Ferry installs the npm latest tag. The version is not pinned.");

      await step(progress, `Checking Node ${NODE_MAJOR} on the box`, async () => {
        await boxRun(link, NODE_COMMAND, `Ferry could not install Node ${NODE_MAJOR} with apt`, INSTALL_TIMEOUT_MS);
        const found = (await boxRun(link, NODE_VERSION_COMMAND, "node --version failed on the box")).trim();
        const major = Number(/^v?(\d+)\./.exec(found)?.[1] ?? 0);
        if (major < NODE_MAJOR) {
          throw new PaseoError(
            `Paseo needs Node ${NODE_MAJOR} or later, and the box has Node ${found || "unknown"} after the apt install. ` +
              `Install Node ${NODE_MAJOR} or later on the box, then run ferry integrations enable paseo again.`,
          );
        }
        return found;
      }, undefined, (found) => found);
      await install(link, progress, version);

      const old = await step(progress, `Checking the old ${OLD_UNIT}`, async () =>
        (await boxRun(link, TAKEOVER_COMMAND, `Ferry could not stop the old ${OLD_UNIT}`)).trim(),
      undefined, (state) => state);
      if (old === "stopped") {
        lines.push(`Stopped and disabled the old ${OLD_UNIT}. The file ~/.config/systemd/user/${OLD_UNIT} stays.`);
      } else if (old === "disabled") {
        lines.push(`Disabled the old ${OLD_UNIT}. The file ~/.config/systemd/user/${OLD_UNIT} stays.`);
      }

      await step(progress, `Writing ${UNIT}`, () => boxRun(link, WRITE_UNIT_COMMAND, `Ferry could not write ~/${UNIT_PATH}`));
      await step(progress, `Starting ${UNIT}`, () => boxRun(link, START_COMMAND, `Ferry could not start ${UNIT}`));
      const running = await step(progress, "Waiting for the Paseo daemon", () => waitForDaemon(link), undefined, (v) => v);

      const registered = await step(progress, "Registering the box projects", async () =>
        (await boxRun(link, PROJECTS_COMMAND, "Ferry could not list the box projects", INSTALL_TIMEOUT_MS))
          .split("\n")
          .filter((line) => line !== ""),
      (result) => result.some((line) => line.startsWith("failed ")), (result) => `${result.length} found`);
      const failed = registered.filter((line) => line.startsWith("failed ")).map((line) => line.slice(7));
      lines.push(`Registered ${registered.length - failed.length} of ${registered.length} box projects in Paseo.`);
      if (failed.length > 0) lines.push(`Warning: paseo project create failed for ${failed.join(", ")}.`);

      lines.push(`Paseo ${running} runs on the box at ${LISTEN}. The relay is off.`);
      return lines;
    },
    async disable(link: IntegrationLink, progress: Progress, options: { readonly purge: boolean }): Promise<readonly string[]> {
      await step(progress, `Stopping ${UNIT}`, () => boxRun(link, DISABLE_COMMAND, `Ferry could not remove ${UNIT}`));
      const lines = [`Stopped ${UNIT} and removed ~/${UNIT_PATH}. Linger stays on.`];
      if (options.purge) {
        await step(progress, "Removing the Paseo CLI", () =>
          boxRun(link, UNINSTALL_COMMAND, "The Paseo uninstall failed", INSTALL_TIMEOUT_MS),
        );
        lines.push(`Removed ${PACKAGE} from ~/.local.`);
      }
      lines.push(KEEP_DATA);
      return lines;
    },
    async update(link: IntegrationLink, progress: Progress): Promise<readonly string[]> {
      const { version } = await self.localVersion();
      await install(link, progress, version);
      await step(progress, `Restarting ${UNIT}`, () => boxRun(link, RESTART_COMMAND, `Ferry could not restart ${UNIT}`));
      const running = await step(progress, "Waiting for the Paseo daemon", () => waitForDaemon(link), undefined, (v) => v);
      return [`Paseo ${running} runs on the box${version === null ? ". The version is not pinned." : "."}`];
    },
    async health(link: IntegrationLink): Promise<IntegrationHealth> {
      const [result, local] = await Promise.all([
        link.run(HEALTH_COMMAND, { timeoutMs: BOX_TIMEOUT_MS }),
        this.localVersion(),
      ]);
      if (!result.ok) {
        const error = `${result.error.origin}/${result.error.code}`;
        return { lines: [`Box: unavailable (${error})`], warnings: [], json: { error } };
      }
      return parseHealth(result.stdout, local.version);
    },
    async onProjectMoved(link: IntegrationLink, path: string): Promise<void> {
      // `project create` is idempotent. It returns the existing project for a known directory.
      const result = await link.run(`paseo project create ${boxPath(path)} >/dev/null`, { timeoutMs: BOX_TIMEOUT_MS });
      if (!result.ok) throw new Error(`paseo project create failed: ${result.error.message}`);
    },
    connectSteps(destination: string): readonly string[] {
      // Paseo Desktop keeps its hosts in app storage and has no command to add one.
      return [
        "Open Paseo Desktop.",
        "Open Settings → Add host → Remote SSH.",
        `Enter ${sshUri(destination)}.`,
      ];
    },
  };
  return self;
}

export const paseo = createPaseo();

/** Run one box command. Returns its stdout, or throws a PaseoError with `what` and the Link message. */
async function boxRun(link: IntegrationLink, command: string, what: string, timeoutMs?: number): Promise<string> {
  const result = await link.run(command, timeoutMs === undefined ? {} : { timeoutMs });
  if (!result.ok) throw new PaseoError(`${what}: ${result.error.message}`);
  return result.stdout;
}

function indent(command: string): string[] {
  return command.split("\n").map((line) => `  ${line}`);
}

function cliVersion(host: HostAdapter, cli: string): Promise<string | null> {
  return existsSync(cli) ? runVersion(host, [cli, "--version"]) : Promise.resolve(null);
}

/** plutil reads both the XML and the binary plist format. */
function plistVersion(host: HostAdapter, plist: string): Promise<string | null> {
  return existsSync(plist)
    ? runVersion(host, ["plutil", "-extract", "CFBundleShortVersionString", "raw", "-o", "-", plist])
    : Promise.resolve(null);
}

async function runVersion(host: HostAdapter, argv: readonly string[]): Promise<string | null> {
  try {
    const result = await host.run({ argv, timeoutMs: 10_000 });
    if (result.timedOut || result.exitCode !== 0) return null;
    return VERSION_PATTERN.exec(result.stdout)?.[0] ?? null;
  } catch {
    return null;
  }
}

/** The line that `ferry move --remove` prints. Ferry never deletes a Paseo project (issue #99, decision 4). */
export function paseoSourceHint(path: string, side: string): string {
  return `Paseo still lists ${path} on ${side}. Ferry does not remove it. To remove it from Paseo, run paseo project ls to find its ID, then paseo project delete <id>. The files stay.`;
}

type DaemonStatus = {
  readonly localDaemon: string | null;
  readonly connectedDaemon: string | null;
  readonly daemonVersion: string | null;
  readonly listen: string | null;
  readonly relay: boolean | null;
  readonly providers: readonly { readonly provider: string; readonly available: boolean }[];
};

function parseHealth(stdout: string, localVersion: string | null): IntegrationHealth {
  const [head = "", status] = stdout.split(`\n${SECTION}\n`);
  const fields = new Map<string, string>();
  for (const line of head.split("\n")) {
    const equals = line.indexOf("=");
    if (equals > 0) fields.set(line.slice(0, equals), line.slice(equals + 1).trim());
  }
  const value = (key: string) => fields.get(key) || null;
  const service = { unit: UNIT, active: value("active"), enabled: value("enabled") };
  const oldService = { unit: OLD_UNIT, active: value("old") };
  const lines = [`Service: ${UNIT} ${service.active ?? "unknown"}, ${service.enabled ?? "unknown"}`];
  const warnings: string[] = [];
  if (oldService.active === "active") {
    warnings.push(
      `The old ${OLD_UNIT} is active, so two Paseo daemons can run. Run ferry integrations enable paseo to replace it.`,
    );
  }
  const base = { installed: status !== undefined, service, oldService, localVersion, pinned: localVersion !== null };
  const empty = { localDaemon: null, connectedDaemon: null, daemonVersion: null, listen: null, relay: null, providers: [] };

  if (status === undefined) {
    lines.push("Paseo: not installed on the box");
    warnings.push("Paseo is not installed on the box. Run ferry integrations enable paseo.");
    return { lines, warnings, json: { ...base, ...empty, error: null } };
  }
  const daemon = parseDaemonStatus(status);
  if (daemon === null) {
    lines.push("Daemon: unknown, paseo daemon status printed no valid JSON");
    warnings.push("Ferry cannot read the output of paseo daemon status --json on the box.");
    return { lines, warnings, json: { ...base, ...empty, error: "malformed-status" } };
  }

  const state = daemon.localDaemon ?? "unknown";
  lines.push(
    `Daemon: ${state}${daemon.connectedDaemon ? `, ${daemon.connectedDaemon}` : ""}`,
    `Version: box ${daemon.daemonVersion ?? "unknown"}, ${localVersion === null ? "not pinned (no local Paseo app)" : `local app ${localVersion}`}`,
    `Listen: ${daemon.listen ?? "unknown"}, relay ${daemon.relay === true ? "ON" : daemon.relay === false ? "off" : "unknown"}`,
    `Providers: ${
      daemon.providers.length === 0
        ? "none"
        : daemon.providers.map((entry) => `${entry.provider} ${entry.available ? "available" : "unavailable"}`).join(", ")
    }`,
  );
  if (daemon.localDaemon !== "running") {
    warnings.push(`The Paseo daemon on the box is ${state}. Run ferry integrations enable paseo to start it.`);
  }
  if (localVersion !== null && daemon.daemonVersion !== null && daemon.daemonVersion !== localVersion) {
    warnings.push(`The box runs Paseo ${daemon.daemonVersion} and the local app is ${localVersion}. Run ferry update.`);
  }
  if (daemon.listen !== null && !loopback(daemon.listen)) {
    warnings.push(
      `Paseo listens on ${daemon.listen}, which is not a loopback address. Other hosts can control the daemon.`,
    );
  }
  if (daemon.relay === true) warnings.push("The Paseo relay is on. Ferry keeps it off on the box.");
  return { lines, warnings, json: { ...base, ...daemon, error: null } };
}

/** Keep only the named fields. The status also has `serverId` and `hostname`, which Ferry never shows. */
function parseDaemonStatus(text: string): DaemonStatus | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return null;
  const status = parsed as Record<string, unknown>;
  const field = (key: string) => (typeof status[key] === "string" ? (status[key] as string) : null);
  const relay = status.relay as { enabled?: unknown } | null | undefined;
  const providers = Array.isArray(status.providers) ? status.providers : [];
  return {
    localDaemon: field("localDaemon"),
    connectedDaemon: field("connectedDaemon"),
    daemonVersion: field("daemonVersion"),
    listen: field("listen"),
    relay: typeof relay?.enabled === "boolean" ? relay.enabled : null,
    providers: providers.flatMap((entry: { provider?: unknown; available?: unknown } | null) =>
      typeof entry?.provider === "string" ? [{ provider: entry.provider, available: entry.available === true }] : [],
    ),
  };
}

/** A socket path, `localhost`, `::1`, or an address in 127.0.0.0/8. */
function loopback(listen: string): boolean {
  if (listen.includes("/")) return true;
  const colon = listen.lastIndexOf(":");
  const host = listen.startsWith("[") ? listen.slice(1, listen.indexOf("]")) : colon === -1 ? listen : listen.slice(0, colon);
  return host === "localhost" || host === "::1" || host.startsWith("127.");
}

/** A shell word for a box path. A leading `~/` becomes the box home. */
function boxPath(path: string): string {
  return path.startsWith("~/") ? `"$HOME"/${quoteShell(path.slice(2))}` : quoteShell(path);
}

/** Paseo Desktop takes an `ssh://` URI. An IPv6 host must be in brackets. */
function sshUri(destination: string): string {
  if (destination.startsWith("ssh://")) return destination;
  const at = destination.lastIndexOf("@");
  const host = destination.slice(at + 1);
  const bracketed = host.includes(":") && !host.startsWith("[") ? `[${host}]` : host;
  return `ssh://${destination.slice(0, at + 1)}${bracketed}`;
}

