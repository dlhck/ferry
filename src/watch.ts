/** Poll Manifest identity and run the existing sync workflow in the foreground. */

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { BoxesSyncError, inspectSyncSource, runSync, SyncError } from "./sync.ts";
import { resolveBoxes } from "./boxes.ts";
import { readConfig } from "./config.ts";
import { AdoptionRefusal } from "./adopt.ts";
import { ApplyError } from "./apply.ts";
import { StoreRefusal } from "./store.ts";
import { runUpdateCommand } from "./update.ts";
import { errorEvent, type OutputEvent } from "./output.ts";
import { noProgress, type Progress } from "./progress.ts";

const DEFAULT_POLL_MS = 500;
const DEFAULT_DEBOUNCE_MS = 1_000;
const DEFAULT_MAX_BACKOFF_MS = 60_000;
const UPDATE_INTERVAL_MS = 24 * 60 * 60 * 1_000;

export type WatchInput = {
  readonly home?: string;
  readonly signal?: AbortSignal;
  readonly pollMs?: number;
  readonly debounceMs?: number;
  readonly maxBackoffMs?: number;
  /**
   * Run the update of the `latest` tools once each 24 hours. The `[update]`
   * config key `watch` sets it.
   */
  readonly dailyUpdate?: boolean;
};

export type WatchObservation =
  | { readonly ok: true; readonly identity: string }
  | { readonly ok: false; readonly signature: string; readonly message: string; readonly error?: unknown };

/** One sync run of the watch. */
export type WatchSyncRequest = {
  readonly identity: string;
  readonly home: string;
  /** The boxes to sync, in config order. */
  readonly boxes: readonly string[];
  /**
   * False when the snapshot already has this identity, for example for a box
   * retry. Then Ferry does not write the store, and the boxes update to the
   * published tip.
   */
  readonly publish: boolean;
};

/**
 * The state that `readState` returns. `published` is the last published
 * identity. `boxes` has the accepted identity of each box. It is null for a
 * version 1 file: then each configured box has the `published` identity.
 */
export type WatchState = {
  readonly published: string | null;
  readonly boxes: Readonly<Record<string, string>> | null;
};

/** The state that the watch writes, as version 2. */
export type WatchStateRecord = {
  readonly published: string | null;
  readonly boxes: Readonly<Record<string, string>>;
};

export type WatchDependencies = {
  readonly observe?: (home: string) => WatchObservation | Promise<WatchObservation>;
  /**
   * Sync the boxes of the request. A failure of some boxes throws a
   * `BoxesSyncError`. With one box, an error of a box step has the origin `box`.
   */
  readonly sync?: (request: WatchSyncRequest) => Promise<void>;
  /** The sync command that the default sync runs. */
  readonly runSync?: typeof runSync;
  /** The names of the configured boxes. The watch reads them in each cycle. */
  readonly readBoxes?: (home: string) => readonly string[];
  readonly isRetryable?: (error: unknown) => boolean;
  readonly sleep?: (milliseconds: number, signal?: AbortSignal) => Promise<void>;
  readonly readState?: (home: string) => WatchState | null;
  readonly writeState?: (home: string, state: WatchStateRecord) => void;
  readonly writeLine?: (line: string) => void;
  /** With --json, prints one event for each watch line. */
  readonly emit?: (event: OutputEvent) => void;
  readonly update?: () => Promise<unknown>;
  /** The update command that the default daily update runs. */
  readonly runUpdate?: typeof runUpdateCommand;
  readonly now?: () => number;
  readonly readUpdateState?: (home: string) => number | null;
  readonly writeUpdateState?: (home: string, time: number) => void;
  /** The reporter for the default sync and update. */
  readonly progress?: Progress;
};

/** A failed sync that waits for its next try. */
type Retry = { readonly identity: string; readonly backoff: number; readonly at: number };

