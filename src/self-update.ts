/**
 * The update of Ferry itself. Before a command runs on a terminal, Ferry
 * reads the latest GitHub release, at most once a day. When a newer release
 * is there, Ferry asks to update. `ferry self-update` reads the latest
 * release each time and updates without a question. The update uses the
 * method that installed this Ferry: npm, or the release installer.
 *
 * A release is visible before the release workflow attaches its files and
 * publishes the npm packages. Ferry does not offer or install a release that
 * does not have the files of this install yet.
 */

import * as prompts from "@clack/prompts";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";
import { FerryError } from "./errors.ts";
import { menuBarService } from "./menubar.ts";
import { tunnelService } from "./tunnel-service.ts";
import { isReleaseVersion, notReadyMessage, VERSION } from "./version.ts";
import { launchdPath, systemdPath, WATCH_SERVICE, type UserService } from "./watch-service.ts";

const STATE_RELATIVE_PATH = ".ferry/update-check.json";
const CHECK_INTERVAL_MS = 24 * 60 * 60 * 1_000;
const FETCH_TIMEOUT_MS = 2_000;
const LATEST_RELEASE_URL = "https://api.github.com/repos/dlhck/ferry/releases/latest";
const INSTALLER_URL = "https://raw.githubusercontent.com/dlhck/ferry";
const NPM_PACKAGE_URL = "https://registry.npmjs.org/@dlhck%2fferry";

/** The last check and the release that the operator skipped. */
type CheckState = {
  readonly checkedAt: number;
  readonly latest: string | null;
  readonly skipped?: string;
};

export type UpdateChoice = "update" | "skip" | "skip-version";

/** A GitHub release: its version, and the names of the files that are uploaded. */
export type LatestRelease = {
  readonly version: string;
  readonly assets: readonly string[];
};

/** The --json result of `ferry self-update`. */
export type SelfUpdateResult = {
  readonly current: string;
  readonly latest: string;
  readonly updated: boolean;
  /** `not-ready`: `latest` is newer, and its files are not there yet. Ferry did not start the update. */
  readonly state: "updated" | "up-to-date" | "not-ready";
  readonly services: readonly SelfUpdateServiceResult[];
  /** The message of the skill update by the new Ferry, or null when Ferry did not update. */
  readonly skill: string | null;
};

export type SelfUpdateServiceResult = {
  readonly service: string;
  readonly action: "restarted" | "updated" | "skipped" | "failed";
  readonly message: string;
};

export type SelfUpdateCommandResult = {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
};

export type SelfUpdateDependencies = {
  readonly version: string;
  readonly home: string;
  readonly platform: NodeJS.Platform;
  readonly arch: string;
  readonly uid: number | undefined;
  /** The path of the running Ferry binary. It tells how Ferry was installed. */
  readonly execPath: string;
  /** The Ferry script under Bun. */
  readonly scriptPath: string | undefined;
  readonly json: boolean;
  readonly now: () => number;
  /** The latest release, or null when Ferry cannot read it. */
  readonly fetchLatest: () => Promise<LatestRelease | null>;
  /** False when npm does not have `@dlhck/ferry` of the version. */
  readonly npmHasVersion: (version: string) => Promise<boolean>;
  readonly choose: (current: string, latest: string) => Promise<UpdateChoice>;
  /** Runs the update command with the terminal of Ferry and returns its exit code. */
  readonly run: (argv: readonly string[]) => Promise<number>;
  /** Runs a service-manager or new-Ferry command and captures its output. */
  readonly runService: (argv: readonly string[]) => Promise<SelfUpdateCommandResult>;
  /** Runs `install-skill` of the new Ferry and captures its output. */
  readonly runSkillUpdate: (argv: readonly string[]) => Promise<SelfUpdateCommandResult>;
  readonly exists: (path: string) => boolean;
  readonly readFile: (path: string) => string;
  readonly readDirectory: (path: string) => readonly string[];
  readonly writeLine: (line: string) => void;
  readonly warn: (line: string) => void;
};

