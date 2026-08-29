/** Convert newly published local skill directories into managed links. */

import {
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  renameSync,
  rmSync,
  symlinkSync,
  unlinkSync,
} from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import type { Seed } from "./manifest.ts";
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
      const source = join(home, harness.skillRoot, skill.name);
      const target = join(store, "skills", skill.name);
      let stat;
      try {
        stat = lstatSync(source);
      } catch (error) {
        if (isMissing(error)) continue;
        throw error;
      }
      if (stat.isSymbolicLink()) {
        if (resolve(dirname(source), readlinkSync(source)) === target) continue;
        throw new AdoptionRefusal(source);
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
