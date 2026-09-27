import { describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  lstatSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ApplyError } from "../src/apply.ts";
import type { OperatorConfig } from "../src/config.ts";
import { denyRules, type Seed } from "../src/manifest.ts";
import { loadRegistry, type RegistryConfig } from "../src/registry/load.ts";
import type { LinkResult } from "../src/link.ts";
import type { HarnessDescriptor } from "../src/registry/types.ts";
import {
  remoteUpdateCommand,
  runSync,
  SyncError,
  type SyncDependencies,
  type SyncPlan,
} from "../src/sync.ts";
import { noProgress, type Progress } from "../src/progress.ts";
import { fakeTerminal } from "./fake-progress.ts";

const config: OperatorConfig = {
  version: 1,
  publisher: "operator-machine",
  snapshotUrl: "git@example.test:operator/ferry-store.git",
  host: { tailscale: "box", sshUser: "ferry" },
};

const seed: Seed = {
  ok: true,
  skills: [],
  instructions: null,
  roots: [],
  settings: [],
  mcp: [],
  identity: "seed-identity",
  leftovers: [],
  storeUpdates: [],
};

describe("remoteUpdateCommand", () => {
  test("clones when the box checkout is missing and resets it to the pushed commit when it exists", () => {
    expect(remoteUpdateCommand("/srv/ferry/.ferry/store", "git@example.test:operator/ferry-store.git", "abc123")).toBe(
      "if [ -d '/srv/ferry/.ferry/store/.git' ]; then git -C '/srv/ferry/.ferry/store' status --porcelain=v1 -z --untracked-files=all && git -C '/srv/ferry/.ferry/store' fetch --quiet && git -C '/srv/ferry/.ferry/store' reset --quiet --hard 'abc123' && git -C '/srv/ferry/.ferry/store' clean --quiet --force -d; else mkdir -p '/srv/ferry/.ferry' && git clone 'git@example.test:operator/ferry-store.git' '/srv/ferry/.ferry/store'; fi",
    );
  });
});

