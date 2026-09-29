/**
 * `ferry tunnel` opens box ports, or ports of a host that the box can reach,
 * on the operator machine, lists the ports that
 * listen on the box, or with `--follow` opens a forward for each port that
 * `ferry expose` announces on the box.
 */

import { mkdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { quoteShell } from "./box-settings.ts";
import { resolveLinkOptions, type OperatorHostConfig } from "./config.ts";
import { EXPOSED_DIR } from "./expose.ts";
import { Link, type ControlConnection, type LinkOptions, type TunnelPort } from "./link.ts";
import { FerryError } from "./errors.ts";
import { errorEvent, type OutputEvent } from "./output.ts";

export type TunnelInput = {
  /** Port specs: `[<host>:]<box>[:<local>]`. */
  readonly ports: readonly string[];
  readonly list: boolean;
  /** Follow the entries of `ferry expose` on the box. */
  readonly follow?: boolean;
  readonly box: { readonly name: string; readonly host: OperatorHostConfig };
};

type TunnelLink = Pick<Link, "run" | "tunnel" | "master" | "reach">;

export type TunnelDependencies = {
  readonly createLink: (options: LinkOptions) => TunnelLink;
  readonly writeLine: (line: string) => void;
  /** Calls `stop` on Ctrl-C (SIGINT) or SIGTERM. Returns a function that removes the handlers. */
  readonly onInterrupt: (stop: () => void) => () => void;
  readonly isPortFree: (port: number) => Promise<boolean>;
  /** The control socket of the master connection of `--follow`. */
  readonly controlPath: string;
  /** The wait before `--follow` connects again after the connection drops. */
  readonly reconnectMs: number;
  /** With --json, prints one event for each forward change. */
  readonly emit: (event: OutputEvent) => void;
  /** Writes `~/.ferry/tunnels/<box>.json` of `--follow`. */
  readonly writeTunnelFile: (file: TunnelFile) => void;
  /** Removes `~/.ferry/tunnels/<box>.json` when `--follow` stops. */
  readonly removeTunnelFile: (box: string) => void;
};

/** The content of `~/.ferry/tunnels/<box>.json`. The menu bar app reads it. */
export type TunnelFile = {
  readonly schemaVersion: 1;
  readonly box: string;
  /** The pid of `ferry tunnel --follow`. A reader ignores the file when this pid does not run. */
  readonly pid: number;
  /** False after the connection drops, until Ferry connects again. */
  readonly connected: boolean;
  /** ISO 8601 time. */
  readonly updatedAt: string;
  readonly forwards: readonly {
    readonly name?: string;
    readonly cwd?: string;
    readonly boxPort: number;
    readonly localPort: number;
  }[];
};

/** A live entry of `~/.ferry/exposed/` on the box. */
export type FollowEntry = {
  readonly pid: number;
  readonly port: number;
  readonly name: string | null;
  readonly cwd: string | null;
};

/** An open forward of `--follow`. */
export type FollowForward = FollowEntry & { readonly localPort: number };

export type Listener = { readonly port: number; readonly address: string; readonly process: string };

/**
 * One read-only command. The first line names the source of the listeners:
 * `ss`, then `netstat`, then the kernel tables in `/proc`.
 */
export const LIST_COMMAND =
  "if command -v ss >/dev/null 2>&1; then echo '# ss'; ss -ltnpH; " +
  "elif command -v netstat >/dev/null 2>&1; then echo '# netstat'; netstat -ltnp 2>/dev/null; " +
  "else echo '# proc'; cat /proc/net/tcp /proc/net/tcp6 2>/dev/null || true; fi";

/**
 * The long command of `--follow` on the box. It prints the box home once, then
 * a snapshot of the live entries each time they change: one line
 * `<pid> TAB <entry JSON>` for each entry whose pid runs, then a line `.`. It
 * waits with inotifywait when the box has it, else it polls each second. The
 * wait has a limit, so an entry whose process stopped without removing its
 * file goes away too. An empty line every 30 s or so lets the command notice
 * a closed connection.
 */
export const FOLLOW_COMMAND = [
  `dir="$HOME/${EXPOSED_DIR}"`,
  "printf 'home\\t%s\\n' \"$HOME\"",
  "last=; first=1; beat=0",
  "while :; do",
  "  now=$(for f in \"$dir\"/*.json; do",
  "    [ -f \"$f\" ] || continue",
  "    pid=${f##*/}; pid=${pid%.json}",
  "    case \"$pid\" in (''|*[!0-9]*) continue ;; esac",
  "    kill -0 \"$pid\" 2>/dev/null || continue",
  "    printf '%s\\t' \"$pid\"; tr -d '\\n' < \"$f\"; echo",
  "  done)",
  "  if [ -n \"$first\" ] || [ \"$now\" != \"$last\" ]; then printf '%s\\n.\\n' \"$now\" || exit 0; last=$now; first=; beat=0; fi",
  "  beat=$((beat + 1)); if [ \"$beat\" -ge 30 ]; then echo || exit 0; beat=0; fi",
  "  if [ -d \"$dir\" ] && command -v inotifywait >/dev/null 2>&1; then",
  "    inotifywait -qq -t 1 -e create,delete,moved_to,close_write \"$dir\" >/dev/null 2>&1",
  "    [ $? -eq 1 ] && sleep 1",
  "  else",
  "    sleep 1",
  "  fi",
  "done",
].join("\n");

/** OpenSSH gets the SIGINT of Ctrl-C too, and can exit before Ferry sees the interrupt. */
const INTERRUPT_GRACE_MS = 200;

/** Returns the listeners of `--list`. A tunnel returns nothing when Ctrl-C closes it. */
export async function runTunnel(
  input: TunnelInput,
  dependencies: Partial<TunnelDependencies> = {},
): Promise<readonly Listener[] | undefined> {
  const resolved = { ...defaultDependencies, ...dependencies };
  if (input.follow === true) {
    if (input.ports.length > 0 || input.list) throw new Error("Give box ports, --list, or --follow, not more than one.");
    await follow(input.box, resolved);
    return undefined;
  }
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
          `such as ferry tunnel ${remoteTarget(port)}:${port.localPort + 1}.`,
      );
    }
  }

  const link = resolved.createLink(resolveLinkOptions(input.box.host));
  // The box connects to 127.0.0.1 only when a client connects, so a dev server can start later.
  for (const port of ports) {
    if (port.remoteHost === undefined) continue;
    const reached = await link.reach({ host: port.remoteHost, port: port.remotePort });
    if (reached.ok) continue;
    if (reached.error.origin === "box") {
      throw new Error(`${input.box.name} cannot reach ${remoteTarget(port)}: ${reached.error.message}`);
    }
    throw new Error(`Could not connect to ${input.box.name}: ${reached.error.message}`);
  }
  for (const port of ports) {
    resolved.emit({ type: "forward-opened", name: null, localPort: port.localPort, box: input.box.name, remotePort: port.remotePort });
    resolved.writeLine(`http://localhost:${port.localPort} -> ${input.box.name}:${remoteTarget({ remoteHost: "127.0.0.1", ...port })}`);
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
    resolved.emit({ type: "tunnel-closed", box: input.box.name });
    resolved.writeLine("Tunnel closed.");
    return;
  }
  const reason = result.ok ? "the SSH connection ended" : result.error.message;
  throw new Error(`The tunnel to ${input.box.name} closed: ${reason}`);
}

