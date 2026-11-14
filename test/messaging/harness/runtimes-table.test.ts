/**
 * The versions table of docs/agent-messaging-runtimes.md, which the real-CLI suite
 * writes, and the passed versions of the adapters (design 9.2 and 9.3) must agree.
 */

import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { passedVersions, renderDoc, RUNTIMES_DOC, type CaseResult } from "../../e2e-runtimes/results.ts";
import { REPO_ROOT } from "./system.ts";

const ADAPTERS = {
  claude: { file: join(REPO_ROOT, "src", "messaging", "adapters", "claude.ts"), name: "CLAUDE_PASSED" },
  codex: { file: join(REPO_ROOT, "src", "messaging", "adapters", "codex.ts"), name: "CODEX_PASSED" },
} as const;
const adaptersPresent = existsSync(ADAPTERS.claude.file) && existsSync(ADAPTERS.codex.file);

describe("runtime versions table", () => {
  test.skipIf(!adaptersPresent)(
    adaptersPresent ? "the passed versions of the table equal the passed versions of the adapters" : "the table equals the adapters (waits for lane C, src/messaging/adapters)",
    async () => {
      const doc = readFileSync(RUNTIMES_DOC, "utf8");
      for (const runtime of ["claude", "codex"] as const) {
        const adapter = ADAPTERS[runtime];
        const passed = ((await import(adapter.file)) as Record<string, readonly string[]>)[adapter.name];
        expect(passed, `${adapter.name} in ${adapter.file}`).toBeArray();
        expect([...new Set(passed)].sort(), `${runtime}: ${adapter.name} and docs/agent-messaging-runtimes.md`).toEqual(passedVersions(doc, runtime));
      }
    },
  );

  test("a run replaces the rows of its versions and keeps the other rows", () => {
    const doc = [
      "intro",
      "<!-- e2e-runtimes:start -->",
      "| Runtime | Version | Platform | Run | Result |",
      "| --- | --- | --- | --- | --- |",
      "| claude | 2.1.323 | linux | 2026-11-13 | passed: design probes, section 20 |",
      "| codex | 0.169.0 | linux | 2026-11-13 | passed: design probes, section 20 |",
      "<!-- e2e-runtimes:end -->",
      "outro",
    ].join("\n");
    const result = (runtime: "claude" | "codex", version: string, name: string, passed: boolean): CaseResult => ({
      run: "20261120T100000Z",
      date: "2026-11-20",
      platform: "linux",
      runtime,
      version,
      case: name,
      passed,
    });
    const next = renderDoc(doc, [
      result("claude", "2.1.330", "Claude to idle Codex", true),
      result("codex", "0.169.0", "Claude to idle Codex", true),
      result("codex", "0.169.0", "codex kill -9", false),
    ]);
    expect(next.startsWith("intro\n")).toBe(true);
    expect(next.endsWith("\noutro")).toBe(true);
    expect(passedVersions(next, "claude")).toEqual(["2.1.323", "2.1.330"]);
    expect(passedVersions(next, "codex")).toEqual([]);
    expect(next).toContain("| codex | 0.169.0 | linux | 2026-11-20 | failed: codex kill -9 |");
    expect(next.indexOf("2.1.330")).toBeLessThan(next.indexOf("2.1.323"));
  });
});
