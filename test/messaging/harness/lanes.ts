/**
 * The modules of the other #306 lanes that the integration suites start.
 *
 * The suites were written against the interfaces of design section 14 before the
 * lanes merged. This file loads each module only when its file exists, so a suite
 * skips with the name of the lane that it waits for, and `bun run typecheck` stays
 * green. A module that exists but fails to load is an error, not a skip.
 *
 * Lane A (the relay) is on `main`, and `system.ts` imports it statically. Until
 * lane B merges, `system.ts` uses the stand-ins of `interim.ts` for the lane B parts.
 * When all lanes are on `main`, replace this file with static imports and the real
 * types. Each type below is only the part of the interface that the harness calls.
 */

import { existsSync } from "node:fs";
import { join } from "node:path";
import type { Clock } from "./clock.ts";
import type { CreateFakeRuntimes, StartFakeGitHub } from "./contracts.ts";

const REPO = join(import.meta.dir, "..", "..", "..");

/** Design 14.2. */
export type GitHubAccessModule = {
  createGitHubAccess(config: {
    readonly appId: number;
    readonly clientId: string;
    readonly slug: string;
    readonly privateKeyPem: string;
    readonly apiUrl: string;
    readonly webUrl: string;
    readonly clock: Clock;
  }): unknown;
};

/** Design 14.2. */
export type RelayClientModule = {
  RelayClient: new (options: { readonly url: string; readonly credential: string; readonly ferryVersion: string }) => unknown;
};

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
  readonly github: GitHubAccessModule | null;
  readonly client: RelayClientModule | null;
  readonly worker: WorkerModule | null;
  readonly fakeGitHub: { readonly startFakeGitHub: StartFakeGitHub } | null;
  readonly fakeRuntimes: { readonly createFakeRuntimes: CreateFakeRuntimes } | null;
  /** Lane D: `ferry messaging worker`, `hook`, and `mcp` exist in the CLI. */
  readonly cli: boolean;
};

type LaneKey = Exclude<keyof Lanes, "cli">;

const FILES: Record<LaneKey | "cli", { readonly lane: string; readonly file: string }> = {
  github: { lane: "B", file: "src/messaging/github/access.ts" },
  client: { lane: "B", file: "src/messaging/client/relay-client.ts" },
  fakeGitHub: { lane: "B", file: "test/messaging/fakes/github.ts" },
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
  github: await load<GitHubAccessModule>("github"),
  client: await load<RelayClientModule>("client"),
  worker: await load<WorkerModule>("worker"),
  fakeGitHub: await load<{ startFakeGitHub: StartFakeGitHub }>("fakeGitHub"),
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

/** The parts that the layer 2 system needs. The lane B parts have stand-ins in `interim.ts`. */
export const SYSTEM_PARTS: readonly (keyof Lanes)[] = ["worker", "fakeRuntimes"];

/** The suite title, with the missing lanes when the suite skips. */
export function suiteTitle(title: string, needed: readonly (keyof Lanes)[] = SYSTEM_PARTS): string {
  const waiting = waitingFor(needed);
  return waiting.length === 0 ? title : `${title} (waits for ${waiting.join(", ")})`;
}