/**
 * True when Ferry can ask: a terminal on stdin and stdout, no --json, no CI,
 * no FERRY_NO_UPDATE_CHECK, and not a command that stays running.
 */
export function offersSelfUpdate(input: {
  readonly json: boolean;
  readonly streaming: boolean;
  readonly interactive: boolean;
  readonly env: Record<string, string | undefined>;
}): boolean {
  return input.interactive && !input.json && !input.streaming && !input.env.CI && !input.env.FERRY_NO_UPDATE_CHECK;
}

/**
 * Ask to update when a newer release is there. Returns true when the update
 * ran, so the command must stop: the running process is still the old version.
 */
export async function offerSelfUpdate(dependencies: Partial<SelfUpdateDependencies> = {}): Promise<boolean> {
  const resolved = { ...defaultDependencies, ...dependencies };
  if (!isReleaseVersion(resolved.version)) return false;
  const path = join(resolved.home, STATE_RELATIVE_PATH);
  let state = readState(path);
  if (state === null || resolved.now() - state.checkedAt >= CHECK_INTERVAL_MS) {
    const release = await resolved.fetchLatest();
    // A newer release without its files is not there yet. The check of the next day reads it again.
    const usable = release !== null && (!isNewer(release.version, resolved.version) || (await isComplete(release, resolved)));
    const latest = usable ? release.version : (state?.latest ?? null);
    state = { ...state, checkedAt: resolved.now(), latest };
    writeState(path, state);
  }
  const latest = state.latest;
  if (latest === null || latest === state.skipped || !isNewer(latest, resolved.version)) return false;

  const choice = await resolved.choose(resolved.version, latest);
  if (choice === "skip-version") writeState(path, { ...state, skipped: latest });
  if (choice !== "update") return false;
  if ((await resolved.run(updateCommand(latest, resolved.execPath))) !== 0) {
    resolved.writeLine(`The update to Ferry ${latest} failed. Ferry ${resolved.version} runs the command.`);
    return false;
  }
  resolved.writeLine(`Updated Ferry to ${latest}. Run the command again.`);
  await refreshInstalledServices(latest, resolved);
  await refreshSkill(resolved);
  resolved.writeLine(`Run ferry update to put Ferry ${latest} on the boxes.`);
  return true;
}

/** `ferry self-update`: read the latest release now, and install it when it is newer. */
export async function runSelfUpdate(dependencies: Partial<SelfUpdateDependencies> = {}): Promise<SelfUpdateResult> {
  const resolved = { ...defaultDependencies, ...dependencies };
  const current = resolved.version;
  if (!isReleaseVersion(current)) {
    throw new FerryError("usage", `Ferry ${current} is a development build. It has no release to update from.`);
  }
  const release = await resolved.fetchLatest();
  if (release === null) throw new FerryError("failed", "Ferry cannot read the latest release from GitHub.");
  const latest = release.version;
  const newer = isNewer(latest, current);
  // Not an error: there is nothing to install yet. The state keeps its release, so the update prompt does not offer this one.
  if (newer && !(await isComplete(release, resolved))) {
    resolved.writeLine(notReadyMessage(latest));
    return { current, latest, updated: false, state: "not-ready", services: [], skill: null };
  }
  const path = join(resolved.home, STATE_RELATIVE_PATH);
  writeState(path, { ...readState(path), checkedAt: resolved.now(), latest });
  if (!newer) {
    resolved.writeLine(`Ferry ${current} is the latest version.`);
    return { current, latest, updated: false, state: "up-to-date", services: [], skill: null };
  }
  if ((await resolved.run(updateCommand(latest, resolved.execPath))) !== 0) {
    throw new FerryError("update-failed", `The update to Ferry ${latest} failed.`);
  }
  resolved.writeLine(`Updated Ferry to ${latest}. Run ferry update to put it on the boxes.`);
  const services = await refreshInstalledServices(latest, resolved);
  const skill = await refreshSkill(resolved);
  return { current, latest, updated: true, state: "updated", services, skill };
}

