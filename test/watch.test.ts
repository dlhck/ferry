import { describe, expect, test } from "bun:test";
import { isRetryableWatchError, runWatch, type WatchObservation } from "../src/watch.ts";
import { StoreRefusal } from "../src/store.ts";
import { SyncError } from "../src/sync.ts";
import { createPaseo } from "../src/integrations/paseo.ts";
import type { Integration } from "../src/integrations/types.ts";
import { runUpdateCommand } from "../src/update.ts";

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
});
