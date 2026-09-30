import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { acquireBoxLock, acquireStoreLock } from "../src/sync.ts";

const box = { name: "box", host: { transport: "ssh" as const, destination: "user@box.example" } };
const digest = (value: string) => createHash("sha256").update(value).digest("hex").slice(0, 16);
const lockFile = `sync-${digest("ssh:user@box.example")}.lock`;
/** No process has this pid: it is more than the largest pid of Linux and of macOS. */
const DEAD_PID = 2_147_483_647;
const staleLock = JSON.stringify({ pid: DEAD_PID, token: "stale" });
const BUSY = "a sync or another Ferry command is active for box box";

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
    const release = acquireBoxLock(home, box);
    const live = readFileSync(lockPath, "utf8");

    const results = await race(4);

    expect(results.map(({ result }) => result)).toEqual(["busy", "busy", "busy", "busy"]);
    expect(readFileSync(lockPath, "utf8")).toBe(live);
    release();
    expect(locks()).toEqual([]);
  });

  test("the release of a lock that another process replaced leaves the new lock", () => {
    const releaseOld = acquireBoxLock(home, box);
    // Make the lock look like the lock of a dead process, so a second owner replaces it.
    writeFileSync(lockPath, staleLock);
    const releaseNew = acquireBoxLock(home, box);
    const live = readFileSync(lockPath, "utf8");

    releaseOld();

    expect(readFileSync(lockPath, "utf8")).toBe(live);
    expect(() => acquireBoxLock(home, box)).toThrow(BUSY);
    releaseNew();
    expect(locks()).toEqual([]);
  });

  test.each([
    ["empty", ""],
    ["half written", '{"pid":'],
    ["not an object", "null"],
  ])("replaces a lock file that is %s", (_name, content) => {
    writeFileSync(lockPath, content);

    const release = acquireBoxLock(home, box);

    expect(owner()).toBe(process.pid);
    expect(locks()).toEqual([lockFile]);
    release();
    expect(locks()).toEqual([]);
  });

  test("replaces the lock of a dead process when a new process has its pid", () => {
    acquireBoxLock(home, box)();
    // This process is live and has the pid, but it did not start at the recorded time.
    writeFileSync(lockPath, JSON.stringify({ pid: process.pid, start: "another-start", token: "stale" }));

    const release = acquireBoxLock(home, box);

    expect(JSON.parse(readFileSync(lockPath, "utf8"))).toMatchObject({ pid: process.pid, start: expect.any(String) });
    expect(() => acquireBoxLock(home, box)).toThrow(BUSY);
    release();
  });

  test("keeps the lock of a live process that did not record its start", () => {
    // A Ferry version before the start record wrote this lock.
    const old = JSON.stringify({ pid: process.pid, token: "old" });
    writeFileSync(lockPath, old);

    expect(() => acquireBoxLock(home, box)).toThrow(BUSY);
    expect(readFileSync(lockPath, "utf8")).toBe(old);
  });

  test("replaces a stale lock when a dead contender left its claim", () => {
    writeFileSync(lockPath, staleLock);
    writeFileSync(`${lockPath}.${digest(staleLock)}.claim`, JSON.stringify({ pid: DEAD_PID, token: "claim" }));

    const release = acquireBoxLock(home, box);

    expect(owner()).toBe(process.pid);
    expect(locks()).toEqual([lockFile]);
    release();
  });

  test("the store lock replaces a stale lock", async () => {
    writeFileSync(join(home, ".ferry", "store.lock"), staleLock);

    const release = await acquireStoreLock(home);

    expect(locks()).toEqual(["store.lock"]);
    release();
    expect(locks()).toEqual([]);
  });
});
