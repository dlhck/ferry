/**
 * Process ancestry and liveness for the messaging worker (design section 8.1).
 *
 * A hook or the MCP server sends its ancestors, from itself up to pid 1, with
 * the start of each process. The worker takes the first ancestor whose
 * executable name is a `processNames` entry of the Claude or Codex harness.
 * That process is the runtime, and the session of a call is the current
 * session of that process. The start makes a later process with the same pid
 * a different process.
 */

import { spawnSync } from "node:child_process";
import { readFileSync, readlinkSync, statSync } from "node:fs";
import { basename } from "node:path";
import { BUILTIN_HARNESSES } from "../../registry/builtin.ts";
import type { Runtime } from "../protocol.ts";

export type Ancestor = { readonly pid: number; readonly startTime: string };

/** The facts about a process that the worker reads. Each method returns null when the process is gone or Ferry cannot read it. */
export interface ProcessTable {
  start(pid: number): string | null;
  parent(pid: number): number | null;
  /** The executable name, as `ps` shows it. */
  name(pid: number): string | null;
  /** The path of the program file. */
  exe(pid: number): string | null;
  /** The arguments of the command line, the program first. */
  argv(pid: number): string[] | null;
}

function ps(field: string, pid: number): string | null {
  const result = spawnSync("/bin/ps", ["-o", `${field}=`, "-p", String(pid)], { encoding: "utf8", env: { LC_ALL: "C", TZ: "UTC" } });
  return result.status === 0 && result.stdout.trim() ? result.stdout.trim() : null;
}

/** The fields after the command name of `/proc/<pid>/stat`. The command name can have spaces. */
function statFields(pid: number): string[] | null {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    return stat.slice(stat.lastIndexOf(")") + 2).split(" ");
  } catch {
    return null;
  }
}

let bootId: string | null = null;

export const systemProcesses: ProcessTable = {
  start(pid) {
    if (process.platform !== "linux") return ps("lstart", pid);
    // Field 22 is the start in clock ticks after the boot. The boot id makes it different after a restart of the machine.
    const ticks = statFields(pid)?.[19];
    if (!ticks) return null;
    try {
      bootId ??= readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim();
    } catch {
      return null;
    }
    return `${bootId}:${ticks}`;
  },
  parent(pid) {
    const value = process.platform === "linux" ? statFields(pid)?.[1] : ps("ppid", pid);
    const parent = Number(value);
    return Number.isInteger(parent) && parent > 0 ? parent : null;
  },
  name(pid) {
    if (process.platform !== "linux") {
      const comm = ps("comm", pid);
      return comm ? basename(comm) : null;
    }
    try {
      return readFileSync(`/proc/${pid}/comm`, "utf8").trim() || null;
    } catch {
      return null;
    }
  },
  exe(pid) {
    if (process.platform !== "linux") return ps("comm", pid);
    try {
      return readlinkSync(`/proc/${pid}/exe`);
    } catch {
      return null;
    }
  },
  argv(pid) {
    if (process.platform !== "linux") return ps("args", pid)?.split(/\s+/) ?? null;
    try {
      const args = readFileSync(`/proc/${pid}/cmdline`, "utf8").split("\0").filter(Boolean);
      return args.length > 0 ? args : null;
    } catch {
      return null;
    }
  },
};

/** The ancestors of `pid`, from `pid` up to pid 1. The hook and the MCP server send this list with each call. */
export function callerAncestors(pid: number = process.pid, processes: ProcessTable = systemProcesses): Ancestor[] {
  const ancestors: Ancestor[] = [];
  for (let current: number | null = pid; current !== null && ancestors.length < 64; current = processes.parent(current)) {
    const startTime = processes.start(current);
    if (startTime === null) break;
    ancestors.push({ pid: current, startTime });
    if (current === 1) break;
  }
  return ancestors;
}

/** The executable names of each runtime, from the harness registry. */
export function runtimeNames(): ReadonlyMap<string, Runtime> {
  const names = new Map<string, Runtime>();
  for (const harness of BUILTIN_HARNESSES) {
    if (harness.id !== "claude" && harness.id !== "codex") continue;
    for (const name of harness.processNames ?? []) names.set(name, harness.id);
  }
  return names;
}