export async function runWatch(
  input: WatchInput = {},
  dependencies: WatchDependencies = {},
): Promise<void> {
  const home = input.home ?? homedir();
  const pollMs = positive(input.pollMs, DEFAULT_POLL_MS);
  const debounceMs = positive(input.debounceMs, DEFAULT_DEBOUNCE_MS);
  const maxBackoffMs = positive(input.maxBackoffMs, DEFAULT_MAX_BACKOFF_MS);
  const observe = dependencies.observe ?? observeSource;
  const sleep = dependencies.sleep ?? abortableSleep;
  const progress = dependencies.progress ?? noProgress;
  const sync = dependencies.sync ??
    (async (request: WatchSyncRequest) => {
      await (dependencies.runSync ?? runSync)(
        { home: request.home, boxes: request.boxes, publish: request.publish },
        { progress, writeLine },
      );
    });
  const readBoxes = dependencies.readBoxes ?? configuredBoxNames;
  const retryable = dependencies.isRetryable ?? isRetryableWatchError;
  const writeLine = dependencies.writeLine ?? console.log;
  /** Write a watch line, and with --json, its event. */
  const note = (line: string, event: OutputEvent) => {
    dependencies.emit?.(event);
    writeLine(line);
  };
  const readState = dependencies.readState ?? readWatchState;
  const writeState = dependencies.writeState ?? writeWatchState;
  let refusal = "";
  // The daily update never includes the integrations. A Paseo restart stops the agents on the box.
  // It updates only the tools whose policy is `latest`. Other versions change only with `ferry update`.
  // It updates all boxes. It skips an offline box and logs it, and that box waits for the next day.
  const update = dependencies.update ??
    (() => (dependencies.runUpdate ?? runUpdateCommand)(
      { yes: true, dryRun: false, includeIntegrations: false, latestOnly: true },
      { writeLine, progress },
    ));
  const now = dependencies.now ?? Date.now;
  const readUpdateState = dependencies.readUpdateState ?? readUpdateTime;
  const writeUpdateState = dependencies.writeUpdateState ?? writeUpdateTime;
  let updating: Promise<void> | null = null;

  // The update runs next to the sync loop, so a slow update never delays a
  // sync. The start time is recorded first, so a restart does not run it again.
  const startDueUpdate = () => {
    if (input.dailyUpdate !== true || updating) return;
    const time = now();
    const last = readUpdateState(home);
    if (last !== null && time - last < UPDATE_INTERVAL_MS) return;
    writeUpdateState(home, time);
    note("Running the daily tool update.", { type: "update-started" });
    updating = update()
      .then(() => undefined)
      .catch((error) => note(`Watch update failed: ${messageOf(error)}`, errorEvent("update-failed", error)))
      .finally(() => {
        updating = null;
      });
  };

  const stored = readState(home);
  const initial = await observe(home);
  let published = stored ? stored.published : initial.ok ? initial.identity : null;
  let accepted: Record<string, string> = { ...stored?.boxes };
  // A version 1 file, or no file: the first config read gives this identity to each box.
  let inherited = stored?.boxes ? null : published;
  const retries = new Map<string, Retry>();
  /** The retry of a sync that failed before the box steps, for example in the publish. */
  let retry = null as Retry | null;
  let settled: string | null = null;
  let names: readonly string[] = [];
  let configError = "";
  const save = () => writeState(home, { published, boxes: { ...accepted } });
  const prefix = (name: string) => (names.length > 1 ? `[${name}] ` : "");

  /** Read the boxes of the config. A removed box leaves the state. A new box has no accepted identity, so it syncs. */
  const loadBoxes = (): boolean => {
    try {
      names = readBoxes(home);
    } catch (error) {
      const message = messageOf(error);
      if (message !== configError) note(`Watch cannot read the config: ${message}`, errorEvent("config-error", error));
      configError = message;
      return false;
    }
    configError = "";
    const next: Record<string, string> = {};
    for (const name of names) {
      const identity = accepted[name] ?? inherited;
      if (identity !== null && identity !== undefined) next[name] = identity;
    }
    const changed = inherited !== null || Object.keys(accepted).some((name) => !names.includes(name));
    for (const name of retries.keys()) if (!names.includes(name)) retries.delete(name);
    inherited = null;
    accepted = next;
    if (changed) save();
    return true;
  };

  if (!initial.ok) {
    refusal = initial.signature;
    note(`Watch refused content: ${initial.message}`, errorEvent("content-refused", initial.error ?? initial.message));
  }
  loadBoxes();
  note("Ferry watch is running.", { type: "watch-started", boxes: names });

  while (!input.signal?.aborted) {
    startDueUpdate();
    await sleep(pollMs, input.signal);
    if (input.signal?.aborted) break;
    const changed = await observe(home);
    if (!changed.ok) {
      if (changed.signature !== refusal) {
        note(`Watch refused content: ${changed.message}`, errorEvent("content-refused", changed.error ?? changed.message));
      }
      refusal = changed.signature;
      continue;
    }
    refusal = "";
    if (!loadBoxes()) continue;
    let identity = changed.identity;
    if (names.every((name) => accepted[name] === identity)) continue;
    if (identity !== published && identity !== settled) {
      const desired = await settle(identity, home, pollMs, debounceMs, observe, sleep, input.signal);
      if (!desired) continue;
      identity = settled = desired;
    }

    // Each box has its own backoff. The loop never sleeps for a backoff, so it observes and syncs the other boxes.
    const time = now();
    if (retry?.identity === identity && time < retry.at) continue;
    const ready = names.filter((name) => {
      const boxRetry = retries.get(name);
      return accepted[name] !== identity && (boxRetry?.identity !== identity || boxRetry.at <= time);
    });
    if (ready.length === 0) continue;
    const publish = identity !== published;

    let failures: Map<string, unknown>;
    try {
      await sync({ identity, home, boxes: ready, publish });
      failures = new Map();
    } catch (error) {
      const boxes = boxFailures(error, ready);
      if (boxes === null) {
        if (retryable(error)) {
          const backoff = retry?.identity === identity ? Math.min(retry.backoff * 2, maxBackoffMs) : 1_000;
          retry = { identity, backoff, at: now() + backoff };
          note(
            `Watch sync failed; retrying in ${backoff} ms: ${messageOf(error)}`,
            errorEvent("sync-failed", error, { box: null, retryInMs: backoff }),
          );
        } else {
          retry = null;
          note(`Watch sync refused: ${messageOf(error)}`, errorEvent("sync-refused", error, { box: null }));
          if (!isManifestReadFailure(error)) {
            for (const name of ready) accepted[name] = identity;
            save();
          }
        }
        continue;
      }
      failures = boxes;
    }

    // The publish succeeded, and each box has its own result.
    retry = null;
    published = identity;
    for (const name of ready) {
      const error = failures.get(name);
      if (error === undefined) {
        accepted[name] = identity;
        retries.delete(name);
        note(`${prefix(name)}Synced Manifest ${identity.slice(0, 12)}.`, { type: "synced", box: name, manifest: identity });
      } else if (retryable(error)) {
        const previous = retries.get(name);
        const backoff = previous?.identity === identity ? Math.min(previous.backoff * 2, maxBackoffMs) : 1_000;
        retries.set(name, { identity, backoff, at: now() + backoff });
        note(
          `${prefix(name)}Watch sync failed; retrying in ${backoff} ms: ${messageOf(error)}`,
          errorEvent("sync-failed", error, { box: name, retryInMs: backoff }),
        );
      } else {
        accepted[name] = identity;
        retries.delete(name);
        note(`${prefix(name)}Watch sync refused: ${messageOf(error)}`, errorEvent("sync-refused", error, { box: name }));
      }
    }
    save();
  }
  await updating;
  dependencies.emit?.({ type: "watch-stopped" });
}

