import { describe, expect, test } from "bun:test";
import { UpdateError, type UpdateCommandInput, type UpdateCommandResult } from "../src/update.ts";
import { BoxesSyncError, SyncError } from "../src/sync.ts";
import { FerryError } from "../src/errors.ts";
import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildProgram, isBoxMode, runCli } from "../src/cli.ts";
import {
  InitRefusal,
  type InitDependencies,
  type InitInput,
  type InitResult,
  type SnapshotHostKeyApproval,
} from "../src/init.ts";
import { createPaseo } from "../src/integrations/paseo.ts";
import { EXAMPLE_ID, operatorIntegration } from "./fake-integration.ts";
import { denyRules } from "../src/manifest.ts";
import { BUILTIN_TOOLS } from "../src/registry/builtin.ts";
import { Link } from "../src/link.ts";
import type { PartialOperatorConfig } from "../src/config.ts";
import type { SyncInput, SyncResult } from "../src/sync.ts";
import type { UninstallInput, UninstallResult } from "../src/uninstall.ts";
import { lineProgress, noProgress, type Progress } from "../src/progress.ts";
import { recordProgress } from "./fake-progress.ts";
import type { StatusCommandInput } from "../src/status-command.ts";
import type { StatusReport } from "../src/status.ts";

const INIT_SKILL = {
  action: "installed",
  path: "/home/user/.agents/skills/ferry",
  message: "Installed the Ferry skill in ~/.agents/skills/ferry.",
} as const;

/** A status report without boxes, for the mocks of runStatus. */
const EMPTY_REPORT: StatusReport = {
  schemaVersion: 2,
  store: { local: null, remote: null, localMatchesRemote: false, error: null },
  operator: { gitIdentity: null, error: null },
  denyList: [],
  boxes: [],
  errors: [],
};

