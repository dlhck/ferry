import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runCli } from "../src/cli.ts";
import type { PartialOperatorConfig } from "../src/config.ts";
import { formatDoctor, runDoctor, type DoctorCheck, type DoctorDependencies } from "../src/doctor.ts";
import type { HostAdapter, HostCommandResult, LinkErrorCode, LinkOptions, LinkResult } from "../src/link.ts";
import { noProgress } from "../src/progress.ts";
import { RealGitRunner, type GitInvocation, type GitRunner } from "../src/store.ts";
import { acquireBoxLock } from "../src/sync.ts";

const SNAPSHOT = "git@github.com:you/ferry-snapshot.git";
const HOME = "/home/user";
const FERRY = "/usr/local/bin/ferry";
const WATCH_UNIT = `${HOME}/.config/systemd/user/ferry-watch.service`;
const TUNNEL_UNIT = `${HOME}/.config/systemd/user/ferry-tunnel-a.service`;

const CONFIG: PartialOperatorConfig = {
  version: 1,
  publisher: "operator",
  snapshotUrl: SNAPSHOT,
  boxes: [
    { name: "a", host: { tailscale: "box-a", sshUser: "user" } },
    { name: "b", host: { transport: "ssh", destination: "user@box.example" }, gitAuth: "box" },
  ],
};

type BoxBehavior = {
  /** The Link error of every command, such as `host-offline`. */
  readonly down?: { readonly code: LinkErrorCode; readonly message: string };
  /** The command substrings that fail on the box. */
  readonly fails?: readonly string[];
  readonly units?: readonly string[];
  readonly linger?: string;
};

type Recorded = { readonly local: string[]; readonly git: string[]; readonly box: string[] };

function serviceFile(executable: string, args: string): string {
  return `[Unit]\nDescription=Ferry\n\n[Service]\nType=simple\nExecStart="${executable}" ${args}\n`;
}

function fakes(options: {
  readonly agent?: boolean;
  readonly tailscale?: "Running" | "Stopped" | "missing";
  readonly read?: boolean;
  readonly push?: boolean;
  readonly boxes?: Readonly<Record<string, BoxBehavior>>;
  readonly files?: Readonly<Record<string, string>>;
}): { readonly dependencies: Partial<DoctorDependencies>; readonly recorded: Recorded } {
  const recorded: Recorded = { local: [], git: [], box: [] };
  const local: HostAdapter = {
    async run({ argv }): Promise<HostCommandResult> {
      recorded.local.push(argv.join(" "));
      if (argv[0] === "ssh-add") {
        return options.agent === false
          ? { exitCode: 1, stdout: "", stderr: "The agent has no identities.", timedOut: false }
          : { exitCode: 0, stdout: "256 SHA256:abc operator@example.com (ED25519)\n", stderr: "", timedOut: false };
      }
      if (options.tailscale === "missing") throw new Error("tailscale: command not found");
      return { exitCode: 0, stdout: JSON.stringify({ BackendState: options.tailscale ?? "Running" }), stderr: "", timedOut: false };
    },
  };
  const git: GitRunner = {
    async run({ args }: GitInvocation) {
      recorded.git.push(args.join(" "));
      const ok = args.includes("push") ? options.push !== false : options.read !== false;
      const stderr = args.includes("push")
        ? "ERROR: The key you are authenticating with has been marked as read only."
        : "Permission denied (publickey).";
      return { status: ok ? 0 : 128, stdout: new Uint8Array(), stderr: new TextEncoder().encode(ok ? "" : stderr) };
    },
  };
  const createLink = (linkOptions: LinkOptions) => {
    const name = "destination" in linkOptions ? "b" : "a";
    const behavior = options.boxes?.[name] ?? {};
    return {
      async run(command: string): Promise<LinkResult> {
        recorded.box.push(`${name}: ${command}`);
        if (behavior.down) return { ok: false, error: { ...behavior.down, origin: "network" } };
        if (behavior.fails?.some((part) => command.includes(part))) {
          return { ok: false, error: { code: "command-failed", origin: "box", message: "git@github.com: Permission denied (publickey)." } };
        }
        const stdout = command.includes("loginctl")
          ? [...(behavior.units ?? []).map((name) => `unit=${name}`), `linger=${behavior.linger ?? "no"}`, ""].join("\n")
          : "";
        return { ok: true, address: name, stdout, stderr: "" };
      },
    };
  };
  const files = options.files ?? {};
  return {
    recorded,
    dependencies: {
      readConfig: () => CONFIG,
      home: HOME,
      local,
      git,
      createLink,
      progress: noProgress,
      services: {
        platform: "linux",
        home: HOME,
        exists: (path) => path in files,
        readFile: (path) => {
          const body = files[path];
          if (body === undefined) throw new Error("missing");
          return body;
        },
        readDirectory: () => Object.keys(files).map((path) => path.slice(path.lastIndexOf("/") + 1)),
        execPath: FERRY,
        scriptPath: undefined,
      },
    },
  };
}

