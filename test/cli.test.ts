import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildProgram, runCli } from "../src/cli.ts";
import type {
  InitDependencies,
  InitInput,
  InitResult,
  SnapshotHostKeyApproval,
} from "../src/init.ts";
import { createPaseo } from "../src/integrations/paseo.ts";
import { denyRules } from "../src/manifest.ts";
import { BUILTIN_TOOLS } from "../src/registry/builtin.ts";
import { Link } from "../src/link.ts";
import type { PartialOperatorConfig } from "../src/config.ts";
import type { SyncInput, SyncResult } from "../src/sync.ts";
import type { UninstallInput, UninstallResult } from "../src/uninstall.ts";
import { lineProgress, noProgress, type Progress } from "../src/progress.ts";
import { recordProgress } from "./fake-progress.ts";

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
    expect(output).toEqual(["Snapshot seed published."]);
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
      "  Local app: not found. The box version is not pinned.",
      "  Connect to the box:",
      "    Open Paseo Desktop.",
      "    Open Settings → Add host → Remote SSH.",
      "    Enter ssh://ploi@box.",
    ]);
  });

  test("wires ferry tools to the registry tools of the config", async () => {
    const received: string[][] = [];
    const program = buildProgram({
      readConfig: () => ({ tools: { bun: "1.4.2" } }),
      runTools: async (dependencies) => {
        received.push(dependencies.tools.map((tool) => tool.id));
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
      runStatus: async (_input, dependencies) => links.push(dependencies?.createLink?.({ destination: "user@box.example" })),
      writeLine: () => {},
      createProgress: () => noProgress,
    }).parseAsync(["status"], { from: "user" });
    await buildProgram({
      readConfig: () => ({ tools }),
      runInstall: async (_input, dependencies) => {
        links.push(dependencies?.createLink?.({ destination: "user@box.example" }));
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
      },
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

  test("wires status --json to the status command", async () => {
    let received: { json: boolean } | undefined;
    const program = buildProgram({
      readConfig: () => null,
      runStatus: async (input) => {
        received = input;
      },
    });

    await program.parseAsync(["status", "--json"], { from: "user" });

    expect(received).toEqual({ json: true });
  });

  test("status help lists the json flag", () => {
    const help = buildProgram().commands
      .find((command) => command.name() === "status")
      ?.helpInformation();

    expect(help).toContain("--json");
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
    let received: { yes: boolean; dryRun: boolean; includeIntegrations?: boolean } | undefined;
    const program = buildProgram({
      readConfig: () => null,
      runUpdate: async (input) => {
        received = input;
      },
    });

    await program.parseAsync(["update", "--yes", "--dry-run"], { from: "user" });

    expect(received).toEqual({ yes: true, dryRun: true, includeIntegrations: true });
  });

  test("wires every move flag to the move module", async () => {
    let received: unknown;
    const program = buildProgram({
      readConfig: () => null,
      runMove: async (input) => {
        received = input;
      },
    });

    await program.parseAsync(
      ["move", "Developer/app", "--from-box", "--dry-run", "--remove", "--include-env", "--allow-secrets", "--yes"],
      { from: "user" },
    );

    expect(received).toEqual({
      path: "Developer/app",
      fromBox: true,
      dryRun: true,
      remove: true,
      includeEnv: true,
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
    };
    await buildProgram({
      readConfig: () => config,
      runInstall: capture,
      runAuth: capture,
      runMove: capture,
      runIntegration: capture,
      runUpdate: capture,
      runStatus: capture,
      runSync: async (input, dependencies) => {
        await capture(input, dependencies);
        return { dryRun: false, published: false } as unknown as SyncResult;
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
    for (const args of [["install"], ["auth", "codex"], ["move", "project"], ["integrations", "enable", "paseo"], ["sync"], ["status"], ["update"]]) {
      expect(await readBy(HOST, args)).toBeUndefined();
    }
  });

  test("single-target commands read the config as the named box", async () => {
    for (const args of [["install"], ["auth", "codex"], ["move", "project"], ["integrations", "enable", "paseo"], ["integrations", "disable", "paseo"]]) {
      expect(await readBy(BOXES, [...args, "--box", "b"])).toEqual(B_VIEW);
    }
  });

  test("--box can come before the command", async () => {
    expect(await readBy(BOXES, ["--box", "b", "install"])).toEqual(B_VIEW);
  });

  test("single-target commands use default_box, then the only box", async () => {
    expect((await readBy(BOXES, ["install"]))?.host).toEqual({ transport: "ssh", destination: "dev@box-a.example" });
    const onlyB = { ...BOXES, defaultBox: undefined, boxes: BOXES.boxes?.slice(1) };
    expect((await readBy(onlyB, ["move", "project"]))?.host).toEqual({ tailscale: "box-b", sshUser: "dev" });
  });

  test("single-target commands refuse more than one --box, and no box with no default_box", async () => {
    await expect(readBy(BOXES, ["install", "--box", "a", "--box", "b"])).rejects.toThrow(
      "ferry install changes one box. Give --box once.",
    );
    await expect(readBy({ ...BOXES, defaultBox: undefined }, ["auth", "codex"])).rejects.toThrow("Add --box <name>");
  });

  test("an unknown or invalid box name is refused", async () => {
    await expect(readBy(BOXES, ["install", "--box", "c"])).rejects.toThrow("unknown box c. Known boxes: a, b.");
    await expect(readBy(HOST, ["sync", "--box", "a"])).rejects.toThrow("unknown box a. Known boxes: default.");
    await expect(readBy(BOXES, ["install", "--box", "Box"])).rejects.toThrow("invalid box name Box");
  });

  test("a [host] config accepts --box default", async () => {
    expect((await readBy(HOST, ["install", "--box", "default"]))?.host).toEqual(HOST.host);
  });

  test("multi-target commands refuse more than one box", async () => {
    for (const command of ["sync", "status", "update"]) {
      await expect(readBy(BOXES, [command])).rejects.toThrow(
        `multi-box ${command} is not available yet. Select one box with --box <name>.`,
      );
      await expect(readBy(BOXES, [command, "--box", "a", "--box", "b"])).rejects.toThrow(
        `multi-box ${command} is not available yet.`,
      );
    }
  });

  test("multi-target commands read the config as the one selected box", async () => {
    for (const command of ["sync", "status", "update"]) {
      expect(await readBy(BOXES, [command, "--box", "b"])).toEqual(B_VIEW);
    }
  });

  test("watch refuses box tables and refuses --box", async () => {
    const program = (config = BOXES) => buildProgram({ readConfig: () => config, runWatch: async () => {} });
    await expect(program().parseAsync(["watch"], { from: "user" })).rejects.toThrow(
      "multi-box watch is not available yet.",
    );
    await expect(
      program({ ...BOXES, defaultBox: undefined, boxes: BOXES.boxes?.slice(0, 1) }).parseAsync(["watch"], { from: "user" }),
    ).rejects.toThrow("ferry watch works only with a [host] config.");
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
    await buildProgram({
      readConfig: () => BOXES,
      runIntegration: async (_input, dependencies) => {
        setIntegration = dependencies?.setIntegration;
      },
    }).parseAsync(["integrations", "enable", "paseo", "--box", "b"], { from: "user" });
    expect(setIntegration).toBeFunction();

    let hostSet: unknown = "not set";
    await buildProgram({
      readConfig: () => HOST,
      runIntegration: async (_input, dependencies) => {
        hostSet = dependencies?.setIntegration;
      },
    }).parseAsync(["integrations", "enable", "paseo"], { from: "user" });
    expect(hostSet).toBeUndefined();
  });

  test("init gets the one --box", async () => {
    let received: InitInput | undefined;
    const program = buildProgram({
      readConfig: () => BOXES,
      runInit: async (input) => {
        received = input;
        return { dryRun: false, leftovers: [], published: false };
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
        return { dryRun: true, published: false } as unknown as SyncResult;
      },
      runStatus: async (_input, dependencies) => {
        received.status = dependencies?.progress;
      },
      runInit: async (_input, dependencies) => {
        received.init = dependencies?.progress;
        return { dryRun: false, leftovers: [], published: false };
      },
      runInstall: async (_input, dependencies) => {
        received.install = dependencies?.progress;
      },
      runAuth: async (_input, dependencies) => {
        received.auth = dependencies?.progress;
      },
      runUpdate: async (_input, dependencies) => {
        received.update = dependencies?.progress;
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

  test("status --json gets no progress and prints the same JSON as before", async () => {
    let received: Progress | undefined;
    const lines: string[] = [];
    const report = { schemaVersion: 1, link: { online: false } };
    const program = buildProgram({
      ...selection,
      runStatus: async (_input, dependencies) => {
        received = dependencies?.progress;
        dependencies?.writeLine?.(JSON.stringify(report));
        return report;
      },
      writeLine: (line) => lines.push(line),
    });

    await program.parseAsync(["status", "--json"], { from: "user" });

    expect(received).toBe(noProgress);
    expect(lines).toEqual(['{"schemaVersion":1,"link":{"online":false}}']);
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
