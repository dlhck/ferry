/**
 * Tell agents on a box that they run on a Ferry box. On each sync, the box
 * gets `~/.ferry/box/AGENTS.md`: a short header, then the shared instructions
 * byte for byte. The harness instruction files on the box link to it. The
 * operator machine does not change. `ferry whoami` prints the role of a machine.
 */

import { readFileSync } from "node:fs";
import { ownsSkills, type HarnessDescriptor } from "./registry/types.ts";

/** The directory of the generated box files, relative to the home. Sync writes it on each run. */
export const BOX_DIRECTORY = ".ferry/box";
/** The generated instruction file of the box, relative to the home. */
export const BOX_INSTRUCTIONS = `${BOX_DIRECTORY}/AGENTS.md`;
/** The name of the box, as `{ "name": "<box>" }`, relative to the home. */
export const BOX_IDENTITY = `${BOX_DIRECTORY}/identity.json`;

/** The header of the generated instruction file. It goes into each agent context on the box, so keep it short. */
export function boxInstructionsHeader(box: string): string {
  return (
    `This machine is the Ferry box \`${box}\`. The operator machine is the source of truth. ` +
    "Do not run `ferry sync`, `ferry box`, or `ferry tunnel` here. " +
    "Do not edit files that Ferry manages. Change them on the operator machine. " +
    "Run `ferry whoami` for details."
  );
}

/**
 * The box command that writes the identity file and the generated instruction
 * file from the checkout. Without a checkout AGENTS.md, it removes the
 * generated file. `box` is a valid box name, so it is safe in JSON.
 */
export function writeBoxFilesCommand(remoteHome: string, checkout: string, box: string): string {
  const directory = quoteShell(`${remoteHome}/${BOX_DIRECTORY}`);
  const source = quoteShell(`${checkout}/AGENTS.md`);
  return [
    "set -e",
    `ferry_dir=${directory}`,
    'mkdir -p "$ferry_dir"',
    `printf '%s\\n' ${quoteShell(JSON.stringify({ name: box }))} > "$ferry_dir/identity.json.tmp"`,
    'mv -f "$ferry_dir/identity.json.tmp" "$ferry_dir/identity.json"',
    `if [ -f ${source} ]; then`,
    `  { printf '%s\\n\\n' ${quoteShell(boxInstructionsHeader(box))}; cat ${source}; } > "$ferry_dir/AGENTS.md.tmp"`,
    '  mv -f "$ferry_dir/AGENTS.md.tmp" "$ferry_dir/AGENTS.md"',
    "else",
    '  rm -f "$ferry_dir/AGENTS.md"',
    "fi",
  ].join("\n");
}

export type WhoamiReport = {
  readonly role: "operator" | "box";
  /** The name of this box, or null on the operator machine or before the first sync. */
  readonly box: string | null;
  /** The paths that Ferry manages on this machine, relative to the home. */
  readonly managedPaths: {
    readonly instructionFiles: readonly string[];
    /** Each skill in these roots is a link into `~/.ferry/store/skills`. */
    readonly skillRoots: readonly string[];
    readonly roots: readonly string[];
  };
};

/** The role comes from the box-install check of the CLI. The box name comes from the last sync. */
export function whoami(input: {
  readonly home: string;
  readonly boxMode: boolean;
  readonly harnesses: readonly HarnessDescriptor[];
}): WhoamiReport {
  const unique = (paths: readonly (string | undefined)[]) =>
    [...new Set(paths.filter((path): path is string => path !== undefined))].map((path) => `~/${path}`);
  return {
    role: input.boxMode ? "box" : "operator",
    box: input.boxMode ? readBoxName(input.home) : null,
    managedPaths: {
      instructionFiles: unique(input.harnesses.map((harness) => harness.instructionFile)),
      skillRoots: unique(input.harnesses.filter(ownsSkills).map((harness) => harness.skillRoot)),
      roots: unique(input.harnesses.flatMap((harness) => harness.extraRoots ?? [])),
    },
  };
}

export function whoamiLines(report: WhoamiReport): string[] {
  const lines =
    report.role === "box"
      ? [
          `This machine is the Ferry box ${report.box ?? "(no sync yet)"}.`,
          "The operator machine is the source of truth. Change Ferry-managed files there.",
          "Only ferry expose and ferry whoami run here.",
        ]
      : [
          "This machine is the Ferry operator machine. It is the source of truth.",
          "Edit Ferry-managed files here, then run ferry sync.",
        ];
  const { instructionFiles, skillRoots, roots } = report.managedPaths;
  return [
    ...lines,
    "Managed paths:",
    ...instructionFiles.map((path) => `  ${path}`),
    ...skillRoots.map((path) => `  ${path}/<skill>`),
    ...roots.map((path) => `  ${path}`),
  ];
}

function readBoxName(home: string): string | null {
  try {
    const identity = JSON.parse(readFileSync(`${home}/${BOX_IDENTITY}`, "utf8")) as { name?: unknown };
    return typeof identity.name === "string" ? identity.name : null;
  } catch {
    return null;
  }
}

function quoteShell(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}
