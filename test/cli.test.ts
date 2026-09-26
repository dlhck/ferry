import { describe, expect, test } from "bun:test";
import { buildProgram, runCli } from "../src/cli.ts";
import type {
  InitDependencies,
  InitInput,
  InitResult,
  SnapshotHostKeyApproval,
} from "../src/init.ts";
import type { SyncInput, SyncResult } from "../src/sync.ts";
import type { UninstallInput, UninstallResult } from "../src/uninstall.ts";

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
      address: "100.64.0.9",
      paseoPort: 6767,
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
    expect(output).toContain("Paseo: 100.64.0.9:6767");
  });

  test("wires an explicit SSH destination to init", async () => {
    let received: InitInput | undefined;
    const program = buildProgram({
      readConfig: () => null,
      runInit: async (input) => {
        received = input;
        return {
          dryRun: false,
          address: "ubuntu@orb",
          paseoPort: 6767,
          leftovers: [],
          published: false,
        };
      },
      writeLine: () => {},
    });

    await program.parseAsync(
      ["init", "--ssh-destination", "ubuntu@orb", "--snapshot-url", "snapshot.git"],
      { from: "user" },
    );

    expect(received).toMatchObject({
      sshDestination: "ubuntu@orb",
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
          address: "ubuntu@orb",
          paseoPort: 6767,
          leftovers: [],
          published: false,
        };
      },
      approveHostKeys: async (value) => value === request,
      writeLine: () => {},
    });

    await program.parseAsync(
      ["init", "--ssh-destination", "ubuntu@orb", "--snapshot-url", "snapshot.git"],
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
});
