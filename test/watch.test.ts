import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  isRetryableWatchError,
  runWatch,
  type WatchObservation,
  type WatchState,
  type WatchStateRecord,
  type WatchSyncRequest,
} from "../src/watch.ts";
import { StoreRefusal } from "../src/store.ts";
import { BoxesSyncError, runSync, SyncError, type SyncPlan } from "../src/sync.ts";
import type { Seed } from "../src/manifest.ts";
import { createPaseo } from "../src/integrations/paseo.ts";
import type { Integration } from "../src/integrations/types.ts";
import { runUpdateCommand } from "../src/update.ts";
import { FerryError } from "../src/errors.ts";
import type { BriefStatusReport } from "../src/status.ts";

function accepted(identity: string): WatchObservation {
  return { ok: true, identity };
}

describe("watch", () => {
  test("does not sync unchanged content after startup", async () => {
    const controller = new AbortController();
    let scans = 0;
    let syncs = 0;

    await runWatch(
      { signal: controller.signal, pollMs: 1, debounceMs: 2 },
      {
        observe: () => {
          scans += 1;
          if (scans === 3) controller.abort();
          return accepted("one");
        },
        sync: async () => {
          syncs += 1;
        },
        sleep: async () => {},
        readBoxes: () => ["default"],
        readState: () => null,
        writeState: () => {},
        writeLine: () => {},
      },
    );

    expect(syncs).toBe(0);
  });

  test("coalesces edits and runs one follow-up for a change during sync", async () => {
    const controller = new AbortController();
    let current = "one";
    const identities = ["one", "two", "three", "three", "three"];
    let index = 0;
    const synced: string[] = [];

    await runWatch(
      { signal: controller.signal, pollMs: 1, debounceMs: 2 },
      {
        observe: () => accepted(identities[index++] ?? current),
        sync: async ({ identity }) => {
          synced.push(identity);
          if (identity === "three") current = "four";
          else controller.abort();
        },
        sleep: async () => {},
        readBoxes: () => ["default"],
        readState: () => null,
        writeState: () => {},
        writeLine: () => {},
      },
    );

    expect(synced).toEqual(["three", "four"]);
  });

  test("retries transport failures with capped backoff and never sleeps for the backoff", async () => {
    const controller = new AbortController();
    let scans = 0;
    let time = 0;
    const attempts: number[] = [];
    const sleeps = new Set<number>();
    const lines: string[] = [];

    await runWatch(
      { signal: controller.signal, pollMs: 100, debounceMs: 100, maxBackoffMs: 4_000 },
      {
        observe: () => accepted(scans++ === 0 ? "one" : "two"),
        sync: async () => {
          attempts.push(time);
          if (attempts.length < 4) throw new SyncError("link-failure", "box", "offline");
          controller.abort();
        },
        sleep: async (milliseconds) => {
          sleeps.add(milliseconds);
          time += milliseconds;
        },
        now: () => time,
        readBoxes: () => ["default"],
        readState: () => null,
        writeState: () => {},
        writeLine: (line) => lines.push(line),
      },
    );

    expect(attempts).toHaveLength(4);
    expect([...sleeps]).toEqual([100]);
    expect(lines.filter((line) => line.startsWith("Watch sync failed"))).toEqual([
      "Watch sync failed; retrying in 1000 ms: box: offline",
      "Watch sync failed; retrying in 2000 ms: box: offline",
      "Watch sync failed; retrying in 4000 ms: box: offline",
    ]);
    expect(attempts[1]! - attempts[0]!).toBeGreaterThanOrEqual(1_000);
    expect(attempts[3]! - attempts[2]!).toBeGreaterThanOrEqual(4_000);
    expect(attempts[3]! - attempts[2]!).toBeLessThan(4_200);
  });

  test("reports a refusal once and waits for content to change", async () => {
    const controller = new AbortController();
    const observations: WatchObservation[] = [
      accepted("one"),
      { ok: false, signature: "secret:/home/me/.agents/skills/x/.env", message: "secret: /home/me/.agents/skills/x/.env" },
      { ok: false, signature: "secret:/home/me/.agents/skills/x/.env", message: "secret: /home/me/.agents/skills/x/.env" },
      accepted("one"),
    ];
    const lines: string[] = [];
    let index = 0;

    await runWatch(
      { signal: controller.signal, pollMs: 1, debounceMs: 1 },
      {
        observe: () => {
          const value = observations[Math.min(index++, observations.length - 1)]!;
          if (index === observations.length) controller.abort();
          return value;
        },
        sync: async () => {},
        sleep: async () => {},
        readBoxes: () => ["default"],
        readState: () => null,
        writeState: () => {},
        writeLine: (line) => lines.push(line),
      },
    );

    expect(lines.filter((line) => line.includes("secret:"))).toHaveLength(1);
  });

  test("remembers a non-retryable refusal across restarts", async () => {
    const controller = new AbortController();
    let scans = 0;
    const states: WatchStateRecord[] = [];

    await runWatch(
      { signal: controller.signal, pollMs: 1, debounceMs: 1 },
      {
        observe: () => accepted(scans++ === 0 ? "one" : "two"),
        sync: async () => {
          controller.abort();
          throw new Error("content conflict");
        },
        sleep: async () => {},
        readBoxes: () => ["default"],
        readState: () => null,
        writeState: (_home, state) => states.push(state),
        writeLine: () => {},
      },
    );

    expect(states.at(-1)).toEqual({ published: "one", boxes: { default: "two" } });
  });

  test("does not retry a store conflict", () => {
    const conflict = new SyncError(
      "publish-failure",
      "git remote",
      "remote differs",
      { cause: new StoreRefusal("remote-clash", "snapshot differs") },
    );

    expect(isRetryableWatchError(conflict)).toBe(false);
    expect(isRetryableWatchError(new SyncError("publish-failure", "git remote", "offline"))).toBe(true);
  });
});

