/**
 * The start of a process, as a string that a later process with the same pid
 * does not have. The sync lock and agent messaging compare it, so both must
 * read it the same way. This module imports no other Ferry module.
 */

import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";

/**
 * The start of the process `pid`. On Linux: the boot id and field 22 of
 * `/proc/<pid>/stat`, so it is different after a restart of the machine. On
 * macOS: the text of `ps -o lstart=` with a fixed locale and time zone. `null`
 * when the start is not known. Then the caller must not decide that the process stopped.
 */
export function processStart(pid: number): string | null {
  try {
    if (process.platform === "linux") {
      // Field 22 of the stat file is the start in clock ticks after the boot. The command name in field 2 can have spaces.
      const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
      const ticks = stat.slice(stat.lastIndexOf(")") + 2).split(" ")[19];
      return ticks ? `${readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim()}:${ticks}` : null;
    }
    // macOS has no /proc. A fixed locale and time zone give the same text in each process.
    const ps = spawnSync("/bin/ps", ["-o", "lstart=", "-p", String(pid)], { encoding: "utf8", env: { LC_ALL: "C", TZ: "UTC" } });
    return ps.status === 0 && ps.stdout.trim() ? ps.stdout.trim() : null;
  } catch {
    return null;
  }
}