/**
 * True when the release has the files that the update of this Ferry downloads.
 * The release installer needs the binary of this platform and SHA256SUMS. An
 * npm install needs `@dlhck/ferry` on npm, which the workflow publishes after
 * the platform packages.
 */
async function isComplete(release: LatestRelease, dependencies: SelfUpdateDependencies): Promise<boolean> {
  if (isNpmInstall(dependencies.execPath)) return dependencies.npmHasVersion(release.version);
  return [`ferry-${dependencies.platform}-${dependencies.arch}`, "SHA256SUMS"].every((name) => release.assets.includes(name));
}

/**
 * Let the new Ferry write its bundled skill. The running process still has the
 * old skill. A failure is a warning: the binary update is done.
 */
async function refreshSkill(dependencies: SelfUpdateDependencies): Promise<string> {
  let run: SelfUpdateCommandResult;
  try {
    run = await dependencies.runSkillUpdate([...currentFerryCommand(dependencies), "install-skill"]);
  } catch (error) {
    run = { exitCode: 1, stdout: "", stderr: errorMessage(error) };
  }
  const message = run.exitCode === 0
    ? run.stdout.trim()
    : `Warning: Could not update the Ferry skill: ${commandError(run)}`;
  dependencies.writeLine(message);
  if (run.exitCode !== 0) dependencies.warn(message);
  return message;
}

async function refreshInstalledServices(
  latest: string,
  dependencies: SelfUpdateDependencies,
): Promise<readonly SelfUpdateServiceResult[]> {
  if (dependencies.platform !== "darwin" && dependencies.platform !== "linux") return [];
  const results: SelfUpdateServiceResult[] = [];
  const installed = installedServices(dependencies);
  for (const entry of installed) {
    const result = await restartService(entry.service, entry.box, entry.path, dependencies);
    results.push(result);
    dependencies.writeLine(result.message);
    if (result.action === "failed") dependencies.warn(result.message);
  }
  if (dependencies.platform === "darwin") {
    const result = await updateMenuBar(latest, dependencies);
    if (result) {
      results.push(result);
      dependencies.writeLine(result.message);
      if (result.action === "failed") dependencies.warn(result.message);
    }
  }
  return results;
}

/** The installed watch and tunnel services. `ferry doctor` also reads them. */
export function installedServices(
  dependencies: Pick<SelfUpdateDependencies, "platform" | "home" | "exists" | "readDirectory">,
): readonly {
  service: UserService;
  box?: string;
  path: string;
}[] {
  const pathOf = dependencies.platform === "darwin" ? launchdPath : systemdPath;
  const services: { service: UserService; box?: string; path: string }[] = [];
  const watchPath = pathOf(WATCH_SERVICE, dependencies.home);
  if (dependencies.exists(watchPath)) services.push({ service: WATCH_SERVICE, path: watchPath });
  const directory = dirname(watchPath);
  let names: readonly string[] = [];
  try {
    names = dependencies.readDirectory(directory);
  } catch {
    // A missing service directory means that no tunnel service is installed.
  }
  const pattern = dependencies.platform === "darwin"
    ? /^dev\.ferry\.tunnel\.([a-z0-9](?:[a-z0-9-]{0,30}[a-z0-9])?)\.plist$/
    : /^ferry-tunnel-([a-z0-9](?:[a-z0-9-]{0,30}[a-z0-9])?)\.service$/;
  for (const name of [...names].sort()) {
    const box = pattern.exec(name)?.[1];
    if (box === undefined) continue;
    const service = tunnelService(box);
    const path = pathOf(service, dependencies.home);
    if (dependencies.exists(path)) services.push({ service, box, path });
  }
  return services;
}

