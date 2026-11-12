import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  EVENTS_DIR,
  mergeEvents,
  NOTIFY_HOOKS,
  NotifyError,
  parseBoxEvent,
  runNotify,
  withNotifyHooks,
  type AgentEvent,
} from "../src/notify.ts";
import { BUILTIN_HARNESSES } from "../src/registry/builtin.ts";

const homes: string[] = [];
afterEach(() => {
  for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true });
});

function home(): string {
  const path = mkdtempSync(join(tmpdir(), "ferry-notify-"));
  homes.push(path);
  return path;
}

const NOW = new Date("2026-11-11T10:00:00.000Z");
const TOKEN = `ghp_${"p".repeat(36)}`;

describe("runNotify", () => {
  test("writes one event with the cwd of the hook input and no other field of it", async () => {
    const dir = home();
    const stdin = JSON.stringify({
      session_id: "abc",
      transcript_path: "/home/user/.claude/projects/app/abc.jsonl",
      cwd: "/home/user/app",
      hook_event_name: "Stop",
      message: "secret prompt text",
    });

    const event = await runNotify(
      { harness: "claude", kind: "turn-ended" },
      { home: dir, cwd: "/home/user", pid: 41, now: () => NOW, readStdin: async () => stdin },
    );

    expect(event).toEqual({ id: `${NOW.getTime()}-41`, harness: "claude", kind: "turn-ended", project: "/home/user/app", at: NOW.toISOString() });
    const path = join(dir, EVENTS_DIR, `${event.id}.json`);
    expect(JSON.parse(readFileSync(path, "utf8"))).toEqual(event);
    expect(readFileSync(path, "utf8")).not.toContain("secret prompt text");
    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(readdirSync(join(dir, EVENTS_DIR))).toEqual([`${event.id}.json`]);
  });

  test("uses the current directory without a valid cwd in the hook input, and replaces a token in the path", async () => {
    const dir = home();
    for (const stdin of ["", "not json", '{"cwd":"relative/app"}']) {
      const event = await runNotify(
        { harness: "claude", kind: "waiting-for-input" },
        { home: dir, cwd: `/home/user/${TOKEN}`, pid: 41, now: () => NOW, readStdin: async () => stdin },
      );
      expect(event.project).toBe("/home/user/[token]");
    }
  });

  test("refuses an unknown kind or a harness id that is not valid", async () => {
    const dependencies = { home: home(), cwd: "/home/user", readStdin: async () => "" };
    await expect(runNotify({ harness: "claude", kind: "prompt" }, dependencies)).rejects.toThrow(NotifyError);
    await expect(runNotify({ harness: "../x", kind: "turn-ended" }, dependencies)).rejects.toThrow(NotifyError);
  });

  test("removes the events older than one hour and keeps the newest 20", async () => {
    const dir = home();
    const events = join(dir, EVENTS_DIR);
    mkdirSync(events, { recursive: true });
    const old = NOW.getTime() - 61 * 60 * 1_000;
    writeFileSync(join(events, `${old}-1.json`), "{}\n");
    for (let index = 0; index < 25; index += 1) writeFileSync(join(events, `${NOW.getTime() - 1_000 * (index + 1)}-2.json`), "{}\n");

    await runNotify({ harness: "claude", kind: "turn-ended" }, { home: dir, cwd: "/home/user", pid: 41, now: () => NOW, readStdin: async () => "" });

    const left = readdirSync(events).sort();
    expect(left).toHaveLength(20);
    expect(left).toContain(`${NOW.getTime()}-41.json`);
    expect(left).not.toContain(`${old}-1.json`);
    expect(left).not.toContain(`${NOW.getTime() - 25_000}-2.json`);
  });
});

const event: AgentEvent = { id: "1789000000000-41", harness: "claude", kind: "turn-ended", project: "/home/user/app", at: "2026-09-10T00:00:00.000Z" };

