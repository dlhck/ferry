/**
 * Raw clients for the two wire protocols, so that the suites check the wire and not
 * only the TypeScript interfaces.
 *
 * - `callWorker`: one call on the worker socket (design 8.1), as a hook or the MCP server makes it.
 * - `RelayHttp`: the relay HTTP API (design 7) with a device credential, for assertions
 *   and for the faults that need a hand-made request.
 */

import { createHash, randomBytes } from "node:crypto";
import { createConnection } from "node:net";

export type WorkerReply = { readonly ok: true; readonly result: unknown } | { readonly ok: false; readonly error: { readonly code: string; readonly message: string } };

let nextId = 1;

/** Sends one request line on the worker socket and reads one response line. */
export function callWorker(socketPath: string, op: string, params: Record<string, unknown>, timeoutMs = 10_000): Promise<WorkerReply> {
  const id = `t${nextId++}`;
  return new Promise((resolve, reject) => {
    const socket = createConnection(socketPath);
    let buffer = "";
    const timer = setTimeout(() => {
      socket.destroy();
      reject(new Error(`the worker did not answer ${op} in ${timeoutMs} ms`));
    }, timeoutMs);
    socket.on("connect", () => socket.write(`${JSON.stringify({ v: 1, id, op, params })}\n`));
    socket.on("data", (chunk) => {
      buffer += chunk.toString("utf8");
      const end = buffer.indexOf("\n");
      if (end === -1) return;
      clearTimeout(timer);
      socket.end();
      const line = JSON.parse(buffer.slice(0, end)) as { v: number; id: string } & WorkerReply;
      if (line.v !== 1 || line.id !== id) reject(new Error(`the worker answered another request: ${buffer.slice(0, end)}`));
      else resolve(line.ok ? { ok: true, result: line.result } : { ok: false, error: line.error });
    });
    socket.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
  });
}

/** A new device credential (design 1.2): `fmr_` and 32 random bytes in base64url. */
export function newCredential(): { readonly credential: string; readonly sha256: string } {
  const credential = `fmr_${randomBytes(32).toString("base64url")}`;
  return { credential, sha256: createHash("sha256").update(credential).digest("hex") };
}

/** A new idempotency key (design 5.2). Not a real ULID, but of the same form. */
export function newIdempotencyKey(): string {
  const alphabet = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
  const bytes = randomBytes(26);
  return `idk_${[...bytes].map((byte) => alphabet[byte % 32]).join("")}`;
}

export type RelayResponse<T = Record<string, unknown>> = { readonly status: number; readonly headers: Headers; readonly body: T };

export class RelayHttp {
  constructor(
    readonly url: string,
    private readonly credential: string | null,
  ) {}

  get<T = Record<string, unknown>>(path: string): Promise<RelayResponse<T>> {
    return this.request<T>("GET", path, undefined, null);
  }

  /** A mutating call. A new idempotency key unless the test gives one. */
  post<T = Record<string, unknown>>(path: string, body: unknown, key: string | null = newIdempotencyKey()): Promise<RelayResponse<T>> {
    return this.request<T>("POST", path, body, path.startsWith("/v1/enroll/") ? null : key);
  }

  async request<T>(method: string, path: string, body: unknown, key: string | null): Promise<RelayResponse<T>> {
    const headers: Record<string, string> = { "Ferry-Protocol": "1", "Ferry-Version": "0.0.0-test" };
    if (this.credential !== null) headers.Authorization = `Bearer ${this.credential}`;
    if (key !== null) headers["Idempotency-Key"] = key;
    if (body !== undefined) headers["Content-Type"] = "application/json";
    const response = await fetch(`${this.url}${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
    const text = await response.text();
    return { status: response.status, headers: response.headers, body: (text === "" ? {} : JSON.parse(text)) as T };
  }
}
