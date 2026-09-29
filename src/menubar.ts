/**
 * Install the macOS menu bar app. The app reads ~/.ferry/status.json, which
 * `ferry watch` writes. Ferry downloads the app of the release of this Ferry,
 * verifies it against SHA256SUMS of the release, unpacks it to
 * ~/Applications, and starts it with a launchd user agent at login.
 */

import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { FerryError } from "./errors.ts";
import { isReleaseVersion, VERSION } from "./version.ts";
import {
  checked,
  installUserService,
  runCommand,
  uninstallUserService,
  type UserService,
  type WatchServiceDependencies,
} from "./watch-service.ts";

const APP = "Ferry Menu Bar.app";
const EXECUTABLE = "FerryMenuBar";
/** The release asset that `macos/build.sh` writes. */
export const MENUBAR_ASSET = "ferry-menubar-macos.zip";
const DOWNLOAD_BASE = "https://github.com/dlhck/ferry/releases/download";

export type MenuBarInput = {
  readonly home?: string;
  readonly platform?: NodeJS.Platform;
  readonly uid?: number;
  readonly version?: string;
  /** The path of the running process. Under bun, it is the bun binary. */
  readonly execPath?: string;
  readonly path?: string;
  /** SSH_AUTH_SOCK of the app. The default is SSH_AUTH_SOCK of this process. */
  readonly sshAuthSock?: string;
  /** A local `.app` directory or a zip of `macos/build.sh`, in place of the release download. */
  readonly app?: string;
};

export type MenuBarDependencies = WatchServiceDependencies & {
  readonly download?: (url: string) => Promise<Uint8Array>;
  /** Finds an executable on PATH, or returns null. */
  readonly which?: (name: string) => string | null;
};

export type MenuBarInstallResult = {
  /** The installed app. */
  readonly app: string;
  /** The launchd agent. */
  readonly path: string;
  /** The release of the app, or null for --app. */
  readonly version: string | null;
  /** FERRY_PATH of the app. */
  readonly ferryPath: string;
};

export type MenuBarUninstallResult = {
  readonly app: string;
  readonly path: string;
  /** False when neither the app nor the agent was there. */
  readonly removed: boolean;
};

export function menuBarService(ferryPath: string, source: "local" | "release" = "release"): UserService {
  return {
    command: "menubar",
    label: "dev.ferry.menubar",
    log: "ferry-menubar.log",
    unit: "ferry-menubar.service",
    description: "Ferry menu bar app",
    args: [],
    // Quit in the menu stops the app until the next login.
    restart: "no",
    environment: { FERRY_PATH: ferryPath, FERRY_MENUBAR_SOURCE: source },
  };
}

export async function installMenuBar(
  input: MenuBarInput = {},
  dependencies: MenuBarDependencies = {},
): Promise<MenuBarInstallResult> {
  const home = input.home ?? homedir();
  const uid = input.uid ?? process.getuid?.();
  const run = dependencies.run ?? runCommand;
  requireMacOS(input.platform, "install");
  const ferryPath = resolveFerryPath(input.execPath ?? process.execPath, dependencies.which ?? Bun.which);
  const version = input.version ?? VERSION;
  const source = input.app === undefined ? null : resolve(input.app);
  if (source === null && !isReleaseVersion(version)) {
    throw new FerryError(
      "usage",
      `Ferry ${version} is a development build. It has no release to download the menu bar app from.`,
      { hint: "Build the app with macos/build.sh, then run ferry menubar install --app <path>." },
    );
  }
  if (source !== null && !existsSync(source)) throw new FerryError("usage", `${source} does not exist.`);

  const applications = join(home, "Applications");
  const app = join(applications, APP);
  // Stop the running app before Ferry replaces it.
  await run(["launchctl", "bootout", `gui/${uid}/dev.ferry.menubar`], true);
  rmSync(app, { recursive: true, force: true });
  if (source !== null && statSync(source).isDirectory()) {
    await checked(run, ["ditto", source, app]);
  } else if (source !== null) {
    await checked(run, ["ditto", "-x", "-k", source, applications]);
  } else {
    await installRelease(version, applications, run, dependencies.download ?? download);
  }

  const service = await installUserService(
    menuBarService(ferryPath, source === null ? "release" : "local"),
    {
      home,
      platform: "darwin",
      executable: join(app, "Contents", "MacOS", EXECUTABLE),
      ...(uid === undefined ? {} : { uid }),
      ...(input.path === undefined ? {} : { path: input.path }),
      // Refresh now and Sync now run ferry, which connects to the boxes with SSH. The app uses the SSH agent of ferry watch.
      ...(input.sshAuthSock === undefined ? {} : { sshAuthSock: input.sshAuthSock }),
    },
    { ...dependencies, run },
  );
  return { app, path: service.path, version: source === null ? version : null, ferryPath };
}

