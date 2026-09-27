/** Convert newly published local skill and extra root directories into managed links. */

import {
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  realpathSync,
  renameSync,
  rmSync,
  symlinkSync,
  unlinkSync,
} from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { CODEX_SYSTEM_SKILLS, type Seed } from "./manifest.ts";
import type { HarnessDescriptor } from "./registry/types.ts";

export class AdoptionRefusal extends Error {
  constructor(readonly path: string) {
    super(`local skill changed after publication: ${path}`);
    this.name = "AdoptionRefusal";
  }
}

/** Adopt only live directories whose complete file set matches the store. */
export function adoptPublishedSkills(
  home: string,
  store: string,
  harnesses: readonly HarnessDescriptor[],
  seed: Seed,
): void {
  for (const harness of harnesses) {
    if (!harness.skillRoot) continue;
    for (const skill of seed.skills) {
      adopt(join(home, harness.skillRoot, skill.name), join(store, "skills", skill.name));
    }
    removeStoreLink(
      join(home, harness.skillRoot, CODEX_SYSTEM_SKILLS),
      join(store, "skills", CODEX_SYSTEM_SKILLS),
    );
  }
  // An extra root that appeared after init links whole, as Apply links it on the box.
  for (const root of seed.roots) adopt(join(home, root.path), join(store, "roots", root.path));
}

function adopt(source: string, target: string): void {
  let stat;
  try {
    stat = lstatSync(source);
  } catch (error) {
    if (isMissing(error)) return;
    throw error;
  }
  if (stat.isSymbolicLink()) {
    if (resolve(dirname(source), readlinkSync(source)) === target) return;
    // A chain through another harness root that ends at the store copy becomes a direct link.
    let real;
    try {
      real = realpathSync(source);
    } catch (error) {
      // A broken link has no content to lose. Manifest reports it as a leftover.
      if (isMissing(error)) return;
      throw error;
    }
    if (real !== realpathSync(target)) throw new AdoptionRefusal(source);
    const held = `${source}.ferry-adopting-${process.pid}`;
    symlinkSync(target, held);
    try {
      renameSync(held, source);
    } catch (error) {
      unlinkSync(held);
      throw error;
    }
    return;
  }
  if (!stat.isDirectory() || !sameTree(source, target)) throw new AdoptionRefusal(source);

  const held = `${source}.ferry-adopting-${process.pid}`;
  renameSync(source, held);
  let linked = false;
  try {
    if (!sameTree(held, target)) throw new AdoptionRefusal(source);
    mkdirSync(dirname(source), { recursive: true });
    symlinkSync(target, source);
    linked = true;
    rmSync(held, { recursive: true });
  } catch (error) {
    try {
      if (linked) unlinkSync(source);
      renameSync(held, source);
    } catch {
      // The source was already removed or restored.
    }
    throw error;
  }
}

/** Remove `source` only when it is a symlink to `target`. */
function removeStoreLink(source: string, target: string): void {
  let stat;
  try {
    stat = lstatSync(source);
  } catch (error) {
    if (isMissing(error)) return;
    throw error;
  }
  if (stat.isSymbolicLink() && resolve(dirname(source), readlinkSync(source)) === target) {
    unlinkSync(source);
  }
}

function sameTree(one: string, other: string): boolean {
  try {
    const left = files(one);
    const right = files(other);
    if (left.size !== right.size) return false;
    for (const [path, bytes] of left) {
      const candidate = right.get(path);
      if (!candidate || !bytes.equals(candidate)) return false;
    }
    return true;
  } catch {
    return false;
  }
}

function files(root: string): Map<string, Buffer> {
  const found = new Map<string, Buffer>();
  walk(root, root, found);
  return found;
}

function walk(root: string, directory: string, found: Map<string, Buffer>): void {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    const stat = lstatSync(path);
    if (stat.isDirectory()) walk(root, path, found);
    else if (stat.isFile() || stat.isSymbolicLink()) found.set(relative(root, path), readFileSync(path));
    else throw new Error(`unsupported local skill entry: ${path}`);
  }
}

function isMissing(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}
