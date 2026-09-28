import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ExposeError, exposePort, runExpose, type ExposeDependencies } from "../src/expose.ts";

const homes: string[] = [];

afterEach(() => {
  for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true });
});

function setup(overrides: Partial<ExposeDependencies> = {}) {
  const home = mkdtempSync(join(tmpdir(), "ferry-expose-"));
  homes.push(home);
  let signal: ((signal: NodeJS.Signals) => void) | undefined;
  const dependencies: Partial<ExposeDependencies> = {
    env: { PASEO_PORT: "3000", PASEO_SCRIPTNAME: "web" },
    home,
    cwd: "/home/user/app",
    pid: 4242,
    now: () => new Date("2026-09-28T10:00:00.000Z"),
    onSignal: (handler) => {
      signal = handler;
      return () => {
        signal = undefined;
      };
    },
    ...overrides,
  };
  const entry = join(home, ".ferry", "exposed", "4242.json");
  return { home, entry, dependencies, send: (name: NodeJS.Signals) => signal?.(name) };
}

describe("ferry expose", () => {
  test("writes the entry before the child starts, and removes it when the child exits", async () => {
    const { home, entry, dependencies } = setup();
    let seen: unknown;
    const code = await runExpose(
      { command: ["bun", "run", "dev"] },
      {
        ...dependencies,
        spawn: (argv) => {
          expect(argv).toEqual(["bun", "run", "dev"]);
          seen = JSON.parse(readFileSync(entry, "utf8"));
          return { exited: Promise.resolve(0), kill: () => {} };
        },
      },
    );

    expect(code).toBe(0);
    expect(seen).toEqual({ port: 3000, name: "web", cwd: "/home/user/app", startedAt: "2026-09-28T10:00:00.000Z" });
    expect(existsSync(entry)).toBe(false);
    expect(readdirSync(join(home, ".ferry", "exposed"))).toEqual([]);
  });

  test("with --json, prints the exposed and exited events and gives the stdout of the command to stderr", async () => {
    const { dependencies } = setup();
    const events: unknown[] = [];
    let stdout: string | undefined;
    const code = await runExpose(
      { command: ["bun", "run", "dev"] },
      {
        ...dependencies,
        stdout: "stderr",
        emit: (event) => events.push(event),
        spawn: (_argv, target) => {
          stdout = target;
          return { exited: Promise.resolve(2), kill: () => {} };
        },
      },
    );

    expect(code).toBe(2);
    expect(stdout).toBe("stderr");
    expect(events).toEqual([
      { type: "exposed", port: 3000, name: "web", cwd: "/home/user/app", pid: 4242 },
      { type: "exited", port: 3000, exitCode: 2 },
    ]);
  });

  test("returns the exit code of the child", async () => {
    const { dependencies } = setup();
    expect(await runExpose({ command: ["sh", "-c", "exit 3"] }, dependencies)).toBe(3);
  });

  test("forwards SIGINT and SIGTERM to the child, and returns its exit code", async () => {
    for (const [signal, code] of [["SIGTERM", 7], ["SIGINT", 8]] as const) {
      const { entry, dependencies, send } = setup();
      const script = `trap 'exit 7' TERM; trap 'exit 8' INT; while :; do sleep 0.05; done`;
      const running = runExpose({ command: ["sh", "-c", script] }, dependencies);
      // Wait until the child has its traps.
      while (!existsSync(entry)) await Bun.sleep(10);
      await Bun.sleep(200);
      send(signal);
      expect(await running).toBe(code);
      expect(existsSync(entry)).toBe(false);
    }
  });

  test("forwards SIGHUP to the child, removes the entry, and exits with the code of the child", async () => {
    const { home } = setup();
    const dir = join(home, ".ferry", "exposed");
    const script = `trap 'exit 9' HUP; while :; do sleep 0.05; done`;
    const ferry = Bun.spawn(["bun", join(import.meta.dir, "..", "src", "cli.ts"), "expose", "--port", "45999", "--", "sh", "-c", script], {
      env: { ...process.env, HOME: home },
      stdout: "ignore",
      stderr: "ignore",
    });
    const entry = join(dir, `${ferry.pid}.json`);
    // Wait until the child has its trap.
    while (!existsSync(entry)) await Bun.sleep(10);
    await Bun.sleep(300);
    ferry.kill("SIGHUP");
    expect(await ferry.exited).toBe(9);
    expect(existsSync(entry)).toBe(false);
  });

  test("removes the entry when the command cannot start", async () => {
    const { entry, dependencies } = setup();
    await expect(
      runExpose(
        { command: ["missing"] },
        {
          ...dependencies,
          spawn: () => {
            throw new Error("missing: command not found");
          },
        },
      ),
    ).rejects.toThrow("command not found");
    expect(existsSync(entry)).toBe(false);
  });

  test("--port wins over PASEO_PORT, and the name is left out without PASEO_SCRIPTNAME", async () => {
    const { entry, dependencies } = setup({ env: { PASEO_PORT: "3000" } });
    let seen: unknown;
    await runExpose(
      { port: "5173", command: ["vite"] },
      {
        ...dependencies,
        spawn: () => {
          seen = JSON.parse(readFileSync(entry, "utf8"));
          return { exited: Promise.resolve(0), kill: () => {} };
        },
      },
    );
    expect(seen).toEqual({ port: 5173, cwd: "/home/user/app", startedAt: "2026-09-28T10:00:00.000Z" });
  });

  test("fails without a port or a command, and writes no entry", async () => {
    const { home, dependencies } = setup({ env: {} });
    await expect(runExpose({ command: ["vite"] }, dependencies)).rejects.toThrow(
      "ferry expose needs a port. Give --port <n>, or set PASEO_PORT.",
    );
    await expect(runExpose({ port: "3000", command: [] }, dependencies)).rejects.toThrow("Give the command after --");
    expect(existsSync(join(home, ".ferry", "exposed"))).toBe(false);
  });
});

describe("exposePort", () => {
  test("refuses a value that is not a port", () => {
    for (const value of ["0", "65536", "30a0", "-1", "3000.5"]) {
      expect(() => exposePort(value, {})).toThrow(ExposeError);
    }
    expect(() => exposePort(undefined, { PASEO_PORT: "abc" })).toThrow("PASEO_PORT abc is not a port.");
    expect(exposePort(undefined, { PASEO_PORT: "4100" })).toBe(4100);
  });
});
