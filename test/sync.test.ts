import { describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ApplyError } from "../src/apply.ts";
import type { OperatorConfig } from "../src/config.ts";
import type { Seed } from "../src/manifest.ts";
import { loadRegistry, type RegistryConfig } from "../src/registry/load.ts";
import type { LinkResult } from "../src/link.ts";
import type { HarnessDescriptor } from "../src/registry/types.ts";
import { remoteUpdateCommand, runSync, type SyncDependencies } from "../src/sync.ts";

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
  identity: "seed-identity",
  leftovers: [],
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

  test("uses a direct SSH destination for Link, plans, and locking", async () => {
    const directConfig: OperatorConfig = {
      ...config,
      host: { transport: "ssh", destination: "ubuntu@orb" },
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
                address: "ubuntu@orb",
                stdout: linkCalls === 1 ? "/home/davidhoeck\n" : "",
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

    expect(linkOptions).toEqual({ destination: "ubuntu@orb" });
    expect(result.plan).toMatchObject({
      box: "ubuntu@orb",
      remoteHome: "/home/davidhoeck",
      remoteCheckout: "/home/davidhoeck/.ferry/store",
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
