/** Record and restore the operator machine state changed by `ferry init`. */

import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  renameSync,
  rmdirSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, relative, resolve } from "node:path";
import type { ApplyPlan } from "./apply.ts";
import { configPath } from "./config.ts";
import type { HarnessDescriptor } from "./registry/types.ts";

const STATE_RELATIVE_PATH = ".ferry/uninstall.json";
const STORE_RELATIVE_PATH = ".ferry/store";

type OriginalPath =
  | { readonly kind: "missing" }
  | { readonly kind: "symlink"; readonly link: string }
  | { readonly kind: "empty-directory" }
  | { readonly kind: "backup"; readonly path: string };

type SavedFile =
  | { readonly kind: "missing" }
  | { readonly kind: "file"; readonly bytes: string; readonly mode: number }
  | { readonly kind: "symlink"; readonly link: string };

type ManagedPath = {
  readonly path: string;
  readonly target: string;
  readonly original: OriginalPath;
};

type UninstallState = {
  readonly version: 1;
  readonly ferryDirectoryExisted: boolean;
  readonly storeExisted: boolean;
  readonly config: SavedFile;
  readonly absentDirectories: readonly string[];
  readonly paths: readonly ManagedPath[];
};

type PendingOriginal = Exclude<OriginalPath, { readonly kind: "backup" }> | { readonly kind: "other" };

type PendingState = Omit<UninstallState, "paths"> & {
  readonly paths: readonly {
    readonly path: string;
    readonly target: string;
    readonly original: PendingOriginal;
  }[];
};

export type CaptureInitStateInput = {
  readonly home: string;
  readonly harnesses: readonly HarnessDescriptor[];
  readonly skillNames: readonly string[];
};

export type UninstallInput = {
  readonly home?: string;
  readonly harnesses: readonly HarnessDescriptor[];
};

export type UninstallResult = {
  readonly removed: number;
  readonly restored: number;
};

export type UninstallRefusalCode = "changed-path" | "invalid-state" | "missing-backup";

export class UninstallRefusal extends Error {
  constructor(
    readonly code: UninstallRefusalCode,
    message: string,
  ) {
    super(message);
    this.name = "UninstallRefusal";
  }
}

/** Capture paths before Store or Apply changes the local home. */
export function captureInitState(input: CaptureInitStateInput): PendingState | null {
  const home = resolve(input.home);
  if (existsSync(statePath(home))) return null;

  const managed = managedPaths(home, input.harnesses, input.skillNames);
  const absentDirectories = new Set<string>();
  for (const entry of managed) {
    for (let directory = dirname(entry.path); directory !== home; directory = dirname(directory)) {
      if (!existsSync(directory)) absentDirectories.add(toRelative(home, directory));
    }
  }

  return {
    version: 1,
    ferryDirectoryExisted: existsSync(join(home, ".ferry")),
    storeExisted: existsSync(join(home, STORE_RELATIVE_PATH)),
    config: captureFile(configPath(home)),
    absentDirectories: [...absentDirectories].sort(deepestFirst),
    paths: managed.map((entry) => ({
      path: toRelative(home, entry.path),
      target: toRelative(home, entry.target),
      original: inspectOriginal(entry.path),
    })),
  };
}