/**
 * Follow the entries of `ferry expose` on the box until Ctrl-C. When the
 * connection drops after it was open, Ferry connects again and reads the
 * entries again. The tunnel file shows the forwards while the command runs.
 */
async function follow(box: TunnelInput["box"], resolved: TunnelDependencies): Promise<void> {
  const link = resolved.createLink(resolveLinkOptions(box.host));
  const controller = new AbortController();
  const stopListening = resolved.onInterrupt(() => controller.abort());
  try {
    let connected = false;
    for (;;) {
      const ended = await followSession(link, box.name, resolved, controller.signal, connected);
      if (!controller.signal.aborted) await Bun.sleep(INTERRUPT_GRACE_MS);
      if (controller.signal.aborted) break;
      if (!ended.connected && !connected) throw new Error(`Could not connect to ${box.name}: ${ended.reason}`);
      connected ||= ended.connected;
      resolved.emit(
        errorEvent("connection-lost", new FerryError("box-offline", `The connection to ${box.name} closed: ${ended.reason}`), {
          box: box.name,
          retryInMs: resolved.reconnectMs,
        }),
      );
      writeTunnelFile(box.name, false, [], resolved);
      resolved.writeLine(`The connection to ${box.name} closed: ${ended.reason}. Ferry connects again in ${resolved.reconnectMs / 1_000} s.`);
      await abortableSleep(resolved.reconnectMs, controller.signal);
      if (controller.signal.aborted) break;
    }
  } finally {
    stopListening();
    resolved.removeTunnelFile(box.name);
  }
  resolved.emit({ type: "tunnel-closed", box: box.name });
  resolved.writeLine("Tunnel closed.");
}

