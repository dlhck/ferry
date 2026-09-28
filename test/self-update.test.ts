import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runCli } from "../src/cli.ts";
import {
  isNewer,
  offerSelfUpdate,
  offersSelfUpdate,
  runSelfUpdate,
  updateCommand,
  type SelfUpdateDependencies,
  type UpdateChoice,
} from "../src/self-update.ts";

const DAY = 24 * 60 * 60 * 1_000;
const SCRIPT_BINARY = "/home/op/.local/bin/ferry";
const NPM_BINARY = "/usr/lib/node_modules/@dlhck/ferry-linux-x64/bin/ferry";

let home: string;

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), "ferry-self-update-"));
});

afterEach(async () => {
  await rm(home, { recursive: true, force: true });
});

/** Fakes that record each fetch, question, and command. */
function fakes(options: { latest?: string | null; choice?: UpdateChoice; exitCode?: number; now?: number } = {}) {
  const record = { fetches: 0, questions: [] as string[], runs: [] as (readonly string[])[], lines: [] as string[] };
  let now = options.now ?? 1_000;
  const dependencies: Partial<SelfUpdateDependencies> = {
    version: "0.4.0",
    home,
    execPath: SCRIPT_BINARY,
    now: () => now,
    fetchLatest: async () => {
      record.fetches++;
      return options.latest === undefined ? "0.5.0" : options.latest;
    },
    choose: async (current, latest) => {
      record.questions.push(`${current} -> ${latest}`);
      return options.choice ?? "skip";
    },
    run: async (argv) => {
      record.runs.push(argv);
      return options.exitCode ?? 0;
    },
    writeLine: (line) => record.lines.push(line),
  };
  return { record, dependencies, advance: (ms: number) => (now += ms) };
}

describe("offerSelfUpdate", () => {
  test("asks when a newer release is there, and a skip lets the command run", async () => {
    const { record, dependencies } = fakes();
    expect(await offerSelfUpdate(dependencies)).toBe(false);
    expect(record.questions).toEqual(["0.4.0 -> 0.5.0"]);
    expect(record.runs).toEqual([]);
  });

  test("an update runs the installer and stops the command", async () => {
    const { record, dependencies } = fakes({ choice: "update" });
    expect(await offerSelfUpdate(dependencies)).toBe(true);
    expect(record.runs).toEqual([updateCommand("0.5.0", SCRIPT_BINARY)]);
    expect(record.lines).toEqual([
      "Updated Ferry to 0.5.0. Run the command again.",
      "Run ferry update to put Ferry 0.5.0 on the boxes.",
    ]);
  });

  test("a failed update lets the old version run the command", async () => {
    const { record, dependencies } = fakes({ choice: "update", exitCode: 1 });
    expect(await offerSelfUpdate(dependencies)).toBe(false);
    expect(record.lines).toEqual(["The update to Ferry 0.5.0 failed. Ferry 0.4.0 runs the command."]);
  });

  test("reads the latest release at most once a day", async () => {
    const { record, dependencies, advance } = fakes();
    await offerSelfUpdate(dependencies);
    advance(DAY - 1);
    await offerSelfUpdate(dependencies);
    expect(record.fetches).toBe(1);
    expect(record.questions).toHaveLength(2);
    advance(1);
    await offerSelfUpdate(dependencies);
    expect(record.fetches).toBe(2);
  });

  test("a failed read keeps the last known release and waits a day", async () => {
    const first = fakes();
    await offerSelfUpdate(first.dependencies);
    const offline = fakes({ latest: null, now: 1_000 + DAY });
    await offerSelfUpdate(offline.dependencies);
    expect(offline.record.fetches).toBe(1);
    expect(offline.record.questions).toEqual(["0.4.0 -> 0.5.0"]);
    expect(JSON.parse(await readFile(join(home, ".ferry/update-check.json"), "utf8"))).toEqual({
      checkedAt: 1_000 + DAY,
      latest: "0.5.0",
    });
  });

  test("a skipped version does not ask again, and the next release does", async () => {
    const skip = fakes({ choice: "skip-version" });
    await offerSelfUpdate(skip.dependencies);
    const again = fakes();
    await offerSelfUpdate(again.dependencies);
    expect(again.record.questions).toEqual([]);
    const next = fakes({ latest: "0.6.0", now: 1_000 + DAY });
    await offerSelfUpdate(next.dependencies);
    expect(next.record.questions).toEqual(["0.4.0 -> 0.6.0"]);
  });

  test("does not ask for the same or an older release, or for a development build", async () => {
    for (const latest of ["0.4.0", "0.3.9"]) {
      await rm(join(home, ".ferry"), { recursive: true, force: true });
      const { record, dependencies } = fakes({ latest });
      await offerSelfUpdate(dependencies);
      expect(record.questions).toEqual([]);
    }
    const dev = fakes();
    await offerSelfUpdate({ ...dev.dependencies, version: "0.0.0-dev" });
    expect(dev.record.fetches).toBe(0);
  });
});

