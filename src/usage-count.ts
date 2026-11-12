/**
 * The token count of the hidden box command `ferry usage-count`. The Ferry on
 * the box reads the session files of each harness that has `usage` and adds
 * the token counts for each project and day. The result has only the harness
 * ids, the project paths, the days, and the numbers. No other text of a
 * session leaves the box, and a project path with a token or a URL
 * credential gets the mark of the token filter.
 *
 * Ferry counts what the session files hold now. A session that a harness or
 * the user deleted is not counted.
 */

import { createReadStream, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { redactTokens, redactUrlCredentials } from "./manifest.ts";
import type { HarnessDescriptor, UsageRecords } from "./registry/types.ts";

export type TokenCounts = {
  /** The input tokens that are not a cache read. */
  readonly input: number;
  readonly output: number;
  readonly cacheRead: number;
  readonly cacheWrite: number;
};

/** The day is a UTC date, such as `2026-01-02`. */
export type DayCounts = TokenCounts & { readonly day: string };

export type HarnessCount = {
  readonly id: string;
  /** False for a harness that records no token counts. Its projects are then empty. */
  readonly available: boolean;
  /** `path` is null when the session file does not name the project. */
  readonly projects: readonly { readonly path: string | null; readonly days: readonly DayCounts[] }[];
};

export type UsageCount = { readonly harnesses: readonly HarnessCount[] };

const FIELDS = ["input", "output", "cacheRead", "cacheWrite"] as const;

/**
 * Count the tokens of each harness with `usage` or `processNames` in the
 * home `home`, from the UTC day `since` on, or of all days when it is null.
 */
export async function countUsage(
  harnesses: readonly HarnessDescriptor[],
  home: string,
  since: string | null,
): Promise<UsageCount> {
  const counted: HarnessCount[] = [];
  for (const harness of harnesses) {
    if (harness.usage) counted.push({ id: harness.id, available: true, projects: await countHarness(harness.usage, home, since) });
    else if (harness.processNames) counted.push({ id: harness.id, available: false, projects: [] });
  }
  return { harnesses: counted };
}

async function countHarness(usage: UsageRecords, home: string, since: string | null): Promise<HarnessCount["projects"]> {
  const totals = new Map<string | null, Map<string, Record<(typeof FIELDS)[number], number>>>();
  // The last line of each `once` value counts. A harness can write a record again with larger counts.
  const last = new Map<string, { path: string | null; day: string; counts: Record<(typeof FIELDS)[number], number> }>();
  const add = (path: string | null, day: string, counts: Record<(typeof FIELDS)[number], number>) => {
    if (FIELDS.every((field) => counts[field] === 0)) return;
    const days = totals.get(path) ?? new Map();
    totals.set(path, days);
    const sum = days.get(day) ?? { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
    for (const field of FIELDS) sum[field] += counts[field];
    days.set(day, sum);
  };
  // A file with no change since the first day has no record of that day or later.
  const notBefore = since === null ? null : Date.parse(`${since}T00:00:00Z`);
  // Ferry parses the first line and each line that has the last key of a record path.
  const keys = usage.records.map((path) => `"${path.split(".").at(-1)}"`);
  for (const file of sessionFiles(join(home, usage.root), new Bun.Glob(usage.files), notBefore)) {
    let first = true;
    let fileProject: string | null = null;
    try {
      for await (const line of createInterface({ input: createReadStream(file), crlfDelay: Infinity })) {
        const isFirst = first;
        first = false;
        if (!isFirst && !keys.some((key) => line.includes(key))) continue;
        let value: unknown;
        try {
          value = JSON.parse(line);
        } catch {
          continue;
        }
        const project = valueAt(value, usage.project);
        if (isFirst && typeof project === "string") fileProject = project;
        const record = usage.records.map((path) => valueAt(value, path)).find(isRecord);
        if (record === undefined) continue;
        const time = Date.parse(String(valueAt(value, "timestamp")));
        if (Number.isNaN(time)) continue;
        const day = new Date(time).toISOString().slice(0, 10);
        if (since !== null && day < since) continue;
        const once = usage.once ? valueAt(value, usage.once.path) : undefined;
        const count = (key: string) => {
          const number = record[key];
          return typeof number === "number" && Number.isSafeInteger(number) && number > 0 ? number : 0;
        };
        const cacheRead = count(usage.fields.cacheRead);
        const input = count(usage.fields.input);
        const counts = {
          input: usage.inputIncludesCacheRead ? Math.max(0, input - cacheRead) : input,
          output: count(usage.fields.output),
          cacheRead,
          cacheWrite: count(usage.fields.cacheWrite),
        };
        const raw = typeof project === "string" ? project : fileProject;
        const path = raw === null ? null : redactUrlCredentials(redactTokens(raw));
        if (usage.once && (typeof once === "string" || typeof once === "number")) {
          last.set(usage.once.scope === "file" ? `${file}\0${once}` : String(once), { path, day, counts });
        } else add(path, day, counts);
      }
    } catch {
      // A file that Ferry cannot read is not counted.
    }
  }
  for (const { path, day, counts } of last.values()) add(path, day, counts);
  return [...totals]
    .sort(([a], [b]) => (a ?? "").localeCompare(b ?? ""))
    .map(([path, days]) => ({
      path,
      days: [...days].sort(([a], [b]) => a.localeCompare(b)).map(([day, sum]) => ({ day, ...sum })),
    }));
}

/** The files under `dir` whose name matches `glob`, with a change at `notBefore` or later. Ferry follows no link. */
function* sessionFiles(dir: string, glob: Bun.Glob, notBefore: number | null): Generator<string> {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) yield* sessionFiles(path, glob, notBefore);
    else if (entry.isFile() && glob.match(entry.name)) {
      if (notBefore !== null) {
        try {
          if (statSync(path).mtimeMs < notBefore) continue;
        } catch {
          continue;
        }
      }
      yield path;
    }
  }
}

function valueAt(value: unknown, path: string): unknown {
  let current = value;
  for (const key of path.split(".")) {
    if (!isRecord(current)) return undefined;
    current = current[key];
  }
  return current;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
