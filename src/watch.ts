/** Poll Manifest identity and run the existing sync workflow in the foreground. */

import { createHash } from "node:crypto";
import { readPaseoPlugins } from "./integrations/paseo-plugins.ts";
import { readPaseoProviders } from "./integrations/paseo-providers.ts";
import { readPaseoTerminalProfiles } from "./integrations/paseo-terminal-profiles.ts";
import { readPaseoPreferences } from "./integrations/paseo.ts";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { BoxesSyncError, inspectSyncSource, runSync, SyncError, type BoxSyncResult } from "./sync.ts";
import { resolveBoxes } from "./boxes.ts";
import { readBoxInstructions } from "./box-identity.ts";
import { readConfig } from "./config.ts";
import { AdoptionRefusal } from "./adopt.ts";
import { ApplyError } from "./apply.ts";
import { StoreRefusal } from "./store.ts";
import { runUpdateCommand } from "./update.ts";
import { errorEvent, type OutputEvent } from "./output.ts";
import { noProgress, type Progress } from "./progress.ts";
import type { BriefStatusReport } from "./status.ts";

const DEFAULT_POLL_MS = 500;
const DEFAULT_DEBOUNCE_MS = 1_000;
const DEFAULT_MAX_BACKOFF_MS = 60_000;
const UPDATE_INTERVAL_MS = 24 * 60 * 60 * 1_000;
const STATUS_INTERVAL_MS = 5 * 60 * 1_000;

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
  | {
      readonly ok: true;
      readonly identity: string;
      /**
       * The identity of each box with per-box instructions. A box without an
       * entry has `identity`. A change here syncs only that box, without a publish.
       */
      readonly boxes?: Readonly<Record<string, string>>;
    }
  | { readonly ok: false; readonly signature: string; readonly message: string; readonly error?: unknown };

type AcceptedObservation = Extract<WatchObservation, { ok: true }>;

