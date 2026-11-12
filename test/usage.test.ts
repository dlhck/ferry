import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { buildProgram } from "../src/cli.ts";
import type { PartialOperatorConfig } from "../src/config.ts";
import type { LinkOptions, LinkResult } from "../src/link.ts";
import { BUILTIN_HARNESSES } from "../src/registry/builtin.ts";
import { countUsage } from "../src/usage-count.ts";
import { parseSince, readAnswer, runUsage, usageCountCommand, usageLines, type UsageReport } from "../src/usage.ts";

const SECRET = "the session text that must stay on the box";
const TOKEN = `ghp_${"a".repeat(36)}`;
const homes: string[] = [];

afterEach(() => {
  for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true });
});

function home(files: Record<string, readonly object[]>): string {
  const dir = mkdtempSync(join(tmpdir(), "ferry-usage-"));
  homes.push(dir);
  for (const [path, lines] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, path)), { recursive: true });
    writeFileSync(join(dir, path), `${lines.map((line) => JSON.stringify(line)).join("\n")}\nnot json\n`);
  }
  return dir;
}

const claudeLine = (id: string, timestamp: string, cwd: string, usage: object) => ({
  type: "assistant",
  timestamp,
  cwd,
  message: { id, role: "assistant", content: [{ type: "text", text: SECRET }], usage },
});
const claudeUsage = { input_tokens: 10, output_tokens: 20, cache_read_input_tokens: 300, cache_creation_input_tokens: 40 };

const codexUsage = (input: number, cached: number, output: number) => ({
  input_tokens: input,
  cached_input_tokens: cached,
  output_tokens: output,
  cache_write_input_tokens: 0,
  total_tokens: input + output,
});
const codexEvent = (timestamp: string, last: ReturnType<typeof codexUsage>, total: number) => ({
  timestamp,
  type: "event_msg",
  payload: { type: "token_count", info: { last_token_usage: last, total_token_usage: { total_tokens: total } } },
});