describe("watch events", () => {
  function run(observations: WatchObservation[], sync: (request: WatchSyncRequest) => Promise<void>) {
    const controller = new AbortController();
    const events: unknown[] = [];
    const lines: string[] = [];
    let index = 0;
    const done = runWatch(
      { signal: controller.signal, pollMs: 1, debounceMs: 1 },
      {
        observe: () => {
          const value = observations[Math.min(index++, observations.length - 1)]!;
          if (index >= observations.length) controller.abort();
          return value;
        },
        sync,
        sleep: async () => {},
        now: () => 0,
        readBoxes: () => ["default"],
        readState: () => null,
        writeState: () => {},
        writeLine: (line) => lines.push(line),
        emit: (event) => events.push(event),
      },
    );
    return { done, events, lines };
  }

  test("prints one event for each watch line: start, sync, refused content, and stop", async () => {
    const refusal = new SyncError("manifest-refusal", "operator", "Manifest refused publisher me: environment file: /home/me/.env", {
      cause: new FerryError("deny-rule-match", "environment file: /home/me/.env"),
    });
    const watch = run(
      [accepted("one"), accepted("two"), accepted("two"), { ok: false, signature: "env", message: refusal.message, error: refusal }],
      async () => {},
    );
    await watch.done;

    expect(watch.events).toEqual([
      { type: "watch-started", boxes: ["default"] },
      { type: "synced", box: "default", manifest: "two" },
      { type: "content-refused", code: "deny-rule-match", message: refusal.message, hint: expect.any(String) },
      { type: "watch-stopped" },
    ]);
    expect(watch.lines).toEqual([
      "Ferry watch is running.",
      "Synced Manifest two.",
      `Watch refused content: ${refusal.message}`,
    ]);
  });

  test("a failed box sync is an error event with the code, the box, and the retry wait", async () => {
    const offline = new SyncError("link-failure", "box", "failed to resolve home on box: network/host-offline: box is offline", {
      cause: new FerryError("box-offline", "network/host-offline: box is offline"),
    });
    const watch = run([accepted("one"), accepted("two"), accepted("two"), accepted("two")], async () => {
      throw offline;
    });
    await watch.done;

    expect(watch.events).toContainEqual({
      type: "sync-failed",
      box: "default",
      retryInMs: 1_000,
      code: "box-offline",
      message: offline.message,
      hint: expect.any(String),
    });
  });
});

