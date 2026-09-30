import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { adoptPublishedSkills } from "../src/adopt.ts";
import type { OperatorConfig } from "../src/config.ts";
import { errorInfo } from "../src/output.ts";
import { runHistory, runRevert, type RevertDependencies } from "../src/revert.ts";
import { openStore } from "../src/store.ts";
import { inspectSyncSource, runSync, type SyncResult } from "../src/sync.ts";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

/** The keys of the local Claude settings file that Ferry does not carry. */
const uncarried = { env: { EXAMPLE_TOKEN_NAME: "local only" }, theme: "dark" };

async function git(cwd: string, ...args: string[]): Promise<string> {
  const process = Bun.spawn(["git", ...args], { cwd, stdout: "pipe", stderr: "pipe" });
  const [status, stdout, stderr] = await Promise.all([
    process.exited,
    new Response(process.stdout).text(),
    new Response(process.stderr).text(),
  ]);
  if (status !== 0) throw new Error(`git ${args.join(" ")}: ${stderr}`);
  return stdout.trim();
}

/**
 * A home whose store holds three commits: the first snapshot, a settings
 * change of `model` to sonnet, and a skill change to v2.
 */
async function snapshotHome() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "ferry-revert-")));
  roots.push(root);
  const remote = join(root, "remote.git");
  const home = join(root, "home");
  const store = join(home, ".ferry", "store");
  await git(root, "init", "--quiet", "--bare", remote);
  mkdirSync(join(home, ".ferry"), { recursive: true });
  await git(root, "clone", "--quiet", remote, store);
  await git(store, "config", "user.name", "Ferry Test");
  await git(store, "config", "user.email", "operator@example.com");
  await git(store, "config", "commit.gpgsign", "false");

  const config: OperatorConfig = {
    version: 1,
    publisher: "operator-machine",
    snapshotUrl: remote,
    host: { tailscale: "box", sshUser: "ferry" },
  };
  const dependencies: RevertDependencies = {
    readConfig: () => config,
    publisher: () => "operator-machine",
    writeLine: () => {},
  };
  const settingsFile = join(home, ".claude", "settings.json");
  const writeSettings = (model: string) =>
    writeFileSync(
      settingsFile,
      `${JSON.stringify({ model, permissions: { allow: ["Bash(git status)"] }, ...uncarried }, null, 2)}\n`,
    );
  /** Publish the local files as `ferry sync` does, without the boxes. */
  const publish = async (message: string) => {
    const source = inspectSyncSource(home, dependencies);
    const opened = await openStore(remote, source.seed, { home, harnesses: source.registry.harnesses });
    const result = await opened.publish(source.seed, message);
    adoptPublishedSkills(home, store, source.harnesses, source.seed);
    return result;
  };

  mkdirSync(join(home, ".claude", "skills", "tdd"), { recursive: true });
  writeFileSync(join(home, ".claude", "skills", "tdd", "SKILL.md"), "v1\n");
  writeSettings("opus");
  await publish("chore: first snapshot");
  writeSettings("sonnet");
  await publish("chore: use sonnet");
  const settingsCommit = await git(store, "rev-parse", "HEAD");
  // The skill is a link into the store now, so this edit changes the store copy.
  writeFileSync(join(home, ".claude", "skills", "tdd", "SKILL.md"), "v2\n");
  await publish("chore: skill v2");

  return { root, remote, home, store, settingsFile, settingsCommit, dependencies, publish, writeSettings };
}