export async function uninstallMenuBar(
  input: Pick<MenuBarInput, "home" | "platform" | "uid"> = {},
  dependencies: WatchServiceDependencies = {},
): Promise<MenuBarUninstallResult> {
  const home = input.home ?? homedir();
  requireMacOS(input.platform, "uninstall");
  const service = await uninstallUserService(
    menuBarService(""),
    { home, platform: "darwin", ...(input.uid === undefined ? {} : { uid: input.uid }) },
    dependencies,
  );
  const app = join(home, "Applications", APP);
  const appRemoved = existsSync(app);
  rmSync(app, { recursive: true, force: true });
  return { app, path: service.path, removed: service.removed || appRemoved };
}

/**
 * The Ferry path for FERRY_PATH. A run from a checkout (`bun link`) has bun
 * as its process, so Ferry takes `ferry` from PATH.
 */
export function resolveFerryPath(execPath: string, which: (name: string) => string | null): string {
  if (!/^bun(\.[^.]+)?$/.test(basename(execPath))) return execPath;
  const ferry = which("ferry");
  if (ferry === null) {
    throw new FerryError("usage", "Ferry runs under bun, and PATH has no ferry. The menu bar app needs the path of ferry.", {
      hint: "Run bun link in the Ferry checkout, or install a Ferry release.",
    });
  }
  return ferry;
}

function requireMacOS(platform: NodeJS.Platform | undefined, command: string): void {
  const current = platform ?? process.platform;
  if (current !== "darwin") {
    throw new FerryError("usage", `ferry menubar ${command} runs only on macOS. This machine runs ${current}.`);
  }
}

async function installRelease(
  version: string,
  applications: string,
  run: NonNullable<WatchServiceDependencies["run"]>,
  fetchBytes: (url: string) => Promise<Uint8Array>,
): Promise<void> {
  const url = `${DOWNLOAD_BASE}/v${version}`;
  const [zip, sums] = await Promise.all([fetchBytes(`${url}/${MENUBAR_ASSET}`), fetchBytes(`${url}/SHA256SUMS`)]);
  // The same lookup as install.sh: the line of the asset, with or without the binary mark.
  const expected = new TextDecoder()
    .decode(sums)
    .split("\n")
    .map((line) => line.trim().split(/\s+/))
    .find(([, name]) => name === MENUBAR_ASSET || name === `*${MENUBAR_ASSET}`)?.[0];
  if (expected === undefined) throw new FerryError("failed", `SHA256SUMS of Ferry ${version} has no checksum for ${MENUBAR_ASSET}.`);
  const actual = createHash("sha256").update(zip).digest("hex");
  if (actual !== expected) {
    throw new FerryError("failed", `Checksum mismatch for ${MENUBAR_ASSET}. Expected ${expected}, got ${actual}.`);
  }
  const directory = mkdtempSync(join(tmpdir(), "ferry-menubar-"));
  try {
    const file = join(directory, MENUBAR_ASSET);
    writeFileSync(file, zip);
    await checked(run, ["ditto", "-x", "-k", file, applications]);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

async function download(url: string): Promise<Uint8Array> {
  const response = await fetch(url, { headers: { "user-agent": `ferry/${VERSION}` } });
  if (!response.ok) throw new FerryError("failed", `Cannot download ${url}: HTTP ${response.status}.`);
  return new Uint8Array(await response.arrayBuffer());
}