describe("runSelfUpdate", () => {
  test("installs a newer release without a question", async () => {
    const { record, dependencies } = fakes();
    expect(await runSelfUpdate(dependencies)).toEqual({ current: "0.4.0", latest: "0.5.0", updated: true });
    expect(record.questions).toEqual([]);
    expect(record.runs).toEqual([updateCommand("0.5.0", SCRIPT_BINARY)]);
  });

  test("reads the latest release also within a day, and does nothing when this is the latest", async () => {
    const { record, dependencies } = fakes({ latest: "0.4.0" });
    await runSelfUpdate(dependencies);
    expect(await runSelfUpdate(dependencies)).toEqual({ current: "0.4.0", latest: "0.4.0", updated: false });
    expect(record.fetches).toBe(2);
    expect(record.runs).toEqual([]);
    expect(record.lines.at(-1)).toBe("Ferry 0.4.0 is the latest version.");
  });

  test("fails with a code when the read or the install fails, and for a development build", async () => {
    await expect(runSelfUpdate(fakes({ latest: null }).dependencies)).rejects.toMatchObject({ code: "failed" });
    await expect(runSelfUpdate(fakes({ exitCode: 1 }).dependencies)).rejects.toMatchObject({ code: "update-failed" });
    await expect(runSelfUpdate({ ...fakes().dependencies, version: "0.0.0-dev" })).rejects.toMatchObject({ code: "usage" });
  });
});

describe("updateCommand", () => {
  test("an npm install updates with npm", () => {
    expect(updateCommand("0.5.0", NPM_BINARY)).toEqual(["npm", "install", "--global", "@dlhck/ferry@0.5.0"]);
  });

  test("a script install runs the installer of the tag into the directory of the binary", () => {
    const argv = updateCommand("0.5.0", SCRIPT_BINARY);
    expect(argv.slice(0, 2)).toEqual(["sh", "-c"]);
    expect(argv[2]).toContain("https://raw.githubusercontent.com/dlhck/ferry/v0.5.0/install.sh");
    expect(argv[2]).toContain('FERRY_VERSION=v0.5.0 FERRY_INSTALL_DIR="$1"');
    expect(argv.slice(3)).toEqual(["ferry-update", "/home/op/.local/bin"]);
  });
});

test("isNewer compares the release parts and puts a release after its pre-release", () => {
  expect(isNewer("0.5.0", "0.4.9")).toBe(true);
  expect(isNewer("0.10.0", "0.9.0")).toBe(true);
  expect(isNewer("1.0.0", "0.99.99")).toBe(true);
  expect(isNewer("0.4.0", "0.4.0")).toBe(false);
  expect(isNewer("0.4.0", "0.5.0")).toBe(false);
  expect(isNewer("0.5.0", "0.5.0-rc.1")).toBe(true);
  expect(isNewer("0.5.0-rc.1", "0.5.0")).toBe(false);
});

test("offersSelfUpdate asks only on a terminal, without --json, CI, FERRY_NO_UPDATE_CHECK, or a command that stays running", () => {
  const base = { json: false, streaming: false, interactive: true, env: {} };
  expect(offersSelfUpdate(base)).toBe(true);
  expect(offersSelfUpdate({ ...base, interactive: false })).toBe(false);
  expect(offersSelfUpdate({ ...base, json: true })).toBe(false);
  expect(offersSelfUpdate({ ...base, streaming: true })).toBe(false);
  expect(offersSelfUpdate({ ...base, env: { CI: "true" } })).toBe(false);
  expect(offersSelfUpdate({ ...base, env: { FERRY_NO_UPDATE_CHECK: "1" } })).toBe(false);
});

describe("ferry CLI", () => {
  const env = { CI: process.env.CI, FERRY_NO_UPDATE_CHECK: process.env.FERRY_NO_UPDATE_CHECK };
  beforeEach(() => {
    delete process.env.CI;
    delete process.env.FERRY_NO_UPDATE_CHECK;
  });
  afterEach(() => {
    for (const [key, value] of Object.entries(env)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  test("an update before a command stops the command, and a skip runs it", async () => {
    for (const updated of [true, false]) {
      const ran: string[] = [];
      const codes: number[] = [];
      await runCli(
        ["tools"],
        {
          isInteractive: () => true,
          offerSelfUpdate: async () => updated,
          runTools: async () => {
            ran.push("tools");
            return { tools: [] };
          },
          writeLine: () => {},
        },
        { setExitCode: (code) => codes.push(code) },
      );
      expect(ran).toEqual(updated ? [] : ["tools"]);
      expect(codes).toEqual([]);
    }
  });

  test("does not ask with --json, without a terminal, or for self-update", async () => {
    const offers: string[] = [];
    const offer = async () => {
      offers.push("asked");
      return false;
    };
    const quiet = { runTools: async () => ({ tools: [] }), writeLine: () => {} };
    await runCli(["tools", "--json"], { ...quiet, isInteractive: () => true, offerSelfUpdate: offer });
    await runCli(["tools"], { ...quiet, isInteractive: () => false, offerSelfUpdate: offer });
    await runCli(["self-update"], {
      ...quiet,
      isInteractive: () => true,
      offerSelfUpdate: offer,
      runSelfUpdate: async () => ({ current: "0.4.0", latest: "0.4.0", updated: false }),
    });
    expect(offers).toEqual([]);
  });

  test("self-update --json prints the result", async () => {
    const out: string[] = [];
    await runCli(["self-update", "--json"], {
      runSelfUpdate: async () => ({ current: "0.4.0", latest: "0.5.0", updated: true }),
      writeLine: (line) => out.push(line),
    });
    expect(JSON.parse(out[0] ?? "")).toMatchObject({
      command: "self-update",
      ok: true,
      result: { current: "0.4.0", latest: "0.5.0", updated: true },
    });
  });
});