function statuses(checks: readonly DoctorCheck[]): string[] {
  return checks.map((check) => `${check.box ?? "-"} ${check.id} ${check.status}`);
}

describe("ferry doctor", () => {
  test("a healthy setup passes each check", async () => {
    const { dependencies } = fakes({
      boxes: { a: { units: ["ferry-paseo.service"], linger: "yes" } },
      files: { [WATCH_UNIT]: serviceFile(FERRY, "watch"), [TUNNEL_UNIT]: serviceFile(FERRY, "tunnel --follow --box a") },
    });

    const report = await runDoctor({}, dependencies);

    expect(report.ok).toBe(true);
    expect(statuses(report.checks)).toEqual([
      "- ssh-agent ok",
      "- tailscale ok",
      "- snapshot-read ok",
      "- snapshot-push ok",
      "- watch-service ok",
      "- tunnel-service-a ok",
      "a box-ssh ok",
      "a box-tailscale ok",
      "a box-snapshot ok",
      "a box-linger ok",
      "a box-lock ok",
      "b box-ssh ok",
      "b box-snapshot ok",
      "b box-linger skipped",
      "b box-lock ok",
    ]);
    expect(formatDoctor(report).endsWith("All checks passed.")).toBe(true);
  });

  describe("box lock", () => {
    const lockOf = (report: { readonly checks: readonly DoctorCheck[] }, box: string) =>
      report.checks.find((check) => check.box === box && check.id === "box-lock");
    const lockPath = (home: string, target: string) =>
      join(home, ".ferry", `sync-${createHash("sha256").update(target).digest("hex").slice(0, 16)}.lock`);

    test("a held box lock is information, with its owner command and pid", async () => {
      const home = await mkdtemp(join(tmpdir(), "ferry-doctor-lock-"));
      const release = acquireBoxLock(home, CONFIG.boxes![1]!, "watch");
      try {
        const report = await runDoctor({}, { ...fakes({}).dependencies, home });

        expect(report.ok).toBe(true);
        expect(lockOf(report, "a")).toEqual({ id: "box-lock", box: "a", status: "ok", message: "No Ferry command holds the lock of the box.", fix: null });
        expect(lockOf(report, "b")).toEqual({
          id: "box-lock",
          box: "b",
          status: "ok",
          message: `The watch service syncs box b now (pid ${process.pid}).`,
          fix: null,
        });
      } finally {
        release();
        await rm(home, { recursive: true, force: true });
      }
    });

    test("a lock of an earlier Ferry version with a live pid fails, with the fix for the installed watch service", async () => {
      const home = await mkdtemp(join(tmpdir(), "ferry-doctor-lock-"));
      await mkdir(join(home, ".ferry"));
      await writeFile(lockPath(home, "ssh:user@box.example"), JSON.stringify({ pid: process.pid, token: "old" }));
      // No process has the pid of this lock, so the next command replaces it.
      await writeFile(lockPath(home, "tailscale:user@box-a"), JSON.stringify({ pid: 2_147_483_647, token: "old" }));
      const line = `A process of an earlier Ferry version holds the lock of box b (pid ${process.pid}). A sync of the box fails while a process has that pid.`;
      try {
        const bare = await runDoctor({}, { ...fakes({}).dependencies, home });
        const watch = await runDoctor({}, { ...fakes({ files: { [WATCH_UNIT]: serviceFile(FERRY, "watch") } }).dependencies, home });

        expect(bare.ok).toBe(false);
        expect(lockOf(bare, "a")?.status).toBe("ok");
        expect(lockOf(bare, "b")).toEqual({ id: "box-lock", box: "b", status: "failed", message: line, fix: `kill ${process.pid}` });
        expect(lockOf(watch, "b")).toEqual({
          id: "box-lock",
          box: "b",
          status: "failed",
          message: `${line} If the fix does not free the lock, stop the process with kill ${process.pid}.`,
          fix: "ferry watch install",
        });
      } finally {
        await rm(home, { recursive: true, force: true });
      }
    });
  });

  test("a broken setup completes and names every failed check with its fix", async () => {
    const { dependencies } = fakes({
      agent: false,
      push: false,
      boxes: {
        a: { down: { code: "host-offline", message: "Tailscale host box-a is offline" } },
        b: { fails: ["ferry_snapshot"], units: ["ferry-paseo.service"], linger: "no" },
      },
      files: { [WATCH_UNIT]: serviceFile("/opt/old/ferry", "watch") },
    });

    const report = await runDoctor({}, dependencies);

    expect(report.ok).toBe(false);
    const failed = report.checks.filter((check) => check.status === "failed");
    expect(failed.map((check) => [check.box, check.id, check.fix])).toEqual([
      [null, "ssh-agent", "ssh-add"],
      [null, "snapshot-push", "ssh-add"],
      [null, "watch-service", "ferry watch install"],
      ["a", "box-tailscale", "sudo tailscale up"],
      ["b", "box-snapshot", "ssh user@box.example cat ~/.ssh/ferry_snapshot.pub"],
      ["b", "box-linger", `ssh user@box.example 'sudo loginctl enable-linger "$USER"'`],
    ]);
    expect(failed.find((check) => check.id === "snapshot-push")?.message).toContain("marked as read only");
    expect(failed.find((check) => check.id === "watch-service")?.message).toContain("/opt/old/ferry");
    expect(report.checks.find((check) => check.box === "a" && check.id === "box-ssh")?.status).toBe("skipped");
    expect(report.checks.find((check) => check.box === "a" && check.id === "box-linger")?.status).toBe("skipped");
    expect(formatDoctor(report)).toContain("FAILED  b box-linger: Linger is off for the box user, so ferry-paseo.service stops at logout.");
  });

  test("a host key failure asks the operator to connect once and check the key", async () => {
    const { dependencies } = fakes({
      boxes: { b: { down: { code: "ssh-failed", message: "Host key verification failed." } } },
    });

    const report = await runDoctor({ selection: ["b"] }, dependencies);

    expect(report.checks.find((check) => check.id === "box-ssh")).toEqual({
      id: "box-ssh",
      box: "b",
      status: "failed",
      message: "user@box.example does not respond over SSH: Host key verification failed.",
      fix: "ssh user@box.example",
    });
    expect(report.checks.some((check) => check.id === "tailscale")).toBe(false);
  });

  test("Tailscale down on this machine fails once, and the Tailscale box checks skip", async () => {
    const { dependencies } = fakes({
      tailscale: "Stopped",
      boxes: { a: { down: { code: "tailscale-status-failed", message: "Tailscale is stopped." } } },
    });

    const report = await runDoctor({ selection: ["a"] }, dependencies);

    expect(statuses(report.checks).filter((line) => !line.includes(" ok"))).toEqual([
      "- tailscale failed",
      "a box-ssh skipped",
      "a box-tailscale skipped",
      "a box-snapshot skipped",
      "a box-linger skipped",
    ]);
  });

  test("the agent box reads the snapshot through the forwarded agent, and doctor runs only reading commands", async () => {
    const { dependencies, recorded } = fakes({ boxes: { a: { fails: ["ls-remote"] } } });

    const report = await runDoctor({ selection: ["a"] }, dependencies);

    expect(report.checks.find((check) => check.id === "box-snapshot")?.fix).toBe("ferry init --box a");
    expect(recorded.local).toEqual(["ssh-add -l", "tailscale status --json"]);
    expect(recorded.git).toEqual([
      `ls-remote ${SNAPSHOT} HEAD`,
      `-C ${HOME}/.ferry/store push --dry-run --porcelain origin HEAD:refs/heads/ferry-doctor-probe`,
    ]);
    expect(recorded.box.map((command) => command.split("\n")[0])).toEqual([
      "a: true",
      `a: git ls-remote '${SNAPSHOT}' HEAD`,
      expect.stringContaining("loginctl show-user"),
    ]);
  });

  test("the push check leaves a local snapshot remote unchanged", async () => {
    const root = await mkdtemp(join(tmpdir(), "ferry-doctor-"));
    const git = new RealGitRunner();
    const run = async (args: string[], cwd?: string) => {
      const result = await git.run({ args, ...(cwd ? { cwd } : {}) });
      if (result.status !== 0) throw new Error(new TextDecoder().decode(result.stderr));
      return new TextDecoder().decode(result.stdout);
    };
    try {
      const remote = join(root, "snapshot.git");
      const store = join(root, ".ferry/store");
      await run(["init", "--bare", "-q", remote]);
      await run(["init", "-q", store]);
      await run(["-c", "user.name=Operator", "-c", "user.email=operator@example.com", "-c", "commit.gpgsign=false", "commit", "-q", "--allow-empty", "-m", "seed"], store);
      await run(["remote", "add", "origin", remote], store);
      await run(["push", "-q", "origin", "HEAD:refs/heads/main"], store);
      const before = await run(["ls-remote", remote]);

      const report = await runDoctor(
        { selection: [] },
        {
          ...fakes({}).dependencies,
          readConfig: () => ({ ...CONFIG, snapshotUrl: remote, boxes: [] }),
          home: root,
          git,
        },
      );

      expect(statuses(report.checks).filter((line) => line.includes("snapshot"))).toEqual([
        "- snapshot-read ok",
        "- snapshot-push ok",
      ]);
      expect(await run(["ls-remote", remote])).toBe(before);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe("ferry doctor --json", () => {
  async function run(report: Awaited<ReturnType<typeof runDoctor>>) {
    const stdout: string[] = [];
    const exitCodes: number[] = [];
    await runCli(
      ["--json", "doctor"],
      {
        readConfig: () => CONFIG,
        createPlainProgress: () => noProgress,
        runDoctor: async () => report,
        writeLine: (line) => stdout.push(line),
        writeError: () => {},
      },
      { renderError: () => {}, setExitCode: (code) => exitCodes.push(code) },
    );
    return { json: stdout.map((line) => JSON.parse(line)), exitCodes };
  }

  const check: DoctorCheck = { id: "ssh-agent", box: null, status: "ok", message: "The SSH agent has a key.", fix: null };

  test("a passing run prints one envelope with one entry for each check", async () => {
    const report = { schemaVersion: 1 as const, ok: true, checks: [check] };
    const result = await run(report);

    expect(result.exitCodes).toEqual([]);
    expect(result.json).toEqual([
      { schemaVersion: 1, command: "doctor", ok: true, result: report, warnings: [], error: null },
    ]);
  });

  test("a failed check gives ok false, exit code 1, and keeps every check in result", async () => {
    const failed: DoctorCheck = { ...check, status: "failed", message: "The SSH agent has no key.", fix: "ssh-add" };
    const report = { schemaVersion: 1 as const, ok: false, checks: [failed, { ...check, id: "snapshot-read" }] };
    const result = await run(report);

    expect(result.exitCodes).toEqual([1]);
    expect(result.json).toEqual([
      {
        schemaVersion: 1,
        command: "doctor",
        ok: false,
        result: report,
        warnings: [],
        error: {
          code: "failed",
          message: "1 of 2 checks failed.",
          hint: "Run the fix of each failed check, then run ferry doctor again.",
        },
      },
    ]);
  });
});