describe("ferry --help", () => {
  test("renders command errors without throwing them to Bun", async () => {
    const errors: string[] = [];
    const exitCodes: number[] = [];

    await runCli(
      ["init", "--host", "box", "--ssh-user", "ferry", "--snapshot-url", "snapshot.git"],
      {
        runInit: async () => {
          throw new Error("Manifest refused the source: clash example");
        },
      },
      {
        renderError: (message) => errors.push(message),
        setExitCode: (code) => exitCodes.push(code),
      },
    );

    expect(errors).toEqual(["Manifest refused the source: clash example"]);
    expect(exitCodes).toEqual([1]);
  });

  test("states that logins are not copied", () => {
    expect(buildProgram().helpInformation()).toContain("Ferry never copies logins.");
  });

  test("an unknown argument is refused", () => {
    const program = buildProgram().exitOverride();
    program.configureOutput({ writeOut: () => {}, writeErr: () => {} });
    expect(() => program.parse(["--sync-everything"], { from: "user" })).toThrow();
  });

  test("wires init flags to the init module", async () => {
    let received: InitInput | undefined;
    const result: InitResult = {
      dryRun: false,
      leftovers: [],
      published: true,
      skill: INIT_SKILL,
    };
    const output: string[] = [];
    const program = buildProgram({
      readConfig: () => null,
      runInit: async (input) => {
        received = input;
        return result;
      },
      prompt: async () => ({}),
      writeLine: (line) => output.push(line),
    });

    await program.parseAsync(
      [
        "init",
        "--host",
        "builder.tailnet.ts.net",
        "--ssh-user",
        "david",
        "--snapshot-url",
        "snapshot.git",
      ],
      { from: "user" },
    );

    expect(received).toMatchObject({
      host: "builder.tailnet.ts.net",
      sshUser: "david",
      snapshotUrl: "snapshot.git",
    });
    expect(received?.skill).toBe(true);
    expect(output).toEqual(["Snapshot seed published.", INIT_SKILL.message]);
  });

  test("--no-skill turns off the skill install of init", async () => {
    let received: InitInput | undefined;
    const program = buildProgram({
      readConfig: () => null,
      runInit: async (input) => {
        received = input;
        return { dryRun: false, leftovers: [], published: false, skill: { ...INIT_SKILL, action: "off" } };
      },
      writeLine: () => {},
    });

    await program.parseAsync(
      ["init", "--ssh-destination", "user@box.example", "--snapshot-url", "snapshot.git", "--no-skill"],
      { from: "user" },
    );

    expect(received?.skill).toBe(false);
  });

  test("wires an explicit SSH destination to init", async () => {
    let received: InitInput | undefined;
    const program = buildProgram({
      readConfig: () => null,
      runInit: async (input) => {
        received = input;
        return {
          dryRun: false,
          leftovers: [],
          published: false,
          skill: INIT_SKILL,
        };
      },
      writeLine: () => {},
    });

    await program.parseAsync(
      ["init", "--ssh-destination", "user@box.example", "--snapshot-url", "snapshot.git"],
      { from: "user" },
    );

    expect(received).toMatchObject({
      sshDestination: "user@box.example",
      snapshotUrl: "snapshot.git",
    });
  });

  test("wires Git host key approval to init", async () => {
    let initDependencies: InitDependencies | undefined;
    const request: SnapshotHostKeyApproval = {
      host: "github.com",
      keys: [
        {
          algorithm: "ssh-ed25519",
          fingerprint: "SHA256:github-key",
        },
      ],
    };
    const program = buildProgram({
      readConfig: () => null,
      runInit: async (_input, dependencies) => {
        initDependencies = dependencies;
        return {
          dryRun: false,
          leftovers: [],
          published: false,
          skill: INIT_SKILL,
        };
      },
      approveHostKeys: async (value) => value === request,
      writeLine: () => {},
    });

    await program.parseAsync(
      ["init", "--ssh-destination", "user@box.example", "--snapshot-url", "snapshot.git"],
      { from: "user" },
    );

    expect(await initDependencies?.approveHostKeys?.(request)).toBe(true);
  });

  test("wires init --dry-run and prints the plan", async () => {
    let received: InitInput | undefined;
    const output: string[] = [];
    const program = buildProgram({
      readConfig: () => null,
      runInit: async (input) => {
        received = input;
        return {
          dryRun: true,
          leftovers: [],
          plan: {
            operator: "operator.test",
            box: "david@box",
            gitRemote: "snapshot.git",
            localCheckout: "/home/david/.ferry/store",
            configPath: "/home/david/.ferry/config.toml",
            skills: ["tdd"],
            instructions: true,
            links: [],
          },
        };
      },
      writeLine: (line) => output.push(line),
    });

    await program.parseAsync(
      ["init", "--host", "box", "--ssh-user", "david", "--snapshot-url", "snapshot.git", "--dry-run"],
      { from: "user" },
    );

    expect(received?.dryRun).toBe(true);
    expect(output).toContain("Init plan (no changes will be made):");
    expect(output).toContain("Probe: SSH connection to david@box");
    expect(output).toContain("Deny list:");
    for (const rule of denyRules()) {
      expect(output).toContain(`  ${rule.code}: ${rule.behavior} ${rule.description}`);
    }
  });

  test("lists the integrations from the config without other work", async () => {
    const output: string[] = [];
    const program = buildProgram({
      readConfig: () => ({
        host: { transport: "ssh", destination: "ploi@box" },
        integrations: { paseo: true },
      }),
      integrations: [createPaseo({ platform: "win32" })],
      writeLine: (line) => output.push(line),
    });

    await program.parseAsync(["integrations"], { from: "user" });

    expect(output).toEqual([
      "paseo  enabled  Paseo daemon on the box",
      "  Parts: box, operator",
      "  Local app: not found. The box version is not pinned.",
      "  This machine: available",
      "  Connect to the box:",
      "    Open Paseo Desktop.",
      "    Open Settings → Add host → Remote SSH.",
      "    Enter ssh://ploi@box.",
    ]);
  });

  test("adds the commands of an enabled operator part only when it can run on this machine", async () => {
    const runs: string[] = [];
    const program = (config: PartialOperatorConfig | null, available = true) =>
      buildProgram({
        readConfig: () => config,
        integrations: [createPaseo({ platform: "win32" }), operatorIntegration({ available, runs })],
        writeLine: () => {},
      });
    const names = (command: ReturnType<typeof buildProgram>) => command.commands.map((known) => known.name());
    const enabled: PartialOperatorConfig = { integrations: { [EXAMPLE_ID]: true } };

    await program(enabled).parseAsync(["example"], { from: "user" });

    expect(runs).toEqual(["example"]);
    expect(names(program(enabled, false))).not.toContain("example");
    expect(names(program({ integrations: { paseo: true } }))).not.toContain("example");
    expect(names(program(null))).toEqual(names(buildProgram({ readConfig: () => null })));
  });

  test("wires ferry tools to the registry tools of the config", async () => {
    const received: string[][] = [];
    const program = buildProgram({
      readConfig: () => ({ tools: { bun: "1.4.2" } }),
      runTools: async (dependencies) => {
        received.push(dependencies.tools.map((tool) => tool.id));
        return { tools: [] };
      },
    });

    await program.parseAsync(["tools"], { from: "user" });

    expect(received).toEqual([BUILTIN_TOOLS.map((tool) => tool.id)]);
  });

  test("wires integrations enable and disable with their flags", async () => {
    const received: unknown[] = [];
    const program = buildProgram({
      readConfig: () => null,
      runIntegration: async (input) => {
        received.push(input);
        return null;
      },
    });

    await program.parseAsync(["integrations", "enable", "paseo", "--dry-run", "--yes"], { from: "user" });
    await program.parseAsync(["integrations", "disable", "paseo", "--purge"], { from: "user" });

    expect(received).toEqual([
      { action: "enable", name: "paseo", dryRun: true, yes: true },
      { action: "disable", name: "paseo", purge: true, yes: false },
    ]);
  });

  test("init help lists every non-interactive flag", () => {
    const help = buildProgram().commands
      .find((command) => command.name() === "init")
      ?.helpInformation();

    expect(help).toContain("Tailscale host or SSH destination");
    expect(help).toContain("--host <host>");
    expect(help).toContain("--ssh-user <user>");
    expect(help).toContain("--ssh-destination <destination>");
    expect(help).toContain("--snapshot-url <url>");
    expect(help).toContain("--dry-run");
  });

  test("wires install --yes to the install command", async () => {
    let received: { yes: boolean } | undefined;
    const program = buildProgram({
      readConfig: () => null,
      runInstall: async (input) => {
        received = input;
        return null;
      },
    });

    await program.parseAsync(["install", "--yes"], { from: "user" });

    expect(received).toEqual({ yes: true });
  });

  test("wires uninstall to the uninstall module and reports the result", async () => {
    let received: UninstallInput | undefined;
    const output: string[] = [];
    const result: UninstallResult = { removed: 11, restored: 3 };
    const program = buildProgram({
      readConfig: () => null,
      runUninstall: (input) => {
        received = input;
        return result;
      },
      writeLine: (line) => output.push(line),
    });

    await program.parseAsync(["uninstall", "--yes"], { from: "user" });

    expect(received?.harnesses).toHaveLength(5);
    expect(output).toEqual(["Uninstalled Ferry. Restored 3 paths and removed 11 managed paths."]);
  });

  test("uninstall asks for confirmation and stops when refused", async () => {
    let calls = 0;
    let asked = 0;
    const output: string[] = [];
    const program = buildProgram({
      readConfig: () => null,
      confirmUninstall: async () => {
        asked += 1;
        return false;
      },
      runUninstall: () => {
        calls += 1;
        return { removed: 0, restored: 0 };
      },
      writeLine: (line) => output.push(line),
    });

    await program.parseAsync(["uninstall"], { from: "user" });

    expect(asked).toBe(1);
    expect(calls).toBe(0);
    expect(output).toEqual(["Uninstall cancelled."]);
  });

  test("uninstall --yes skips the confirmation", async () => {
    let asked = 0;
    const program = buildProgram({
      readConfig: () => null,
      confirmUninstall: async () => {
        asked += 1;
        return false;
      },
      runUninstall: () => ({ removed: 0, restored: 0 }),
      writeLine: () => {},
    });

    await program.parseAsync(["uninstall", "--yes"], { from: "user" });

    expect(asked).toBe(0);
  });

  test("passes custom harnesses from the config to uninstall", async () => {
    let received: UninstallInput | undefined;
    const program = buildProgram({
      readConfig: () => ({
        harness: [{ id: "opencode", name: "OpenCode", skillRoot: ".config/opencode/skills" }],
      }),
      runUninstall: (input) => {
        received = input;
        return { removed: 0, restored: 0 };
      },
      writeLine: () => {},
    });

    await program.parseAsync(["uninstall", "--yes"], { from: "user" });

    expect(received?.harnesses.map((harness) => harness.id)).toContain("opencode");
  });

  test("help does not read the config", () => {
    const program = buildProgram({
      readConfig: () => {
        throw new Error("config read");
      },
    });

    expect(program.helpInformation()).toContain("Ferry never copies logins.");
  });

  test("wires an auth provider to the auth command", async () => {
    let received: { provider?: string } | undefined;
    const program = buildProgram({
      readConfig: () => null,
      runAuth: async (input) => {
        received = input;
        return null;
      },
    });

    await program.parseAsync(["auth", "codex"], { from: "user" });

    expect(received).toEqual({ provider: "codex" });
  });

  test("wires an MCP server to the auth command", async () => {
    let received: unknown;
    const program = buildProgram({
      readConfig: () => null,
      runAuth: async (input) => {
        received = input;
        return null;
      },
    });

    await program.parseAsync(["auth", "claude", "--mcp", "linear"], { from: "user" });

    expect(received).toEqual({ provider: "claude", mcp: "linear" });
  });

  test("rejects a credential-file flag before auth execution", async () => {
    let calls = 0;
    const program = buildProgram({
      readConfig: () => null,
      runAuth: async () => {
        calls += 1;
        return null;
      },
    });
    program.exitOverride();
    program.configureOutput({ writeOut: () => {}, writeErr: () => {} });
    const auth = program.commands.find((command) => command.name() === "auth");
    auth?.exitOverride();
    auth?.configureOutput({ writeOut: () => {}, writeErr: () => {} });

    await expect(
      program.parseAsync(["auth", "gh", "--credential-file", "auth.json"], { from: "user" }),
    ).rejects.toThrow("unknown option '--credential-file'");
    expect(calls).toBe(0);
  });

  test("install and auth help define no credential path options", () => {
    const flags = buildProgram().commands
      .filter((command) => command.name() === "install" || command.name() === "auth")
      .flatMap((command) => command.options.map((option) => option.flags))
      .join("\n");

    expect(flags).not.toMatch(/credential|auth-file|token-file|session-file|local-path/i);
  });

  test("the box commands get a Link with the PATH directories of the config tools", async () => {
    const links: unknown[] = [];
    const tools = { bun: { local: "bun --version", install: "curl -fsSL https://bun.sh/install | bash", path: [".bun/bin"] } };
    await buildProgram({
      readConfig: () => ({ tools }),
      runStatus: async (_input, dependencies) => {
        links.push(dependencies?.createLink?.({ destination: "user@box.example" }));
        return EMPTY_REPORT;
      },
      writeLine: () => {},
      createProgress: () => noProgress,
    }).parseAsync(["status"], { from: "user" });
    await buildProgram({
      readConfig: () => ({ tools }),
      runInstall: async (_input, dependencies) => {
        links.push(dependencies?.createLink?.({ destination: "user@box.example" }));
        return null;
      },
      createProgress: () => noProgress,
    }).parseAsync(["install", "--yes"], { from: "user" });

    expect(links).toHaveLength(2);
    for (const link of links) {
      expect(link).toBeInstanceOf(Link);
      expect((link as Link).pathDirs).toEqual([".local/bin", ".pi/agent/bin", ".bun/bin"]);
    }
  });

  test("wires every sync flag to the sync module", async () => {
    let received: SyncInput | undefined;
    const result: SyncResult = {
      dryRun: true,
      published: false,
      plan: {
        operator: "operator-machine",
        gitRemote: "snapshot.git",
        box: "ferry@box",
        localCheckout: "/operator/.ferry/store",
        remoteHome: null,
        remoteCheckout: null,
        message: "chore: ship skills",
        force: true,
        settingsChanges: [],
        mcpServers: [],
        storeUpdates: [],
        paseoProfiles: null,
        pathDirs: [".local/bin"],
        offHarnesses: [],
      },
      boxes: [],
    };
    const program = buildProgram({
      readConfig: () => null,
      runSync: async (input) => {
        received = input;
        return result;
      },
    });

    await program.parseAsync(
      ["sync", "--dry-run", "--force", "-m", "chore: ship skills"],
      { from: "user" },
    );

    expect(received).toEqual({
      dryRun: true,
      force: true,
      message: "chore: ship skills",
      boxes: [],
    });
  });

  test("sync help lists dry-run, force, and message flags", () => {
    const help = buildProgram().commands
      .find((command) => command.name() === "sync")
      ?.helpInformation();

    expect(help).toContain("--dry-run");
    expect(help).toContain("--force");
    expect(help).toContain("-m, --message <message>");
  });

  test("status --json puts the status report in the envelope", async () => {
    let received: StatusCommandInput | undefined;
    const lines: string[] = [];
    const program = buildProgram({
      readConfig: () => null,
      runStatus: async (input) => {
        received = input;
        return EMPTY_REPORT;
      },
      writeLine: (line) => lines.push(line),
      writeError: () => {},
    });

    await program.parseAsync(["status", "--json"], { from: "user" });

    expect(received).toEqual({ selection: [] });
    expect(lines.map((line) => JSON.parse(line))).toEqual([
      { schemaVersion: 1, command: "status", ok: true, result: EMPTY_REPORT, warnings: [], error: null },
    ]);
  });

  test("history --json puts the commits in the envelope", async () => {
    const commits = [{ commit: "a".repeat(40), date: "2026-09-29T10:00:00Z", subject: "chore: update ferry snapshot", paths: ["AGENTS.md"] }];
    const received: unknown[] = [];
    const lines: string[] = [];
    const program = buildProgram({
      readConfig: () => null,
      runHistory: async (input) => {
        received.push(input);
        return commits;
      },
      writeLine: (line) => lines.push(line),
      writeError: () => {},
    });

    await program.parseAsync(["history", "--limit", "5", "--json"], { from: "user" });

    expect(received).toEqual([{ limit: 5 }]);
    expect(JSON.parse(lines[0] as string)).toMatchObject({ command: "history", ok: true, result: { commits } });
  });

  test("wires ferry revert with --dry-run and --no-sync", async () => {
    const received: unknown[] = [];
    const program = buildProgram({
      readConfig: () => null,
      runRevert: async (input) => {
        received.push(input);
        return { dryRun: true, commit: "a".repeat(40), subject: "s", tip: null, paths: [], settings: [], sync: null };
      },
      writeLine: () => {},
    });

    await program.parseAsync(["revert", "abc1234", "--dry-run"], { from: "user" });
    await program.parseAsync(["revert", "abc1234", "--no-sync"], { from: "user" });

    expect(received).toEqual([
      { commit: "abc1234", dryRun: true, sync: true },
      { commit: "abc1234", dryRun: false, sync: false },
    ]);
  });

  test("the program help lists the json flag", () => {
    expect(buildProgram().helpInformation()).toContain("--json");
  });

  test("command help holds the setup facts that the README points to", () => {
    const program = buildProgram();
    const help = (...path: string[]) => {
      let command = program;
      for (const name of path) command = command.commands.find((known) => known.name() === name)!;
      return command.helpInformation();
    };

    expect(help("update")).toContain("NOPASSWD: /usr/bin/true, \\\n    /usr/bin/apt update, /usr/bin/apt install gh -y");
    expect(help("tools")).toContain("[tools.pnpm]");
    expect(help("tools")).toContain("{version} is the only placeholder");
    expect(help("box", "add")).toContain("read-only deploy key");
    expect(help("expose")).toContain('"command": "ferry expose -- bun run dev --port $PASEO_PORT"');
    expect(help("watch", "install")).toContain("dev.ferry.watch.plist");
    expect(help("watch", "install")).toContain("ferry-watch.service");
    expect(help("tools")).toContain('"off" turns off gh or an agent CLI (claude, codex, pi, cursor).');
    expect(help("tools")).toContain("Ferry does not uninstall it from the box.");
    // The command list shows the one-line summary, not the long description.
    expect(program.helpInformation()).not.toContain("paseo.json");
  });

  test("runs watch in the foreground with a shutdown signal", async () => {
    let signal: AbortSignal | undefined;
    const program = buildProgram({
      readConfig: () => null,
      runWatch: async (input) => {
        signal = input.signal;
      },
    });

    await program.parseAsync(["watch"], { from: "user" });

    expect(signal).toBeInstanceOf(AbortSignal);
    expect(signal?.aborted).toBe(false);
  });

  test("passes the watch update switch from the config to watch", async () => {
    let received: boolean | undefined;
    const program = buildProgram({
      readConfig: () => ({ update: { watch: true } }),
      runWatch: async (input) => {
        received = input.dailyUpdate;
      },
    });

    await program.parseAsync(["watch"], { from: "user" });

    expect(received).toBe(true);
  });

  test("wires update --yes --dry-run to the update command", async () => {
    let received: UpdateCommandInput | undefined;
    const program = buildProgram({
      readConfig: () => null,
      runUpdate: async (input) => {
        received = input;
        return null;
      },
    });

    await program.parseAsync(["update", "--yes", "--dry-run"], { from: "user" });

    expect(received).toEqual({ yes: true, dryRun: true, includeIntegrations: true, boxes: [] });
  });

  test("wires ferry adopt to the box adopt module", async () => {
    let received: unknown;
    const program = buildProgram({
      readConfig: () => null,
      runAdoptFromBox: async (input) => {
        received = input;
        return null;
      },
    });

    await program.parseAsync(["adopt", "draft", "--from-box", "a", "--yes"], { from: "user" });

    expect(received).toEqual({ box: "a", name: "draft", yes: true });
  });

  test("wires every move flag to the move module", async () => {
    let received: unknown;
    const program = buildProgram({
      readConfig: () => null,
      runMove: async (input) => {
        received = input;
        return null;
      },
    });

    await program.parseAsync(
      [
        "move",
        "Developer/app",
        "--from-box",
        "a",
        "--to-box",
        "b",
        "--dry-run",
        "--remove",
        "--include-env",
        "--no-sessions",
        "--allow-secrets",
        "--yes",
      ],
      { from: "user" },
    );

    expect(received).toEqual({
      path: "Developer/app",
      fromBox: "a",
      toBox: "b",
      dryRun: true,
      remove: true,
      includeEnv: true,
      sessions: false,
      allowSecrets: true,
      yes: true,
    });
  });

  test("installs the platform watch service", async () => {
    const output: string[] = [];
    let calls = 0;
    const program = buildProgram({
      readConfig: () => null,
      installWatchService: async () => {
        calls += 1;
        return { manager: "systemd", path: "/home/me/.config/systemd/user/ferry-watch.service" };
      },
      writeLine: (line) => output.push(line),
    });

    await program.parseAsync(["watch", "install"], { from: "user" });

    expect(calls).toBe(1);
    expect(output).toEqual([
      "Installed systemd service at /home/me/.config/systemd/user/ferry-watch.service",
    ]);
  });

  test("wires skills add to npx with global copy flags and passes other arguments through", async () => {
    const calls: (readonly string[])[] = [];
    const program = buildProgram({
      readConfig: () => {
        throw new Error("config read");
      },
      runProcess: async (argv) => {
        calls.push(argv);
        return 0;
      },
    });

    await program.parseAsync(
      [
        "skills",
        "add",
        "vercel-labs/agent-skills",
        "--skill",
        "frontend-design",
        "-a",
        "claude-code",
        "-y",
      ],
      { from: "user" },
    );

    expect(calls).toEqual([
      [
        "npx",
        "skills",
        "add",
        "vercel-labs/agent-skills",
        "--skill",
        "frontend-design",
        "-a",
        "claude-code",
        "-y",
        "-g",
        "--copy",
      ],
    ]);
  });

  test("skills add --project omits -g and does not pass --project to npx", async () => {
    const calls: (readonly string[])[] = [];
    const program = buildProgram({
      runProcess: async (argv) => {
        calls.push(argv);
        return 0;
      },
    });

    await program.parseAsync(["skills", "add", "owner/repo", "-y", "--project"], { from: "user" });

    expect(calls).toEqual([["npx", "skills", "add", "owner/repo", "-y", "--copy"]]);
  });

  test("skills add passes arguments after -- through unchanged", async () => {
    const calls: (readonly string[])[] = [];
    const program = buildProgram({
      runProcess: async (argv) => {
        calls.push(argv);
        return 0;
      },
    });

    await program.parseAsync(["skills", "add", "--", "owner/repo", "--project", "--help"], {
      from: "user",
    });

    expect(calls).toEqual([
      ["npx", "skills", "add", "owner/repo", "--project", "--help", "-g", "--copy"],
    ]);
  });

  test("a failed npx skills add sets the child exit code", async () => {
    const errors: string[] = [];
    const exitCodes: number[] = [];

    await runCli(
      ["skills", "add", "owner/repo"],
      { runProcess: async () => 3 },
      {
        renderError: (message) => errors.push(message),
        setExitCode: (code) => exitCodes.push(code),
      },
    );

    expect(errors).toEqual(["npx skills add exited with code 3."]);
    expect(exitCodes).toEqual([3]);
  });

  test("skills add help states that global copies match the snapshot model", () => {
    const help = buildProgram().commands
      .find((command) => command.name() === "skills")
      ?.commands.find((command) => command.name() === "add")
      ?.helpInformation();

    expect(help).toContain("--project");
    expect(help).toContain("Global copy installs match Ferry's snapshot model");
    expect(help).toContain("ferry sync");
  });
});