/**
 * The error of each failed box, or null when the sync failed before the box
 * steps. With one box, sync throws the error of the box, and a box step error
 * has the origin `box`.
 */
function boxFailures(error: unknown, boxes: readonly string[]): Map<string, unknown> | null {
  if (error instanceof BoxesSyncError) {
    return new Map(error.results.flatMap((result) => (result.failure ? [[result.name, result.failure.error]] : [])));
  }
  if (boxes.length === 1 && error instanceof SyncError && error.origin === "box") return new Map([[boxes[0]!, error]]);
  return null;
}

function configuredBoxNames(home: string): readonly string[] {
  return resolveBoxes(readConfig(home) ?? {}).map((box) => box.name);
}

async function settle(
  first: string,
  home: string,
  pollMs: number,
  debounceMs: number,
  observe: (home: string) => WatchObservation | Promise<WatchObservation>,
  sleep: (milliseconds: number, signal?: AbortSignal) => Promise<void>,
  signal?: AbortSignal,
): Promise<string | null> {
  let desired = first;
  let stableFor = 0;
  while (stableFor < debounceMs && !signal?.aborted) {
    await sleep(Math.min(pollMs, debounceMs - stableFor), signal);
    const current = await observe(home);
    if (!current.ok) return null;
    if (current.identity === desired) stableFor += pollMs;
    else {
      desired = current.identity;
      stableFor = 0;
    }
  }
  return signal?.aborted ? null : desired;
}

