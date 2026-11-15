/**
 * The worker socket (design section 8.1): `~/.ferry/messaging/worker.sock`,
 * a Unix socket in a directory with mode 0700. Each line is one JSON object,
 * a request or a response. A connection can send more than one request. The
 * worker answers each request in its order.
 *
 * The hooks and the MCP server are the clients (lane D). They hold no relay
 * credential. When the worker is down, a hook writes its request, as the
 * same `LocalRequest` JSON, to `~/.ferry/messaging/spool/<ms>-<pid>.json`
 * (mode 0600). The worker replays the spool at start, oldest first, and
 * removes each file.
 */

import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { createConnection, createServer, type Server } from "node:net";
import { dirname, join } from "node:path";
import type { Ancestor } from "./registry.ts";

export type LocalOp =
  | "hook.sessionStart"
  | "hook.userPromptSubmit"
  | "hook.stop"
  | "hook.permissionRequest"
  | "hook.postToolUse"
  | "hook.sessionEnd"
  | "tool.call"
  | "status";

export type Caller = { readonly ancestors: readonly Ancestor[] };

export type LocalRequest = { readonly v: 1; readonly id: string; readonly op: LocalOp; readonly params: Record<string, unknown> };
export type LocalResponse =
  | { readonly v: 1; readonly id: string; readonly ok: true; readonly result: unknown }
  | { readonly v: 1; readonly id: string; readonly ok: false; readonly error: { readonly code: string; readonly message: string } };

/** The answer times of design section 8.1. A hook client waits this long, then goes on without the worker. */
export const HOOK_DEADLINE_MS: Readonly<Partial<Record<LocalOp, number>>> = {
  "hook.sessionStart": 1500,
  "hook.userPromptSubmit": 1500,
  "hook.sessionEnd": 500,
};

const MAX_LINE = 1 << 20;

export function workerSocketPath(home: string): string {
  return join(home, ".ferry", "messaging", "worker.sock");
}

export function spoolDir(home: string): string {
  return join(home, ".ferry", "messaging", "spool");
}

function isRequest(value: unknown): value is LocalRequest {
  const request = value as LocalRequest | null;
  return request?.v === 1 && typeof request.id === "string" && typeof request.op === "string" && typeof request.params === "object" && request.params !== null;
}

/** True when a process answers on the socket path. */
async function answers(path: string): Promise<boolean> {
  return await new Promise((resolve) => {
    const connection = createConnection({ path });
    connection.on("connect", () => {
      connection.destroy();
      resolve(true);
    });
    connection.on("error", () => resolve(false));
  });
}

/**
 * Listen on the socket path. A socket file that no process answers on is
 * left from a crash, and the worker removes it. A live socket means another
 * worker runs, and this one refuses to start.
 */
export async function listenSocket(path: string, handle: (request: LocalRequest) => Promise<LocalResponse>): Promise<Server> {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  if (existsSync(path)) {
    if (await answers(path)) throw new Error(`Another Ferry messaging worker listens on ${path}.`);
    rmSync(path, { force: true });
  }
  const server = createServer((connection) => {
    let buffer = "";
    let queue = Promise.resolve();
    connection.setEncoding("utf8");
    connection.on("data", (chunk: string) => {
      buffer += chunk;
      if (buffer.length > MAX_LINE) {
        connection.destroy();
        return;
      }
      let newline: number;
      while ((newline = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        if (line.trim() === "") continue;
        queue = queue.then(async () => {
          const response = await answer(line, handle);
          if (!connection.destroyed) connection.write(`${JSON.stringify(response)}\n`);
        });
      }
    });
    connection.on("error", () => connection.destroy());
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(path, () => {
      server.off("error", reject);
      resolve();
    });
  });
  return server;
}

async function answer(line: string, handle: (request: LocalRequest) => Promise<LocalResponse>): Promise<LocalResponse> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    return { v: 1, id: "", ok: false, error: { code: "invalid-request", message: "The line is not JSON." } };
  }
  if (!isRequest(parsed)) {
    const id = typeof (parsed as { id?: unknown } | null)?.id === "string" ? (parsed as { id: string }).id : "";
    return { v: 1, id, ok: false, error: { code: "invalid-request", message: "The request needs v 1, an id, an op, and params." } };
  }
  try {
    return await handle(parsed);
  } catch (error) {
    return { v: 1, id: parsed.id, ok: false, error: { code: "internal", message: error instanceof Error ? error.message : String(error) } };
  }
}

/** The spooled requests, oldest first. Each file is removed after `handle` returns. A file that is not a request is removed too. */
export async function replaySpool(home: string, handle: (request: LocalRequest) => Promise<unknown>): Promise<number> {
  const dir = spoolDir(home);
  if (!existsSync(dir)) return 0;
  // The name starts with the time in ms. A numeric sort keeps the order also across a change in digit count.
  const files = readdirSync(dir)
    .filter((name) => name.endsWith(".json"))
    .sort((a, b) => Number.parseInt(a, 10) - Number.parseInt(b, 10) || a.localeCompare(b));
  let replayed = 0;
  for (const name of files) {
    const path = join(dir, name);
    try {
      const request = JSON.parse(readFileSync(path, "utf8")) as unknown;
      if (isRequest(request) && request.op.startsWith("hook.")) {
        await handle(request);
        replayed++;
      }
    } catch {
      // A file that is not valid JSON has no request to replay.
    }
    rmSync(path, { force: true });
  }
  return replayed;
}
