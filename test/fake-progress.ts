import { lineProgress, noProgress, type Progress } from "../src/progress.ts";

/**
 * A Progress that records each call as `start:<step>`, `count:<current>/<total>`,
 * `done`, `fail`, `skip:<step>`, or `pause`. It writes held lines at once.
 */
export function recordProgress(): Progress & { readonly events: string[] } {
  const events: string[] = [];
  return {
    ...noProgress,
    events,
    start: (step) => events.push(`start:${step}`),
    count: (current, total) => events.push(`count:${current}/${total}`),
    done: () => events.push("done"),
    fail: () => events.push("fail"),
    skip: (step) => events.push(`skip:${step}`),
    pause: () => events.push("pause"),
  };
}

/**
 * The terminal reporter on a fake terminal without color. Each clock read
 * advances 100 ms, so each step takes 0.1s. `writes` holds each raw write.
 */
export function fakeTerminal(columns = 80): {
  readonly progress: Progress;
  readonly writes: string[];
  /** The lines of the summary table, or none. */
  table(): string[];
} {
  const writes: string[] = [];
  let clock = 0;
  const progress = lineProgress({ write: (text) => writes.push(text), columns, color: false, now: () => (clock += 100) });
  return {
    progress,
    writes,
    table: () => writes.find((text) => text.startsWith("Step"))?.trimEnd().split("\n") ?? [],
  };
}
