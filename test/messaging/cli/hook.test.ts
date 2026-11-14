import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { callerAncestors, callWorker, hookFields, OFFLINE_CONTEXT, runHook, workerSocketPath, type LocalResponse } from "../../../src/messaging/hook.ts";
import { messagingEvents } from "../../../src/messaging/hooks.ts";
import { processStart } from "../../../src/process-start.ts";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

/** A home with `~/.ferry/messaging`, as after an enrollment. */
function home(messaging = true): string {
  const root = mkdtempSync(join(tmpdir(), "ferry-msg-hook-"));
  roots.push(root);
  if (messaging) mkdirSync(join(root, ".ferry", "messaging"), { recursive: true });
  return root;
}

const MSG = "msg_01JZ8X2T3V4W5Y6Z7A8B9C0D1E";
const offline = async (): Promise<LocalResponse> => ({ v: 1, id: "1", ok: false, error: { code: "worker-offline", message: "no worker" } });

describe("runHook", () => {
  test("sends the hook fields and the caller, and prints the context of the worker", async () => {
    const calls: { op: string; params: Record<string, unknown>; timeout: number }[] = [];
    const output = await runHook(
      { runtime: "claude", event: "SessionStart" },
      {
        home: home(),
        env: { CLAUDE_CODE_MESSAGING_SOCKET: "/run/example.sock", CODEX_HOME: "/home/user/.codex" },
        readStdin: async () => JSON.stringify({ session_id: "s1", cwd: "/home/user/app", source: "startup", tool_input: { secret: "x" } }),
        caller: () => ({ ancestors: [{ pid: 10, startTime: "boot:1" }] }),
        call: async (_socket, op, params, timeout) => {
          calls.push({ op, params, timeout });
          return { v: 1, id: "1", ok: true, result: { additionalContext: "Read the skill." } };
        },
      },
    );

    expect(JSON.parse(output)).toEqual({ hookSpecificOutput: { hookEventName: "SessionStart", additionalContext: "Read the skill." } });
    expect(calls).toEqual([
      {
        op: "hook.sessionStart",
        timeout: 1500,
        params: {
          runtime: "claude",
          event: { session_id: "s1", cwd: "/home/user/app", source: "startup" },
          caller: { ancestors: [{ pid: 10, startTime: "boot:1" }] },
          env: { messagingSocket: "/run/example.sock", codexHome: "/home/user/.codex" },
        },
      },
    ]);
  });

  test("maps the Claude Notification hook to a permission request, and prints nothing for it", async () => {
    const ops: string[] = [];
    const output = await runHook(
      { runtime: "claude", event: "Notification" },
      { home: home(), readStdin: async () => "{}", caller: () => ({ ancestors: [] }), call: async (_s, op) => (ops.push(op), { v: 1, id: "1", ok: true, result: {} }) },
    );
    expect(output).toBe("");
    expect(ops).toEqual(["hook.permissionRequest"]);
  });

  test("each event of the hook settings reaches the worker", async () => {
    for (const runtime of ["claude", "codex"] as const) {
      for (const event of messagingEvents(runtime)) {
        let op = "";
        await runHook({ runtime, event }, { home: home(), readStdin: async () => "{}", caller: () => ({ ancestors: [] }), call: async (_s, called) => ((op = called), { v: 1, id: "1", ok: true, result: {} }) });
        expect(op).toStartWith("hook.");
      }
    }
  });

  test("does nothing without ~/.ferry/messaging, for an unknown event, and for an unknown runtime", async () => {
    let called = false;
    const call = async () => ((called = true), { v: 1 as const, id: "1", ok: true as const, result: {} });
    const dependencies = { readStdin: async () => "{}", caller: () => ({ ancestors: [] }), call };
    expect(await runHook({ runtime: "claude", event: "SessionStart" }, { ...dependencies, home: home(false) })).toBe("");
    expect(await runHook({ runtime: "claude", event: "Bogus" }, { ...dependencies, home: home() })).toBe("");
    expect(await runHook({ runtime: "pi", event: "SessionStart" }, { ...dependencies, home: home() })).toBe("");
    expect(called).toBe(false);
  });

  test("spools the request when the worker does not run, and gives the offline context only in a checkout", async () => {
    const root = home();
    const checkout = join(root, "app");
    mkdirSync(join(checkout, ".git"), { recursive: true });
    const run = (cwd: string, now: number) =>
      runHook(
        { runtime: "codex", event: "SessionStart" },
        { home: root, env: {}, readStdin: async () => JSON.stringify({ cwd }), caller: () => ({ ancestors: [] }), call: offline, now: () => now, pid: 7 },
      );

    expect(JSON.parse(await run(join(checkout, "src"), 1000)).hookSpecificOutput.additionalContext).toBe(OFFLINE_CONTEXT);
    expect(await run(root, 2000)).toBe("");

    const spool = join(root, ".ferry", "messaging", "spool");
    expect(readdirSync(spool).sort()).toEqual(["1000-7.json", "2000-7.json"]);
    expect(statSync(join(spool, "1000-7.json")).mode & 0o777).toBe(0o600);
    expect(JSON.parse(readFileSync(join(spool, "1000-7.json"), "utf8"))).toEqual({
      v: 1,
      id: "spool-1000-7",
      op: "hook.sessionStart",
      params: { runtime: "codex", event: { cwd: join(checkout, "src") }, caller: { ancestors: [] }, env: {} },
    });
  });

  test("prints nothing when the worker answers late", async () => {
    const output = await runHook(
      { runtime: "claude", event: "UserPromptSubmit" },
      { home: home(), readStdin: async () => "{}", caller: () => ({ ancestors: [] }), call: async () => ({ v: 1, id: "1", ok: false, error: { code: "worker-timeout", message: "late" } }) },
    );
    expect(output).toBe("");
  });
});