export type RuntimeProcess = { readonly runtime: Runtime; readonly pid: number; readonly start: string };

/**
 * The first ancestor that is a runtime process and still has the start that
 * the caller saw. Null when no ancestor is a runtime.
 */
export function findRuntime(ancestors: readonly Ancestor[], processes: ProcessTable = systemProcesses, names = runtimeNames()): RuntimeProcess | null {
  for (const { pid, startTime } of ancestors) {
    const runtime = names.get(processes.name(pid) ?? "");
    if (!runtime) continue;
    return processes.start(pid) === startTime ? { runtime, pid, start: startTime } : null;
  }
  return null;
}

/** True when the process `pid` runs and started at `start`. */
export function alive(pid: number, start: string, processes: ProcessTable = systemProcesses): boolean {
  return processes.start(pid) === start;
}

/** Programs that run a script. For them, the script in the second argument is the runtime program. */
const INTERPRETERS = new Set(["node", "bun"]);

/**
 * The candidate programs of a runtime process, in order: the program file,
 * the first argument, the script of an interpreter, and the runtime name on
 * the PATH. Only absolute paths count. The program file of an installed
 * Claude Code has a version as its name, and an npm install runs node with a
 * script, so one candidate is not enough.
 */
export function runtimePrograms(pid: number, runtime: Runtime, processes: ProcessTable = systemProcesses): string[] {
  const args = processes.argv(pid) ?? [];
  const script = INTERPRETERS.has(basename(args[0] ?? "")) ? args[1] : undefined;
  const candidates = [processes.exe(pid), args[0], script, Bun.which(runtime)];
  return [...new Set(candidates.filter((path): path is string => typeof path === "string" && path.startsWith("/")))];
}

/** `/proc/locks` lines of `flock` write locks: `<n>: FLOCK ADVISORY WRITE <pid> <major>:<minor>:<inode> <start> <end>`. */
const PROC_LOCK = /^\d+:\s+FLOCK\s+\S+\s+WRITE\s+(\d+)\s+([0-9a-f]+):([0-9a-f]+):(\d+)\s/;

/** The pids in the `flock` write lock lines of `/proc/locks` text for one device and inode. */
export function parseProcLocks(text: string, dev: { major: number; minor: number }, inode: number): number[] {
  const pids: number[] = [];
  for (const line of text.split("\n")) {
    const match = PROC_LOCK.exec(line);
    if (!match) continue;
    const [, pid, major, minor, ino] = match;
    if (Number(ino) === inode && parseInt(major!, 16) === dev.major && parseInt(minor!, 16) === dev.minor) pids.push(Number(pid));
  }
  return pids;
}

/**
 * The pids that hold a `flock` write lock on `path`. An empty list when the
 * file exists and no process holds it. Null when the file does not exist or
 * Ferry cannot read the locks. Ferry only reads the lock table. It never
 * takes the lock.
 */
export function flockHolders(path: string): number[] | null {
  let stat;
  try {
    stat = statSync(path);
  } catch {
    return null;
  }
  if (process.platform === "linux") {
    // The kernel shows a device as its major and minor numbers. `st_dev` packs them in the Linux format.
    const high = Math.floor(stat.dev / 2 ** 32);
    const dev = { major: ((stat.dev >>> 8) & 0xfff) | (high & ~0xfff), minor: (stat.dev & 0xff) | ((stat.dev >>> 12) & 0xfff00) };
    try {
      return parseProcLocks(readFileSync("/proc/locks", "utf8"), dev, stat.ino);
    } catch {
      return null;
    }
  }
  // macOS has no /proc/locks. `lsof -F pl` gives a `p<pid>` line and an `l<lock>` line for each open file. Not tested yet.
  const result = spawnSync("lsof", ["-F", "pl", "--", path], { encoding: "utf8" });
  if (result.status !== 0 && result.stdout === "") return result.status === 1 ? [] : null;
  const pids: number[] = [];
  let pid = 0;
  for (const line of result.stdout.split("\n")) {
    if (line.startsWith("p")) pid = Number(line.slice(1));
    else if ((line === "lW" || line === "lw") && pid > 0) pids.push(pid);
  }
  return pids;
}
