import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, openSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { PartialOperatorConfig } from "../src/config.ts";
import { runIntegrationCommand } from "../src/integrations/command.ts";
import {
  addSherlockConnection,
  createSherlock,
  readSherlockFile,
  SHERLOCK_INSTALL,
  sherlockHealth,
  tunnelCommand,
  type SherlockDependencies,
  type SherlockInput,
} from "../src/integrations/sherlock.ts";
import type { LinkResult } from "../src/link.ts";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function tempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "ferry-sherlock-"));
  roots.push(root);
  return root;
}

const CONFIG: PartialOperatorConfig = {
  version: 1,
  publisher: "operator@example.com",
  snapshotUrl: "git@github.com:you/ferry-snapshot.git",
  integrations: { sherlock: true },
  boxes: [
    { name: "lab", host: { transport: "ssh", destination: "user@box.example" } },
    { name: "edge", host: { transport: "ssh", destination: "user@edge.example" } },
  ],
  defaultBox: "lab",
};

const REACHED: LinkResult = { ok: true, address: "box.example", stdout: "", stderr: "" };

type Calls = { sherlock: { args: readonly string[]; input: SherlockInput }[]; reach: string[] };

/** Fakes for Sherlock and the box. `list` is the output of `sherlock connection list`. */
function fakes(
  overrides: Partial<SherlockDependencies> & { list?: readonly string[]; reach?: (target: string) => LinkResult } = {},
) {
  const home = tempRoot();
  const calls: Calls = { sherlock: [], reach: [] };
  const dependencies: SherlockDependencies = {
    which: () => "/usr/local/bin/sherlock",
    runSherlock: async (args, input) => {
      calls.sherlock.push({ args, input });
      if (args[1] === "list") return { exitCode: 0, stdout: JSON.stringify({ connections: overrides.list ?? [] }), stderr: "" };
      return { exitCode: 0, stdout: "{}", stderr: "" };
    },
    readConfig: () => CONFIG,
    createLink: (options) => ({
      reach: async (target) => {
        const key = `${"destination" in options ? options.destination : "?"} ${target.host}:${target.port}`;
        calls.reach.push(key);
        return overrides.reach?.(key) ?? REACHED;
      },
    }),
    home: () => home,
    askPassword: async () => "s3cret-example",
    interactive: () => true,
    ...overrides,
  };
  return { home, calls, dependencies };
}

describe("tunnelCommand", () => {
  test("puts the target and the Sherlock port placeholder after ferry tunnel --box", () => {
    expect(tunnelCommand("lab", "5432")).toBe("ferry tunnel --box lab 5432:{{port}}");
    expect(tunnelCommand("lab", "db.example:5432")).toBe("ferry tunnel --box lab db.example:5432:{{port}}");
    // Brackets are shell patterns, so an IPv6 target gets quotes.
    expect(tunnelCommand("lab", "[fd00::1]:5432")).toBe("ferry tunnel --box lab '[fd00::1]:5432:{{port}}'");
  });
});

