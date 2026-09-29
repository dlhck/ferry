/**
 * The Sherlock integration. Sherlock is a read-only database query CLI on the
 * operator machine. `ferry sherlock add` adds a Sherlock connection whose
 * tunnel command is `ferry tunnel`, so Sherlock reaches a database through a
 * box. Ferry uses only the Sherlock CLI and never reads or writes the
 * Sherlock config file. Ferry never stores a password.
 */

import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import * as prompts from "@clack/prompts";
import type { Command } from "commander";
import { quoteShell } from "../box-settings.ts";
import { resolveBoxes, resolveTargetBox, UnknownBoxError } from "../boxes.ts";
import { readConfig, resolveLinkOptions, type PartialOperatorConfig } from "../config.ts";
import { FerryError } from "../errors.ts";
import { Link, type LinkOptions } from "../link.ts";
import { parsePortSpecs } from "../tunnel.ts";
import type { IntegrationHealth, OperatorIntegration } from "./types.ts";

export const SHERLOCK_INSTALL = "curl -fsSL https://raw.githubusercontent.com/michaelbromley/sherlock/main/install.sh | bash";

/** A connection that `ferry sherlock add` added. It has no password. */
export type SherlockRecord = { readonly name: string; readonly box: string; readonly target: string };

/** The content of `~/.ferry/sherlock.json`. */
export type SherlockFile = { readonly schemaVersion: 1; readonly connections: readonly SherlockRecord[] };

export type SherlockResult = { readonly exitCode: number; readonly stdout: string; readonly stderr: string };

/** Where `sherlock` gets its stdin: nothing, the stdin of Ferry, or a password. */
export type SherlockInput = "none" | "inherit" | { readonly password: string };

export type SherlockDependencies = {
  readonly which: (command: string) => string | null;
  readonly runSherlock: (args: readonly string[], input: SherlockInput) => Promise<SherlockResult>;
  readonly readConfig: () => PartialOperatorConfig | null;
  readonly createLink: (options: LinkOptions) => Pick<Link, "reach">;
  readonly home: () => string;
  /** Asks for the password without echo. Null when the operator cancels. */
  readonly askPassword: (message: string) => Promise<string | null>;
  readonly interactive: () => boolean;
  readonly writeLine: (line: string) => void;
};

export type SherlockAddInput = {
  readonly name: string;
  /** The `--box` values. */
  readonly boxes: readonly string[];
  readonly target: string;
  readonly type: string;
  readonly database?: string;
  readonly username?: string;
  readonly ssl?: string;
  readonly passwordStdin?: boolean;
  readonly passwordEnv?: string;
  readonly force?: boolean;
};

export function createSherlock(dependencies: Partial<SherlockDependencies> = {}): OperatorIntegration {
  const resolved = { ...defaultDependencies, ...dependencies };
  return {
    id: "sherlock",
    name: "Sherlock",
    description: "Sherlock database connections that tunnel through a box",
    operator: {
      available: () => resolved.which("sherlock") !== null,
      install: SHERLOCK_INSTALL,
      registerCommands: (program) => registerCommands(program, resolved),
      health: () => sherlockHealth(resolved),
    },
  };
}

/** The tunnel command of a connection. Sherlock replaces `{{port}}` with a free local port. */
export function tunnelCommand(box: string, target: string): string {
  const spec = `${target}:{{port}}`;
  return `ferry tunnel --box ${box} ${/^[A-Za-z0-9_.:{}-]+$/.test(spec) ? spec : quoteShell(spec)}`;
}

