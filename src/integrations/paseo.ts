/**
 * The Paseo integration. The Paseo daemon runs on the box, and Paseo Desktop connects to it over SSH.
 * On this machine, it puts a project that moves back into the local Paseo.
 */

import type { IntegrationsConfig } from "../config.ts";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { jqEditScript, quoteShell } from "../box-settings.ts";
import { BunHostAdapter, type HostAdapter, type Link } from "../link.ts";
import { carriedContentHits } from "../manifest.ts";
import { step, type Progress } from "../progress.ts";
import { nodeBootstrap } from "../registry/builtin.ts";
import { BUILTIN_BOX_PATH_DIRS } from "../tools/path.ts";
import type {
  BoxIntegration,
  IntegrationAction,
  IntegrationBoxPart,
  IntegrationHealth,
  IntegrationLink,
  IntegrationOperatorPart,
  LocalVersion,
  MovedSession,
  OperatorIntegration,
} from "./types.ts";

export type PaseoOptions = {
  readonly platform?: NodeJS.Platform;
  /** The macOS app bundle. */
  readonly macApp?: string;
  /** The install directory of the Linux `.deb` and `.rpm` packages. */
  readonly linuxInstallDir?: string;
  readonly host?: HostAdapter;
  /** Finds a command on the PATH of this machine. */
  readonly which?: (command: string) => string | null;
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
/** The system directories at the end of the PATH of ferry-paseo.service. */
export const SYSTEM_PATH = "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin";
const INSTALL_TIMEOUT_MS = 10 * 60 * 1_000;
/**
 * Each agent of the daemon runs in the cgroup of the unit. With the systemd
 * default `stop`, one process that the OOM killer kills stops the whole
 * service. With `continue`, only that process ends. It is the first line of
 * `[Service]`, where a sync also adds it to a unit that has no such line.
 */
const OOM_LINE = "OOMPolicy=continue";
/** The end of the line that Ferry prints after it added the OOM policy line to an existing unit. */
const OOM_APPLIED =
  "systemd applied the line without a restart of the Paseo daemon. When a process of an agent runs out of memory, the daemon and the other agents continue.";

/** The daemon gets the same PATH as a Ferry box command, so agents find the same tools. */
export function unitFile(pathDirs: readonly string[], relay = false): string {
  return [
    "# Managed by ferry. ferry integrations disable paseo removes this file.",
    "[Unit]",
    "Description=Paseo daemon (ferry)",
    "After=network-online.target",
    "",
    "[Service]",
    OOM_LINE,
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
/**
 * The box script that writes the unit from its standard input. It prints
 * `created` for a new unit, `unchanged` for the same text, `policy` for a text
 * that differs only by the `OOMPolicy=continue` line, and `changed` for
 * another text. systemd applies the OOM policy of a running service on
 * `daemon-reload`, so `policy` needs no restart. A unit on the box can hold an
 * `Environment=` line with a credential, so the box compares the two texts and
 * Ferry never reads the unit.
 */
const UNIT_WRITE_COMMAND = [
  `f=${quoteShell(UNIT_PATH)}`,
  "umask 077",
  `mkdir -p "$(dirname "$f")" && cat > "$f.ferry-tmp" || { rm -f "$f.ferry-tmp"; exit 1; }`,
  `if [ ! -e "$f" ]; then state=created; elif cmp -s "$f.ferry-tmp" "$f"; then state=unchanged`,
  `elif grep -vxF ${OOM_LINE} "$f.ferry-tmp" | cmp -s - "$f"; then state=policy; else state=changed; fi`,
  `mv "$f.ferry-tmp" "$f" || { rm -f "$f.ferry-tmp"; exit 1; }`,
  'echo "$state"',
].join("\n");
/**
 * An awk program that prints the unit with the PATH line `FERRY_PATH_LINE`.
 * With `FERRY_PATH=replace`, the line replaces the first PATH line. With
 * `add`, it goes after the first `[Service]` line. With `keep`, the PATH line
 * stays. With `FERRY_OOM=1`, the OOM policy line goes after the first
 * `[Service]` line. awk exits with 3 when it finds no place for the PATH line.
 */
const UNIT_LINES_AWK = [
  'BEGIN { want = ENVIRON["FERRY_PATH_LINE"]; path = ENVIRON["FERRY_PATH"]; oom = ENVIRON["FERRY_OOM"] == 1 }',
  'path == "replace" && /^Environment=PATH=/ { print want; path = "keep"; next }',
  "{ print }",
  '!service && $0 == "[Service]" {',
  "  service = 1",
  `  if (oom) print "${OOM_LINE}"`,
  '  if (path == "add") { print want; path = "keep" }',
  "}",
  'END { if (path != "keep") exit 3 }',
].join("\n");
// The stderr of `paseo daemon status` stays on the box. Ferry keeps only the named fields of the JSON.
const STATUS_COMMAND = `systemctl --user is-active --quiet ${UNIT} && paseo daemon status --json 2>/dev/null`;
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
/**
 * `paseo import` refuses a provider session that an agent on the daemon
 * already has. For an archived agent, it unarchives that agent. So a second
 * move creates no duplicate agent.
 */
const ALREADY_IMPORTED = "Provider session is already imported";
/** The Paseo error code for a directory that the daemon does not find. */
const DIRECTORY_NOT_FOUND = "directory_not_found";
/** The Paseo config, relative to the home directory, on the operator machine and on the box. */
export const CONFIG_FILE = ".paseo/config.json";
// Ferry needs only the exit code of the reload, so its output stays on the box.
const RELOAD_COMMAND = "paseo daemon reload >/dev/null 2>&1";
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

/**
 * Run an npm command on the box. The npm output can hold a registry URL or a
 * proxy URL of the box with a credential, so it stays on the box. After a
 * failure, the error has only the npm error code.
 */
function boxNpm(link: IntegrationLink, command: string, what: string): Promise<string> {
  const script = [
    `out=$(${command} 2>&1) && exit 0`,
    `code=$(printf '%s\\n' "$out" | sed -n -e 's/^npm error code \\([A-Za-z0-9_]*\\)$/\\1/p' -e 's/^npm ERR! code \\([A-Za-z0-9_]*\\)$/\\1/p' | head -n 1)`,
    'echo "npm error code ${code:-unknown}" >&2',
    "exit 1",
  ].join("\n");
  return boxRun(link, script, `${what}. Run ${command} on the box to see the npm output`, INSTALL_TIMEOUT_MS);
}

const VERSION_PATTERN = /\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?/;
const SECTION = "ferry-section";
const BOX_TIMEOUT_MS = 30_000;
const LOCAL_TIMEOUT_MS = 30_000;
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

export function createPaseo(options: PaseoOptions = {}): BoxIntegration & OperatorIntegration {
  const platform = options.platform ?? process.platform;
  const macApp = options.macApp ?? "/Applications/Paseo.app";
  const linuxInstallDir = options.linuxInstallDir ?? "/opt/Paseo";
  const host = options.host ?? new BunHostAdapter();
  const which = options.which ?? ((command: string) => Bun.which(command));
  /** The CLI in the desktop app. Null on a platform without a known install directory. */
  const appCli =
    platform === "darwin"
      ? join(macApp, "Contents/Resources/bin/paseo")
      : platform === "linux"
        ? join(linuxInstallDir, "resources/bin/paseo")
        : null;
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
        // A failed status command can print daemon output, so Ferry shows a fixed text for it.
        last = result.error.code === "command-failed"
          ? `${UNIT} is not active, or paseo daemon status failed`
          : result.error.message;
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
      boxNpm(link, installCommand(version), "The Paseo install failed"),
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

  const self: IntegrationBoxPart = {
    async localVersion(): Promise<LocalVersion> {
      if (appCli !== null) {
        const fromCli = await cliVersion(host, appCli);
        if (fromCli) return { version: fromCli, source: appCli };
      }
      if (platform === "darwin") {
        const plist = join(macApp, "Contents/Info.plist");
        const fromPlist = await plistVersion(host, plist);
        if (fromPlist) return { version: fromPlist, source: plist };
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
        `A changed unit restarts the daemon and stops its agents. A unit that differs only by the ${OOM_LINE} line gets no restart.`,
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
      // The box compares the new unit with its file. The new unit replaces the whole file.
      const written = await step(progress, `Writing ${UNIT}`, async () =>
        (await boxRun(link, UNIT_WRITE_COMMAND, `Ferry could not write ~/${UNIT_PATH}`, undefined, new TextEncoder().encode(unit))).trim(),
      );
      await step(progress, `Starting ${UNIT}`, () => boxRun(link, START_COMMAND, `Ferry could not start ${UNIT}`));
      if (written === "changed") {
        await step(progress, `Restarting ${UNIT}`, () => boxRun(link, RESTART_COMMAND, `Ferry could not restart ${UNIT}`));
        lines.push("The service config changed, so Ferry restarted the Paseo daemon. The restart stopped its agents.");
      } else if (written === "policy") {
        lines.push(`Ferry added ${OOM_LINE} to ${UNIT}. ${OOM_APPLIED}`);
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
          boxNpm(link, UNINSTALL_COMMAND, "The Paseo uninstall failed"),
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
    async onProjectMoved(link: IntegrationLink, path: string, sessions: readonly MovedSession[]): Promise<void> {
      // The paseo output can hold box content, so the box matches it and prints one status word.
      const run = async (words: readonly string[]): Promise<PaseoFailure | null> => {
        const command = `paseo ${words.join(" ")}`;
        const script = [
          `out=$(${command} 2>&1) && { echo ok; exit 0; }`,
          "case $out in",
          `  *${quoteShell(ALREADY_IMPORTED)}*) echo duplicate ;;`,
          `  *${DIRECTORY_NOT_FOUND}*) echo no-directory ;;`,
          "  *) echo failed ;;",
          "esac",
        ].join("\n");
        const result = await link.run(script, { timeoutMs: BOX_TIMEOUT_MS });
        if (!result.ok) return { duplicate: false, message: `${result.error.origin}/${result.error.code}` };
        const status = result.stdout.trim();
        if (status === "ok") return null;
        if (status === "duplicate") return { duplicate: true, message: ALREADY_IMPORTED };
        return {
          duplicate: false,
          message: status === "no-directory"
            ? `Paseo did not find the directory on the box (${DIRECTORY_NOT_FOUND})`
            : `Paseo printed an error. Run ${command} on the box to see it`,
        };
      };
      await registerProject(run, quoteShell, boxPath(path), sessions);
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
  const operator: IntegrationOperatorPart = {
    // Always true, also without a local `paseo` command. The box part works without a local Paseo. With false,
    // `ferry status` shows a permanent warning for that operator, and `ferry integrations enable paseo` says that
    // Ferry adds commands later. So `onProjectMoved` looks for the command, and a missing command is a warning of the move.
    available: () => true,
    async onProjectMoved(path: string, sessions: readonly MovedSession[]): Promise<void> {
      const cli = which("paseo") ?? (appCli !== null && existsSync(appCli) ? appCli : null);
      if (cli === null) throw new PaseoError("Ferry found no paseo command on this machine");
      // This paseo runs on this machine, so its message stays here.
      const run = async (words: readonly string[]): Promise<PaseoFailure | null> => {
        const result = await host.run({ argv: [cli, ...words], timeoutMs: LOCAL_TIMEOUT_MS });
        if (result.timedOut) return { duplicate: false, message: "the command timed out" };
        if (result.exitCode === 0) return null;
        const message = result.stderr.trim() || result.stdout.trim() || `exit code ${result.exitCode}`;
        return { duplicate: message.includes(ALREADY_IMPORTED), message };
      };
      await registerProject(run, (value) => value, path, sessions);
    },
  };
  return { id: "paseo", name: "Paseo", description: "Paseo daemon on the box", box: self, operator };
}

export const paseo = createPaseo();

/** A failed `paseo` command. `duplicate` is true for a session that an agent on the daemon already has. */
type PaseoFailure = { readonly duplicate: boolean; readonly message: string };

/**
 * Register the project at `path` in Paseo, then import each session as an
 * agent of that project. The box part and the operator part share it. `run`
 * runs `paseo` with `words` on the box or on this machine, and returns null or
 * the failure of the command. `word` makes one word from a value: a shell
 * quote for the box, the value itself for a local argv. `path` is a word.
 */
async function registerProject(
  run: (words: readonly string[]) => Promise<PaseoFailure | null>,
  word: (value: string) => string,
  path: string,
  sessions: readonly MovedSession[],
): Promise<void> {
  // `project create` is idempotent. It returns the existing project for a known directory.
  const created = await run(["project", "create", path]);
  if (created !== null) throw new Error(`paseo project create failed: ${created.message}`);
  // One failed import does not stop the other imports. The error names each failed session.
  const failed: string[] = [];
  for (const session of sessions) {
    const imported = await run(["import", word(session.id), "--provider", word(session.provider), "--cwd", path]);
    if (imported !== null && !imported.duplicate) {
      failed.push(`${session.provider} session ${session.id} (${imported.message})`);
    }
  }
  if (failed.length > 0) throw new Error(`paseo import failed for ${failed.join(", ")}`);
}

/** Run one box command. Returns its stdout, or throws a PaseoError with `what` and the Link message. */
async function boxRun(link: IntegrationLink, command: string, what: string, timeoutMs?: number, input?: Uint8Array): Promise<string> {
  const result = await link.run(command, { ...(timeoutMs === undefined ? {} : { timeoutMs }), ...(input === undefined ? {} : { input }) });
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

/** What a sync did to the unit: the detail of the sync step, and a line for the operator, or null. */
export type UnitRefresh = { readonly detail: string; readonly note: string | null };

/** The part of the sync plan line for the box PATH that names the unit. */
export const UNIT_PLAN =
  ` and the PATH of ${UNIT}. A PATH change restarts the Paseo daemon and stops its agents. ` +
  `A unit without an OOMPolicy line gets ${OOM_LINE} without a restart`;

/**
 * Set the PATH line of the unit to `pathDirs` on the box, and add the OOM
 * policy line to a unit that has a `[Service]` line and no `OOMPolicy` line.
 * Then the box reloads systemd. It restarts the daemon only when the PATH
 * changed, because the restart stops the agents that run on the box. systemd
 * applies the OOM policy of a running service on `daemon-reload`. An
 * `OOMPolicy` value that the operator set in the unit stays, and a value in a
 * drop-in file has priority over the unit.
 * The unit can hold an `Environment=` line with a credential, so the box
 * compares and edits the lines itself and keeps each other line. It prints
 * `missing`, `unchanged`, `policy`, `updated`, or `failed`. Ferry never reads
 * the unit.
 */
export async function refreshUnitPath(link: IntegrationLink, pathDirs: readonly string[]): Promise<UnitRefresh> {
  const script = [
    `f=${quoteShell(UNIT_PATH)}`,
    `want=${quoteShell(unitPathLine(pathDirs))}`,
    '[ -f "$f" ] || { echo missing; exit 0; }',
    `path=keep; grep -qxF -e "$want" "$f" 2>/dev/null || { path=add; grep -q '^Environment=PATH=' "$f" 2>/dev/null && path=replace; }`,
    `oom=0; grep -qxF '[Service]' "$f" 2>/dev/null && ! grep -q '^[[:space:]]*OOMPolicy[[:space:]]*=' "$f" 2>/dev/null && oom=1`,
    '[ "$path" = keep ] && [ "$oom" = 0 ] && { echo unchanged; exit 0; }',
    "umask 077",
    `if FERRY_PATH_LINE="$want" FERRY_PATH="$path" FERRY_OOM="$oom" awk ${quoteShell(UNIT_LINES_AWK)} "$f" > "$f.ferry-tmp" 2>/dev/null && mv "$f.ferry-tmp" "$f" 2>/dev/null; then`,
    '  if [ "$path" = keep ]; then',
    "    systemctl --user daemon-reload >/dev/null || exit 1",
    "    echo policy",
    "  else",
    `    systemctl --user daemon-reload >/dev/null && ${RESTART_COMMAND} >/dev/null || exit 1`,
    "    echo updated",
    "  fi",
    "else",
    '  rm -f "$f.ferry-tmp"; echo failed',
    "fi",
  ].join("\n");
  const status = (await boxRun(link, script, `Ferry could not reload or restart ${UNIT}`)).trim();
  if (status === "missing") throw new PaseoError(`~/${UNIT_PATH} is not on the box. Run ferry integrations enable paseo`);
  if (status === "unchanged") return { detail: "no changes", note: null };
  if (status === "policy") {
    return { detail: `${OOM_LINE} added, no restart`, note: `Ferry added ${OOM_LINE} to ${UNIT} on the box. ${OOM_APPLIED}` };
  }
  if (status !== "updated") throw new PaseoError(`Ferry could not write the PATH line of ~/${UNIT_PATH} on the box`);
  return {
    detail: "restarted",
    note: `The box PATH changed, so Ferry updated ${UNIT} and restarted the Paseo daemon. The restart stopped the agents that ran on the box.`,
  };
}

/** A jq test: the input is an object, and the value at each path is an object or is not set. */
export function jqObjects(...paths: readonly string[]): string {
  return ['type == "object"', ...paths.map((path) => `(${path} | type | . == "null" or . == "object")`)].join(" and ");
}

/** The warning for a box without jq. Ferry never reads the box config to merge it on the operator machine. */
export function noJqWarning(what: string): string {
  return `jq is not on the box, so Ferry did not update ${what}. Run ferry update to install jq.`;
}

/**
 * Edit the box Paseo config on the box with a jq filter, and reload the daemon
 * when the box wrote the file. The box config can hold env blocks with
 * credentials, so the box merges the file itself and prints only a status
 * letter. `what` names the carried values in an error. `run` runs one box
 * command and throws its second argument, never the box output.
 */
export async function editBoxConfig(
  run: (command: string, what: string) => Promise<string>,
  edit: { readonly args: string; readonly valid: string; readonly filter: string; readonly what: string },
): Promise<"written" | "unchanged" | "no-jq" | "invalid"> {
  const failed = `Ferry could not write ${edit.what} to ~/${CONFIG_FILE} on the box`;
  const script = jqEditScript(CONFIG_FILE, edit.args, edit.valid, edit.filter);
  const status = await run(`sh -c ${quoteShell(script)}`, failed);
  if (status.startsWith("J")) return "no-jq";
  if (status.startsWith("E")) return "invalid";
  if (status.startsWith("S")) throw new PaseoError(failed);
  if (!status.startsWith("W")) return "unchanged";
  await run(RELOAD_COMMAND, `paseo daemon reload failed on the box after Ferry wrote ${edit.what}`);
  return "written";
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
 * reload` applies them. With no profiles, it runs no box command. The box
 * merges the file with jq. Without jq, the file stays as it is.
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

  const edit = await editBoxConfig((command, what) => boxRun(link, command, what), {
    args: `--argjson p ${quoteShell(JSON.stringify(kept))}`,
    valid: jqObjects(".daemon"),
    filter: ".daemon.agentProfiles = $p",
    what: "the Paseo agent profiles",
  });
  if (edit === "invalid") throw new PaseoError(`~/${CONFIG_FILE} on the box is not a JSON object with a daemon object`);
  if (edit === "no-jq") return { carried: [], warnings: [...warnings, noJqWarning("the Paseo agent profiles")], changed: false };
  return { carried, warnings, changed: edit === "written" };
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
  /** `daemon.autoArchiveAfterMerge`. Ferry carries it only to a box with `paseo_auto_archive = true`. */
  readonly autoArchiveAfterMerge?: boolean;
};

const METADATA_PROVIDERS = "agents.metadataGeneration.providers";
const APPEND_SYSTEM_PROMPT = "daemon.appendSystemPrompt";
const AUTO_ARCHIVE = "daemon.autoArchiveAfterMerge";

/**
 * Read the metadata providers, the shared instructions, and the auto-archive
 * switch from the local Paseo config. A missing file or key gives an absent field. Throw a PaseoError for a
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
  const autoArchive = daemon?.autoArchiveAfterMerge;
  if (providers !== undefined && (!Array.isArray(providers) || !providers.every(isMetadataProvider))) {
    throw new PaseoError(`${METADATA_PROVIDERS} in ${path} is not a list of provider entries with a provider, an optional model, and an optional thinkingOptionId`);
  }
  if (prompt !== undefined && typeof prompt !== "string") {
    throw new PaseoError(`${APPEND_SYSTEM_PROMPT} in ${path} is not a string`);
  }
  if (autoArchive !== undefined && typeof autoArchive !== "boolean") {
    throw new PaseoError(`${AUTO_ARCHIVE} in ${path} is not true or false`);
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
    ...(autoArchive === undefined ? {} : { autoArchiveAfterMerge: autoArchive }),
  };
}

/**
 * The preferences for one box. The auto-archive switch changes the workspace
 * lifecycle on the box, so it stays only when the box config has
 * `paseo_auto_archive = true`.
 */
export function boxPaseoPreferences(preferences: PaseoPreferences, config: IntegrationsConfig): PaseoPreferences {
  if (config.paseo_auto_archive === true) return preferences;
  const { autoArchiveAfterMerge: _autoArchive, ...rest } = preferences;
  return rest;
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
 * local provider is available, keep the box list. Paseo reloads all three fields
 * without a restart. With no set field, it runs no box command. The box merges
 * the file with jq. Without jq, the file stays as it is.
 */
export async function carryPaseoPreferences(link: IntegrationLink, preferences: PaseoPreferences): Promise<PreferenceCarry> {
  const { metadataProviders, appendSystemPrompt, autoArchiveAfterMerge } = preferences;
  if (metadataProviders === undefined && appendSystemPrompt === undefined && autoArchiveAfterMerge === undefined) {
    return { warnings: [], changed: false };
  }

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
  if (providers === undefined && appendSystemPrompt === undefined && autoArchiveAfterMerge === undefined) {
    return { warnings, changed: false };
  }

  // The write command holds the instruction text, and a box can echo a failed command. Report only the action.
  const run = async (command: string, what: string): Promise<string> => {
    const result = await link.run(command);
    if (!result.ok) throw new PaseoError(what);
    return result.stdout;
  };
  const sets: { readonly filter: string; readonly arg: string }[] = [
    ...(providers === undefined ? [] : [{ filter: `.${METADATA_PROVIDERS} = $m`, arg: `--argjson m ${quoteShell(JSON.stringify(providers))}` }]),
    ...(appendSystemPrompt === undefined ? [] : [{ filter: `.${APPEND_SYSTEM_PROMPT} = $s`, arg: `--arg s ${quoteShell(appendSystemPrompt)}` }]),
    ...(autoArchiveAfterMerge === undefined ? [] : [{ filter: `.${AUTO_ARCHIVE} = $a`, arg: `--argjson a ${autoArchiveAfterMerge}` }]),
  ];
  const edit = await editBoxConfig(run, {
    args: sets.map((set) => set.arg).join(" "),
    valid: jqObjects(".daemon", ".agents", ".agents.metadataGeneration"),
    filter: sets.map((set) => set.filter).join(" | "),
    what: "the Paseo preferences",
  });
  if (edit === "invalid") {
    throw new PaseoError(`~/${CONFIG_FILE} on the box is not a JSON object with daemon, agents, and agents.metadataGeneration objects`);
  }
  if (edit === "no-jq") warnings.push(noJqWarning("the Paseo preferences"));
  return { warnings, changed: edit === "written" };
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