/** One master connection and its forwards, until the connection ends or the signal aborts. */
async function followSession(
  link: TunnelLink,
  boxName: string,
  resolved: TunnelDependencies,
  signal: AbortSignal,
  reconnect: boolean,
): Promise<{ readonly connected: boolean; readonly reason: string }> {
  // A socket from a stopped run makes the new master fail.
  rmSync(resolved.controlPath, { force: true });
  const session = new AbortController();
  const master = await link.master({ controlPath: resolved.controlPath, signal: session.signal });
  if ("ok" in master) {
    session.abort();
    return { connected: false, reason: master.error.message };
  }
  // Close the forwards and the master connection first, then stop the box command.
  const close = () => void master.exit().finally(() => session.abort());
  signal.addEventListener("abort", close, { once: true });
  if (signal.aborted) close();
  resolved.emit({ type: "following", box: boxName, reconnected: reconnect });
  writeTunnelFile(boxName, true, [], resolved);
  resolved.writeLine(
    `${reconnect ? "Connected again. " : ""}Following the ports that ferry expose announces on ${boxName}. Press Ctrl-C to close the tunnel.`,
  );

  const forwards = new Map<number, FollowForward>();
  let home: string | null = null;
  let queue = Promise.resolve();
  const onLine = snapshotReader(
    (value) => {
      home = value;
    },
    (entries) => {
      queue = queue
        .then(() => reconcile(master, forwards, entries, boxName, () => home, resolved, signal))
        .then(() => {
          if (!signal.aborted) writeTunnelFile(boxName, true, forwards.values(), resolved);
        });
    },
  );
  // The login shell of the box can be another shell, so the script runs in sh.
  const watching = master.stream(`sh -c ${quoteShell(FOLLOW_COMMAND)}`, onLine, session.signal);
  const ended = await Promise.race([master.closed, watching]);
  signal.removeEventListener("abort", close);
  await queue;
  if (!signal.aborted) {
    await master.exit();
    session.abort();
  }
  await master.closed;
  return { connected: true, reason: ended.ok ? "the SSH connection ended" : ended.error.message };
}

/** Open and close forwards so they match the entries. Each change prints one line. */
async function reconcile(
  master: ControlConnection,
  forwards: Map<number, FollowForward>,
  entries: readonly FollowEntry[],
  boxName: string,
  home: () => string | null,
  resolved: TunnelDependencies,
  signal: AbortSignal,
): Promise<void> {
  if (signal.aborted) return;
  const { add, remove } = diffEntries(forwards, entries);
  for (const forward of remove) {
    forwards.delete(forward.port);
    const result = await master.cancel({ localPort: forward.localPort, remotePort: forward.port });
    const line = followLine(forward, forward.localPort, boxName, home());
    const fields = forwardFields(forward, forward.localPort, boxName);
    resolved.emit(
      result.ok
        ? { type: "forward-closed", ...fields }
        : errorEvent("forward-failed", new FerryError("forward-failed", `${line} could not close: ${result.error.message}`), fields),
    );
    resolved.writeLine(result.ok ? `${line} closed` : `${line} could not close: ${result.error.message}`);
  }
  for (const entry of add) {
    const taken = new Set([...forwards.values()].map((forward) => forward.localPort));
    const localPort = await pickLocalPort(entry.port, taken, resolved.isPortFree);
    if (localPort === null) {
      const line = `${followLine(entry, null, boxName, home())} has no free local port from ${entry.port}`;
      resolved.emit(errorEvent("forward-failed", new FerryError("forward-failed", line), forwardFields(entry, null, boxName)));
      resolved.writeLine(line);
      continue;
    }
    const forward = { ...entry, localPort };
    const result = await master.forward({ localPort, remotePort: entry.port });
    if (result.ok) forwards.set(entry.port, forward);
    resolved.emit(
      result.ok
        ? { type: "forward-opened", ...forwardFields(entry, localPort, boxName) }
        : errorEvent(
            "forward-failed",
            new FerryError("forward-failed", `${followLine(entry, localPort, boxName, home())} could not open: ${result.error.message}`),
            forwardFields(entry, localPort, boxName),
          ),
    );
    resolved.writeLine(
      result.ok
        ? followLine(entry, localPort, boxName, home())
        : `${followLine(entry, localPort, boxName, home())} could not open: ${result.error.message}`,
    );
  }
}

