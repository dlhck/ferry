/** The Paseo integration. The Paseo daemon runs on the box, and Paseo Desktop connects to it over SSH. */

import type { IntegrationsConfig } from "../config.ts";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { quoteShell, readCommand, writeCommand } from "../box-settings.ts";
import { BunHostAdapter, type HostAdapter, type Link } from "../link.ts";
import { carriedContentHits } from "../manifest.ts";
import { step, type Progress } from "../progress.ts";
import { nodeBootstrap } from "../registry/builtin.ts";
import { BUILTIN_BOX_PATH_DIRS } from "../tools/path.ts";
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
export function unitFile(pathDirs: readonly string[], relay = false): string {
  return [
    "# Managed by ferry. ferry integrations disable paseo removes this file.",
    "[Unit]",
    "Description=Paseo daemon (ferry)",
    "After=network-online.target",
    "",
    "[Service]",
    "Type=simple",
    "ExecStart=%h/.local/bin/paseo daemon run",
    unitPathLine(pathDirs),
    `Environment=PASEO_LISTEN=${LISTEN}`,
    `Environment=PASEO_RELAY_ENABLED=${relay}`,
    // The daemon self-update runs npm -g. This prefix points it to the Ferry install.
    "Environment=NPM_CONFIG_PREFIX=%h/.local",
    "Restart=on-failure",
    "RestartSec=5",
    "KillSignal=SIGTERM",
    "TimeoutStopSec=15",
    "",
    "[Install]",
    "WantedBy=default.target",
    "",
  ].join("\n");
}

function unitPathLine(pathDirs: readonly string[]): string {
  return `Environment=PATH=${[...pathDirs.map((dir) => `%h/${dir}`), SYSTEM_PATH].join(":")}`;
}

/** A Link knows the box PATH directories. A link without them gets the directories of the built-in tools. */
function linkPathDirs(link: IntegrationLink): readonly string[] {
  return (link as Partial<Pick<Link, "pathDirs">>).pathDirs ?? BUILTIN_BOX_PATH_DIRS;
}

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
const START_COMMAND = ["systemctl --user daemon-reload", `systemctl --user enable --now ${UNIT}`].join(" && ");
/**
 * Keep the user services running after the last logout. In a container, the
 * user often may not turn on linger without sudo, so Ferry skips the call when
 * linger is on, and else tries `sudo -n`.
 */
const LINGER_COMMAND = [
  '[ "$(loginctl show-user "$USER" -p Linger --value 2>/dev/null)" = yes ]',
  'loginctl enable-linger "$USER" 2>/dev/null',
  'sudo -n loginctl enable-linger "$USER"',
].join(" || ");
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
/** The Paseo config, relative to the home directory, on the operator machine and on the box. */
export const CONFIG_FILE = ".paseo/config.json";
const RELOAD_COMMAND = "paseo daemon reload";
const DISABLE_COMMAND = [
  "set -e",
  `if [ -f ${quoteShell(UNIT_PATH)} ]; then systemctl --user disable --now ${UNIT}; fi`,
  `rm -f ${quoteShell(UNIT_PATH)}`,
  "systemctl --user daemon-reload",
].join("\n");
const UNINSTALL_COMMAND = `npm uninstall -g --prefix "$HOME/.local" ${PACKAGE}`;
const KEEP_DATA = "Ferry keeps ~/.paseo on the box. It holds the Paseo config, agent state and worktrees.";

/** The target version of an update, the daemon version on the box, and the warnings of the check. */
type UpdateCheck = {
  /** Null when there is no local app and npm view failed. */
  readonly target: string | null;
  /** Null when Ferry could not read the version, or the daemon does not run. */
  readonly box: string | null;
  readonly warnings: readonly string[];
};

