import { describe, expect, test } from "bun:test";
import { isRetryableWatchError, runWatch, type WatchObservation } from "../src/watch.ts";
import { StoreRefusal } from "../src/store.ts";
import { SyncError } from "../src/sync.ts";

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
        sync: async (identity) => {
          synced.push(identity);
          if (identity === "three") current = "four";
          else controller.abort();
        },
        sleep: async () => {},
        readState: () => null,
        writeState: () => {},
        writeLine: () => {},
      },
    );

    expect(synced).toEqual(["three", "four"]);
  });

  test("retries transport failures with capped backoff", async () => {
    const controller = new AbortController();
    let scans = 0;
    let attempts = 0;
    const delays: number[] = [];

    await runWatch(
      { signal: controller.signal, pollMs: 1, debounceMs: 1, maxBackoffMs: 4_000 },
      {
        observe: () => accepted(scans++ === 0 ? "one" : "two"),
        sync: async () => {
          attempts += 1;
          if (attempts < 4) throw Object.assign(new Error("offline"), { retryable: true });
          controller.abort();
        },
        isRetryable: (error) =>
          error instanceof Error && "retryable" in error && error.retryable === true,
        sleep: async (milliseconds) => {
          if (milliseconds > 1) delays.push(milliseconds);
        },
        readState: () => null,
        writeState: () => {},
        writeLine: () => {},
      },
    );

    expect(attempts).toBe(4);
    expect(delays).toEqual([1_000, 2_000, 4_000]);
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
    const states: string[] = [];

    await runWatch(
      { signal: controller.signal, pollMs: 1, debounceMs: 1 },
      {
        observe: () => accepted(scans++ === 0 ? "one" : "two"),
        sync: async () => {
          controller.abort();
          throw new Error("content conflict");
        },
        sleep: async () => {},
        readState: () => null,
        writeState: (_home, identity) => states.push(identity),
        writeLine: () => {},
      },
    );

    expect(states).toEqual(["two"]);
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