describe("runSync", () => {
  test("refuses a machine that is not the configured publisher before other work", async () => {
    let manifestCalls = 0;

    await expect(
      runSync(
        { home: "/operator" },
        {
          readConfig: () => config,
          publisher: () => "box-machine",
          readSeed: () => {
            manifestCalls += 1;
            throw new Error("Manifest must not run");
          },
        },
      ),
    ).rejects.toEqual(
      expect.objectContaining({
        code: "wrong-publisher",
        origin: "operator",
        message: expect.stringContaining("operator-machine"),
      }),
    );
    expect(manifestCalls).toBe(0);
  });

  test("fails closed when Manifest finds a forbidden file", async () => {
    await expect(
      runSync(
        { home: "/operator" },
        {
          readConfig: () => config,
          publisher: () => "operator-machine",
          readSeed: () => ({
            ok: false,
            clashes: [
              {
                name: "deploy",
                paths: [
                  "/operator/.agents/skills/deploy",
                  "/operator/.codex/skills/deploy",
                ],
              },
            ],
            forbidden: [
              {
                path: "/operator/.codex/skills/deploy/.env",
                code: "dotenv",
                reason: "environment file",
              },
            ],
          }),
        },
      ),
    ).rejects.toEqual(
      expect.objectContaining({
        code: "manifest-refusal",
        origin: "operator",
        message: expect.stringContaining("deploy/.env"),
      }),
    );
    await expect(
      runSync(
        { home: "/operator" },
        {
          readConfig: () => config,
          publisher: () => "operator-machine",
          readSeed: () => ({
            ok: false,
            clashes: [
              {
                name: "deploy",
                paths: [
                  "/operator/.agents/skills/deploy",
                  "/operator/.codex/skills/deploy",
                ],
              },
            ],
            forbidden: [],
          }),
        },
      ),
    ).rejects.toThrow("clash deploy");
  });

  test("dry-run prints and returns a plan with zero writes or remote calls", async () => {
    let prohibitedCalls = 0;
    const printed: unknown[] = [];

    const result = await runSync(
      { home: "/operator", dryRun: true, force: true, message: "chore: ship skills" },
      {
        readConfig: () => config,
        publisher: () => "operator-machine",
        readSeed: () => seed,
        createLink: () => {
          prohibitedCalls += 1;
          throw new Error("Link must not be created");
        },
        openStore: async () => {
          prohibitedCalls += 1;
          throw new Error("Store must not be opened");
        },
        acquireLock: () => {
          prohibitedCalls += 1;
          throw new Error("lock must not be acquired");
        },
        apply: async () => {
          prohibitedCalls += 1;
          throw new Error("Apply must not run");
        },
        writePlan: (plan) => printed.push(plan),
      },
    );

    expect(prohibitedCalls).toBe(0);
    expect(printed).toEqual([result.plan]);
    expect(result).toMatchObject({
      dryRun: true,
      published: false,
      plan: {
        operator: "operator-machine",
        gitRemote: "git@example.test:operator/ferry-store.git",
        box: "ferry@box",
        force: true,
        message: "chore: ship skills",
      },
    });
  });

  test("dry-run prints every deny rule without remote calls", async () => {
    let prohibitedCalls = 0;
    const output: string[] = [];
    const log = console.log;
    console.log = (line: string) => output.push(line);
    try {
      await runSync(
        { home: "/operator", dryRun: true },
        {
          readConfig: () => config,
          publisher: () => "operator-machine",
          readSeed: () => seed,
          createLink: () => {
            prohibitedCalls += 1;
            throw new Error("Link must not be created");
          },
          openStore: async () => {
            prohibitedCalls += 1;
            throw new Error("Store must not be opened");
          },
        },
      );
    } finally {
      console.log = log;
    }

    expect(prohibitedCalls).toBe(0);
    const lines = output.join("\n").split("\n");
    expect(lines).toContain("Deny list:");
    for (const rule of denyRules()) {
      expect(lines).toContain(`  ${rule.code}: ${rule.behavior} ${rule.description}`);
    }
  });

  test("dry-run lists the carried settings keys that differ from the store, offline", async () => {
    const home = realpathSync(mkdtempSync(join(tmpdir(), "ferry-sync-home-")));
    try {
      mkdirSync(join(home, ".ferry", "store", "settings"), { recursive: true });
      writeFileSync(
        join(home, ".ferry", "store", "settings", "claude.json"),
        JSON.stringify({
          enabledPlugins: { "review@team": true },
          permissions: { allow: ["Bash(ls)"] },
          extraKnownMarketplaces: { old: {} },
        }),
      );
      const local = {
        ...seed,
        settings: [
          {
            harness: "claude",
            bytes: Buffer.from(
              JSON.stringify({
                enabledPlugins: { "review@team": true },
                permissions: { allow: ["Bash(git status)"] },
                hooks: { Stop: [] },
              }),
            ),
          },
        ],
      };
      let remoteCalls = 0;
      const printed: SyncPlan[] = [];

      const result = await runSync(
        { home, dryRun: true },
        {
          readConfig: () => config,
          publisher: () => "operator-machine",
          readSeed: () => local,
          createLink: () => {
            remoteCalls += 1;
            throw new Error("Link must not be created");
          },
          openStore: async () => {
            remoteCalls += 1;
            throw new Error("Store must not be opened");
          },
          writePlan: (plan) => printed.push(plan),
        },
      );

      expect(remoteCalls).toBe(0);
      expect(result.plan.settingsChanges).toEqual([
        { harness: "claude", keys: ["extraKnownMarketplaces", "permissions", "hooks"] },
      ]);
      expect(printed).toEqual([result.plan]);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test("dry-run names a skipped hook and carries the others", async () => {
    const home = realpathSync(mkdtempSync(join(tmpdir(), "ferry-sync-hooks-")));
    try {
      mkdirSync(join(home, ".claude"), { recursive: true });
      writeFileSync(
        join(home, ".claude", "settings.json"),
        JSON.stringify({
          hooks: {
            Stop: [
              {
                hooks: [
                  { type: "command", command: "~/.claude/hooks/notify.sh" },
                  { type: "command", command: "jq ." },
                ],
              },
            ],
          },
        }),
      );
      const lines: string[] = [];
      const printed: SyncPlan[] = [];

      const result = await runSync(
        { home, dryRun: true },
        {
          readConfig: () => config,
          publisher: () => "operator-machine",
          writePlan: (plan) => printed.push(plan),
          writeLine: (line) => lines.push(line),
        },
      );

      expect(result.dryRun).toBe(true);
      expect(lines).toEqual([
        `Skipped hook: hook hooks.Stop[0].hooks[0].command refers to ~/.claude/hooks/notify.sh, outside the managed set: ${join(home, ".claude", "settings.json")}`,
      ]);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test("dry-run lists every carried key present when the store has no settings yet", async () => {
    const local = {
      ...seed,
      settings: [{ harness: "claude", bytes: Buffer.from(JSON.stringify({ permissions: {} })) }],
    };

    const result = await runSync(
      { home: "/operator", dryRun: true },
      {
        readConfig: () => config,
        publisher: () => "operator-machine",
        readSeed: () => local,
        writePlan: () => {},
      },
    );

    expect(result.plan.settingsChanges).toEqual([{ harness: "claude", keys: ["permissions"] }]);
  });

  test("plans, publishes, resets the box, and applies the snapshot", async () => {
    const events: string[] = [];
    const linkCalls: Array<{ command: string; options: unknown }> = [];
    let applyInput: Record<string, unknown> | undefined;
    const link = {
      run: async (command: string, options?: unknown) => {
        linkCalls.push({ command, options });
        if (linkCalls.length === 1) {
          events.push("resolve-home");
          return {
            ok: true as const,
            address: "box.example.ts.net",
            stdout: "/srv/ferry\n",
            stderr: "",
          };
        }
        events.push("update-box");
        return {
          ok: true as const,
          address: "box.example.ts.net",
          stdout: "",
          stderr: "",
        };
      },
    };

    const result = await runSync(
      { home: "/operator", message: "chore: ship skills" },
      {
        readConfig: () => config,
        publisher: () => "operator-machine",
        readSeed: () => seed,
        createLink: () => {
          events.push("create-link");
          return link;
        },
        writePlan: () => events.push("plan"),
        acquireLock: () => {
          events.push("lock");
          return () => events.push("unlock");
        },
        openStore: async () => {
          events.push("open-store");
          return {
            path: "/operator/.ferry/store",
            publish: async (_seed, message) => {
              events.push(`publish:${message}`);
              return { published: true, tip: "abc123" };
            },
          };
        },
        apply: async (input) => {
          events.push("apply");
          applyInput = input as unknown as Record<string, unknown>;
          return {
            checkout: input.checkout,
            targetHome: input.targetHome,
            actions: [],
            unmanaged: [],
          };
        },
      },
    );

    expect(events).toEqual([
      "create-link",
      "resolve-home",
      "plan",
      "lock",
      "open-store",
      "publish:chore: ship skills",
      "update-box",
      "apply",
      "unlock",
    ]);
    expect(linkCalls).toEqual([
      { command: `printf '%s\\n' "$HOME"`, options: undefined },
      {
        command:
          "if [ -d '/srv/ferry/.ferry/store/.git' ]; then git -C '/srv/ferry/.ferry/store' status --porcelain=v1 -z --untracked-files=all && git -C '/srv/ferry/.ferry/store' fetch --quiet && git -C '/srv/ferry/.ferry/store' reset --quiet --hard 'abc123' && git -C '/srv/ferry/.ferry/store' clean --quiet --force -d; else mkdir -p '/srv/ferry/.ferry' && git clone 'git@example.test:operator/ferry-store.git' '/srv/ferry/.ferry/store'; fi",
        options: { agentForwarding: "git" },
      },
    ]);
    expect(applyInput).toMatchObject({
      checkout: "/srv/ferry/.ferry/store",
      targetHome: "/srv/ferry",
      force: false,
      dryRun: false,
      link,
    });
    expect(result).toMatchObject({
      dryRun: false,
      published: true,
      plan: {
        localCheckout: "/operator/.ferry/store",
        remoteHome: "/srv/ferry",
        remoteCheckout: "/srv/ferry/.ferry/store",
      },
      applyPlan: { actions: [] },
    });
  });

  test("installs the declared Claude plugins, then merges the carried settings keys on the box", async () => {
    const events: string[] = [];
    const commands: Array<{ command: string; options: unknown }> = [];
    const carried = { enabledPlugins: { "review@team": true } };
    const link = {
      run: async (command: string, options?: unknown) => {
        commands.push({ command, options });
        let stdout = "";
        if (command.startsWith("printf")) stdout = "/srv/ferry\n";
        else if (command.includes("claude plugin install")) events.push("install-plugins");
        else if (command.includes("settings.json") && command.includes("mv ")) events.push("write-settings");
        else if (command.includes("settings.json")) {
          events.push("read-settings");
          stdout = "M";
        }
        return { ok: true as const, address: "box", stdout, stderr: "" };
      },
    };

    await runSync(
      { home: "/operator" },
      {
        readConfig: () => config,
        publisher: () => "operator-machine",
        readSeed: () => ({
          ...seed,
          settings: [{ harness: "claude", bytes: Buffer.from(JSON.stringify(carried)) }],
        }),
        createLink: () => link,
        writePlan: () => {},
        acquireLock: () => () => events.push("unlock"),
        openStore: async () => ({
          path: "/operator/.ferry/store",
          publish: async () => ({ published: true, tip: "abc123" }),
        }),
        apply: async (input) => {
          events.push("apply");
          return { checkout: input.checkout, targetHome: input.targetHome, actions: [], unmanaged: [] };
        },
        adopt: () => events.push("adopt"),
      },
    );

    expect(events).toEqual(["apply", "install-plugins", "read-settings", "write-settings", "adopt", "unlock"]);
    const write = commands.find((call) => call.command.includes("mv "));
    expect(write?.command).toContain("/srv/ferry/.claude/settings.json");
    expect(write?.command).toContain('"review@team": true');
  });

  test("declares the carried MCP servers on the box after the settings, and prints each warning", async () => {
    const events: string[] = [];
    const lines: string[] = [];
    const link = {
      run: async (command: string) => {
        let stdout = "";
        if (command.startsWith("printf")) stdout = "/srv/ferry\n";
        else if (command.includes("claude mcp add")) {
          events.push("declare-mcp");
          stdout = "S\tlinear\n";
        }
        return { ok: true as const, address: "box", stdout, stderr: "" };
      },
    };

    await runSync(
      { home: "/operator" },
      {
        readConfig: () => config,
        publisher: () => "operator-machine",
        readSeed: () => ({
          ...seed,
          mcp: [{ harness: "claude", servers: [{ name: "linear", type: "http", url: "https://mcp.linear.app/mcp" }] }],
        }),
        createLink: () => link,
        writePlan: () => {},
        writeLine: (line) => lines.push(line),
        acquireLock: () => () => events.push("unlock"),
        openStore: async () => ({
          path: "/operator/.ferry/store",
          publish: async () => ({ published: true, tip: "abc123" }),
        }),
        apply: async (input) => {
          events.push("apply");
          return { checkout: input.checkout, targetHome: input.targetHome, actions: [], unmanaged: [] };
        },
        adopt: () => events.push("adopt"),
      },
    );

    expect(events).toEqual(["apply", "declare-mcp", "adopt", "unlock"]);
    expect(lines).toContain("Box MCP: could not declare claude MCP server linear");
  });

  test("dry-run names a skipped local MCP server and plans the carried one", async () => {
    const home = realpathSync(mkdtempSync(join(tmpdir(), "ferry-sync-mcp-")));
    try {
      writeFileSync(
        join(home, ".claude.json"),
        JSON.stringify({
          mcpServers: {
            repl: { command: "node", env: { KEY: "value" } },
            linear: { type: "http", url: "https://mcp.linear.app/mcp" },
          },
        }),
      );
      const lines: string[] = [];
      const printed: SyncPlan[] = [];

      await runSync(
        { home, dryRun: true },
        {
          readConfig: () => config,
          publisher: () => "operator-machine",
          writePlan: (plan) => printed.push(plan),
          writeLine: (line) => lines.push(line),
        },
      );

      expect(lines).toEqual([
        `Skipped MCP server: MCP server repl is not a remote HTTPS server: ${join(home, ".claude.json")}`,
      ]);
      expect(printed[0]?.mcpServers).toEqual(["claude/linear"]);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test("uses a direct SSH destination for Link, plans, and locking", async () => {
    const directConfig: OperatorConfig = {
      ...config,
      host: { transport: "ssh", destination: "user@box.example" },
    };
    let linkOptions: unknown;
    let linkCalls = 0;

    const result = await runSync(
      { home: "/operator" },
      {
        readConfig: () => directConfig,
        publisher: () => "operator-machine",
        readSeed: () => seed,
        createLink: (options) => {
          linkOptions = options;
          return {
            run: async () => {
              linkCalls += 1;
              return {
                ok: true,
                address: "user@box.example",
                stdout: linkCalls === 1 ? "/home/user\n" : "",
                stderr: "",
              };
            },
          };
        },
        acquireLock: () => () => {},
        openStore: async () => ({
          path: "/operator/.ferry/store",
          publish: async () => ({ published: false, tip: "abc123" }),
        }),
        apply: async (input) => ({
          checkout: input.checkout,
          targetHome: input.targetHome,
          actions: [],
          unmanaged: [],
        }),
        writePlan: () => {},
      },
    );

    expect(linkOptions).toEqual({ destination: "user@box.example" });
    expect(result.plan).toMatchObject({
      box: "user@box.example",
      remoteHome: "/home/user",
      remoteCheckout: "/home/user/.ferry/store",
    });
  });

  test("passes one effective custom harness registry through Manifest, Store, and Apply", async () => {
    const customHarness: HarnessDescriptor = {
      id: "opencode",
      name: "OpenCode",
      skillRoot: ".config/opencode/skills",
      instructionFile: ".config/opencode/AGENTS.md",
    };
    const configured = {
      ...config,
      harness: [customHarness],
    } satisfies OperatorConfig & RegistryConfig;
    let registryCalls = 0;
    let manifestHarnesses: readonly HarnessDescriptor[] | undefined;
    let storeHarnesses: readonly HarnessDescriptor[] | undefined;
    let applyHarnesses: readonly HarnessDescriptor[] | undefined;
    let published = false;
    let linkCalls = 0;

    await runSync(
      { home: "/operator" },
      {
        readConfig: () => configured,
        publisher: () => "operator-machine",
        loadRegistry: (registryConfig) => {
          registryCalls += 1;
          expect(registryConfig).toBe(configured);
          return loadRegistry(registryConfig);
        },
        readSeed: (_home, harnesses) => {
          manifestHarnesses = harnesses;
          return seed;
        },
        createLink: () => ({
          run: async () => {
            linkCalls += 1;
            return {
              ok: true,
              address: "box.example.ts.net",
              stdout: linkCalls === 1 ? "/srv/ferry\n" : "",
              stderr: "",
            };
          },
        }),
        writePlan: () => {},
        acquireLock: () => () => {},
        openStore: async (_remote, _seed, options) => {
          storeHarnesses = options.harnesses;
          return {
            path: "/operator/.ferry/store",
            publish: async () => {
              published = true;
              return { published: true, tip: "abc123" };
            },
          };
        },
        apply: async (input) => {
          applyHarnesses = input.harnesses;
          return {
            checkout: input.checkout,
            targetHome: input.targetHome,
            actions: [],
            unmanaged: [],
          };
        },
      },
    );

    expect(registryCalls).toBe(1);
    expect(manifestHarnesses?.map((harness) => harness.id)).toContain("opencode");
    expect(storeHarnesses).toBe(manifestHarnesses);
    expect(applyHarnesses).toBe(manifestHarnesses);
    expect(published).toBe(true);
  });

  test("refuses a concurrent sync for the same host and removes the lock after success", async () => {
    const home = mkdtempSync(join(tmpdir(), "ferry-sync-lock-"));
    let markPublishStarted: () => void = () => {};
    let continuePublish: () => void = () => {};
    const publishStarted = new Promise<void>((resolve) => {
      markPublishStarted = resolve;
    });
    const publishMayFinish = new Promise<void>((resolve) => {
      continuePublish = resolve;
    });
    const dependencies: SyncDependencies = {
      readConfig: () => config,
      publisher: () => "operator-machine",
      readSeed: () => seed,
      createLink: () => {
        let calls = 0;
        return {
          run: async () => {
            calls += 1;
            return {
              ok: true,
              address: "box.example.ts.net",
              stdout: calls === 1 ? "/srv/ferry\n" : "",
              stderr: "",
            };
          },
        };
      },
      openStore: async () => ({
        path: join(home, ".ferry", "store"),
        publish: async () => {
          markPublishStarted();
          await publishMayFinish;
          return { published: false, tip: "abc123" };
        },
      }),
      apply: async (input) => ({
        checkout: input.checkout,
        targetHome: input.targetHome,
        actions: [],
        unmanaged: [],
      }),
      writePlan: () => {},
    };

    try {
      const first = runSync({ home }, dependencies);
      await publishStarted;

      await expect(runSync({ home }, dependencies)).rejects.toEqual(
        expect.objectContaining({
          code: "concurrent-sync",
          origin: "operator",
          message: expect.stringContaining("box"),
        }),
      );

      continuePublish();
      await first;
      expect(readdirSync(join(home, ".ferry"))).toEqual([]);
    } finally {
      continuePublish();
      rmSync(home, { recursive: true, force: true });
    }
  });

  test("recovers a lock left by a dead process", async () => {
    const home = mkdtempSync(join(tmpdir(), "ferry-sync-stale-lock-"));
    const lockDirectory = join(home, ".ferry");
    let markPublishStarted: () => void = () => {};
    let continuePublish: () => void = () => {};
    let publishCalls = 0;
    const publishStarted = new Promise<void>((resolve) => {
      markPublishStarted = resolve;
    });
    const publishMayFinish = new Promise<void>((resolve) => {
      continuePublish = resolve;
    });
    const dependencies: SyncDependencies = {
      readConfig: () => config,
      publisher: () => "operator-machine",
      readSeed: () => seed,
      createLink: () => {
        let calls = 0;
        return {
          run: async () => ({
            ok: true,
            address: "box.example.ts.net",
            stdout: ++calls === 1 ? "/srv/ferry\n" : "",
            stderr: "",
          }),
        };
      },
      openStore: async () => ({
        path: join(home, ".ferry", "store"),
        publish: async () => {
          publishCalls += 1;
          if (publishCalls === 1) {
            markPublishStarted();
            await publishMayFinish;
          }
          return { published: false, tip: "abc123" };
        },
      }),
      apply: async (input) => ({
        checkout: input.checkout,
        targetHome: input.targetHome,
        actions: [],
        unmanaged: [],
      }),
      adopt: () => {},
      writePlan: () => {},
    };

    try {
      const first = runSync({ home }, dependencies);
      await publishStarted;
      const [lockFile] = readdirSync(lockDirectory);
      expect(lockFile).toMatch(/^sync-[a-f0-9]{16}\.lock$/);
      writeFileSync(join(lockDirectory, lockFile!), JSON.stringify({ pid: 999_999_999 }));
      continuePublish();
      await first;

      await runSync({ home }, dependencies);
      expect(readdirSync(lockDirectory)).toEqual([]);
    } finally {
      continuePublish();
      rmSync(home, { recursive: true, force: true });
    }
  });

  test("names a failed box update, stops before Apply, and releases the lock", async () => {
    let linkCalls = 0;
    let applyCalls = 0;
    let released = false;

    await expect(
      runSync(
        { home: "/operator" },
        {
          readConfig: () => config,
          publisher: () => "operator-machine",
          readSeed: () => seed,
          createLink: () => ({
            run: async () => {
              linkCalls += 1;
              if (linkCalls === 1) {
                return {
                  ok: true,
                  address: "box.example.ts.net",
                  stdout: "/srv/ferry\n",
                  stderr: "",
                };
              }
              return {
                ok: false,
                error: { code: "ssh-failed", origin: "network", message: "connection lost" },
              };
            },
          }),
          writePlan: () => {},
          acquireLock: () => () => {
            released = true;
          },
          openStore: async () => ({
            path: "/operator/.ferry/store",
            publish: async () => ({ published: true, tip: "abc123" }),
          }),
          apply: async (input) => {
            applyCalls += 1;
            return {
              checkout: input.checkout,
              targetHome: input.targetHome,
              actions: [],
              unmanaged: [],
            };
          },
        },
      ),
    ).rejects.toEqual(
      expect.objectContaining({
        code: "remote-update-failure",
        origin: "box",
        message: expect.stringMatching(/ferry@box.*git@example\.test/),
      }),
    );
    expect(applyCalls).toBe(0);
    expect(released).toBe(true);
  });

  test("passes force only to Apply and reports the failed harness", async () => {
    let linkCalls = 0;
    let applyForce: boolean | undefined;
    let released = false;

    await expect(
      runSync(
        { home: "/operator", force: true },
        {
          readConfig: () => config,
          publisher: () => "operator-machine",
          readSeed: () => seed,
          createLink: () => ({
            run: async () => {
              linkCalls += 1;
              return {
                ok: true,
                address: "box.example.ts.net",
                stdout: linkCalls === 1 ? "/srv/ferry\n" : "",
                stderr: "",
              };
            },
          }),
          writePlan: () => {},
          acquireLock: () => () => {
            released = true;
          },
          openStore: async () => ({
            path: "/operator/.ferry/store",
            publish: async () => ({ published: true, tip: "abc123" }),
          }),
          apply: async (input) => {
            applyForce = input.force;
            throw new ApplyError("commit-failed", "Codex", "/srv/ferry/.codex/skills");
          },
        },
      ),
    ).rejects.toEqual(
      expect.objectContaining({
        code: "apply-failure",
        origin: "box",
        message: expect.stringMatching(/ferry@box.*Codex/),
      }),
    );
    expect(applyForce).toBe(true);
    expect(released).toBe(true);
  });

  test("names the git remote when Store publication fails", async () => {
    let released = false;

    await expect(
      runSync(
        { home: "/operator" },
        {
          readConfig: () => config,
          publisher: () => "operator-machine",
          readSeed: () => seed,
          createLink: () => ({
            run: async () => ({
              ok: true,
              address: "box.example.ts.net",
              stdout: "/srv/ferry\n",
              stderr: "",
            }),
          }),
          writePlan: () => {},
          acquireLock: () => () => {
            released = true;
          },
          openStore: async () => {
            throw new Error("push rejected");
          },
        },
      ),
    ).rejects.toEqual(
      expect.objectContaining({
        code: "publish-failure",
        origin: "git remote",
        message: expect.stringMatching(/git@example\.test.*push rejected/),
      }),
    );
    expect(released).toBe(true);
  });

  test("resets a dirty box checkout to the pushed commit and names each discarded file", async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "ferry-sync-dirty-box-")));
    const remote = join(root, "remote.git");
    const operator = join(root, "operator");
    const boxHome = join(root, "box");
    const boxCheckout = join(boxHome, ".ferry", "store");
    const outside = join(root, "outside.txt");
    const lines: string[] = [];
    try {
      await sh(root, `git init --quiet --bare ${remote} && git clone --quiet ${remote} ${operator}`);
      mkdirSync(join(operator, "skills", "tdd"), { recursive: true });
      writeFileSync(join(operator, "skills", "tdd", "SKILL.md"), "operator v1\n");
      writeFileSync(join(operator, "skills", "tdd", "notes.md"), "operator notes\n");
      await sh(operator, "git add -A && git commit --quiet -m v1 && git push --quiet origin HEAD");
      mkdirSync(join(boxHome, ".ferry"), { recursive: true });
      await sh(root, `git clone --quiet ${remote} ${boxCheckout}`);

      writeFileSync(join(boxCheckout, "skills", "tdd", "SKILL.md"), "box edit\n");
      writeFileSync(join(boxCheckout, "skills", "tdd", "notes.md"), "box notes\n");
      mkdirSync(join(boxCheckout, "skills", "scratch"), { recursive: true });
      writeFileSync(join(boxCheckout, "skills", "scratch", "SKILL.md"), "box only\n");
      writeFileSync(outside, "keep\n");

      writeFileSync(join(operator, "skills", "tdd", "SKILL.md"), "operator v2\n");
      await sh(operator, "git commit --quiet -am v2 && git push --quiet origin HEAD");
      const tip = (await sh(operator, "git rev-parse HEAD")).trim();

      const result = await runSync(
        { home: "/operator" },
        {
          readConfig: () => ({ ...config, snapshotUrl: remote }),
          publisher: () => "operator-machine",
          readSeed: () => seed,
          createLink: () => ({ run: (command) => shellLink(root, boxHome, command) }),
          writePlan: () => {},
          writeLine: (line) => lines.push(line),
          acquireLock: () => () => {},
          openStore: async () => ({
            path: operator,
            publish: async () => ({ published: true, tip }),
          }),
          apply: async (input) => ({
            checkout: input.checkout,
            targetHome: input.targetHome,
            actions: [],
            unmanaged: [],
          }),
          adopt: () => {},
        },
      );

      expect((await sh(boxCheckout, "git rev-parse HEAD")).trim()).toBe(tip);
      expect(await sh(boxCheckout, "git status --porcelain --untracked-files=all")).toBe("");
      expect(readFileSync(join(boxCheckout, "skills", "tdd", "SKILL.md"), "utf8")).toBe("operator v2\n");
      expect(existsSync(join(boxCheckout, "skills", "scratch"))).toBe(false);
      expect(readFileSync(outside, "utf8")).toBe("keep\n");
      expect(result.discarded).toEqual([
        "skills/scratch/SKILL.md",
        "skills/tdd/SKILL.md",
        "skills/tdd/notes.md",
      ]);
      expect(lines).toEqual([
        `Discarded box change: ${boxCheckout}/skills/scratch/SKILL.md`,
        `Discarded box change: ${boxCheckout}/skills/tdd/SKILL.md`,
        `Discarded box change: ${boxCheckout}/skills/tdd/notes.md`,
      ]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("runSync progress", () => {
  /** Record the progress calls and the printed lines in one list, to show that no line prints inside a step. */
  function recorder(): { readonly events: string[]; readonly progress: Progress } {
    const events: string[] = [];
    return {
      events,
      progress: {
        ...noProgress,
        start: (step) => events.push(`start:${step}`),
        count: (current, total) => events.push(`count:${current}/${total}`),
        done: () => events.push("done"),
        fail: () => events.push("fail"),
      },
    };
  }

  const carriedSeed: Seed = {
    ...seed,
    leftovers: [
      { code: "hook-path", reason: "hook entry that refers to a home path outside the managed set", path: "~/.claude/hooks/notify.sh" },
    ],
    settings: [
      {
        harness: "claude",
        bytes: Buffer.from(JSON.stringify({ enabledPlugins: { "review@team": true, "broken@team": true } })),
      },
    ],
    mcp: [
      {
        harness: "claude",
        servers: [
          { name: "linear", type: "http", url: "https://mcp.linear.app/mcp" },
          { name: "notion", type: "http", url: "https://mcp.notion.com/mcp" },
        ],
      },
    ],
  };

  function dependencies(events: string[], progress: Progress, update: LinkResult): SyncDependencies {
    return {
      readConfig: () => config,
      publisher: () => "operator-machine",
      readSeed: () => carriedSeed,
      createLink: () => ({
        run: async (command: string) => {
          let stdout = "";
          if (command.startsWith("printf")) stdout = "/srv/ferry\n";
          else if (command.includes("git clone")) return update;
          else if (command.includes("broken@team")) stdout = "P\tbroken@team\tnot found\n";
          else if (command.includes("settings.json")) stdout = "M";
          return { ok: true as const, address: "box", stdout, stderr: "" };
        },
      }),
      writePlan: () => events.push("plan"),
      writeLine: (line) => events.push(`line:${line}`),
      acquireLock: () => () => {},
      openStore: async () => ({
        path: "/operator/.ferry/store",
        publish: async () => ({ published: true, tip: "abc123" }),
      }),
      apply: async (input) => ({ checkout: input.checkout, targetHome: input.targetHome, actions: [], unmanaged: [] }),
      adopt: () => {},
      progress,
    };
  }

  test("prints a summary table with a row, a result, and a detail for each step", async () => {
    const terminal = fakeTerminal();
    const update: LinkResult = { ok: true, address: "box", stdout: " M skills/x/SKILL.md\0", stderr: "" };

    await runSync({ home: "/operator" }, dependencies([], terminal.progress, update));
    terminal.progress.finish();

    expect(terminal.table()).toEqual([
      "Step                              Result     Detail                    Time",
      "Reading the portable set          ✔ done     0 skills                  0.1s",
      "Connecting to ferry@box           ✔ done                               0.1s",
      "Publishing the snapshot           ✔ done     published abc123          0.1s",
      "Updating the box checkout         ✔ done     discarded 1 box change    0.1s",
      "Applying the snapshot on the box  ✔ done     0 changes                 0.1s",
      "Installing Claude plugins         ✔ done     1 warning                 0.1s",
      "Merging settings on the box       ✔ done                               0.1s",
      "Declaring MCP servers             ✔ done     2 servers                 0.1s",
      "Adopting published local skills   ✔ done                               0.1s",
    ]);
  });

  test("ends the summary table at a failed step, with the error as detail", async () => {
    const terminal = fakeTerminal();
    const update: LinkResult = {
      ok: false,
      error: { origin: "box", code: "command-failed", message: "fatal: could not read from remote" },
    } as LinkResult;

    await expect(runSync({ home: "/operator" }, dependencies([], terminal.progress, update))).rejects.toThrow(
      "failed to update",
    );
    terminal.progress.finish();

    expect(terminal.table()).toEqual([
      "Step                       Result     Detail                               Time",
      "Reading the portable set   ✔ done     0 skills                             0.1s",
      "Connecting to ferry@box    ✔ done                                          0.1s",
      "Publishing the snapshot    ✔ done     published abc123                     0.1s",
      "Updating the box checkout  ✖ failed   box: failed to update ferry@box…     0.1s",
    ]);
  });

  test("shows each step in order, counts plugins and MCP servers, and prints lines between steps", async () => {
    const { events, progress } = recorder();
    const update: LinkResult = { ok: true, address: "box", stdout: " M skills/x/SKILL.md\0", stderr: "" };

    await runSync({ home: "/operator" }, dependencies(events, progress, update));

    expect(events).toEqual([
      "start:Reading the portable set",
      "done",
      "line:Skipped hook: hook entry that refers to a home path outside the managed set: ~/.claude/hooks/notify.sh",
      "start:Connecting to ferry@box",
      "done",
      "plan",
      "start:Publishing the snapshot",
      "done",
      "start:Updating the box checkout",
      "done",
      "line:Discarded box change: /srv/ferry/.ferry/store/skills/x/SKILL.md",
      "start:Applying the snapshot on the box",
      "done",
      "start:Installing Claude plugins",
      "count:1/2",
      "count:2/2",
      "done",
      "line:Box plugins: could not install plugin broken@team: not found",
      "start:Merging settings on the box",
      "done",
      "start:Declaring MCP servers",
      "count:1/2",
      "count:2/2",
      "done",
      "start:Adopting published local skills",
      "done",
    ]);
  });

  test("ends a failed step with a failed mark before the error", async () => {
    const { events, progress } = recorder();
    const update: LinkResult = {
      ok: false,
      error: { code: "ssh-failed", origin: "network", message: "connection lost" },
    };

    await expect(runSync({ home: "/operator" }, dependencies(events, progress, update))).rejects.toBeInstanceOf(
      SyncError,
    );
    expect(events.slice(-2)).toEqual(["start:Updating the box checkout", "fail"]);
  });

  test("a dry run shows only the local read step", async () => {
    const { events, progress } = recorder();

    await runSync({ home: "/operator", dryRun: true }, dependencies(events, progress, { ok: true, address: "box", stdout: "", stderr: "" }));

    expect(events.filter((event) => event.startsWith("start:"))).toEqual(["start:Reading the portable set"]);
  });
});

describe("a store update from one harness root", () => {
  /**
   * The published store copy of `tdd` is v1. An installer replaced the
   * `.agents/skills` link with a real v2 directory. `.claude/skills` links to
   * the store, and `.codex/skills` chains through `.claude/skills`.
   */
  async function installerHome() {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "ferry-sync-store-update-")));
    const remote = join(root, "remote.git");
    const home = join(root, "home");
    const store = join(home, ".ferry", "store");
    await sh(root, `git init --quiet --bare ${remote} && mkdir -p ${home}/.ferry && git clone --quiet ${remote} ${store}`);
    await sh(
      store,
      "git config user.name 'Ferry Test' && git config user.email ferry@example.test && git config commit.gpgsign false",
    );
    mkdirSync(join(store, "skills", "tdd"), { recursive: true });
    writeFileSync(join(store, "skills", "tdd", "SKILL.md"), "v1\n");
    await sh(store, "git add -A && git commit --quiet -m v1 && git push --quiet origin HEAD");

    const real = join(home, ".agents", "skills", "tdd");
    mkdirSync(real, { recursive: true });
    writeFileSync(join(real, "SKILL.md"), "v2\n");
    writeFileSync(join(real, ".installer-source"), "stack\n");
    mkdirSync(join(home, ".claude", "skills"), { recursive: true });
    symlinkSync(join(store, "skills", "tdd"), join(home, ".claude", "skills", "tdd"));
    mkdirSync(join(home, ".codex", "skills"), { recursive: true });
    symlinkSync(join(home, ".claude", "skills", "tdd"), join(home, ".codex", "skills", "tdd"));
    const remoteTip = (await sh(remote, "git rev-parse HEAD")).trim();
    return { root, remote, home, store, real, remoteTip };
  }

  function prohibited(): SyncDependencies {
    const refuse = () => {
      throw new Error("must not run");
    };
    return { createLink: refuse, openStore: refuse, acquireLock: refuse, apply: refuse, adopt: refuse };
  }

  test("updates the store copy, publishes it, and links the real directory to the store", async () => {
    const { root, remote, home, store, real } = await installerHome();
    const plans: SyncPlan[] = [];
    const lines: string[] = [];
    try {
      await runSync(
        { home },
        {
          readConfig: () => ({ ...config, snapshotUrl: remote }),
          publisher: () => "operator-machine",
          createLink: () => ({
            run: async (command) => ({
              ok: true,
              address: "box",
              stdout: command.startsWith("printf") ? "/box\n" : "",
              stderr: "",
            }),
          }),
          acquireLock: () => () => {},
          apply: async (input) => ({
            checkout: input.checkout,
            targetHome: input.targetHome,
            actions: [],
            unmanaged: [],
          }),
          writePlan: (plan) => plans.push(plan),
          writeLine: (line) => lines.push(line),
        },
      );

      expect(plans[0]?.storeUpdates).toEqual([{ name: "tdd", path: real }]);
      expect(lines).toContain(`Updated store skill tdd from ${real}`);
      expect(await sh(remote, "git show HEAD:skills/tdd/SKILL.md")).toBe("v2\n");
      expect(await sh(remote, "git show HEAD:skills/tdd/.installer-source")).toBe("stack\n");
      expect(readFileSync(join(home, ".codex", "skills", "tdd", "SKILL.md"), "utf8")).toBe("v2\n");
      expect(lstatSync(real).isSymbolicLink()).toBe(true);
      expect(realpathSync(real)).toBe(join(store, "skills", "tdd"));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("refuses with a clash when the store copy has unpublished changes", async () => {
    const { root, remote, home, store, real, remoteTip } = await installerHome();
    try {
      writeFileSync(join(store, "skills", "tdd", "SKILL.md"), "local edit\n");

      const sync = runSync(
        { home },
        {
          ...prohibited(),
          readConfig: () => ({ ...config, snapshotUrl: remote }),
          publisher: () => "operator-machine",
          writePlan: () => {},
        },
      );

      await expect(sync).rejects.toBeInstanceOf(SyncError);
      await expect(sync).rejects.toMatchObject({ code: "manifest-refusal" });
      await expect(sync).rejects.toThrow(/clash tdd/);
      expect(readFileSync(join(store, "skills", "tdd", "SKILL.md"), "utf8")).toBe("local edit\n");
      expect(lstatSync(real).isDirectory()).toBe(true);
      expect((await sh(remote, "git rev-parse HEAD")).trim()).toBe(remoteTip);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("dry-run names the skill and changes nothing", async () => {
    const { root, remote, home, store, real, remoteTip } = await installerHome();
    const output: string[] = [];
    const log = console.log;
    console.log = (line: string) => output.push(line);
    try {
      const result = await runSync(
        { home, dryRun: true },
        {
          ...prohibited(),
          readConfig: () => ({ ...config, snapshotUrl: remote }),
          publisher: () => "operator-machine",
        },
      );

      expect(result.plan.storeUpdates).toEqual([{ name: "tdd", path: real }]);
      expect(output.join("\n").split("\n")).toContain(`Store updates from a harness root: tdd (${real})`);
      expect(readFileSync(join(store, "skills", "tdd", "SKILL.md"), "utf8")).toBe("v1\n");
      expect(await sh(store, "git status --porcelain --untracked-files=all")).toBe("");
      expect(lstatSync(real).isDirectory()).toBe(true);
      expect((await sh(remote, "git rev-parse HEAD")).trim()).toBe(remoteTip);
    } finally {
      console.log = log;
      rmSync(root, { recursive: true, force: true });
    }
  });
});

const gitEnvironment = {
  GIT_AUTHOR_NAME: "Ferry Test",
  GIT_AUTHOR_EMAIL: "ferry@example.test",
  GIT_COMMITTER_NAME: "Ferry Test",
  GIT_COMMITTER_EMAIL: "ferry@example.test",
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_NOSYSTEM: "1",
};

async function shellLink(cwd: string, home: string, command: string): Promise<LinkResult> {
  const process = Bun.spawn(["sh", "-c", command], {
    cwd,
    env: { ...Bun.env, ...gitEnvironment, HOME: home },
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  const [exitCode, stdout, stderr] = await Promise.all([
    process.exited,
    new Response(process.stdout).text(),
    new Response(process.stderr).text(),
  ]);
  if (exitCode !== 0) {
    return {
      ok: false,
      error: { code: "command-failed", origin: "box", message: stderr.trim() || "command failed" },
    };
  }
  return { ok: true, address: "test-box", stdout, stderr };
}

async function sh(cwd: string, command: string): Promise<string> {
  const result = await shellLink(cwd, cwd, command);
  if (!result.ok) throw new Error(`${command}: ${result.error.message}`);
  return result.stdout;
}
