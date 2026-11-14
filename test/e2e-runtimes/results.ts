/**
 * The results of the real-CLI suite, and the table of runtime versions in
 * docs/agent-messaging-runtimes.md (design 15.3).
 *
 * Each case appends one line to `<run root>/results.jsonl`. After each file, the
 * suite writes the table again from all lines, so the table shows the newest run
 * for each runtime version and platform.
 */

import { test } from "bun:test";
import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { REPO_ROOT } from "../messaging/harness/system.ts";
import { RUN_ID, RUN_ROOT, type E2E, type Runtime } from "./harness.ts";

export const RUNTIMES_DOC = join(REPO_ROOT, "docs", "agent-messaging-runtimes.md");
const START = "<!-- e2e-runtimes:start -->";
const END = "<!-- e2e-runtimes:end -->";
const RESULTS = join(RUN_ROOT, "results.jsonl");

export type CaseResult = {
  readonly run: string;
  readonly date: string;
  readonly platform: string;
  readonly runtime: Runtime;
  readonly version: string;
  readonly case: string;
  readonly passed: boolean;
};

const versions = new Map<Runtime, string>();

/** The version that the runtime on the PATH reports. */
export function runtimeVersion(runtime: Runtime): string {
  const known = versions.get(runtime);
  if (known !== undefined) return known;
  const result = Bun.spawnSync([runtime, "--version"], { stdout: "pipe", stderr: "pipe" });
  const match = result.stdout.toString().match(/\d+\.\d+\.\d+/);
  const version = match?.[0] ?? "unknown";
  versions.set(runtime, version);
  return version;
}

/**
 * A test that records its result for each runtime that it uses. On a failure, it
 * saves the tmux panes to the run directory.
 */
export function caseTest(name: string, runtimes: readonly Runtime[], e2e: () => E2E, body: () => Promise<void>, timeoutMs = 600_000): void {
  test(
    name,
    async () => {
      let passed = false;
      try {
        await body();
        passed = true;
      } catch (error) {
        e2e().savePanes(name.replace(/[^a-z0-9]+/gi, "-").toLowerCase());
        throw error;
      } finally {
        for (const runtime of new Set(runtimes)) {
          const result: CaseResult = {
            run: RUN_ID,
            date: new Date().toISOString().slice(0, 10),
            platform: process.platform,
            runtime,
            version: runtimeVersion(runtime),
            case: name,
            passed,
          };
          appendFileSync(RESULTS, `${JSON.stringify(result)}\n`);
        }
      }
    },
    timeoutMs,
  );
}

/** One row of the version table. */
export type TableRow = { readonly runtime: string; readonly version: string; readonly platform: string; readonly run: string; readonly result: string };

/** The rows between the markers of the runtimes page. */
export function parseTable(doc: string): TableRow[] {
  const start = doc.indexOf(START);
  const end = doc.indexOf(END);
  if (start === -1 || end === -1) throw new Error(`the runtimes page has no ${START} and ${END} markers`);
  return doc
    .slice(start + START.length, end)
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.startsWith("|") && !line.startsWith("| Runtime") && !line.startsWith("| ---"))
    .map((line) => {
      const [runtime = "", version = "", platform = "", run = "", result = ""] = line.slice(1, -1).split("|").map((cell) => cell.trim());
      return { runtime, version, platform, run, result };
    });
}

/** The versions of a runtime that the table lists as passed, on any platform. */
export function passedVersions(doc: string, runtime: Runtime): string[] {
  const versions = parseTable(doc)
    .filter((row) => row.runtime === runtime && row.result.startsWith("passed"))
    .map((row) => row.version);
  return [...new Set(versions)].sort();
}

/**
 * The page with a new table. A runtime version and platform with results gets the
 * row of its newest run. A row without results stays, such as a row from the design probes.
 */
export function renderDoc(doc: string, results: readonly CaseResult[]): string {
  const groups = new Map<string, CaseResult[]>();
  for (const result of results) {
    const key = `${result.runtime} ${result.version} ${result.platform}`;
    groups.set(key, [...(groups.get(key) ?? []), result]);
  }
  const rows = new Map<string, TableRow>();
  for (const row of parseTable(doc)) rows.set(`${row.runtime} ${row.version} ${row.platform}`, row);
  for (const [key, group] of groups) {
    const newest = group.reduce((latest, result) => (result.run > latest ? result.run : latest), "");
    const cases = group.filter((result) => result.run === newest);
    const failed = cases.filter((result) => !result.passed).map((result) => result.case);
    const first = cases[0]!;
    const result = failed.length === 0 ? `passed all ${cases.length} cases` : `failed: ${failed.join("; ")}`;
    rows.set(key, { runtime: first.runtime, version: first.version, platform: first.platform, run: first.date, result });
  }
  const sorted = [...rows.values()].sort((a, b) =>
    a.runtime !== b.runtime ? (a.runtime < b.runtime ? -1 : 1) : a.version !== b.version ? Bun.semver.order(b.version, a.version) : a.platform < b.platform ? -1 : 1,
  );
  const table = [
    "| Runtime | Version | Platform | Run | Result |",
    "| --- | --- | --- | --- | --- |",
    ...sorted.map((row) => `| ${row.runtime} | ${row.version} | ${row.platform} | ${row.run} | ${row.result} |`),
  ].join("\n");
  const start = doc.indexOf(START);
  const end = doc.indexOf(END);
  return `${doc.slice(0, start + START.length)}\n${table}\n${doc.slice(end)}`;
}

/** Writes the version table of the runtimes page from the results of all runs. */
export function writeRuntimeTable(): void {
  if (!existsSync(RESULTS) || !existsSync(RUNTIMES_DOC)) return;
  const results = readFileSync(RESULTS, "utf8")
    .split("\n")
    .filter((line) => line.trim() !== "")
    .map((line) => JSON.parse(line) as CaseResult);
  writeFileSync(RUNTIMES_DOC, renderDoc(readFileSync(RUNTIMES_DOC, "utf8"), results));
}
