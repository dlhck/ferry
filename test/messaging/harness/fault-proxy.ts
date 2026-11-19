/**
 * A TCP proxy between the workers and the relay, for fault injection (design 15.2).
 *
 * The workers get the proxy URL as the relay URL. The test changes the mode to make
 * the network fail, and changes the target port when it restarts the relay, so the
 * relay URL stays the same.
 */

import { createConnection, createServer, type Server, type Socket } from "node:net";

export type FaultMode =
  /** Forward in both directions. */
  | "pass"
  /** Close each connection at once, as a network drop or a stopped relay does. */
  | "refuse";

export type FaultProxy = {
  readonly url: string;
  readonly port: number;
  mode(): FaultMode;
  setMode(mode: FaultMode): void;
  /**
   * The next request whose request line matches `requestLine` goes to the relay, but
   * the proxy closes the connection when the answer starts. The relay did the work,
   * and the client never saw the answer. Resolves when the proxy cut the answer.
   */
  cutNextResponse(requestLine: RegExp): Promise<void>;
  /** Forwards new connections to another relay port. */
  retarget(port: number): void;
  stop(): Promise<void>;
};

const REQUEST_LINE = /^[A-Z]+ \S+ HTTP\/1\.[01]\r\n/;

export async function startFaultProxy(targetPort: number): Promise<FaultProxy> {
  let target = targetPort;
  let current: FaultMode = "pass";
  let cut: { readonly pattern: RegExp; readonly done: () => void } | null = null;
  const open = new Set<Socket>();

  const server: Server = createServer((client) => {
    open.add(client);
    client.on("close", () => open.delete(client));
    client.on("error", () => client.destroy());
    if (current === "refuse") {
      client.destroy();
      return;
    }
    const upstream = createConnection({ host: "127.0.0.1", port: target });
    open.add(upstream);
    let cutThis: (() => void) | null = null;
    upstream.on("close", () => {
      open.delete(upstream);
      client.destroy();
    });
    upstream.on("error", () => client.destroy());
    client.on("close", () => upstream.destroy());
    client.on("data", (chunk: Buffer) => {
      const head = chunk.subarray(0, 512).toString("latin1");
      if (cut !== null && REQUEST_LINE.test(head) && cut.pattern.test(head.split("\r\n")[0] ?? "")) {
        cutThis = cut.done;
        cut = null;
      }
      upstream.write(chunk);
    });
    upstream.on("data", (chunk: Buffer) => {
      if (cutThis !== null || current === "refuse") {
        upstream.destroy();
        client.destroy();
        cutThis?.();
        cutThis = null;
        return;
      }
      client.write(chunk);
    });
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("the fault proxy has no TCP address");

  return {
    url: `http://127.0.0.1:${address.port}`,
    port: address.port,
    mode: () => current,
    setMode(mode) {
      current = mode;
      // A drop also ends the connections that are open now, such as a long poll.
      if (mode === "refuse") for (const socket of open) socket.destroy();
    },
    cutNextResponse(requestLine) {
      return new Promise<void>((resolve) => {
        cut = { pattern: requestLine, done: resolve };
      });
    },
    retarget(port) {
      target = port;
    },
    async stop() {
      for (const socket of open) socket.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}
