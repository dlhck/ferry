/**
 * `ferry expose` runs on the box. It announces the port of a command in
 * `~/.ferry/exposed/<pid>.json`, runs the command, and removes the entry when
 * the command exits. `ferry tunnel --follow` on the operator machine reads the
 * entries and opens a forward for each one.
 */

import { mkdirSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { OutputEvent } from "./output.ts";

/** The directory of the entries, relative to the home. */
export const EXPOSED_DIR = ".ferry/exposed";

/** One file in `~/.ferry/exposed/`. The file name is the pid of `ferry expose`. */
export type ExposedEntry = {
  readonly port: number;
  /** `$PASEO_SCRIPTNAME` when it is set. */
  readonly name?: string;
  readonly cwd: string;
  /** ISO 8601 time. */
  readonly startedAt: string;
};

export type ExposeInput = {
  /** The value of `--port`. */
  readonly port?: string;
  readonly command: readonly string[];
};

export type ExposeChild = {
  readonly exited: Promise<number>;
  kill(signal: NodeJS.Signals): void;
};

export type ExposeDependencies = {
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly home: string;
  readonly cwd: string;
  readonly pid: number;
  readonly now: () => Date;
  /** Starts the command with the standard streams of Ferry. With `stdout: "stderr"`, the stdout of the command goes to stderr. */
  readonly spawn: (argv: readonly string[], stdout: "inherit" | "stderr") => ExposeChild;
  /** With --json, stdout carries only the events, so the output of the command goes to stderr. */
  readonly stdout: "inherit" | "stderr";
  /** With --json, prints the `exposed` and `exited` events. */
  readonly emit: (event: OutputEvent) => void;
  /** Calls `handler` for SIGINT, SIGTERM, and SIGHUP. Returns a function that removes the handlers. */
  readonly onSignal: (handler: (signal: NodeJS.Signals) => void) => () => void;
};

export class ExposeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ExposeError";
  }
}

/** Run the command with its entry. Returns the exit code of the command. */
export async function runExpose(input: ExposeInput, dependencies: Partial<ExposeDependencies> = {}): Promise<number> {
  const resolved = { ...defaultDependencies(), ...dependencies };
  if (input.command.length === 0) {
    throw new ExposeError("Give the command after --, such as ferry expose --port 3000 -- bun run dev.");
  }
  const port = exposePort(input.port, resolved.env);
  const name = resolved.env.PASEO_SCRIPTNAME?.trim();
  const entry: ExposedEntry = {
    port,
    ...(name ? { name } : {}),
    cwd: resolved.cwd,
    startedAt: resolved.now().toISOString(),
  };

  const dir = join(resolved.home, EXPOSED_DIR);
  const path = join(dir, `${resolved.pid}.json`);
  mkdirSync(dir, { recursive: true });
  removeDeadEntries(dir);
  // A rename is atomic, so the box watch never reads a part of the file.
  writeFileSync(`${path}.tmp`, `${JSON.stringify(entry)}\n`);
  renameSync(`${path}.tmp`, path);
  let exitCode: number;
  try {
    const child = resolved.spawn(input.command, resolved.stdout);
    resolved.emit({ type: "exposed", port, name: entry.name ?? null, cwd: entry.cwd, pid: resolved.pid });
    const stopForwarding = resolved.onSignal((signal) => child.kill(signal));
    try {
      exitCode = await child.exited;
    } finally {
      stopForwarding();
    }
  } finally {
    rmSync(path, { force: true });
  }
  resolved.emit({ type: "exited", port, exitCode });
  return exitCode;
}

/**
 * Remove the entries whose pid does not run. SIGKILL or a crash of `ferry expose`
 * leaves its entry. The rule is the same as `kill -0` in the follower.
 */
function removeDeadEntries(dir: string): void {
  for (const file of readdirSync(dir)) {
    const match = /^(\d+)\.json$/.exec(file);
    if (match && !isRunning(Number(match[1]))) rmSync(join(dir, file), { force: true });
  }
}

function isRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM: the process runs, but as a different user.
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

/** The port of `--port`, else of `$PASEO_PORT`. */
export function exposePort(option: string | undefined, env: Readonly<Record<string, string | undefined>>): number {
  const [value, source] = option !== undefined ? [option, "--port"] : [env.PASEO_PORT, "PASEO_PORT"];
  if (value === undefined || value.trim() === "") {
    throw new ExposeError("ferry expose needs a port. Give --port <n>, or set PASEO_PORT.");
  }
  const port = Number(value);
  if (!/^\d+$/.test(value.trim()) || port < 1 || port > 65_535) {
    throw new ExposeError(`${source} ${value} is not a port. Give a number from 1 through 65535.`);
  }
  return port;
}

function defaultDependencies(): ExposeDependencies {
  return {
    env: process.env,
    home: homedir(),
    cwd: process.cwd(),
    pid: process.pid,
    now: () => new Date(),
    spawn: (argv, stdout) => {
      const child = Bun.spawn([...argv], { stdin: "inherit", stdout: stdout === "stderr" ? 2 : "inherit", stderr: "inherit" });
      return { exited: child.exited, kill: (signal) => child.kill(signal) };
    },
    stdout: "inherit",
    emit: () => {},
    onSignal: (handler) => {
      const signals: NodeJS.Signals[] = ["SIGINT", "SIGTERM", "SIGHUP"];
      for (const signal of signals) process.on(signal, handler);
      return () => {
        for (const signal of signals) process.off(signal, handler);
      };
    },
  };
}
