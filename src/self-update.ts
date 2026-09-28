/**
 * The update of Ferry itself. Before a command runs on a terminal, Ferry
 * reads the latest GitHub release, at most once a day. When a newer release
 * is there, Ferry asks to update. `ferry self-update` reads the latest
 * release each time and updates without a question. The update uses the
 * method that installed this Ferry: npm, or the release installer.
 */

import * as prompts from "@clack/prompts";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { FerryError } from "./errors.ts";
import { isReleaseVersion, VERSION } from "./version.ts";

const STATE_RELATIVE_PATH = ".ferry/update-check.json";
const CHECK_INTERVAL_MS = 24 * 60 * 60 * 1_000;
const FETCH_TIMEOUT_MS = 2_000;
const LATEST_RELEASE_URL = "https://api.github.com/repos/dlhck/ferry/releases/latest";
const INSTALLER_URL = "https://raw.githubusercontent.com/dlhck/ferry";

/** The last check and the release that the operator skipped. */
type CheckState = {
  readonly checkedAt: number;
  readonly latest: string | null;
  readonly skipped?: string;
};

export type UpdateChoice = "update" | "skip" | "skip-version";

/** The --json result of `ferry self-update`. */
export type SelfUpdateResult = {
  readonly current: string;
  readonly latest: string;
  readonly updated: boolean;
};

export type SelfUpdateDependencies = {
  readonly version: string;
  readonly home: string;
  /** The path of the running Ferry binary. It tells how Ferry was installed. */
  readonly execPath: string;
  readonly now: () => number;
  /** The version of the latest release, or null when Ferry cannot read it. */
  readonly fetchLatest: () => Promise<string | null>;
  readonly choose: (current: string, latest: string) => Promise<UpdateChoice>;
  /** Runs the update command with the terminal of Ferry and returns its exit code. */
  readonly run: (argv: readonly string[]) => Promise<number>;
  readonly writeLine: (line: string) => void;
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
    const latest = (await resolved.fetchLatest()) ?? state?.latest ?? null;
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
  const latest = await resolved.fetchLatest();
  if (latest === null) throw new FerryError("failed", "Ferry cannot read the latest release from GitHub.");
  const path = join(resolved.home, STATE_RELATIVE_PATH);
  writeState(path, { ...readState(path), checkedAt: resolved.now(), latest });
  if (!isNewer(latest, current)) {
    resolved.writeLine(`Ferry ${current} is the latest version.`);
    return { current, latest, updated: false };
  }
  if ((await resolved.run(updateCommand(latest, resolved.execPath))) !== 0) {
    throw new FerryError("update-failed", `The update to Ferry ${latest} failed.`);
  }
  resolved.writeLine(`Updated Ferry to ${latest}. Run ferry update to put it on the boxes.`);
  return { current, latest, updated: true };
}

/**
 * The command that installs `version` in the same way as this Ferry. An npm
 * install has its binary in `node_modules/@dlhck/ferry-<os>-<arch>`. Else the
 * release installer replaces the binary in its directory.
 */
export function updateCommand(version: string, execPath: string): string[] {
  if (execPath.includes("/node_modules/@dlhck/ferry-")) return ["npm", "install", "--global", `@dlhck/ferry@${version}`];
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

async function fetchLatestRelease(): Promise<string | null> {
  try {
    const response = await fetch(LATEST_RELEASE_URL, {
      headers: { accept: "application/vnd.github+json", "user-agent": `ferry/${VERSION}` },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    if (!response.ok) return null;
    const body = (await response.json()) as { tag_name?: unknown };
    const version = typeof body.tag_name === "string" ? body.tag_name.replace(/^v/, "") : "";
    return isReleaseVersion(version) ? version : null;
  } catch {
    return null;
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

const defaultDependencies: SelfUpdateDependencies = {
  version: VERSION,
  home: homedir(),
  execPath: process.execPath,
  now: Date.now,
  fetchLatest: fetchLatestRelease,
  choose: chooseUpdate,
  run: (argv) => Bun.spawn([...argv], { stdio: ["inherit", "inherit", "inherit"] }).exited,
  writeLine: console.log,
};