describe("parseBoxEvent", () => {
  test("keeps only the known fields, and replaces a token in the project again", () => {
    expect(parseBoxEvent(JSON.stringify({ ...event, prompt: "text" }))).toEqual(event);
    expect(parseBoxEvent(JSON.stringify({ ...event, project: `/home/user/${TOKEN}` }))?.project).toBe("/home/user/[token]");
  });

  test("refuses an event that is not valid", () => {
    for (const bad of [
      "not json",
      JSON.stringify({ ...event, id: "1/../x" }),
      JSON.stringify({ ...event, harness: "Claude Code" }),
      JSON.stringify({ ...event, kind: "prompt" }),
      JSON.stringify({ ...event, project: "app" }),
      JSON.stringify({ ...event, project: "/home/user/\u001b[31m" }),
      JSON.stringify({ ...event, at: "yesterday" }),
    ]) {
      expect(parseBoxEvent(bad)).toBeNull();
    }
  });
});

describe("mergeEvents", () => {
  const at = (index: number) => new Date(Date.UTC(2026, 8, 10, 0, index)).toISOString();
  const numbered = (index: number): AgentEvent => ({ ...event, id: `${1789000000000 + index}-41`, at: at(index) });

  test("adds only the new events with the receive time, and returns null when no event is new", () => {
    const known = [{ ...numbered(1), receivedAt: "2026-09-10T00:01:01.000Z" }];
    expect(mergeEvents(known, [numbered(1)], "later")).toBeNull();
    expect(mergeEvents(known, [numbered(1), numbered(2), numbered(2)], "2026-09-10T00:02:01.000Z")).toEqual([
      known[0]!,
      { ...numbered(2), receivedAt: "2026-09-10T00:02:01.000Z" },
    ]);
  });

  test("does not add a seen event", () => {
    expect(mergeEvents([], [numbered(1)], "now", [numbered(1).id])).toBeNull();
    expect(mergeEvents([], [numbered(1), numbered(2)], "now", [numbered(1).id])).toEqual([{ ...numbered(2), receivedAt: "now" }]);
  });

  test("keeps the newest 20 events, oldest first", () => {
    const merged = mergeEvents([], Array.from({ length: 25 }, (_, index) => numbered(24 - index)), "now");
    expect(merged?.map((entry) => entry.at)).toEqual(Array.from({ length: 20 }, (_, index) => at(index + 5)));
  });
});

describe("withNotifyHooks", () => {
  const claude = { harness: "claude", bytes: Buffer.from(JSON.stringify({ model: "opus", hooks: { Stop: [{ hooks: [{ type: "command", command: "paseo hooks claude stop" }] }] } })) };
  const decode = (bytes: Uint8Array) => JSON.parse(Buffer.from(bytes).toString());

  test("adds the hooks after the hooks of the operator and keeps the other keys", () => {
    const codex = { harness: "codex", bytes: Buffer.from("{}") };
    const settings = withNotifyHooks([codex, claude], BUILTIN_HARNESSES);

    expect(settings?.[0]).toBe(codex);
    expect(decode(settings![1]!.bytes)).toEqual({
      model: "opus",
      hooks: {
        Stop: [{ hooks: [{ type: "command", command: "paseo hooks claude stop" }] }, NOTIFY_HOOKS.Stop],
        Notification: [NOTIFY_HOOKS.Notification],
      },
    });
    expect(JSON.stringify(NOTIFY_HOOKS)).toContain('\\"$HOME/.local/bin/ferry\\" notify claude turn-ended');
    // The settings of the operator stay the same.
    expect(decode(claude.bytes).hooks.Notification).toBeUndefined();
  });

  test("returns null without the Claude settings or with Claude off for the box", () => {
    expect(withNotifyHooks([], BUILTIN_HARNESSES)).toBeNull();
    expect(withNotifyHooks([claude], BUILTIN_HARNESSES.filter((harness) => harness.id !== "claude"))).toBeNull();
  });
});
