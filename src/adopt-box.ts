/**
 * Adopt brings a skill that an agent wrote on a box back to this machine.
 *
 * A box skill root holds links into the box snapshot checkout. A box-only
 * skill is a directory there that the box snapshot does not track: a real
 * directory, or a link to a directory outside the checkout, in a harness skill
 * root, or an untracked directory in the skills of the box checkout.
 *
 * The Ferry on the box runs the Manifest deny rules on the skill with `ferry
 * scan`. It reads each file one time and gives the bytes that it checked. A
 * skill with a file that a rule refuses stays on the box, and Adopt copies no
 * file of it. Else Adopt takes the files that pass, applies the rules of this
 * machine to them, and writes them to a local harness skill root as a real
 * directory. The next `ferry sync`
 * publishes it and links it into the
 * store, as it does for each new local skill. Ferry then moves the box copy to
 * `~/.ferry/backups` on the box, so that the sync can link the published skill
 * there.
 */

import * as prompts from "@clack/prompts";
import {
  chmodSync,
  cpSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  renameSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join, posix, relative } from "node:path";
import { resolveTargetBox } from "./boxes.ts";
import { ConfigMissingError, readConfig, resolveLinkOptions, type PartialOperatorConfig } from "./config.ts";
import { FerryError } from "./errors.ts";
import { Link, type LinkOptions } from "./link.ts";
import { CODEX_SYSTEM_SKILLS, readSeed, TOKEN_ERE } from "./manifest.ts";
import { noProgress, step, type Progress } from "./progress.ts";
import { BUILTIN_HARNESSES } from "./registry/builtin.ts";
import { ownsSkills, type HarnessDescriptor } from "./registry/types.ts";
import { MAX_FILE_BYTES, packOnBox, writePack } from "./scan.ts";

/** The skills of the snapshot checkout, relative to the home. */
const STORE_SKILLS = ".ferry/store/skills";

/** One skill that is only on the box. Each path is `~/<root>/<name>` on the box. */
export type BoxSkill = { readonly name: string; readonly paths: readonly string[] };

type BoxLink = Pick<Link, "run">;

const LIST_WORKER = String.raw`
hex() { LC_ALL=C od -An -tx1 | tr -d ' \n'; }
index=$1
tokens=$2
shift 2
for entry; do
  # A name or a link target with the form of a token does not leave the box.
  if printf '%s
' "$(basename -- "$entry")" "$(readlink "$entry" 2>/dev/null)" | grep -Eq -- "$tokens"; then continue; fi
  if [ -L "$entry" ]; then kind=L; target=$(printf '%s' "$(readlink "$entry")" | hex); else kind=O; target=; fi
  if [ -d "$entry" ]; then directory=1; else directory=0; fi
  printf 'E\t%s\t%s\t%s\t%s\t%s\n' "$index" "$(printf '%s' "$(basename -- "$entry")" | hex)" "$directory" "$kind" "$target"
done
`;

const LIST_SCRIPT = String.raw`
set -f
worker=$1
tokens=$2
shift 2
hex() { LC_ALL=C od -An -tx1 | tr -d ' \n'; }
printf 'H\t%s\n' "$(printf '%s' "$HOME" | hex)"
printf 'T\t%s\n' "$(git -C "$HOME/.ferry/store" ls-tree -z -d --name-only HEAD skills/ 2>/dev/null | hex)"
index=0
for root in "$@"; do
  if [ -d "$HOME/$root" ]; then
    find "$HOME/$root"/. ! -name . -prune -exec sh -c "$worker" sh "$index" "$tokens" {} + || exit 1
  fi
  index=$((index + 1))
done
`;

/**
 * List the skills on the box that its snapshot checkout does not track. It
 * reads each skill root of `harnesses` and the skills of the box checkout.
 * It changes nothing. It leaves out a directory whose name, or whose link
 * target, has the form of a token, so that the name stays on the box.
 */
