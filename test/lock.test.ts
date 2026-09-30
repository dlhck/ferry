import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { errorInfo } from "../src/output.ts";
import { acquireBoxLock, acquireStoreLock, boxLockOwner } from "../src/sync.ts";

const box = { name: "box", host: { transport: "ssh" as const, destination: "user@box.example" } };
const digest = (value: string) => createHash("sha256").update(value).digest("hex").slice(0, 16);
const lockFile = `sync-${digest("ssh:user@box.example")}.lock`;
/** No process has this pid: it is more than the largest pid of Linux and of macOS. */
const DEAD_PID = 2_147_483_647;
const staleLock = JSON.stringify({ pid: DEAD_PID, token: "stale" });
const BUSY = `operator: ferry sync works on box box now (pid ${process.pid}). Wait for it to end, then try again.`;

describe("lock recovery", () => {
  let home: string;
  let lockPath: string;
  const children: Bun.Subprocess[] = [];

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "ferry-lock-"));
    mkdirSync(join(home, ".ferry"));
    lockPath = join(home, ".ferry", lockFile);
  });

  afterEach(async () => {
    writeFileSync(join(home, "release"), "");
    for (const child of children.splice(0)) {
      child.kill();
      await child.exited;
    }
    rmSync(home, { recursive: true, force: true });
  });

  /** Start a process that asks for the box lock. See `lock-child.ts` for `pause`. */
  function contender(id: string, pause?: string): Bun.Subprocess {
    const child = Bun.spawn([process.execPath, join(import.meta.dir, "lock-child.ts"), home, id, ...(pause ? [pause] : [])], {
      stdout: "inherit",
      stderr: "inherit",
    });
    children.push(child);
    return child;
  }

  /** Wait until the contender has one of the states. Return the state. */
  async function reaches(id: string, ...states: string[]): Promise<string> {
    const until = Date.now() + 15_000;
    while (Date.now() < until) {
      const state = states.find((name) => existsSync(join(home, `${id}.${name}`)));
      if (state) return state;
      await Bun.sleep(2);
    }
    throw new Error(`contender ${id} did not reach ${states.join(" or ")}`);
  }

  const go = (id: string) => writeFileSync(join(home, `${id}.go`), "");
  const owner = () => (JSON.parse(readFileSync(lockPath, "utf8")) as { pid: number }).pid;
  const locks = () => readdirSync(join(home, ".ferry"));

  /** Start `count` contenders that ask for the lock at the same time. Return the result of each contender. */
  async function race(count: number): Promise<{ readonly child: Bun.Subprocess; readonly result: string }[]> {
    writeFileSync(join(home, "barrier"), "");
    const ids = Array.from({ length: count }, (_, index) => `c${index}`);
    const started = ids.map((id) => contender(id));
    await Promise.all(ids.map((id) => reaches(id, "waiting")));
    writeFileSync(join(home, "start"), "");
    const results = await Promise.all(ids.map((id) => reaches(id, "acquired", "busy")));
    return results.map((result, index) => ({ child: started[index] as Bun.Subprocess, result }));
  }

  test("two contenders that stop before they remove one stale lock do not both take the lock", async () => {
    writeFileSync(lockPath, staleLock);
    const pause = "unlinkSync:.lock,renameSync:.lock";
    const a = contender("a", pause);
    const b = contender("b", pause);
    // Each contender read the stale lock. It stops before it removes the lock, or it is refused.
    const before = await Promise.all([reaches("a", "paused", "busy"), reaches("b", "paused", "busy")]);
    expect(before).toContain("paused");

    go("a");
    const first = await reaches("a", "acquired", "busy");
    go("b");
    const second = await reaches("b", "acquired", "busy");

    expect([first, second].sort()).toEqual(["acquired", "busy"]);
    expect(a.exitCode === null || b.exitCode === null).toBe(true);
    expect(owner()).toBe((first === "acquired" ? a : b).pid);
  });

  test("a contender that read the stale lock before another process replaced it leaves the new lock", async () => {
    writeFileSync(lockPath, staleLock);
    // The contender b stops after it read the stale lock, and before it claims the lock.
    contender("b", "linkSync:.claim,unlinkSync:.lock");
    await reaches("b", "paused");
    const a = contender("a");
    expect(await reaches("a", "acquired")).toBe("acquired");

    go("b");

    expect(await reaches("b", "acquired", "busy")).toBe("busy");
    expect(a.exitCode).toBeNull();
    expect(owner()).toBe(a.pid);
  });

  test("only one of many contenders takes one stale lock", async () => {
    writeFileSync(lockPath, staleLock);

    const results = await race(8);

    const winners = results.filter(({ result }) => result === "acquired");
    expect(winners).toHaveLength(1);
    expect(owner()).toBe(winners[0]?.child.pid as number);
    expect(locks()).toEqual([lockFile]);
  });

  test("no contender removes a live lock", async () => {
    const release = acquireBoxLock(home, box, "sync");
    const live = readFileSync(lockPath, "utf8");

    const results = await race(4);

    expect(results.map(({ result }) => result)).toEqual(["busy", "busy", "busy", "busy"]);
    expect(readFileSync(lockPath, "utf8")).toBe(live);
    release();
    expect(locks()).toEqual([]);
  });

  test("the release of a lock that another process replaced leaves the new lock", () => {
    const releaseOld = acquireBoxLock(home, box, "sync");
    // Make the lock look like the lock of a dead process, so a second owner replaces it.
    writeFileSync(lockPath, staleLock);
    const releaseNew = acquireBoxLock(home, box, "sync");
    const live = readFileSync(lockPath, "utf8");

    releaseOld();

    expect(readFileSync(lockPath, "utf8")).toBe(live);
    expect(() => acquireBoxLock(home, box, "sync")).toThrow(BUSY);
    releaseNew();
    expect(locks()).toEqual([]);
  });

  test.each([
    ["empty", ""],
    ["half written", '{"pid":'],
    ["not an object", "null"],
  ])("replaces a lock file that is %s", (_name, content) => {
    writeFileSync(lockPath, content);

    const release = acquireBoxLock(home, box, "sync");

    expect(owner()).toBe(process.pid);
    expect(locks()).toEqual([lockFile]);
    release();
    expect(locks()).toEqual([]);
  });

  test("replaces the lock of a dead process when a new process has its pid", () => {
    acquireBoxLock(home, box, "sync")();
    // This process is live and has the pid, but it did not start at the recorded time.
    writeFileSync(lockPath, JSON.stringify({ pid: process.pid, start: "another-start", token: "stale" }));

    const release = acquireBoxLock(home, box, "sync");

    expect(JSON.parse(readFileSync(lockPath, "utf8"))).toMatchObject({ pid: process.pid, start: expect.any(String) });
    expect(() => acquireBoxLock(home, box, "sync")).toThrow(BUSY);
    release();
  });

  test("keeps the lock of a live process that did not record its start", () => {
    // A Ferry version before the start record wrote this lock.
    const old = JSON.stringify({ pid: process.pid, token: "old" });
    writeFileSync(lockPath, old);

    expect(() => acquireBoxLock(home, box, "sync")).toThrow("The lock of an earlier Ferry version for box box names pid");
    expect(readFileSync(lockPath, "utf8")).toBe(old);
  });

  test("replaces a stale lock when a dead contender left its claim", () => {
    writeFileSync(lockPath, staleLock);
    writeFileSync(`${lockPath}.${digest(staleLock)}.claim`, JSON.stringify({ pid: DEAD_PID, token: "claim" }));

    const release = acquireBoxLock(home, box, "sync");

    expect(owner()).toBe(process.pid);
    expect(locks()).toEqual([lockFile]);
    release();
  });

  test("the lock file names the command next to the pid, the start, and the token", async () => {
    const release = acquireBoxLock(home, box, "box remove");
    const lock = JSON.parse(readFileSync(lockPath, "utf8"));
    expect(lock).toEqual({ pid: process.pid, start: expect.any(String), command: "box remove", token: expect.any(String) });
    // A process of Ferry 0.10.0 reads only the pid, the start, and the token.
    expect(Object.keys(lock)).toEqual(["pid", "start", "command", "token"]);
    expect(boxLockOwner(home, box)).toEqual({ pid: process.pid, command: "box remove", earlierVersion: false, otherProgram: false });
    release();
    expect(boxLockOwner(home, box)).toBeNull();

    const releaseStore = await acquireStoreLock(home, "revert");
    expect(JSON.parse(readFileSync(join(home, ".ferry", "store.lock"), "utf8"))).toMatchObject({ pid: process.pid, command: "revert" });
    releaseStore();
  });

  test.each([
    ["watch", "The watch service syncs box box now (pid PID). Try again in a moment."],
    ["watch update", "The watch service updates box box now (pid PID). Try again in a moment."],
    ["integrations enable", "ferry integrations enable works on box box now (pid PID). Wait for it to end, then try again."],
  ])("the busy error names the box and the owner %s", (command, text) => {
    const release = acquireBoxLock(home, box, command);
    let error: unknown;
    try {
      acquireBoxLock(home, box, "sync");
    } catch (caught) {
      error = caught;
    }
    release();

    expect(error).toMatchObject({ code: "concurrent-sync" });
    expect(errorInfo(error)).toEqual({
      code: "sync-busy",
      message: `operator: ${text.replace("PID", String(process.pid))}`,
      hint: "Wait for the other Ferry command to end, then run the command again.",
      details: { box: "box", owner: { pid: process.pid, command, earlierVersion: false, otherProgram: false } },
    });
  });

  test("a lock of Ferry 0.10.0 has no command, and the busy error names the box", () => {
    const release = acquireBoxLock(home, box, "sync");
    const { command: _command, ...old } = JSON.parse(readFileSync(lockPath, "utf8"));
    writeFileSync(lockPath, JSON.stringify(old));

    expect(() => acquireBoxLock(home, box, "sync")).toThrow(
      `operator: A sync or another Ferry command works on box box now (pid ${process.pid}). Wait for it to end, then try again.`,
    );
    expect(boxLockOwner(home, box)).toEqual({ pid: process.pid, command: null, earlierVersion: false, otherProgram: false });
    expect(readFileSync(lockPath, "utf8")).toBe(JSON.stringify(old));
    // The release compares only the token, as the release of Ferry 0.10.0 does.
    release();
    expect(locks()).toEqual([]);
  });

  /** Start a process with the command line of Ferry under bun, which only waits. */
  async function ferryProcess(): Promise<Bun.Subprocess> {
    const script = join(home, "ferry", "src", "cli.ts");
    mkdirSync(join(home, "ferry", "src"), { recursive: true });
    writeFileSync(script, `require("node:fs").writeFileSync(${JSON.stringify(join(home, "ferry.started"))}, ""); setInterval(() => {}, 1000);`);
    const child = Bun.spawn([process.execPath, script, "watch"], { stdout: "inherit", stderr: "inherit" });
    children.push(child);
    while (!existsSync(join(home, "ferry.started"))) await Bun.sleep(2);
    return child;
  }

  test("a lock of an earlier Ferry version whose pid a different program has now gives no advice to stop that program", () => {
    // The test process has the pid, and it is not a Ferry process.
    const old = JSON.stringify({ pid: process.pid, token: "old" });
    writeFileSync(lockPath, old);
    let error: unknown;
    try {
      acquireBoxLock(home, box, "sync");
    } catch (caught) {
      error = caught;
    }

    expect(errorInfo(error)).toEqual({
      code: "sync-busy",
      message: `operator: The lock of an earlier Ferry version for box box names pid ${process.pid}, which another program has now, so the lock stays. Run ferry doctor for the fix.`,
      hint: "Run ferry doctor. It gives the fix for the lock of an earlier Ferry version.",
      details: { box: "box", owner: { pid: process.pid, command: null, earlierVersion: true, otherProgram: true } },
    });
    // Ferry keeps the lock.
    expect(readFileSync(lockPath, "utf8")).toBe(old);
  });

  test("a lock without a start and a command that a Ferry process holds is the lock of an earlier Ferry version", async () => {
    const ferry = await ferryProcess();
    writeFileSync(lockPath, JSON.stringify({ pid: ferry.pid, token: "old" }));
    let error: unknown;
    try {
      acquireBoxLock(home, box, "sync");
    } catch (caught) {
      error = caught;
    }

    expect(errorInfo(error)).toEqual({
      code: "sync-busy",
      message:
        `operator: A process of an earlier Ferry version holds the lock of box box (pid ${ferry.pid}). Wait for it to end, then try again. ` +
        "If the lock stays, run ferry watch install to start the watch service with this version, or stop that process.",
      hint: "Run ferry doctor. It gives the fix for the lock of an earlier Ferry version.",
      details: { box: "box", owner: { pid: ferry.pid, command: null, earlierVersion: true, otherProgram: false } },
    });
  });

  test("a command in the lock file that is not a short name does not go into the message", () => {
    const release = acquireBoxLock(home, box, "sync");
    const lock = JSON.parse(readFileSync(lockPath, "utf8"));
    writeFileSync(lockPath, JSON.stringify({ ...lock, command: "sync\u001b[2J" }));

    expect(boxLockOwner(home, box)).toEqual({ pid: process.pid, command: null, earlierVersion: false, otherProgram: false });
    release();
  });

  test("a process of Ferry 0.10.0 and a new process share one lock file", async () => {
    // The lock of a dead process of Ferry 0.10.0, and then of a dead new process: a new contender replaces each.
    for (const stale of [
      JSON.stringify({ pid: DEAD_PID, start: "boot:1", token: "stale" }),
      JSON.stringify({ pid: DEAD_PID, start: "boot:1", command: "watch", token: "stale" }),
    ]) {
      writeFileSync(lockPath, stale);
      const id = `n${digest(stale)}`;
      const child = contender(id);
      expect(await reaches(id, "acquired", "busy")).toBe("acquired");
      expect(JSON.parse(readFileSync(lockPath, "utf8"))).toMatchObject({ pid: child.pid, command: "sync" });
      child.kill();
      await child.exited;
    }
  });

  test("the store lock replaces a stale lock", async () => {
    writeFileSync(join(home, ".ferry", "store.lock"), staleLock);

    const release = await acquireStoreLock(home, "sync");

    expect(locks()).toEqual(["store.lock"]);
    release();
    expect(locks()).toEqual([]);
  });
});
