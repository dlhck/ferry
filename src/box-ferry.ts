/**
 * Ferry on the box. `ferry install` and `ferry update` put the Ferry version
 * of this machine on each box, with the release installer, and write the
 * box-mode marker `~/.ferry/box.json`. A Ferry binary that finds the marker
 * runs only the box commands (`ferry expose`, `ferry whoami`, `--version`, and help),
 * and the hidden `ferry scan` that the operator machine runs over Link.
 *
 * A development build has no release. Ferry then puts no Ferry on the box,
 * so the box never gets a version that differs from this machine. Then
 * `ferry adopt --from-box` and `ferry move --from-box` refuse, because they
 * need `ferry scan` on the box.
 */

import type { Link } from "./link.ts";
import type { ToolStatus } from "./tools/check.ts";
import type { ToolStep } from "./tools/resolve.ts";
import { parseVersion } from "./tools/version.ts";
import { isReleaseVersion } from "./version.ts";

/** The box-mode marker, relative to the home. Ferry checks only that the file is there. */
export const BOX_MARKER = ".ferry/box.json";

/** The id of the Ferry row in the plans and in `ferry status`. */
const ID = "ferry";
const VERSION_TIMEOUT_MS = 15_000;
const INSTALLER_URL = "https://raw.githubusercontent.com/dlhck/ferry";

/** Prints the Ferry version of the box. It prints nothing when the box has no box install. */
export const BOX_FERRY_VERSION_COMMAND = `[ -f "$HOME/${BOX_MARKER}" ] && "$HOME/.local/bin/ferry" --version`;

/**
 * Download `install.sh` of the release tag, install the Linux binary of that
 * release to `~/.local/bin`, then write the box-mode marker. The box needs
 * curl or wget, and no Node. `version` must pass `isReleaseVersion`, so it is
 * safe in the shell text.
 */
export function boxFerryInstallCommand(version: string): string {
  if (!isReleaseVersion(version)) throw new Error(`${version} is not a Ferry release version`);
  const tag = `v${version}`;
  const url = `${INSTALLER_URL}/${tag}/install.sh`;
  return [
    "ferry_tmp=$(mktemp) || exit 1",
    `if command -v curl >/dev/null 2>&1; then curl -fsSL -o "$ferry_tmp" ${url}; else wget -q -O "$ferry_tmp" ${url}; fi \\`,
    `  && FERRY_VERSION=${tag} FERRY_INSTALL_DIR="$HOME/.local/bin" sh "$ferry_tmp"`,
    "ferry_rc=$?",
    'rm -f "$ferry_tmp"',
    '[ "$ferry_rc" -eq 0 ] || exit "$ferry_rc"',
    `mkdir -p "$HOME/.ferry" && printf '%s\\n' '{"mode":"box","version":"${version}"}' > "$HOME/${BOX_MARKER}"`,
  ].join("\n");
}

/** The Ferry version of the box install, or null when the box has none. */
export async function readBoxFerryVersion(box: Pick<Link, "run">): Promise<string | null> {
  const result = await box.run(BOX_FERRY_VERSION_COMMAND, { timeoutMs: VERSION_TIMEOUT_MS });
  return result.ok ? parseVersion(result.stdout) : null;
}

/**
 * The Ferry step of an install or update plan. The target is `version`, the
 * version of this Ferry. A development build gives a skipped step and does
 * not read the box.
 */
export async function planBoxFerry(
  purpose: "install" | "update",
  box: Pick<Link, "run">,
  version: string,
): Promise<ToolStep> {
  const base = { tool: ID, policy: "operator", dependsOn: [] };
  if (!isReleaseVersion(version)) return { ...base, version: null, action: "skip-dev-build" };
  const onBox = await readBoxFerryVersion(box);
  if (onBox === version) return { ...base, version, action: "skip-same" };
  const action = purpose === "update" && onBox !== null ? "update" : "install";
  return { ...base, version, action, command: boxFerryInstallCommand(version) };
}

/** The Ferry row of `ferry status`. `box` is null when the box is offline. */
export async function boxFerryStatus(box: Pick<Link, "run"> | null, version: string): Promise<ToolStatus> {
  const release = isReleaseVersion(version);
  const base = { id: ID, mode: "always", policy: "operator", operator: version, target: release ? version : null } as const;
  if (box === null) return { ...base, box: null, state: "unknown", reason: "host offline" };
  const onBox = await readBoxFerryVersion(box);
  if (!release) return { ...base, box: onBox, state: "skipped", reason: "this Ferry is a development build" };
  if (onBox === null) return { ...base, box: null, state: "missing" };
  return { ...base, box: onBox, state: onBox === version ? "ok" : "drift" };
}