async function restartService(
  service: UserService,
  box: string | undefined,
  path: string,
  dependencies: SelfUpdateDependencies,
): Promise<SelfUpdateServiceResult> {
  const name = box === undefined ? "watch service" : `tunnel service of ${box}`;
  const id = box === undefined ? "watch" : `tunnel:${box}`;
  let body: string;
  try {
    body = dependencies.readFile(path);
  } catch (error) {
    return { service: id, action: "skipped", message: `Skipped the ${name}: ${errorMessage(error)}` };
  }
  const actual = serviceFerryCommand(body, service.args, dependencies.platform);
  const expected = currentFerryCommand(dependencies);
  if (!actual || !sameCommand(actual, expected)) {
    return {
      service: id,
      action: "skipped",
      message: `Skipped the ${name}: it runs ${actual?.join(" ") ?? "an unrecognized command"}.`,
    };
  }
  const command = dependencies.platform === "darwin"
    ? ["launchctl", "kickstart", "-k", `gui/${dependencies.uid}/${service.label}`]
    : ["systemctl", "--user", "restart", service.unit];
  let run: SelfUpdateCommandResult;
  try {
    run = await dependencies.runService(command);
  } catch (error) {
    return {
      service: id,
      action: "failed",
      message: `Warning: Could not restart the ${name}: ${errorMessage(error)}`,
    };
  }
  if (run.exitCode !== 0) {
    return {
      service: id,
      action: "failed",
      message: `Warning: Could not restart the ${name}: ${commandError(run)}`,
    };
  }
  return { service: id, action: "restarted", message: `Restarted the ${name}.` };
}

async function updateMenuBar(
  latest: string,
  dependencies: SelfUpdateDependencies,
): Promise<SelfUpdateServiceResult | null> {
  const path = launchdPath(menuBarService(""), dependencies.home);
  if (!dependencies.exists(path)) return null;
  let body = "";
  try {
    body = dependencies.readFile(path);
  } catch (error) {
    return { service: "menubar", action: "failed", message: `Warning: Could not read the menu bar service: ${errorMessage(error)}` };
  }
  if (menuBarSource(body) === "local") {
    return {
      service: "menubar",
      action: "skipped",
      message: "Skipped the menu bar app: --app installed a local build.",
    };
  }
  const command = [...currentFerryCommand(dependencies), "menubar", "install", ...(dependencies.json ? ["--json"] : [])];
  let run: SelfUpdateCommandResult;
  try {
    run = await dependencies.runService(command);
  } catch (error) {
    return {
      service: "menubar",
      action: "failed",
      message: `Warning: Could not update the menu bar app: ${errorMessage(error)}`,
    };
  }
  if (dependencies.json) {
    try {
      const envelope = JSON.parse(run.stdout) as { ok?: unknown; warnings?: unknown; error?: { message?: unknown } | null };
      if (Array.isArray(envelope.warnings)) {
        for (const warning of envelope.warnings) if (typeof warning === "string") dependencies.warn(warning);
      }
      if (envelope.ok !== true) {
        const message = typeof envelope.error?.message === "string" ? envelope.error.message : commandError(run);
        return { service: "menubar", action: "failed", message: `Warning: Could not update the menu bar app: ${message}` };
      }
    } catch {
      return {
        service: "menubar",
        action: "failed",
        message: "Warning: Could not update the menu bar app: the new Ferry returned invalid JSON.",
      };
    }
  }
  if (run.exitCode !== 0) {
    return {
      service: "menubar",
      action: "failed",
      message: `Warning: Could not update the menu bar app: ${commandError(run)}`,
    };
  }
  const legacy = menuBarSource(body) === null;
  return {
    service: "menubar",
    action: "updated",
    message: legacy
      ? `Updated the menu bar app to ${latest}. Its service did not record whether --app installed it.`
      : `Updated the menu bar app to ${latest}.`,
  };
}

