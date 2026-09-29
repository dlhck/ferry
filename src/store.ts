/**
 * Store owns the private snapshot checkout and its tracked layout.
 *
 * Git execution sits behind GitRunner. Callers provide a Seed, not paths to
 * stage, so only skills, extra roots, carried settings keys, AGENTS.md, and
 * ferry.json enter snapshot commits.
 */

import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { Seed, SeedFile } from "./manifest.ts";
import type { HarnessDescriptor } from "./registry/types.ts";

const STORE_DIRECTORY = ".ferry/store";
const DEFAULT_COMMIT_MESSAGE = "chore: update ferry snapshot";
const METADATA_FILE = "ferry.json";
/** The paths that a publish writes. */
const PUBLISHED = ["skills", "roots", "settings", "AGENTS.md", METADATA_FILE];
/** Version 2 records a harness descriptor. Version 1 recorded a bare id. */
const SCHEMA_VERSION = 2;

export type GitInvocation = {
  readonly args: readonly string[];
  readonly cwd?: string;
};

export type GitResult = {
  readonly status: number;
  readonly stdout: Uint8Array;
  readonly stderr: Uint8Array;
};

export interface GitRunner {
  run(invocation: GitInvocation): Promise<GitResult>;
}

export class RealGitRunner implements GitRunner {
  async run(invocation: GitInvocation): Promise<GitResult> {
    const process = Bun.spawn(["git", ...invocation.args], {
      cwd: invocation.cwd,
      stdout: "pipe",
      stderr: "pipe",
    });
    const [status, stdout, stderr] = await Promise.all([
      process.exited,
      new Response(process.stdout).arrayBuffer(),
      new Response(process.stderr).arrayBuffer(),
    ]);
    return {
      status,
      stdout: new Uint8Array(stdout),
      stderr: new Uint8Array(stderr),
    };
  }
}

export type StoreRefusalCode =
  | "remote-clash"
  | "missing-git-identity"
  | "unreadable-store"
  | "schema-mismatch"
  | "unknown-commit";

export class StoreRefusal extends Error {
  constructor(
    readonly code: StoreRefusalCode,
    message: string,
    readonly paths: readonly string[] = [],
  ) {
    super(message);
    this.name = "StoreRefusal";
  }
}

export class GitCommandError extends Error {
  constructor(
    readonly args: readonly string[],
    readonly status: number,
    readonly stderr: string,
  ) {
    super(`git ${args.join(" ")} failed with status ${status}`);
    this.name = "GitCommandError";
  }
}

export type PublishResult = {
  readonly published: boolean;
  readonly tip: string | null;
};

/** One snapshot commit and the paths it changed. */
export type HistoryEntry = {
  readonly commit: string;
  readonly date: string;
  readonly subject: string;
  readonly paths: readonly string[];
};

/**
 * The result of a revert of `commit` onto the local tip. `tree` is the
 * snapshot without the commit. `conflicts` names the paths that later
 * commits also changed.
 */
export type RevertPlan =
  | {
      readonly ok: true;
      readonly commit: string;
      readonly subject: string;
      readonly base: string;
      readonly tree: string;
      readonly paths: readonly string[];
    }
  | { readonly ok: false; readonly commit: string; readonly conflicts: readonly string[] };

export type TipReport = {
  readonly local: string | null;
  readonly remote: string | null;
  readonly box: string | null;
  readonly localMatchesRemote: boolean;
  readonly remoteMatchesBox: boolean;
  readonly allMatch: boolean;
};

export type OpenStoreOptions = {
  /** The managed harnesses. The store records their descriptors in ferry.json. */
  readonly harnesses: readonly HarnessDescriptor[];
  readonly git?: GitRunner;
  /** Source home. The checkout remains at the locked `.ferry/store` path below it. */
  readonly home?: string;
};

export async function openStore(
  remote: string,
  seed: Seed,
  options: OpenStoreOptions,
): Promise<Store> {
  const git = options.git ?? new RealGitRunner();
  const path = join(options.home ?? homedir(), STORE_DIRECTORY);
  const metadata = storeMetadata(options.harnesses);
  const freshClone = !existsSync(join(path, ".git"));

  if (freshClone) {
    mkdirSync(dirname(path), { recursive: true });
    await checked(git, ["clone", remote, path]);
    const tip = await optionalTip(git, path, "HEAD");
    if (tip) await refuseRemoteClash(git, path, tip, seed, metadata);
  }
  refuseUnusableStore(path);

  return new Store(git, path, metadata);
}