/** One sync run of the watch. */
export type WatchSyncRequest = {
  /** The identity of the snapshot. */
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
   * Returns the names of the boxes that the sync skipped, because the config changed for them during the sync.
   */
  readonly sync?: (request: WatchSyncRequest) => Promise<readonly string[] | void>;
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
  /**
   * The brief status of all boxes. The watch runs it at the start, every 5
   * minutes, and after each sync, and writes it to `~/.ferry/status.json`.
   * Without it, the watch writes no status file.
   */
  readonly status?: () => Promise<BriefStatusReport>;
  readonly writeStatusFile?: (home: string, report: BriefStatusReport) => void;
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
      const result = await (dependencies.runSync ?? runSync)(
        { home: request.home, boxes: request.boxes, publish: request.publish },
        { progress, writeLine },
      );
      return skippedBoxes(result.boxes);
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
  // It holds the lock of each box that it changes, and it skips a box whose lock a sync holds.
  const update = dependencies.update ??
    (() => (dependencies.runUpdate ?? runUpdateCommand)(
      { yes: true, dryRun: false, includeIntegrations: false, latestOnly: true },
      { writeLine, progress, home },
    ));
  const now = dependencies.now ?? Date.now;
  const readUpdateState = dependencies.readUpdateState ?? readUpdateTime;
  const writeUpdateState = dependencies.writeUpdateState ?? writeUpdateTime;
  let updating: Promise<void> | null = null;
  const status = dependencies.status;
  const writeStatus = dependencies.writeStatusFile ?? writeStatusFile;
  let checking: Promise<void> | null = null;
  /** The time of the next status check. A sync sets it to 0, so the next cycle checks. */
  let statusDue = 0;

  // The update runs next to the sync loop, so a slow update does not stop the
  // loop. A sync of a box that the update changes finds the box busy and is
  // tried again. The start time is recorded first, so a restart does not run it again.
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

  // The status check runs next to the sync loop, as the update does. It only reads the boxes.
  const startDueStatus = () => {
    if (status === undefined || checking || now() < statusDue) return;
    statusDue = now() + STATUS_INTERVAL_MS;
    checking = status()
      .then((report) => writeStatus(home, report))
      .catch((error) => note(`Watch status check failed: ${messageOf(error)}`, errorEvent("status-failed", error)))
      .finally(() => {
        checking = null;
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
    startDueStatus();
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
    let desired = changed;
    /** The identity that the box has after a sync: the snapshot identity, with its per-box instructions when it has them. */
    const want = (name: string) => desired.boxes?.[name] ?? desired.identity;
    if (names.every((name) => accepted[name] === want(name))) continue;
    const boxChange = names.some((name) => desired.boxes?.[name] !== undefined && accepted[name] !== desired.boxes[name]);
    if ((desired.identity !== published || boxChange) && observationKey(desired) !== settled) {
      const stable = await settle(desired, home, pollMs, debounceMs, observe, sleep, input.signal);
      if (!stable) continue;
      desired = stable;
      settled = observationKey(desired);
    }
    const identity = desired.identity;

    // Each box has its own backoff. The loop never sleeps for a backoff, so it observes and syncs the other boxes.
    const time = now();
    if (retry?.identity === identity && time < retry.at) continue;
    const ready = names.filter((name) => {
      const boxRetry = retries.get(name);
      return accepted[name] !== want(name) && (boxRetry?.identity !== want(name) || boxRetry.at <= time);
    });
    if (ready.length === 0) continue;
    const publish = identity !== published;

    let failures: Map<string, unknown>;
    let skipped: readonly string[];
    try {
      skipped = (await sync({ identity, home, boxes: ready, publish })) ?? [];
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
            for (const name of ready) accepted[name] = want(name);
            save();
          }
        }
        continue;
      }
      failures = boxes;
      skipped = error instanceof BoxesSyncError ? skippedBoxes(error.results) : [];
    }

    // The publish succeeded, and each box has its own result.
    retry = null;
    published = identity;
    for (const name of ready) {
      // The sync did not connect to a skipped box, so the box keeps its identity. The next cycle reads the config again.
      if (skipped.includes(name)) continue;
      const error = failures.get(name);
      if (error === undefined) {
        accepted[name] = want(name);
        retries.delete(name);
        statusDue = 0;
        note(`${prefix(name)}Synced Manifest ${identity.slice(0, 12)}.`, { type: "synced", box: name, manifest: identity });
      } else if (retryable(error)) {
        const previous = retries.get(name);
        const backoff = previous?.identity === want(name) ? Math.min(previous.backoff * 2, maxBackoffMs) : 1_000;
        retries.set(name, { identity: want(name), backoff, at: now() + backoff });
        note(
          `${prefix(name)}Watch sync failed; retrying in ${backoff} ms: ${messageOf(error)}`,
          errorEvent("sync-failed", error, { box: name, retryInMs: backoff }),
        );
      } else {
        accepted[name] = want(name);
        retries.delete(name);
        note(`${prefix(name)}Watch sync refused: ${messageOf(error)}`, errorEvent("sync-refused", error, { box: name }));
      }
    }
    save();
  }
  await updating;
  await checking;
  dependencies.emit?.({ type: "watch-stopped" });
}

/** The names of the boxes that the sync skipped. */
function skippedBoxes(results: readonly BoxSyncResult[]): string[] {
  return results.filter((result) => result.skipped !== undefined).map((result) => result.name);
}

/**
 * The error of each failed box, or null when the sync failed before the box
 * steps. With one box, sync throws the error of the box. A box step error has
 * the origin `box`, and refused per-box instructions have their own code.
 */