/** The command that runs this Ferry: the binary, or Bun and the Ferry script. */
export function currentFerryCommand(dependencies: Pick<SelfUpdateDependencies, "execPath" | "scriptPath">): readonly string[] {
  if (!/^bun(?:\.[^.]+)?$/.test(basename(dependencies.execPath))) return [dependencies.execPath];
  return dependencies.scriptPath === undefined ? [dependencies.execPath] : [dependencies.execPath, dependencies.scriptPath];
}

/** The Ferry command of a service file, without the service arguments, or null when Ferry cannot read it. */
export function serviceFerryCommand(
  body: string,
  serviceArgs: readonly string[],
  platform: NodeJS.Platform,
): readonly string[] | null {
  const command = platform === "darwin" ? launchdCommand(body) : systemdCommand(body);
  if (command === null || command.length <= serviceArgs.length) return null;
  const tail = command.slice(-serviceArgs.length);
  if (!sameCommand(tail, serviceArgs)) return null;
  return command.slice(0, -serviceArgs.length);
}

function launchdCommand(body: string): readonly string[] | null {
  const array = /<key>ProgramArguments<\/key>\s*<array>([\s\S]*?)<\/array>/.exec(body)?.[1];
  if (array === undefined) return null;
  return [...array.matchAll(/<string>([\s\S]*?)<\/string>/g)].map((match) => xmlText(match[1] ?? ""));
}

function systemdCommand(body: string): readonly string[] | null {
  const line = /^ExecStart=(.*)$/m.exec(body)?.[1];
  if (line === undefined) return null;
  return [...line.matchAll(/"((?:\\.|[^"])*)"|(\S+)/g)].map((match) =>
    match[1] === undefined ? (match[2] ?? "") : match[1].replaceAll('\\"', '"').replaceAll("\\\\", "\\"),
  );
}

function menuBarSource(body: string): "local" | "release" | null {
  const source = /<key>FERRY_MENUBAR_SOURCE<\/key>\s*<string>(local|release)<\/string>/.exec(body)?.[1];
  return source === "local" || source === "release" ? source : null;
}

export function sameCommand(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((part, index) => part === right[index]);
}

function xmlText(value: string): string {
  return value.replaceAll("&quot;", '"').replaceAll("&gt;", ">").replaceAll("&lt;", "<").replaceAll("&amp;", "&");
}

function commandError(result: SelfUpdateCommandResult): string {
  return result.stderr.trim() || result.stdout.trim() || `exit code ${result.exitCode}`;
}

function errorMessage(error: unknown): string {
  return error instanceof Error && error.message ? error.message : "Ferry could not read the service file.";
}

/**
 * The command that installs `version` in the same way as this Ferry. An npm
 * install has its binary in `node_modules/@dlhck/ferry-<os>-<arch>`. Else the
 * release installer replaces the binary in its directory.
 */
export function updateCommand(version: string, execPath: string): string[] {
  if (isNpmInstall(execPath)) return ["npm", "install", "--global", `@dlhck/ferry@${version}`];
  const tag = `v${version}`;
  const url = `${INSTALLER_URL}/${tag}/install.sh`;
  return [
    "sh",
    "-c",
    [
      "ferry_tmp=$(mktemp) || exit 1",
      `if command -v curl >/dev/null 2>&1; then curl -fsSL -o "$ferry_tmp" ${url}; else wget -q -O "$ferry_tmp" ${url}; fi \\`,
      `  && FERRY_VERSION=${tag} FERRY_INSTALL_DIR="$1" sh "$ferry_tmp"`,
      "ferry_rc=$?",
      'rm -f "$ferry_tmp"',
      'exit "$ferry_rc"',
    ].join("\n"),
    "ferry-update",
    dirname(execPath),
  ];
}

function isNpmInstall(execPath: string): boolean {
  return execPath.includes("/node_modules/@dlhck/ferry-");
}

