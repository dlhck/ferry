/**
 * Fake Claude Code and Codex runtimes for the messaging tests (design 14.3).
 * They implement the `FakeRuntimes` contract of `test/messaging/harness/contracts.ts`.
 *
 * API:
 *
 *   const runtimes = await createFakeRuntimes({ root, clock, versions });
 *   const worker = await runWorker({ home: home.home, adapters: runtimes.adapters(home), ... });
 *   const session = await runtimes.start("claude", { home, cwd });
 *   await worker.handle({ v: 1, id: "1", op: "hook.sessionStart", params: {
 *     runtime: "claude", event: session.hookInput("SessionStart"), caller: session.caller(),
 *     env: { messagingSocket: ..., messagingToken: ... } } });   // from session.hookEnv()
 *   session.setActivity("busy"); session.received(); await session.crash(); await session.resume();
 *   await runtimes.stop();
 *
 * Each session is a real child process. Its program is a shebang script named
 * `claude` or `codex` in `<root>/bin`, so its executable name (`comm`) is the
 * runtime name, and the worker finds it in the caller ancestry and checks its
 * liveness as it does for a real runtime. The script runs this file again in
 * the child, in one of three modes:
 *
 * - `--version`: prints `<version> (Claude Code)` or `codex-cli <version>`.
 * - `queue --thread <id> --message <text>` (Codex only): writes a row to
 *   `<CODEX_HOME>/queue_1.sqlite`, table `queued_items`, and prints
 *   `Queued message <id> for thread <thread>.`. It refuses `--resume`.
 * - `fake-session <config>`: the session itself.
 *   - Claude: listens on a fake inbox socket. A connection must send the auth
 *     line with the session token first. Each later frame goes to the
 *     transcript when the session is idle or busy (at the next tool call
 *     boundary, which is the next poll of 20 ms), and waits while the session
 *     waits for approval.
 *   - Codex: holds a `flock` write lock on
 *     `<codex home>/thread-writer-locks/<thread>.lock` (through `bun:ffi`, so
 *     `/proc/locks` shows the session pid), and takes each queue row of its
 *     thread into the transcript when it is idle.
 *
 * The parent controls a session through files in its state directory:
 * `activity` and `command` (`exit`). `received()` reads the transcript. All
 * state is under `root`. Linux only, as the worker liveness checks are.
 */