describe("multi-box watch", () => {
  const offline = () => new SyncError("link-failure", "box", "box-b.example is offline");
  const boxFailure = (ok: readonly string[], failed: readonly string[]) =>
    new BoxesSyncError([
      ...ok.map((name) => ({ name, plan: {} as SyncPlan })),
      ...failed.map((name) => ({ name, plan: {} as SyncPlan, failure: { step: "Connecting", error: offline() } })),
    ], true);

  /**
   * Run the watch on a fake clock. Each poll advances the clock by `pollMs`.
   * `script` gives the identity and the box names of each poll, and ends the watch when it returns null.
   */
  async function watchBoxes(options: {
    readonly state?: WatchState | null;
    readonly script: (poll: number) => { readonly identity: string; readonly boxes: readonly string[] } | null;
    readonly sync?: (request: WatchSyncRequest, time: number) => Promise<void>;
    readonly pollMs?: number;
  }) {
    const controller = new AbortController();
    const pollMs = options.pollMs ?? 100;
    let time = 0;
    let poll = 0;
    let current = options.script(0)!;
    const record = {
      requests: [] as (WatchSyncRequest & { time: number })[],
      states: [] as WatchStateRecord[],
      lines: [] as string[],
      sleeps: new Set<number>(),
      observes: [] as number[],
    };
    await runWatch(
      { signal: controller.signal, pollMs, debounceMs: pollMs },
      {
        observe: () => {
          record.observes.push(time);
          return accepted(current.identity);
        },
        readBoxes: () => current.boxes,
        sync: async (request) => {
          record.requests.push({ ...request, time });
          await options.sync?.(request, time);
        },
        sleep: async (milliseconds) => {
          record.sleeps.add(milliseconds);
          time += milliseconds;
          poll += 1;
          const next = options.script(poll);
          if (next === null) controller.abort();
          else current = next;
        },
        now: () => time,
        readState: () => options.state === undefined ? { published: "one", boxes: { a: "one", b: "one" } } : options.state,
        writeState: (_home, state) => record.states.push(state),
        writeLine: (line) => record.lines.push(line),
      },
    );
    return record;
  }

  test("an offline box does not stop the sync of the other box", async () => {
    const record = await watchBoxes({
      script: (poll) => (poll > 4 ? null : { identity: poll === 0 ? "one" : "two", boxes: ["a", "b"] }),
      sync: async (request) => {
        if (request.boxes.includes("b")) throw boxFailure(request.boxes.filter((name) => name !== "b"), ["b"]);
      },
    });

    expect(record.requests[0]).toMatchObject({ identity: "two", boxes: ["a", "b"], publish: true });
    expect(record.states.at(-1)).toEqual({ published: "two", boxes: { a: "two", b: "one" } });
    expect(record.lines).toContain("[a] Synced Manifest two.");
    expect(record.lines).toContain(
      "[b] Watch sync failed; retrying in 1000 ms: box: box-b.example is offline",
    );
  });

  test("the backoff of one box does not block the observe loop or a new change", async () => {
    const record = await watchBoxes({
      // The Manifest changes to "three" 500 ms after the first failure of b. Box b is still in its backoff then.
      script: (poll) => (poll > 12 ? null : { identity: poll === 0 ? "one" : poll < 7 ? "two" : "three", boxes: ["a", "b"] }),
      sync: async (request) => {
        if (request.identity === "two" && request.boxes.includes("b")) {
          throw boxFailure(request.boxes.filter((name) => name !== "b"), ["b"]);
        }
      },
    });

    expect([...record.sleeps]).toEqual([100]);
    const failed = record.requests[0]!;
    expect(failed).toMatchObject({ identity: "two", boxes: ["a", "b"], publish: true });
    // The loop observes during the backoff of b.
    expect(record.observes.filter((time) => time > failed.time && time < failed.time + 1_000).length).toBeGreaterThan(3);
    expect(record.requests[1]).toMatchObject({ identity: "three", boxes: ["a", "b"], publish: true });
    expect(record.requests[1]!.time - failed.time).toBeLessThan(1_000);
    expect(record.states.at(-1)).toEqual({ published: "three", boxes: { a: "three", b: "three" } });
  });

  test("a due box retry syncs that box only and does not publish again", async () => {
    let failures = 0;
    const record = await watchBoxes({
      script: (poll) => (poll > 50 ? null : { identity: poll === 0 ? "one" : "two", boxes: ["a", "b"] }),
      sync: async (request) => {
        if (request.boxes.includes("b") && failures < 2) {
          failures += 1;
          const others = request.boxes.filter((name) => name !== "b");
          throw others.length > 0 ? boxFailure(others, ["b"]) : offline();
        }
      },
    });

    expect(record.requests.map(({ boxes, publish }) => ({ boxes, publish }))).toEqual([
      { boxes: ["a", "b"], publish: true },
      { boxes: ["b"], publish: false },
      { boxes: ["b"], publish: false },
    ]);
    const [first, second, third] = record.requests;
    expect(second!.time - first!.time).toBeGreaterThanOrEqual(1_000);
    expect(third!.time - second!.time).toBeGreaterThanOrEqual(2_000);
    expect(record.lines).toContain("[b] Watch sync failed; retrying in 2000 ms: box: box-b.example is offline");
    expect(record.states.at(-1)).toEqual({ published: "two", boxes: { a: "two", b: "two" } });
  });

  test("the default sync publishes once, and a box retry applies the published tip to the retried box only", async () => {
    const home = mkdtempSync(join(tmpdir(), "ferry-watch-retry-"));
    try {
      const seed: Seed = {
        ok: true,
        skills: [],
        instructions: null,
        roots: [],
        settings: [],
        mcp: [],
        identity: "two",
        leftovers: [],
        storeUpdates: [],
      };
      const box = (name: string) => ({ name, host: { transport: "ssh" as const, destination: `dev@box-${name}.example` } });
      const events: string[] = [];
      let bOffline = true;
      const controller = new AbortController();
      let time = 0;
      await runWatch(
        { home, signal: controller.signal, pollMs: 100, debounceMs: 100 },
        {
          observe: () => accepted("two"),
          readBoxes: () => ["a", "b"],
          sleep: async (milliseconds) => {
            time += milliseconds;
            if (time > 3_000) controller.abort();
          },
          now: () => time,
          readState: () => ({ published: "one", boxes: { a: "one", b: "one" } }),
          writeState: () => {},
          writeLine: () => {},
          runSync: (input, dependencies) =>
            runSync(input, {
              ...dependencies,
              readConfig: () => ({
                version: 1,
                publisher: "operator-machine",
                snapshotUrl: "git@example.test:operator/ferry-store.git",
                boxes: [box("a"), box("b")],
              }),
              publisher: () => "operator-machine",
              readSeed: () => seed,
              createLink: (target) => {
                const name = /box-([a-z]+)\./.exec((target as { destination: string }).destination)![1]!;
                return {
                  run: async (command) => {
                    if (command.startsWith("printf")) {
                      if (name === "b" && bOffline) {
                        bOffline = false;
                        return { ok: false, error: { origin: "network", code: "host-offline", message: "no route" } };
                      }
                      return { ok: true, address: name, stdout: `/home/${name}\n`, stderr: "" };
                    }
                    if (command.includes("git clone")) events.push(`${name}:update ${/reset --quiet --hard (\S+)/.exec(command)![1]}`);
                    return { ok: true, address: name, stdout: "", stderr: "" };
                  },
                };
              },
              openStore: async () => ({
                path: join(home, ".ferry", "store"),
                publish: async () => {
                  events.push("publish");
                  return { published: true, tip: "abc123" };
                },
              }),
              apply: async (applyInput) => {
                events.push(`${applyInput.targetHome}:apply`);
                return { checkout: applyInput.checkout, targetHome: applyInput.targetHome, actions: [], unmanaged: [] };
              },
              adopt: () => {},
              writePlan: () => {},
              writeLine: () => {},
            }),
        },
      );

      expect(events).toEqual([
        "publish",
        "a:update 'abc123'",
        "/home/a:apply",
        "b:update '@{upstream}'",
        "/home/b:apply",
      ]);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test("reads the config each cycle: a new box syncs, and a removed box leaves the state", async () => {
    const record = await watchBoxes({
      script: (poll) =>
        poll > 6 ? null : { identity: "one", boxes: poll < 3 ? ["a", "b"] : poll < 5 ? ["a", "b", "c"] : ["a", "c"] },
    });

    expect(record.requests.map(({ identity, boxes, publish }) => ({ identity, boxes, publish }))).toEqual([
      { identity: "one", boxes: ["c"], publish: false },
    ]);
    expect(record.states.at(-1)).toEqual({ published: "one", boxes: { a: "one", c: "one" } });
  });

  test("a version 1 state file is the accepted identity of each configured box, and the watch writes version 2", async () => {
    const home = mkdtempSync(join(tmpdir(), "ferry-watch-"));
    try {
      const path = join(home, ".ferry", "watch-state.json");
      mkdirSync(join(home, ".ferry"));
      writeFileSync(path, `${JSON.stringify({ version: 1, identity: "one" })}\n`);
      const controller = new AbortController();
      let scans = 0;
      const requests: WatchSyncRequest[] = [];

      await runWatch(
        { home, signal: controller.signal, pollMs: 1, debounceMs: 1 },
        {
          observe: () => {
            scans += 1;
            if (scans > 3) controller.abort();
            return accepted("one");
          },
          readBoxes: () => ["a", "b"],
          sync: async (request) => { requests.push(request); },
          sleep: async () => {},
          writeLine: () => {},
        },
      );

      expect(requests).toEqual([]);
      expect(JSON.parse(readFileSync(path, "utf8"))).toEqual({ version: 2, published: "one", boxes: { a: "one", b: "one" } });
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test("a [host] config watches the box default with plain lines and no prefix", async () => {
    const home = mkdtempSync(join(tmpdir(), "ferry-watch-"));
    try {
      mkdirSync(join(home, ".ferry"));
      writeFileSync(
        join(home, ".ferry", "config.toml"),
        ['version = 1', 'publisher = "operator"', 'snapshot_url = "snapshot.git"', "", "[host]", 'tailscale = "box"', 'ssh_user = "ferry"', ""].join("\n"),
      );
      const controller = new AbortController();
      let scans = 0;
      const requests: WatchSyncRequest[] = [];
      const lines: string[] = [];

      await runWatch(
        { home, signal: controller.signal, pollMs: 1, debounceMs: 1 },
        {
          observe: () => {
            scans += 1;
            if (scans > 3) controller.abort();
            return accepted(scans === 1 ? "one" : "two");
          },
          sync: async (request) => { requests.push(request); },
          sleep: async () => {},
          writeLine: (line) => lines.push(line),
        },
      );

      expect(requests).toEqual([{ identity: "two", home, boxes: ["default"], publish: true }]);
      expect(lines).toContain("Synced Manifest two.");
      expect(JSON.parse(readFileSync(join(home, ".ferry", "watch-state.json"), "utf8"))).toEqual({
        version: 2,
        published: "two",
        boxes: { default: "two" },
      });
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});

describe("watch daily update", () => {
  const DAY_MS = 24 * 60 * 60 * 1_000;

  function watchWithUpdate(options: {
    readonly dailyUpdate?: boolean;
    readonly lastRun: number | null;
    readonly now: number;
    readonly polls?: number;
    readonly update?: () => Promise<void>;
  }) {
    const controller = new AbortController();
    const record = { updates: 0, syncs: 0, writes: [] as number[], output: [] as string[] };
    let scans = 0;
    const run = runWatch(
      { signal: controller.signal, pollMs: 1, debounceMs: 1, dailyUpdate: options.dailyUpdate },
      {
        observe: () => {
          scans += 1;
          if (scans > (options.polls ?? 3)) controller.abort();
          return accepted(scans === 1 ? "one" : "two");
        },
        sync: async () => {
          record.syncs += 1;
        },
        sleep: async () => {},
        readBoxes: () => ["default"],
        readState: () => null,
        writeState: () => {},
        writeLine: (line) => record.output.push(line),
        now: () => options.now,
        readUpdateState: () => record.writes.at(-1) ?? options.lastRun,
        writeUpdateState: (_home, time) => record.writes.push(time),
        update: async () => {
          record.updates += 1;
          await options.update?.();
        },
      },
    );
    return { run, record };
  }

  test("runs no update unless the config enables it", async () => {
    const { run, record } = watchWithUpdate({ lastRun: null, now: DAY_MS * 10 });
    await run;

    expect(record.updates).toBe(0);
    expect(record.writes).toEqual([]);
  });

  test("runs one update and records the start time when none ran before", async () => {
    const now = DAY_MS * 10;
    const { run, record } = watchWithUpdate({ dailyUpdate: true, lastRun: null, now });
    await run;

    expect(record.updates).toBe(1);
    expect(record.writes).toEqual([now]);
    expect(record.syncs).toBe(1);
  });

  test("a restart within 24 hours of the last run does not start an update", async () => {
    const now = DAY_MS * 10;
    const { run, record } = watchWithUpdate({ dailyUpdate: true, lastRun: now - DAY_MS + 1, now });
    await run;

    expect(record.updates).toBe(0);
  });

  test("runs again once 24 hours passed since the last run", async () => {
    const now = DAY_MS * 10;
    const { run, record } = watchWithUpdate({ dailyUpdate: true, lastRun: now - DAY_MS, now });
    await run;

    expect(record.updates).toBe(1);
  });

  test("a failed update prints a warning and the sync continues", async () => {
    const { run, record } = watchWithUpdate({
      dailyUpdate: true,
      lastRun: null,
      now: DAY_MS * 10,
      update: async () => {
        throw new Error("1 of 5 updates failed: box claude");
      },
    });
    await run;

    expect(record.output).toContain("Watch update failed: 1 of 5 updates failed: box claude");
    expect(record.syncs).toBe(1);
  });

  test("the sync does not wait for a running update", async () => {
    let finish = () => {};
    const { run, record } = watchWithUpdate({
      dailyUpdate: true,
      lastRun: null,
      now: DAY_MS * 10,
      update: () => new Promise<void>((resolve) => { finish = resolve; }),
    });
    await Promise.resolve();
    await new Promise((resolve) => setTimeout(resolve, 10));

    expect(record.syncs).toBe(1);
    finish();
    await run;
    expect(record.updates).toBe(1);
  });

  test("the default daily update never includes the integrations, also when Paseo is enabled", async () => {
    const controller = new AbortController();
    const inputs: unknown[] = [];
    const paseoCalls: string[] = [];
    let scans = 0;
    const paseo: Integration = {
      ...createPaseo({ platform: "win32" }),
      plan: async () => [],
      update: async () => {
        paseoCalls.push("update");
        return [];
      },
    };

    await runWatch(
      { signal: controller.signal, pollMs: 1, debounceMs: 1, dailyUpdate: true },
      {
        observe: () => {
          scans += 1;
          if (scans > 1) controller.abort();
          return accepted("one");
        },
        sleep: async () => {},
        readBoxes: () => ["default"],
        readState: () => null,
        writeState: () => {},
        writeLine: () => {},
        now: () => DAY_MS * 10,
        readUpdateState: () => null,
        writeUpdateState: () => {},
        runUpdate: (input, dependencies) => {
          inputs.push(input);
          return runUpdateCommand(input, {
            ...dependencies,
            tools: [],
            integrations: [paseo],
            readConfig: () => ({ host: { transport: "ssh", destination: "ploi@box" }, integrations: { paseo: true } }),
            createLink: () => ({ run: async () => ({ ok: true, address: "box", stdout: "", stderr: "" }) }),
            local: { run: async () => ({ exitCode: 1, stdout: "", stderr: "", timedOut: false }) },
          });
        },
      },
    );

    expect(inputs).toEqual([{ yes: true, dryRun: false, includeIntegrations: false, latestOnly: true }]);
    expect(paseoCalls).toEqual([]);
  });

  test("the default daily update changes only the tools whose policy is latest", async () => {
    const controller = new AbortController();
    const boxCommands: string[] = [];
    const localCommands: string[] = [];
    let scans = 0;
    const tool = (id: string, kind: "agent" | "tool") => ({
      id,
      kind,
      localVersion: `${id} --version`,
      boxVersion: `${id} --version`,
      install: { command: `install ${id}` },
      update: { command: `${id} update`, binary: id },
    });

    await runWatch(
      { signal: controller.signal, pollMs: 1, debounceMs: 1, dailyUpdate: true },
      {
        observe: () => {
          scans += 1;
          if (scans > 1) controller.abort();
          return accepted("one");
        },
        sleep: async () => {},
        readBoxes: () => ["default"],
        readState: () => null,
        writeState: () => {},
        writeLine: () => {},
        now: () => DAY_MS * 10,
        readUpdateState: () => null,
        writeUpdateState: () => {},
        runUpdate: (input, dependencies) =>
          runUpdateCommand(input, {
            ...dependencies,
            // gh follows the operator version, codex an exact version, and claude the latest release.
            tools: [tool("gh", "tool"), tool("claude", "agent"), tool("codex", "agent")],
            integrations: [],
            readConfig: () => ({ host: { transport: "ssh", destination: "user@box.example" }, tools: { codex: "0.156.1" } }),
            createLink: () => ({
              run: async (command) => {
                // Skip the version reads and the reach check of the box.
                if (!command.includes('cd "$HOME"') && command !== "true") boxCommands.push(command);
                return { ok: true, address: "box", stdout: command.includes("--version") ? "1.0.0" : "", stderr: "" };
              },
            }),
            local: {
              run: async (command) => {
                const script = command.argv.at(-1) ?? "";
                if (script.startsWith("command -v ")) return { exitCode: 0, stdout: "", stderr: "", timedOut: false };
                if (!script.includes('cd "$HOME"')) localCommands.push(script);
                return { exitCode: 0, stdout: "2.0.0", stderr: "", timedOut: false };
              },
            },
          }),
      },
    );

    expect(boxCommands).toEqual(["claude update"]);
    expect(localCommands).toEqual(["claude update"]);
  });

  test("the daily update runs once for all boxes, and skips and logs an offline box", async () => {
    const controller = new AbortController();
    const boxCommands: string[] = [];
    const output: string[] = [];
    let scans = 0;
    let updates = 0;
    let lastRun: number | null = null;

    await runWatch(
      { signal: controller.signal, pollMs: 1, debounceMs: 1, dailyUpdate: true },
      {
        observe: () => {
          scans += 1;
          if (scans > 5) controller.abort();
          return accepted("one");
        },
        sleep: async () => {},
        readBoxes: () => ["a", "b"],
        readState: () => null,
        writeState: () => {},
        writeLine: (line) => output.push(line),
        now: () => DAY_MS * 10,
        readUpdateState: () => lastRun,
        writeUpdateState: (_home, time) => { lastRun = time; },
        runUpdate: (input, dependencies) => {
          updates += 1;
          return runUpdateCommand(input, {
            ...dependencies,
            tools: [{
              id: "claude",
              kind: "agent",
              localVersion: "claude --version",
              boxVersion: "claude --version",
              install: { command: "install claude" },
              update: { command: "claude update", binary: "claude" },
            }],
            integrations: [],
            readConfig: () => ({
              tools: { claude: "latest" },
              boxes: [
                { name: "a", host: { transport: "ssh", destination: "dev@box-a.example" } },
                { name: "b", host: { transport: "ssh", destination: "dev@box-b.example" } },
              ],
            }),
            createLink: (options) => ({
              run: async (command) => {
                if ("destination" in options && options.destination === "dev@box-b.example") {
                  return { ok: false, error: { code: "ssh-failed", origin: "box", message: "box-b.example is offline" } };
                }
                if (!command.includes('cd "$HOME"') && command !== "true") boxCommands.push(`a: ${command}`);
                return { ok: true, address: "box", stdout: command.includes("--version") ? "1.0.0" : "", stderr: "" };
              },
            }),
            local: { run: async () => ({ exitCode: 1, stdout: "", stderr: "", timedOut: false }) },
          });
        },
      },
    );

    expect(updates).toBe(1);
    expect(boxCommands).toEqual(["a: claude update"]);
    expect(output).toContain("[b] Box offline, Ferry skips it: box-b.example is offline");
    expect(output.some((line) => line.startsWith("Watch update failed:") && line.includes("[b] box offline"))).toBe(true);
  });
});

describe("watch status file", () => {
  const MINUTE_MS = 60 * 1_000;
  const report: BriefStatusReport = { schemaVersion: 1, checkedAt: "2026-09-29T10:00:00.000Z", boxes: [] };
  const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

  /** Run the watch for `polls` observations. `identities` gives the identity of each observation, then the last one repeats. */
  function watchWithStatus(options: {
    readonly identities: readonly string[];
    readonly polls: number;
    readonly now?: () => number;
    readonly status?: () => Promise<BriefStatusReport>;
    readonly home?: string;
  }) {
    const controller = new AbortController();
    const record = { checks: 0, syncs: 0, written: [] as BriefStatusReport[], output: [] as string[], events: [] as unknown[] };
    let scans = 0;
    const run = runWatch(
      { signal: controller.signal, pollMs: 1, debounceMs: 1, ...(options.home ? { home: options.home } : {}) },
      {
        observe: () => {
          scans += 1;
          if (scans > options.polls) controller.abort();
          return accepted(options.identities[Math.min(scans, options.identities.length) - 1]!);
        },
        sync: async () => {
          record.syncs += 1;
        },
        sleep: tick,
        readBoxes: () => ["default"],
        readState: () => null,
        writeState: () => {},
        writeLine: (line) => record.output.push(line),
        emit: (event) => record.events.push(event),
        now: options.now ?? (() => 0),
        status:
          options.status ??
          (async () => {
            record.checks += 1;
            return report;
          }),
        ...(options.home ? {} : { writeStatusFile: (_home: string, written: BriefStatusReport) => record.written.push(written) }),
      },
    );
    return { run, record };
  }

  test("writes the brief status to ~/.ferry/status.json at the start", async () => {
    const home = mkdtempSync(join(tmpdir(), "ferry-watch-status-"));
    try {
      const { run } = watchWithStatus({ identities: ["one"], polls: 3, home });
      await run;

      expect(JSON.parse(readFileSync(join(home, ".ferry", "status.json"), "utf8"))).toEqual(report);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test("checks one time in 5 minutes when nothing changes", async () => {
    const { run, record } = watchWithStatus({ identities: ["one"], polls: 5 });
    await run;

    expect(record.checks).toBe(1);
    expect(record.written).toEqual([report]);
  });

  test("checks again when 5 minutes passed", async () => {
    let time = 0;
    const { run, record } = watchWithStatus({
      identities: ["one"],
      polls: 3,
      now: () => {
        time += 3 * MINUTE_MS;
        return time;
      },
    });
    await run;

    expect(record.checks).toBeGreaterThan(1);
  });

  test("checks again after a sync", async () => {
    const { run, record } = watchWithStatus({ identities: ["one", "one", "two"], polls: 8 });
    await run;

    expect(record.syncs).toBe(1);
    expect(record.checks).toBe(2);
  });

  test("a failed check prints a warning and an event, and the watch continues", async () => {
    const { run, record } = watchWithStatus({
      identities: ["one", "two"],
      polls: 5,
      status: async () => {
        throw new Error("config unreadable");
      },
    });
    await run;

    expect(record.output).toContain("Watch status check failed: config unreadable");
    expect(record.events).toContainEqual(expect.objectContaining({ type: "status-failed" }));
    expect(record.written).toEqual([]);
    expect(record.syncs).toBe(1);
  });

  test("writes no status file without the status dependency", async () => {
    const home = mkdtempSync(join(tmpdir(), "ferry-watch-status-"));
    const controller = new AbortController();
    let scans = 0;
    try {
      await runWatch(
        { home, signal: controller.signal, pollMs: 1, debounceMs: 1 },
        {
          observe: () => {
            scans += 1;
            if (scans > 2) controller.abort();
            return accepted("one");
          },
          sync: async () => {},
          sleep: tick,
          readBoxes: () => ["default"],
          readState: () => null,
          writeState: () => {},
          writeLine: () => {},
        },
      );

      expect(existsSync(join(home, ".ferry", "status.json"))).toBe(false);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});