export async function listBoxSkills(link: BoxLink, harnesses: readonly HarnessDescriptor[]): Promise<BoxSkill[]> {
  const roots = [...new Set(harnesses.flatMap((harness) => (harness.skillRoot ? [harness.skillRoot] : []))), STORE_SKILLS];
  const result = await link.run(shellCommand(LIST_SCRIPT, [LIST_WORKER, TOKEN_ERE, ...roots]));
  if (!result.ok) throw new Error(`${result.error.origin}/${result.error.code}: ${result.error.message}`);

  let home: string | null = null;
  let tracked = new Set<string>();
  const found = new Map<string, string[]>();
  for (const line of result.stdout.split("\n")) {
    if (line === "") continue;
    const fields = line.split("\t");
    if (fields[0] === "H") {
      home = fromHex(fields[1] ?? "");
    } else if (fields[0] === "T") {
      tracked = new Set(
        fromHex(fields[1] ?? "")
          .split("\0")
          .filter((path) => path !== "")
          .map((path) => path.replace(/^skills\//, "")),
      );
    } else if (fields[0] === "E" && fields.length === 6 && home !== null) {
      const root = roots[Number(fields[1])];
      const name = fromHex(fields[2]!);
      if (root === undefined) throw new Error("the box returned an invalid skill list");
      if (fields[3] !== "1" || name === CODEX_SYSTEM_SKILLS || tracked.has(name)) continue;
      // A link into the checkout is Ferry's. An untracked target there is listed with the checkout root.
      if (fields[4] === "L" && posix.resolve(posix.join(home, root), fromHex(fields[5]!)).startsWith(`${posix.join(home, STORE_SKILLS)}/`)) {
        continue;
      }
      const paths = found.get(name) ?? [];
      paths.push(`~/${root}/${name}`);
      found.set(name, paths);
    } else {
      throw new Error("the box returned an invalid skill list");
    }
  }
  return [...found].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([name, paths]) => ({ name, paths }));
}

export type AdoptFromBoxInput = {
  /** The box name of `--from-box`. */
  readonly box: string;
  /** The skill name, as `ferry status` lists it. */
  readonly name: string;
  /** Adopt without a confirmation prompt. Without a terminal, Ferry refuses without it. */
  readonly yes: boolean;
};

export type AdoptFromBoxDependencies = {
  readonly readConfig: () => PartialOperatorConfig | null;
  readonly createLink: (options: LinkOptions) => BoxLink;
  /** The home directory of this machine. */
  readonly home: string;
  /** The harnesses whose skill roots Adopt reads on the box and writes on this machine. */
  readonly harnesses: readonly HarnessDescriptor[];
  readonly now: () => Date;
  readonly writeLine: (line: string) => void;
  /** Records a warning for the --json envelope. The warning line also goes to `writeLine`. */
  readonly warn?: (line: string) => void;
  readonly progress: Progress;
  /** True when Ferry can ask a question on a terminal. */
  readonly interactive: boolean;
  readonly confirm: (message: string) => Promise<boolean | symbol | undefined>;
};

export type AdoptFromBoxResult = {
  readonly box: string;
  readonly name: string;
  /** The box copy, as `~/<root>/<name>` on the box. */
  readonly source: string;
  /** The local skill directory, as `~/<root>/<name>`. */
  readonly destination: string;
  /** True when the skill replaces the store copy of a skill with the same name. */
  readonly replaces: boolean;
  /** The adopted files, relative to the skill directory. */
  readonly files: readonly { readonly path: string; readonly executable: boolean }[];
  /** The files that a skip rule left on the box. */
  readonly skipped: readonly { readonly path: string; readonly code: string; readonly reason: string }[];
  /** The unified diff against the store copy, or null for a new skill. */
  readonly diff: string | null;
  /** False when the copy on this machine is already the same. */
  readonly adopted: boolean;
  /** Where the box copy went on the box, or null when Ferry did not move it. */
  readonly boxBackup: string | null;
};

/** Returns null when the operator does not confirm. */
export async function runAdoptFromBox(
  input: AdoptFromBoxInput,
  overrides: Partial<AdoptFromBoxDependencies> = {},
): Promise<AdoptFromBoxResult | null> {
  const dependencies = { ...defaultDependencies(), ...overrides };
  const { home, harnesses, progress, writeLine } = dependencies;
  const warn = dependencies.warn ?? writeLine;
  const { name } = input;
  if (name === "" || name === "." || name === ".." || name === CODEX_SYSTEM_SKILLS || /[/\\\0]/.test(name)) {
    throw new FerryError("usage", `${JSON.stringify(name)} is not a skill name.`);
  }
  const box = resolveTargetBox(loadConfig(dependencies.readConfig), input.box);
  const link = dependencies.createLink(resolveLinkOptions(box.host));

  const skills = await step(progress, `Listing the box-only skills on box ${box.name}`, () => listBoxSkills(link, harnesses));
  const skill = skills.find((entry) => entry.name === name);
  if (!skill) {
    throw new FerryError("usage", `Box ${box.name} has no box-only skill ${name}.`, {
      hint: `Run ferry status --box ${box.name} to list the box-only skills.`,
    });
  }
  const source = skill.paths[0]!;
  const destination = localDestination(home, harnesses, name, posix.dirname(source.slice(2)));
  const storeCopy = join(home, STORE_SKILLS, name);
  const replaces = exists(storeCopy);

  // The box reads each file of the skill one time, applies the rules of a publish to those bytes, and gives exactly
  // those bytes. When a rule refuses a file, the box gives no file of the skill.
  const pack = await step(progress, `Copying ${name} from box ${box.name}`, () =>
    packOnBox(link, `box ${box.name}`, { kind: "skill", root: source.slice(2) }),
  );
  if (pack.refused.length > 0) {
    const hits = pack.refused.map((hit) => `${hit.code} ${hit.reason}: ${hit.path}`);
    throw new FerryError(
      "deny-rule-match",
      `Ferry refused ${name} from box ${box.name}, and copied nothing to this machine: ${hits.join("; ")}`,
    );
  }
  if (pack.files.length === 0) throw new FerryError("refused", `${source} on box ${box.name} has no file that Ferry carries.`);
  const skipped = pack.skipped.map((entry) => ({ path: entry.path, code: entry.code, reason: entry.reason }));

  const stage = mkdtempSync(join(tmpdir(), "ferry-adopt-"));
  try {
    writePack(join(stage, "box", name), pack.files);

    // The rules of this machine run again on the copy. They find a hit only when the Ferry on the box has other rules.
    const seed = readSeed(join(stage, "box"), [{ id: "box", name: "box", skillRoot: "." }]);
    const inSkill = (path: string) => relative(join(stage, "box", name), path);
    if (!seed.ok) {
      const hits = seed.forbidden.map((hit) => `${hit.code} ${hit.reason}: ${inSkill(hit.path)}`);
      throw new FerryError(
        "deny-rule-match",
        `Ferry refused ${name} from box ${box.name} after the copy, and removed the copy from this machine: ${hits.join("; ")}`,
        { hint: `Run ferry update, so that the Ferry on box ${box.name} has the rules of this machine.` },
      );
    }
    const files = seed.skills.find((entry) => entry.name === name)?.files ?? [];
    if (files.length === 0) throw new FerryError("refused", `${source} on box ${box.name} has no file that Ferry carries.`);

    const staged = join(stage, "new");
    writeSkill(staged, files);
    let diff: string | null = null;
    if (replaces) {
      cpSync(storeCopy, join(stage, "old"), { recursive: true });
      diff = unifiedDiff(stage);
    }
    const result = {
      box: box.name,
      name,
      source,
      destination: `~/${relative(home, destination)}`,
      replaces,
      files: files.map((file) => ({ path: file.path, executable: file.executable })),
      skipped,
      diff,
    };

    if (diff === "") {
      writeLine(`${name} on box ${box.name} is the same as the copy on this machine.`);
      return { ...result, adopted: false, boxBackup: null };
    }
    if (diff === null) {
      writeLine(`New skill ${name} from ${source} on box ${box.name}:`);
      for (const file of result.files) writeLine(`  + ${file.path}${file.executable ? " (executable)" : ""}`);
    } else {
      writeLine(`${name} from ${source} on box ${box.name} changes the copy on this machine:`);
      for (const line of diff.replace(/\n$/, "").split("\n")) writeLine(line);
    }
    for (const entry of skipped) writeLine(`Skip: ${entry.path} (${entry.reason})`);
    const large = skipped.filter((entry) => entry.code === "too-large").map((entry) => entry.path);
    if (large.length > 0) {
      writeLine(`Ferry does not read a file of more than ${MAX_FILE_BYTES / 1024 / 1024} MiB. Copy ${large.join(", ")} from box ${box.name} by hand.`);
    }

    if (!input.yes) {
      if (!dependencies.interactive) {
        throw new FerryError("confirmation-required", `Adopt ${name} from box ${box.name}? Without a terminal, add --yes.`);
      }
      progress.pause();
      const question = `Adopt ${name} to ${result.destination}? Ferry moves the box copy to ~/.ferry/backups on box ${box.name}.`;
      if ((await dependencies.confirm(question)) !== true) {
        writeLine("Adopt cancelled.");
        return null;
      }
    }

    await step(progress, `Writing ${result.destination}`, () => install(staged, destination));

    const stamp = dependencies.now().toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z");
    const backup = `~/.ferry/backups/${stamp}/adopt`;
    let boxBackup: string | null = backup;
    try {
      await step(progress, `Moving the box copy aside on box ${box.name}`, async () => {
        const moves = skill.paths.map((path) => {
          const target = `"$HOME"/${quoteShell(`${backup.slice(2)}/${path.slice(2)}`)}`;
          return `mkdir -p "$(dirname ${target})" && mv "$HOME"/${quoteShell(path.slice(2))} ${target}`;
        });
        const moved = await link.run(moves.join(" && "));
        if (!moved.ok) throw new Error(moved.error.message);
      });
    } catch (error) {
      boxBackup = null;
      warn(
        `Warning: Ferry could not move ${skill.paths.join(", ")} on box ${box.name}: ${error instanceof Error ? error.message : String(error)}. ` +
          `Move it away on the box before ferry sync, or the sync refuses the live directory there.`,
      );
    }
    writeLine(`Adopted ${name} at ${result.destination}. Run ferry sync to publish it to all boxes.`);
    return { ...result, adopted: true, boxBackup };
  } finally {
    rmSync(stage, { recursive: true, force: true });
  }
}

/**
 * The local skill directory for `name`: the same root as on the box when a
 * local harness owns it, else the first root that owns skills. Each local
 * copy of `name` must be a link to the store copy, so that the sync publishes
 * the adopted directory as a store update and not as a clash.
 */
function localDestination(home: string, harnesses: readonly HarnessDescriptor[], name: string, boxRoot: string): string {
  const storeCopy = join(home, STORE_SKILLS, name);
  for (const harness of harnesses) {
    if (!harness.skillRoot) continue;
    const path = join(home, harness.skillRoot, name);
    if (!exists(path)) continue;
    let managed = false;
    try {
      managed = lstatSync(path).isSymbolicLink() && realpathSync(path) === realpathSync(storeCopy);
    } catch {
      // A broken link or a missing store copy is not managed.
    }
    if (!managed) {
      throw new FerryError("refused", `~/${relative(home, path)} exists on this machine and is not a Ferry link. Move it away first.`);
    }
  }
  const owners = harnesses.filter(ownsSkills);
  const root = owners.find((harness) => harness.skillRoot === boxRoot) ?? owners[0];
  if (!root?.skillRoot) throw new FerryError("refused", "No harness on this machine has a skill root.");
  return join(home, root.skillRoot, name);
}

function writeSkill(directory: string, files: readonly { path: string; bytes: Uint8Array; executable: boolean }[]): void {
  for (const file of files) {
    const path = join(directory, file.path);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, file.bytes);
    chmodSync(path, file.executable ? 0o755 : 0o644);
  }
}

