/**
 * Tell agents on a box that they run on a Ferry box. On each sync, the box
 * gets `~/.ferry/box/AGENTS.md`: a short header, then the per-box instructions
 * of the operator machine, then the shared instructions byte for byte. One
 * blank line separates the parts. The harness instruction files on the box
 * link to it. The operator machine does not change. `ferry whoami` prints the
 * role of a machine.
 */

import { existsSync, readdirSync, readFileSync, readlinkSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { ownsSkills, type HarnessDescriptor } from "./registry/types.ts";

/** The directory of the generated box files, relative to the home. Sync writes it on each run. */
export const BOX_DIRECTORY = ".ferry/box";
/** The generated instruction file of the box, relative to the home. */
export const BOX_INSTRUCTIONS = `${BOX_DIRECTORY}/AGENTS.md`;
/**
 * The box name, whether the generated file has per-box instructions, and the
 * managed paths of the last Apply, as `{ "name": "<box>", "boxInstructions":
 * true, "managedPaths": { ... } }`, relative to the home.
 */
export const BOX_IDENTITY = `${BOX_DIRECTORY}/identity.json`;

/** The paths that Ferry keeps linked in a home, relative to the home. */
export type ManagedPaths = {
  readonly instructionFiles: readonly string[];
  /** Each skill in these roots is a link into the checkout. */
  readonly skillRoots: readonly string[];
  readonly roots: readonly string[];
};

/** The snapshot checkout, relative to the home. */
const CHECKOUT = ".ferry/store";

/** The per-box instruction file of a box on the operator machine, relative to the home. It never goes into the snapshot. */
export function boxInstructionsSource(box: string): string {
  return `.ferry/boxes/${box}/AGENTS.md`;
}

/** Read the per-box instruction file on the operator machine. Null when the file is missing or has only blank lines. */
export function readBoxInstructions(home: string, box: string): { readonly path: string; readonly bytes: Uint8Array } | null {
  const path = join(home, boxInstructionsSource(box));
  let bytes: Uint8Array;
  try {
    bytes = readFileSync(path);
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return null;
    throw error;
  }
  return bytes.every(isBlank) ? null : { path, bytes };
}

/**
 * The standard input of `writeBoxFilesCommand` with per-box instructions: the
 * bytes without the blank lines at the start and the end, then one blank line.
 * The text goes to the box on the standard input, so it is not in a command line.
 */
export function boxInstructionsInput(bytes: Uint8Array): Uint8Array {
  let start = 0;
  let end = bytes.length;
  while (start < end && isBlank(bytes[start]!)) start += 1;
  while (end > start && isBlank(bytes[end - 1]!)) end -= 1;
  return Buffer.concat([bytes.subarray(start, end), Buffer.from("\n\n")]);
}

/** A space, a tab, a line feed, or a carriage return. */
function isBlank(byte: number): boolean {
  return byte === 0x20 || byte === 0x09 || byte === 0x0a || byte === 0x0d;
}

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
 * The box command that writes the generated instruction file from the checkout,
 * then the identity file. With `perBox`, the command reads the per-box part of
 * `boxInstructionsInput` from its standard input and puts it between the header
 * and the shared instructions. Without a checkout AGENTS.md, it removes the
 * generated file. The identity file has no managed paths until Apply ends, so
 * a failed Apply does not keep the list of an earlier sync.
 */
export function writeBoxFilesCommand(remoteHome: string, checkout: string, box: string, perBox = false): string {
  const directory = quoteShell(`${remoteHome}/${BOX_DIRECTORY}`);
  const source = quoteShell(`${checkout}/AGENTS.md`);
  return [
    "set -e",
    `ferry_dir=${directory}`,
    'mkdir -p "$ferry_dir"',
    `if [ -f ${source} ]; then`,
    `  { printf '%s\\n\\n' ${quoteShell(boxInstructionsHeader(box))};${perBox ? " cat;" : ""} cat ${source}; } > "$ferry_dir/AGENTS.md.tmp"`,
    '  mv -f "$ferry_dir/AGENTS.md.tmp" "$ferry_dir/AGENTS.md"',
    "else",
    '  rm -f "$ferry_dir/AGENTS.md"',
    "fi",
    ...writeIdentityLines({ name: box }, perBox),
  ].join("\n");
}

/**
 * The box command that writes the identity file again after Apply, with the
 * paths that Apply keeps linked. `ferry whoami` on the box prints them, because
 * the box has no operator config.
 */
export function recordManagedPathsCommand(remoteHome: string, box: string, perBox: boolean, managedPaths: ManagedPaths): string {
  return [
    "set -e",
    `ferry_dir=${quoteShell(`${remoteHome}/${BOX_DIRECTORY}`)}`,
    ...writeIdentityLines({ name: box, managedPaths }, perBox),
  ].join("\n");
}

/** Replace the identity file in one step. A box without the generated file has no per-box instructions. `name` is a valid box name. */
function writeIdentityLines(fields: { readonly name: string; readonly managedPaths?: ManagedPaths }, perBox: boolean): string[] {
  const identity = (boxInstructions: boolean) =>
    quoteShell(JSON.stringify({ name: fields.name, boxInstructions, managedPaths: fields.managedPaths }));
  return [
    perBox
      ? `if [ -f "$ferry_dir/AGENTS.md" ]; then identity=${identity(true)}; else identity=${identity(false)}; fi`
      : `identity=${identity(false)}`,
    `printf '%s\\n' "$identity" > "$ferry_dir/identity.json.tmp"`,
    'mv -f "$ferry_dir/identity.json.tmp" "$ferry_dir/identity.json"',
  ];
}

export type WhoamiReport = {
  readonly role: "operator" | "box";
  /** The name of this box, or null on the operator machine or before the first sync. */
  readonly box: string | null;
  /**
   * The generated instruction file of a box and its parts, in order. `path` is
   * the file of the part on the operator machine, or null for the header. Null
   * on the operator machine and on a box without the generated file.
   */
  readonly instructions: {
    readonly file: string;
    readonly sources: readonly { readonly part: "header" | "box" | "shared"; readonly path: string | null }[];
  } | null;
  /**
   * The paths that Ferry manages on this machine, each with `~/`. On a box,
   * they are the paths of the last sync, so an off harness has none.
   */
  readonly managedPaths: {
    readonly instructionFiles: readonly string[];
    /** Each skill in these roots is a link into `~/.ferry/store/skills`. */
    readonly skillRoots: readonly string[];
    readonly roots: readonly string[];
  };
};

/**
 * The role comes from the box-install check of the CLI. The box name, the
 * instruction parts, and the managed paths of a box come from the last sync.
 * On the operator machine, the managed paths come from the harnesses.
 */
export function whoami(input: {
  readonly home: string;
  readonly boxMode: boolean;
  readonly harnesses: readonly HarnessDescriptor[];
}): WhoamiReport {
  const unique = (paths: readonly (string | undefined)[]) =>
    [...new Set(paths.filter((path): path is string => path !== undefined))];
  const inHome = (paths: readonly string[]) => paths.map((path) => `~/${path}`);
  const identity = input.boxMode ? readIdentity(input.home) : null;
  const harnessPaths: ManagedPaths = {
    instructionFiles: unique(input.harnesses.map((harness) => harness.instructionFile)),
    skillRoots: unique(input.harnesses.filter(ownsSkills).map((harness) => harness.skillRoot)),
    roots: unique(input.harnesses.flatMap((harness) => harness.extraRoots ?? [])),
  };
  const managed = identity === null ? harnessPaths : (identity.managedPaths ?? linkedPaths(input.home, harnessPaths));
  return {
    role: input.boxMode ? "box" : "operator",
    box: identity?.name ?? null,
    instructions:
      identity !== null && existsSync(`${input.home}/${BOX_INSTRUCTIONS}`)
        ? {
            file: `~/${BOX_INSTRUCTIONS}`,
            sources: [
              { part: "header", path: null },
              ...(identity.boxInstructions && identity.name !== null
                ? [{ part: "box" as const, path: `~/${boxInstructionsSource(identity.name)}` }]
                : []),
              { part: "shared", path: "~/AGENTS.md" },
            ],
          }
        : null,
    managedPaths: {
      instructionFiles: inHome(managed.instructionFiles),
      skillRoots: inHome(managed.skillRoots),
      roots: inHome(managed.roots),
    },
  };
}

/**
 * The managed paths of a box that an earlier Ferry synced. Its identity file
 * has no list, and the box has no operator config. So keep each path of the
 * builtin harnesses that is a link to the generated instruction file or into
 * the checkout, and each skill root that holds such a link.
 */
function linkedPaths(home: string, paths: ManagedPaths): ManagedPaths {
  const linked = (path: string) => {
    try {
      const target = resolve(dirname(join(home, path)), readlinkSync(join(home, path)));
      return target === join(home, BOX_INSTRUCTIONS) || target.startsWith(`${join(home, CHECKOUT)}/`);
    } catch {
      return false;
    }
  };
  const names = (root: string) => {
    try {
      return readdirSync(join(home, root));
    } catch {
      return [];
    }
  };
  return {
    instructionFiles: paths.instructionFiles.filter(linked),
    skillRoots: paths.skillRoots.filter((root) => names(root).some((name) => linked(`${root}/${name}`))),
    roots: paths.roots.filter(linked),
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
  const paths = [
    ...instructionFiles.map((path) => `  ${path}`),
    ...skillRoots.map((path) => `  ${path}/<skill>`),
    ...roots.map((path) => `  ${path}`),
  ];
  return [
    ...lines,
    ...(report.instructions
      ? [
          `Ferry writes ${report.instructions.file} on each sync. Do not edit it. It has these parts, in this order:`,
          ...report.instructions.sources.map((source) =>
            source.path === null ? "  The Ferry header" : `  ${source.path} on the operator machine`,
          ),
        ]
      : []),
    ...(paths.length > 0 ? ["Managed paths:", ...paths] : ["Managed paths: none"]),
  ];
}

function readIdentity(home: string): {
  readonly name: string | null;
  readonly boxInstructions: boolean;
  /** Null when the last sync did not record the list: an earlier Ferry, or a failed Apply. */
  readonly managedPaths: ManagedPaths | null;
} {
  try {
    const identity = JSON.parse(readFileSync(`${home}/${BOX_IDENTITY}`, "utf8")) as {
      name?: unknown;
      boxInstructions?: unknown;
      managedPaths?: Partial<Record<keyof ManagedPaths, unknown>>;
    };
    const paths = (value: unknown) =>
      Array.isArray(value) && value.every((path) => typeof path === "string") ? (value as string[]) : null;
    const instructionFiles = paths(identity.managedPaths?.instructionFiles);
    const skillRoots = paths(identity.managedPaths?.skillRoots);
    const roots = paths(identity.managedPaths?.roots);
    return {
      name: typeof identity.name === "string" ? identity.name : null,
      boxInstructions: identity.boxInstructions === true,
      managedPaths: instructionFiles && skillRoots && roots ? { instructionFiles, skillRoots, roots } : null,
    };
  } catch {
    return { name: null, boxInstructions: false, managedPaths: null };
  }
}

function quoteShell(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}