describe("ferry sherlock add", () => {
  const input = {
    name: "app-db",
    boxes: [] as string[],
    target: "db.example:5432",
    type: "postgres",
    database: "app",
    username: "dbuser",
  };

  test("adds a connection with the ferry tunnel command and gives the password to Sherlock on stdin", async () => {
    const { home, calls, dependencies } = fakes();

    const result = await addSherlockConnection({ ...input, boxes: ["edge"] }, dependencies);

    expect(calls.sherlock).toEqual([
      {
        args: [
          "connection", "add", "app-db",
          "--type", "postgres",
          "--database", "app",
          "--username", "dbuser",
          "--password-stdin",
          "--tunnel-command", "ferry tunnel --box edge db.example:5432:{{port}}",
        ],
        input: { password: "s3cret-example" },
      },
    ]);
    expect(readSherlockFile(home).connections).toEqual([{ name: "app-db", box: "edge", target: "db.example:5432" }]);
    // Ferry writes only its record. It has no password, and Ferry does not touch the Sherlock config.
    expect(readFileSync(join(home, ".ferry", "sherlock.json"), "utf8")).not.toContain("s3cret-example");
    expect(existsSync(join(home, ".config"))).toBe(false);
    expect(result).toEqual({
      name: "app-db",
      box: "edge",
      target: "db.example:5432",
      tunnelCommand: "ferry tunnel --box edge db.example:5432:{{port}}",
    });
  });

  test("adds a connection to a box port on the default box", async () => {
    const { home, calls, dependencies } = fakes();

    await addSherlockConnection({ ...input, target: "5432" }, dependencies);

    expect(calls.sherlock[0]?.args).toContain("ferry tunnel --box lab 5432:{{port}}");
    expect(readSherlockFile(home).connections).toEqual([{ name: "app-db", box: "lab", target: "5432" }]);
  });

  test("passes the stdin of Ferry through with --password-stdin, and asks nothing", async () => {
    const { calls, dependencies } = fakes({ askPassword: async () => { throw new Error("no prompt"); } });

    await addSherlockConnection({ ...input, passwordStdin: true }, dependencies);

    expect(calls.sherlock[0]?.input).toBe("inherit");
    expect(calls.sherlock[0]?.args).toContain("--password-stdin");
  });

  test("without a terminal and without a password flag, asks nothing and gives Sherlock no password", async () => {
    const { calls, dependencies } = fakes({ interactive: () => false, askPassword: async () => { throw new Error("no prompt"); } });

    await addSherlockConnection({ ...input, passwordEnv: undefined }, dependencies);

    expect(calls.sherlock[0]?.input).toBe("none");
    expect(calls.sherlock[0]?.args).not.toContain("--password-stdin");
  });

  test("an empty password gives Sherlock no password", async () => {
    const { calls, dependencies } = fakes({ askPassword: async () => "" });

    await addSherlockConnection(input, dependencies);

    expect(calls.sherlock[0]?.input).toBe("none");
  });

  test("replaces the record of a connection with the same name", async () => {
    const { home, dependencies } = fakes();

    await addSherlockConnection(input, dependencies);
    await addSherlockConnection({ ...input, target: "5433", force: true }, dependencies);

    expect(readSherlockFile(home).connections).toEqual([{ name: "app-db", box: "lab", target: "5433" }]);
  });

  test("refuses a target with a local port and an unknown box before it runs Sherlock", async () => {
    const { calls, dependencies } = fakes();

    await expect(addSherlockConnection({ ...input, target: "5432:15432" }, dependencies)).rejects.toThrow("invalid target 5432:15432");
    await expect(addSherlockConnection({ ...input, boxes: ["nope"] }, dependencies)).rejects.toThrow("unknown box nope");
    expect(calls.sherlock).toEqual([]);
  });

  test("reports a Sherlock failure and records nothing", async () => {
    const { home, dependencies } = fakes({
      runSherlock: async () => ({ exitCode: 1, stdout: "", stderr: 'Error: Connection "app-db" already exists. Pass --force to replace it.\n' }),
    });

    await expect(addSherlockConnection(input, dependencies)).rejects.toThrow(
      'sherlock connection add failed: Connection "app-db" already exists. Pass --force to replace it.',
    );
    expect(existsSync(join(home, ".ferry", "sherlock.json"))).toBe(false);
  });
});