describe("ferry revert", () => {
  test("reverts a settings key in the local file and keeps the other keys and later commits", async () => {
    const setup = await snapshotHome();
    const before = JSON.parse(readFileSync(setup.settingsFile, "utf8"));
    const syncs: unknown[] = [];

    const result = await runRevert(
      { home: setup.home, commit: setup.settingsCommit.slice(0, 12) },
      {
        ...setup.dependencies,
        runSync: async (input) => {
          syncs.push(input);
          return { dryRun: false, published: false, boxes: [] } as unknown as SyncResult;
        },
      },
    );

    expect(result.paths).toEqual(["settings/claude.json"]);
    expect(result.settings).toEqual([{ file: ".claude/settings.json", keys: ["model"] }]);
    const after = JSON.parse(readFileSync(setup.settingsFile, "utf8"));
    expect(after).toEqual({ ...before, model: "opus" });
    expect(after.env).toEqual(uncarried.env);
    expect(after.theme).toBe("dark");
    // The later skill commit stays.
    expect(readFileSync(join(setup.home, ".claude", "skills", "tdd", "SKILL.md"), "utf8")).toBe("v2\n");
    expect(await git(setup.remote, "rev-parse", "HEAD")).toBe(result.tip as string);
    expect(await git(setup.store, "log", "-n", "1", "--format=%s")).toBe("revert: chore: use sonnet");
    expect(syncs).toEqual([{ home: setup.home, command: "revert" }]);
    // The local files match the snapshot, so the next watch or sync publishes nothing.
    expect((await setup.publish("chore: after revert")).published).toBe(false);
  });

  test("a sync that read the files before a revert does not publish them after it", async () => {
    const setup = await snapshotHome();
    let revertTip: string | null = null;

    // The sync reads the files first. The revert runs while the sync waits for the store lock.
    const error = await runSync(
      { home: setup.home },
      {
        readConfig: setup.dependencies.readConfig,
        publisher: setup.dependencies.publisher,
        writeLine: () => {},
        acquireStoreLock: async () => {
          const reverted = await runRevert(
            { home: setup.home, commit: setup.settingsCommit, sync: false },
            { ...setup.dependencies, acquireStoreLock: async () => () => {} },
          );
          revertTip = reverted.tip;
          return () => {};
        },
        createLink: () => {
          throw new Error("no box in this test");
        },
      },
    ).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(Error);
    expect(revertTip).not.toBeNull();
    expect(await git(setup.remote, "rev-parse", "HEAD")).toBe(revertTip as unknown as string);
    expect(JSON.parse(await git(setup.store, "show", "HEAD:settings/claude.json")).model).toBe("opus");
    expect(JSON.parse(readFileSync(setup.settingsFile, "utf8")).model).toBe("opus");
  });

  test("reverts a skill commit through the store link", async () => {
    const setup = await snapshotHome();
    const skillCommit = await git(setup.store, "rev-parse", "HEAD");

    await runRevert({ home: setup.home, commit: skillCommit, sync: false }, setup.dependencies);

    expect(readFileSync(join(setup.home, ".claude", "skills", "tdd", "SKILL.md"), "utf8")).toBe("v1\n");
    expect(JSON.parse(readFileSync(setup.settingsFile, "utf8")).model).toBe("sonnet");
    expect((await setup.publish("chore: after revert")).published).toBe(false);
  });

  test("stops at a conflict with a later commit and changes nothing", async () => {
    const setup = await snapshotHome();
    setup.writeSettings("haiku");
    await setup.publish("chore: use haiku");
    const tip = await git(setup.store, "rev-parse", "HEAD");
    const settings = readFileSync(setup.settingsFile, "utf8");

    const error = await runRevert({ home: setup.home, commit: setup.settingsCommit }, setup.dependencies).catch(
      (caught: unknown) => caught,
    );

    expect(errorInfo(error).code).toBe("refused");
    expect(errorInfo(error).message).toContain("settings/claude.json");
    expect(await git(setup.store, "rev-parse", "HEAD")).toBe(tip);
    expect(await git(setup.store, "status", "--porcelain")).toBe("");
    expect(readFileSync(setup.settingsFile, "utf8")).toBe(settings);
  });

  test("refuses to rewrite a TOML settings file with comments and changes nothing", async () => {
    const setup = await snapshotHome();
    const codexFile = join(setup.home, ".codex", "config.toml");
    const writeCodex = (model: string) =>
      writeFileSync(codexFile, `# Keep this comment.\nmodel = "${model}"\napproval_policy = "never" # local only\n`);
    mkdirSync(join(setup.home, ".codex"), { recursive: true });
    writeCodex("gpt-a");
    await setup.publish("chore: codex gpt-a");
    writeCodex("gpt-b");
    await setup.publish("chore: codex gpt-b");
    const codexCommit = await git(setup.store, "rev-parse", "HEAD");
    const text = readFileSync(codexFile, "utf8");

    for (const dryRun of [true, false]) {
      const error = await runRevert({ home: setup.home, commit: codexCommit, dryRun }, setup.dependencies).catch(
        (caught: unknown) => caught,
      );

      expect(errorInfo(error).code).toBe("refused");
      expect(errorInfo(error).message).toContain(codexFile);
      expect(errorInfo(error).message).toContain("comments");
      expect(errorInfo(error).message).toContain('model = "gpt-a"');
    }
    expect(await git(setup.store, "rev-parse", "HEAD")).toBe(codexCommit);
    expect(readFileSync(codexFile, "utf8")).toBe(text);
  });

  test("rewrites a TOML settings file whose # signs are only in strings", async () => {
    const setup = await snapshotHome();
    const codexFile = join(setup.home, ".codex", "config.toml");
    const writeCodex = (model: string) =>
      writeFileSync(codexFile, `model = "${model}"\nnotify_url = "https://example.com/#top"\n`);
    mkdirSync(join(setup.home, ".codex"), { recursive: true });
    writeCodex("gpt-a");
    await setup.publish("chore: codex gpt-a");
    writeCodex("gpt-b");
    await setup.publish("chore: codex gpt-b");
    const codexCommit = await git(setup.store, "rev-parse", "HEAD");

    await runRevert({ home: setup.home, commit: codexCommit, sync: false }, setup.dependencies);

    const reverted = Bun.TOML.parse(readFileSync(codexFile, "utf8"));
    expect(reverted).toEqual({ model: "gpt-a", notify_url: "https://example.com/#top" });
  });

  test("refuses local changes that are not published", async () => {
    const setup = await snapshotHome();
    setup.writeSettings("haiku");
    const tip = await git(setup.store, "rev-parse", "HEAD");

    const error = await runRevert({ home: setup.home, commit: setup.settingsCommit }, setup.dependencies).catch(
      (caught: unknown) => caught,
    );

    expect(errorInfo(error).code).toBe("refused");
    expect(errorInfo(error).message).toContain("settings/claude.json");
    expect(await git(setup.store, "rev-parse", "HEAD")).toBe(tip);
    expect(JSON.parse(readFileSync(setup.settingsFile, "utf8")).model).toBe("haiku");
  });

  test("--dry-run shows the plan and writes nothing", async () => {
    const setup = await snapshotHome();
    const tip = await git(setup.store, "rev-parse", "HEAD");
    const settings = readFileSync(setup.settingsFile, "utf8");
    const lines: string[] = [];

    const result = await runRevert(
      { home: setup.home, commit: setup.settingsCommit, dryRun: true },
      { ...setup.dependencies, writeLine: (line) => lines.push(line) },
    );

    expect(result).toMatchObject({ dryRun: true, tip: null, sync: null, paths: ["settings/claude.json"] });
    expect(lines).toContain("Settings: ~/.claude/settings.json keys model");
    expect(await git(setup.store, "rev-parse", "HEAD")).toBe(tip);
    expect(readFileSync(setup.settingsFile, "utf8")).toBe(settings);
  });

  test("refuses a ref that is not a snapshot commit", async () => {
    const setup = await snapshotHome();
    const error = await runRevert({ home: setup.home, commit: "no-such-ref" }, setup.dependencies).catch(
      (caught: unknown) => caught,
    );
    expect(errorInfo(error).code).toBe("refused");
    expect(errorInfo(error).message).toContain("no-such-ref is not a commit of the snapshot");
  });
});

describe("ferry history", () => {
  test("lists the last 20 commits, newest first, with their paths", async () => {
    const setup = await snapshotHome();
    for (let index = 0; index < 20; index++) {
      await git(setup.store, "commit", "--quiet", "--allow-empty", "-m", `chore: empty ${index}`);
    }

    const commits = await runHistory({ home: setup.home });

    expect(commits).toHaveLength(20);
    expect(commits[0]?.subject).toBe("chore: empty 19");
    const all = await runHistory({ home: setup.home, limit: 30 });
    expect(all).toHaveLength(23);
    expect(all.at(-2)).toMatchObject({ subject: "chore: use sonnet", paths: ["settings/claude.json"] });
    expect(all.at(-3)).toMatchObject({ subject: "chore: skill v2", paths: ["skills/tdd/SKILL.md"] });
  });
});