/** Add the connection with `sherlock connection add`, then record it in `~/.ferry/sherlock.json`. */
export async function addSherlockConnection(input: SherlockAddInput, resolved: SherlockDependencies): Promise<SherlockRecord> {
  if (input.boxes.length > 1) throw new FerryError("usage", "ferry sherlock add uses one box. Give --box once.");
  if (input.passwordStdin === true && input.passwordEnv !== undefined) {
    throw new FerryError("usage", "Give --password-stdin or --password-env, not both.");
  }
  checkTarget(input.target);
  const box = resolveTargetBox(resolved.readConfig() ?? {}, input.boxes[0]).name;
  const command = tunnelCommand(box, input.target);

  let stdin: SherlockInput = "none";
  if (input.passwordStdin === true) stdin = "inherit";
  else if (input.passwordEnv === undefined && resolved.interactive()) {
    const password = await resolved.askPassword(`Database password of ${input.name} (empty for none)`);
    if (password === null) throw new FerryError("refused", "Cancelled. Ferry added no connection.");
    if (password !== "") stdin = { password };
  }

  const args = [
    "connection",
    "add",
    input.name,
    "--type",
    input.type,
    ...option("--database", input.database),
    ...option("--username", input.username),
    ...option("--ssl", input.ssl),
    ...option("--password-env", input.passwordEnv),
    ...(stdin === "none" ? [] : ["--password-stdin"]),
    "--tunnel-command",
    command,
    ...(input.force === true ? ["--force"] : []),
  ];
  const result = await resolved.runSherlock(args, stdin);
  if (result.exitCode !== 0) {
    const detail = result.stderr.trim() || result.stdout.trim() || `exit code ${result.exitCode}`;
    throw new FerryError("command-failed", `sherlock connection add failed: ${detail.replace(/^Error: /, "")}`);
  }

  const record = { name: input.name, box, target: input.target };
  const file = readSherlockFile(resolved.home());
  writeSherlockFile(resolved.home(), {
    schemaVersion: 1,
    connections: [...file.connections.filter((entry) => entry.name !== input.name), record],
  });
  resolved.writeLine(`Added Sherlock connection ${input.name}. Tunnel command: ${command}`);
  resolved.writeLine(`Sherlock opens the tunnel on the first query. Try: sherlock -c ${input.name} tables`);
  return record;
}

/**
 * The recorded connections that Sherlock still has. For each one, check that
 * the box is in the config and that the target accepts TCP connections from
 * the box.
 */
export async function sherlockHealth(resolved: SherlockDependencies): Promise<IntegrationHealth> {
  const recorded = readSherlockFile(resolved.home()).connections;
  if (recorded.length === 0) {
    return { lines: ["No connections of ferry sherlock add."], warnings: [], json: { connections: [] } };
  }
  const listed = await resolved.runSherlock(["connection", "list"], "none");
  const names = listed.exitCode === 0 ? connectionNames(listed.stdout) : null;
  if (names === null) {
    const detail = listed.stderr.trim() || listed.stdout.trim() || `exit code ${listed.exitCode}`;
    const warning = `sherlock connection list failed: ${detail}`;
    return { lines: [], warnings: [warning], json: { connections: [], error: warning } };
  }

  const config = resolved.readConfig() ?? {};
  const checks = await Promise.all(
    recorded.filter((record) => names.includes(record.name)).map((record) => checkConnection(record, config, resolved)),
  );
  if (checks.length === 0) {
    return { lines: ["No connections of ferry sherlock add."], warnings: [], json: { connections: [] } };
  }
  return {
    lines: checks.map((check) => `${check.name}  ${check.box}:${check.target}  ${check.state}`),
    warnings: checks.flatMap((check) => (check.error === null ? [] : [`Sherlock connection ${check.name}: ${check.error}`])),
    json: { connections: checks },
  };
}

type ConnectionCheck = SherlockRecord & {
  readonly state: "reachable" | "unreachable" | "box-offline" | "unknown-box";
  readonly error: string | null;
};

async function checkConnection(
  record: SherlockRecord,
  config: PartialOperatorConfig,
  resolved: SherlockDependencies,
): Promise<ConnectionCheck> {
  let host;
  try {
    host = resolveBoxes(config, [record.box])[0]!.host;
  } catch (error) {
    if (!(error instanceof UnknownBoxError)) throw error;
    return { ...record, state: "unknown-box", error: `box ${record.box} is not in the Ferry config.` };
  }
  const [port] = parsePortSpecs([record.target]);
  const reached = await resolved
    .createLink(resolveLinkOptions(host))
    .reach({ host: port!.remoteHost ?? "127.0.0.1", port: port!.remotePort });
  if (reached.ok) return { ...record, state: "reachable", error: null };
  if (reached.error.origin === "box") {
    return { ...record, state: "unreachable", error: `${record.box} cannot reach ${record.target}: ${reached.error.message}` };
  }
  return { ...record, state: "box-offline", error: `could not connect to ${record.box}: ${reached.error.message}` };
}