describe("--box", () => {
  const HOST: PartialOperatorConfig = {
    version: 1,
    publisher: "operator",
    snapshotUrl: "snapshot.git",
    host: { transport: "ssh", destination: "dev@box-a.example" },
    integrations: { paseo: true },
  };
  const BOXES: PartialOperatorConfig = {
    version: 1,
    publisher: "operator",
    snapshotUrl: "snapshot.git",
    defaultBox: "a",
    integrations: { paseo: true },
    tools: { codex: "operator" },
    boxes: [
      { name: "a", host: { transport: "ssh", destination: "dev@box-a.example" } },
      { name: "b", host: { tailscale: "box-b", sshUser: "dev" }, integrations: { paseo: false }, tools: { codex: "latest" } },
    ],
  };

  /** Run one command and return the config that the command reads, or undefined when the CLI passes none. */
  async function readBy(config: PartialOperatorConfig, args: string[]): Promise<PartialOperatorConfig | null | undefined> {
    let read: (() => PartialOperatorConfig | null) | undefined;
    const capture = async (_input: unknown, dependencies?: { readConfig?: (home: string) => PartialOperatorConfig | null }) => {
      read = dependencies?.readConfig ? () => dependencies.readConfig!("/home/user") : undefined;
      return null;
    };
    await buildProgram({
      readConfig: () => config,
      runInstall: capture,
      runAuth: capture,
      runMove: capture,
      runIntegration: capture,
      runUpdate: capture,
      runStatus: async (input, dependencies) => {
        await capture(input, dependencies);
        return EMPTY_REPORT;
      },
      runSync: async (input, dependencies) => {
        await capture(input, dependencies);
        return { dryRun: false, published: false, boxes: [] } as unknown as SyncResult;
      },
      createProgress: () => noProgress,
      writeLine: () => {},
    }).parseAsync(args, { from: "user" });
    return read?.();
  }

  const B_VIEW: PartialOperatorConfig = {
    version: 1,
    publisher: "operator",
    snapshotUrl: "snapshot.git",
    host: { tailscale: "box-b", sshUser: "dev" },
    integrations: { paseo: false },
    tools: { codex: "latest" },
  };

  test("a [host] config without --box reaches each command as before", async () => {
    for (const args of [["install"], ["auth", "codex"], ["move", "project"], ["integrations", "enable", "paseo"], ["sync"], ["status"]]) {
      expect(await readBy(HOST, args)).toBeUndefined();
    }
  });

  test("single-target commands read the config as the named box", async () => {
    for (const args of [["install"], ["auth", "codex"], ["integrations", "enable", "paseo"], ["integrations", "disable", "paseo"]]) {
      expect(await readBy(BOXES, [...args, "--box", "b"])).toEqual(B_VIEW);
    }
  });

  test("--box can come before the command", async () => {
    expect(await readBy(BOXES, ["--box", "b", "install"])).toEqual(B_VIEW);
  });

  test("single-target commands use default_box, then the only box", async () => {
    expect((await readBy(BOXES, ["install"]))?.host).toEqual({ transport: "ssh", destination: "dev@box-a.example" });
    const onlyB = { ...BOXES, defaultBox: undefined, boxes: BOXES.boxes?.slice(1) };
    expect((await readBy(onlyB, ["auth", "codex"]))?.host).toEqual({ tailscale: "box-b", sshUser: "dev" });
  });

  test("single-target commands refuse more than one --box, and no box with no default_box", async () => {
    await expect(readBy(BOXES, ["install", "--box", "a", "--box", "b"])).rejects.toThrow(
      "ferry install changes one box. Give --box once.",
    );
    await expect(readBy({ ...BOXES, defaultBox: undefined }, ["auth", "codex"])).rejects.toThrow("Add --box <name>");
  });

  test("move reads the whole config and refuses --box", async () => {
    expect(await readBy(BOXES, ["move", "project", "--from-box", "a", "--to-box", "b"])).toBeUndefined();
    for (const args of [["move", "project", "--box", "a"], ["--box", "a", "move", "project"]]) {
      await expect(readBy(BOXES, args)).rejects.toThrow(
        "ferry move does not accept --box. Use --from-box <name> or --to-box <name>.",
      );
    }
  });

  test("an unknown or invalid box name is refused", async () => {
    await expect(readBy(BOXES, ["install", "--box", "c"])).rejects.toThrow("unknown box c. Known boxes: a, b.");
    await expect(readBy(HOST, ["install", "--box", "a"])).rejects.toThrow("unknown box a. Known boxes: default.");
    await expect(readBy(BOXES, ["install", "--box", "Box"])).rejects.toThrow("invalid box name Box");
  });

  test("a [host] config accepts --box default", async () => {
    expect((await readBy(HOST, ["install", "--box", "default"]))?.host).toEqual(HOST.host);
  });

  test("sync gets the --box names, and no box means all boxes", async () => {
    const selections: unknown[] = [];
    const program = () =>
      buildProgram({
        readConfig: () => BOXES,
        runSync: async (input, dependencies) => {
          selections.push(input.boxes);
          expect(dependencies?.readConfig).toBeUndefined();
          return { dryRun: false, published: false, boxes: [] } as unknown as SyncResult;
        },
        createProgress: () => noProgress,
        writeLine: () => {},
      });

    await program().parseAsync(["sync"], { from: "user" });
    await program().parseAsync(["sync", "--box", "b", "--dry-run"], { from: "user" });
    await program().parseAsync(["--box", "a", "sync", "--box", "b"], { from: "user" });

    expect(selections).toEqual([[], ["b"], ["a", "b"]]);
  });

  test("status gets the --box names as its selection, and no box means all boxes", async () => {
    const selections: unknown[] = [];
    const program = () =>
      buildProgram({
        readConfig: () => BOXES,
        runStatus: async (input, dependencies) => {
          selections.push(input.selection);
          expect(dependencies?.readConfig).toBeUndefined();
          return EMPTY_REPORT;
        },
        createProgress: () => noProgress,
        writeLine: () => {},
      });

    await program().parseAsync(["status"], { from: "user" });
    await program().parseAsync(["status", "--box", "b"], { from: "user" });
    await program().parseAsync(["--box", "a", "status", "--box", "b", "--json"], { from: "user" });

    expect(selections).toEqual([[], ["b"], ["a", "b"]]);
  });

  test("watch runs with box tables and refuses --box", async () => {
    let runs = 0;
    const program = () => buildProgram({ readConfig: () => BOXES, runWatch: async () => { runs += 1; } });
    await program().parseAsync(["watch"], { from: "user" });
    expect(runs).toBe(1);
    await expect(program().parseAsync(["watch", "--box", "a"], { from: "user" })).rejects.toThrow(
      "--box does not apply to ferry watch.",
    );
  });

  test("commands that do not touch a box refuse --box", async () => {
    const program = buildProgram({ readConfig: () => BOXES, runUninstall: () => ({ restored: 0, removed: 0 }) as UninstallResult });
    await expect(program.parseAsync(["uninstall", "--yes", "--box", "a"], { from: "user" })).rejects.toThrow(
      "--box does not apply to ferry uninstall.",
    );
    await expect(buildProgram({ readConfig: () => BOXES }).parseAsync(["box", "list", "--box", "a"], { from: "user" })).rejects.toThrow(
      "--box does not apply to ferry box list.",
    );
  });

  test("integrations enable with box tables writes the key of the box", async () => {
    let setIntegration: ((id: "paseo", enabled: boolean) => void) | undefined;
    let box: string | undefined;
    await buildProgram({
      readConfig: () => BOXES,
      runIntegration: async (_input, dependencies) => {
        setIntegration = dependencies?.setIntegration;
        box = dependencies?.box;
        return null;
      },
    }).parseAsync(["integrations", "enable", "paseo", "--box", "b"], { from: "user" });
    expect(setIntegration).toBeFunction();
    expect(box).toBe("b");

    let hostSet: unknown = "not set";
    await buildProgram({
      readConfig: () => HOST,
      runIntegration: async (_input, dependencies) => {
        hostSet = dependencies?.setIntegration;
        return null;
      },
    }).parseAsync(["integrations", "enable", "paseo"], { from: "user" });
    expect(hostSet).toBeUndefined();
  });

  test("install and integrations enable and disable get the lock of their box, and update gets the home of the locks", async () => {
    const home = await mkdtemp(join(tmpdir(), "ferry-cli-lock-"));
    type Lock = () => (() => void) | { busy: boolean; reason: string };
    try {
      let current = BOXES;
      const lockOf = async (config: PartialOperatorConfig, args: string[]): Promise<Lock | undefined> => {
        let lockBox: Lock | undefined;
        current = config;
        const capture = async (_input: unknown, dependencies?: { lockBox?: Lock }) => {
          lockBox = dependencies?.lockBox;
          return null;
        };
        await buildProgram({ readConfig: () => current, home: () => home, runInstall: capture, runIntegration: capture })
          .parseAsync(args, { from: "user" });
        return lockBox;
      };

      for (const args of [["install"], ["integrations", "enable", "paseo"], ["integrations", "disable", "paseo"]]) {
        const lockBox = await lockOf(BOXES, [...args, "--box", "b"]);
        const release = lockBox!();
        expect(release).toBeFunction();
        expect(await readdir(join(home, ".ferry"))).toHaveLength(1);
        expect(lockBox!()).toEqual({ busy: true, reason: "box b is busy: a sync or another Ferry command is active for it" });
        (release as () => void)();
        expect(await readdir(join(home, ".ferry"))).toEqual([]);
        // The command reads box b at its start. The lock reads the config of that moment, not the view of the command.
        current = { ...BOXES, boxes: BOXES.boxes!.slice(0, 1) };
        expect(lockBox!()).toEqual({ busy: false, reason: `box b left the config during the ${args[0] === "install" ? "install" : "change"}` });
      }
      // A [host] config has the box default.
      const hostLock = await lockOf(HOST, ["install"]);
      const release = hostLock!();
      expect(release).toBeFunction();
      (release as () => void)();
      // The command reports a config without a box.
      expect(await lockOf({ version: 1, publisher: "operator", snapshotUrl: "snapshot.git" }, ["install"])).toBeUndefined();

      let updateHome: string | undefined;
      await buildProgram({
        readConfig: () => BOXES,
        home: () => home,
        runUpdate: async (_input, dependencies) => {
          updateHome = dependencies?.home;
          return null;
        },
        createProgress: () => noProgress,
      }).parseAsync(["update", "--dry-run"], { from: "user" });
      expect(updateHome).toBe(home);
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });

  test("update gets the whole config and the --box selection", async () => {
    const received: { boxes?: readonly string[]; config?: PartialOperatorConfig | null }[] = [];
    const program = () =>
      buildProgram({
        readConfig: () => BOXES,
        runUpdate: async (input, dependencies) => {
          received.push({ boxes: input.boxes, config: dependencies?.readConfig?.() });
          return null;
        },
        createProgress: () => noProgress,
      });
    await program().parseAsync(["update", "--dry-run"], { from: "user" });
    await program().parseAsync(["update", "--box", "a", "--box", "b"], { from: "user" });
    expect(received).toEqual([
      { boxes: [], config: BOXES },
      { boxes: ["a", "b"], config: BOXES },
    ]);
  });

  test("integrations lists each box, and --box narrows the list", async () => {
    const lines = async (args: string[]) => {
      const output: string[] = [];
      await buildProgram({
        readConfig: () => BOXES,
        integrations: [createPaseo({ platform: "win32" })],
        writeLine: (line) => output.push(line),
      }).parseAsync(args, { from: "user" });
      return output;
    };
    expect((await lines(["integrations"])).filter((line) => line.startsWith("Box "))).toEqual(["Box a", "Box b"]);
    expect(await lines(["integrations"])).toContain("      Enter ssh://dev@box-a.example.");
    expect(await lines(["integrations", "--box", "b"])).toEqual([
      "Box b",
      "  paseo  disabled  Paseo daemon on the box",
      "    Parts: box, operator",
      "    Local app: not found. The box version is not pinned.",
      "    This machine: available",
    ]);
  });

  test("tools gets the --box selection", async () => {
    let boxes: readonly string[] | undefined;
    await buildProgram({
      readConfig: () => BOXES,
      runTools: async (dependencies) => {
        boxes = dependencies.boxes;
        return { tools: [] };
      },
    }).parseAsync(["tools", "--box", "b"], { from: "user" });
    expect(boxes).toEqual(["b"]);
  });

  test("init gets the one --box", async () => {
    let received: InitInput | undefined;
    const program = buildProgram({
      readConfig: () => BOXES,
      runInit: async (input) => {
        received = input;
        return { dryRun: false, leftovers: [], published: false, skill: INIT_SKILL };
      },
      writeLine: () => {},
    });
    await program.parseAsync(["init", "--box", "b"], { from: "user" });
    expect(received?.box).toBe("b");
  });

  test("box list prints the boxes of the config", async () => {
    const lines: string[] = [];
    await buildProgram({ readConfig: () => BOXES, writeLine: (line) => lines.push(line) }).parseAsync(["box", "list"], {
      from: "user",
    });
    expect(lines).toEqual([
      "Box  Transport  Destination        Default",
      "a    ssh        dev@box-a.example  yes",
      "b    tailscale  dev@box-b",
    ]);
  });
});

describe("progress selection", () => {
  const terminal = recordProgress();
  const plain = recordProgress();
  const selection = { createProgress: () => terminal, createPlainProgress: () => plain, readConfig: () => null };

  test("passes the terminal reporter to sync, status, init, install, auth, and update", async () => {
    const received: Record<string, unknown> = {};
    const program = buildProgram({
      ...selection,
      runSync: async (_input, dependencies) => {
        received.sync = dependencies?.progress;
        return { dryRun: true, published: false, boxes: [] } as unknown as SyncResult;
      },
      runStatus: async (_input, dependencies) => {
        received.status = dependencies?.progress;
        return EMPTY_REPORT;
      },
      runInit: async (_input, dependencies) => {
        received.init = dependencies?.progress;
        return { dryRun: false, leftovers: [], published: false, skill: INIT_SKILL };
      },
      runInstall: async (_input, dependencies) => {
        received.install = dependencies?.progress;
        return null;
      },
      runAuth: async (_input, dependencies) => {
        received.auth = dependencies?.progress;
        return null;
      },
      runUpdate: async (_input, dependencies) => {
        received.update = dependencies?.progress;
        return null;
      },
      writeLine: () => {},
    });

    for (const args of [
      ["sync"],
      ["status"],
      ["init", "--host", "box", "--ssh-user", "ferry", "--snapshot-url", "snapshot.git"],
      ["install", "--yes"],
      ["auth", "gh"],
      ["update", "--yes"],
    ]) {
      await program.parseAsync(args, { from: "user" });
    }

    expect(received).toEqual({
      sync: terminal,
      status: terminal,
      init: terminal,
      install: terminal,
      auth: terminal,
      update: terminal,
    });
  });

  test("--json gets the plain reporter, and stdout gets only the envelope", async () => {
    let received: Progress | undefined;
    const lines: string[] = [];
    const program = buildProgram({
      ...selection,
      runStatus: async (_input, dependencies) => {
        received = dependencies?.progress;
        return EMPTY_REPORT;
      },
      writeLine: (line) => lines.push(line),
    });

    await program.parseAsync(["status", "--json"], { from: "user" });

    expect(received).toBe(plain);
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0]!).result).toEqual(EMPTY_REPORT);
  });

  test("on a terminal, prints the table, then the command's lines, then the error, and shows the cursor again", async () => {
    const log: string[] = [];
    const terminal = lineProgress({ write: (text) => log.push(text), columns: 80, color: false, now: () => 0 });

    await runCli(
      ["sync"],
      {
        readConfig: () => null,
        createProgress: () => terminal,
        writeLine: (line) => log.push(`line:${line}`),
        runSync: async (_input, dependencies) => {
          const progress = dependencies!.progress!;
          progress.plan(2);
          progress.start("Reading the portable set");
          progress.done("3 skills");
          dependencies!.writeLine!("Skipped hook: hook-path: ~/.claude/hooks/notify.sh");
          progress.start("Connecting to user@box.example");
          progress.fail("network/host-offline");
          throw new Error("box: failed to resolve home");
        },
      },
      { renderError: (message) => log.push(`error:${message}`), setExitCode: () => {} },
    );

    expect(log.filter((text) => !text.startsWith("\x1b") && !text.startsWith("\r"))).toEqual([
      [
        "Step                            Result     Detail                  Time",
        "Reading the portable set        ✔ done     3 skills                0.0s",
        "Connecting to user@box.example  ✖ failed   network/host-offline    0.0s",
        "",
      ].join("\n"),
      "line:Skipped hook: hook-path: ~/.claude/hooks/notify.sh",
      "error:box: failed to resolve home",
    ]);
    expect(log.lastIndexOf("\r\x1b[2K\x1b[?25h")).toBeGreaterThan(log.lastIndexOf("\x1b[?25l"));
  });

  test("watch always gets the plain reporter", async () => {
    let received: unknown;
    const program = buildProgram({
      ...selection,
      runWatch: async (_input, dependencies) => {
        received = dependencies?.progress;
      },
    });

    await program.parseAsync(["watch"], { from: "user" });

    expect(received).toBe(plain);
  });
});