export class Store {
  constructor(
    private readonly git: GitRunner,
    readonly path: string,
    private readonly metadata: string,
  ) {}

  async publish(seed: Seed, message = DEFAULT_COMMIT_MESSAGE): Promise<PublishResult> {
    const identity = await this.readIdentity();
    writeSeed(this.path, seed, this.metadata);

    await checked(
      this.git,
      ["add", "-A", "--", ...PUBLISHED],
      this.path,
    );
    const diff = await this.git.run({ args: ["diff", "--cached", "--quiet", "--"], cwd: this.path });
    if (diff.status === 0) return { published: false, tip: await this.localTip() };
    if (diff.status !== 1) throw commandError(["diff", "--cached", "--quiet", "--"], diff);

    await checked(
      this.git,
      [
        "-c",
        `user.name=${identity.name}`,
        "-c",
        `user.email=${identity.email}`,
        "commit",
        "-m",
        message,
        "--",
      ],
      this.path,
    );
    await checked(this.git, ["push", "origin", "HEAD"], this.path);
    return { published: true, tip: await this.localTip() };
  }

  async fetchTip(): Promise<string | null> {
    await checked(this.git, ["fetch", "origin"], this.path);
    return optionalTip(this.git, this.path, "FETCH_HEAD");
  }

  async compareTips(box: string | null): Promise<TipReport> {
    const local = await this.localTip();
    const remote = await this.fetchTip();
    return tipReport(local, remote, box);
  }

  /** Read local and remote tips without fetching or changing git refs. */
  async inspectTips(box: string | null): Promise<TipReport> {
    const local = await this.localTip();
    const remote = await remoteTip(this.git, this.path);
    return tipReport(local, remote, box);
  }

  /**
   * The seed paths whose bytes or executable bit differ from the local tip.
   * An empty list means that a publish of `seed` changes nothing.
   */
  async unpublished(seed: Seed): Promise<string[]> {
    const tip = await this.localTip();
    const tracked = new Map<string, { mode: string; blob: string }>();
    if (tip) {
      const listed = await checked(this.git, ["ls-tree", "-r", "-z", tip], this.path);
      for (const entry of decode(listed.stdout).split("\0").filter(Boolean)) {
        const tab = entry.indexOf("\t");
        const path = entry.slice(tab + 1);
        const [mode = "", , blob = ""] = entry.slice(0, tab).split(" ");
        // Publish writes only the seed layout, so other tracked files stay as they are.
        if (PUBLISHED.some((top) => path === top || path.startsWith(`${top}/`))) tracked.set(path, { mode, blob });
      }
    }
    const changed = new Set<string>();
    for (const [path, file] of seedEntries(seed, this.metadata)) {
      const entry = tracked.get(path);
      tracked.delete(path);
      const mode = file.executable ? "100755" : "100644";
      if (!entry || entry.mode !== mode || entry.blob !== blobId(file.bytes)) changed.add(path);
    }
    for (const path of tracked.keys()) changed.add(path);
    return [...changed].sort(compare);
  }

