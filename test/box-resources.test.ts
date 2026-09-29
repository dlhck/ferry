import { describe, expect, test } from "bun:test";
import { BOX_RESOURCES_COMMAND, parseBoxResources } from "../src/box-resources.ts";

describe("box resources", () => {
  test("reads the disk, memory, load, and CPU lines", () => {
    expect(parseBoxResources("disk 104857600 4194304\nmemory 16777216 838860\nload 9.50 8.00 6.20\ncpus 4\n")).toEqual({
      disk: { totalKiB: 104857600, freeKiB: 4194304 },
      memory: { totalKiB: 16777216, availableKiB: 838860 },
      load: { one: 9.5, five: 8, fifteen: 6.2, cpus: 4 },
    });
  });

  test("a part that the box does not report is null", () => {
    expect(parseBoxResources("disk 104857600 4194304\ncpus \n")).toEqual({
      disk: { totalKiB: 104857600, freeKiB: 4194304 },
      memory: null,
      load: null,
    });
    expect(parseBoxResources("load 0.1 0.2 0.3\ncpus \n").load).toEqual({ one: 0.1, five: 0.2, fifteen: 0.3, cpus: null });
    expect(parseBoxResources("memory 16777216\ndisk 0 0\n")).toEqual({ disk: null, memory: null, load: null });
  });

  test("the command prints the disk line and exits with 0 in a local shell", () => {
    const result = Bun.spawnSync(["sh", "-c", BOX_RESOURCES_COMMAND]);

    expect(result.exitCode).toBe(0);
    expect(parseBoxResources(result.stdout.toString()).disk).not.toBeNull();
  });
});