describe("ferry usage-count", () => {
  test("adds the tokens of each harness, project, and day, and gives no session text", async () => {
    const dir = home({
      ".claude/projects/-home-user-app/one.jsonl": [
        { type: "user", timestamp: "2026-01-02T09:00:00.000Z", cwd: "/home/user/app", message: { content: SECRET } },
        // One API message on two lines counts once.
        claudeLine("msg_1", "2026-01-02T09:01:00.000Z", "/home/user/app", claudeUsage),
        claudeLine("msg_1", "2026-01-02T09:01:00.000Z", "/home/user/app", claudeUsage),
        claudeLine("msg_2", "2026-01-03T09:00:00.000Z", "/home/user/app", claudeUsage),
      ],
      // A resumed session copies msg_1 into a new file. It still counts once.
      ".claude/projects/-home-user-app/two.jsonl": [
        claudeLine("msg_1", "2026-01-02T09:01:00.000Z", "/home/user/app", claudeUsage),
        claudeLine("msg_3", "2026-01-03T10:00:00.000Z", "/home/user/app", claudeUsage),
      ],
      ".claude/projects/-home-user-app/two/subagents/agent-a.jsonl": [
        claudeLine("msg_4", "2026-01-03T11:00:00.000Z", `/home/user/${TOKEN}/app`, claudeUsage),
      ],
      ".codex/sessions/2026/01/02/rollout-a.jsonl": [
        { timestamp: "2026-01-02T08:00:00.000Z", type: "session_meta", payload: { id: "a", cwd: "/home/user/api", base_instructions: SECRET } },
        { timestamp: "2026-01-02T08:00:01.000Z", type: "response_item", payload: { type: "message", content: SECRET } },
        codexEvent("2026-01-02T08:01:00.000Z", codexUsage(1000, 800, 50), 1050),
        // Codex can repeat an event. The total does not grow, so it does not count.
        codexEvent("2026-01-02T08:01:00.000Z", codexUsage(1000, 800, 50), 1050),
        codexEvent("2026-01-02T08:02:00.000Z", codexUsage(2000, 1500, 100), 3150),
      ],
      // The same total in another file is another session.
      ".codex/sessions/2026/01/02/rollout-b.jsonl": [
        { timestamp: "2026-01-02T08:00:00.000Z", type: "session_meta", payload: { id: "b", cwd: "/home/user/api" } },
        codexEvent("2026-01-02T12:00:00.000Z", codexUsage(1000, 800, 50), 1050),
      ],
      ".codex/sessions/2026/01/02/notes.jsonl": [codexEvent("2026-01-02T12:00:00.000Z", codexUsage(9, 0, 9), 18)],
      ".pi/agent/sessions/--home-user-web--/s.jsonl": [
        { type: "session", version: 3, id: "s", timestamp: "2026-01-02T07:00:00.000Z", cwd: "/home/user/web" },
        { type: "message", timestamp: "2026-01-02T07:01:00.000Z", message: { role: "user", content: SECRET } },
        {
          type: "message",
          timestamp: "2026-01-02T07:02:00.000Z",
          message: { role: "assistant", content: [{ type: "text", text: SECRET }], usage: { input: 5, output: 6, cacheRead: 7, cacheWrite: 8 } },
        },
        { type: "usage", timestamp: "2026-01-02T07:03:00.000Z", kind: "cache_warm", usage: { input: 0, output: 0, cacheRead: 100, cacheWrite: 0 } },
      ],
    });

    const result = await countUsage(BUILTIN_HARNESSES, dir, null);

    expect(result).toEqual({
      harnesses: [
        {
          id: "claude",
          available: true,
          projects: [
            { path: "/home/user/[token]/app", days: [{ day: "2026-01-03", input: 10, output: 20, cacheRead: 300, cacheWrite: 40 }] },
            {
              path: "/home/user/app",
              days: [
                { day: "2026-01-02", input: 10, output: 20, cacheRead: 300, cacheWrite: 40 },
                { day: "2026-01-03", input: 20, output: 40, cacheRead: 600, cacheWrite: 80 },
              ],
            },
          ],
        },
        {
          id: "codex",
          available: true,
          projects: [{ path: "/home/user/api", days: [{ day: "2026-01-02", input: 900, output: 200, cacheRead: 3100, cacheWrite: 0 }] }],
        },
        {
          id: "pi",
          available: true,
          projects: [{ path: "/home/user/web", days: [{ day: "2026-01-02", input: 5, output: 6, cacheRead: 107, cacheWrite: 8 }] }],
        },
        { id: "cursor", available: false, projects: [] },
      ],
    });
    const text = JSON.stringify(result);
    expect(text).not.toContain(SECRET);
    expect(text).not.toContain(TOKEN);
    expect(text).not.toContain("msg_");
  });

  test("--since counts only the records of that UTC day and later", async () => {
    const dir = home({
      ".claude/projects/-home-user-app/one.jsonl": [
        claudeLine("msg_1", "2026-01-01T23:59:59.000Z", "/home/user/app", claudeUsage),
        claudeLine("msg_2", "2026-01-02T00:00:00.000Z", "/home/user/app", claudeUsage),
      ],
    });

    const result = await countUsage(BUILTIN_HARNESSES.filter((harness) => harness.id === "claude"), dir, "2026-01-02");

    expect(result.harnesses[0]!.projects).toEqual([
      { path: "/home/user/app", days: [{ day: "2026-01-02", input: 10, output: 20, cacheRead: 300, cacheWrite: 40 }] },
    ]);
  });

  test("the box command prints the count, and a box install runs it", async () => {
    const dir = home({
      ".claude/projects/-home-user-app/one.jsonl": [claudeLine("msg_1", "2026-01-02T09:00:00.000Z", "/home/user/app", claudeUsage)],
    });
    const lines: string[] = [];
    const program = buildProgram({ readConfig: () => null, home: () => dir, isBoxMode: () => true, writeLine: (line) => lines.push(line) });

    await program.parseAsync(["--json", "usage-count", "--since", "2026-01-01"], { from: "user" });

    const envelope = JSON.parse(lines.join("\n"));
    expect(envelope).toMatchObject({ command: "usage-count", ok: true });
    const harnesses = readAnswer(lines.join("\n"));
    expect(Array.isArray(harnesses) && harnesses.map((harness) => [harness.id, harness.total])).toEqual([
      ["claude", { input: 10, output: 20, cacheRead: 300, cacheWrite: 40 }],
      ["codex", { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }],
      ["pi", { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }],
      ["cursor", null],
    ]);
    expect(lines.join("\n")).not.toContain(SECRET);
  });
});