function registerCommands(program: Command, resolved: SherlockDependencies): void {
  const command = program
    .command("sherlock")
    .description("Add Sherlock database connections that tunnel through a box");
  command
    .command("add")
    .summary("Add a Sherlock connection whose tunnel is ferry tunnel")
    .description(`Add a Sherlock connection whose tunnel is ferry tunnel.

Ferry runs sherlock connection add with
--tunnel-command "ferry tunnel --box <box> <target>:{{port}}". Sherlock opens
the tunnel on the first query and closes it when it is idle. The box is --box,
then default_box, then the only box.

The target is a box port, such as 5432, or a host and port that the box can
reach, such as db.example:5432.

On a terminal, Ferry asks for the password and gives it to Sherlock on stdin.
Sherlock stores it in the keychain of this machine. With --password-stdin,
Sherlock reads the password from the stdin of Ferry. Ferry never stores the
password and never changes the Sherlock config file. Ferry records the name,
box, and target in ~/.ferry/sherlock.json for ferry status.`)
    .argument("<name>", "connection name in Sherlock")
    .requiredOption("--target <target>", "box port or host:port that the box can reach, such as 5432 or db.example:5432")
    .requiredOption("--type <type>", "postgres, mysql, mssql, or redis")
    .option("--database <name>", "database name")
    .option("--username <user>", "database user")
    .option("--ssl <mode>", "off, require, or verify")
    .option("--password-stdin", "Sherlock reads the password from stdin")
    .option("--password-env <var>", "Sherlock reads the password from this environment variable at query time")
    .option("--force", "replace a Sherlock connection with the same name")
    .action(async (name: string, options: Omit<SherlockAddInput, "name" | "boxes">) => {
      const boxes = program.opts<{ box?: string[] }>().box ?? [];
      await addSherlockConnection({ ...options, name, boxes }, resolved);
    });
}

/** `db.example:5432` or `5432`. The local port comes from Sherlock, so the target has none. */
function checkTarget(target: string): void {
  try {
    parsePortSpecs([`${target}:1`]);
  } catch {
    throw new FerryError(
      "usage",
      `invalid target ${target}. Give a box port, such as 5432, or a host and port that the box can reach, such as db.example:5432.`,
    );
  }
}

function option(flag: string, value: string | undefined): string[] {
  return value === undefined ? [] : [flag, value];
}

/** The names in the output of `sherlock connection list`, or null when the output is not valid. */
function connectionNames(stdout: string): string[] | null {
  try {
    const value = JSON.parse(stdout) as { connections?: unknown };
    return Array.isArray(value.connections) ? value.connections.filter((name) => typeof name === "string") : null;
  } catch {
    return null;
  }
}

function sherlockFilePath(home: string): string {
  return join(home, ".ferry", "sherlock.json");
}

export function readSherlockFile(home: string): SherlockFile {
  let text: string;
  try {
    text = readFileSync(sherlockFilePath(home), "utf8");
  } catch {
    return { schemaVersion: 1, connections: [] };
  }
  const value = JSON.parse(text) as Partial<SherlockFile>;
  return { schemaVersion: 1, connections: Array.isArray(value.connections) ? value.connections : [] };
}

function writeSherlockFile(home: string, file: SherlockFile): void {
  const path = sherlockFilePath(home);
  const temporary = `${path}.tmp`;
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(temporary, `${JSON.stringify(file, null, 2)}\n`, { mode: 0o600 });
  renameSync(temporary, path);
}

async function runSherlock(args: readonly string[], input: SherlockInput): Promise<SherlockResult> {
  const child = Bun.spawn(["sherlock", ...args], {
    stdin: input === "none" ? "ignore" : input === "inherit" ? "inherit" : "pipe",
    stdout: "pipe",
    stderr: "pipe",
  });
  if (typeof input === "object") {
    child.stdin!.write(input.password);
    await child.stdin!.end();
  }
  const [exitCode, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  return { exitCode, stdout, stderr };
}

const defaultDependencies: SherlockDependencies = {
  which: (command) => Bun.which(command),
  runSherlock,
  readConfig,
  createLink: (options) => new Link(options),
  home: homedir,
  askPassword: async (message) => {
    const value = await prompts.password({ message });
    return prompts.isCancel(value) ? null : (value ?? "");
  },
  interactive: () => process.stdin.isTTY === true && process.stdout.isTTY === true,
  writeLine: console.log,
};

export const sherlock = createSherlock();
