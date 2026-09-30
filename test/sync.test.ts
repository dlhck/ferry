import { afterEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { boxInstructionsHeader, writeBoxFilesCommand } from "../src/box-identity.ts";
import { errorInfo } from "../src/output.ts";
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
import { join, posix } from "node:path";
import { ApplyError } from "../src/apply.ts";
import { buildProgram } from "../src/cli.ts";
import type { OperatorConfig } from "../src/config.ts";
import { denyRules, type Seed } from "../src/manifest.ts";
import { unitFile } from "../src/integrations/paseo.ts";
import { loadRegistry, type RegistryConfig } from "../src/registry/load.ts";
import type { LinkResult } from "../src/link.ts";
import type { HarnessDescriptor } from "../src/registry/types.ts";
import {
  remoteUpdateCommand,
  BoxesSyncError,
  runSync,
  SyncError,
  type SyncDependencies,
  type SyncPlan,
} from "../src/sync.ts";
import { noProgress, type Progress } from "../src/progress.ts";
import { BUILTIN_BOX_PATH_DIRS, profileBlockCommand } from "../src/tools/path.ts";
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
        // The forbidden file gives the --json error code deny-rule-match.
        cause: expect.objectContaining({ code: "deny-rule-match" }),
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
        acquireStoreLock: async () => () => {},
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

  for (const [label, integrations] of [
    ["no [integrations] section", {}],
    ["paseo = false", { integrations: { paseo: false } }],
  ] as const) {
    test(`sync --dry-run prints nothing about Paseo with ${label}`, async () => {
      const lines: string[] = [];
      const terminal = fakeTerminal();
      const log = console.log;
      console.log = (line: string) => lines.push(line);
      try {
        await buildProgram({
          runSync: (input, dependencies) =>
            runSync(
              { ...input, home: "/operator" },
              {
                readConfig: () => ({ ...config, ...integrations }),
                publisher: () => "operator-machine",
                readSeed: () => seed,
                ...dependencies,
              },
            ),
          createProgress: () => terminal.progress,
        }).parseAsync(["sync", "--dry-run"], { from: "user" });
      } finally {
        console.log = log;
      }

      const output = lines.join("\n");
      expect(output).toContain("Deny list:");
      expect(terminal.table().join("\n")).toContain("Reading the portable set");
      expect(output).not.toMatch(/paseo/i);
      expect(terminal.writes.join("")).not.toMatch(/paseo/i);
    });
  }

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
                  { type: "command", command: "~/bin/notify.sh" },
                  { type: "command", command: "~/.claude/hooks/format.sh" },
                  { type: "command", command: "paseo hooks claude stop" },
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
        `Skipped hook: hook hooks.Stop[0].hooks[0].command refers to ~/bin/notify.sh, outside the managed set: ${join(home, ".claude", "settings.json")}`,
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
        events.push(command.includes(".profile") ? "write-path" : command.includes(".ferry/box") ? "write-box-files" : "update-box");
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
        acquireStoreLock: async () => {
          events.push("store-lock");
          return () => events.push("store-unlock");
        },
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
        adopt: () => events.push("adopt"),
      },
    );

    expect(events).toEqual([
      "store-lock",
      "open-store",
      "publish:chore: ship skills",
      "store-unlock",
      "lock",
      "create-link",
      "resolve-home",
      "plan",
      "update-box",
      "write-box-files",
      "apply",
      "write-path",
      "unlock",
      "adopt",
    ]);
    expect(linkCalls).toEqual([
      { command: `printf '%s\\n' "$HOME"`, options: undefined },
      {
        command:
          "if [ -d '/srv/ferry/.ferry/store/.git' ]; then git -C '/srv/ferry/.ferry/store' status --porcelain=v1 -z --untracked-files=all && git -C '/srv/ferry/.ferry/store' fetch --quiet && git -C '/srv/ferry/.ferry/store' reset --quiet --hard 'abc123' && git -C '/srv/ferry/.ferry/store' clean --quiet --force -d; else mkdir -p '/srv/ferry/.ferry' && git clone 'git@example.test:operator/ferry-store.git' '/srv/ferry/.ferry/store'; fi",
        options: { agentForwarding: "git" },
      },
      { command: writeBoxFilesCommand("/srv/ferry", "/srv/ferry/.ferry/store", "default"), options: undefined },
      { command: profileBlockCommand(BUILTIN_BOX_PATH_DIRS), options: undefined },
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
        else if (command.includes("settings.json")) {
          events.push("merge-settings");
          stdout = "J\n";
        }
        return { ok: true as const, address: "box", stdout, stderr: "" };
      },
    };
    const warnings: string[] = [];

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
        warn: (line) => warnings.push(line),
        acquireStoreLock: async () => () => {},
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

    expect(events).toEqual(["apply", "install-plugins", "merge-settings", "unlock", "adopt"]);
    const merge = commands.find((call) => call.command.includes("settings.json"));
    expect(merge?.command).toContain("/srv/ferry/.claude/settings.json");
    expect(merge?.command).toContain("review@team");
    expect(warnings).toEqual([
      "Box settings: jq is not on the box, so Ferry did not update .claude/settings.json. Run ferry update to install jq.",
    ]);
  });

  test("declares the carried MCP servers on the box after the settings, and prints each warning", async () => {
    const events: string[] = [];
    const lines: string[] = [];
    const warnings: string[] = [];
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
        warn: (line) => warnings.push(line),
        acquireStoreLock: async () => () => {},
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

    expect(events).toEqual(["apply", "declare-mcp", "unlock", "adopt"]);
    expect(lines).toContain("Box MCP: could not declare claude MCP server linear");
    expect(warnings).toEqual(["Box MCP: could not declare claude MCP server linear"]);
  });

  test("dry-run names a skipped local MCP server and plans the carried one", async () => {
    const home = realpathSync(mkdtempSync(join(tmpdir(), "ferry-sync-mcp-")));
    try {
      writeFileSync(
        join(home, ".claude.json"),
        JSON.stringify({
          mcpServers: {
            repl: { command: join(home, "bin", "repl"), env: { KEY: "value" } },
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
        `Skipped MCP server: MCP server repl refers to a path in the home, which the box does not have: ${join(home, ".claude.json")}`,
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
        acquireStoreLock: async () => () => {},
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

    expect(linkOptions).toEqual({ destination: "user@box.example", pathDirs: BUILTIN_BOX_PATH_DIRS });
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
        acquireStoreLock: async () => () => {},
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
    expect(storeHarnesses).toEqual(manifestHarnesses);
    expect(applyHarnesses).toEqual(manifestHarnesses);
    expect(published).toBe(true);
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
          acquireStoreLock: async () => () => {},
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
        // The Link error of the box command gives the --json code box-offline.
        cause: expect.objectContaining({ code: "box-offline" }),
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
          acquireStoreLock: async () => () => {},
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

  test("names the git remote when Store publication fails, before it locks the box", async () => {
    let locked = false;

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
          acquireStoreLock: async () => () => {},
          acquireLock: () => {
            locked = true;
            return () => {};
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
    expect(locked).toBe(false);
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
          acquireStoreLock: async () => () => {},
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
      acquireStoreLock: async () => () => {},
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
      "Publishing the snapshot           ✔ done     published abc123          0.1s",
      "Connecting to ferry@box           ✔ done                               0.1s",
      "Updating the box checkout         ✔ done     discarded 1 box change    0.1s",
      "Writing the box instructions      ✔ done                               0.1s",
      "Applying the snapshot on the box  ✔ done     0 changes                 0.1s",
      "Installing Claude plugins         ✔ done     1 warning                 0.1s",
      "Merging settings on the box       ✔ done                               0.1s",
      "Declaring MCP servers             ✔ done     2 servers                 0.1s",
      "Writing the box PATH              ✔ done     updated ~/.profile        0.1s",
      "Adopting published local skills   ✔ done                               0.1s",
    ]);
  });

  test("marks the failed box step, with the error as detail, and still adopts after the publish", async () => {
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
      "Step                             Result     Detail                         Time",
      "Reading the portable set         ✔ done     0 skills                       0.1s",
      "Publishing the snapshot          ✔ done     published abc123               0.1s",
      "Connecting to ferry@box          ✔ done                                    0.1s",
      "Updating the box checkout        ✖ failed   box: failed to update ferr…    0.1s",
      "Adopting published local skills  ✔ done                                    0.1s",
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
      "start:Publishing the snapshot",
      "done",
      "start:Connecting to ferry@box",
      "done",
      "plan",
      "start:Updating the box checkout",
      "done",
      "line:Discarded box change: /srv/ferry/.ferry/store/skills/x/SKILL.md",
      "start:Writing the box instructions",
      "done",
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
      "start:Writing the box PATH",
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
    expect(events.slice(-4, -2)).toEqual(["start:Updating the box checkout", "fail"]);
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
    return { createLink: refuse, openStore: refuse, acquireStoreLock: refuse, acquireLock: refuse, apply: refuse, adopt: refuse };
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
          acquireStoreLock: async () => () => {},
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

describe("sync with the Paseo integration", () => {
  const paseoConfig: OperatorConfig = { ...config, integrations: { paseo: true } };
  const reviewer = { id: "p1", name: "Reviewer", provider: "claude", model: "opus" };
  const pilot = { id: "p2", name: "Pilot", provider: "copilot", model: "any" };

  const homes: string[] = [];
  afterEach(() => {
    for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true });
  });

  function paseoHome(profiles: readonly unknown[] | null): string {
    const home = mkdtempSync(join(tmpdir(), "ferry-sync-paseo-"));
    homes.push(home);
    if (profiles !== null) {
      mkdirSync(join(home, ".paseo"));
      writeFileSync(
        join(home, ".paseo/config.json"),
        JSON.stringify({ daemon: { listen: "127.0.0.1:6767", agentProfiles: profiles }, providers: { openai: {} } }),
      );
    }
    return home;
  }

  function run(
    home: string,
    options: {
      readonly config?: OperatorConfig & RegistryConfig;
      readonly dryRun?: boolean;
      readonly status?: string;
      /** The box unit file. `null` means that the file is missing. */
      readonly unit?: string | null;
    } = {},
  ) {
    const events: string[] = [];
    const commands: string[] = [];
    const lines: string[] = [];
    const plans: SyncPlan[] = [];
    const status =
      options.status ??
      JSON.stringify({ localDaemon: "running", providers: [{ provider: "claude", available: true }] });
    const dependencies: SyncDependencies = {
      readConfig: () => options.config ?? paseoConfig,
      publisher: () => "operator-machine",
      readSeed: () => seed,
      createLink: () => {
        if (options.dryRun) throw new Error("Link must not be created");
        return {
          run: async (command: string) => {
            commands.push(command);
            let stdout = "";
            if (command.startsWith("printf")) stdout = "/srv/ferry\n";
            else if (command.includes("paseo daemon status")) stdout = status;
            else if (command.startsWith("if [ -e '.config/systemd/user/ferry-paseo.service' ]")) {
              stdout = options.unit === null ? "M" : `F${options.unit ?? unitFile(BUILTIN_BOX_PATH_DIRS)}`;
            }
            else if (command.includes(".paseo/config.json") && !command.includes(" mv ")) stdout = "M";
            return { ok: true as const, address: "box", stdout, stderr: "" };
          },
        };
      },
      writePlan: (plan) => plans.push(plan),
      writeLine: (line) => lines.push(line),
      acquireStoreLock: async () => () => {},
      acquireLock: () => () => {},
      openStore: async () => ({
        path: "/operator/.ferry/store",
        publish: async () => ({ published: false, tip: null }),
      }),
      apply: async (input) => ({ checkout: input.checkout, targetHome: input.targetHome, actions: [], unmanaged: [] }),
      adopt: () => {},
      progress: {
        ...noProgress,
        plan: (total) => events.push(`plan:${total}`),
        start: (step) => events.push(`start:${step}`),
        done: (detail) => events.push(`done:${detail ?? ""}`),
        fail: () => events.push("fail"),
      },
    };
    return { events, commands, lines, plans, result: runSync({ home, dryRun: options.dryRun }, dependencies) };
  }

  test("carries the profiles after the box PATH, skips a missing provider, and reloads the daemon", async () => {
    const sync = run(paseoHome([reviewer, pilot]));
    await sync.result;

    expect(sync.events).toContain("plan:12");
    expect(sync.events.slice(-2)).toEqual(["start:Adopting published local skills", "done:"]);
    expect(sync.events.slice(-8, -2)).toEqual([
      "start:Writing the box PATH",
      "done:updated ~/.profile",
      "start:Carrying Paseo agent profiles",
      "done:1 profile, 1 skipped",
      "start:Updating the Paseo unit PATH",
      "done:no changes",
    ]);
    expect(sync.lines).toContain(
      "Warning: Paseo agent profile Pilot was not carried: provider copilot is not available on the box.",
    );
    const write = sync.commands.find((command) => command.includes(".paseo/config.json") && command.includes(" mv "));
    expect(write).toContain('"name": "Reviewer"');
    expect(write).not.toContain("Pilot");
    expect(write).not.toContain("providers");
    expect(sync.commands.at(-2)).toBe("paseo daemon reload");
  });

  test("reports no profiles and runs no Paseo command when the operator has none", async () => {
    const sync = run(paseoHome(null));
    await sync.result;

    expect(sync.events.slice(-6, -4)).toEqual(["start:Carrying Paseo agent profiles", "done:no profiles"]);
    expect(sync.commands.some((command) => command.includes("paseo daemon") || command.includes(".paseo/"))).toBe(false);
  });

  test("warns and completes the sync when the box cannot take the profiles", async () => {
    const sync = run(paseoHome([reviewer]), { status: "" });
    await sync.result;

    expect(sync.events.slice(-6, -4)).toEqual(["start:Carrying Paseo agent profiles", "fail"]);
    expect(sync.lines.at(-1)).toStartWith("Warning: Ferry could not carry the Paseo agent profiles:");
  });

  const bunConfig = {
    ...paseoConfig,
    tools: { bun: { local: "bun --version", install: "curl -fsSL https://bun.sh/install | bash", path: [".bun/bin"] } },
  };
  const restart = "systemctl --user daemon-reload && systemctl --user restart ferry-paseo.service";

  test("rewrites the unit PATH and restarts the daemon as the last box step when a config tool adds a directory", async () => {
    const sync = run(paseoHome(null), { config: bunConfig });
    await sync.result;

    const dirs = [...BUILTIN_BOX_PATH_DIRS, ".bun/bin"];
    expect(sync.commands).toContain(profileBlockCommand(dirs));
    const write = sync.commands.find((command) => command.includes("ferry-paseo.service") && command.includes(" mv "));
    expect(write).toContain(":%h/.bun/bin:/usr/local/sbin");
    expect(sync.commands.at(-1)).toBe(restart);
    expect(sync.events.slice(-4, -2)).toEqual(["start:Updating the Paseo unit PATH", "done:restarted"]);
    expect(sync.lines).toContain(
      "The box PATH changed, so Ferry updated ferry-paseo.service and restarted the Paseo daemon. The restart stopped the agents that ran on the box.",
    );
  });

  test("does not write the unit or restart the daemon when the unit PATH is current", async () => {
    const dirs = [...BUILTIN_BOX_PATH_DIRS, ".bun/bin"];
    const sync = run(paseoHome(null), { config: bunConfig, unit: unitFile(dirs) });
    await sync.result;

    expect(sync.commands.some((command) => command.includes("ferry-paseo.service") && command.includes(" mv "))).toBe(false);
    expect(sync.commands).not.toContain(restart);
    expect(sync.events.slice(-4, -2)).toEqual(["start:Updating the Paseo unit PATH", "done:no changes"]);
    expect(sync.lines.some((line) => line.includes("restart"))).toBe(false);
  });

  test("warns and completes the sync when the unit is not on the box", async () => {
    const sync = run(paseoHome(null), { config: bunConfig, unit: null });
    await sync.result;

    expect(sync.events.slice(-4, -2)).toEqual(["start:Updating the Paseo unit PATH", "fail"]);
    expect(sync.commands).not.toContain(restart);
    expect(sync.lines.at(-1)).toBe(
      "Warning: Ferry could not update the PATH of ferry-paseo.service: ~/.config/systemd/user/ferry-paseo.service is not on the box. Run ferry integrations enable paseo. The sync is complete.",
    );
  });

  test("the dry run names the box PATH directories, and the Paseo restart only when the integration is enabled", async () => {
    const printed = async (config: OperatorConfig & RegistryConfig) => {
      const output: string[] = [];
      const result = await runSync(
        { home: paseoHome(null), dryRun: true },
        { readConfig: () => config, publisher: () => "operator-machine", readSeed: () => seed, writeLine: (line) => output.push(line) },
      );
      return { plan: result.plan, output: output.join("\n") };
    };

    const on = await printed(bunConfig);
    expect(on.plan.pathDirs).toEqual([".local/bin", ".pi/agent/bin", ".bun/bin"]);
    expect(on.output).toContain(
      "Box PATH: ~/.local/bin, ~/.pi/agent/bin, ~/.bun/bin -> the ferry block of ~/.profile and the PATH of ferry-paseo.service. A PATH change restarts the Paseo daemon and stops its agents",
    );
    const off = await printed({ ...bunConfig, integrations: { paseo: false } });
    expect(off.output).toContain("Box PATH: ~/.local/bin, ~/.pi/agent/bin, ~/.bun/bin -> the ferry block of ~/.profile\n");
  });

  test("refuses an unsafe box PATH directory before it connects to the box", async () => {
    const sync = run(paseoHome(null), { config: { ...bunConfig, tools: { bad: { local: "x", install: "x", path: ['.bin"x'] } } } });

    await expect(sync.result).rejects.toEqual(
      expect.objectContaining({ code: "registry-refusal", message: expect.stringContaining("not safe in PATH") }),
    );
    expect(sync.commands).toEqual([]);
  });

  test("refuses a profile with an env block before it connects to the box", async () => {
    const sync = run(paseoHome([{ ...reviewer, env: { MODE: "fast" } }]));

    await expect(sync.result).rejects.toEqual(
      expect.objectContaining({ code: "manifest-refusal", message: expect.stringContaining("Reviewer") }),
    );
    expect(sync.commands).toEqual([]);
  });

  test("the dry run names the profiles it would carry and stays offline", async () => {
    const output: string[] = [];
    const log = console.log;
    console.log = (line: string) => output.push(line);
    try {
      const sync = run(paseoHome([reviewer, pilot]), { dryRun: true });
      await sync.result;
      expect(sync.plans[0]?.paseoProfiles).toEqual(["Reviewer", "Pilot"]);
      expect(sync.commands).toEqual([]);
    } finally {
      console.log = log;
    }
  });

  test("the printed plan has a Paseo line only when the integration is enabled", async () => {
    const printed = async (config: OperatorConfig) => {
      const output: string[] = [];
      await runSync(
        { home: paseoHome([reviewer]), dryRun: true },
        {
          readConfig: () => config,
          publisher: () => "operator-machine",
          readSeed: () => seed,
          writeLine: (line) => output.push(line),
        },
      );
      return output.join("\n");
    };

    expect(await printed(paseoConfig)).toContain(
      "Paseo agent profiles: Reviewer -> box ~/.paseo/config.json daemon.agentProfiles, then paseo daemon reload. Ferry skips each profile whose provider is not available on the box.",
    );
    expect(await printed(config)).not.toContain("Paseo");
  });
});

describe("sync locks", () => {
  /** The box lock file name of the earlier single-lock version, so a running old watch and a new CLI share it. */
  function boxLockFile(target: string): string {
    return `sync-${createHash("sha256").update(target).digest("hex").slice(0, 16)}.lock`;
  }

  function deferred(): { readonly promise: Promise<void>; readonly resolve: () => void } {
    let resolve = () => {};
    const promise = new Promise<void>((done) => {
      resolve = done;
    });
    return { promise, resolve };
  }

  function lockedSync(
    home: string,
    destination: string,
    events: string[],
    hooks: { readonly publish?: () => Promise<void>; readonly apply?: () => Promise<void> } = {},
  ): SyncDependencies {
    return {
      readConfig: () => ({ ...config, host: { transport: "ssh", destination } }),
      publisher: () => "operator-machine",
      readSeed: () => seed,
      createLink: () => ({
        run: async (command) => {
          const home = command.startsWith("printf");
          events.push(`${destination}:${home ? "resolve-home" : "box-command"}`);
          return { ok: true, address: destination, stdout: home ? "/srv/ferry\n" : "", stderr: "" };
        },
      }),
      openStore: async () => ({
        path: join(home, ".ferry", "store"),
        publish: async () => {
          events.push(`${destination}:publish`);
          await hooks.publish?.();
          events.push(`${destination}:published`);
          return { published: true, tip: "abc123" };
        },
      }),
      apply: async (input) => {
        events.push(`${destination}:apply`);
        await hooks.apply?.();
        events.push(`${destination}:applied`);
        return { checkout: input.checkout, targetHome: input.targetHome, actions: [], unmanaged: [] };
      },
      adopt: () => {
        events.push(`${destination}:adopt`);
      },
      writePlan: () => {},
    };
  }

  test("serializes two publishes on the store lock", async () => {
    const home = mkdtempSync(join(tmpdir(), "ferry-sync-store-lock-"));
    const events: string[] = [];
    const publishing = deferred();
    const release = deferred();
    try {
      const first = runSync(
        { home },
        lockedSync(home, "a@box-a", events, {
          publish: async () => {
            publishing.resolve();
            await release.promise;
          },
        }),
      );
      await publishing.promise;
      expect(readdirSync(join(home, ".ferry"))).toEqual(["store.lock"]);

      const second = runSync({ home }, lockedSync(home, "b@box-b", events));
      await new Promise((done) => setTimeout(done, 300));
      expect(events.filter((event) => event.endsWith(":publish"))).toEqual(["a@box-a:publish"]);

      release.resolve();
      await Promise.all([first, second]);
      expect(events.filter((event) => /:publish(ed)?$/.test(event))).toEqual([
        "a@box-a:publish",
        "a@box-a:published",
        "b@box-b:publish",
        "b@box-b:published",
      ]);
      expect(readdirSync(join(home, ".ferry"))).toEqual([]);
    } finally {
      release.resolve();
      rmSync(home, { recursive: true, force: true });
    }
  });

  test("runs the box steps of two targets in parallel", async () => {
    const home = mkdtempSync(join(tmpdir(), "ferry-sync-box-locks-"));
    const events: string[] = [];
    const firstApplying = deferred();
    const secondApplied = deferred();
    try {
      const first = runSync(
        { home },
        lockedSync(home, "a@box-a", events, {
          apply: async () => {
            firstApplying.resolve();
            await secondApplied.promise;
          },
        }),
      );
      await firstApplying.promise;
      expect(readdirSync(join(home, ".ferry"))).toEqual([boxLockFile("ssh:a@box-a")]);

      const second = runSync(
        { home },
        lockedSync(home, "b@box-b", events, { apply: async () => secondApplied.resolve() }),
      );
      await Promise.all([first, second]);

      expect(events.indexOf("b@box-b:applied")).toBeLessThan(events.indexOf("a@box-a:applied"));
      expect(readdirSync(join(home, ".ferry"))).toEqual([]);
    } finally {
      secondApplied.resolve();
      rmSync(home, { recursive: true, force: true });
    }
  });

  test("refuses a second sync for the same target before it publishes, with the old lock file name", async () => {
    const home = mkdtempSync(join(tmpdir(), "ferry-sync-same-box-"));
    const events: string[] = [];
    const secondEvents: string[] = [];
    const applying = deferred();
    const release = deferred();
    try {
      const first = runSync(
        { home },
        lockedSync(home, "a@box-a", events, {
          apply: async () => {
            applying.resolve();
            await release.promise;
          },
        }),
      );
      await applying.promise;
      expect(readdirSync(join(home, ".ferry"))).toEqual([boxLockFile("ssh:a@box-a")]);

      await expect(runSync({ home }, lockedSync(home, "a@box-a", secondEvents))).rejects.toEqual(
        expect.objectContaining({
          code: "concurrent-sync",
          origin: "operator",
          message: expect.stringContaining("a@box-a"),
        }),
      );
      expect(secondEvents).toEqual([]);

      release.resolve();
      await first;
      expect(readdirSync(join(home, ".ferry"))).toEqual([]);
    } finally {
      release.resolve();
      rmSync(home, { recursive: true, force: true });
    }
  });

  test("refuses a sync after the publish when another sync takes the box lock after the check", async () => {
    const home = mkdtempSync(join(tmpdir(), "ferry-sync-box-race-"));
    const events: string[] = [];
    try {
      await expect(
        runSync(
          { home },
          {
            ...lockedSync(home, "a@box-a", events),
            acquireLock: (_home, host) => {
              throw new SyncError("concurrent-sync", "operator", `another sync is active for ${host}`);
            },
          },
        ),
      ).rejects.toEqual(expect.objectContaining({ code: "concurrent-sync" }));
      expect(events).toEqual(["a@box-a:publish", "a@box-a:published", "a@box-a:adopt"]);
      expect(readdirSync(join(home, ".ferry"))).toEqual([]);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test("changes no box when the publish fails, and releases the store lock", async () => {
    const home = mkdtempSync(join(tmpdir(), "ferry-sync-publish-failure-"));
    const events: string[] = [];
    try {
      await expect(
        runSync(
          { home },
          {
            ...lockedSync(home, "a@box-a", events),
            openStore: async () => {
              throw new Error("push rejected");
            },
            acquireLock: () => {
              events.push("box-lock");
              return () => {};
            },
          },
        ),
      ).rejects.toEqual(expect.objectContaining({ code: "publish-failure" }));
      expect(events).toEqual([]);
      expect(readdirSync(join(home, ".ferry"))).toEqual([]);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test("recovers a store lock and a box lock left by a dead process", async () => {
    const home = mkdtempSync(join(tmpdir(), "ferry-sync-stale-locks-"));
    const events: string[] = [];
    try {
      mkdirSync(join(home, ".ferry"));
      writeFileSync(join(home, ".ferry", "store.lock"), JSON.stringify({ pid: 999_999_999 }));
      writeFileSync(join(home, ".ferry", boxLockFile("ssh:a@box-a")), JSON.stringify({ pid: 999_999_999 }));

      await runSync({ home }, lockedSync(home, "a@box-a", events));

      expect(events).toContain("a@box-a:applied");
      expect(readdirSync(join(home, ".ferry"))).toEqual([]);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});

describe("sync with more than one box", () => {
  const homes: string[] = [];
  afterEach(() => {
    for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true });
  });

  function box(name: string, paseo?: boolean) {
    return {
      name,
      host: { transport: "ssh" as const, destination: `dev@box-${name}.example` },
      ...(paseo === undefined ? {} : { integrations: { paseo } }),
    };
  }

  /** Box a has Paseo on from `[integrations]`. Box b turns it off. */
  const fleetConfig = {
    version: 1 as const,
    publisher: "operator-machine",
    snapshotUrl: "git@example.test:operator/ferry-store.git",
    integrations: { paseo: true },
    boxes: [box("a"), box("b", false)],
  };

  function fleet(
    options: {
      readonly config?: typeof fleetConfig;
      readonly offline?: readonly string[];
      readonly apply?: (box: string) => Promise<void>;
      readonly publish?: () => Promise<{ published: boolean; tip: string | null }>;
    } = {},
  ) {
    const home = mkdtempSync(join(tmpdir(), "ferry-sync-fleet-"));
    homes.push(home);
    const events: string[] = [];
    const lines: string[] = [];
    const steps: string[] = [];
    const nameOf = (destination: string) => /box-([a-z0-9-]+)\./.exec(destination)?.[1] ?? destination;
    const dependencies: SyncDependencies = {
      readConfig: () => options.config ?? fleetConfig,
      publisher: () => "operator-machine",
      readSeed: () => seed,
      createLink: (target) => {
        const name = nameOf((target as { destination: string }).destination);
        events.push(`${name}:link`);
        return {
          run: async (command) => {
            if (command.startsWith("printf")) {
              events.push(`${name}:resolve-home`);
              if (options.offline?.includes(name)) {
                return { ok: false, error: { origin: "network", code: "host-offline", message: "no route" } } as LinkResult;
              }
              return { ok: true, address: name, stdout: `/home/${name}\n`, stderr: "" };
            }
            if (command.includes("git clone")) events.push(`${name}:update`);
            return { ok: true, address: name, stdout: "", stderr: "" };
          },
        };
      },
      openStore: async () => ({
        path: join(home, ".ferry", "store"),
        publish: async () => {
          events.push("publish");
          return (await options.publish?.()) ?? { published: true, tip: "abc123" };
        },
      }),
      apply: async (input) => {
        const name = posix.basename(input.targetHome);
        events.push(`${name}:apply`);
        await options.apply?.(name);
        events.push(`${name}:applied`);
        return { checkout: input.checkout, targetHome: input.targetHome, actions: [], unmanaged: [] };
      },
      adopt: () => {
        events.push("adopt");
      },
      writeLine: (line) => lines.push(line),
      progress: { ...noProgress, start: (step) => steps.push(step) },
    };
    return { home, events, lines, steps, dependencies };
  }

  test("an off agent: Manifest reads its harness only while a box has it on, and Apply cleans it up on the box where it is off", async () => {
    const offConfig = {
      ...fleetConfig,
      tools: { pi: "off" },
      boxes: [box("a"), { ...box("b", false), tools: { pi: "latest", claude: "off" } }],
    };
    const { home, dependencies, lines } = fleet({ config: offConfig as typeof fleetConfig });
    let read: readonly string[] = [];
    let adopted: readonly string[] = [];
    const applied = new Map<string, { harnesses: readonly string[]; off: readonly string[] }>();

    const result = await runSync({ home }, {
      ...dependencies,
      readSeed: (_home, harnesses) => {
        read = harnesses.map((harness) => harness.id);
        return seed;
      },
      adopt: (_home, _store, harnesses) => {
        adopted = harnesses.map((harness) => harness.id);
      },
      apply: async (input) => {
        applied.set(posix.basename(input.targetHome), {
          harnesses: input.harnesses.map((harness) => harness.id),
          off: (input.offHarnesses ?? []).map((harness) => harness.id),
        });
        return { checkout: input.checkout, targetHome: input.targetHome, actions: [], unmanaged: [] };
      },
    });

    expect(read).toEqual(["agents", "claude", "codex", "pi", "cursor"]);
    expect(adopted).toEqual(read);
    expect(applied.get("a")).toEqual({ harnesses: ["agents", "claude", "codex", "cursor"], off: ["pi"] });
    expect(applied.get("b")).toEqual({ harnesses: ["agents", "codex", "pi", "cursor"], off: ["claude"] });
    expect(result.boxes.map((entry) => [entry.name, entry.plan.offHarnesses])).toEqual([["a", ["pi"]], ["b", ["claude"]]]);
    expect(lines.join("\n")).toContain("[a] Off harnesses: pi. Apply writes nothing there and removes only its own earlier links");
    expect(lines.join("\n")).toContain("[b] Off harnesses: claude. Apply writes nothing there and removes only its own earlier links");
  });

  test("an agent that is off on every box is not read on this machine, also with --box", async () => {
    const offConfig = { ...fleetConfig, tools: { pi: "off" } };
    const { home, dependencies } = fleet({ config: offConfig as typeof fleetConfig });
    let read: readonly string[] = [];

    await runSync({ home, boxes: ["b"], dryRun: true }, {
      ...dependencies,
      readSeed: (_home, harnesses) => {
        read = harnesses.map((harness) => harness.id);
        return seed;
      },
    });

    expect(read).toEqual(["agents", "claude", "codex", "cursor"]);
  });

  test("an off agent gets no plugins, settings, or MCP servers on the box", async () => {
    const offConfig = { ...fleetConfig, tools: { claude: "off", cursor: "off" }, boxes: [box("a")] };
    const { home, dependencies, lines } = fleet({ config: offConfig as typeof fleetConfig });
    const commands: string[] = [];
    const settings = { harness: "claude", bytes: new TextEncoder().encode('{"enabledPlugins":{"tdd@market":true}}') };
    const mcp = [
      { harness: "claude", servers: [{ name: "linear", type: "http", url: "https://mcp.linear.app/mcp" }] },
      { harness: "cursor", servers: [{ name: "linear", type: "http", url: "https://mcp.linear.app/mcp" }] },
    ];

    await runSync({ home }, {
      ...dependencies,
      readSeed: () => ({ ...seed, settings: [settings], mcp } as unknown as Seed),
      createLink: (target) => {
        const inner = dependencies.createLink!(target);
        return {
          run: async (command, options) => {
            commands.push(command);
            return inner.run(command, options);
          },
        };
      },
    });

    expect(commands.some((command) => /claude|cursor|settings\.json|mcp/.test(command))).toBe(false);
    expect(lines.join("\n")).toContain("\nMCP servers: declare on the box, and keep the other box servers: none\n");
  });

  function deferred(): { readonly promise: Promise<void>; readonly resolve: () => void } {
    let resolve = () => {};
    const promise = new Promise<void>((done) => {
      resolve = done;
    });
    return { promise, resolve };
  }

  test("publishes once, syncs two boxes in parallel, then adopts once", async () => {
    const bApplied = deferred();
    const sync = fleet({
      apply: async (name) => {
        if (name === "a") await bApplied.promise;
        else bApplied.resolve();
      },
    });

    const result = await runSync({ home: sync.home }, sync.dependencies);

    expect(sync.events.filter((event) => event === "publish")).toHaveLength(1);
    expect(sync.events.indexOf("publish")).toBeLessThan(sync.events.indexOf("a:link"));
    expect(sync.events.indexOf("b:applied")).toBeLessThan(sync.events.indexOf("a:applied"));
    expect(sync.events.filter((event) => event === "adopt")).toEqual(["adopt"]);
    expect(sync.events.at(-1)).toBe("adopt");
    expect(result.boxes.map((entry) => [entry.name, entry.plan.box, entry.plan.remoteHome, entry.failure])).toEqual([
      ["a", "dev@box-a.example", "/home/a", undefined],
      ["b", "dev@box-b.example", "/home/b", undefined],
    ]);
    expect(readdirSync(join(sync.home, ".ferry"))).toEqual([]);
  });

  test("without a publish, updates only the selected box to the upstream tip and still adopts", async () => {
    const sync = fleet();
    const commands: string[] = [];
    const createLink = sync.dependencies.createLink!;
    const dependencies: SyncDependencies = {
      ...sync.dependencies,
      createLink: (target) => {
        const link = createLink(target);
        return { run: (command, options) => (commands.push(command), link.run(command, options)) };
      },
    };

    const result = await runSync({ home: sync.home, boxes: ["b"], publish: false }, dependencies);

    expect(result.published).toBe(false);
    expect(sync.events).toEqual(["b:link", "b:resolve-home", "b:update", "b:apply", "b:applied", "adopt"]);
    expect(sync.steps).not.toContain("Publishing the snapshot");
    expect(commands.filter((command) => command.includes("git clone"))).toEqual([
      remoteUpdateCommand("/home/b/.ferry/store", fleetConfig.snapshotUrl, null),
    ]);
    expect(readdirSync(join(sync.home, ".ferry"))).toEqual([]);
  });

  test("syncs the other box when one box is offline, adopts once, and names the failed box and step", async () => {
    const sync = fleet({ offline: ["b"] });

    const error = await runSync({ home: sync.home }, sync.dependencies).then(
      () => null,
      (cause: unknown) => cause,
    );

    expect(error).toBeInstanceOf(SyncError);
    expect(error).toMatchObject({ code: "box-failure", origin: "box" });
    expect((error as Error).message).toBe(
      "box: sync failed on 1 of 2 boxes.\n[b] Connecting to dev@box-b.example: box: failed to resolve home on dev@box-b.example: network/host-offline: no route",
    );
    expect(sync.events).toContain("a:applied");
    expect(sync.events.filter((event) => event.startsWith("b:"))).toEqual(["b:link", "b:resolve-home"]);
    expect(sync.events.filter((event) => event === "adopt")).toHaveLength(1);
    expect(readdirSync(join(sync.home, ".ferry"))).toEqual([]);
  });

  test("the CLI exits 1 when one box fails", async () => {
    const sync = fleet({ offline: ["b"] });
    let exitCode = 0;
    const { runCli } = await import("../src/cli.ts");

    await runCli(["sync"], {
      readConfig: () => fleetConfig,
      createProgress: () => noProgress,
      writeLine: () => {},
      runSync: (input, dependencies) => runSync({ ...input, home: sync.home }, { ...dependencies, ...sync.dependencies }),
    }, { renderError: () => {}, setExitCode: (code) => (exitCode = code) });

    expect(exitCode).toBe(1);
    expect(sync.events).toContain("a:applied");
  });

  test("refuses before the publish and names the box when a sync is active for one box", async () => {
    const sync = fleet();
    const digest = createHash("sha256").update("ssh:dev@box-b.example").digest("hex").slice(0, 16);
    mkdirSync(join(sync.home, ".ferry"));
    writeFileSync(join(sync.home, ".ferry", `sync-${digest}.lock`), JSON.stringify({ pid: process.pid }));

    await expect(runSync({ home: sync.home }, sync.dependencies)).rejects.toEqual(
      expect.objectContaining({
        code: "concurrent-sync",
        message: "operator: another sync is active for box b (ssh:dev@box-b.example)",
      }),
    );
    expect(sync.events).toEqual([]);
  });

  test("changes no box when the publish fails", async () => {
    const sync = fleet({
      publish: async () => {
        throw new Error("push rejected");
      },
    });

    await expect(runSync({ home: sync.home }, sync.dependencies)).rejects.toEqual(
      expect.objectContaining({ code: "publish-failure" }),
    );
    expect(sync.events).toEqual(["publish"]);
  });

  test("runs the Paseo steps only on a box with Paseo on", async () => {
    const sync = fleet();

    await runSync({ home: sync.home }, sync.dependencies);

    expect(sync.steps.filter((step) => step.includes("Paseo"))).toEqual([
      "[a] Carrying Paseo agent profiles",
      "[a] Updating the Paseo unit PATH",
    ]);
  });

  test("puts the box name before each box step and each box line", async () => {
    const sync = fleet();

    await runSync({ home: sync.home }, sync.dependencies);

    expect(sync.steps.filter((step) => step.startsWith("[b] "))).toEqual([
      "[b] Connecting to dev@box-b.example",
      "[b] Updating the box checkout",
      "[b] Writing the box instructions",
      "[b] Applying the snapshot on the box",
      "[b] Installing Claude plugins",
      "[b] Merging settings on the box",
      "[b] Declaring MCP servers",
      "[b] Writing the box PATH",
    ]);
    expect(sync.steps.filter((step) => !step.startsWith("["))).toEqual([
      "Reading the portable set",
      "Publishing the snapshot",
      "Adopting published local skills",
    ]);
    const plan = sync.lines.find((line) => line.startsWith("[b] Sync plan:"))?.split("\n") ?? [];
    expect(plan).toContain("[b] Box: dev@box-b.example");
    expect(plan.every((line) => line.startsWith("[b] "))).toBe(true);
  });

  test("keeps the output of one selected box without a prefix", async () => {
    const sync = fleet();

    await runSync({ home: sync.home, boxes: ["b"] }, sync.dependencies);

    expect(sync.steps).toEqual([
      "Reading the portable set",
      "Publishing the snapshot",
      "Connecting to dev@box-b.example",
      "Updating the box checkout",
      "Writing the box instructions",
      "Applying the snapshot on the box",
      "Installing Claude plugins",
      "Merging settings on the box",
      "Declaring MCP servers",
      "Writing the box PATH",
      "Adopting published local skills",
    ]);
    expect(sync.lines.find((line) => line.startsWith("Sync plan:"))).toContain("Box: dev@box-b.example");
    expect(sync.events.some((event) => event.startsWith("a:"))).toBe(false);
  });

  test("forwards no agent to a git_auth = box box and reads the snapshot with its deploy key", async () => {
    const config = { ...fleetConfig, boxes: [box("a"), { ...box("b"), gitAuth: "box" as const }] };
    const sync = fleet({ config });
    const updates: Array<{ box: string; command: string; options: unknown }> = [];
    const createLink = sync.dependencies.createLink!;
    const dependencies: SyncDependencies = {
      ...sync.dependencies,
      createLink: (target) => {
        const inner = createLink(target);
        const name = (target as { destination: string }).destination;
        return {
          run: (command, options) => {
            if (command.includes("clone")) updates.push({ box: name, command, options });
            return inner.run(command, options);
          },
        };
      },
    };

    await runSync({ home: sync.home }, dependencies);

    const [a, b] = [...updates].sort((left, right) => left.box.localeCompare(right.box));
    expect(a?.options).toEqual({ agentForwarding: "git" });
    expect(a?.command).not.toContain("core.sshCommand");
    expect(b?.options).toBeUndefined();
    expect(b?.command).toContain(
      "git -c core.sshCommand='ssh -i ~/.ssh/ferry_snapshot -o IdentitiesOnly=yes' -C '/home/b/.ferry/store' fetch --quiet",
    );
    expect(b?.command).toContain(
      "git -c core.sshCommand='ssh -i ~/.ssh/ferry_snapshot -o IdentitiesOnly=yes' clone 'git@example.test:operator/ferry-store.git'",
    );
  });

  test("refuses an unknown box before it publishes", async () => {
    const sync = fleet();

    const error = await runSync({ home: sync.home, boxes: ["c"] }, sync.dependencies).catch((caught: unknown) => caught);
    expect(error).toEqual(expect.objectContaining({ code: "invalid-config", message: expect.stringContaining("unknown box c") }));
    expect(errorInfo(error).code).toBe("unknown-box");
    expect(sync.events).toEqual([]);
  });

  test("runs at most 4 boxes at the same time", async () => {
    const config = { ...fleetConfig, boxes: ["a", "b", "c", "d", "e", "f"].map((name) => box(name)) };
    let active = 0;
    let most = 0;
    const sync = fleet({
      config,
      apply: async () => {
        active += 1;
        most = Math.max(most, active);
        await new Promise((done) => setTimeout(done, 20));
        active -= 1;
      },
    });

    const result = await runSync({ home: sync.home }, sync.dependencies);

    expect(most).toBe(4);
    expect(result.boxes.map((entry) => entry.name)).toEqual(["a", "b", "c", "d", "e", "f"]);
  });

  test("the dry run prints one plan for each box and stays offline", async () => {
    const sync = fleet();
    const plans: SyncPlan[] = [];

    const result = await runSync(
      { home: sync.home, dryRun: true },
      { ...sync.dependencies, writePlan: (plan) => plans.push(plan) },
    );

    expect(sync.events).toEqual([]);
    expect(plans.map((plan) => [plan.box, plan.paseoProfiles])).toEqual([
      ["dev@box-a.example", []],
      ["dev@box-b.example", null],
    ]);
    expect(result.boxes.map((entry) => entry.plan)).toEqual(plans);
  });

  test("the plan of each box names its SSH agent forwarding", async () => {
    const config = { ...fleetConfig, boxes: [box("a"), { ...box("b", false), gitAuth: "box" as const }] };
    const sync = fleet({ config });

    await runSync({ home: sync.home, dryRun: true }, sync.dependencies);

    expect(sync.lines.flatMap((line) => line.split("\n")).filter((line) => line.includes("SSH agent forwarding"))).toEqual([
      "[a] SSH agent forwarding: only for the box snapshot update and the Claude plugin installs",
      "[b] SSH agent forwarding: none (git_auth = box)",
    ]);
  });
});

describe("sync with per-box instructions", () => {
  const homes: string[] = [];
  afterEach(() => {
    for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true });
  });

  const fleetConfig = {
    version: 1 as const,
    publisher: "operator-machine",
    snapshotUrl: "git@example.test:operator/ferry-store.git",
    boxes: ["a", "b"].map((name) => ({ name, host: { transport: "ssh" as const, destination: `dev@box-${name}.example` } })),
  };
  // Build the token at run time so this file holds no string a secret scanner flags.
  const token = "gh" + "p_" + "a1B2".repeat(9);

  /**
   * Two boxes whose homes are directories of the temporary root. Each box has
   * the shared instructions in its checkout. The fake link runs the command
   * that writes the box files with `sh`, and records the other commands.
   */
  function fleet(perBox: Readonly<Record<string, string>>, shared: string | null = "shared\n") {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "ferry-sync-box-instructions-")));
    homes.push(root);
    const home = join(root, "operator");
    for (const [name, text] of Object.entries(perBox)) {
      mkdirSync(join(home, ".ferry", "boxes", name), { recursive: true });
      writeFileSync(join(home, ".ferry", "boxes", name, "AGENTS.md"), text);
    }
    const boxHome = (name: string) => join(root, `box-${name}`);
    for (const { name } of fleetConfig.boxes) {
      mkdirSync(join(boxHome(name), ".ferry", "store"), { recursive: true });
      if (shared !== null) writeFileSync(join(boxHome(name), ".ferry", "store", "AGENTS.md"), shared);
    }
    const commands: string[] = [];
    const events: string[] = [];
    const lines: string[] = [];
    const dependencies: SyncDependencies = {
      readConfig: () => fleetConfig,
      publisher: () => "operator-machine",
      readSeed: () => ({ ...seed, instructions: shared === null ? null : { bytes: new TextEncoder().encode(shared) } }),
      createLink: (target) => {
        const name = /box-([a-z]+)\./.exec((target as { destination: string }).destination)![1]!;
        return {
          run: async (command, options) => {
            commands.push(command);
            if (command.startsWith("printf")) return { ok: true, address: name, stdout: `${boxHome(name)}\n`, stderr: "" };
            if (command.includes("ferry_dir=")) {
              const child = Bun.spawn(["sh", "-c", command], { stdin: options?.input ?? "ignore", stdout: "pipe", stderr: "pipe" });
              expect(await child.exited).toBe(0);
            }
            return { ok: true, address: name, stdout: "", stderr: "" };
          },
        };
      },
      openStore: async () => ({
        path: join(home, ".ferry", "store"),
        publish: async () => {
          events.push("publish");
          return { published: true, tip: "abc123" };
        },
      }),
      apply: async (input) => {
        events.push(`${posix.basename(input.targetHome)}:apply`);
        return { checkout: input.checkout, targetHome: input.targetHome, actions: [], unmanaged: [] };
      },
      adopt: () => {},
      writePlan: () => {},
      writeLine: (line) => lines.push(line),
    };
    const generated = (name: string) => readFileSync(join(boxHome(name), ".ferry", "box", "AGENTS.md"), "utf8");
    return { home, commands, events, lines, dependencies, generated };
  }

  test("puts the per-box file between the header and the shared instructions on its box, and on no other box", async () => {
    const { home, commands, dependencies, generated } = fleet({ a: "Use the GPU here.\n" });

    const result = await runSync({ home }, dependencies);

    expect(generated("a")).toBe(`${boxInstructionsHeader("a")}\n\nUse the GPU here.\n\nshared\n`);
    expect(generated("b")).toBe(`${boxInstructionsHeader("b")}\n\nshared\n`);
    // The text goes on the standard input, so no box command holds it.
    expect(commands.join("\n")).not.toContain("GPU");
    expect(result.boxes.map((box) => box.plan.boxInstructions)).toEqual([join(home, ".ferry/boxes/a/AGENTS.md"), undefined]);
  });

  test("an empty per-box file adds nothing", async () => {
    const { home, dependencies, generated } = fleet({ a: "", b: "\n \n" });

    await runSync({ home }, dependencies);

    expect(generated("a")).toBe(`${boxInstructionsHeader("a")}\n\nshared\n`);
    expect(generated("b")).toBe(`${boxInstructionsHeader("b")}\n\nshared\n`);
  });

  test("a per-box file with a secret stops the sync of that box only, with the file name and never the value", async () => {
    const { home, commands, events, dependencies, generated } = fleet({ a: `Log in with ${token}.\n`, b: "Do not run Docker here.\n" });

    const error = await runSync({ home }, dependencies).catch((cause: unknown) => cause);

    expect(error).toBeInstanceOf(BoxesSyncError);
    const { results, message } = error as BoxesSyncError;
    expect(results.map((result) => [result.name, result.failure?.step])).toEqual([["a", "Reading the box instructions"], ["b", undefined]]);
    expect(results[0]!.failure!.error).toMatchObject({ code: "box-instructions-refusal", origin: "operator" });
    expect(errorInfo(results[0]!.failure!.error).code).toBe("deny-rule-match");
    expect(message).toContain(`GitHub token in file content: ${join(home, ".ferry/boxes/a/AGENTS.md")}`);
    expect(message).not.toContain(token);
    expect(commands.join("\n")).not.toContain(token);
    // Ferry does not connect to the refused box.
    expect(events).toEqual(["publish", "box-b:apply"]);
    expect(existsSync(join(home, "..", "box-a", ".ferry", "box"))).toBe(false);
    expect(generated("b")).toBe(`${boxInstructionsHeader("b")}\n\nDo not run Docker here.\n\nshared\n`);
  });

  test("a secret in the per-box file of a box that is not selected does not stop the sync", async () => {
    const { home, dependencies, generated } = fleet({ a: `Log in with ${token}.\n` });

    await runSync({ home, boxes: ["b"] }, dependencies);

    expect(generated("b")).toBe(`${boxInstructionsHeader("b")}\n\nshared\n`);
  });

  test("the dry run names the per-box file of its box and refuses a secret", async () => {
    const plans: string[] = [];
    const clean = fleet({ a: "Use the GPU here.\n" });
    const { writePlan: _writePlan, ...printed } = clean.dependencies;
    await runSync({ home: clean.home, dryRun: true }, { ...printed, writeLine: (line) => plans.push(line) });

    const file = join(clean.home, ".ferry/boxes/a/AGENTS.md");
    expect(plans.filter((line) => line.includes("Box instructions:"))).toHaveLength(1);
    expect(plans.find((line) => line.startsWith("[a] Sync plan:"))).toContain(
      `[a] Box instructions: ${file} -> $HOME/.ferry/box/AGENTS.md, between the Ferry header and the shared AGENTS.md`,
    );
    expect(plans.join("\n")).not.toContain("GPU");

    const secret = fleet({ a: `Log in with ${token}.\n` });
    const error = await runSync({ home: secret.home, dryRun: true }, secret.dependencies).catch((cause: unknown) => cause);
    expect(error).toMatchObject({ code: "box-instructions-refusal" });
    expect((error as Error).message).toContain(join(secret.home, ".ferry/boxes/a/AGENTS.md"));
    expect((error as Error).message).not.toContain(token);
  });

  test("warns when the operator machine has no shared instructions, because the box then has no instruction file", async () => {
    const { home, lines, dependencies } = fleet({ a: "Use the GPU here.\n" }, null);

    await runSync({ home }, dependencies);

    expect(lines).toContain(
      `[a] Warning: Ferry did not apply ${join(home, ".ferry/boxes/a/AGENTS.md")}, because this machine has no ~/AGENTS.md. The box gets no instruction file.`,
    );
    expect(existsSync(join(home, "..", "box-a", ".ferry", "box", "AGENTS.md"))).toBe(false);
    expect(JSON.parse(readFileSync(join(home, "..", "box-a", ".ferry", "box", "identity.json"), "utf8"))).toEqual({ name: "a", boxInstructions: false });
  });
});