describe("ferry usage", () => {
  const answer = (harnesses: unknown) => JSON.stringify({ schemaVersion: 1, command: "usage-count", ok: true, result: { harnesses }, warnings: [], error: null });

  test("takes only the numbers, days, ids, and paths from the box, and filters the paths again", () => {
    const harnesses = readAnswer(
      answer([
        {
          id: "claude",
          available: true,
          content: SECRET,
          projects: [
            {
              path: `/home/user/${TOKEN}`,
              text: SECRET,
              days: [{ day: "2026-01-02", input: 1, output: 2, cacheRead: 3, cacheWrite: 4, prompt: SECRET }],
            },
          ],
        },
        { id: "cursor", available: false, projects: [] },
      ]),
    );

    expect(harnesses).toEqual([
      {
        id: "claude",
        available: true,
        total: { input: 1, output: 2, cacheRead: 3, cacheWrite: 4 },
        projects: [
          {
            path: "/home/user/[token]",
            total: { input: 1, output: 2, cacheRead: 3, cacheWrite: 4 },
            days: [{ day: "2026-01-02", input: 1, output: 2, cacheRead: 3, cacheWrite: 4 }],
          },
        ],
      },
      { id: "cursor", available: false, total: null, projects: [] },
    ]);
    expect(JSON.stringify(harnesses)).not.toContain(SECRET);
  });

  test("refuses an answer that is not in the full form, and names a box without a usable Ferry", () => {
    const unreadable = "the Ferry on the box gave an answer that this Ferry cannot read";
    expect(readAnswer(answer([{ id: "claude", available: true, projects: [{ path: SECRET, days: [{ day: "2026-01-02", input: "1" }] }] }]))).toStartWith(unreadable);
    expect(readAnswer(answer([{ id: "claude", available: true, projects: [{ path: `a\n${SECRET}`, days: [] }] }]))).toStartWith(unreadable);
    expect(readAnswer(answer([{ id: "cursor", available: false, projects: [{ path: "/a", days: [] }] }]))).toStartWith(unreadable);
    expect(readAnswer("MISSING\n")).toStartWith("Ferry is not installed on the box. Run ferry install.");
    const oldFerry = JSON.stringify({ ok: false, error: { code: "usage", message: "unknown command 'usage-count'" } });
    expect(readAnswer(oldFerry)).toStartWith("the Ferry on the box cannot count tokens. Run ferry update.");
    expect(readAnswer("Usage: ferry [options]")).toStartWith("the Ferry on the box cannot count tokens.");
    const failed = JSON.stringify({ ok: false, error: { code: "internal", message: `read ${TOKEN}` } });
    expect(readAnswer(failed)).not.toContain(TOKEN);
    const escape = JSON.stringify({ ok: false, error: { code: "internal", message: "read \u001b[2Jfile" } });
    expect(readAnswer(escape)).toBe("the Ferry on the box failed: read ?[2Jfile");
  });

  test("an offline box and a box without Ferry get their reason, and the other boxes still run", async () => {
    const config: PartialOperatorConfig = {
      boxes: ["a", "b", "c"].map((name) => ({ name, host: { transport: "ssh" as const, destination: `user@box-${name}.example` } })),
    };
    const commands: string[] = [];
    const createLink = (options: LinkOptions) => ({
      async run(command: string): Promise<LinkResult> {
        commands.push(command);
        const text = JSON.stringify(options);
        if (text.includes("box-a")) return { ok: false, error: { code: "host-offline", origin: "network", message: "the host is offline" } };
        const stdout = text.includes("box-b")
          ? "MISSING\n"
          : answer([{ id: "claude", available: true, projects: [] }, { id: "cursor", available: false, projects: [] }]);
        return { ok: true, address: "100.64.0.8", stdout, stderr: "" };
      },
    });

    const report = await runUsage([], "2026-01-02", { readConfig: () => config, createLink });

    expect(commands).toEqual([usageCountCommand("2026-01-02"), usageCountCommand("2026-01-02"), usageCountCommand("2026-01-02")]);
    expect(report.boxes.map((box) => [box.name, box.online, box.error === null])).toEqual([
      ["a", false, false],
      ["b", true, false],
      ["c", true, true],
    ]);
    expect(usageLines(report)).toEqual([
      "a: offline (the host is offline)",
      "b: not available (Ferry is not installed on the box. Run ferry install. A development build of Ferry puts no Ferry on a box)",
      "c (since 2026-01-02):",
      "  HARNESS  INPUT  OUTPUT  CACHE READ  CACHE WRITE  PROJECT",
      "  claude       0       0           0            0  -",
      "  cursor: not available, the harness records no token counts",
    ]);
  });

  test("prints one row for each harness and project, with a harness without counts as not available", () => {
    const total = { input: 1200, output: 34, cacheRead: 5_600_000, cacheWrite: 7 };
    const report: UsageReport = {
      since: null,
      boxes: [
        {
          name: "a",
          online: true,
          error: null,
          harnesses: [
            { id: "claude", available: true, total, projects: [{ path: "/home/user/app", total, days: [] }] },
            { id: "cursor", available: false, total: null, projects: [] },
          ],
        },
      ],
    };

    expect(usageLines(report)).toEqual([
      "a:",
      "  HARNESS  INPUT  OUTPUT  CACHE READ  CACHE WRITE  PROJECT",
      "  claude   1,200      34   5,600,000            7  /home/user/app",
      "  cursor: not available, the harness records no token counts",
    ]);
  });

  test("--since takes a UTC day, and refuses other text", () => {
    expect(parseSince(undefined)).toBeNull();
    expect(parseSince("2026-01-02")).toBe("2026-01-02");
    expect(() => parseSince("2026-02-30")).toThrow("invalid --since date");
    expect(() => parseSince("2026-01-02; rm -rf ~")).toThrow("invalid --since date");
  });

  test("wires ferry usage to the --box selection and --since, and prints the report with --json", async () => {
    const received: unknown[] = [];
    const lines: string[] = [];
    const program = buildProgram({
      readConfig: () => null,
      writeLine: (line) => lines.push(line),
      runUsage: async (selection, since) => {
        received.push([selection, since]);
        return { since, boxes: [{ name: "a", online: false, error: "the host is offline", harnesses: [] }] };
      },
    });

    await program.parseAsync(["--box", "a", "--json", "usage", "--since", "2026-01-02"], { from: "user" });

    expect(received).toEqual([[["a"], "2026-01-02"]]);
    expect(JSON.parse(lines.join("\n"))).toMatchObject({
      command: "usage",
      ok: true,
      result: { since: "2026-01-02", boxes: [{ name: "a", online: false, error: "the host is offline", harnesses: [] }] },
    });
  });
});