/** The report line when the box already runs the target version, else null. */
function currentLine(check: UpdateCheck): string | null {
  return check.target !== null && check.box === check.target
    ? `Paseo ${check.target} is current. Ferry does not install it or restart ${UNIT}.`
    : null;
}

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

  /**
   * Find the version to install and the version that the daemon on the box
   * runs. The target is the local app version, else the npm latest version.
   * Both reads change nothing.
   */
  const checkUpdate = async (link: IntegrationLink, local: LocalVersion): Promise<UpdateCheck> => {
    const target = local.version ?? (await runVersion(host, ["npm", "view", PACKAGE, "version"]));
    if (target === null) {
      const warning = `Warning: npm view ${PACKAGE} version failed. Ferry installs the npm latest tag and restarts ${UNIT}.`;
      return { target, box: null, warnings: [warning] };
    }
    const result = await link.run(STATUS_COMMAND, { timeoutMs: BOX_TIMEOUT_MS });
    const status = result.ok ? parseDaemonStatus(result.stdout) : null;
    const box = status?.localDaemon === "running" ? status.daemonVersion : null;
    if (box === null) {
      const warning = `Warning: Ferry could not read the Paseo version on the box. Ferry installs Paseo and restarts ${UNIT}.`;
      return { target, box, warnings: [warning] };
    }
    return { target, box, warnings: [] };
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
    async plan(action: IntegrationAction, link?: IntegrationLink, config?: IntegrationsConfig): Promise<readonly string[]> {
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
      ];
      if (action === "update") {
        // Only the update plan reads the box, and only the daemon version.
        const check = link === undefined ? null : await checkUpdate(link, local);
        if (check !== null) {
          const current = currentLine(check);
          if (current !== null) return [...lines, current];
          lines.push(...check.warnings, ...(check.box === null ? [] : [`Box: Paseo ${check.box}`]));
        }
        lines.push(
          "Box commands:",
          ...indent(installCommand(check?.target ?? local.version)),
          ...indent(RESTART_COMMAND),
          ...indent(STATUS_COMMAND),
          "The restart stops the agents that run on the box.",
        );
        return lines;
      }
      lines.push(
        "Box commands:",
        ...indent(NODE_COMMAND),
        ...indent(`${NODE_VERSION_COMMAND}   # stop if the major version is lower than ${NODE_MAJOR}`),
        ...indent(installCommand(local.version)),
        ...indent(TAKEOVER_COMMAND),
        `  # write ~/${UNIT_PATH}. PATH also has the directories of the tools in the config:`,
        ...unitFile(BUILTIN_BOX_PATH_DIRS, config?.paseo_relay === true).trimEnd().split("\n").map((line) => `  #   ${line}`),
        ...indent(START_COMMAND),
        `  # If an existing unit changed: ${RESTART_COMMAND}`,
        "A changed unit restarts the daemon and stops its agents.",
        ...indent(LINGER_COMMAND),
        ...indent(`${STATUS_COMMAND}   # repeat until localDaemon is running, for ${Math.round(startTimeoutMs / 1_000)} s`),
        ...indent(PROJECTS_COMMAND),
        "Config: set [integrations] paseo = true after the box steps succeed.",
      );
      return lines;
    },
    async enable(link: IntegrationLink, progress: Progress, config?: IntegrationsConfig): Promise<readonly string[]> {
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

      const unit = unitFile(linkPathDirs(link), config?.paseo_relay === true);
      const previous = await boxRun(link, readCommand(UNIT_PATH), `Ferry could not read ~/${UNIT_PATH}`);
      await step(progress, `Writing ${UNIT}`, () =>
        boxRun(link, writeCommand(UNIT_PATH, unit), `Ferry could not write ~/${UNIT_PATH}`),
      );
      await step(progress, `Starting ${UNIT}`, () => boxRun(link, START_COMMAND, `Ferry could not start ${UNIT}`));
      if (previous.startsWith("F") && previous.slice(1) !== unit) {
        await step(progress, `Restarting ${UNIT}`, () => boxRun(link, RESTART_COMMAND, `Ferry could not restart ${UNIT}`));
        lines.push("The service config changed, so Ferry restarted the Paseo daemon. The restart stopped its agents.");
      }
      // The daemon runs without linger until the user logs out, so a linger failure is a warning.
      const linger = await step(progress, "Turning on linger for the box user", async () => {
        const result = await link.run(LINGER_COMMAND, {});
        return result.ok ? null : result.error.message;
      }, (error) => error !== null, (error) => error ?? undefined);
      if (linger !== null) {
        lines.push(
          `Warning: Ferry could not turn on linger (${linger}). Without linger, ${UNIT} stops when you log out of the box. ` +
            'Run sudo loginctl enable-linger "$USER" on the box.',
        );
      }
      const running = await step(progress, "Waiting for the Paseo daemon", () => waitForDaemon(link), undefined, (v) => v);

      const registered = await step(progress, "Registering the box projects", async () =>
        (await boxRun(link, PROJECTS_COMMAND, "Ferry could not list the box projects", INSTALL_TIMEOUT_MS))
          .split("\n")
          .filter((line) => line !== ""),
      (result) => result.some((line) => line.startsWith("failed ")), (result) => `${result.length} found`);
      const failed = registered.filter((line) => line.startsWith("failed ")).map((line) => line.slice(7));
      lines.push(`Registered ${registered.length - failed.length} of ${registered.length} box projects in Paseo.`);
      if (failed.length > 0) lines.push(`Warning: paseo project create failed for ${failed.join(", ")}.`);

      lines.push(`Paseo ${running} runs on the box at ${LISTEN}. The relay is ${config?.paseo_relay === true ? "on" : "off"}.`);
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
      const local = await self.localVersion();
      const check = await step(progress, "Checking the Paseo version on the box", () => checkUpdate(link, local),
        undefined, (result) => result.box ?? "unknown");
      const current = currentLine(check);
      if (current !== null) return [current];
      await install(link, progress, check.target);
      await step(progress, `Restarting ${UNIT}`, () => boxRun(link, RESTART_COMMAND, `Ferry could not restart ${UNIT}`));
      const running = await step(progress, "Waiting for the Paseo daemon", () => waitForDaemon(link), undefined, (v) => v);
      return [...check.warnings, `Paseo ${running} runs on the box${local.version === null ? ". The version is not pinned." : "."}`];
    },
    async health(link: IntegrationLink, config?: IntegrationsConfig): Promise<IntegrationHealth> {
      const [result, local] = await Promise.all([
        link.run(HEALTH_COMMAND, { timeoutMs: BOX_TIMEOUT_MS }),
        this.localVersion(),
      ]);
      if (!result.ok) {
        const error = `${result.error.origin}/${result.error.code}`;
        return { lines: [`Box: unavailable (${error})`], warnings: [], json: { error } };
      }
      return parseHealth(result.stdout, local.version, config?.paseo_relay === true);
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

/**
 * Write the unit again when its PATH is not `pathDirs`, then reload systemd
 * and restart the daemon. The restart stops the agents that run on the box, so
 * it happens only when the PATH changed. Returns true after a restart.
 */
export async function refreshUnitPath(link: IntegrationLink, pathDirs: readonly string[]): Promise<boolean> {
  const current = await boxRun(link, readCommand(UNIT_PATH), `Ferry could not read ~/${UNIT_PATH} on the box`);
  if (!current.startsWith("F")) {
    throw new PaseoError(`~/${UNIT_PATH} is not on the box. Run ferry integrations enable paseo`);
  }
  if (current.slice(1).split("\n").includes(unitPathLine(pathDirs))) return false;
  const text = current.slice(1);
  const updated = /^Environment=PATH=.*$/m.test(text)
    ? text.replace(/^Environment=PATH=.*$/m, unitPathLine(pathDirs))
    : text.replace("[Service]", `[Service]\n${unitPathLine(pathDirs)}`);
  await boxRun(link, writeCommand(UNIT_PATH, updated), `Ferry could not write ~/${UNIT_PATH}`);
  await boxRun(link, `systemctl --user daemon-reload && ${RESTART_COMMAND}`, `Ferry could not restart ${UNIT}`);
  return true;
}

/**
 * A Paseo agent profile. Ferry carries `daemon.agentProfiles` from the Paseo
 * config and nothing else from that file.
 */
export type AgentProfile = Readonly<Record<string, unknown>>;

/**
 * Read `daemon.agentProfiles` from the local Paseo config. A missing file or
 * key gives no profiles. Throw a PaseoError that names each profile that holds
 * an `env` block, a credential key, a token, or a secret field. The error never
 * holds a value.
 */
export function readAgentProfiles(home: string): readonly AgentProfile[] {
  const path = join(home, CONFIG_FILE);
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch {
    return [];
  }
  let config: unknown;
  try {
    config = JSON.parse(text);
  } catch {
    throw new PaseoError(`${path} is not valid JSON, so Ferry cannot read daemon.agentProfiles`);
  }
  const profiles = isObject(config) && isObject(config.daemon) ? config.daemon.agentProfiles : undefined;
  if (profiles === undefined) return [];
  if (!Array.isArray(profiles)) throw new PaseoError(`daemon.agentProfiles in ${path} is not a list`);

  const refused: string[] = [];
  for (const [index, profile] of profiles.entries()) {
    const name = profileName(profile, index);
    if (!isObject(profile)) {
      refused.push(`${name} is not a JSON object`);
      continue;
    }
    if (hasCredentialKey(profile)) refused.push(`${name} has an env block or a credential key`);
    for (const hit of carriedContentHits(path, Buffer.from(JSON.stringify(profile)))) {
      refused.push(`${name}: ${hit.reason}`);
    }
  }
  if (refused.length > 0) {
    throw new PaseoError(`Ferry refused to carry the Paseo agent profiles in ${path}: ${refused.join("; ")}`);
  }
  return profiles as AgentProfile[];
}

export type ProfileCarry = {
  /** The names of the profiles that the box config holds after the carry. */
  readonly carried: readonly string[];
  /** One line for each profile that Ferry did not carry. */
  readonly warnings: readonly string[];
  /** True when Ferry wrote the box config and reloaded the daemon. */
  readonly changed: boolean;
};

/**
 * Put `profiles` into `daemon.agentProfiles` of the box Paseo config, and keep
 * all other box keys. Skip each profile whose provider is not available on the
 * box (issue #99, decision 3). Profiles need no restart, so `paseo daemon
 * reload` applies them. With no profiles, it runs no box command.
 */
export async function carryAgentProfiles(
  link: IntegrationLink,
  profiles: readonly AgentProfile[],
): Promise<ProfileCarry> {
  if (profiles.length === 0) return { carried: [], warnings: [], changed: false };

  const status = await link.run(STATUS_COMMAND, { timeoutMs: BOX_TIMEOUT_MS });
  const daemon = status.ok ? parseDaemonStatus(status.stdout) : null;
  if (daemon === null || daemon.localDaemon !== "running") {
    throw new PaseoError(
      `Ferry cannot read the providers from paseo daemon status --json, because ${UNIT} or the daemon does not run on the box`,
    );
  }
  const available = new Set(daemon.providers.filter((entry) => entry.available).map((entry) => entry.provider));
  const kept: AgentProfile[] = [];
  const carried: string[] = [];
  const warnings: string[] = [];
  for (const [index, profile] of profiles.entries()) {
    const name = profileName(profile, index);
    if (typeof profile.provider === "string" && available.has(profile.provider)) {
      kept.push(profile);
      carried.push(name);
    } else {
      warnings.push(
        `Paseo agent profile ${name} was not carried: provider ${String(profile.provider)} is not available on the box.`,
      );
    }
  }

  const current = await boxRun(link, readCommand(CONFIG_FILE), `Ferry could not read ~/${CONFIG_FILE} on the box`);
  const text = current.startsWith("F") ? current.slice(1) : null;
  const merged = mergeAgentProfiles(text, kept);
  if (merged === text) return { carried, warnings, changed: false };
  await boxRun(link, writeCommand(CONFIG_FILE, merged), `Ferry could not write ~/${CONFIG_FILE} on the box`);
  await boxRun(link, RELOAD_COMMAND, "paseo daemon reload failed on the box");
  return { carried, warnings, changed: true };
}

/** Set `daemon.agentProfiles` in the box config text. Keep all other keys. */
function mergeAgentProfiles(box: string | null, profiles: readonly AgentProfile[]): string {
  let config: unknown = {};
  if (box !== null && box.trim() !== "") {
    try {
      config = JSON.parse(box);
    } catch {
      config = null;
    }
  }
  if (!isObject(config) || (config.daemon !== undefined && !isObject(config.daemon))) {
    throw new PaseoError(`~/${CONFIG_FILE} on the box is not a JSON object with a daemon object`);
  }
  const merged = { ...config, daemon: { ...(config.daemon as object | undefined), agentProfiles: profiles } };
  return `${JSON.stringify(merged, null, 2)}\n`;
}

/** One entry of `agents.metadataGeneration.providers`, in the strict Paseo schema. */
export type MetadataProvider = {
  readonly provider: string;
  readonly model?: string;
  readonly thinkingOptionId?: string;
};

/** The portable Paseo host preferences. A field that the local config does not set is absent. */
export type PaseoPreferences = {
  /** `agents.metadataGeneration.providers`. */
  readonly metadataProviders?: readonly MetadataProvider[];
  /** `daemon.appendSystemPrompt`. */
  readonly appendSystemPrompt?: string;
};

const METADATA_PROVIDERS = "agents.metadataGeneration.providers";
const APPEND_SYSTEM_PROMPT = "daemon.appendSystemPrompt";

/**
 * Read the metadata providers and the shared instructions from the local Paseo
 * config. A missing file or key gives an absent field. Throw a PaseoError for a
 * value that the Paseo schema rejects, or that holds a token or a secret. The
 * error never holds the instruction text or a value.
 */
export function readPaseoPreferences(home: string): PaseoPreferences {
  const path = join(home, CONFIG_FILE);
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch {
    return {};
  }
  let config: unknown;
  try {
    config = JSON.parse(text);
  } catch {
    throw new PaseoError(`${path} is not valid JSON, so Ferry cannot read the Paseo preferences`);
  }
  if (!isObject(config)) throw new PaseoError(`${path} is not a JSON object`);
  for (const key of ["agents", "daemon"]) {
    if (config[key] !== undefined && !isObject(config[key])) throw new PaseoError(`${key} in ${path} is not an object`);
  }
  const agents = config.agents as Record<string, unknown> | undefined;
  const daemon = config.daemon as Record<string, unknown> | undefined;
  const generation = agents?.metadataGeneration;
  if (generation !== undefined && !isObject(generation)) {
    throw new PaseoError(`agents.metadataGeneration in ${path} is not an object`);
  }
  const providers = generation?.providers;
  const prompt = daemon?.appendSystemPrompt;
  if (providers !== undefined && (!Array.isArray(providers) || !providers.every(isMetadataProvider))) {
    throw new PaseoError(`${METADATA_PROVIDERS} in ${path} is not a list of provider entries with a provider, an optional model, and an optional thinkingOptionId`);
  }
  if (prompt !== undefined && typeof prompt !== "string") {
    throw new PaseoError(`${APPEND_SYSTEM_PROMPT} in ${path} is not a string`);
  }
  const refused = (field: string, hits: readonly { readonly reason: string }[]) => {
    if (hits.length > 0) {
      throw new PaseoError(`Ferry refused to carry ${field} in ${path}: ${[...new Set(hits.map((hit) => hit.reason))].join("; ")}`);
    }
  };
  if (providers !== undefined) refused(METADATA_PROVIDERS, carriedContentHits(path, Buffer.from(JSON.stringify(providers))));
  // The `.env` name adds the `key: value` line check to the token check, since the text is not JSON.
  if (prompt !== undefined) refused(APPEND_SYSTEM_PROMPT, carriedContentHits(".env", Buffer.from(prompt)));
  return {
    ...(providers === undefined ? {} : { metadataProviders: providers as MetadataProvider[] }),
    ...(prompt === undefined ? {} : { appendSystemPrompt: prompt }),
  };
}

function isMetadataProvider(value: unknown): boolean {
  if (!isObject(value)) return false;
  const text = (key: string) => typeof value[key] === "string" && value[key] !== "";
  return text("provider") &&
    Object.keys(value).every((key) => ["provider", "model", "thinkingOptionId"].includes(key) && text(key));
}

export type PreferenceCarry = {
  /** One line for each value that Ferry did not carry. */
  readonly warnings: readonly string[];
  /** True when Ferry wrote the box config and reloaded the daemon. */
  readonly changed: boolean;
};

/**
 * Put the set preferences into the box Paseo config, and keep all other box
 * keys. Skip each metadata provider that is not available on the box. When no
 * local provider is available, keep the box list. Paseo reloads both fields
 * without a restart. With no set field, it runs no box command.
 */
export async function carryPaseoPreferences(link: IntegrationLink, preferences: PaseoPreferences): Promise<PreferenceCarry> {
  const { metadataProviders, appendSystemPrompt } = preferences;
  if (metadataProviders === undefined && appendSystemPrompt === undefined) return { warnings: [], changed: false };

  const warnings: string[] = [];
  let providers = metadataProviders;
  if (providers !== undefined && providers.length > 0) {
    const status = await link.run(STATUS_COMMAND, { timeoutMs: BOX_TIMEOUT_MS });
    const daemon = status.ok ? parseDaemonStatus(status.stdout) : null;
    if (daemon === null || daemon.localDaemon !== "running") {
      throw new PaseoError(
        `Ferry cannot read the providers from paseo daemon status --json, because ${UNIT} or the daemon does not run on the box`,
      );
    }
    const available = new Set(daemon.providers.filter((entry) => entry.available).map((entry) => entry.provider));
    const kept = providers.filter((entry) => available.has(entry.provider));
    for (const entry of providers) {
      if (!available.has(entry.provider)) {
        warnings.push(`Paseo metadata provider ${entry.provider} was not carried: it is not available on the box.`);
      }
    }
    if (kept.length === 0) {
      warnings.push(`Ferry kept the box ${METADATA_PROVIDERS}, because no local metadata provider is available on the box.`);
    }
    providers = kept.length === 0 ? undefined : kept;
  }
  if (providers === undefined && appendSystemPrompt === undefined) return { warnings, changed: false };

  // The write command holds the instruction text, and a box can echo a failed command. Report only the action.
  const run = async (command: string, what: string): Promise<string> => {
    const result = await link.run(command);
    if (!result.ok) throw new PaseoError(what);
    return result.stdout;
  };
  const current = await run(readCommand(CONFIG_FILE), `Ferry could not read ~/${CONFIG_FILE} on the box`);
  const text = current.startsWith("F") ? current.slice(1) : null;
  const merged = mergePreferences(text, providers, appendSystemPrompt);
  if (merged === text) return { warnings, changed: false };
  await run(writeCommand(CONFIG_FILE, merged), `Ferry could not write the Paseo preferences to ~/${CONFIG_FILE} on the box`);
  await run(RELOAD_COMMAND, "paseo daemon reload failed on the box after Ferry wrote the Paseo preferences");
  return { warnings, changed: true };
}

/** Set the given preferences in the box config text. Keep all other keys. */
function mergePreferences(
  box: string | null,
  providers: readonly MetadataProvider[] | undefined,
  prompt: string | undefined,
): string {
  let config: unknown = {};
  if (box !== null && box.trim() !== "") {
    try {
      config = JSON.parse(box);
    } catch {
      config = null;
    }
  }
  const agents = isObject(config) ? config.agents : undefined;
  if (!isObject(config) || (config.daemon !== undefined && !isObject(config.daemon)) ||
      (agents !== undefined && (!isObject(agents) || (agents.metadataGeneration !== undefined && !isObject(agents.metadataGeneration))))) {
    throw new PaseoError(`~/${CONFIG_FILE} on the box is not a JSON object with daemon, agents, and agents.metadataGeneration objects`);
  }
  const merged = {
    ...config,
    ...(prompt === undefined ? {} : { daemon: { ...(config.daemon as object | undefined), appendSystemPrompt: prompt } }),
    ...(providers === undefined ? {} : {
      agents: {
        ...(agents as Record<string, unknown> | undefined),
        metadataGeneration: { ...((agents as Record<string, unknown> | undefined)?.metadataGeneration as object | undefined), providers },
      },
    }),
  };
  return `${JSON.stringify(merged, null, 2)}\n`;
}

/** The profile name for people: its `name`, else its `id`, else its position. */
export function profileName(profile: unknown, index: number): string {
  if (isObject(profile)) {
    if (typeof profile.name === "string" && profile.name !== "") return profile.name;
    if (typeof profile.id === "string" && profile.id !== "") return profile.id;
  }
  return `#${index + 1}`;
}

/** True when a key at any depth is `env` or names a credential. */
function hasCredentialKey(value: unknown): boolean {
  if (typeof value !== "object" || value === null) return false;
  return Object.entries(value).some(
    ([key, child]) =>
      (!Array.isArray(value) && (key.toLowerCase() === "env" || key.toLowerCase().includes("credential"))) ||
      hasCredentialKey(child),
  );
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
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

function parseHealth(stdout: string, localVersion: string | null, relay: boolean): IntegrationHealth {
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
  if (daemon.relay !== null && daemon.relay !== relay) {
    warnings.push(relay
      ? "The Paseo relay is off, but the config requests on. Run ferry integrations enable paseo to apply the config."
      : "The Paseo relay is on. Ferry keeps it off on the box.");
  }
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