function boxFailures(error: unknown, boxes: readonly string[]): Map<string, unknown> | null {
  if (error instanceof BoxesSyncError) {
    return new Map(error.results.flatMap((result) => (result.failure ? [[result.name, result.failure.error]] : [])));
  }
  if (boxes.length === 1 && error instanceof SyncError && (error.origin === "box" || error.code === "box-instructions-refusal")) {
    return new Map([[boxes[0]!, error]]);
  }
  return null;
}

function configuredBoxNames(home: string): readonly string[] {
  return resolveBoxes(readConfig(home) ?? {}).map((box) => box.name);
}

/** The snapshot identity and the identity of each box with per-box instructions, as one string. */
function observationKey(observation: AcceptedObservation): string {
  return JSON.stringify([observation.identity, observation.boxes ?? {}]);
}

async function settle(
  first: AcceptedObservation,
  home: string,
  pollMs: number,
  debounceMs: number,
  observe: (home: string) => WatchObservation | Promise<WatchObservation>,
  sleep: (milliseconds: number, signal?: AbortSignal) => Promise<void>,
  signal?: AbortSignal,
): Promise<AcceptedObservation | null> {
  let desired = first;
  let stableFor = 0;
  while (stableFor < debounceMs && !signal?.aborted) {
    await sleep(Math.min(pollMs, debounceMs - stableFor), signal);
    const current = await observe(home);
    if (!current.ok) return null;
    if (observationKey(current) === observationKey(desired)) stableFor += pollMs;
    else {
      desired = current;
      stableFor = 0;
    }
  }
  return signal?.aborted ? null : desired;
}

async function observeSource(home: string): Promise<WatchObservation> {
  try {
    const source = inspectSyncSource(home);
    const identity = source.boxes.some((box) => box.integrations.paseo === true)
      ? paseoIdentity(home, source.seed.identity)
      : source.seed.identity;
    // Only a box with per-box instructions has its own identity, so an existing identity stays the same without them.
    const boxes: Record<string, string> = {};
    for (const box of source.boxes) {
      const instructions = readBoxInstructions(home, box.name);
      if (instructions) boxes[box.name] = createHash("sha256").update(identity).update(instructions.bytes).digest("hex");
    }
    return { ok: true, identity, boxes };
  } catch (error) {
    const message = messageOf(error);
    return { ok: false, signature: message, message, error };
  }
}

/** The identity of the portable set with the Paseo values that Ferry carries. */
function paseoIdentity(home: string, identity: string): string {
  const hash = createHash("sha256").update(identity).update(JSON.stringify(readPaseoPlugins(home)));
  // Only set providers change the identity, so an existing identity stays the same without them.
  const providers = readPaseoProviders(home);
  if (providers.providers.length > 0 || providers.warnings.length > 0) hash.update(JSON.stringify(providers));
  // Only set preferences change the identity, so an existing identity stays the same without them.
  const preferences = readPaseoPreferences(home);
  if (Object.keys(preferences).length > 0) hash.update(JSON.stringify(preferences));
  // Only a set terminal profile list changes the identity.
  const terminals = readPaseoTerminalProfiles(home);
  if (terminals !== null) hash.update(JSON.stringify(terminals));
  return hash.digest("hex");
}

export function isRetryableWatchError(error: unknown): boolean {
  if (!(error instanceof SyncError)) return false;
  if (error.code === "publish-failure") return !(error.cause instanceof StoreRefusal);
  if (error.code === "apply-failure") {
    return !(error.cause instanceof AdoptionRefusal) &&
      !(error.cause instanceof ApplyError && error.cause.code === "refused");
  }
  // A daily update or `ferry box remove --uninstall` holds the box lock for a time.
  return ["link-failure", "remote-update-failure", "concurrent-sync"].includes(error.code);
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

/** Replace the status file in one rename, so a reader never sees half a file. */
function writeStatusFile(home: string, report: BriefStatusReport): void {
  const path = join(home, ".ferry", "status.json");
  const temporary = `${path}.tmp`;
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(temporary, `${JSON.stringify(report)}\n`, { mode: 0o600 });
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
