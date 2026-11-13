/**
 * The injectable clock of the messaging tests.
 *
 * The relay, the GitHub access checks, and the worker read the time only through a
 * `Clock`. A test gives them a `FakeClock` and moves it forward, so the rules of
 * 15 minutes, 1 hour, 90 seconds, and 24 hours run without a wait.
 *
 * The shape is structural. A `src/messaging` module that takes `{ now(): number }`
 * accepts a `FakeClock` without an import from the test tree.
 */

/** Milliseconds since the Unix epoch, as `Date.now()` gives them. */
export interface Clock {
  now(): number;
}

export const systemClock: Clock = { now: () => Date.now() };

/** The start time of each fake clock, unless the test gives one. */
export const FAKE_CLOCK_START = Date.parse("2026-01-05T09:00:00.000Z");

export class FakeClock implements Clock {
  #ms: number;

  constructor(start: number | string = FAKE_CLOCK_START) {
    this.#ms = typeof start === "string" ? parseIso(start) : start;
  }

  now(): number {
    return this.#ms;
  }

  /** The time as the relay stores it: ISO 8601 in UTC with milliseconds. */
  iso(): string {
    return new Date(this.#ms).toISOString();
  }

  /** Moves the clock forward. A clock never goes back, as the relay clock never does. */
  advance(ms: number): void {
    if (!Number.isFinite(ms) || ms < 0) throw new Error(`advance needs a finite, positive time, not ${ms}`);
    this.#ms += ms;
  }

  /** Moves the clock forward to a time. */
  set(to: number | string): void {
    const ms = typeof to === "string" ? parseIso(to) : to;
    if (ms < this.#ms) throw new Error(`the clock cannot go back from ${this.iso()} to ${new Date(ms).toISOString()}`);
    this.#ms = ms;
  }
}

export const SECOND = 1_000;
export const MINUTE = 60 * SECOND;
export const HOUR = 60 * MINUTE;

function parseIso(value: string): number {
  const ms = Date.parse(value);
  if (Number.isNaN(ms)) throw new Error(`not an ISO 8601 time: ${value}`);
  return ms;
}
