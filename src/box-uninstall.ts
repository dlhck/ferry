/**
 * Remove Ferry from a box, for `ferry box remove <name> --uninstall`. Ferry
 * reads the box first, so the plan names only what is there. Then one box
 * command stops the Ferry user services, removes the harness links into the
 * Ferry checkout, moves the backups of `ferry sync --force` back, and removes
 * the Ferry files. The box keeps its logins, its projects, the installed
 * tools, and the values that sync merged into its config files.
 */

import { posix } from "node:path";
import { BOX_MARKER } from "./box-ferry.ts";
import { BOX_DIRECTORY, BOX_INSTRUCTIONS } from "./box-identity.ts";
import { quoteShell } from "./box-settings.ts";
import { FerryError, linkFailure } from "./errors.ts";
import { EXPOSED_DIR } from "./expose.ts";
import type { Link } from "./link.ts";
import type { HarnessDescriptor } from "./registry/types.ts";
import { PROFILE_BLOCK_END, PROFILE_BLOCK_START } from "./tools/path.ts";

const STORE = ".ferry/store";
const BACKUPS = ".ferry/backups";
const OPERATOR_CONFIG = ".ferry/config.toml";
const BINARY = ".local/bin/ferry";
const UNIT_DIRECTORY = ".config/systemd/user";
/** The Ferry files and directories of a box, in the order of removal. The marker goes last, so a failed run leaves a box install. */
const FERRY_PATHS = [BOX_DIRECTORY, EXPOSED_DIR, STORE, BINARY, BOX_MARKER];

/** What Ferry removes from a box. Each path is relative to the box home. */
export type BoxUninstallPlan = {
  readonly home: string;
  /** The `ferry-*.service` units in `~/.config/systemd/user`. */
  readonly services: readonly string[];
  /**
   * Each harness path that links into the Ferry checkout or to the generated
   * instruction file. `link` is the text of the link. `backup` is the newest
   * backup of the path, which Ferry moves back, or null.
   */
  readonly links: readonly { readonly path: string; readonly link: string; readonly backup: string | null }[];
  /** True when `~/.profile` has the ferry PATH block. */
  readonly profileBlock: boolean;
  /** The Ferry files and directories that are on the box, in the order of removal. */
  readonly paths: readonly string[];
};

type UninstallLink = Pick<Link, "run">;

/** Prints one record for each line. Each path and link text is hex, so no byte breaks a record. */
const INSPECT_SCRIPT = String.raw`
hex() { LC_ALL=C od -An -tx1 | tr -d ' \n'; }
record() { printf '%s\t%s\n' "$1" "$(printf '%s' "$2" | hex)"; }
link() {
  [ -L "$1" ] || return 0
  link_text=$(readlink "$1") || exit 1
  printf 'L\t%s\t%s\n' "$(printf '%s' "$1" | hex)" "$(printf '%s' "$link_text" | hex)"
}
cd "$HOME" || exit 1
record H "$HOME"
backup_depth=$1
root_count=$2
shift 2
while [ "$root_count" -gt 0 ]; do
  for entry in "$1"/* "$1"/.[!.]*; do link "$entry"; done
  shift
  root_count=$((root_count - 1))
done
path_count=$1
shift
while [ "$path_count" -gt 0 ]; do
  link "$1"
  shift
  path_count=$((path_count - 1))
done
for unit in ${UNIT_DIRECTORY}/ferry-*.service; do
  if [ -e "$unit" ] || [ -L "$unit" ]; then record U "$(basename "$unit")"; fi
done
for path do
  if [ -e "$path" ] || [ -L "$path" ]; then record X "$path"; fi
done
if [ -f .profile ] && grep -qxF '${PROFILE_BLOCK_START}' .profile; then echo P; fi
if [ -d ${BACKUPS} ]; then
  find ${BACKUPS} -mindepth 3 -maxdepth "$backup_depth" | while IFS= read -r backup; do record B "$backup"; done
fi
`;

