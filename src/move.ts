/**
 * Move continues a project on the other machine: from the operator machine to
 * the box, or with `fromBox` from the box to the operator machine.
 *
 * The destination clones the project from its git remote at the same path
 * relative to the home directory. Ferry then carries the local-only files that
 * pass the Manifest deny rules, verifies each one with a SHA-256 checksum on
 * the destination. With `remove`, the source copy goes to a trash directory.
 * Ferry never deletes it.
 *
 * Every source and destination step is a `sh` command string. The operator
 * machine runs it with `sh -c`. The box runs it through Link.
 */

import { createHash } from "node:crypto";
import { existsSync, lstatSync, mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { isAbsolute, join, posix, relative, resolve } from "node:path";
import { readConfig, resolveLinkOptions, type PartialOperatorConfig } from "./config.ts";
import { INTEGRATIONS, type Integration } from "./integrations/index.ts";
import { paseoSourceHint } from "./integrations/paseo.ts";
import type { IntegrationId } from "./integrations/types.ts";
import { Link, type LinkOptions } from "./link.ts";
import { carriedContentHits, carriedNameHit } from "./manifest.ts";
import { noProgress, plural, step, type Progress } from "./progress.ts";

export type MoveInput = {
  /** The project path on the operator machine, or the same path for the box with `fromBox`. */
  readonly path: string;
  readonly fromBox: boolean;
  readonly dryRun: boolean;
  readonly remove: boolean;
  readonly includeEnv: boolean;
};

export type MoveDependencies = {
  readonly readConfig: () => PartialOperatorConfig | null;
  readonly createLink: (options: LinkOptions) => Pick<Link, "run">;
  /** The home directory of the operator machine. */
  readonly home: string;
  /** Relative paths resolve from here. */
  readonly cwd: string;
  readonly platform: NodeJS.Platform;
  readonly now: () => Date;
  readonly writeLine: (line: string) => void;
  readonly progress: Progress;
  /** All built-in integrations. Move uses the ones that the config enables. */
  readonly integrations: readonly Integration[];
};

/** The line for `--remove`. Ferry never removes the source project from an integration. */
const SOURCE_HINTS: Record<IntegrationId, (path: string, side: string) => string> = { paseo: paseoSourceHint };

export class MoveError extends Error {}

/**
 * Directory and file names that Ferry does not carry: build output, caches,
 * IDE state, and macOS metadata. A tracked file in one of them still arrives
 * with the clone.
 */
export const SKIPPED_NAMES = [
  "node_modules",
  ".next",
  ".nuxt",
  ".svelte-kit",
  ".turbo",
  ".cache",
  ".parcel-cache",
  "dist",
  "build",
  "coverage",
  "target",
  "__pycache__",
  ".venv",
  "venv",
  ".gradle",
  ".terraform",
  ".idea",
  ".vscode",
  ".DS_Store",
  "._*",
] as const;

type Hit = { readonly path: string; readonly code: string; readonly reason: string };
type Carried = { readonly path: string; readonly sha256: string };

type SideResult = { readonly ok: true; readonly stdout: string } | { readonly ok: false; readonly message: string };

/** One machine of the move. `home` is a shell word for its home directory. */
type Side = {
  readonly label: "the box" | "this machine";
  readonly home: string;
  readonly trash: string;
  run(command: string, options?: { readonly input?: Uint8Array; readonly timeoutMs?: number }): Promise<SideResult>;
};

type GitSource = {
  readonly url: string;
  /** The branch to clone, or null for the default branch of the remote. */
  readonly branch: string | null;
};

type Plan = {
  readonly git: GitSource | null;
  readonly carry: readonly Carried[];
  readonly refused: readonly Hit[];
  readonly skipped: readonly Hit[];
  readonly notes: readonly string[];
  readonly problems: readonly string[];
  /** The local directory that holds the checked bytes of the carried files. */
  readonly stage: string;
};

const PROBE_TIMEOUT_MS = 30_000;
const NETWORK_TIMEOUT_MS = 120_000;
const GH_TIMEOUT_MS = 15_000;
const TRANSFER_TIMEOUT_MS = 15 * 60_000;
const SECTION = "ferry-section";

export async function runMove(input: MoveInput, overrides: Partial<MoveDependencies> = {}): Promise<void> {
  const dependencies: MoveDependencies = { ...defaultDependencies(), ...overrides };
  const home = realpathSync(dependencies.home);
  const rel = homeRelative(input, home, dependencies.cwd);
  const { target, config } = loadTarget(dependencies.readConfig);
  const link = dependencies.createLink(target);
  const box = boxSide(link);
  const integrations = dependencies.integrations.filter((integration) => config.integrations?.[integration.id] === true);
  // An integration service runs on the box. A move to this machine registers nothing.
  const registered = input.fromBox ? [] : integrations;
  const local = localSide(home, dependencies.platform);
  const [source, destination] = input.fromBox ? [box, local] : [local, box];
  const sourcePath = `${source.home}/${quoteShell(rel)}`;
  const destinationPath = `${destination.home}/${quoteShell(rel)}`;
  const writeLine = dependencies.writeLine;
  const progress = dependencies.progress;

  progress.plan(input.dryRun ? 1 : (input.remove ? 5 : 4) + registered.length);
  const plan = await step(
    progress,
    "Preflight",
    () => preflight(input, rel, source, sourcePath, destination, destinationPath, input.fromBox ? null : join(home, rel)),
    undefined,
    (plan) =>
      [
        `carry ${plan.carry.length}`,
        `refuse ${plan.refused.length}`,
        `skip ${plan.skipped.length}`,
        plan.problems.length > 0 && plural(plan.problems.length, "problem"),
      ]
        .filter(Boolean)
        .join(", "),
  );
  try {
    writeLine(input.dryRun ? "Move plan (no changes will be made):" : "Move plan:");
    writeLine(`Source: ${source.label} ~/${rel}`);
    writeLine(`Destination: ${destination.label} ~/${rel}`);
    writeLine(
      plan.git
        ? `Clone: ${plan.git.url} ${plan.git.branch ? `at branch ${plan.git.branch}` : "at the default branch"}`
        : "Clone: none, the folder has no git repository; Ferry copies the folder",
    );
    for (const file of plan.carry) writeLine(`Carry: ${file.path}`);
    for (const hit of plan.refused) writeLine(`Refuse: ${hit.path} (${hit.reason})`);
    for (const hit of plan.skipped) writeLine(`Skip: ${hit.path} (${hit.reason})`);
    for (const note of plan.notes) writeLine(`Note: ${note}`);
    for (const problem of plan.problems) writeLine(`Problem: ${problem}`);
    if (plan.problems.length > 0) {
      throw new MoveError(
        `Ferry refused to move ~/${rel}: ${plan.problems.length} ${plan.problems.length === 1 ? "problem" : "problems"}.`,
      );
    }
    if (input.dryRun) return;

    const incomplete = `The copy at ~/${rel} on ${destination.label} is incomplete. Move it away before you try again.`;
    await step(progress, `Cloning on ${destination.label}`, async () => {
      const parent = posix.dirname(rel) === "." ? destination.home : `${destination.home}/${quoteShell(posix.dirname(rel))}`;
      const command = plan.git
        ? `mkdir -p ${parent} && GIT_TERMINAL_PROMPT=0 git clone${plan.git.branch ? ` --branch ${quoteShell(plan.git.branch)}` : ""} -- ${quoteShell(plan.git.url)} ${destinationPath}`
        : `mkdir -p ${destinationPath}`;
      await must(destination.run(command, { timeoutMs: TRANSFER_TIMEOUT_MS }), "The clone failed");
    });

    if (plan.carry.length === 0) {
      progress.skip("Carrying files", "no files to carry");
      progress.skip("Verifying", "no files to carry");
    } else {
      await step(progress, `Carrying ${plan.carry.length} ${plan.carry.length === 1 ? "file" : "files"}`, async () => {
        const archive = await createArchive(plan.stage, plan.carry.map((file) => file.path));
        await must(
          destination.run(`tar -xf - -C ${destinationPath}`, { input: archive, timeoutMs: TRANSFER_TIMEOUT_MS }),
          `Ferry could not carry the files. ${incomplete}`,
        );
      });
      await step(progress, "Verifying", async () => {
        const mismatched = await verify(destination, destinationPath, plan.carry);
        if (mismatched.length > 0) {
          throw new MoveError(
            `The checksum of ${mismatched.join(", ")} on ${destination.label} does not match. ${incomplete}`,
          );
        }
      });
    }

    let trashLine: string | null = null;
    if (input.remove) {
      const name = `${posix.basename(rel)}-${timestamp(dependencies.now())}`;
      await step(
        progress,
        input.fromBox ? "Moving the box copy to the Ferry trash" : "Moving the local copy to the Trash",
        async () => {
          await must(
            source.run(`mkdir -p ${source.trash} && mv -- ${sourcePath} ${source.trash}/${quoteShell(name)}`),
            "Ferry could not move the source copy to the trash",
          );
        },
      );
      trashLine = `Trash: moved the source copy to ${source.trash.replace(source.home, "~")}/${name}`;
    }

    const warnings: string[] = [];
    for (const integration of registered) {
      progress.start(`Registering the project in ${integration.name}`);
      try {
        await integration.onProjectMoved(link, `~/${rel}`);
        progress.done();
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        progress.fail(message);
        warnings.push(
          `WARNING: Ferry could not register ~/${rel} in ${integration.name}: ${message}. The move is complete.`,
        );
      }
    }

    if (trashLine) writeLine(trashLine);
    writeLine(
      `Moved ~/${rel} to ${destination.label}: carried ${plan.carry.length}, refused ${plan.refused.length}, skipped ${plan.skipped.length}.`,
    );
    for (const warning of warnings) writeLine(warning);
    if (input.remove) {
      for (const integration of integrations) writeLine(SOURCE_HINTS[integration.id](`~/${rel}`, source.label));
    }
  } finally {
    if (input.fromBox) rmSync(plan.stage, { recursive: true, force: true });
  }
}

/** The project path relative to the home. Ferry refuses a path outside the home. */
function homeRelative(input: MoveInput, home: string, cwd: string): string {
  let path = resolve(cwd, input.path);
  if (!input.fromBox) {
    if (!existsSync(path)) throw new MoveError(`${path} does not exist.`);
    path = realpathSync(path);
  }
  const rel = relative(home, path);
  if (rel === "" || rel === ".." || rel.startsWith("../") || isAbsolute(rel)) {
    throw new MoveError(`${path} is not inside the home directory ${home}. Ferry moves only folders inside the home.`);
  }
  return rel.split("\\").join("/");
}

async function preflight(
  input: MoveInput,
  rel: string,
  source: Side,
  sourcePath: string,
  destination: Side,
  destinationPath: string,
  localSource: string | null,
): Promise<Plan> {
  const problems: string[] = [];
  const notes: string[] = [];

  const kind = await must(
    source.run(
      `if [ ! -d ${sourcePath} ]; then echo missing; elif cd ${sourcePath} && git rev-parse --is-inside-work-tree >/dev/null 2>&1; then echo git; git rev-parse --show-prefix; else echo plain; fi`,
      { timeoutMs: PROBE_TIMEOUT_MS },
    ),
    `Ferry could not read ~/${rel} on ${source.label}`,
  );
  const [shape, prefix] = kind.split("\n");
  if (shape === "missing") throw new MoveError(`~/${rel} does not exist on ${source.label}.`);
  if (shape === "git" && prefix) {
    throw new MoveError(`~/${rel} is inside a git repository. Move the repository root.`);
  }

  const exists = await must(
    destination.run(`if [ -e ${destinationPath} ] || [ -L ${destinationPath} ]; then echo exists; fi`, {
      timeoutMs: PROBE_TIMEOUT_MS,
    }),
    `Ferry could not read ~/${rel} on ${destination.label}`,
  );
  if (exists.includes("exists")) problems.push(`~/${rel} already exists on ${destination.label}.`);

  const git = shape === "git" ? await gitPreflight(source, sourcePath, problems, notes) : null;

  const listed = await must(
    source.run(`cd ${sourcePath} && ${shape === "git" ? GIT_LIST : FIND_LIST}`, { timeoutMs: PROBE_TIMEOUT_MS }),
    `Ferry could not list the files of ~/${rel} on ${source.label}`,
  );
  const [candidates = "", skippedList = ""] = listed.split(`\0${SECTION}\0`);
  const skipped: Hit[] = entries(skippedList).map((path) => ({
    path: path.replace(/\/$/, ""),
    code: "skip",
    reason: "build output, cache, IDE state, or macOS metadata",
  }));

  const refused: Hit[] = [];
  const wanted: string[] = [];
  for (const path of entries(candidates)) {
    if (path.endsWith("/")) {
      refused.push({ path: path.slice(0, -1), code: "nested-repository", reason: "nested git repository" });
      continue;
    }
    const hit = carriedNameHit(path, { allowEnv: input.includeEnv });
    if (hit) refused.push(hit);
    else wanted.push(path);
  }

  const stage = localSource ?? (await fetchFiles(source, sourcePath, wanted));
  const carry: Carried[] = [];
  for (const path of wanted) {
    const full = join(stage, path);
    let stat;
    try {
      stat = lstatSync(full);
    } catch {
      refused.push({ path, code: "missing", reason: "file changed during the preflight" });
      continue;
    }
    if (stat.isSymbolicLink()) {
      refused.push({ path, code: "symlink", reason: "symbolic link" });
      continue;
    }
    if (!stat.isFile()) {
      refused.push({ path, code: "not-a-file", reason: "not a regular file" });
      continue;
    }
    const bytes = readFileSync(full);
    const hits = carriedContentHits(path, bytes);
    if (hits.length > 0) refused.push(...hits);
    else carry.push({ path, sha256: createHash("sha256").update(bytes).digest("hex") });
  }

  if (input.remove && refused.length > 0) {
    problems.push(
      `--remove needs every local-only file carried, and Ferry refuses ${refused.length}. Move them by hand or leave out --remove.`,
    );
  }
  return { git, carry, refused, skipped, notes, problems, stage };
}

async function gitPreflight(source: Side, path: string, problems: string[], notes: string[]): Promise<GitSource | null> {
  const origin = await source.run(`cd ${path} && git remote get-url origin`, { timeoutMs: PROBE_TIMEOUT_MS });
  if (!origin.ok) {
    problems.push("The repository has no origin remote.");
    return null;
  }
  const url = origin.stdout.trim();

  const remote = await source.run(
    `cd ${path} && git ls-remote --symref origin HEAD && git ls-remote --heads --tags origin`,
    { timeoutMs: NETWORK_TIMEOUT_MS },
  );
  if (!remote.ok) {
    problems.push(`Ferry could not read origin: ${remote.message}`);
    return null;
  }
  const remoteShas = new Set<string>();
  const remoteBranches = new Set<string>();
  let defaultSha: string | null = null;
  for (const line of remote.stdout.split("\n")) {
    const [sha, ref] = line.split("\t");
    if (!sha || !ref || sha.startsWith("ref:")) continue;
    remoteShas.add(sha);
    if (ref === "HEAD") defaultSha = sha;
    if (ref.startsWith("refs/heads/")) remoteBranches.add(ref.slice("refs/heads/".length));
  }

  const state = await must(
    source.run(
      `cd ${path} && git status --porcelain --untracked-files=no && echo ${SECTION} && git stash list --format='%gd %s' && echo ${SECTION} && (git symbolic-ref -q --short HEAD || true)`,
      { timeoutMs: PROBE_TIMEOUT_MS },
    ),
    "Ferry could not read the git state",
  );
  const [changes = "", stashes = "", head = ""] = state.split(`${SECTION}\n`);
  for (const change of lines(changes)) problems.push(`Uncommitted change: ${change.trim()}. Commit or stash it.`);
  for (const stash of lines(stashes)) notes.push(`Stash ${stash} stays in the source copy. The clone does not have it.`);

  const log = await must(
    source.run(`cd ${path} && git log --topo-order --ignore-missing --stdin --branches HEAD --format='%H%x09%S%x09%s'`, {
      input: new TextEncoder().encode([...remoteShas].map((sha) => `^${sha}\n`).join("")),
      timeoutMs: PROBE_TIMEOUT_MS,
    }),
    "Ferry could not list the local commits",
  );
  const unpushed = new Map<string, { sha: string; subject: string }[]>();
  for (const line of lines(log)) {
    const [sha = "", ref = "", ...subject] = line.split("\t");
    const commits = unpushed.get(ref) ?? [];
    commits.push({ sha, subject: subject.join("\t") });
    unpushed.set(ref, commits);
  }
  // A commit that is not on origin passes when git cherry finds an equivalent patch on the default branch of
  // origin, when git merge-tree shows that the default branch has its changes (a squash merge), or when gh
  // finds a merged pull request with the branch tip as its head.
  let mergeTreeUnused = false;
  let ghUnused = false;
  for (const [ref, commits] of unpushed) {
    const cherry = defaultSha
      ? await source.run(`cd ${path} && git cherry ${defaultSha} ${quoteShell(ref)}`, { timeoutMs: PROBE_TIMEOUT_MS })
      : null;
    const equivalent = new Set(
      cherry?.ok ? lines(cherry.stdout).filter((line) => line.startsWith("- ")).map((line) => line.slice(2)) : [],
    );
    let left = commits.filter((commit) => !equivalent.has(commit.sha));
    const accepted: [number, string][] = [[commits.length - left.length, "git cherry finds an equivalent patch on origin"]];
    if (defaultSha && left.length > 0) {
      const merged = await mergedCommits(source, path, defaultSha, commits, remoteShas);
      if (merged === null) mergeTreeUnused = true;
      else {
        const count = left.length;
        left = left.filter((commit) => !merged.has(commit.sha));
        accepted.push([count - left.length, "git merge-tree shows that the default branch of origin has their changes"]);
      }
    }
    if (left.length > 0 && !ghUnused) {
      const pull = await mergedPull(source, path, url, ref);
      if (pull === null) ghUnused = true;
      else if (pull !== undefined) {
        accepted.push([left.length, `gh finds merged pull request #${pull} with the branch tip as its head`]);
        left = [];
      }
    }
    for (const [count, reason] of accepted) {
      if (count === 0) continue;
      notes.push(
        `Branch ${ref}: Ferry accepts ${count} ${count === 1 ? "commit that is" : "commits that are"} not on origin, because ${reason}.`,
      );
    }
    for (const commit of left) {
      const name = `${commit.sha.slice(0, 12)} "${commit.subject}"`;
      problems.push(`Branch ${ref} has commit ${name} that is not on origin. Push it. If an equivalent patch is on origin, run git fetch first.`);
    }
  }
  if (mergeTreeUnused) {
    notes.push(
      "Ferry could not compare branches with git merge-tree. It needs git 2.38 or later and the commit of the default branch of origin. Run git fetch.",
    );
  }
  if (ghUnused) notes.push("gh is missing or cannot read origin, so Ferry did not look for merged pull requests.");

  const branch = head.trim();
  if (branch && remoteBranches.has(branch)) return { url, branch };
  notes.push(
    branch
      ? `Branch ${branch} is not on origin. The clone uses the default branch.`
      : "HEAD is detached. The clone uses the default branch.",
  );
  return { url, branch: null };
}

/**
 * The commits not on origin that the default branch of origin already has: the ancestors of the newest
 * commit in `commits` that merges into `defaultSha` with no change to its tree. Null if git cannot do the
 * check, for example a git before 2.38 or no local copy of `defaultSha`.
 *
 * `git merge-tree --write-tree` writes the merged objects. The preflight must not write to the repository,
 * so git writes them to a temporary object directory and reads the repository objects as alternates.
 */
async function mergedCommits(
  source: Side,
  path: string,
  defaultSha: string,
  commits: readonly { sha: string }[],
  remoteShas: ReadonlySet<string>,
): Promise<Set<string> | null> {
  const base = quoteShell(defaultSha);
  const script = [
    `cd ${path} || exit 1`,
    "objects=$(git rev-parse --path-format=absolute --git-path objects) || { echo unavailable; exit 0; }",
    `tmp=$(mktemp -d) || exit 1`,
    `trap 'rm -rf "$tmp"' EXIT`,
    `export GIT_OBJECT_DIRECTORY="$tmp" GIT_ALTERNATE_OBJECT_DIRECTORIES="$objects"`,
    `want=$(git rev-parse --verify -q ${base}^{tree}) || { echo unavailable; exit 0; }`,
    `for c in ${commits.map((commit) => commit.sha).join(" ")}; do`,
    `  tree=$(git merge-tree --write-tree ${base} "$c" 2>/dev/null)`,
    "  case $? in",
    `    0) if [ "$tree" = "$want" ]; then git rev-list --ignore-missing --stdin "$c"; exit; fi ;;`,
    "    1) ;;",
    "    *) echo unavailable; exit 0 ;;",
    "  esac",
    "done",
  ].join("\n");
  const result = await source.run(script, {
    input: new TextEncoder().encode([...remoteShas].map((sha) => `^${sha}\n`).join("")),
    timeoutMs: PROBE_TIMEOUT_MS,
  });
  if (!result.ok || result.stdout.startsWith("unavailable")) return null;
  return new Set(lines(result.stdout));
}

/**
 * The number of a merged pull request whose head is the tip of `ref`, or undefined if gh finds none. Null if
 * gh is missing, cannot read origin, or does not answer in time.
 */
async function mergedPull(source: Side, path: string, url: string, ref: string): Promise<number | null | undefined> {
  const result = await source.run(
    `cd ${path} && tip=$(git rev-parse --verify ${quoteShell(`${ref}^{commit}`)}) && echo "$tip" && GH_PROMPT_DISABLED=1 gh pr list -R ${quoteShell(url)} --state merged --search "$tip" --json number,headRefOid`,
    { timeoutMs: GH_TIMEOUT_MS },
  );
  if (!result.ok) return null;
  const [tip, ...json] = result.stdout.split("\n");
  try {
    const pulls = JSON.parse(json.join("\n")) as { number: number; headRefOid: string }[];
    return pulls.find((pull) => pull.headRefOid === tip)?.number;
  } catch {
    return null;
  }
}

const X_SKIPPED = SKIPPED_NAMES.map((name) => `-x ${quoteShell(name)}`).join(" ");
const FIND_SKIPPED = `\\( ${SKIPPED_NAMES.map((name) => `-name ${quoteShell(name)}`).join(" -o ")} \\)`;
/**
 * The untracked and ignored files, then the skipped entries. Without
 * `--exclude-standard`, only the skip list excludes a file. An entry that ends
 * in `/` is a nested git repository.
 */
const GIT_LIST = `git ls-files -z --others ${X_SKIPPED} && printf '\\0${SECTION}\\0' && git ls-files -z --others --ignored --directory ${X_SKIPPED}`;
const FIND_LIST = `find . ${FIND_SKIPPED} -prune -o ! -type d -print0 && printf '\\0${SECTION}\\0' && find . -mindepth 1 ${FIND_SKIPPED} -prune -print0`;

/** Copy `paths` from the box into a local temporary directory for the deny checks. */
async function fetchFiles(source: Side, path: string, paths: readonly string[]): Promise<string> {
  const stage = mkdtempSync(join(tmpdir(), "ferry-move-"));
  if (paths.length === 0) return stage;
  try {
    const encoded = await must(
      source.run(`cd ${path} && tar --null -cf - -T - | base64`, {
        input: nulList(paths),
        timeoutMs: TRANSFER_TIMEOUT_MS,
      }),
      "Ferry could not read the local-only files on the box",
    );
    const extracted = await exec(["tar", "-xf", "-", "-C", stage], { input: Buffer.from(encoded, "base64") });
    if (extracted.exitCode !== 0) throw new MoveError(`Ferry could not unpack the box files: ${extracted.stderr.trim()}`);
  } catch (error) {
    rmSync(stage, { recursive: true, force: true });
    throw error;
  }
  return stage;
}

/**
 * A tar archive of `paths` under `stage`. `COPYFILE_DISABLE` and `--no-xattrs`
 * keep macOS tar from adding `._*` AppleDouble entries and extended attributes.
 */
async function createArchive(stage: string, paths: readonly string[]): Promise<Uint8Array> {
  const result = await exec(["tar", "--null", "--no-xattrs", "-cf", "-", "-C", stage, "-T", "-"], {
    input: nulList(paths),
    env: { COPYFILE_DISABLE: "1" },
  });
  if (result.exitCode !== 0) throw new MoveError(`Ferry could not pack the files: ${result.stderr.trim()}`);
  return result.stdout;
}

/** The carried paths whose SHA-256 on the destination differs from the checked bytes. */
async function verify(destination: Side, path: string, carry: readonly Carried[]): Promise<string[]> {
  const output = await must(
    destination.run(
      `cd ${path} && if command -v sha256sum >/dev/null 2>&1; then xargs -0 sha256sum --; else xargs -0 shasum -a 256 --; fi`,
      { input: nulList(carry.map((file) => file.path)), timeoutMs: TRANSFER_TIMEOUT_MS },
    ),
    `Ferry could not compute checksums on ${destination.label}`,
  );
  // Both tools print one line for each file in input order. An escaped name starts with `\`.
  const sums = lines(output).map((line) => line.replace(/^\\/, "").slice(0, 64));
  return carry.filter((file, index) => sums[index] !== file.sha256).map((file) => file.path);
}

function boxSide(link: Pick<Link, "run">): Side {
  return {
    label: "the box",
    home: '"$HOME"',
    trash: '"$HOME"/.ferry/trash',
    async run(command, options = {}) {
      const result = await link.run(command, options);
      return result.ok ? { ok: true, stdout: result.stdout } : { ok: false, message: result.error.message };
    },
  };
}

function localSide(home: string, platform: NodeJS.Platform): Side {
  const quoted = quoteShell(home);
  return {
    label: "this machine",
    home: quoted,
    trash: platform === "darwin" ? `${quoted}/.Trash` : `${quoted}/.ferry/trash`,
    async run(command, options = {}) {
      const result = await exec(["sh", "-c", command], options);
      if (result.timedOut) return { ok: false, message: "the command timed out" };
      const stdout = Buffer.from(result.stdout).toString("utf8");
      if (result.exitCode === 0) return { ok: true, stdout };
      return { ok: false, message: result.stderr.trim() || stdout.trim() || `the command exited with ${result.exitCode}` };
    },
  };
}

type ExecResult = { exitCode: number | null; stdout: Uint8Array; stderr: string; timedOut: boolean };

/** Run a local command with binary stdout. */
async function exec(
  argv: readonly string[],
  options: { readonly input?: Uint8Array; readonly env?: Record<string, string>; readonly timeoutMs?: number } = {},
): Promise<ExecResult> {
  const child = Bun.spawn([...argv], {
    stdin: options.input ?? "ignore",
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env, ...options.env },
  });
  const stdout = new Response(child.stdout).bytes();
  const stderr = new Response(child.stderr).text();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<"timeout">((done) => {
    timer = setTimeout(() => done("timeout"), options.timeoutMs ?? TRANSFER_TIMEOUT_MS);
  });
  const settled = await Promise.race([child.exited, timeout]);
  if (timer) clearTimeout(timer);
  if (settled === "timeout") child.kill();
  return {
    exitCode: settled === "timeout" ? null : settled,
    stdout: await stdout,
    stderr: await stderr,
    timedOut: settled === "timeout",
  };
}