describe("ferry --version", () => {
  test("prints the development version when the build sets no version", () => {
    const output: string[] = [];
    const program = buildProgram().exitOverride();
    program.configureOutput({ writeOut: (text) => output.push(text), writeErr: () => {} });
    expect(() => program.parse(["--version"], { from: "user" })).toThrow("0.0.0-dev");
    expect(output).toEqual(["0.0.0-dev\n"]);
  });

  test("prints the version that the build sets with --define", async () => {
    const dir = await mkdtemp(join(tmpdir(), "ferry-version-"));
    try {
      const outfile = join(dir, "cli.js");
      const build = Bun.spawnSync([
        process.execPath, "build", "--target=bun", "--define", 'FERRY_VERSION="1.2.3-rc.1"',
        join(import.meta.dir, "..", "src", "cli.ts"), "--outfile", outfile,
      ]);
      expect(build.exitCode).toBe(0);
      const run = Bun.spawnSync([process.execPath, outfile, "--version"]);
      expect(run.stdout.toString()).toBe("1.2.3-rc.1\n");
      expect(run.exitCode).toBe(0);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("ferry tunnel", () => {
  const BOXES: PartialOperatorConfig = {
    version: 1,
    publisher: "operator",
    snapshotUrl: "snapshot.git",
    defaultBox: "a",
    boxes: [
      { name: "a", host: { transport: "ssh", destination: "dev@box-a.example" } },
      { name: "lab", host: { tailscale: "lab", sshUser: "dev" } },
    ],
  };
  const HOST: PartialOperatorConfig = {
    version: 1,
    publisher: "operator",
    snapshotUrl: "snapshot.git",
    host: { transport: "ssh", destination: "dev@box.example" },
  };

  async function tunnelInput(config: PartialOperatorConfig, args: string[]): Promise<unknown> {
    let captured: unknown;
    await buildProgram({
      readConfig: () => config,
      runTunnel: async (input) => {
        captured = input;
      },
      writeLine: () => {},
    }).parseAsync(args, { from: "user" });
    return captured;
  }

  test("passes the ports, --list, and the box of --box, then default_box, then the only box", async () => {
    expect(await tunnelInput(BOXES, ["tunnel", "3000", "5173:4000", "--box", "lab"])).toEqual({
      ports: ["3000", "5173:4000"],
      list: false,
      box: { name: "lab", host: { tailscale: "lab", sshUser: "dev" } },
    });
    expect(await tunnelInput(BOXES, ["tunnel", "--list"])).toEqual({
      ports: [],
      list: true,
      box: { name: "a", host: { transport: "ssh", destination: "dev@box-a.example" } },
    });
    expect(await tunnelInput(HOST, ["tunnel", "3000"])).toEqual({
      ports: ["3000"],
      list: false,
      box: { name: "default", host: { transport: "ssh", destination: "dev@box.example" } },
    });
  });

  test("refuses more than one box and an unknown box, with a message for the tunnel", async () => {
    await expect(tunnelInput(BOXES, ["tunnel", "3000", "--box", "a", "--box", "lab"])).rejects.toThrow(
      "ferry tunnel opens the ports of one box. Give --box once.",
    );
    await expect(tunnelInput({ ...BOXES, defaultBox: undefined }, ["tunnel", "3000"])).rejects.toThrow(
      "ferry tunnel opens the ports of one box, and 2 boxes are configured (a, lab). Add --box <name>, or set default_box in the config.",
    );
    await expect(tunnelInput(BOXES, ["tunnel", "3000", "--box", "c"])).rejects.toThrow("unknown box c.");
  });

  test("passes --follow with the selected box", async () => {
    expect(await tunnelInput(BOXES, ["tunnel", "--follow", "--box", "lab"])).toEqual({
      ports: [],
      list: false,
      follow: true,
      box: { name: "lab", host: { tailscale: "lab", sshUser: "dev" } },
    });
  });

  test("tunnel install and uninstall pass the box of --box, then default_box, and print the service path", async () => {
    const boxes: string[] = [];
    const output: string[] = [];
    const program = () =>
      buildProgram({
        readConfig: () => BOXES,
        installTunnelService: async ({ box }) => {
          boxes.push(`install ${box}`);
          return { manager: "systemd", path: `/home/me/.config/systemd/user/ferry-tunnel-${box}.service` };
        },
        uninstallTunnelService: async ({ box }) => {
          boxes.push(`uninstall ${box}`);
          return { manager: "launchd", path: `/Users/me/Library/LaunchAgents/dev.ferry.tunnel.${box}.plist`, removed: box === "lab" };
        },
        runTunnel: async () => {
          throw new Error("tunnel ran");
        },
        writeLine: (line) => output.push(line),
      });

    await program().parseAsync(["tunnel", "install", "--box", "lab"], { from: "user" });
    await program().parseAsync(["tunnel", "install"], { from: "user" });
    await program().parseAsync(["tunnel", "uninstall", "--box", "lab"], { from: "user" });
    await program().parseAsync(["tunnel", "uninstall"], { from: "user" });

    expect(boxes).toEqual(["install lab", "install a", "uninstall lab", "uninstall a"]);
    expect(output).toEqual([
      "Installed systemd service at /home/me/.config/systemd/user/ferry-tunnel-lab.service",
      "Installed systemd service at /home/me/.config/systemd/user/ferry-tunnel-a.service",
      "Removed launchd service at /Users/me/Library/LaunchAgents/dev.ferry.tunnel.lab.plist",
      "No launchd service at /Users/me/Library/LaunchAgents/dev.ferry.tunnel.a.plist",
    ]);
    await expect(
      buildProgram({ readConfig: () => ({ ...BOXES, defaultBox: undefined }), writeLine: () => {} }).parseAsync(["tunnel", "install"], {
        from: "user",
      }),
    ).rejects.toThrow("Add --box <name>, or set default_box in the config.");
  });

  test("tunnel install --help names the service files and the logs", () => {
    const tunnel = buildProgram().commands.find((command) => command.name() === "tunnel")!;
    const install = tunnel.commands.find((command) => command.name() === "install")!;
    let text = "";
    install.configureOutput({ writeOut: (value) => (text += value) });
    install.outputHelp();
    expect(text).toContain("~/Library/LaunchAgents/dev.ferry.tunnel.<box>.plist");
    expect(text).toContain("~/Library/Logs/ferry-tunnel-<box>.log");
    expect(text).toContain("~/.config/systemd/user/ferry-tunnel-<box>.service");
    expect(text).toContain("journalctl --user -u ferry-tunnel-<box>.service -f");
  });

  test("tunnel --help describes the host form and the child process behavior", () => {
    const tunnel = buildProgram().commands.find((command) => command.name() === "tunnel")!;
    let text = "";
    tunnel.configureOutput({ writeOut: (value) => (text += value) });
    tunnel.outputHelp();
    expect(text).toContain("host:port[:local] for a host that the box can reach");
    expect(text).toContain("db.example:5432:15432  db.example:5432 from the box, local port 15432");
    expect(text).toContain("[fd00::1]:5432         [fd00::1]:5432 from the box, local port 5432");
    expect(text).toContain("SIGTERM closes the tunnel with exit code 0.");
  });
});

describe("ferry expose", () => {
  test("passes the command after -- and --port, and sets the exit code of the command", async () => {
    let received: unknown;
    const codes: number[] = [];
    await buildProgram({
      runExpose: async (input) => {
        received = input;
        return 3;
      },
      setExitCode: (code) => codes.push(code),
      isBoxMode: () => true,
    }).parseAsync(["expose", "--port", "5173", "--", "bun", "run", "dev", "--port", "5173"], { from: "user" });

    expect(received).toEqual({ port: "5173", command: ["bun", "run", "dev", "--port", "5173"] });
    expect(codes).toEqual([3]);
  });
});

describe("ferry menubar", () => {
  const APP = "/Users/me/Applications/Ferry Menu Bar.app";
  const PLIST = "/Users/me/Library/LaunchAgents/dev.ferry.menubar.plist";

  test("install passes --app and prints the app and the agent, uninstall prints the app", async () => {
    const inputs: unknown[] = [];
    const output: string[] = [];
    const program = () =>
      buildProgram({
        installMenuBar: async (input) => {
          inputs.push(input);
          return { app: APP, path: PLIST, version: null, ferryPath: "/Users/me/.bun/bin/ferry" };
        },
        uninstallMenuBar: async () => ({ app: APP, path: PLIST, removed: false }),
        writeLine: (line) => output.push(line),
      });

    await program().parseAsync(["menubar", "install", "--app", "dist/Ferry Menu Bar.app"], { from: "user" });
    await program().parseAsync(["menubar", "install"], { from: "user" });
    await program().parseAsync(["menubar", "uninstall"], { from: "user" });

    expect(inputs).toEqual([{ app: "dist/Ferry Menu Bar.app" }, {}]);
    expect(output).toEqual([
      `Installed ${APP}. It starts at login with ${PLIST}.`,
      `Installed ${APP}. It starts at login with ${PLIST}.`,
      `No menu bar app at ${APP}`,
    ]);
  });

  test("install --help names --app, macos/build.sh, and the agent", () => {
    const install = buildProgram()
      .commands.find((command) => command.name() === "menubar")!
      .commands.find((command) => command.name() === "install")!;
    let text = "";
    install.configureOutput({ writeOut: (value) => (text += value) });
    install.outputHelp();
    expect(text).toContain("--app <path>");
    expect(text).toContain("macos/build.sh");
    expect(text).toContain("~/Library/LaunchAgents/dev.ferry.menubar.plist");
  });
});

describe("box mode", () => {
  test("a box install refuses the operator commands and names the box install", async () => {
    for (const args of [
      ["sync"],
      ["install", "--yes"],
      ["tunnel", "3000"],
      ["status"],
      ["box", "list"],
      ["watch", "install"],
      ["tunnel", "install"],
      ["move", "Developer/app"],
      ["move", "Developer/app", "--from-box", "a"],
      ["move", "Developer/app", "--to-box", "lab"],
      ["move", "Developer/app", "--from-box", "a", "--to-box", "lab"],
    ]) {
      const errors: string[] = [];
      await runCli(
        args,
        {
          isBoxMode: () => true,
          runSync: async () => { throw new Error("sync ran"); },
          runMove: async () => { throw new Error("move ran"); },
        },
        { renderError: (message) => errors.push(message), setExitCode: () => {} },
      );
      expect(errors).toEqual([
        `This is a box install of Ferry (~/.ferry/box.json). Only ferry expose and ferry whoami run here. Run ferry ${args[0] === "box" || args[0] === "watch" || args[1] === "install" ? args.join(" ") : args[0]} on the operator machine.`,
      ]);
    }
  });

  test("a box install runs the hidden ferry scan, which prints the result envelope with --json", async () => {
    const home = await mkdtemp(join(tmpdir(), "ferry-box-scan-"));
    try {
      await mkdir(join(home, ".claude/skills/demo"), { recursive: true });
      await writeFile(join(home, ".claude/skills/demo/SKILL.md"), "# Demo\n");
      await writeFile(join(home, ".claude/skills/demo/.env"), "PASSWORD=box-only-password\n");
      const output: string[] = [];

      await runCli(["--json", "scan"], {
        isBoxMode: () => true,
        home: () => home,
        readStdin: async () => '{"kind":"skill","root":".claude/skills/demo"}',
        writeLine: (line) => output.push(line),
      });

      expect(output).toHaveLength(1);
      const envelope = JSON.parse(output[0]!);
      expect(envelope.ok).toBe(true);
      expect(envelope.command).toBe("scan");
      expect(envelope.result.files.map((file: { path: string }) => file.path)).toEqual(["SKILL.md"]);
      expect(envelope.result.forbidden).toEqual([{ path: ".env", code: "dotenv", reason: "environment file" }]);
      expect(output[0]).not.toContain("box-only-password");
      expect(buildProgram().helpInformation()).not.toContain("scan");
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });

  test("a box install runs the hidden ferry redact, which copies stdin with a mark in the place of each token", async () => {
    const token = "gh" + "p_" + "a".repeat(36);
    const output: string[] = [];

    await runCli(["redact"], {
      isBoxMode: () => true,
      readStdin: async () => `notes/${token}.md\0AGENTS.md\0`,
      writeText: (text) => output.push(text),
    });

    expect(output).toEqual(["notes/[token].md\0AGENTS.md\0"]);

    await runCli(["redact"], {
      isBoxMode: () => true,
      readStdin: async () => "https://alice:box-only-password@example.invalid/app.git?token=box-only-password\n",
      writeText: (text) => output.push(text),
    });

    expect(output[1]).toBe("https://[credential]@example.invalid/app.git?token=[credential]\n");

    await runCli(["redact"], {
      isBoxMode: () => true,
      readStdin: async () =>
        "https://proxy/path?next=https://alice:box-only-password@backend/path\nhttps://proxy/path?next=https%3A%2F%2Falice%3Abox-only-password%40backend%2Fpath\nhttps://host/a,https://alice:box-only-password@host/b\n",
      writeText: (text) => output.push(text),
    });

    expect(output[2]).toBe(
      "https://proxy/path?next=https://[credential]@backend/path\nhttps://proxy/path?next=https%3A%2F%2F[credential]%40backend%2Fpath\nhttps://host/a,https://[credential]@host/b\n",
    );
    expect(buildProgram().helpInformation()).not.toContain("redact");
  });

  test("the error of ferry scan and of ferry redact has a mark in the place of a token, also for an error that Ferry does not expect", async () => {
    const token = "gh" + "p_" + "a".repeat(36);
    const output: string[] = [];
    const failing = () => {
      throw new Error(`EACCES: permission denied, open '/home/user/skill/${token}.txt'`);
    };

    await runCli(["--json", "scan"], { isBoxMode: () => true, readStdin: async () => '{"kind":"skill","root":"skill"}', home: failing, writeLine: (line) => output.push(line) }, { setExitCode: () => {} });
    await runCli(["--json", "redact"], { isBoxMode: () => true, readStdin: async () => failing(), writeLine: (line) => output.push(line) }, { setExitCode: () => {} });

    expect(output).toHaveLength(2);
    for (const line of output) {
      const envelope = JSON.parse(line);
      expect(envelope.ok).toBe(false);
      expect(envelope.error.message).toBe("EACCES: permission denied, open '/home/user/skill/[token].txt'");
      expect(line).not.toContain(token);
    }
  });

  test("the result of ferry scan has a mark in the place of a token that a rule did not take out", async () => {
    const home = await mkdtemp(join(tmpdir(), "ferry-box-scan-"));
    const token = "gh" + "p_" + "a".repeat(36);
    try {
      await mkdir(join(home, "skill"), { recursive: true });
      await writeFile(join(home, "skill/SKILL.md"), "# Demo\n");
      const output: string[] = [];

      // The root of the request is from the operator machine. A root with a token must not come back in a text.
      await runCli(["--json", "scan"], {
        isBoxMode: () => true,
        home: () => home,
        readStdin: async () => JSON.stringify({ kind: "skill", root: `missing-${token}` }),
        writeLine: (line) => output.push(line),
      });

      expect(output).toHaveLength(1);
      expect(output[0]).not.toContain(token);
      expect(JSON.parse(output[0]!).result.forbidden).toEqual([{ path: ".", code: "unreadable", reason: "Ferry cannot read the file" }]);
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });

  test("a box install still prints the version and the help", async () => {
    const out: string[] = [];
    const program = buildProgram({ isBoxMode: () => true }).exitOverride();
    program.configureOutput({ writeOut: (text) => out.push(text), writeErr: () => {} });
    expect(() => program.parse(["--version"], { from: "user" })).toThrow();
    expect(out.join("")).toBe("0.0.0-dev\n");
    await program.parseAsync([], { from: "user" });
    expect(out.join("")).toContain("Usage: ferry");
  });

  test("only a release build with ~/.ferry/box.json is a box install, so a development build and its tests run on a box", async () => {
    const home = await mkdtemp(join(tmpdir(), "ferry-box-mode-"));
    try {
      expect(isBoxMode("0.4.0", home)).toBe(false);
      await mkdir(join(home, ".ferry"));
      await writeFile(join(home, ".ferry/box.json"), '{"mode":"box","version":"0.4.0"}\n');
      expect(isBoxMode("0.4.0", home)).toBe(true);
      expect(isBoxMode("0.0.0-dev", home)).toBe(false);
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });
});

describe("--json", () => {
  const BOXES: PartialOperatorConfig = {
    version: 1,
    publisher: "operator",
    snapshotUrl: "snapshot.git",
    defaultBox: "a",
    boxes: [
      { name: "a", host: { transport: "ssh", destination: "dev@box-a.example" } },
      { name: "b", host: { tailscale: "box-b", sshUser: "dev" } },
    ],
  };
  const HOST: PartialOperatorConfig = {
    version: 1,
    publisher: "operator",
    snapshotUrl: "snapshot.git",
    host: { transport: "ssh", destination: "dev@box-a.example" },
  };

  /** Run the CLI with --json. `stdout` holds the parsed JSON lines, `stderr` the text lines. */
  async function run(args: string[], dependencies: Parameters<typeof runCli>[1] = {}) {
    const stdout: string[] = [];
    const stderr: string[] = [];
    const rendered: string[] = [];
    const exitCodes: number[] = [];
    await runCli(
      ["--json", ...args],
      {
        readConfig: () => BOXES,
        createPlainProgress: () => noProgress,
        ...dependencies,
        writeLine: (line) => stdout.push(line),
        writeError: (line) => stderr.push(line),
      },
      { renderError: (message) => rendered.push(message), setExitCode: (code) => exitCodes.push(code) },
    );
    expect(rendered).toEqual([]);
    return { json: stdout.map((line) => JSON.parse(line)), stderr, exitCodes };
  }

  test("a command prints one envelope with its result, and nothing else on stdout", async () => {
    const result = await run(["box", "list"]);

    expect(result.json).toEqual([
      {
        schemaVersion: 1,
        command: "box list",
        ok: true,
        result: {
          boxes: [
            { name: "a", transport: "ssh", destination: "dev@box-a.example", default: true },
            { name: "b", transport: "tailscale", destination: "dev@box-b", default: false },
          ],
        },
        warnings: [],
        error: null,
      },
    ]);
    expect(result.exitCodes).toEqual([]);
  });

  test("the text lines of a command go to stderr", async () => {
    const result = await run(["auth"]);

    expect(result.json).toHaveLength(1);
    expect(result.json[0].result.providers).toContainEqual({ id: "pi", login: "manual" });
    expect(result.stderr).toContain("pi: manual SSH flow");
  });

  test("a failure prints the envelope with the error code, and exits with 1", async () => {
    const unknown = await run(["integrations", "--box", "c"], { integrations: [] });
    expect(unknown.json).toEqual([
      {
        schemaVersion: 1,
        command: "integrations",
        ok: false,
        result: null,
        warnings: [],
        error: { code: "unknown-box", message: "unknown box c. Known boxes: a, b.", hint: "Run ferry box list for the box names." },
      },
    ]);
    expect(unknown.exitCodes).toEqual([1]);

    expect((await run(["box", "list"], { readConfig: () => null })).json[0].error.code).toBe("config-missing");
    expect((await run(["install", "--box", "a", "--box", "b"])).json[0].error.code).toBe("usage");
  });

  test("a usage error from the option parser is an envelope with the code usage", async () => {
    const result = await run(["sync", "--bogus"]);

    expect(result.json).toEqual([
      expect.objectContaining({ command: "sync", ok: false, error: expect.objectContaining({ code: "usage" }) }),
    ]);
    expect(result.exitCodes).toEqual([1]);
  });

  test("sync puts the plan of each box in result, and its warnings in the envelope", async () => {
    const result = await run(["sync", "--dry-run"], {
      runSync: async (input, dependencies) => {
        dependencies?.warn?.("Box MCP: could not declare claude MCP server linear");
        const plan = { box: "dev@box-a.example" } as SyncResult["plan"];
        return { dryRun: input.dryRun === true, published: false, plan, boxes: [{ name: "a", plan }] };
      },
    });

    expect(result.json[0]).toMatchObject({
      ok: true,
      result: { dryRun: true, published: false, boxes: [{ name: "a", plan: { box: "dev@box-a.example" }, applyPlan: null, discarded: [] }] },
      warnings: ["Box MCP: could not declare claude MCP server linear"],
    });
  });

  test("sync names a skipped box with the reason in result, and the box is not a failure", async () => {
    const plan = { box: "dev@box-a.example" } as SyncResult["plan"];
    const result = await run(["sync"], {
      runSync: async (_input, dependencies) => {
        dependencies?.warn?.("[b] Warning: box b left the config during the sync. Ferry did not connect to it.");
        return {
          dryRun: false,
          published: true,
          plan,
          boxes: [
            { name: "a", plan, applyPlan: { checkout: "/c", targetHome: "/h", actions: [], unmanaged: [], managed: { instructionFiles: [], skillRoots: [], roots: [] } }, discarded: [] },
            { name: "b", plan, skipped: "box b left the config during the sync" },
          ],
        };
      },
    });

    expect(result.exitCodes).toEqual([]);
    expect(result.json[0]).toMatchObject({
      command: "sync",
      ok: true,
      result: {
        boxes: [
          { name: "a", ok: true, applyPlan: { actions: [] } },
          { name: "b", ok: true, skipped: "box b left the config during the sync", applyPlan: null, discarded: [] },
        ],
      },
      warnings: ["[b] Warning: box b left the config during the sync. Ferry did not connect to it."],
    });
    expect("skipped" in result.json[0].result.boxes[0]).toBe(false);
  });

  test("a failed multi-box sync keeps the outcome of each box in result", async () => {
    const plan = { box: "dev@box-a.example" } as SyncResult["plan"];
    const offline = new SyncError("link-failure", "box", "failed to resolve home on box-b", {
      cause: new FerryError("box-offline", "network/host-offline: box-b is offline"),
    });
    const result = await run(["sync"], {
      runSync: async () => {
        throw new BoxesSyncError(
          [
            { name: "a", plan, applyPlan: { checkout: "/c", targetHome: "/h", actions: [], unmanaged: [], managed: { instructionFiles: [], skillRoots: [], roots: [] } }, discarded: [] },
            { name: "b", plan, failure: { step: "Connecting to dev@box-b", error: offline } },
          ],
          true,
        );
      },
    });

    expect(result.exitCodes).toEqual([1]);
    expect(result.json[0]).toMatchObject({
      command: "sync",
      ok: false,
      error: { code: "sync-failed", message: expect.stringContaining("[b] Connecting to dev@box-b") },
      result: {
        dryRun: false,
        published: true,
        boxes: [
          { name: "a", ok: true, applyPlan: { actions: [] }, discarded: [] },
          {
            name: "b",
            ok: false,
            step: "Connecting to dev@box-b",
            error: { code: "box-offline", message: offline.message },
            applyPlan: null,
          },
        ],
      },
    });
    expect("error" in result.json[0].result.boxes[0]).toBe(false);
  });

  test("a failed update keeps the outcome of each box in result", async () => {
    const outcome = {
      dryRun: false,
      boxes: [{ name: "a", ok: false, error: { code: "box-offline", message: "network/host-offline: off", hint: null }, offline: "off", plan: [], integrations: [] }],
      operator: [],
      updated: [],
      failed: ["[a] box offline"],
    } satisfies UpdateCommandResult;
    const result = await run(["update", "--yes"], {
      runUpdate: async () => {
        throw new UpdateError("1 of 1 updates failed: [a] box offline", outcome);
      },
    });

    expect(result.json[0]).toMatchObject({ ok: false, result: outcome, error: { code: "update-failed" } });
  });

  test("a command that stays running prints its events, and an error event on failure", async () => {
    const watch = await run(["watch"], {
      runWatch: async (_input, dependencies) => {
        dependencies?.emit?.({ type: "watch-started", boxes: ["a"] });
      },
    });
    expect(watch.json).toEqual([{ type: "watch-started", boxes: ["a"] }]);

    const tunnel = await run(["tunnel", "3000"], { readConfig: () => null });
    expect(tunnel.json).toEqual([
      { type: "error", code: "config-missing", message: "Ferry config has no complete box. Run ferry init.", hint: "Run ferry init." },
    ]);
    expect(tunnel.exitCodes).toEqual([1]);

    const list = await run(["tunnel", "--list"], { readConfig: () => null });
    expect(list.json[0]).toMatchObject({ command: "tunnel", ok: false, error: { code: "config-missing" } });
  });

  test("tunnel install and uninstall print one envelope", async () => {
    const install = await run(["tunnel", "install", "--box", "b"], {
      installTunnelService: async () => ({ manager: "launchd", path: "/Users/me/Library/LaunchAgents/dev.ferry.tunnel.b.plist" }),
    });
    expect(install.json).toEqual([
      {
        schemaVersion: 1,
        command: "tunnel install",
        ok: true,
        result: { manager: "launchd", path: "/Users/me/Library/LaunchAgents/dev.ferry.tunnel.b.plist" },
        warnings: [],
        error: null,
      },
    ]);

    const uninstall = await run(["tunnel", "uninstall"], {
      uninstallTunnelService: async () => ({ manager: "systemd", path: "/home/me/.config/systemd/user/ferry-tunnel-a.service", removed: false }),
    });
    expect(uninstall.json[0]).toMatchObject({
      command: "tunnel uninstall",
      ok: true,
      result: { manager: "systemd", path: "/home/me/.config/systemd/user/ferry-tunnel-a.service", removed: false },
    });

    const failed = await run(["tunnel", "install"], {
      installTunnelService: async () => {
        throw new Error("launchctl failed: denied");
      },
    });
    expect(failed.json).toEqual([
      expect.objectContaining({ command: "tunnel install", ok: false, error: expect.objectContaining({ code: "failed", message: "launchctl failed: denied" }) }),
    ]);
    expect(failed.exitCodes).toEqual([1]);
  });

  test("menubar install and uninstall print one envelope", async () => {
    const install = await run(["menubar", "install"], {
      installMenuBar: async () => ({
        app: "/Users/me/Applications/Ferry Menu Bar.app",
        path: "/Users/me/Library/LaunchAgents/dev.ferry.menubar.plist",
        version: "1.2.0",
        ferryPath: "/Users/me/.local/bin/ferry",
      }),
    });
    expect(install.json).toEqual([
      {
        schemaVersion: 1,
        command: "menubar install",
        ok: true,
        result: {
          app: "/Users/me/Applications/Ferry Menu Bar.app",
          path: "/Users/me/Library/LaunchAgents/dev.ferry.menubar.plist",
          version: "1.2.0",
          ferryPath: "/Users/me/.local/bin/ferry",
        },
        warnings: [],
        error: null,
      },
    ]);

    const uninstall = await run(["menubar", "uninstall"], {
      uninstallMenuBar: async () => ({
        app: "/Users/me/Applications/Ferry Menu Bar.app",
        path: "/Users/me/Library/LaunchAgents/dev.ferry.menubar.plist",
        removed: true,
      }),
    });
    expect(uninstall.json[0]).toMatchObject({ command: "menubar uninstall", ok: true, result: { removed: true } });

    const failed = await run(["menubar", "install"], {
      installMenuBar: async () => {
        throw new FerryError("usage", "ferry menubar install runs only on macOS. This machine runs linux.");
      },
    });
    expect(failed.json).toEqual([
      expect.objectContaining({ command: "menubar install", ok: false, error: expect.objectContaining({ code: "usage" }) }),
    ]);
    expect(failed.exitCodes).toEqual([1]);
  });

  test("tunnel --list prints the listeners in the envelope", async () => {
    const result = await run(["tunnel", "--list"], {
      runTunnel: async () => [{ port: 3000, address: "127.0.0.1", process: "node" }],
    });

    expect(result.json[0].result).toEqual({ box: "a", listeners: [{ port: 3000, address: "127.0.0.1", process: "node" }] });
  });

  describe("asks nothing", () => {
    const refused = { code: "confirmation-required", hint: "Add --yes to confirm." };

    test("uninstall fails without --yes", async () => {
      let asked = 0;
      const result = await run(["uninstall"], {
        confirmUninstall: async () => {
          asked += 1;
          return true;
        },
        runUninstall: () => {
          throw new Error("uninstall ran");
        },
      });

      expect(asked).toBe(0);
      expect(result.json[0].error).toMatchObject(refused);
      expect(result.exitCodes).toEqual([1]);
    });

    test("install, update, and integrations enable|disable fail at the confirmation", async () => {
      const confirm = async (dependencies?: { confirm?: (message: string) => Promise<unknown> }) => {
        await dependencies?.confirm?.("Run?");
        return null;
      };
      for (const args of [["install"], ["update"], ["integrations", "enable", "paseo"], ["integrations", "disable", "paseo"]]) {
        const result = await run(args, {
          runInstall: (_input, dependencies) => confirm(dependencies),
          runUpdate: (_input, dependencies) => confirm(dependencies),
          runIntegration: (_input, dependencies) => confirm(dependencies),
        });
        expect(result.json[0].error).toMatchObject(refused);
      }
    });

    test("box add fails before it changes a [host] config", async () => {
      const result = await run(["box", "add", "b", "--ssh-destination", "dev@box-b.example"], {
        readConfig: () => HOST,
        confirm: async () => true,
      });

      expect(result.json[0]).toMatchObject({ command: "box add", ok: false, error: refused });
    });

    test("box remove --uninstall fails at the box name question, and --dry-run needs --uninstall", async () => {
      const inputs: unknown[] = [];
      const runBoxUninstall = async (input: unknown, dependencies: { confirmName: (message: string) => Promise<unknown> }) => {
        inputs.push(input);
        await dependencies.confirmName("Type b to remove Ferry from the box.");
        return null;
      };
      const confirmName = async () => "b";

      const result = await run(["box", "remove", "b", "--uninstall"], { runBoxUninstall, confirmName });
      const dryRun = await run(["box", "remove", "b", "--dry-run"], { runBoxUninstall, confirmName });

      expect(inputs).toEqual([{ name: "b", yes: false, dryRun: false }]);
      expect(result.json[0]).toMatchObject({
        command: "box remove",
        ok: false,
        error: { ...refused, message: "Type b to remove Ferry from the box. Ferry does not ask with --json." },
      });
      expect(dryRun.json[0]).toMatchObject({ command: "box remove", ok: false, error: { code: "usage", message: "--dry-run needs --uninstall." } });
    });

    test("init gets no prompt", async () => {
      let received: InitDependencies | undefined;
      await run(["init"], {
        readConfig: () => HOST,
        prompt: async () => ({}),
        runInit: async (_input, dependencies) => {
          received = dependencies;
          return { dryRun: false, leftovers: [], published: true, skill: INIT_SKILL };
        },
      });
      expect(received).toBeDefined();
      expect(received?.prompt).toBeUndefined();
    });

    test("init without the values fails with missing-values", async () => {
      const result = await run(["init"], {
        runInit: async () => {
          throw new InitRefusal("missing-values", "missing init values: host, sshUser, snapshotUrl");
        },
      });

      expect(result.json[0].error).toEqual({
        code: "missing-values",
        message: "missing init values: host, sshUser, snapshotUrl",
        hint: "Give the missing values as options.",
      });
    });

    test("move carries no file with secrets and adopt adopts nothing without --yes, and auth reads the login code from stdin", async () => {
      let interactive: boolean | undefined;
      await run(["move", "Developer/app"], {
        runMove: async (_input, dependencies) => {
          interactive = dependencies?.interactive;
          return null;
        },
      });
      expect(interactive).toBe(false);

      let adoptInteractive: boolean | undefined;
      await run(["adopt", "draft", "--from-box", "a"], {
        runAdoptFromBox: async (_input, dependencies) => {
          adoptInteractive = dependencies?.interactive;
          return null;
        },
      });
      expect(adoptInteractive).toBe(false);

      let readLoginCode: unknown;
      await run(["auth", "claude"], {
        runAuth: async (_input, dependencies) => {
          readLoginCode = dependencies?.readLoginCode;
          return null;
        },
      });
      expect(readLoginCode).toBeFunction();
    });
  });

  test("the help gives the contract, and the help of each command gives its result", () => {
    const program = buildProgram();
    const help = (path: string[]) => {
      let command = program;
      for (const name of path) command = command.commands.find((known) => known.name() === name)!;
      let text = "";
      command.configureOutput({ writeOut: (value) => (text += value) });
      command.outputHelp();
      return text;
    };
    expect(help([])).toContain("confirmation-required");
    expect(help([])).toContain("forward-opened");
    for (const path of [
      "init", "box list", "box add", "box remove", "box default", "install", "sync", "watch", "watch install", "status",
      "auth", "update", "tools", "skills add", "move", "tunnel", "tunnel install", "tunnel uninstall", "expose", "integrations", "integrations enable",
      "integrations disable", "uninstall", "menubar install", "menubar uninstall",
    ]) {
      expect(help(path.split(" "))).toContain("With --json: ");
    }
  });

  describe("SSH host keys of the snapshot host", () => {
    const key: SnapshotHostKeyApproval = { host: "github.com", keys: [{ algorithm: "ssh-ed25519", fingerprint: "SHA256:abc" }] };
    const trusted = "Trusting the SSH host keys for github.com on the box (--accept-host-keys): ssh-ed25519 SHA256:abc";
    /** init and box add, each with a fake run that asks for the approval of `key`. */
    const commands = {
      init: {
        args: ["init"],
        runInit: async (_input: InitInput, dependencies?: InitDependencies): Promise<InitResult> => {
          if ((await dependencies?.approveHostKeys?.(key)) !== true) throw new Error("not trusted");
          return { dryRun: false, leftovers: [], published: true, skill: INIT_SKILL };
        },
      },
      "box add": {
        args: ["box", "add", "c", "--ssh-destination", "dev@box-c.example"],
        runBoxAdd: async (_input: unknown, dependencies: { approveHostKeys?: (request: SnapshotHostKeyApproval) => Promise<boolean> }) => {
          if ((await dependencies.approveHostKeys?.(key)) !== true) throw new Error("not trusted");
          return { name: "c", transport: "ssh" as const, destination: "dev@box-c.example", gitAuth: "agent" as const, migrated: false, instructionFile: "/home/user/.ferry/boxes/c/AGENTS.md" };
        },
      },
    };

    for (const [name, command] of Object.entries(commands)) {
      const dependencies = { readConfig: () => BOXES, ...("runInit" in command ? { runInit: command.runInit } : { runBoxAdd: command.runBoxAdd }) };

      test(`${name} without --accept-host-keys asks on a terminal`, async () => {
        const asked: SnapshotHostKeyApproval[] = [];
        const lines: string[] = [];
        await buildProgram({
          ...dependencies,
          approveHostKeys: async (request) => {
            asked.push(request);
            return true;
          },
          createProgress: () => noProgress,
          writeLine: (line) => lines.push(line),
        }).parseAsync(command.args, { from: "user" });

        expect(asked).toEqual([key]);
        expect(lines).not.toContain(trusted);
      });

      test(`${name} --accept-host-keys trusts the keys without a prompt and logs the fingerprints`, async () => {
        const lines: string[] = [];
        await buildProgram({
          ...dependencies,
          approveHostKeys: async () => {
            throw new Error("prompt");
          },
          createProgress: () => noProgress,
          writeLine: (line) => lines.push(line),
        }).parseAsync([...command.args, "--accept-host-keys"], { from: "user" });

        expect(lines).toContain(trusted);
      });

      test(`${name} --json without --accept-host-keys fails with the keys as data, also with --yes`, async () => {
        for (const extra of name === "box add" ? [[], ["--yes"]] : [[]]) {
          const result = await run([...command.args, ...extra], {
            ...dependencies,
            approveHostKeys: async () => {
              throw new Error("prompt");
            },
          });

          expect(result.json[0]).toMatchObject({ command: name, ok: false });
          expect(result.json[0].error).toEqual({
            code: "confirmation-required",
            message: "Trust these SSH host keys for github.com on the box: ssh-ed25519 SHA256:abc? Ferry does not ask with --json.",
            hint: "Show the fingerprints to the operator. When the operator accepts them, add --accept-host-keys.",
            details: { hostKeys: [{ host: "github.com", type: "ssh-ed25519", fingerprint: "SHA256:abc" }] },
          });
        }
      });

      test(`${name} --json --accept-host-keys trusts the keys and logs the fingerprints on stderr`, async () => {
        const result = await run([...command.args, "--accept-host-keys"], dependencies);

        expect(result.json[0]).toMatchObject({ command: name, ok: true });
        expect(result.stderr).toContain(trusted);
      });
    }

    test("init has no --yes", async () => {
      const result = await run(["init", "--yes"], { runInit: commands.init.runInit });
      expect(result.json[0].error.code).toBe("usage");
    });
  });

  test('ferry auth of a tool that is off for the box fails with the code refused, and a box can turn it on again', async () => {
    const off: PartialOperatorConfig = {
      ...BOXES,
      tools: { codex: "off" },
      boxes: [BOXES.boxes![0]!, { ...BOXES.boxes![1]!, tools: { codex: "latest" } }],
    };

    const refused = await run(["auth", "codex"], { readConfig: () => off });

    expect(refused.json).toHaveLength(1);
    expect(refused.json[0]).toMatchObject({ command: "auth", ok: false, error: { code: "refused" } });
    expect(refused.json[0].error.message).toContain("The codex tool is off for this box");
    expect(refused.exitCodes).toEqual([1]);

    let started = "";
    const onBox = await run(["auth", "codex", "--box", "b"], {
      readConfig: () => off,
      runAuth: async (input, dependencies) => {
        started = `${input.provider} ${JSON.stringify(dependencies?.readConfig?.()?.tools)}`;
        return { kind: "already-done", provider: "codex" };
      },
    });
    expect(onBox.json[0]).toMatchObject({ command: "auth", ok: true });
    expect(started).toBe('codex {"codex":"latest"}');
  });

  test("ferry tools lists the off policy of [tools] and of each box", async () => {
    const off: PartialOperatorConfig = { ...BOXES, tools: { pi: "off" }, boxes: [BOXES.boxes![0]!, { ...BOXES.boxes![1]!, tools: { pi: "latest" } }] };

    const result = await run(["tools"], { readConfig: () => off });

    const pi = result.json[0].result.tools.find((tool: { id: string }) => tool.id === "pi");
    expect(pi.policy).toEqual({ policy: "off", default: false });
    expect(pi.boxes).toEqual([
      { name: "a", policy: "off", default: false },
      { name: "b", policy: "latest", default: false },
    ]);
  });

  test("without --json, the confirmations and prompts stay", async () => {
    let received: InitDependencies | undefined;
    await buildProgram({
      readConfig: () => HOST,
      runInit: async (_input, dependencies) => {
        received = dependencies;
        return { dryRun: false, leftovers: [], published: true, skill: INIT_SKILL };
      },
      prompt: async () => ({}),
      writeLine: () => {},
    }).parseAsync(["init"], { from: "user" });

    expect(received?.prompt).toBeFunction();
  });
});