describe("the Sherlock status check", () => {
  function record(home: string, connections: readonly { name: string; box: string; target: string }[]) {
    mkdirSync(join(home, ".ferry"), { recursive: true });
    writeFileSync(join(home, ".ferry", "sherlock.json"), JSON.stringify({ schemaVersion: 1, connections }));
  }

  test("checks each recorded connection that Sherlock still has from its box", async () => {
    const setup = fakes({
      list: ["box-db", "rds", "old-box"],
      reach: (key) =>
        key.endsWith("rds.example:5432")
          ? { ok: false, error: { code: "forward-failed", origin: "box", message: "connect failed: Connection timed out" } }
          : REACHED,
    });
    record(setup.home, [
      { name: "box-db", box: "lab", target: "5432" },
      { name: "rds", box: "edge", target: "rds.example:5432" },
      { name: "old-box", box: "gone", target: "5432" },
      { name: "deleted", box: "lab", target: "6379" },
    ]);

    const health = await sherlockHealth(setup.dependencies);

    expect(setup.calls.reach.sort()).toEqual(["user@box.example 127.0.0.1:5432", "user@edge.example rds.example:5432"]);
    expect(health.lines).toEqual([
      "box-db  lab:5432  reachable",
      "rds  edge:rds.example:5432  unreachable",
      "old-box  gone:5432  unknown-box",
    ]);
    expect(health.warnings).toEqual([
      "Sherlock connection rds: edge cannot reach rds.example:5432: connect failed: Connection timed out",
      "Sherlock connection old-box: box gone is not in the Ferry config.",
    ]);
    expect(health.json).toEqual({
      connections: [
        { name: "box-db", box: "lab", target: "5432", state: "reachable", error: null },
        {
          name: "rds",
          box: "edge",
          target: "rds.example:5432",
          state: "unreachable",
          error: "edge cannot reach rds.example:5432: connect failed: Connection timed out",
        },
        { name: "old-box", box: "gone", target: "5432", state: "unknown-box", error: "box gone is not in the Ferry config." },
      ],
    });
  });

  test("says when the box does not answer", async () => {
    const setup = fakes({
      list: ["box-db"],
      reach: () => ({ ok: false, error: { code: "ssh-failed", origin: "network", message: "Connection refused" } }),
    });
    record(setup.home, [{ name: "box-db", box: "lab", target: "5432" }]);

    const health = await sherlockHealth(setup.dependencies);

    expect(health.warnings).toEqual(["Sherlock connection box-db: could not connect to lab: Connection refused"]);
  });

  test("without records, runs no command", async () => {
    const setup = fakes();

    const health = await sherlockHealth(setup.dependencies);

    expect(health).toEqual({ lines: ["No connections of ferry sherlock add."], warnings: [], json: { connections: [] } });
    expect(setup.calls.sherlock).toEqual([]);
  });
});

describe("ferry integrations enable sherlock", () => {
  test("without the sherlock executable, stops with the install command and keeps the config", async () => {
    const changes: string[] = [];
    const run = runIntegrationCommand(
      { action: "enable", name: "sherlock", yes: true, dryRun: false },
      {
        integrations: [createSherlock({ which: () => null })],
        readConfig: () => CONFIG,
        setIntegration: (id, enabled) => changes.push(`${id}=${enabled}`),
        writeLine: () => {},
      },
    );

    await expect(run).rejects.toThrow(`Sherlock is not available on this machine. Install it, then run ferry integrations enable sherlock again:\n  ${SHERLOCK_INSTALL}`);
    expect(changes).toEqual([]);
  });

  test("with the sherlock executable, changes only the config", async () => {
    const changes: string[] = [];

    await runIntegrationCommand(
      { action: "enable", name: "sherlock", yes: false, dryRun: false },
      {
        integrations: [createSherlock({ which: () => "/usr/local/bin/sherlock" })],
        readConfig: () => ({ ...CONFIG, boxes: undefined, host: { transport: "ssh", destination: "user@box.example" } }),
        setIntegration: (id, enabled) => changes.push(`${id}=${enabled}`),
        writeLine: () => {},
      },
    );

    expect(changes).toEqual(["sherlock=true"]);
  });
});