  /**
   * Plan a revert of one commit of the local history, as `git revert` does.
   * The plan changes no file and no ref.
   */
  async planRevert(ref: string): Promise<RevertPlan> {
    const resolved = await this.git.run({
      args: ["rev-parse", "--verify", "--quiet", `${ref}^{commit}`],
      cwd: this.path,
    });
    const commit = decode(resolved.stdout).trim();
    if (resolved.status !== 0 || !commit) {
      throw new StoreRefusal("unknown-commit", `${ref} is not a commit of the snapshot`);
    }
    const ancestor = await this.git.run({ args: ["merge-base", "--is-ancestor", commit, "HEAD"], cwd: this.path });
    if (ancestor.status === 1) {
      throw new StoreRefusal("unknown-commit", `${ref} is not in the history of the snapshot`);
    }
    if (ancestor.status !== 0) throw commandError(["merge-base", "--is-ancestor", commit, "HEAD"], ancestor);

    const listed = await checked(this.git, ["rev-list", "--parents", "-n", "1", commit], this.path);
    const parents = decode(listed.stdout).trim().split(" ").slice(1);
    if (parents.length !== 1) {
      throw new StoreRefusal(
        "unknown-commit",
        parents.length === 0
          ? `${ref} is the first snapshot commit; Ferry cannot revert it`
          : `${ref} is a merge commit; Ferry cannot revert it`,
      );
    }
    const subject = decode((await checked(this.git, ["log", "-n", "1", "--format=%s", commit], this.path)).stdout).trim();

    // A revert is a merge of the parent into HEAD, with the commit as the merge base.
    const args = ["merge-tree", "--write-tree", "--name-only", "--no-messages", `--merge-base=${commit}`, "HEAD", `${commit}^`];
    const merged = await this.git.run({ args, cwd: this.path });
    const [tree = "", ...rest] = decode(merged.stdout).split("\n");
    if (merged.status === 1) {
      return { ok: false, commit, conflicts: [...new Set(rest.filter(Boolean))].sort(compare) };
    }
    if (merged.status !== 0) throw commandError(args, merged);
    const base = decode((await checked(this.git, ["rev-parse", "HEAD"], this.path)).stdout).trim();
    const diff = await checked(this.git, ["diff", "--name-only", "-z", base, tree], this.path);
    const paths = decode(diff.stdout).split("\0").filter(Boolean).sort(compare);
    return { ok: true, commit, subject, base, tree, paths };
  }

  /** The bytes of `path` in a commit or tree, or null when it has no such file. */
  async readFile(treeish: string, path: string): Promise<Uint8Array | null> {
    const result = await this.git.run({ args: ["cat-file", "blob", `${treeish}:${path}`], cwd: this.path });
    return result.status === 0 ? result.stdout : null;
  }

  /**
   * Commit the tree of a revert plan on the local tip and move the checkout
   * to it. The local files that link into the checkout change with it.
   * Return the new tip. `push` publishes it.
   */
  async commitRevert(plan: Extract<RevertPlan, { ok: true }>): Promise<string> {
    const identity = await this.readIdentity();
    const message = `revert: ${plan.subject}\n\nThis reverts commit ${plan.commit}.\n`;
    const created = await checked(
      this.git,
      [
        "-c",
        `user.name=${identity.name}`,
        "-c",
        `user.email=${identity.email}`,
        "commit-tree",
        plan.tree,
        "-p",
        plan.base,
        "-m",
        message,
      ],
      this.path,
    );
    const tip = decode(created.stdout).trim();
    await checked(this.git, ["merge", "--ff-only", "--quiet", tip], this.path);
    return tip;
  }

  async push(): Promise<void> {
    await checked(this.git, ["push", "origin", "HEAD"], this.path);
  }

  private async localTip(): Promise<string | null> {
    return optionalTip(this.git, this.path, "HEAD");
  }

  private async readIdentity(): Promise<{ name: string; email: string }> {
    const name = await configuredValue(this.git, this.path, "user.name");
    const email = await configuredValue(this.git, this.path, "user.email");
    if (!name || !email) {
      throw new StoreRefusal(
        "missing-git-identity",
        "git user.name and user.email must both be configured",
      );
    }
    return { name, email };
  }
}

function tipReport(local: string | null, remote: string | null, box: string | null): TipReport {
  const localMatchesRemote = local !== null && local === remote;
  const remoteMatchesBox = remote !== null && remote === box;
  return {
    local,
    remote,
    box,
    localMatchesRemote,
    remoteMatchesBox,
    allMatch: localMatchesRemote && remoteMatchesBox,
  };
}

/** The last `limit` commits of the checkout, newest first. A checkout without commits has none. */
export async function readHistory(
  checkout: string,
  limit: number,
  git: GitRunner = new RealGitRunner(),
): Promise<HistoryEntry[]> {
  if (!(await optionalTip(git, checkout, "HEAD"))) return [];
  const result = await checked(
    git,
    ["log", "-n", String(limit), "-z", "--name-only", "--format=%x1e%H%x1f%aI%x1f%s"],
    checkout,
  );
  return decode(result.stdout)
    .split("\x1e")
    .filter(Boolean)
    .map((record) => {
      const [header = "", ...paths] = record.split("\0");
      const [commit = "", date = "", subject = ""] = header.split("\x1f");
      return { commit, date, subject, paths: paths.map((path) => path.replace(/^\n/, "")).filter(Boolean) };
    });
}

