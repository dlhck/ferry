/**
 * `ferry ps` lists the agent processes on each selected box. One shell probe
 * runs over Link and prints one line for each process of the box user. The
 * probe compares the program names of the harness descriptors on the box, so
 * no command line leaves the box. Only the pid, the parent pid, the memory,
 * the CPU, the age, the harness id, and the working directory of a matched
 * process do.
 */

import { quoteShell } from "./box-settings.ts";
import { resolveBoxes } from "./boxes.ts";
import { readConfig, resolveLinkOptions, type PartialOperatorConfig } from "./config.ts";
import type { LinkOptions, LinkResult } from "./link.ts";
import { redactTokens, redactUrlCredentials } from "./manifest.ts";
import type { HarnessDescriptor } from "./registry/types.ts";

/** One agent: a matched process with no matched ancestor. Memory and CPU include all its descendants. */
export type AgentProcess = {
  readonly harness: string;
  readonly pid: number;
  /** The working directory of the agent process, or null when the box does not show it. */
  readonly project: string | null;
  readonly startedAt: string;
  /** The resident memory of the process and its descendants. */
  readonly memoryKiB: number;
  /** The sum of the CPU percent of the process and its descendants. `ps` gives the average over the life of each process. */
  readonly cpuPercent: number;
  /** The number of descendant processes. */
  readonly children: number;
};

export type PsReport = {
  readonly boxes: readonly {
    readonly name: string;
    readonly online: boolean;
    /** Why Ferry could not read the box, or null. */
    readonly error: string | null;
    readonly agents: readonly AgentProcess[];
  }[];
};

export type PsDependencies = {
  readonly readConfig: () => PartialOperatorConfig | null;
  readonly harnesses: readonly HarnessDescriptor[];
  readonly createLink: (options: LinkOptions) => { run(command: string): Promise<LinkResult> };
  readonly now: () => Date;
};

/** The interpreters that run an agent script. The script is the second argument. */
const INTERPRETERS = ["node", "bun"];

/**
 * Print `pid ppid rssKiB pcpu ageSeconds harness [cwd]` for each process of
 * the box user. `harness` is `-` for a process that matches no program name.
 */
export function psCommand(harnesses: readonly HarnessDescriptor[]): string {
  const names = harnesses.flatMap((harness) => (harness.processNames ?? []).map((name) => `${name}=${harness.id}`));
  const program = [
    `BEGIN { n = split(names, pairs, " "); for (i = 1; i <= n; i++) { split(pairs[i], kv, "="); id[kv[1]] = kv[2] } }`,
    `{ a = $6; sub(/.*\\//, "", a); b = $7; sub(/.*\\//, "", b); h = (a in id) ? id[a] : ""`,
    `  if (h == "" && (${INTERPRETERS.map((name) => `a == "${name}"`).join(" || ")}) && (b in id)) h = id[b]`,
    `  if (h == "") { print $1, $2, $3, $4, $5, "-"; next }`,
    `  cwd = ""; cmd = "readlink /proc/" $1 "/cwd 2>/dev/null"; cmd | getline cwd; close(cmd)`,
    `  print $1, $2, $3, $4, $5, h, cwd }`,
  ].join("\n");
  return `ps -ww -u "$(id -u)" -o pid=,ppid=,rss=,pcpu=,etimes=,args= | awk -v names=${quoteShell(names.join(" "))} ${quoteShell(program)}`;
}

type Row = { pid: number; ppid: number; rss: number; cpu: number; age: number; harness: string | null; cwd: string | null };