async function observeSource(home: string): Promise<WatchObservation> {
  try {
    return { ok: true, identity: inspectSyncSource(home).seed.identity };
  } catch (error) {
    const message = messageOf(error);
    return { ok: false, signature: message, message, error };
  }
}

export function isRetryableWatchError(error: unknown): boolean {
  if (!(error instanceof SyncError)) return false;
  if (error.code === "publish-failure") return !(error.cause instanceof StoreRefusal);
  if (error.code === "apply-failure") {
    return !(error.cause instanceof AdoptionRefusal) &&
      !(error.cause instanceof ApplyError && error.cause.code === "refused");
  }
  return ["link-failure", "remote-update-failure"].includes(error.code);
}

function isManifestReadFailure(error: unknown): boolean {
  return error instanceof SyncError &&
    (error.code === "manifest-failure" || error.code === "manifest-refusal");
}

function statePath(home: string): string {
  return join(home, ".ferry", "watch-state.json");
}

function updateStatePath(home: string): string {
  return join(home, ".ferry", "update-state.json");
}

function readUpdateTime(home: string): number | null {
  const path = updateStatePath(home);
  if (!existsSync(path)) return null;
  try {
    const value: unknown = JSON.parse(readFileSync(path, "utf8"));
    const state = value as { version?: unknown; lastRun?: unknown };
    return state.version === 1 && typeof state.lastRun === "number" ? state.lastRun : null;
  } catch {
    return null;
  }
}

function writeUpdateTime(home: string, time: number): void {
  const path = updateStatePath(home);
  const temporary = `${path}.tmp`;
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(temporary, `${JSON.stringify({ version: 1, lastRun: time })}\n`, { mode: 0o600 });
  renameSync(temporary, path);
}

function readWatchState(home: string): WatchState | null {
  const path = statePath(home);
  if (!existsSync(path)) return null;
  try {
    const value: unknown = JSON.parse(readFileSync(path, "utf8"));
    const state = value as { version?: unknown; identity?: unknown; published?: unknown; boxes?: unknown };
    if (state.version === 1) return typeof state.identity === "string" ? { published: state.identity, boxes: null } : null;
    if (state.version !== 2 || (state.published !== null && typeof state.published !== "string")) return null;
    if (typeof state.boxes !== "object" || state.boxes === null || Array.isArray(state.boxes)) return null;
    const boxes = Object.entries(state.boxes).filter((entry): entry is [string, string] => typeof entry[1] === "string");
    return { published: state.published, boxes: Object.fromEntries(boxes) };
  } catch {
    return null;
  }
}

function writeWatchState(home: string, state: WatchStateRecord): void {
  const path = statePath(home);
  const temporary = `${path}.tmp`;
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(
    temporary,
    `${JSON.stringify({ version: 2, published: state.published, boxes: state.boxes })}\n`,
    { mode: 0o600 },
  );
  renameSync(temporary, path);
}

function abortableSleep(milliseconds: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(done, milliseconds);
    signal?.addEventListener("abort", done, { once: true });
    function done() {
      clearTimeout(timer);
      signal?.removeEventListener("abort", done);
      resolve();
    }
  });
}

function positive(value: number | undefined, fallback: number): number {
  return value !== undefined && value > 0 ? value : fallback;
}

function messageOf(error: unknown): string {
  return error instanceof Error && error.message ? error.message : String(error);
}
