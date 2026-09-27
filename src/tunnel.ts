/** `ferry tunnel` opens box ports on the operator machine, or lists the ports that listen on the box. */

import { resolveLinkOptions, type OperatorHostConfig } from "./config.ts";
import { Link, type LinkOptions, type TunnelPort } from "./link.ts";

export type TunnelInput = {
  /** Port specs: `<box>` or `<box>:<local>`. */
  readonly ports: readonly string[];
  readonly list: boolean;
  readonly box: { readonly name: string; readonly host: OperatorHostConfig };
};

type TunnelLink = Pick<Link, "run" | "tunnel">;

export type TunnelDependencies = {
  readonly createLink: (options: LinkOptions) => TunnelLink;
  readonly writeLine: (line: string) => void;
  /** Calls `stop` when the operator presses Ctrl-C. Returns a function that removes the handler. */
  readonly onInterrupt: (stop: () => void) => () => void;
  readonly isPortFree: (port: number) => Promise<boolean>;
};

export type Listener = { readonly port: number; readonly address: string; readonly process: string };

/**
 * One read-only command. The first line names the source of the listeners:
 * `ss`, then `netstat`, then the kernel tables in `/proc`.
 */
export const LIST_COMMAND =
  "if command -v ss >/dev/null 2>&1; then echo '# ss'; ss -ltnpH; " +
  "elif command -v netstat >/dev/null 2>&1; then echo '# netstat'; netstat -ltnp 2>/dev/null; " +
  "else echo '# proc'; cat /proc/net/tcp /proc/net/tcp6 2>/dev/null || true; fi";

/** OpenSSH gets the SIGINT of Ctrl-C too, and can exit before Ferry sees the interrupt. */
const INTERRUPT_GRACE_MS = 200;

export async function runTunnel(input: TunnelInput, dependencies: Partial<TunnelDependencies> = {}): Promise<void> {
  const resolved = { ...defaultDependencies, ...dependencies };
  if (input.list) {
    if (input.ports.length > 0) throw new Error("Give box ports or --list, not both.");
    return listPorts(input.box, resolved);
  }
  if (input.ports.length === 0) {
    throw new Error("Give at least one box port, such as ferry tunnel 3000, or use --list.");
  }

  const ports = parsePortSpecs(input.ports);
  for (const port of ports) {
    if (!(await resolved.isPortFree(port.localPort))) {
      throw new Error(
        `Local port ${port.localPort} is in use on this machine. Pick another local port with box:local, ` +
          `such as ferry tunnel ${port.remotePort}:${port.localPort + 1}.`,
      );
    }
  }

  const link = resolved.createLink(resolveLinkOptions(input.box.host));
  for (const port of ports) {
    resolved.writeLine(`http://localhost:${port.localPort} -> ${input.box.name}:127.0.0.1:${port.remotePort}`);
  }
  resolved.writeLine("Press Ctrl-C to close the tunnel.");

  const controller = new AbortController();
  const stopListening = resolved.onInterrupt(() => controller.abort());
  let result: Awaited<ReturnType<TunnelLink["tunnel"]>>;
  try {
    result = await link.tunnel({ ports, signal: controller.signal });
    if (!controller.signal.aborted) await Bun.sleep(INTERRUPT_GRACE_MS);
  } finally {
    stopListening();
  }
  if (controller.signal.aborted) {
    resolved.writeLine("Tunnel closed.");
    return;
  }
  const reason = result.ok ? "the SSH connection ended" : result.error.message;
  throw new Error(`The tunnel to ${input.box.name} closed: ${reason}`);
}

/** Parse `<box>` and `<box>:<local>` port specs. Two specs cannot use the same local port. */
export function parsePortSpecs(specs: readonly string[]): TunnelPort[] {
  const ports: TunnelPort[] = [];
  for (const spec of specs) {
    const match = /^(\d+)(?::(\d+))?$/.exec(spec);
    const remotePort = Number(match?.[1]);
    const localPort = match?.[2] === undefined ? remotePort : Number(match[2]);
    if (!validPort(remotePort) || !validPort(localPort)) {
      throw new Error(
        `invalid port ${spec}. Give a box port from 1 through 65535, or box:local, such as 3000:3001.`,
      );
    }
    if (ports.some((port) => port.localPort === localPort)) {
      throw new Error(`local port ${localPort} is given more than once.`);
    }
    ports.push({ remotePort, localPort });
  }
  return ports;
}

/** Bind the port on `127.0.0.1` for a moment. A port that Ferry cannot bind is busy. */
export async function isPortFree(port: number): Promise<boolean> {
  try {
    const server = Bun.listen({ hostname: "127.0.0.1", port, socket: { data() {} } });
    server.stop(true);
    return true;
  } catch {
    return false;
  }
}

/** The listeners on loopback or all interfaces, sorted by port. A process that is unknown without root is `-`. */
export function parseListeners(output: string): Listener[] {
  const [source, ...lines] = output.split("\n");
  const parse = source?.trim() === "# netstat" ? netstatLine : source?.trim() === "# proc" ? procLine : ssLine;
  const listeners: Listener[] = [];
  for (const line of lines) {
    const listener = parse(line.trim().split(/\s+/));
    if (!listener || !reachableByTunnel(listener.address)) continue;
    if (listeners.some((known) => sameListener(known, listener))) continue;
    listeners.push(listener);
  }
  return listeners.sort((a, b) => a.port - b.port);
}