/**
 * True when `skills/<name>` in the checkout differs from its last commit, with
 * untracked files counted. The check takes no git lock, so a dry run can use it.
 */
export async function skillChanged(
  checkout: string,
  name: string,
  git: GitRunner = new RealGitRunner(),
): Promise<boolean> {
  const result = await checked(
    git,
    ["--no-optional-locks", "status", "--porcelain", "--untracked-files=all", "--", `skills/${name}`],
    checkout,
  );
  return result.stdout.length > 0;
}

export async function configuredValue(git: GitRunner, cwd: string, key: string): Promise<string | null> {
  const result = await git.run({ args: ["config", "--get", key], cwd });
  if (result.status !== 0) return null;
  return decode(result.stdout).trim() || null;
}

async function optionalTip(git: GitRunner, cwd: string, ref: string): Promise<string | null> {
  const result = await git.run({ args: ["rev-parse", "--verify", ref], cwd });
  if (result.status !== 0) return null;
  return decode(result.stdout).trim() || null;
}

async function remoteTip(git: GitRunner, cwd: string): Promise<string | null> {
  const args = ["ls-remote", "--exit-code", "origin", "HEAD"] as const;
  const result = await git.run({ args, cwd });
  if (result.status === 2) return null;
  if (result.status !== 0) throw commandError(args, result);
  return decode(result.stdout).trim().split(/\s+/, 1)[0] || null;
}

async function refuseRemoteClash(
  git: GitRunner,
  cwd: string,
  tip: string,
  seed: Seed,
  metadata: string,
): Promise<void> {
  const expected = seedFiles(seed, metadata);
  const listed = await checked(git, ["ls-tree", "-r", "--name-only", tip], cwd);
  const remotePaths = decode(listed.stdout)
    .split("\n")
    .filter(Boolean);
  const clashes = new Set<string>();

  for (const path of remotePaths) {
    const expectedBytes = expected.get(path);
    if (!expectedBytes) {
      clashes.add(path);
      continue;
    }
    const shown = await checked(git, ["show", `${tip}:${path}`], cwd);
    if (!Buffer.from(shown.stdout).equals(Buffer.from(expectedBytes))) clashes.add(path);
  }
  for (const path of expected.keys()) {
    if (!remotePaths.includes(path)) clashes.add(path);
  }

  if (clashes.size > 0) {
    const paths = [...clashes].sort(compare);
    throw new StoreRefusal(
      "remote-clash",
      `snapshot remote differs from the seed at: ${paths.join(", ")}`,
      paths,
    );
  }
}

/**
 * The tracked ferry.json. It names the schema version and every managed
 * harness, so a later ferry can refuse a store it does not understand.
 */
function storeMetadata(harnesses: readonly HarnessDescriptor[]): string {
  const managedHarnesses = harnesses.map((harness) => ({
    id: harness.id,
    name: harness.name,
    ...(harness.skillRoot ? { skillRoot: harness.skillRoot } : {}),
    ...(harness.ownSkills === false ? { ownSkills: false } : {}),
    ...(harness.instructionFile ? { instructionFile: harness.instructionFile } : {}),
    ...(harness.extraRoots ? { extraRoots: harness.extraRoots } : {}),
    ...(harness.settings ? { settings: harness.settings } : {}),
  }));
  return `${JSON.stringify({ schemaVersion: SCHEMA_VERSION, managedHarnesses }, null, 2)}\n`;
}

/**
 * Refuse a checkout this ferry does not manage: metadata it cannot read, or a
 * schema version it does not write. A store of another version names other
 * folders, so publishing into it would write the wrong layout.
 */
