/**
 * The modules of the other #306 lanes that the integration suites start.
 *
 * The suites were written against the interfaces of design section 14 before the
 * lanes merged. This file loads each module only when its file exists, so a suite
 * skips with the name of the lane that it waits for, and `bun run typecheck` stays
 * green. A module that exists but fails to load is an error, not a skip.
 *
 * Lanes A (the relay) and B (GitHub access, the relay client, and the fake GitHub)
 * are on `main`, and `system.ts` imports them statically. When all lanes are on `main`, replace this file with static imports and the real
 * types. Each type below is only the part of the interface that the harness calls.
 */

import { existsSync } from "node:fs";
import { join } from "node:path";
import type { Clock } from "./clock.ts";
import type { CreateFakeRuntimes } from "./contracts.ts";

const REPO = join(import.meta.dir, "..", "..", "..");

/** Design 14.3. */
export type WorkerModule = {
  runWorker(options: {
    readonly home: string;
    readonly client: unknown;
    readonly adapters: readonly unknown[];
    readonly clock: Clock;
  }): Promise<{ stop(): Promise<void> }>;
};

export type Lanes = {
  readonly worker: WorkerModule | null;
  readonly fakeRuntimes: { readonly createFakeRuntimes: CreateFakeRuntimes } | null;
  /** Lane D: `ferry messaging worker`, `hook`, and `mcp` exist in the CLI. */
  readonly cli: boolean;
};

type LaneKey = Exclude<keyof Lanes, "cli">;

const FILES: Record<LaneKey | "cli", { readonly lane: string; readonly file: string }> = {
  worker: { lane: "C", file: "src/messaging/worker/worker.ts" },
  fakeRuntimes: { lane: "C", file: "test/messaging/fakes/runtimes.ts" },
  cli: { lane: "D", file: "src/messaging/commands.ts" },
};

async function load<T>(key: LaneKey): Promise<T | null> {
  const path = join(REPO, FILES[key].file);
  if (!existsSync(path)) return null;
  return (await import(path)) as T;
}

export const lanes: Lanes = {
  worker: await load<WorkerModule>("worker"),
  fakeRuntimes: await load<{ createFakeRuntimes: CreateFakeRuntimes }>("fakeRuntimes"),
  cli: existsSync(join(REPO, FILES.cli.file)),
};

/**
 * The missing parts among `needed`, as "lane A (src/messaging/relay/server.ts)".
 * Empty when all are present.
 */
export function waitingFor(needed: readonly (keyof Lanes)[]): string[] {
  return needed
    .filter((key) => (key === "cli" ? !lanes.cli : lanes[key] === null))
    .map((key) => `lane ${FILES[key].lane} (${FILES[key].file})`);
}

/** The parts that the layer 2 system needs. */
export const SYSTEM_PARTS: readonly (keyof Lanes)[] = ["worker", "fakeRuntimes"];

/** The suite title, with the missing lanes when the suite skips. */
export function suiteTitle(title: string, needed: readonly (keyof Lanes)[] = SYSTEM_PARTS): string {
  const waiting = waitingFor(needed);
  return waiting.length === 0 ? title : `${title} (waits for ${waiting.join(", ")})`;
}