describe("ferry sherlock as a process", () => {
  const CLI = join(import.meta.dir, "..", "src", "cli.ts");

  /** Logs the arguments and the stdin of `connection add`, and prints the names of FAKE_SHERLOCK_LIST. */
  const FAKE_SHERLOCK = `#!/bin/sh
if [ "$1 $2" = "connection add" ]; then
  printf '%s\\n' "$@" > "$FAKE_SHERLOCK_LOG"
  cat > "$FAKE_SHERLOCK_LOG.stdin"
  echo '{"action":"added"}'
  exit 0
fi
echo '{"connections":[]}'
`;

  /** Answers the connect test of reach. Else it waits for SIGTERM and records that it had no terminal. */
  const FAKE_SSH = `#!/bin/sh
printf '%s\\n' "$*" >> "$FAKE_SSH_LOG"
case "$*" in *"/dev/tcp/"*) echo "exit 0"; exit 0 ;; esac
[ -t 0 ] && echo "stdin is a terminal" >> "$FAKE_SSH_LOG"
trap 'echo stopped >> "$FAKE_SSH_LOG"; exit 0' TERM
touch "$FAKE_SSH_LOG.ready"
while :; do sleep 0.05; done
`;

  function setup(withSherlock: boolean) {
    const root = tempRoot();
    const home = join(root, "home");
    const bin = join(root, "bin");
    mkdirSync(join(home, ".ferry"), { recursive: true });
    mkdirSync(bin);
    const script = (name: string, body: string) => {
      writeFileSync(join(bin, name), body);
      chmodSync(join(bin, name), 0o755);
    };
    script("ssh", FAKE_SSH);
    script("ferry", `#!/bin/sh\nexec "${process.execPath}" "${CLI}" "$@"\n`);
    if (withSherlock) script("sherlock", FAKE_SHERLOCK);
    writeFileSync(
      join(home, ".ferry", "config.toml"),
      [
        "version = 1",
        'publisher = "operator@example.com"',
        'snapshot_url = "git@github.com:you/ferry-snapshot.git"',
        "",
        "[integrations]",
        "sherlock = true",
        "",
        "[box.lab]",
        'transport = "ssh"',
        'destination = "user@box.example"',
        "",
      ].join("\n"),
    );
    const env = {
      HOME: home,
      // No real sherlock: only the fakes, bun, and the system tools.
      PATH: `${bin}:${dirname(process.execPath)}:/usr/bin:/bin`,
      FAKE_SHERLOCK_LOG: join(root, "sherlock.log"),
      FAKE_SSH_LOG: join(root, "ssh.log"),
    };
    const run = async (args: string[], stdin = "") => {
      const child = Bun.spawn([process.execPath, CLI, ...args], { env, stdin: new Blob([stdin]), stdout: "pipe", stderr: "pipe" });
      const [exitCode, stdout, stderr] = await Promise.all([
        child.exited,
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
      ]);
      return { exitCode, stdout, stderr };
    };
    return { root, home, env, run };
  }

  test("without sherlock on the PATH, ferry sherlock is not in the help and does not run", async () => {
    const env = setup(false);

    const help = await env.run(["--help"]);
    const add = await env.run(["sherlock"]);

    expect(help.stdout).toContain("integrations");
    expect(help.stdout).not.toContain("sherlock");
    expect(add.exitCode).not.toBe(0);
    expect(`${add.stdout}${add.stderr}`).toContain("too many arguments. Expected 0 arguments but got 1: sherlock.");
  }, 20_000);

  test("with sherlock on the PATH, add passes --box and the stdin password through to Sherlock", async () => {
    const env = setup(true);

    const add = await env.run(
      ["sherlock", "add", "app-db", "--box", "lab", "--target", "db.example:5432", "--type", "postgres", "--database", "app", "--username", "dbuser", "--password-stdin"],
      "s3cret-example",
    );

    expect(add.exitCode).toBe(0);
    expect(readFileSync(env.env.FAKE_SHERLOCK_LOG, "utf8").trim().split("\n")).toEqual([
      "connection", "add", "app-db",
      "--type", "postgres",
      "--database", "app",
      "--username", "dbuser",
      "--password-stdin",
      "--tunnel-command", "ferry tunnel --box lab db.example:5432:{{port}}",
    ]);
    expect(readFileSync(`${env.env.FAKE_SHERLOCK_LOG}.stdin`, "utf8")).toBe("s3cret-example");
    for (const file of readdirSync(join(env.home, ".ferry"))) {
      expect(readFileSync(join(env.home, ".ferry", file), "utf8")).not.toContain("s3cret-example");
    }
  }, 20_000);

  test("with --json, add prints one envelope on stdout and asks nothing", async () => {
    const env = setup(true);

    const refused = await env.run(["--json", "sherlock", "add", "app-db", "--target", "5432", "--type", "postgres"]);
    const ranSherlock = existsSync(env.env.FAKE_SHERLOCK_LOG);
    const added = await env.run(
      ["--json", "sherlock", "add", "app-db", "--target", "5432", "--type", "postgres", "--database", "app", "--username", "dbuser", "--password-env", "APP_DB_PASSWORD"],
    );

    expect(refused.exitCode).not.toBe(0);
    expect(JSON.parse(refused.stdout)).toMatchObject({
      ok: false,
      error: { code: "usage", message: "With --json, Ferry asks nothing. Give --password-stdin or --password-env." },
    });
    expect(ranSherlock).toBe(false);
    expect(added.exitCode).toBe(0);
    expect(JSON.parse(added.stdout)).toEqual({
      schemaVersion: 1,
      command: "sherlock add",
      ok: true,
      result: { name: "app-db", box: "lab", target: "5432", tunnelCommand: "ferry tunnel --box lab 5432:{{port}}" },
      warnings: [],
      error: null,
    });
    expect(readFileSync(env.env.FAKE_SHERLOCK_LOG, "utf8")).toContain("--password-env\nAPP_DB_PASSWORD\n");
  }, 20_000);

  test("the tunnel command runs as Sherlock runs it: in a shell, without a terminal, and SIGTERM to the group closes it", async () => {
    const env = setup(true);
    const port = await freePort();
    const log = join(env.root, "tunnel.log");
    const output = openSync(log, "w");
    // Sherlock starts the command with a shell, detached, stdin ignored, and output in a log file.
    const child = Bun.spawn(["sh", "-c", tunnelCommand("lab", "db.example:5432").replace("{{port}}", String(port))], {
      env: env.env,
      stdin: "ignore",
      stdout: output,
      stderr: output,
      detached: true,
    });
    const deadline = Date.now() + 10_000;
    while (!existsSync(`${env.env.FAKE_SSH_LOG}.ready`) && Date.now() < deadline) await Bun.sleep(20);
    expect(existsSync(`${env.env.FAKE_SSH_LOG}.ready`)).toBe(true);

    // Sherlock stops the tunnel with SIGTERM to the process group.
    process.kill(-child.pid, "SIGTERM");

    // The shell dies of the signal. Ferry closes the tunnel and stops OpenSSH.
    await child.exited;
    const closed = Date.now() + 10_000;
    while (!readFileSync(log, "utf8").includes("Tunnel closed.") && Date.now() < closed) await Bun.sleep(20);
    const ssh = readFileSync(env.env.FAKE_SSH_LOG, "utf8").trim().split("\n");
    expect(ssh[0]).toContain("-o BatchMode=yes");
    expect(ssh[1]).toContain(`-L 127.0.0.1:${port}:db.example:5432 user@box.example`);
    expect(ssh).not.toContain("stdin is a terminal");
    expect(ssh.at(-1)).toBe("stopped");
    expect(readFileSync(log, "utf8")).toContain(`http://localhost:${port} -> lab:db.example:5432`);
    expect(readFileSync(log, "utf8").trim().split("\n").at(-1)).toBe("Tunnel closed.");
  }, 20_000);
});

async function freePort(): Promise<number> {
  const server = Bun.listen({ hostname: "127.0.0.1", port: 0, socket: { data() {} } });
  const port = server.port;
  server.stop(true);
  return port;
}
