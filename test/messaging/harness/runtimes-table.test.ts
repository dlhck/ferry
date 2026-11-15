/**
 * The versions table of docs/agent-messaging-runtimes.md, which the real-CLI suite
 * writes, and the passed versions of the adapters (design 9.2 and 9.3) must agree.
 */

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { CLAUDE_PASSED } from "../../../src/messaging/adapters/claude.ts";
import { CODEX_PASSED } from "../../../src/messaging/adapters/codex.ts";
import { passedVersions, renderDoc, RUNTIMES_DOC, type CaseResult } from "../../e2e-runtimes/results.ts";

describe("runtime versions table", () => {
  test("the passed versions of the table equal the passed versions of the adapters", () => {
    const doc = readFileSync(RUNTIMES_DOC, "utf8");
    expect([...new Set(CLAUDE_PASSED)].sort(), "CLAUDE_PASSED and docs/agent-messaging-runtimes.md").toEqual(passedVersions(doc, "claude"));
    expect([...new Set(CODEX_PASSED)].sort(), "CODEX_PASSED and docs/agent-messaging-runtimes.md").toEqual(passedVersions(doc, "codex"));
  });

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