/** Put `staged` at `destination`. A link to the store copy there goes away, and comes back when the move fails. */
function install(staged: string, destination: string): void {
  const held = `${destination}.ferry-adopting-${process.pid}`;
  mkdirSync(dirname(destination), { recursive: true });
  cpSync(staged, held, { recursive: true });
  const link = exists(destination);
  const aside = `${held}-link`;
  try {
    if (link) renameSync(destination, aside);
    renameSync(held, destination);
  } catch (error) {
    if (link && exists(aside) && !exists(destination)) renameSync(aside, destination);
    rmSync(held, { recursive: true, force: true });
    throw error;
  }
  if (link) unlinkSync(aside);
}

/** The unified diff from `old` to `new` under `stage`, or an empty string when they are the same. */
function unifiedDiff(stage: string): string {
  const result = Bun.spawnSync(["git", "diff", "--no-index", "--no-color", "--", "old", "new"], { cwd: stage });
  if (result.exitCode !== 0 && result.exitCode !== 1) {
    throw new Error(`Ferry could not compare the skill: ${result.stderr.toString().trim()}`);
  }
  return result.stdout.toString();
}

function exists(path: string): boolean {
  try {
    lstatSync(path);
    return true;
  } catch {
    return false;
  }
}

function loadConfig(read: () => PartialOperatorConfig | null): PartialOperatorConfig {
  const config = read();
  if (!config) throw new ConfigMissingError("Ferry config has no complete host. Run ferry init.");
  return config;
}

function defaultDependencies(): AdoptFromBoxDependencies {
  return {
    readConfig,
    createLink: (options) => new Link(options),
    home: homedir(),
    harnesses: BUILTIN_HARNESSES,
    now: () => new Date(),
    writeLine: console.log,
    progress: noProgress,
    interactive: process.stdin.isTTY === true && process.stdout.isTTY === true,
    confirm: (message) => prompts.confirm({ message, initialValue: false }),
  };
}

function fromHex(value: string): string {
  if (!/^(?:[0-9a-f]{2})*$/.test(value)) throw new Error("the box returned invalid skill list data");
  return Buffer.from(value, "hex").toString("utf8");
}

function shellCommand(script: string, arguments_: readonly string[]): string {
  return ["sh", "-c", quoteShell(script), "sh", ...arguments_.map(quoteShell)].join(" ");
}

function quoteShell(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}
