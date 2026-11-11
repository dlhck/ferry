import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { LinkOptions, LinkResult } from "../src/link.ts";
import { parsePs, psCommand, psLines, runPs } from "../src/ps.ts";
import { BUILTIN_HARNESSES } from "../src/registry/builtin.ts";

const NOW = new Date("2026-01-02T12:00:00.000Z");

describe("ferry ps", () => {
  test("an agent counts the memory and CPU of all its child processes, and a matched child stays part of its parent", () => {
    const stdout = [
      "1 0 1000 0.0 9000 -",
      "100 1 300000 12.5 3600 claude /home/user/projects/app",
      "101 100 50000 2.5 3500 -",
      "102 101 20000 1.0 3400 codex /home/user/projects/app/sub",
      "200 1 80000 0.4 60 pi /home/user/with space",
      "300 1 5000 0.0 10 -",
    ].join("\n");

    expect(parsePs(stdout, NOW)).toEqual([
      {
        harness: "claude",
        pid: 100,
        project: "/home/user/projects/app",
        startedAt: "2026-01-02T11:00:00.000Z",
        memoryKiB: 370000,
        cpuPercent: 16,
        children: 2,
      },
      {
        harness: "pi",
        pid: 200,
        project: "/home/user/with space",
        startedAt: "2026-01-02T11:59:00.000Z",
        memoryKiB: 80000,
        cpuPercent: 0.4,
        children: 0,
      },
    ]);
  });

  test("a project path with a token loses the token, and a missing working directory is null", () => {
    const token = `ghp_${"a".repeat(36)}`;
    const agents = parsePs(`10 1 100 0.0 5 claude /home/user/${token}/app\n11 1 100 0.0 5 codex\n`, NOW);

    expect(agents.map((agent) => agent.project)).toEqual(["/home/user/[token]/app", null]);
  });

  test("the probe matches a program name and an interpreter script, and prints no command line", () => {
    if (!existsSync("/proc/self/cwd")) return;
    const dir = realpathSync(mkdtempSync(join(tmpdir(), "ferry-ps-")));
    const script = join(dir, "fake-agent");
    Bun.spawnSync(["sh", "-c", `printf 'setInterval(() => {}, 1000)\\n' > ${script}`]);
    const sleeper = Bun.spawn(["sleep", "30"], { cwd: dir });
    const interpreted = Bun.spawn([process.execPath, script, "--secret-flag"], { cwd: dir });
    try {
      Bun.sleepSync(200);
      const harnesses = [
        { id: "sleeper", name: "Sleeper", processNames: ["sleep"] },
        { id: "scripted", name: "Scripted", processNames: ["fake-agent"] },
      ];
      const result = Bun.spawnSync(["sh", "-c", psCommand(harnesses)]);
      const stdout = result.stdout.toString();
      const agents = parsePs(stdout, NOW);

      expect(result.exitCode).toBe(0);
      expect(agents.find((agent) => agent.pid === sleeper.pid)).toMatchObject({ harness: "sleeper", project: dir });
      expect(agents.find((agent) => agent.pid === interpreted.pid)).toMatchObject({ harness: "scripted", project: dir });
      expect(stdout).not.toContain("--secret-flag");
      expect(stdout).not.toContain("sleep 30");
    } finally {
      sleeper.kill();
      interpreted.kill();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("the builtin harnesses name the program of each agent CLI", () => {
    expect(Object.fromEntries(BUILTIN_HARNESSES.map((harness) => [harness.id, harness.processNames ?? []]))).toEqual({
      agents: [],
      claude: ["claude"],
      codex: ["codex"],
      pi: ["pi"],
      cursor: ["cursor-agent"],
    });
  });

  test("an offline box gets its reason, and the other boxes still report their agents", async () => {
    const commands: string[] = [];
    const report = await runPs([], {
      harnesses: BUILTIN_HARNESSES,
      now: () => NOW,
      readConfig: () => ({
        boxes: [
          { name: "a", host: { transport: "ssh" as const, destination: "user@box-a.example" } },
          { name: "b", host: { transport: "ssh" as const, destination: "user@box-b.example" } },
        ],
      }),
      createLink: (options: LinkOptions) => ({
        async run(command: string): Promise<LinkResult> {
          commands.push(command);
          if (JSON.stringify(options).includes("box-b")) {
            return { ok: false, error: { code: "host-offline", origin: "network", message: "the host is offline" } };
          }
          return { ok: true, address: "100.64.0.8", stdout: "100 1 2097152 3.0 120 claude /home/user/app\n", stderr: "" };
        },
      }),
    });

    expect(commands).toHaveLength(2);
    expect(report.boxes.map((box) => ({ name: box.name, online: box.online, error: box.error }))).toEqual([
      { name: "a", online: true, error: null },
      { name: "b", online: false, error: "the host is offline" },
    ]);
    expect(psLines(report)).toEqual([
      "a:",
      "  HARNESS  PID  STARTED UTC       MEMORY  CPU  PROJECT",
      "  claude   100  2026-01-02 11:58  2 GiB   3%   /home/user/app",
      "b: offline (the host is offline)",
    ]);
  });

  test("a box with no agent gets one line", () => {
    expect(psLines({ boxes: [{ name: "a", online: true, error: null, agents: [] }] })).toEqual(["a: no agents"]);
  });
});
