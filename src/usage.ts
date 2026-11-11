/**
 * `ferry usage` shows the token counts of the agents on each selected box,
 * for each harness, project, and day. The Ferry on the box counts them with
 * the hidden command `ferry usage-count`, and sends only the harness ids, the
 * project paths, the days, and the numbers. This machine reads the answer
 * against its full form, takes nothing else from it, and applies the token
 * filter to the project paths again.
 */

import { BOX_MARKER } from "./box-ferry.ts";
import { resolveBoxes } from "./boxes.ts";
import { readConfig, resolveLinkOptions, type PartialOperatorConfig } from "./config.ts";
import { FerryError } from "./errors.ts";
import type { LinkOptions, LinkResult, RunOptions } from "./link.ts";
import { holdsToken, redactTokens, redactUrlCredentials } from "./manifest.ts";
import type { DayCounts, TokenCounts } from "./usage-count.ts";

export type HarnessUsage = {
  readonly id: string;
  /** False for a harness that records no token counts. Its total is then null. */
  readonly available: boolean;
  readonly total: TokenCounts | null;
  readonly projects: readonly { readonly path: string | null; readonly total: TokenCounts; readonly days: readonly DayCounts[] }[];
};

export type UsageReport = {
  /** The first UTC day of the count, or null for all days. */
  readonly since: string | null;
  readonly boxes: readonly {
    readonly name: string;
    readonly online: boolean;
    /** Why Ferry has no count of the box, or null. */
    readonly error: string | null;
    readonly harnesses: readonly HarnessUsage[];
  }[];
};

export type UsageDependencies = {
  readonly readConfig: () => PartialOperatorConfig | null;
  readonly createLink: (options: LinkOptions) => { run(command: string, options?: RunOptions): Promise<LinkResult> };
};

const COUNT_TIMEOUT_MS = 15 * 60_000;
const DAY = /^\d{4}-\d{2}-\d{2}$/;
const ID = /^[a-z0-9][a-z0-9-]{0,63}$/;
const PATH = /^[^\p{Cc}]{1,4096}$/u;
const FIELDS = ["input", "output", "cacheRead", "cacheWrite"] as const;

/** The date of `--since`, as a UTC day. */
export function parseSince(text: string | undefined): string | null {
  if (text === undefined) return null;
  if (DAY.test(text) && new Date(`${text}T00:00:00Z`).toISOString().startsWith(text)) return text;
  throw new FerryError("usage", `invalid --since date ${text}. Use the form YYYY-MM-DD.`);
}

/** Prints `MISSING` when the box has no box install of Ferry. The exit code of Ferry does not fail the command. */
export function usageCountCommand(since: string | null): string {
  const option = since === null ? "" : ` --since ${since}`;
  return `if [ -f "$HOME/${BOX_MARKER}" ] && [ -x "$HOME/.local/bin/ferry" ]; then "$HOME/.local/bin/ferry" --json usage-count${option} 2>/dev/null; else echo MISSING; fi; true`;
}

/** Count the tokens on each selected box. A box that Ferry cannot count gets its reason, and the other boxes still run. */
export async function runUsage(
  selection: readonly string[],
  since: string | null,
  dependencies: Pick<UsageDependencies, "createLink"> & Partial<UsageDependencies>,
): Promise<UsageReport> {
  const resolved = { readConfig, ...dependencies };
  const boxes = resolveBoxes(resolved.readConfig() ?? {}, selection);
  const command = usageCountCommand(since);
  return {
    since,
    boxes: await Promise.all(
      boxes.map(async (box) => {
        const result = await resolved.createLink(resolveLinkOptions(box.host)).run(command, { timeoutMs: COUNT_TIMEOUT_MS });
        if (!result.ok) return { name: box.name, online: false, error: result.error.message, harnesses: [] };
        const answer = readAnswer(result.stdout);
        if (typeof answer === "string") return { name: box.name, online: true, error: answer, harnesses: [] };
        return { name: box.name, online: true, error: null, harnesses: answer };
      }),
    ),
  };
}

