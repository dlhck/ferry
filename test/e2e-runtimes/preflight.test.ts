/**
 * The preflight of the real-CLI suite. It runs on each `bun run test:e2e-runtimes`,
 * also without `FERRY_E2E_RUNTIMES=1`, and uses no model tokens. It finds the
 * runtimes, runs one Ferry hook without a worker, and prints which Codex hook
 * trust entries the Codex cases need. It only reads the Codex config.
 */

import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { CLAUDE_PASSED } from "../../src/messaging/adapters/claude.ts";
import { CODEX_PASSED } from "../../src/messaging/adapters/codex.ts";
import { BUN, CLI, codexHooksArg, e2eHooks, ready, RUN_ROOT, RUN_ID } from "./harness.ts";
import { runtimeVersion } from "./results.ts";

/** The source name that Codex 0.169 gives to hooks from `-c`, in the keys of `hooks.state`. */
const SESSION_FLAGS = "/<session-flags>/config.toml";

/** The `hooks.state` keys of the suite hooks: `<source>:<event in snake case>:<group>:<hook>`. */
export function codexTrustKeys(): string[] {
  return Object.entries(e2eHooks("codex")).flatMap(([event, groups]) =>
    groups.flatMap((group, g) =>
      (group.hooks as unknown[]).map((_, h) => `${SESSION_FLAGS}:${event.replace(/(?<!^)([A-Z])/g, "_$1").toLowerCase()}:${g}:${h}`),
    ),
  );
}

describe("real runtimes: preflight", () => {
  test("claude, codex, and tmux are on the PATH", () => {
    const lines: string[] = [];
    for (const [runtime, passed] of [
      ["claude", CLAUDE_PASSED],
      ["codex", CODEX_PASSED],
    ] as const) {
      const version = runtimeVersion(runtime);
      expect(version, `${runtime} --version`).not.toBe("unknown");
      lines.push(`${runtime} ${version}: ${passed.includes(version) ? "passed before" : "not tested yet, the adapter reports it as untested"}`);
    }
    const tmux = Bun.spawnSync(["tmux", "-V"], { stdout: "pipe", stderr: "pipe" });
    expect(tmux.exitCode, "tmux -V").toBe(0);
    lines.push(tmux.stdout.toString().trim());

    const config = join(process.env.CODEX_HOME ?? join(homedir(), ".codex"), "config.toml");
    const state = existsSync(config) ? ((Bun.TOML.parse(readFileSync(config, "utf8")) as { hooks?: { state?: Record<string, unknown> } }).hooks?.state ?? {}) : {};
    const missing = codexTrustKeys().filter((key) => state[key] === undefined);
    lines.push(
      missing.length === 0
        ? `Codex hook trust: an entry exists for each of the ${codexTrustKeys().length} suite hooks.`
        : `Codex hook trust: no entry for ${missing.join(", ")} in [hooks.state] of ${config}. The Codex cases fail until you trust the suite hooks (docs/agent-messaging-runtimes.md).`,
    );
    lines.push("The preflight cannot check the trusted_hash values. An entry from an older hook text does not count, and Codex asks again.");
    if (missing.length > 0) lines.push(`The -c value of the suite hooks, for a trust in /hooks:\n  codex -c '${codexHooksArg()}'`);
    lines.push(ready ? "FERRY_E2E_RUNTIMES=1: the cases run, with real model tokens." : "The cases skip. Set FERRY_E2E_RUNTIMES=1 to run them.");
    console.log(lines.join("\n"));
  });

  test("ferry messaging hook exits 0 with no output when no worker runs", () => {
    const home = join(RUN_ROOT, `preflight-${RUN_ID}`);
    mkdirSync(home, { recursive: true });
    const result = Bun.spawnSync([BUN, CLI, "messaging", "hook", "codex", "SessionStart"], {
      env: { ...process.env, HOME: home },
      stdin: new TextEncoder().encode(JSON.stringify({ hook_event_name: "SessionStart", session_id: "preflight", cwd: home, source: "startup" })),
      stdout: "pipe",
      stderr: "pipe",
    });
    expect(result.exitCode).toBe(0);
    expect(result.stdout.toString()).toBe("");
  });
});