/**
 * Read the box and plan the removal. This function changes nothing. It
 * refuses a box that has a Ferry operator config, because its checkout is the
 * store of an operator machine.
 */
export async function planBoxUninstall(
  harnesses: readonly HarnessDescriptor[],
  link: UninstallLink,
): Promise<BoxUninstallPlan> {
  const roots = unique(harnesses.map((harness) => harness.skillRoot));
  const direct = unique(harnesses.flatMap((harness) => [harness.instructionFile, ...(harness.extraRoots ?? [])]));
  // A backup is at <timestamp>/<harness id>/<path>, below the backup directory.
  const depth = 2 + Math.max(1, ...direct.map((path) => path.split("/").length));
  const result = await link.run(
    shellCommand(INSPECT_SCRIPT, [String(depth), String(roots.length), ...roots, String(direct.length), ...direct, OPERATOR_CONFIG, ...FERRY_PATHS]),
  );
  if (!result.ok) throw new Error(`${result.error.origin}/${result.error.code}: ${result.error.message}`, { cause: linkFailure(result.error) });

  let home = "";
  const found = new Map<string, string>();
  const services: string[] = [];
  const present = new Set<string>();
  /** The timestamps of each backup, by its path below the timestamp directory. */
  const backups = new Map<string, string[]>();
  let profileBlock = false;
  for (const line of result.stdout.split("\n")) {
    const [kind, first = "", second = ""] = line.split("\t");
    const value = fromHex(first);
    if (kind === "H") home = value;
    else if (kind === "L") found.set(value, fromHex(second));
    else if (kind === "U") services.push(value);
    else if (kind === "X") present.add(value);
    else if (kind === "P") profileBlock = true;
    else if (kind === "B") {
      const [timestamp = "", ...rest] = value.slice(BACKUPS.length + 1).split("/");
      backups.set(rest.join("/"), [...(backups.get(rest.join("/")) ?? []), timestamp]);
    }
  }
  if (!home.startsWith("/")) throw new Error("the box returned no home directory");
  if (present.has(OPERATOR_CONFIG)) {
    throw new FerryError(
      "refused",
      `The box has a Ferry operator config, ~/${OPERATOR_CONFIG}, so it is an operator machine too. Ferry does not remove its checkout.`,
      { hint: "Run ferry uninstall on that machine." },
    );
  }

  const store = posix.join(home, STORE);
  const links = [...found]
    .filter(([path, text]) => {
      const target = posix.resolve(home, posix.dirname(path), text);
      return target === store || target.startsWith(`${store}/`) || target === posix.join(home, BOX_INSTRUCTIONS);
    })
    .map(([path, text]) => {
      const [newest] = harnesses
        .flatMap((harness) => [
          ...(harness.skillRoot === posix.dirname(path) || harness.instructionFile === path
            ? [`${harness.id}/${posix.basename(path)}`]
            : []),
          ...(harness.extraRoots?.includes(path) ? [`${harness.id}/${path}`] : []),
        ])
        .flatMap((suffix) => (backups.get(suffix) ?? []).map((timestamp) => `${timestamp}/${suffix}`))
        .sort(compare)
        .reverse();
      return { path, link: text, backup: newest === undefined ? null : `${BACKUPS}/${newest}` };
    })
    .sort((a, b) => compare(a.path, b.path));
  // Without the marker, the binary is not a box install of Ferry, so it stays.
  const paths = FERRY_PATHS.filter((path) => present.has(path) && (path !== BINARY || present.has(BOX_MARKER)));
  return { home, services: services.sort(compare), links, profileBlock, paths };
}

/** The plan as lines. Ferry prints them before it asks. */
export function boxUninstallLines(plan: BoxUninstallPlan): string[] {
  const lines = [
    ...(plan.services.length > 0
      ? [`Stop and remove the user services: ${plan.services.join(", ")}. A stopped service stops its agents.`]
      : []),
    ...plan.links.map((entry) =>
      entry.backup === null ? `Remove the link ~/${entry.path}` : `Remove the link ~/${entry.path} and move ~/${entry.backup} back`,
    ),
    ...(plan.profileBlock ? ["Remove the ferry PATH block of ~/.profile"] : []),
    ...plan.paths.map((path) => `Remove ~/${path}`),
  ];
  return [
    ...(lines.length > 0 ? lines : ["The box has no Ferry files."]),
    "Ferry keeps the logins and credentials, the project directories, the installed tools, ~/.paseo, and the values that ferry sync merged into the config files of the box.",
  ];
}