import { Database } from "bun:sqlite";
import { randomBytes, randomUUID } from "node:crypto";
import { appendFileSync, chmodSync, closeSync, existsSync, mkdirSync, openSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { join } from "node:path";
import type { Adapter } from "../../../src/messaging/adapters/types.ts";
import { callerAncestors } from "../../../src/messaging/worker/registry.ts";
import { defaultAdapters } from "../../../src/messaging/worker/worker.ts";
import type {
  CreateFakeRuntimes,
  FakeActivity,
  FakeRuntime,
  FakeRuntimeSession,
} from "../harness/contracts.ts";
import type { TestHome } from "../harness/homes.ts";

/** The newest tested versions of design 9.2 and 9.3. */
export const FAKE_VERSIONS = { claude: "2.1.323", codex: "0.169.0" } as const;

const POLL_MS = 20;
const ENVELOPE = /<ferry-message [\s\S]*?<\/ferry-message>/;

type SessionConfig = {
  readonly runtime: FakeRuntime;
  readonly dir: string;
  readonly sessionId: string;
  readonly transcriptPath: string;
  readonly socketPath: string | null;
  readonly token: string | null;
  readonly codexHome: string | null;
};

export const createFakeRuntimes: CreateFakeRuntimes<Adapter> = async (options) => {
  const clock = options.clock ?? { now: () => Date.now() };
  const versions = { ...FAKE_VERSIONS, ...options.versions };
  const bin = join(options.root, "bin");
  mkdirSync(bin, { recursive: true });
  const programs = {} as Record<FakeRuntime, string>;
  for (const runtime of ["claude", "codex"] as const) {
    programs[runtime] = join(bin, runtime);
    writeFileSync(
      programs[runtime],
      `#!${process.execPath}\nimport { fakeRuntimeMain } from ${JSON.stringify(import.meta.path)};\nawait fakeRuntimeMain(${JSON.stringify(runtime)}, ${JSON.stringify(versions[runtime])});\n`,
    );
    chmodSync(programs[runtime], 0o755);
  }
  const running = new Set<Bun.Subprocess>();
  let count = 0;

  const launch = async (runtime: FakeRuntime, home: TestHome, cwd: string, sessionId: string, transcriptPath: string): Promise<FakeRuntimeSession> => {
    // A short path: a Unix socket path has at most 107 bytes.
    const dir = join(options.root, "s", String(++count));
    mkdirSync(dir, { recursive: true });
    const config: SessionConfig = {
      runtime,
      dir,
      sessionId,
      transcriptPath,
      socketPath: runtime === "claude" ? join(dir, "in.sock") : null,
      token: runtime === "claude" ? randomBytes(16).toString("hex") : null,
      codexHome: runtime === "codex" ? home.codexHome : null,
    };
    let current: FakeActivity = "idle";
    writeFileSync(join(dir, "activity"), current);
    const child = Bun.spawn([programs[runtime], "fake-session", JSON.stringify(config)], { cwd, env: { ...home.env }, stdout: "pipe", stderr: "inherit" });
    running.add(child);
    const reader = child.stdout.getReader();
    const first = await reader.read();
    reader.releaseLock();
    if (!new TextDecoder().decode(first.value ?? new Uint8Array()).includes("ready")) throw new Error(`The fake ${runtime} did not start.`);
    const gone = async () => {
      await child.exited;
      running.delete(child);
    };
    const session: FakeRuntimeSession = {
      runtime,
      runtimeSessionId: sessionId,
      runtimeVersion: versions[runtime],
      pid: child.pid,
      cwd,
      transcriptPath,
      home,
      caller: () => ({ ancestors: callerAncestors(child.pid) }),
      hookInput: (event, fields = {}) => ({
        session_id: sessionId,
        transcript_path: transcriptPath,
        cwd,
        hook_event_name: event,
        ...(event === "SessionStart" ? { source: "startup" } : {}),
        ...fields,
      }),
      hookEnv: (): Record<string, string> =>
        runtime === "claude" ? { CLAUDE_CODE_MESSAGING_SOCKET: config.socketPath!, CLAUDE_CODE_MESSAGING_TOKEN: config.token! } : { CODEX_HOME: config.codexHome! },
      activity: () => current,
      setActivity(activity) {
        current = activity;
        writeFileSync(join(dir, "activity"), activity);
      },
      received: () => receivedEnvelopes(transcriptPath),
      async exit() {
        writeFileSync(join(dir, "command"), "exit");
        await gone();
      },
      async crash() {
        child.kill(9);
        await gone();
      },
      resume: () => launch(runtime, home, cwd, sessionId, transcriptPath),
    };
    return session;
  };

  return {
    adapters: (home) => defaultAdapters(home.home, clock),
    async start(runtime, { home, cwd }) {
      const sessionId = randomUUID();
      const transcripts = join(options.root, "transcripts");
      mkdirSync(transcripts, { recursive: true });
      return await launch(runtime, home, cwd, sessionId, join(transcripts, `${sessionId}.jsonl`));
    },
    async stop() {
      for (const child of running) child.kill(9);
      await Promise.all([...running].map((child) => child.exited));
      running.clear();
    },
  };
};

/** The envelopes in a fake transcript, in order. */
export function receivedEnvelopes(transcriptPath: string): string[] {
  if (!existsSync(transcriptPath)) return [];
  const envelopes: string[] = [];
  for (const line of readFileSync(transcriptPath, "utf8").split("\n")) {
    if (!line) continue;
    const match = ENVELOPE.exec((JSON.parse(line) as { text: string }).text);
    if (match) envelopes.push(match[0]);
  }
  return envelopes;
}

// ---------------------------------------------------------------------------
// The child process

/** The entry of the fake runtime program. */
export async function fakeRuntimeMain(runtime: FakeRuntime, version: string): Promise<void> {
  const [mode, ...args] = process.argv.slice(2);
  if (mode === "--version") {
    console.log(runtime === "claude" ? `${version} (Claude Code)` : `codex-cli ${version}`);
    return;
  }
  if (mode === "queue" && runtime === "codex") return fakeCodexQueue(args);
  if (mode === "fake-session") return await fakeSession(JSON.parse(args[0]!) as SessionConfig);
  console.error(`fake ${runtime}: unknown arguments ${process.argv.slice(2).join(" ")}`);
  process.exit(2);
}

function queueStore(codexHome: string): Database {
  const db = new Database(join(codexHome, "queue_1.sqlite"), { create: true });
  db.exec("PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000;");
  db.exec(
    "CREATE TABLE IF NOT EXISTS queued_items (id TEXT PRIMARY KEY NOT NULL, thread_id TEXT NOT NULL, payload_json TEXT NOT NULL, queue_order INTEGER NOT NULL, created_at_ms INTEGER NOT NULL, updated_at_ms INTEGER NOT NULL)",
  );
  return db;
}

function fakeCodexQueue(args: string[]): void {
  if (args.includes("--resume")) {
    console.error("fake codex: --resume can start a stopped thread, and the worker must never pass it");
    process.exit(2);
  }
  const value = (flag: string) => {
    const index = args.indexOf(flag);
    return index >= 0 ? args[index + 1] : undefined;
  };
  const thread = value("--thread");
  const text = value("--message");
  const home = process.env.CODEX_HOME;
  if (!thread || text === undefined || !home) {
    console.error("fake codex: queue needs --thread, --message, and CODEX_HOME");
    process.exit(2);
  }
  const db = queueStore(home);
  const id = randomUUID();
  const order = (db.query("SELECT COALESCE(MAX(queue_order), -1) + 1 AS n FROM queued_items WHERE thread_id = ?").get(thread) as { n: number }).n;
  const payload = JSON.stringify({ UserInput: { content: [{ type: "text", text, text_elements: [] }] } });
  db.query("INSERT INTO queued_items VALUES (?, ?, ?, ?, ?, ?)").run(id, thread, payload, order, Date.now(), Date.now());
  db.close();
  console.log(`Queued message ${id} for thread ${thread}.`);
}

function flock(fd: number): void {
  const { dlopen } = require("bun:ffi") as typeof import("bun:ffi");
  const libc = dlopen("libc.so.6", { flock: { args: ["i32", "i32"], returns: "i32" } });
  // LOCK_EX
  if (libc.symbols.flock(fd, 2) !== 0) throw new Error("fake codex: flock failed");
}

async function fakeSession(config: SessionConfig): Promise<void> {
  const record = (text: string) => appendFileSync(config.transcriptPath, `${JSON.stringify({ type: "user", text })}\n`);
  const activity = () => {
    try {
      return readFileSync(join(config.dir, "activity"), "utf8").trim() as FakeActivity;
    } catch {
      return "idle";
    }
  };
  let finish: () => void = () => {};

  if (config.runtime === "claude") {
    const waiting: string[] = [];
    const server = createServer((connection) => {
      let buffer = "";
      let authed = false;
      connection.setEncoding("utf8");
      connection.on("data", (chunk: string) => {
        buffer += chunk;
        let newline: number;
        while ((newline = buffer.indexOf("\n")) >= 0) {
          const line = buffer.slice(0, newline);
          buffer = buffer.slice(newline + 1);
          const frame = JSON.parse(line) as { type?: string; token?: string; message?: { content?: string } };
          if (!authed) {
            authed = frame.type === "auth" && frame.token === config.token;
            if (!authed) connection.destroy();
            continue;
          }
          if (typeof frame.message?.content === "string") waiting.push(frame.message.content);
        }
      });
      connection.on("error", () => {});
    });
    await new Promise<void>((resolve) => server.listen(config.socketPath!, resolve));
    const timer = setInterval(() => {
      if (activity() !== "awaiting-approval") while (waiting.length > 0) record(waiting.shift()!);
    }, POLL_MS);
    finish = () => {
      clearInterval(timer);
      server.close();
      rmSync(config.socketPath!, { force: true });
    };
  } else {
    const lockPath = join(config.codexHome!, "thread-writer-locks", `${config.sessionId}.lock`);
    mkdirSync(join(config.codexHome!, "thread-writer-locks"), { recursive: true });
    const fd = openSync(lockPath, "w");
    flock(fd);
    const db = queueStore(config.codexHome!);
    const timer = setInterval(() => {
      if (activity() !== "idle") return;
      const rows = db.query("SELECT id, payload_json FROM queued_items WHERE thread_id = ? ORDER BY queue_order").all(config.sessionId) as { id: string; payload_json: string }[];
      for (const row of rows) {
        db.query("DELETE FROM queued_items WHERE id = ?").run(row.id);
        const payload = JSON.parse(row.payload_json) as { UserInput: { content: { text: string }[] } };
        record(payload.UserInput.content.map((part) => part.text).join("\n"));
      }
    }, POLL_MS);
    finish = () => {
      clearInterval(timer);
      db.close();
      rmSync(lockPath, { force: true });
      closeSync(fd);
    };
  }

  console.log("ready");
  await new Promise<void>((resolve) => {
    const timer = setInterval(() => {
      if (!existsSync(join(config.dir, "command"))) return;
      clearInterval(timer);
      finish();
      resolve();
    }, POLL_MS);
  });
  process.exit(0);
}