describe("hookFields", () => {
  test("keeps the starts of the Ferry envelopes of a prompt, and no other prompt text", () => {
    const prompt = `Please look.\n<ferry-message id="${MSG}" kind="request">\nsecret text\n</ferry-message>`;
    expect(hookFields(JSON.stringify({ prompt, session_id: "s1", hook_event_name: "UserPromptSubmit" }))).toEqual({
      prompt: `<ferry-message id="${MSG}"`,
      session_id: "s1",
      hook_event_name: "UserPromptSubmit",
    });
    expect(hookFields(JSON.stringify({ prompt: "no envelope" }))).toEqual({ prompt: "" });
    expect(hookFields("not json")).toEqual({});
  });
});

describe("callWorker", () => {
  test("sends one JSON line and reads the answer with the same id", async () => {
    const root = home();
    const socket = workerSocketPath(root);
    const requests: unknown[] = [];
    const server = createServer((connection) => {
      connection.setEncoding("utf8");
      connection.on("data", (line: string) => {
        const request = JSON.parse(line) as { id: string };
        requests.push(request);
        connection.write(`${JSON.stringify({ v: 1, id: request.id, ok: true, result: { additionalContext: null } })}\n`);
      });
    });
    await new Promise<void>((resolve) => server.listen(socket, resolve));
    try {
      const response = await callWorker(socket, "hook.stop", { runtime: "codex" }, 1000);
      expect(response.ok).toBe(true);
      expect(requests).toEqual([{ v: 1, id: response.id, op: "hook.stop", params: { runtime: "codex" } }]);
    } finally {
      server.close();
    }
  });

  test("gives worker-offline without a socket, and worker-timeout for a worker that does not answer", async () => {
    const root = home();
    expect(await callWorker(workerSocketPath(root), "status", {}, 500)).toMatchObject({ ok: false, error: { code: "worker-offline" } });
    const socket = workerSocketPath(root);
    const server = createServer(() => {});
    await new Promise<void>((resolve) => server.listen(socket, resolve));
    try {
      expect(await callWorker(socket, "status", {}, 100)).toMatchObject({ ok: false, error: { code: "worker-timeout" } });
    } finally {
      server.close();
    }
  });
});

test("callerAncestors starts with this process, with its start in the form of processStart", () => {
  const { ancestors } = callerAncestors();
  expect(ancestors[0]).toEqual({ pid: process.pid, startTime: processStart(process.pid)! });
  expect(ancestors.length).toBeGreaterThan(1);
  expect(ancestors[1]!.pid).toBe(process.ppid);
});