async function must(result: Promise<SideResult>, context: string): Promise<string> {
  const settled = await result;
  if (!settled.ok) throw new MoveError(`${context}: ${settled.message}`);
  return settled.stdout;
}

function loadTarget(read: () => PartialOperatorConfig | null): {
  readonly target: LinkOptions;
  readonly config: PartialOperatorConfig;
} {
  let config: PartialOperatorConfig | null;
  try {
    config = read();
  } catch {
    throw new MoveError("Could not read Ferry config. Run ferry init.");
  }
  const target = resolveLinkOptions(config?.host);
  if (!config || !target) throw new MoveError("Ferry config has no complete host. Run ferry init.");
  return { target, config };
}

function defaultDependencies(): MoveDependencies {
  return {
    readConfig,
    createLink: (options) => new Link(options),
    home: homedir(),
    cwd: process.cwd(),
    platform: process.platform,
    now: () => new Date(),
    writeLine: console.log,
    progress: noProgress,
    integrations: INTEGRATIONS,
  };
}

function entries(list: string): string[] {
  return list.split("\0").filter((entry) => entry !== "").map((entry) => entry.replace(/^\.\//, ""));
}

function lines(text: string): string[] {
  return text.split("\n").filter((line) => line.trim() !== "");
}

function nulList(paths: readonly string[]): Uint8Array {
  return new TextEncoder().encode(paths.map((path) => `${path}\0`).join(""));
}

function timestamp(date: Date): string {
  return date.toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z");
}

function quoteShell(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}