/** The harnesses in the answer of the box, or the reason that Ferry cannot use it. */
export function readAnswer(stdout: string): HarnessUsage[] | string {
  const update = "Run ferry update. A development build of Ferry puts no Ferry on a box";
  if (stdout.trim() === "MISSING") return `Ferry is not installed on the box. Run ferry install. A development build of Ferry puts no Ferry on a box`;
  let envelope: unknown;
  try {
    envelope = JSON.parse(stdout);
  } catch {
    envelope = null;
  }
  if (isRecord(envelope) && envelope.ok === false && isRecord(envelope.error) && envelope.error.code !== "usage") {
    const text = String(envelope.error.message);
    return holdsToken(text) ? "the Ferry on the box failed with an error text that has the form of a token" : `the Ferry on the box failed: ${text}`;
  }
  // An older Ferry has no usage-count, and fails with a usage error.
  if (!isRecord(envelope) || envelope.ok !== true || !isRecord(envelope.result)) return `the Ferry on the box cannot count tokens. ${update}`;
  const harnesses = readHarnesses(envelope.result.harnesses);
  return harnesses ?? `the Ferry on the box gave an answer that this Ferry cannot read. ${update}`;
}

/** Rebuild the harnesses from their full form, or null when one value does not have it. */
function readHarnesses(value: unknown): HarnessUsage[] | null {
  if (!Array.isArray(value)) return null;
  const harnesses: HarnessUsage[] = [];
  for (const harness of value as unknown[]) {
    if (!isRecord(harness) || typeof harness.id !== "string" || !ID.test(harness.id) || typeof harness.available !== "boolean") return null;
    if (!Array.isArray(harness.projects) || (!harness.available && harness.projects.length > 0)) return null;
    const projects: HarnessUsage["projects"][number][] = [];
    for (const project of harness.projects as unknown[]) {
      if (!isRecord(project) || !Array.isArray(project.days)) return null;
      const path = project.path;
      if (path !== null && (typeof path !== "string" || !PATH.test(path))) return null;
      const days: DayCounts[] = [];
      for (const day of project.days as unknown[]) {
        if (!isRecord(day) || typeof day.day !== "string" || !DAY.test(day.day)) return null;
        const counts = readCounts(day);
        if (counts === null) return null;
        days.push({ day: day.day, ...counts });
      }
      projects.push({ path: path === null ? null : redactUrlCredentials(redactTokens(path)), total: sum(days), days });
    }
    harnesses.push({
      id: harness.id,
      available: harness.available,
      total: harness.available ? sum(projects.map((project) => project.total)) : null,
      projects,
    });
  }
  return harnesses;
}

function readCounts(value: Record<string, unknown>): TokenCounts | null {
  const counts = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
  for (const field of FIELDS) {
    const number = value[field];
    if (typeof number !== "number" || !Number.isSafeInteger(number) || number < 0) return null;
    counts[field] = number;
  }
  return counts;
}

function sum(list: readonly TokenCounts[]): TokenCounts {
  const total = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
  for (const counts of list) for (const field of FIELDS) total[field] += counts[field];
  return total;
}

/** One block for each box, with one row for each harness and project. A box without a count has one line with the reason. */
export function usageLines(report: UsageReport): string[] {
  const lines: string[] = [];
  for (const box of report.boxes) {
    if (!box.online) {
      lines.push(`${box.name}: offline (${box.error ?? "unknown error"})`);
      continue;
    }
    if (box.error !== null) {
      lines.push(`${box.name}: not available (${box.error})`);
      continue;
    }
    lines.push(report.since === null ? `${box.name}:` : `${box.name} (since ${report.since}):`);
    const rows: string[][] = [["HARNESS", "INPUT", "OUTPUT", "CACHE READ", "CACHE WRITE", "PROJECT"]];
    const missing: string[] = [];
    for (const harness of box.harnesses) {
      if (!harness.available) missing.push(harness.id);
      else if (harness.projects.length === 0) rows.push([harness.id, "0", "0", "0", "0", "-"]);
      else for (const project of harness.projects) rows.push([harness.id, ...FIELDS.map((field) => format(project.total[field])), project.path ?? "-"]);
    }
    const widths = rows[0]!.map((_, column) => Math.max(...rows.map((row) => row[column]!.length)));
    if (rows.length > 1) {
      for (const row of rows) {
        const cells = row.map((cell, column) => {
          if (column === row.length - 1) return cell;
          return column === 0 ? cell.padEnd(widths[column]!) : cell.padStart(widths[column]!);
        });
        lines.push(`  ${cells.join("  ")}`);
      }
    }
    for (const id of missing) lines.push(`  ${id}: not available, the harness records no token counts`);
  }
  return lines;
}

function format(count: number): string {
  return count.toLocaleString("en-US");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