/** Write the first pre-init snapshot before Apply commits its plan. */
export function writeInitState(home: string, pending: PendingState | null, plan: ApplyPlan): void {
  if (!pending) return;
  const root = resolve(home);
  const backups = new Map(
    plan.actions.flatMap((action) =>
      action.kind === "backup-and-link"
        ? [[toRelative(root, action.path), toRelative(root, action.backupPath)] as const]
        : [],
    ),
  );
  const state: UninstallState = {
    ...pending,
    paths: pending.paths.map((entry): ManagedPath => {
      if (entry.original.kind !== "other") return entry as ManagedPath;
      const backup = backups.get(entry.path);
      if (!backup) {
        throw new UninstallRefusal(
          "invalid-state",
          `init did not plan a backup for ${join(root, entry.path)}`,
        );
      }
      return { ...entry, original: { kind: "backup", path: backup } };
    }),
  };
  const path = statePath(root);
  const temporary = `${path}.tmp`;
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(temporary, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
  renameSync(temporary, path);
}

export function runUninstall(input: UninstallInput): UninstallResult {
  const home = resolve(input.home ?? homedir());
  const state = readState(home, input.harnesses);
  const currentLinks = discoverManagedLinks(home, input.harnesses, state);
  preflight(home, state, currentLinks);

  let removed = 0;
  let restored = 0;
  const savedPaths = new Set(state.paths.map((entry) => entry.path));

  for (const entry of currentLinks) {
    const path = toRelative(home, entry.path);
    if (savedPaths.has(path)) continue;
    unlinkSync(entry.path);
    removed++;
  }

  for (const entry of state.paths) {
    const path = fromRelative(home, entry.path);
    if (isExpectedLink(path, fromRelative(home, entry.target))) {
      unlinkSync(path);
      removed++;
    }
    switch (entry.original.kind) {
      case "missing":
        break;
      case "symlink":
        mkdirSync(dirname(path), { recursive: true });
        symlinkSync(entry.original.link, path);
        restored++;
        break;
      case "empty-directory":
        mkdirSync(path, { recursive: true });
        restored++;
        break;
      case "backup":
        mkdirSync(dirname(path), { recursive: true });
        renameSync(fromRelative(home, entry.original.path), path);
        restored++;
        break;
    }
  }

  const store = join(home, STORE_RELATIVE_PATH);
  if (!state.storeExisted && existsSync(store)) {
    rmSync(store, { recursive: true });
    removed++;
  }
  restoreConfig(home, state.config);
  rmSync(join(home, ".ferry", "watch-state.json"), { force: true });
  rmSync(statePath(home), { force: true });

  for (const directory of state.absentDirectories) removeEmpty(fromRelative(home, directory));
  if (!state.ferryDirectoryExisted) removeEmpty(join(home, ".ferry"));
  return { removed, restored };
}

function managedPaths(
  home: string,
  harnesses: readonly HarnessDescriptor[],
  skillNames: readonly string[],
): { readonly path: string; readonly target: string }[] {
  const checkout = join(home, STORE_RELATIVE_PATH);
  const paths = new Map<string, string>();
  for (const harness of harnesses) {
    if (harness.skillRoot) {
      for (const name of skillNames) {
        paths.set(join(home, harness.skillRoot, name), join(checkout, "skills", name));
      }
    }
    if (harness.instructionFile) {
      paths.set(join(home, harness.instructionFile), join(checkout, "AGENTS.md"));
    }
  }
  return [...paths].map(([path, target]) => ({ path, target }));
}

function discoverManagedLinks(
  home: string,
  harnesses: readonly HarnessDescriptor[],
  state?: UninstallState,
): { readonly path: string; readonly target: string }[] {
  const checkout = join(home, STORE_RELATIVE_PATH);
  const links = new Map<string, string>();
  const skillRoots = new Set(
    harnesses.flatMap((harness) => harness.skillRoot ? [join(home, harness.skillRoot)] : []),
  );
  for (const entry of state?.paths ?? []) {
    const target = fromRelative(home, entry.target);
    if (dirname(target) === join(checkout, "skills")) {
      skillRoots.add(dirname(fromRelative(home, entry.path)));
    }
  }
  for (const root of skillRoots) {
    for (const name of readNames(root)) {
      const path = join(root, name);
      const target = join(checkout, "skills", name);
      if (isExpectedLink(path, target)) links.set(path, target);
    }
  }
  for (const harness of harnesses) {
    if (harness.instructionFile) {
      const path = join(home, harness.instructionFile);
      const target = join(checkout, "AGENTS.md");
      if (isExpectedLink(path, target)) links.set(path, target);
    }
  }
  return [...links].map(([path, target]) => ({ path, target }));
}

function preflight(
  home: string,
  state: UninstallState,
  currentLinks: readonly { readonly path: string; readonly target: string }[],
): void {
  const discovered = new Set(currentLinks.map((entry) => entry.path));
  for (const entry of state.paths) {
    const path = fromRelative(home, entry.path);
    const status = inspectPath(path);
    if (status !== "missing" && !discovered.has(path)) {
      throw new UninstallRefusal("changed-path", `refusing changed managed path ${path}`);
    }
    if (entry.original.kind === "backup") {
      const backup = fromRelative(home, entry.original.path);
      if (!existsSync(backup)) {
        throw new UninstallRefusal("missing-backup", `missing init backup ${backup}`);
      }
    }
  }
}

function inspectOriginal(path: string): PendingOriginal {
  const status = inspectPath(path);
  if (status === "missing") return { kind: "missing" };
  const stat = lstatSync(path);
  if (stat.isSymbolicLink()) return { kind: "symlink", link: readlinkSync(path) };
  if (stat.isDirectory() && readdirSync(path).length === 0) return { kind: "empty-directory" };
  return { kind: "other" };
}

function captureFile(path: string): SavedFile {
  if (inspectPath(path) === "missing") return { kind: "missing" };
  const stat = lstatSync(path);
  if (stat.isSymbolicLink()) return { kind: "symlink", link: readlinkSync(path) };
  if (!stat.isFile()) {
    throw new UninstallRefusal("invalid-state", `cannot preserve non-file config ${path}`);
  }
  return {
    kind: "file",
    bytes: readFileSync(path).toString("base64"),
    mode: stat.mode & 0o777,
  };
}

function restoreConfig(home: string, config: SavedFile): void {
  const path = configPath(home);
  rmSync(path, { recursive: true, force: true });
  if (config.kind === "missing") return;
  mkdirSync(dirname(path), { recursive: true });
  if (config.kind === "symlink") {
    symlinkSync(config.link, path);
    return;
  }
  writeFileSync(path, Buffer.from(config.bytes, "base64"));
  chmodSync(path, config.mode);
}

function readState(home: string, harnesses: readonly HarnessDescriptor[]): UninstallState {
  const path = statePath(home);
  if (!existsSync(path)) return legacyState(home, harnesses);
  let value: unknown;
  try {
    value = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    throw new UninstallRefusal("invalid-state", `cannot read uninstall state ${path}`);
  }
  if (!isState(value)) {
    throw new UninstallRefusal("invalid-state", `invalid uninstall state ${path}`);
  }
  for (const entry of value.paths) {
    fromRelative(home, entry.path);
    fromRelative(home, entry.target);
    if (entry.original.kind === "backup") fromRelative(home, entry.original.path);
  }
  for (const directory of value.absentDirectories) fromRelative(home, directory);
  return value;
}

function legacyState(home: string, harnesses: readonly HarnessDescriptor[]): UninstallState {
  const links = discoverManagedLinks(home, harnesses);
  return {
    version: 1,
    ferryDirectoryExisted: false,
    storeExisted: false,
    config: { kind: "missing" },
    absentDirectories: [],
    paths: links.map((entry): ManagedPath => {
      const backups = backupCandidates(entry.path);
      if (backups.length > 1) {
        throw new UninstallRefusal(
          "invalid-state",
          `multiple init backups found for ${entry.path}: ${backups.join(", ")}`,
        );
      }
      return {
        path: toRelative(home, entry.path),
        target: toRelative(home, entry.target),
        original: backups[0]
          ? { kind: "backup", path: toRelative(home, backups[0]) }
          : { kind: "missing" },
      };
    }),
  };
}

function backupCandidates(path: string): string[] {
  const prefix = `${basename(path)}.ferry-backup-`;
  return readNames(dirname(path))
    .filter((name) => name.startsWith(prefix))
    .map((name) => join(dirname(path), name));
}

function isState(value: unknown): value is UninstallState {
  const state = value as Partial<UninstallState> | null;
  return state?.version === 1 &&
    typeof state.ferryDirectoryExisted === "boolean" &&
    typeof state.storeExisted === "boolean" &&
    Array.isArray(state.paths) &&
    Array.isArray(state.absentDirectories) &&
    state.paths.every(isManagedPath) &&
    state.absentDirectories.every((path) => typeof path === "string") &&
    isSavedFile(state.config);
}

function isManagedPath(value: unknown): value is ManagedPath {
  const entry = value as Partial<ManagedPath> | null;
  return typeof entry?.path === "string" &&
    typeof entry.target === "string" &&
    isOriginalPath(entry.original);
}

function isOriginalPath(value: unknown): value is OriginalPath {
  const original = value as Partial<OriginalPath> | null;
  return original?.kind === "missing" ||
    original?.kind === "empty-directory" ||
    (original?.kind === "symlink" && typeof original.link === "string") ||
    (original?.kind === "backup" && typeof original.path === "string");
}

function isSavedFile(value: unknown): value is SavedFile {
  const file = value as Partial<SavedFile> | null;
  return file?.kind === "missing" ||
    (file?.kind === "symlink" && typeof file.link === "string") ||
    (file?.kind === "file" && typeof file.bytes === "string" && typeof file.mode === "number");
}

function statePath(home: string): string {
  return join(home, STATE_RELATIVE_PATH);
}

function isExpectedLink(path: string, target: string): boolean {
  try {
    return lstatSync(path).isSymbolicLink() && resolve(dirname(path), readlinkSync(path)) === target;
  } catch (error) {
    if (isMissing(error)) return false;
    throw error;
  }
}

function inspectPath(path: string): "missing" | "present" {
  try {
    lstatSync(path);
    return "present";
  } catch (error) {
    if (isMissing(error)) return "missing";
    throw error;
  }
}

function readNames(path: string): string[] {
  try {
    return readdirSync(path).sort(compare);
  } catch (error) {
    if (isMissing(error) || isNotDirectory(error)) return [];
    throw error;
  }
}

function fromRelative(home: string, path: string): string {
  if (path === "" || path.startsWith("/") || path.split(/[\\/]/).includes("..")) {
    throw new UninstallRefusal("invalid-state", `uninstall state contains unsafe path ${path}`);
  }
  const resolved = resolve(home, path);
  if (resolved === home || !resolved.startsWith(`${home}/`)) {
    throw new UninstallRefusal("invalid-state", `uninstall state contains unsafe path ${path}`);
  }
  return resolved;
}

function toRelative(home: string, path: string): string {
  return relative(home, path);
}

function removeEmpty(path: string): void {
  try {
    rmdirSync(path);
  } catch (error) {
    if (!isMissing(error) && !isNotEmpty(error) && !isNotDirectory(error)) throw error;
  }
}

function deepestFirst(a: string, b: string): number {
  const depth = b.split(/[\\/]/).length - a.split(/[\\/]/).length;
  return depth || compare(a, b);
}

function isMissing(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}

function isNotDirectory(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOTDIR";
}

function isNotEmpty(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOTEMPTY";
}

function compare(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}