function refuseUnusableStore(path: string): void {
  const file = join(path, METADATA_FILE);
  if (!existsSync(file)) return;

  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(file, "utf8"));
  } catch {
    parsed = null;
  }
  const metadata = parsed as { schemaVersion?: unknown; managedHarnesses?: unknown } | null;
  if (
    typeof metadata?.schemaVersion !== "number" ||
    !Array.isArray(metadata.managedHarnesses)
  ) {
    throw new StoreRefusal("unreadable-store", `${file} is not readable ferry store metadata`, [
      file,
    ]);
  }
  if (metadata.schemaVersion !== SCHEMA_VERSION) {
    throw new StoreRefusal(
      "schema-mismatch",
      `${file} records store schema version ${metadata.schemaVersion}; this ferry manages version ${SCHEMA_VERSION}`,
      [file],
    );
  }
}

function writeSeed(root: string, seed: Seed, metadata: string): void {
  const skills = join(root, "skills");
  rmSync(skills, { recursive: true, force: true });
  mkdirSync(skills, { recursive: true });

  for (const skill of seed.skills) {
    for (const file of skill.files) {
      const target = join(skills, skill.name, file.path);
      mkdirSync(dirname(target), { recursive: true });
      writeFileSync(target, file.bytes, { mode: fileMode(file) });
    }
  }

  // Each seed root gets a directory, empty or not, so a local link into it never dangles.
  const roots = join(root, "roots");
  rmSync(roots, { recursive: true, force: true });
  mkdirSync(roots, { recursive: true });
  for (const extra of seed.roots) {
    mkdirSync(join(roots, extra.path), { recursive: true });
    for (const file of extra.files) {
      const target = join(roots, extra.path, file.path);
      mkdirSync(dirname(target), { recursive: true });
      writeFileSync(target, file.bytes, { mode: fileMode(file) });
    }
  }

  const settings = join(root, "settings");
  rmSync(settings, { recursive: true, force: true });
  mkdirSync(settings, { recursive: true });
  for (const entry of seed.settings) writeFileSync(join(settings, `${entry.harness}.json`), entry.bytes);

  writeFileSync(join(root, "AGENTS.md"), seed.instructions?.bytes ?? new Uint8Array());
  writeFileSync(join(root, METADATA_FILE), metadata);
}

function fileMode(file: SeedFile): number {
  return file.executable ? 0o755 : 0o644;
}

/** Each tracked path of `seed`, with its bytes and executable bit. */
function seedEntries(seed: Seed, metadata: string): Map<string, { bytes: Uint8Array; executable: boolean }> {
  const files = new Map<string, { bytes: Uint8Array; executable: boolean }>();
  for (const [path, bytes] of seedFiles(seed, metadata)) files.set(path, { bytes, executable: false });
  for (const skill of seed.skills) {
    for (const file of skill.files) files.set(`skills/${skill.name}/${file.path}`, file);
  }
  for (const root of seed.roots) {
    for (const file of root.files) files.set(`roots/${root.path}/${file.path}`, file);
  }
  return files;
}

/** The git blob id of `bytes`. */
function blobId(bytes: Uint8Array): string {
  return createHash("sha1").update(`blob ${bytes.length}\0`).update(bytes).digest("hex");
}

function seedFiles(seed: Seed, metadata: string): Map<string, Uint8Array> {
  const files = new Map<string, Uint8Array>();
  files.set("AGENTS.md", seed.instructions?.bytes ?? new Uint8Array());
  files.set(METADATA_FILE, Buffer.from(metadata));
  for (const skill of seed.skills) {
    for (const file of skill.files) files.set(`skills/${skill.name}/${file.path}`, file.bytes);
  }
  for (const root of seed.roots) {
    for (const file of root.files) files.set(`roots/${root.path}/${file.path}`, file.bytes);
  }
  for (const entry of seed.settings) files.set(`settings/${entry.harness}.json`, entry.bytes);
  return files;
}

async function checked(
  git: GitRunner,
  args: readonly string[],
  cwd?: string,
): Promise<GitResult> {
  const result = await git.run({ args, cwd });
  if (result.status !== 0) throw commandError(args, result);
  return result;
}

function commandError(args: readonly string[], result: GitResult): GitCommandError {
  return new GitCommandError(args, result.status, decode(result.stderr).trim());
}

function decode(bytes: Uint8Array): string {
  return new TextDecoder().decode(bytes);
}

function compare(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}
