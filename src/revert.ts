/**
 * `ferry history` and `ferry revert`.
 *
 * Skills, AGENTS.md, and extra roots link into the store checkout, so the
 * revert commit restores them on this machine. Carried settings keys are
 * copies in local files, so Ferry writes the reverted keys back into those
 * files and keeps all other content. Then the local files match the snapshot,
 * and the next sync or watch cycle publishes nothing.
 */

import { existsSync, mkdirSync, readFileSync, realpathSync, renameSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { apply } from "./apply.ts";
import { mergeSettings, record } from "./box-settings.ts";
import { FerryError } from "./errors.ts";
import type { Progress } from "./progress.ts";
import type { HarnessDescriptor } from "./registry/types.ts";
import { openStore, readHistory, type GitRunner, type HistoryEntry, type Store } from "./store.ts";
import {
  acquireStoreLock,
  inspectSyncSource,
  runSync,
  type SyncDependencies,
  type SyncResult,
} from "./sync.ts";

export const HISTORY_LIMIT = 20;
const STORE_DIRECTORY = join(".ferry", "store");

/** The carried keys of one local settings file that a revert writes. `file` is relative to the home. */
export type SettingsRevert = { readonly file: string; readonly keys: readonly string[] };

export type RevertInput = {
  readonly home?: string;
  readonly commit: string;
  readonly dryRun?: boolean;
  /** False skips the sync of the boxes after the revert. */
  readonly sync?: boolean;
};

export type RevertResult = {
  readonly dryRun: boolean;
  /** The full id of the reverted commit. */
  readonly commit: string;
  readonly subject: string;
  /** The new snapshot commit, or null with --dry-run. */
  readonly tip: string | null;
  /** The snapshot paths that the revert changes. */
  readonly paths: readonly string[];
  readonly settings: readonly SettingsRevert[];
  /** The sync result, or null with --dry-run or --no-sync. */
  readonly sync: SyncResult | null;
};

export type RevertDependencies = Pick<SyncDependencies, "readConfig" | "loadRegistry" | "readSeed" | "publisher"> & {
  readonly git?: GitRunner;
  readonly acquireStoreLock?: (home: string) => Promise<() => void>;
  readonly runSync?: typeof runSync;
  /** The dependencies of the sync after the revert. */
  readonly syncDependencies?: SyncDependencies;
  readonly writeLine?: (line: string) => void;
  readonly progress?: Progress;
};

/** The last `limit` snapshot commits of the store checkout, newest first. */
export async function runHistory(
  input: { readonly home?: string; readonly limit?: number },
  dependencies: { readonly git?: GitRunner } = {},
): Promise<readonly HistoryEntry[]> {
  const checkout = join(input.home ?? homedir(), STORE_DIRECTORY);
  if (!existsSync(join(checkout, ".git"))) {
    throw new FerryError("config-missing", `Ferry has no snapshot checkout at ${checkout}.`);
  }
  return readHistory(checkout, input.limit ?? HISTORY_LIMIT, dependencies.git);
}

export function historyLines(entries: readonly HistoryEntry[]): string[] {
  if (entries.length === 0) return ["The snapshot has no commits."];
  return entries.flatMap((entry) => [
    `${entry.commit.slice(0, 12)}  ${entry.date}  ${entry.subject}`,
    ...entry.paths.map((path) => `    ${path}`),
  ]);
}

/**
 * Undo one snapshot commit, as `git revert` does. Later commits stay. A revert
 * that conflicts with a later commit, or local changes that are not published,
 * stop the revert before it changes anything.
 */
export async function runRevert(input: RevertInput, dependencies: RevertDependencies = {}): Promise<RevertResult> {
  const home = input.home ?? homedir();
  const writeLine = dependencies.writeLine ?? console.log;
  const source = inspectSyncSource(home, dependencies);
  const release = await (dependencies.acquireStoreLock ?? acquireStoreLock)(home);
  let result: Omit<RevertResult, "sync">;
  try {
    const store = await openStore(source.config.snapshotUrl, source.seed, {
      home,
      harnesses: source.registry.harnesses,
      git: dependencies.git,
    });
    const unpublished = await store.unpublished(source.seed);
    if (unpublished.length > 0) {
      throw new FerryError("refused", `This machine has changes that are not in the snapshot: ${unpublished.join(", ")}.`, {
        hint: "Run ferry sync, then run ferry revert again.",
        details: { paths: unpublished },
      });
    }

    const plan = await store.planRevert(input.commit);
    if (!plan.ok) {
      throw new FerryError(
        "refused",
        `Later commits also change ${plan.conflicts.join(", ")}. Ferry did not revert ${plan.commit.slice(0, 12)} and changed nothing.`,
        { hint: "Revert the later commits first, or change the files by hand.", details: { paths: plan.conflicts } },
      );
    }
    const writes = await settingsWrites(home, store, plan.base, plan.tree, source.registry.harnesses);
    const settings = writes.map(({ file, keys }) => ({ file, keys }));
    result = { dryRun: input.dryRun === true, commit: plan.commit, subject: plan.subject, tip: null, paths: plan.paths, settings };

    writeLine(`Revert ${plan.commit.slice(0, 12)} ${plan.subject}`);
    for (const path of plan.paths) writeLine(`  ${path}`);
    for (const write of settings) writeLine(`Settings: ~/${write.file} keys ${write.keys.join(", ")}`);
    if (input.dryRun) {
      if (input.sync !== false) writeLine("Then Ferry syncs all boxes.");
      return { ...result, sync: null };
    }

    const tip = await store.commitRevert(plan);
    for (const write of writes) writeLocal(join(home, write.file), write.text);
    // A revert can add or remove a skill or root, so the local links follow the checkout.
    apply({ checkout: store.path, targetHome: home, harnesses: source.harnesses });
    await store.push();
    result = { ...result, tip };
    writeLine(`Published ${tip.slice(0, 7)}.`);
  } finally {
    release();
  }

  if (input.sync === false) return { ...result, sync: null };
  const sync = await (dependencies.runSync ?? runSync)(
    { home },
    { progress: dependencies.progress, writeLine, ...dependencies.syncDependencies },
  );
  return { ...result, sync };
}

type SettingsWrite = SettingsRevert & { readonly text: string };

/**
 * The local settings files that the revert changes. Only the carried keys
 * that the revert changes are written. A key whose local value is not the
 * published value stops the revert, because Ferry would lose that value.
 */
async function settingsWrites(
  home: string,
  store: Store,
  base: string,
  tree: string,
  harnesses: readonly HarnessDescriptor[],
): Promise<SettingsWrite[]> {
  const writes: SettingsWrite[] = [];
  for (const harness of harnesses) {
    const descriptor = harness.settings;
    if (!descriptor) continue;
    const path = `settings/${harness.id}.json`;
    const before = carried(await store.readFile(base, path));
    const after = carried(await store.readFile(tree, path));
    const keys = descriptor.keys.filter((key) => !Bun.deepEquals(before[key], after[key]));
    if (keys.length === 0) continue;

    const file = join(home, descriptor.file);
    const text = existsSync(file) ? readFileSync(file, "utf8") : null;
    const local = parseLocal(file, text, descriptor.format);
    const kept = keys.filter((key) => !Bun.deepEquals(normalized(local[key]), before[key]));
    if (kept.length > 0) {
      throw new FerryError(
        "refused",
        `${file} has values in ${kept.join(", ")} that Ferry does not carry. Ferry did not revert and changed nothing.`,
        { hint: "Change these keys by hand.", details: { paths: [file] } },
      );
    }
    writes.push({ file: descriptor.file, keys, text: mergeSettings(text, after, keys, descriptor.format) });
  }
  return writes;
}

function carried(bytes: Uint8Array | null): Record<string, unknown> {
  return bytes ? record(JSON.parse(Buffer.from(bytes).toString())) : {};
}

/** Read a local settings file as Manifest reads it. */
function parseLocal(file: string, text: string | null, format: "json" | "toml"): Record<string, unknown> {
  if (text === null) return {};
  let parsed: unknown;
  try {
    parsed = format === "toml" ? Bun.TOML.parse(text) : JSON.parse(text);
  } catch {
    parsed = null;
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new FerryError("refused", `${file} is not a ${format.toUpperCase()} object.`, { details: { paths: [file] } });
  }
  return parsed as Record<string, unknown>;
}

/** The value as the snapshot holds it: JSON. */
function normalized(value: unknown): unknown {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}

/** Write through a temporary file. A settings file that is a link keeps the link. */
function writeLocal(path: string, text: string): void {
  const target = existsSync(path) ? realpathSync(path) : path;
  const mode = existsSync(target) ? statSync(target).mode & 0o777 : 0o644;
  const temporary = `${target}.ferry-tmp`;
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(temporary, text, { mode });
  renameSync(temporary, target);
}