/** True when release `a` is newer than `b`. A version without a pre-release part is newer than its pre-release. */
export function isNewer(a: string, b: string): boolean {
  const [coreA = "", preA] = a.split("-", 2);
  const [coreB = "", preB] = b.split("-", 2);
  const partsA = coreA.split(".").map(Number);
  const partsB = coreB.split(".").map(Number);
  for (let index = 0; index < 3; index++) {
    const difference = (partsA[index] ?? 0) - (partsB[index] ?? 0);
    if (difference !== 0) return difference > 0;
  }
  return preA === undefined && preB !== undefined;
}

async function fetchLatestRelease(): Promise<LatestRelease | null> {
  try {
    const response = await fetch(LATEST_RELEASE_URL, {
      headers: { accept: "application/vnd.github+json", "user-agent": `ferry/${VERSION}` },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    return response.ok ? latestRelease(await response.json()) : null;
  } catch {
    return null;
  }
}

/** The release of a GitHub release body, or null when the body has no release version. A file counts when its upload is done. */
export function latestRelease(body: unknown): LatestRelease | null {
  const release = (body ?? {}) as { tag_name?: unknown; assets?: unknown };
  const version = typeof release.tag_name === "string" ? release.tag_name.replace(/^v/, "") : "";
  if (!isReleaseVersion(version)) return null;
  const assets = Array.isArray(release.assets) ? (release.assets as { name?: unknown; state?: unknown }[]) : [];
  return {
    version,
    assets: assets.flatMap((asset) => (typeof asset?.name === "string" && asset.state === "uploaded" ? [asset.name] : [])),
  };
}

/** Only HTTP 404 says that npm does not have the version. After another failure, npm gives its own error. */
async function npmHasVersion(version: string): Promise<boolean> {
  try {
    const response = await fetch(`${NPM_PACKAGE_URL}/${version}`, {
      headers: { "user-agent": `ferry/${VERSION}` },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    return response.status !== 404;
  } catch {
    return true;
  }
}

async function chooseUpdate(current: string, latest: string): Promise<UpdateChoice> {
  const choice = await prompts.select<UpdateChoice>({
    message: `Ferry ${latest} is available. You have ${current}.`,
    options: [
      { value: "update", label: "Update now" },
      { value: "skip", label: "Skip" },
      { value: "skip-version", label: `Skip ${latest}` },
    ],
  });
  return prompts.isCancel(choice) ? "skip" : choice;
}

function readState(path: string): CheckState | null {
  try {
    const state = JSON.parse(readFileSync(path, "utf8")) as CheckState;
    return typeof state.checkedAt === "number" ? state : null;
  } catch {
    return null;
  }
}

/** A state that Ferry cannot write only makes the next run check again. */
function writeState(path: string, state: CheckState): void {
  try {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, `${JSON.stringify(state)}\n`);
  } catch {
    // The check is optional.
  }
}

async function runCaptured(argv: readonly string[]): Promise<SelfUpdateCommandResult> {
  const child = Bun.spawn([...argv], { stdin: "inherit", stdout: "pipe", stderr: "pipe" });
  const [exitCode, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  return { exitCode, stdout, stderr };
}

const defaultDependencies: SelfUpdateDependencies = {
  version: VERSION,
  home: homedir(),
  platform: process.platform,
  arch: process.arch,
  uid: process.getuid?.(),
  execPath: process.execPath,
  scriptPath: process.argv[1],
  json: false,
  now: Date.now,
  fetchLatest: fetchLatestRelease,
  npmHasVersion,
  choose: chooseUpdate,
  run: (argv) => Bun.spawn([...argv], { stdio: ["inherit", "inherit", "inherit"] }).exited,
  runService: runCaptured,
  runSkillUpdate: runCaptured,
  exists: existsSync,
  readFile: (path) => readFileSync(path, "utf8"),
  readDirectory: readdirSync,
  writeLine: console.log,
  warn: () => {},
};
