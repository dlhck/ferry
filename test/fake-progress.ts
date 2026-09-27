import type { Progress } from "../src/progress.ts";

/** A Progress that records each call as `start:<step>`, `count:<current>/<total>`, `done`, or `fail`. */
export function recordProgress(): Progress & { readonly events: string[] } {
  const events: string[] = [];
  return {
    events,
    start: (step) => events.push(`start:${step}`),
    count: (current, total) => events.push(`count:${current}/${total}`),
    done: () => events.push("done"),
    fail: () => events.push("fail"),
  };
}
