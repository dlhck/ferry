/**
 * A process that takes the box lock of `user@box.example`, for `lock.test.ts`.
 *
 * Arguments: `<home> <id> [<pause>]`. The process writes marker files to `<home>`:
 * `<id>.acquired` or `<id>.busy` for the result, and `<id>.paused` when it stops at a pause.
 *
 * `<pause>` is a list of `<function>:<suffix>` with commas between the items, such as
 * `unlinkSync:.lock,renameSync:.lock`. The process stops before the first call of a `node:fs`
 * function in the list that changes a path with that suffix, until the file `<id>.go` exists.
 *
 * When the file `barrier` exists, the process writes `<id>.waiting` and spins until the file
 * `start` exists, so many processes ask for the lock at the same time. A process that has the
 * lock holds it until the file `release` exists.
 */
import * as fs from "node:fs";
import { join } from "node:path";
import { mock } from "bun:test";

const [home, id, pause] = process.argv.slice(2) as [string, string, string | undefined];
const { existsSync, writeFileSync } = fs;
const mark = (name: string) => writeFileSync(join(home, name), "");

if (pause) {
  const points = pause.split(",").map((point) => point.split(":") as [string, string]);
  let paused = false;
  const wrap = (name: "unlinkSync" | "renameSync" | "linkSync") => {
    const real = fs[name] as (...paths: string[]) => void;
    return (...paths: string[]) => {
      const changed = String(paths.at(-1));
      if (!paused && points.some(([point, suffix]) => point === name && changed.endsWith(suffix))) {
        paused = true;
        mark(`${id}.paused`);
        const until = Date.now() + 10_000;
        while (!existsSync(join(home, `${id}.go`)) && Date.now() < until) {
          Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 2);
        }
      }
      return real(...paths);
    };
  };
  mock.module("node:fs", () => ({
    ...fs,
    unlinkSync: wrap("unlinkSync"),
    renameSync: wrap("renameSync"),
    linkSync: wrap("linkSync"),
  }));
}

const { acquireBoxLock } = await import("../src/sync.ts");

if (existsSync(join(home, "barrier"))) {
  mark(`${id}.waiting`);
  while (!existsSync(join(home, "start"))) {}
}

let release: () => void;
try {
  release = acquireBoxLock(home, { name: "box", host: { transport: "ssh", destination: "user@box.example" } });
} catch (error) {
  if ((error as { code?: unknown }).code !== "concurrent-sync") throw error;
  mark(`${id}.busy`);
  process.exit(0);
}
mark(`${id}.acquired`);
while (!existsSync(join(home, "release"))) await Bun.sleep(5);
release();
