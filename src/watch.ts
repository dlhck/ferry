/** Poll Manifest identity and run the existing sync workflow in the foreground. */

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { inspectSyncSource, runSync, SyncError } from "./sync.ts";
import { AdoptionRefusal } from "./adopt.ts";
import { ApplyError } from "./apply.ts";
import { StoreRefusal } from "./store.ts";
import { runUpdateCommand } from "./update.ts";
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
  /** Run the tool update once each 24 hours. The `[update]` config key `watch` sets it. */
  readonly dailyUpdate?: boolean;
};

export type WatchObservation =
  | { readonly ok: true; readonly identity: string }
  | { readonly ok: false; readonly signature: string; readonly message: string };

export type WatchDependencies = {
  readonly observe?: (home: string) => WatchObservation | Promise<WatchObservation>;
  readonly sync?: (identity: string, home: string) => Promise<void>;
  readonly isRetryable?: (error: unknown) => boolean;
  readonly sleep?: (milliseconds: number, signal?: AbortSignal) => Promise<void>;
  readonly readState?: (home: string) => string | null;
  readonly writeState?: (home: string, identity: string) => void;
  readonly writeLine?: (line: string) => void;
  readonly update?: () => Promise<void>;
  readonly now?: () => number;
  readonly readUpdateState?: (home: string) => number | null;
  readonly writeUpdateState?: (home: string, time: number) => void;
  /** The reporter for the default sync and update. */
  readonly progress?: Progress;
};

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
    (async (_identity, sourceHome) => { await runSync({ home: sourceHome }, { progress }); });
  const retryable = dependencies.isRetryable ?? isRetryableWatchError;
  const writeLine = dependencies.writeLine ?? console.log;
  const readState = dependencies.readState ?? readWatchState;
  const writeState = dependencies.writeState ?? writeWatchState;
  let accepted = readState(home);
  let refusal = "";
  const update = dependencies.update ??
    (() => runUpdateCommand({ yes: true, dryRun: false }, { writeLine, progress }));
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
    writeLine("Running the daily tool update.");
    updating = update()
      .catch((error) => writeLine(`Watch update failed: ${messageOf(error)}`))
      .finally(() => {
        updating = null;
      });
  };

  const initial = await observe(home);
  if (initial.ok) {
    if (accepted === null) accepted = initial.identity;
  } else {
    refusal = initial.signature;
    writeLine(`Watch refused content: ${initial.message}`);
  }
  writeLine("Ferry watch is running.");

  while (!input.signal?.aborted) {
    startDueUpdate();
    await sleep(pollMs, input.signal);
    if (input.signal?.aborted) break;
    const changed = await observe(home);
    if (!changed.ok) {
      if (changed.signature !== refusal) writeLine(`Watch refused content: ${changed.message}`);
      refusal = changed.signature;
      continue;
    }
    refusal = "";
    if (changed.identity === accepted) continue;

    let desired = await settle(changed.identity, home, pollMs, debounceMs, observe, sleep, input.signal);
    if (!desired) continue;
    let backoff = 1_000;
    for (;;) {
      try {
        await sync(desired, home);
        accepted = desired;
        writeState(home, desired);
        writeLine(`Synced Manifest ${desired.slice(0, 12)}.`);
        break;
      } catch (error) {
        if (!retryable(error)) {
          writeLine(`Watch sync refused: ${messageOf(error)}`);
          if (!isManifestReadFailure(error)) {
            accepted = desired;
            writeState(home, desired);
          }
          break;
        }
        writeLine(`Watch sync failed; retrying in ${backoff} ms: ${messageOf(error)}`);
        await sleep(backoff, input.signal);
        if (input.signal?.aborted) break;
        const latest = await observe(home);
        if (!latest.ok) {
          writeLine(`Watch refused content: ${latest.message}`);
          refusal = latest.signature;
          break;
        }
        if (latest.identity !== desired) {
          desired = latest.identity;
          backoff = 1_000;
        } else {
          backoff = Math.min(backoff * 2, maxBackoffMs);
        }
      }
    }
  }
  await updating;
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
    return { ok: false, signature: message, message };
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

function readWatchState(home: string): string | null {
  const path = statePath(home);
  if (!existsSync(path)) return null;
  try {
    const value: unknown = JSON.parse(readFileSync(path, "utf8"));
    const state = value as { version?: unknown; identity?: unknown };
    return state.version === 1 && typeof state.identity === "string" ? state.identity : null;
  } catch {
    return null;
  }
}

function writeWatchState(home: string, identity: string): void {
  const path = statePath(home);
  const temporary = `${path}.tmp`;
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(temporary, `${JSON.stringify({ version: 1, identity })}\n`, { mode: 0o600 });
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