/**
 * Remove what the plan names. A link that changed after the plan stays. The
 * command stops at the first failure, and the services go first, so a failed
 * stop removes nothing. Returns the names that stay in `~/.ferry`. With no
 * name, Ferry removed the directory.
 */
export async function commitBoxUninstall(plan: BoxUninstallPlan, link: UninstallLink): Promise<readonly string[]> {
  const result = await link.run(boxUninstallCommand(plan));
  if (!result.ok) throw new Error(`${result.error.origin}/${result.error.code}: ${result.error.message}`, { cause: linkFailure(result.error) });
  return result.stdout.split("\n").filter((line) => line !== "").map(fromHex).sort(compare);
}

function boxUninstallCommand(plan: BoxUninstallPlan): string {
  const lines = ["set -e", 'cd "$HOME"'];
  for (const unit of plan.services) {
    lines.push(`systemctl --user disable --now ${quoteShell(unit)}`, `rm -f ${quoteShell(`${UNIT_DIRECTORY}/${unit}`)}`);
  }
  if (plan.services.length > 0) lines.push("systemctl --user daemon-reload");
  for (const entry of plan.links) {
    const path = quoteShell(entry.path);
    lines.push(`if [ -L ${path} ] && [ "$(readlink ${path})" = ${quoteShell(entry.link)} ]; then`, `  unlink ${path}`);
    if (entry.backup !== null) {
      lines.push(`  mv ${quoteShell(entry.backup)} ${path}`);
      // The empty harness and timestamp directories of the backup go too.
      for (let directory = posix.dirname(entry.backup); directory !== BACKUPS; directory = posix.dirname(directory)) {
        lines.push(`  rmdir ${quoteShell(directory)} 2>/dev/null || true`);
      }
    }
    lines.push("fi");
  }
  if (plan.profileBlock) {
    lines.push(
      "if [ -f .profile ]; then",
      // The copy gives the temporary file the mode of the profile.
      "  cp -p .profile .profile.ferry-tmp",
      `  awk '$0 == "${PROFILE_BLOCK_START}" { skip = 1; next } skip && $0 == "${PROFILE_BLOCK_END}" { skip = 0; next } !skip { print }' .profile > .profile.ferry-tmp`,
      // A profile with only the block is a file that Ferry made.
      "  if [ -s .profile.ferry-tmp ]; then mv .profile.ferry-tmp .profile; else rm -f .profile.ferry-tmp .profile; fi",
      "fi",
    );
  }
  for (const path of plan.paths) lines.push(`rm -rf ${quoteShell(path)}`);
  lines.push(
    `rmdir ${BACKUPS} .ferry 2>/dev/null || true`,
    "for entry in .ferry/* .ferry/.[!.]*; do",
    '  if [ -e "$entry" ] || [ -L "$entry" ]; then printf \'%s\' "${entry##*/}" | LC_ALL=C od -An -tx1 | tr -d \' \\n\'; echo; fi',
    "done",
  );
  return lines.join("\n");
}

function shellCommand(script: string, arguments_: readonly string[]): string {
  return ["sh", "-c", quoteShell(script), "sh", ...arguments_.map(quoteShell)].join(" ");
}

function unique(values: readonly (string | undefined)[]): string[] {
  return [...new Set(values.filter((value): value is string => value !== undefined))];
}

function fromHex(value: string): string {
  if (!/^(?:[0-9a-f]{2})*$/.test(value)) throw new Error("the box returned invalid uninstall data");
  return Buffer.from(value, "hex").toString("utf8");
}

function compare(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}