/**
 * The forwards to close and the entries to open. A box port is the key, so an
 * entry that a new process of the same port replaces keeps its forward.
 */
export function diffEntries(
  forwards: ReadonlyMap<number, FollowForward>,
  entries: readonly FollowEntry[],
): { readonly add: FollowEntry[]; readonly remove: FollowForward[] } {
  const next = new Map<number, FollowEntry>();
  for (const entry of entries) if (!next.has(entry.port)) next.set(entry.port, entry);
  return {
    add: [...next.values()].filter((entry) => !forwards.has(entry.port)),
    remove: [...forwards.values()].filter((forward) => !next.has(forward.port)),
  };
}

/** The box port when it is free on this machine, else the next free port. Null when no port is free. */
export async function pickLocalPort(
  port: number,
  taken: ReadonlySet<number>,
  isFree: (port: number) => Promise<boolean>,
): Promise<number | null> {
  for (let candidate = port; candidate <= 65_535; candidate += 1) {
    if (!taken.has(candidate) && (await isFree(candidate))) return candidate;
  }
  return null;
}

/**
 * A reader for the output of FOLLOW_COMMAND. It gets text chunks, and calls
 * `onHome` for the home line and `onSnapshot` with the entries of each
 * snapshot. A line that is not a valid entry is ignored.
 */
export function snapshotReader(
  onHome: (home: string) => void,
  onSnapshot: (entries: FollowEntry[]) => void,
): (text: string) => void {
  let buffer = "";
  let entries: FollowEntry[] = [];
  return (text) => {
    buffer += text;
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";
    for (const line of lines) {
      if (line === ".") {
        onSnapshot(entries);
        entries = [];
        continue;
      }
      const tab = line.indexOf("\t");
      if (tab === -1) continue;
      const key = line.slice(0, tab);
      const value = line.slice(tab + 1);
      if (key === "home") onHome(value);
      else {
        const entry = parseEntry(key, value);
        if (entry) entries.push(entry);
      }
    }
  };
}

function parseEntry(pid: string, json: string): FollowEntry | null {
  let value: unknown;
  try {
    value = JSON.parse(json);
  } catch {
    return null;
  }
  if (!/^\d+$/.test(pid) || typeof value !== "object" || value === null) return null;
  const { port, name, cwd } = value as Record<string, unknown>;
  if (typeof port !== "number" || !validPort(port)) return null;
  return {
    pid: Number(pid),
    port,
    name: typeof name === "string" && name !== "" ? name : null,
    cwd: typeof cwd === "string" && cwd !== "" ? cwd : null,
  };
}

/** `web  http://localhost:3000 -> box:3000 (~/app)`. */
/** The fields of a forward event of `--follow`. */
function forwardFields(entry: FollowEntry, localPort: number | null, boxName: string) {
  return { name: entry.name, localPort, box: boxName, remotePort: entry.port, pid: entry.pid, cwd: entry.cwd };
}

function followLine(entry: FollowEntry, localPort: number | null, boxName: string, home: string | null): string {
  const name = entry.name ?? `pid ${entry.pid}`;
  const local = localPort === null ? "" : `http://localhost:${localPort} -> `;
  const cwd = entry.cwd === null ? "" : ` (${home !== null && (entry.cwd === home || entry.cwd.startsWith(`${home}/`)) ? `~${entry.cwd.slice(home.length)}` : entry.cwd})`;
  return `${name}  ${local}${boxName}:${entry.port}${cwd}`;
}

function writeTunnelFile(box: string, connected: boolean, forwards: Iterable<FollowForward>, resolved: TunnelDependencies): void {
  resolved.writeTunnelFile({
    schemaVersion: 1,
    box,
    pid: process.pid,
    connected,
    updatedAt: new Date().toISOString(),
    forwards: [...forwards].map((forward) => ({
      ...(forward.name === null ? {} : { name: forward.name }),
      ...(forward.cwd === null ? {} : { cwd: forward.cwd }),
      boxPort: forward.port,
      localPort: forward.localPort,
    })),
  });
}