/** Read the lines of `psCommand`, and return one entry for each agent, oldest first. */
export function parsePs(stdout: string, now: Date): AgentProcess[] {
  const rows: Row[] = [];
  for (const line of stdout.split(/\r?\n/)) {
    const [pid, ppid, rss, cpu, age, harness, ...cwd] = line.trim().split(" ");
    const numbers = [pid, ppid, rss, cpu, age].map(Number);
    if (harness === undefined || !numbers.every((value) => Number.isFinite(value) && value >= 0)) continue;
    rows.push({
      pid: numbers[0]!,
      ppid: numbers[1]!,
      rss: numbers[2]!,
      cpu: numbers[3]!,
      age: numbers[4]!,
      harness: harness === "-" ? null : harness,
      cwd: cwd.length > 0 && cwd.join(" ") !== "" ? cwd.join(" ") : null,
    });
  }
  const byPid = new Map(rows.map((row) => [row.pid, row]));
  const children = new Map<number, Row[]>();
  for (const row of rows) children.set(row.ppid, [...(children.get(row.ppid) ?? []), row]);
  const matchedAncestor = (row: Row): boolean => {
    const seen = new Set<number>();
    for (let parent = byPid.get(row.ppid); parent && !seen.has(parent.pid); parent = byPid.get(parent.ppid)) {
      if (parent.harness !== null) return true;
      seen.add(parent.pid);
    }
    return false;
  };
  const descendants = (row: Row): Row[] => {
    const found: Row[] = [];
    const queue = [...(children.get(row.pid) ?? [])];
    while (queue.length > 0) {
      const next = queue.shift()!;
      if (found.includes(next) || next === row) continue;
      found.push(next);
      queue.push(...(children.get(next.pid) ?? []));
    }
    return found;
  };
  return rows
    .filter((row) => row.harness !== null && !matchedAncestor(row))
    .sort((a, b) => b.age - a.age || a.pid - b.pid)
    .map((row) => {
      const tree = [row, ...descendants(row)];
      return {
        harness: row.harness!,
        pid: row.pid,
        project: row.cwd === null ? null : redactUrlCredentials(redactTokens(row.cwd)),
        startedAt: new Date(Math.floor(now.getTime() / 1000 - row.age) * 1000).toISOString(),
        memoryKiB: tree.reduce((sum, entry) => sum + entry.rss, 0),
        cpuPercent: Number(tree.reduce((sum, entry) => sum + entry.cpu, 0).toFixed(1)),
        children: tree.length - 1,
      };
    });
}

/** Read the agents of each selected box. An offline box gets its reason, and the other boxes still run. */
export async function runPs(
  selection: readonly string[],
  dependencies: Pick<PsDependencies, "harnesses" | "createLink"> & Partial<PsDependencies>,
): Promise<PsReport> {
  const resolved = { readConfig, now: () => new Date(), ...dependencies };
  const boxes = resolveBoxes(resolved.readConfig() ?? {}, selection);
  const command = psCommand(resolved.harnesses);
  return {
    boxes: await Promise.all(
      boxes.map(async (box) => {
        const result = await resolved.createLink(resolveLinkOptions(box.host)).run(command);
        if (!result.ok) return { name: box.name, online: false, error: result.error.message, agents: [] };
        return { name: box.name, online: true, error: null, agents: parsePs(result.stdout, resolved.now()) };
      }),
    ),
  };
}

/** One block for each box. An offline box has one line with the reason. */
export function psLines(report: PsReport): string[] {
  const lines: string[] = [];
  for (const box of report.boxes) {
    if (!box.online) {
      lines.push(`${box.name}: offline (${box.error ?? "unknown error"})`);
      continue;
    }
    if (box.agents.length === 0) {
      lines.push(`${box.name}: no agents`);
      continue;
    }
    lines.push(`${box.name}:`);
    const rows = [
      ["HARNESS", "PID", "STARTED UTC", "MEMORY", "CPU", "PROJECT"],
      ...box.agents.map((agent) => [
        agent.harness,
        String(agent.pid),
        agent.startedAt.slice(0, 16).replace("T", " "),
        formatMemory(agent.memoryKiB),
        `${agent.cpuPercent}%`,
        agent.project ?? "-",
      ]),
    ];
    const widths = rows[0]!.map((_, column) => Math.max(...rows.map((row) => row[column]!.length)));
    for (const row of rows) {
      lines.push(`  ${row.map((cell, column) => (column === row.length - 1 ? cell : cell.padEnd(widths[column]!))).join("  ")}`);
    }
  }
  return lines;
}

function formatMemory(kib: number): string {
  return kib >= 1024 * 1024 ? `${Number((kib / 1024 / 1024).toFixed(1))} GiB` : `${Math.round(kib / 1024)} MiB`;
}
