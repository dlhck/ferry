/**
 * A participating checkout, and the proof that Ferry wrote nothing into it.
 *
 * Design 11.1: Ferry writes nothing into a participating checkout or its Git
 * metadata. Each integration test makes a checkout with `createCheckout`, takes a
 * `treeState` of it before the run and after the run, and asserts that
 * `changedPaths` is empty.
 *
 * The state covers each entry under the root: the main worktree, its `.git`
 * directory, the linked worktree, and ignored files. For each file it records the
 * mode, the size, the modification time, and a SHA-256 of the content. A rewrite
 * with the same content changes the modification time, so it shows too.
 */

import { createHash } from "node:crypto";
import { lstatSync, mkdirSync, readdirSync, readFileSync, readlinkSync, realpathSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";

export type Checkout = {
  /** The directory that holds both worktrees. Hash this directory. */
  readonly root: string;
  /** The main worktree. Its `.git` is a directory. */
  readonly main: string;
  /** A linked worktree of the same repository, on `branch`. */
  readonly linked: string;
  readonly branch: string;
  /** The remote URL of `origin`. */
  readonly remoteUrl: string;
  /** The project key that the URL normalizes to (design 4.2). */
  readonly key: string;
  /** A file that `.gitignore` ignores, in the main worktree. */
  readonly ignoredFile: string;
};

export type CheckoutOptions = {
  /** Default `git@github.com:acme/app.git`. */
  readonly remoteUrl?: string;
  /** Default `github.com/acme/app`. Give it with a non-default `remoteUrl`. */
  readonly key?: string;
  /** The branch of the linked worktree. Default `feat/clo-1442-example`. */
  readonly branch?: string;
  /** More remotes, by name. */
  readonly remotes?: Readonly<Record<string, string>>;
};

/** The environment of each Git command of the harness: no user or system config, fixed identity. */
export const GIT_ENV: Readonly<Record<string, string>> = {
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_AUTHOR_NAME: "Example",
  GIT_AUTHOR_EMAIL: "operator@example.com",
  GIT_COMMITTER_NAME: "Example",
  GIT_COMMITTER_EMAIL: "operator@example.com",
};

export function git(cwd: string, ...args: string[]): string {
  const result = Bun.spawnSync(["git", ...args], {
    cwd,
    env: { ...process.env, ...GIT_ENV },
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  if (result.exitCode !== 0) throw new Error(`git ${args.join(" ")} failed in ${cwd}: ${result.stderr.toString().trim()}`);
  return result.stdout.toString().trim();
}

/** Makes a repository with one commit, a GitHub `origin`, a linked worktree, and an ignored file, under `parent`. */
export function createCheckout(parent: string, options: CheckoutOptions = {}): Checkout {
  const root = join(realpathSync(parent), "checkout");
  const main = join(root, "app");
  const linked = join(root, "app-linked");
  const remoteUrl = options.remoteUrl ?? "git@github.com:acme/app.git";
  const key = options.key ?? "github.com/acme/app";
  const branch = options.branch ?? "feat/clo-1442-example";
  mkdirSync(main, { recursive: true });

  git(main, "init", "-q", "-b", "main");
  writeFileSync(join(main, "README.md"), "# app\n");
  writeFileSync(join(main, ".gitignore"), "*.local\n");
  git(main, "add", "README.md", ".gitignore");
  git(main, "commit", "-q", "-m", "initial");
  git(main, "remote", "add", "origin", remoteUrl);
  for (const [name, url] of Object.entries(options.remotes ?? {})) git(main, "remote", "add", name, url);
  git(main, "worktree", "add", "-q", "-b", branch, linked);

  const ignoredFile = join(main, "notes.local");
  writeFileSync(ignoredFile, "ignored by .gitignore\n");
  return { root, main, linked, branch, remoteUrl, key, ignoredFile };
}

export type TreeState = {
  /** SHA-256 over all entries. Equal hashes mean an equal tree. */
  readonly hash: string;
  /** One line for each entry, keyed by the path relative to the root. */
  readonly entries: ReadonlyMap<string, string>;
};

/** Records each entry under `root`, `.git` and ignored files included. */
export function treeState(root: string): TreeState {
  const entries = new Map<string, string>();
  walk(root, root, entries);
  const hash = createHash("sha256");
  for (const path of [...entries.keys()].sort()) hash.update(`${path}\0${entries.get(path)}\n`);
  return { hash: hash.digest("hex"), entries };
}

/** The paths that were added, removed, or changed between two states, sorted. */
export function changedPaths(before: TreeState, after: TreeState): string[] {
  const changed = new Set<string>();
  for (const [path, entry] of before.entries) if (after.entries.get(path) !== entry) changed.add(path);
  for (const path of after.entries.keys()) if (!before.entries.has(path)) changed.add(path);
  return [...changed].sort();
}

function walk(root: string, dir: string, entries: Map<string, string>): void {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    const rel = relative(root, path);
    const stat = lstatSync(path);
    const mode = (stat.mode & 0o7777).toString(8);
    if (stat.isDirectory()) {
      entries.set(rel, `dir ${mode}`);
      walk(root, path, entries);
    } else if (stat.isSymbolicLink()) {
      entries.set(rel, `link ${readlinkSync(path)}`);
    } else if (stat.isFile()) {
      const sha = createHash("sha256").update(readFileSync(path)).digest("hex");
      entries.set(rel, `file ${mode} ${stat.size} ${stat.mtimeMs} ${sha}`);
    } else {
      // A socket or a FIFO in a checkout is a change by itself.
      entries.set(rel, `other ${mode}`);
    }
  }
}
