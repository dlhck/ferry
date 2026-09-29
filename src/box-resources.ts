/** The disk, memory, and load of a box, which the brief status probe reads. */

import type { StatusLimitsConfig } from "./config.ts";

/** Sizes are in KiB. A part is null when the box cannot report it, for example a box without `/proc`. */
export type BoxResources = {
  /** The file system of the box home. */
  readonly disk: { readonly totalKiB: number; readonly freeKiB: number } | null;
  readonly memory: { readonly totalKiB: number; readonly availableKiB: number } | null;
  /** The load averages over 1, 5, and 15 minutes, and the number of CPUs, or null when the box does not report it. */
  readonly load: { readonly one: number; readonly five: number; readonly fifteen: number; readonly cpus: number | null } | null;
};

/** The brief status reports the disk when it is below both disk limits, and the memory when it is below its limit. A limit of 0 turns its part off. */
export type ResourceLimits = Required<StatusLimitsConfig>;

export const DEFAULT_RESOURCE_LIMITS: ResourceLimits = {
  diskFreePercent: 10,
  diskFreeGiB: 5,
  memoryAvailablePercent: 10,
};

/**
 * Print one labeled line for each part that the box can report. The probe runs
 * it after the home line, in the same SSH command. A part that fails prints
 * nothing, and the command always exits with 0, so a box without `/proc` stays online.
 */
export const BOX_RESOURCES_COMMAND = [
  `df -Pk "$HOME" 2>/dev/null | awk 'NR == 2 { print "disk", $2, $4 }'`,
  `awk '/^MemTotal:/ { total = $2 } /^MemAvailable:/ { available = $2 } END { if (total) print "memory", total, available }' /proc/meminfo 2>/dev/null`,
  `awk '{ print "load", $1, $2, $3 }' /proc/loadavg 2>/dev/null`,
  `printf 'cpus %s\\n' "$(nproc 2>/dev/null)"`,
  "true",
].join("; ");

/** Read the lines of BOX_RESOURCES_COMMAND. It ignores other lines and each line with a value that is not a number. */
export function parseBoxResources(stdout: string): BoxResources {
  const lines = new Map<string, number[]>();
  for (const line of stdout.split(/\r?\n/)) {
    const [label = "", ...fields] = line.trim().split(/\s+/);
    const values = fields.map(Number);
    if (values.length > 0 && values.every((value) => Number.isFinite(value) && value >= 0)) lines.set(label, values);
  }
  const disk = lines.get("disk");
  const memory = lines.get("memory");
  const load = lines.get("load");
  const cpus = lines.get("cpus")?.[0];
  return {
    disk: disk?.length === 2 && disk[0]! > 0 ? { totalKiB: disk[0]!, freeKiB: disk[1]! } : null,
    memory: memory?.length === 2 && memory[0]! > 0 ? { totalKiB: memory[0]!, availableKiB: memory[1]! } : null,
    load: load?.length === 3
      ? { one: load[0]!, five: load[1]!, fifteen: load[2]!, cpus: cpus !== undefined && cpus > 0 ? cpus : null }
      : null,
  };
}