async function listPorts(box: TunnelInput["box"], resolved: TunnelDependencies): Promise<void> {
  const result = await resolved.createLink(resolveLinkOptions(box.host)).run(LIST_COMMAND);
  if (!result.ok) throw new Error(`Could not list the ports on ${box.name}: ${result.error.message}`);
  const listeners = parseListeners(result.stdout);
  if (listeners.length === 0) {
    resolved.writeLine(`No TCP port listens on loopback or all interfaces on ${box.name}.`);
    return;
  }
  const rows = [["PORT", "ADDRESS", "PROCESS"], ...listeners.map((entry) => [String(entry.port), entry.address, entry.process])];
  const portWidth = Math.max(...rows.map((row) => row[0]!.length)) + 2;
  const addressWidth = Math.max(...rows.map((row) => row[1]!.length)) + 2;
  for (const [port, address, process] of rows) {
    resolved.writeLine(`${port!.padEnd(portWidth)}${address!.padEnd(addressWidth)}${process}`);
  }
}

/** `LISTEN 0 511 127.0.0.1:3000 0.0.0.0:* users:(("node",pid=812,fd=21))` */
function ssLine(fields: string[]): Listener | null {
  if (fields[0] !== "LISTEN" || fields[3] === undefined) return null;
  const process = /users:\(\("([^"]+)"/.exec(fields.slice(5).join(" "))?.[1] ?? "-";
  return hostPort(fields[3], process);
}

/** `tcp 0 0 127.0.0.1:3000 0.0.0.0:* LISTEN 812/node` */
function netstatLine(fields: string[]): Listener | null {
  if (!fields[0]?.startsWith("tcp") || fields[5] !== "LISTEN" || fields[3] === undefined) return null;
  const program = fields.slice(6).join(" ");
  const slash = program.indexOf("/");
  return hostPort(fields[3], slash === -1 ? "-" : program.slice(slash + 1) || "-");
}

/** `0: 0100007F:0BB8 00000000:0000 0A ...`. State `0A` is LISTEN. */
function procLine(fields: string[]): Listener | null {
  if (!/^\d+:$/.test(fields[0] ?? "") || fields[3] !== "0A") return null;
  const [hex, portHex] = (fields[1] ?? "").split(":");
  const address = hex?.length === 8 ? procIpv4(hex) : hex?.length === 32 ? procIpv6(hex) : null;
  const port = Number.parseInt(portHex ?? "", 16);
  return address && validPort(port) ? { port, address, process: "-" } : null;
}

function hostPort(local: string, process: string): Listener | null {
  const colon = local.lastIndexOf(":");
  const port = Number(local.slice(colon + 1));
  if (colon === -1 || !validPort(port)) return null;
  const address = local.slice(0, colon).replace(/^\[(.*)\]$/, "$1").replace(/%.*$/, "");
  return { port, address, process };
}

/** The kernel writes each 32-bit word of the address in host byte order, which is little-endian on x86 and arm64. */
function procBytes(hex: string): number[] {
  const bytes: number[] = [];
  for (let word = 0; word < hex.length; word += 8) {
    for (let byte = 6; byte >= 0; byte -= 2) bytes.push(Number.parseInt(hex.slice(word + byte, word + byte + 2), 16));
  }
  return bytes;
}

function procIpv4(hex: string): string {
  return procBytes(hex).join(".");
}

function procIpv6(hex: string): string {
  const bytes = procBytes(hex);
  if (bytes.every((byte) => byte === 0)) return "::";
  if (bytes.slice(0, 15).every((byte) => byte === 0) && bytes[15] === 1) return "::1";
  if (bytes.slice(0, 10).every((byte) => byte === 0) && bytes[10] === 0xff && bytes[11] === 0xff) {
    return `::ffff:${bytes.slice(12).join(".")}`;
  }
  const groups: string[] = [];
  for (let index = 0; index < 16; index += 2) groups.push(((bytes[index]! << 8) | bytes[index + 1]!).toString(16));
  return groups.join(":");
}

/** Loopback and all-interface listeners. A listener on another interface is not for a tunnel. */
function reachableByTunnel(address: string): boolean {
  return (
    ["*", "0.0.0.0", "::", "::1", "::ffff:0.0.0.0"].includes(address) ||
    address.startsWith("127.") ||
    address.startsWith("::ffff:127.")
  );
}

function sameListener(a: Listener, b: Listener): boolean {
  return a.port === b.port && a.address === b.address && a.process === b.process;
}

function validPort(port: number): boolean {
  return Number.isInteger(port) && port >= 1 && port <= 65_535;
}

const defaultDependencies: TunnelDependencies = {
  createLink: (options) => new Link(options),
  writeLine: console.log,
  onInterrupt: (stop) => {
    process.once("SIGINT", stop);
    return () => process.off("SIGINT", stop);
  },
  isPortFree,
};