function tunnelFilePath(box: string): string {
  return join(homedir(), ".ferry", "tunnels", `${box}.json`);
}

function abortableSleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(done, ms);
    function done() {
      clearTimeout(timer);
      signal.removeEventListener("abort", done);
      resolve();
    }
    signal.addEventListener("abort", done, { once: true });
  });
}

/**
 * Parse `<box>`, `<box>:<local>`, `<host>:<box>`, and `<host>:<box>:<local>`
 * port specs. A numeric first part is a port on 127.0.0.1 of the box. An IPv6
 * host is in brackets. Two specs cannot use the same local port.
 */
export function parsePortSpecs(specs: readonly string[]): TunnelPort[] {
  const ports: TunnelPort[] = [];
  for (const spec of specs) {
    const match =
      /^()(\d+)(?::(\d+))?$/.exec(spec) ??
      /^\[([0-9A-Fa-f.:]*:[0-9A-Fa-f.:]*)\]:(\d+)(?::(\d+))?$/.exec(spec) ??
      /^((?!\d+:)[A-Za-z0-9_][A-Za-z0-9_.-]*):(\d+)(?::(\d+))?$/.exec(spec);
    const remoteHost = match?.[1] || undefined;
    const remotePort = Number(match?.[2]);
    const localPort = match?.[3] === undefined ? remotePort : Number(match[3]);
    if (!validPort(remotePort) || !validPort(localPort)) {
      throw new Error(
        `invalid port ${spec}. Give a box port from 1 through 65535, box:local such as 3000:3001, ` +
          "or host:port[:local] such as db.example:5432:15432.",
      );
    }
    if (ports.some((port) => port.localPort === localPort)) {
      throw new Error(`local port ${localPort} is given more than once.`);
    }
    ports.push(remoteHost === undefined ? { remotePort, localPort } : { remoteHost, remotePort, localPort });
  }
  return ports;
}

/** `3000`, `db.example:5432`, or `[fd00::1]:5432`. */
function remoteTarget(port: TunnelPort): string {
  if (port.remoteHost === undefined) return String(port.remotePort);
  return `${port.remoteHost.includes(":") ? `[${port.remoteHost}]` : port.remoteHost}:${port.remotePort}`;
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

async function listPorts(box: TunnelInput["box"], resolved: TunnelDependencies): Promise<readonly Listener[]> {
  const result = await resolved.createLink(resolveLinkOptions(box.host)).run(LIST_COMMAND);
  if (!result.ok) throw new Error(`Could not list the ports on ${box.name}: ${result.error.message}`);
  const listeners = parseListeners(result.stdout);
  if (listeners.length === 0) {
    resolved.writeLine(`No TCP port listens on loopback or all interfaces on ${box.name}.`);
    return listeners;
  }
  const rows = [["PORT", "ADDRESS", "PROCESS"], ...listeners.map((entry) => [String(entry.port), entry.address, entry.process])];
  const portWidth = Math.max(...rows.map((row) => row[0]!.length)) + 2;
  const addressWidth = Math.max(...rows.map((row) => row[1]!.length)) + 2;
  for (const [port, address, process] of rows) {
    resolved.writeLine(`${port!.padEnd(portWidth)}${address!.padEnd(addressWidth)}${process}`);
  }
  return listeners;
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
    // The user service manager stops the service with SIGTERM.
    process.once("SIGINT", stop);
    process.once("SIGTERM", stop);
    return () => {
      process.off("SIGINT", stop);
      process.off("SIGTERM", stop);
    };
  },
  isPortFree,
  controlPath: join(tmpdir(), `ferry-tunnel-${process.pid}.sock`),
  reconnectMs: 5_000,
  emit: () => {},
  // Replace the file in one rename, so a reader never sees half a file.
  writeTunnelFile: (file) => {
    const path = tunnelFilePath(file.box);
    const temporary = `${path}.tmp`;
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(temporary, `${JSON.stringify(file)}\n`, { mode: 0o600 });
    renameSync(temporary, path);
  },
  removeTunnelFile: (box) => rmSync(tunnelFilePath(box), { force: true }),
};
