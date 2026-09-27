import { afterEach, describe, expect, test } from "bun:test";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { Link, LinkResult, RunOptions } from "../src/link.ts";
import { runMove, type MoveDependencies, type MoveInput } from "../src/move.ts";
import { recordProgress } from "./fake-progress.ts";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const GIT_ENV = {
  GIT_AUTHOR_NAME: "Test",
  GIT_AUTHOR_EMAIL: "test@example.com",
  GIT_COMMITTER_NAME: "Test",
  GIT_COMMITTER_EMAIL: "test@example.com",
};

function git(cwd: string, ...args: string[]): string {
  const result = Bun.spawnSync(["git", "-c", "commit.gpgsign=false", "-c", "init.defaultBranch=main", ...args], {
    cwd,
    env: { ...process.env, ...GIT_ENV },
  });
  if (result.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${result.stderr.toString()}`);
  return result.stdout.toString().trim();
}

function write(path: string, body: string | Uint8Array): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, body);
}

/** A temp world: an operator home, a box home, and a bare origin. */
function world() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "ferry-move-test-")));
  roots.push(root);
  const operator = join(root, "operator");
  const box = join(root, "box");
  const origin = join(root, "origin.git");
  const bin = join(root, "box-bin");
  mkdirSync(operator);
  mkdirSync(box);
  mkdirSync(bin);
  git(root, "init", "-q", "--bare", origin);
  const seed = join(root, "seed");
  git(root, "clone", "-q", origin, seed);
  write(join(seed, "README.md"), "# App\n");
  write(join(seed, ".gitignore"), ".env*\nnode_modules/\n.next/\n.idea/\n.claude/settings.local.json\n");
  git(seed, "add", ".");
  git(seed, "commit", "-q", "-m", "init");
  git(seed, "push", "-q", "origin", "HEAD:main");

  const commands: { command: string; options: RunOptions }[] = [];
  /** Runs each box command in `sh` with the box home, as OpenSSH would on the box. */
  const link: Pick<Link, "run"> = {
    async run(command, options = {}) {
      commands.push({ command, options });
      const child = Bun.spawnSync(["sh", "-c", command], {
        stdin: options.input ?? "ignore",
        env: { ...process.env, HOME: box, PATH: `${bin}:${process.env.PATH}` },
      });
      const stdout = child.stdout.toString();
      const stderr = child.stderr.toString();
      const result: LinkResult =
        child.exitCode === 0
          ? { ok: true, address: "user@box.example", stdout, stderr }
          : { ok: false, error: { code: "command-failed", origin: "box", message: stderr.trim() || "failed" } };
      return result;
    },
  };
  return { root, operator, box, origin, link, commands };
}

type World = ReturnType<typeof world>;

function project(w: World, home: string): string {
  const path = join(home, "Developer", "app");
  mkdirSync(dirname(path), { recursive: true });
  git(w.root, "clone", "-q", w.origin, path);
  return path;
}

async function move(w: World, input: Partial<MoveInput> & { path: string }, overrides: Partial<MoveDependencies> = {}) {
  const lines: string[] = [];
  const progress = recordProgress();
  let error: unknown = null;
  try {
    await runMove(
      { fromBox: false, dryRun: false, remove: false, includeEnv: false, ...input },
      {
        readConfig: () => ({ host: { transport: "ssh", destination: "user@box.example" } }),
        createLink: () => w.link,
        home: w.operator,
        cwd: w.operator,
        platform: "darwin",
        now: () => new Date("2026-09-27T10:11:12.345Z"),
        writeLine: (line) => lines.push(line),
        progress,
        ...overrides,
      },
    );
  } catch (caught) {
    error = caught;
  }
  return { lines, events: progress.events, error: error as Error | null };
}

function commit(repo: string, path: string, body: string, message: string): string {
  write(join(repo, path), body);
  git(repo, "add", ".");
  git(repo, "commit", "-q", "-m", message);
  return git(repo, "rev-parse", "HEAD");
}

/** A feature branch of three commits in `app` that origin gets as one squash commit. */
function squashMerged(w: World, app: string): { other: string; tip: string } {
  git(app, "switch", "-q", "-c", "feature");
  commit(app, "feature.ts", "export const a = 0;\n", "Start feature");
  commit(app, "feature.ts", "export const a = 1;\n", "Change feature");
  const tip = commit(app, "helper.ts", "export {};\n", "Add helper");
  const other = join(w.root, "other");
  git(w.root, "clone", "-q", w.origin, other);
  git(other, "fetch", "-q", app, "feature");
  git(other, "merge", "-q", "--squash", "FETCH_HEAD");
  git(other, "commit", "-q", "-m", "Feature (#12)");
  commit(other, "later.md", "later\n", "Later");
  git(other, "push", "-q", "origin", "HEAD:main");
  git(app, "fetch", "-q", "origin");
  return { other, tip };
}

function looseObjects(repo: string): string[] {
  return readdirSync(join(repo, ".git/objects"), { recursive: true }).map(String).sort();
}

function listTree(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { recursive: true, withFileTypes: false })
    .map(String)
    .filter((path) => !path.startsWith(".git/") && path !== ".git")
    .sort();
}

describe("ferry move to the box", () => {
  test("clones the project, carries local-only files, skips build output, and refuses .env files", async () => {
    const w = world();
    const app = project(w, w.operator);
    write(join(app, "AGENTS.md"), "# Agents\n");
    write(join(app, ".codex/config.toml"), 'model = "x"\n');
    write(join(app, "docs/draft.mdx"), "draft\n");
    write(join(app, ".claude/settings.local.json"), '{"permissions":{}}\n');
    write(join(app, ".env.local"), "PORT=3000\n");
    write(join(app, "node_modules/pkg/index.js"), "x\n");
    write(join(app, ".next/cache/a"), "x\n");
    write(join(app, ".idea/workspace.xml"), "<x/>\n");
    write(join(app, ".DS_Store"), "x");

    const result = await move(w, { path: "Developer/app" });

    expect(result.error).toBeNull();
    const boxApp = join(w.box, "Developer/app");
    expect(git(boxApp, "rev-parse", "--abbrev-ref", "HEAD")).toBe("main");
    expect(listTree(boxApp)).toEqual(
      expect.arrayContaining([
        "AGENTS.md",
        ".codex/config.toml",
        "docs/draft.mdx",
        ".claude/settings.local.json",
        "README.md",
      ]),
    );
    for (const path of [".env.local", "node_modules", ".next", ".idea", ".DS_Store"]) {
      expect(existsSync(join(boxApp, path))).toBe(false);
    }
    expect(readFileSync(join(boxApp, "docs/draft.mdx"), "utf8")).toBe("draft\n");
    expect(result.lines).toContain("Refuse: .env.local (environment file)");
    expect(result.lines).toContain("Skip: node_modules (build output, cache, IDE state, or macOS metadata)");
    expect(result.lines).toContain("Skip: .idea (build output, cache, IDE state, or macOS metadata)");
    expect(result.lines.at(-2)).toMatch(/^(Carry|Refuse|Skip|Note): /);
    expect(result.lines.at(-1)).toMatch(/^Moved ~\/Developer\/app to the box: carried 4, refused 1,/);
    expect(existsSync(app)).toBe(true);
    expect(result.events).toEqual([
      "start:Preflight",
      "done",
      "start:Cloning on the box",
      "done",
      "start:Carrying 4 files",
      "done",
      "start:Verifying",
      "done",
    ]);
  });

  test("the archive for the box has no AppleDouble entries and no extended attributes", async () => {
    const w = world();
    const app = project(w, w.operator);
    write(join(app, "notes.md"), "notes\n");
    // Only macOS has the xattr tool and the AppleDouble behaviour of tar.
    const darwin = process.platform === "darwin";
    if (darwin) {
      const set = Bun.spawnSync(["xattr", "-w", "com.example.test", "value", join(app, "notes.md")]);
      expect(set.exitCode).toBe(0);
    }

    await move(w, { path: "Developer/app" });

    const carried = w.commands.find((entry) => entry.command.startsWith("tar -xf -"));
    const listing = Bun.spawnSync(["tar", "-tf", "-"], { stdin: carried?.options.input }).stdout.toString();
    expect(listing.split("\n").filter(Boolean)).toEqual(["notes.md"]);
    if (darwin) expect(Buffer.from(carried?.options.input ?? []).includes("com.example.test")).toBe(false);
  });

  test("refuses an unpushed commit and names the commit and branch", async () => {
    const w = world();
    const app = project(w, w.operator);
    git(app, "switch", "-q", "-c", "feature");
    write(join(app, "feature.ts"), "export {};\n");
    git(app, "add", ".");
    git(app, "commit", "-q", "-m", "Add feature");

    const result = await move(w, { path: join(app) });

    expect(result.error?.message).toContain("Ferry refused to move ~/Developer/app");
    expect(result.lines.find((line) => line.startsWith("Problem: Branch feature has commit"))).toContain(
      '"Add feature" that is not on origin',
    );
    expect(existsSync(join(w.box, "Developer"))).toBe(false);
  });

  test("accepts an unpushed commit when an equivalent patch is on the remote", async () => {
    const w = world();
    const app = project(w, w.operator);
    git(app, "switch", "-q", "-c", "feature");
    write(join(app, "feature.ts"), "export {};\n");
    git(app, "add", ".");
    git(app, "commit", "-q", "-m", "Add feature");
    const other = join(w.root, "other");
    git(w.root, "clone", "-q", w.origin, other);
    write(join(other, "later.md"), "later\n");
    git(other, "add", ".");
    git(other, "commit", "-q", "-m", "Later");
    git(other, "fetch", "-q", app, "feature");
    git(other, "cherry-pick", "FETCH_HEAD");
    git(other, "push", "-q", "origin", "HEAD:main");
    git(app, "fetch", "-q", "origin");

    const result = await move(w, { path: "Developer/app" });

    expect(result.error).toBeNull();
    expect(result.lines).toContain(
      "Note: Branch feature: Ferry accepts 1 commit that is not on origin, because git cherry finds an equivalent patch on origin.",
    );
    expect(result.lines).toContain("Note: Branch feature is not on origin. The clone uses the default branch.");
    expect(existsSync(join(w.box, "Developer/app/feature.ts"))).toBe(true);
  });

  test("accepts a squash-merged branch of several commits, and --dry-run names the rule", async () => {
    const w = world();
    const app = project(w, w.operator);
    squashMerged(w, app);

    const result = await move(w, { path: "Developer/app", dryRun: true });

    expect(result.error).toBeNull();
    expect(result.lines).toContain(
      "Note: Branch feature: Ferry accepts 3 commits that are not on origin, because git merge-tree shows that the default branch of origin has their changes.",
    );
    expect(result.lines.some((line) => line.startsWith("Problem:"))).toBe(false);
  });

  test("refuses and names a commit after the squash merge, and accepts the commits before it", async () => {
    const w = world();
    const app = project(w, w.operator);
    squashMerged(w, app);
    commit(app, "extra.ts", "export {};\n", "Extra work");
    const objects = looseObjects(app);

    const result = await move(w, { path: "Developer/app", dryRun: true });

    expect(result.error?.message).toContain("Ferry refused to move ~/Developer/app: 1 problem.");
    expect(result.lines.find((line) => line.startsWith("Problem: Branch feature has commit"))).toContain(
      '"Extra work" that is not on origin',
    );
    expect(result.lines).toContain(
      "Note: Branch feature: Ferry accepts 3 commits that are not on origin, because git merge-tree shows that the default branch of origin has their changes.",
    );
    expect(looseObjects(app)).toEqual(objects);
  });

  test("refuses an uncommitted change to a tracked file", async () => {
    const w = world();
    const app = project(w, w.operator);
    write(join(app, "README.md"), "# Changed\n");

    const result = await move(w, { path: "Developer/app" });

    expect(result.lines).toContain("Problem: Uncommitted change: M README.md. Commit or stash it.");
    expect(result.error).not.toBeNull();
  });

  test("carries .env files with --include-env only when they pass the token and secret rules", async () => {
    const w = world();
    const app = project(w, w.operator);
    write(join(app, ".env.local"), "PORT=3000\n");
    write(join(app, ".env.example"), "PASSWORD=\n");
    write(join(app, ".env"), `GITHUB_TOKEN=ghp_${"a".repeat(36)}\n`);
    write(join(app, ".env.production"), "PASSWORD=hunter2\n");

    const result = await move(w, { path: "Developer/app", includeEnv: true });

    expect(result.error).toBeNull();
    const boxApp = join(w.box, "Developer/app");
    expect(existsSync(join(boxApp, ".env.local"))).toBe(true);
    expect(existsSync(join(boxApp, ".env.example"))).toBe(true);
    expect(existsSync(join(boxApp, ".env"))).toBe(false);
    expect(existsSync(join(boxApp, ".env.production"))).toBe(false);
    expect(result.lines).toContain("Refuse: .env (GitHub token in file content)");
    expect(result.lines).toContain("Refuse: .env.production (key PASSWORD holds a password or secret)");
  });

  test("refuses and names a file that fails a deny rule, and --remove then refuses the move", async () => {
    const w = world();
    const app = project(w, w.operator);
    write(join(app, "notes/keys.md"), `sk-ant-${"b".repeat(30)}\n`);
    write(join(app, "tool"), new Uint8Array([0x7f, 0x45, 0x4c, 0x46, 2, 1, 1, 0]));

    const result = await move(w, { path: "Developer/app", remove: true });

    expect(result.lines).toContain("Refuse: notes/keys.md (Anthropic API key in file content)");
    expect(result.lines).toContain("Refuse: tool (executable binary (ELF, Mach-O, or PE))");
    expect(result.lines.some((line) => line.startsWith("Problem: --remove needs every local-only file"))).toBe(true);
    expect(existsSync(join(w.box, "Developer"))).toBe(false);
    expect(existsSync(app)).toBe(true);
  });

  test("--remove moves the local copy to the Trash after verification", async () => {
    const w = world();
    const app = project(w, w.operator);
    write(join(app, "AGENTS.md"), "# Agents\n");

    const result = await move(w, { path: "Developer/app", remove: true });

    expect(result.error).toBeNull();
    expect(existsSync(app)).toBe(false);
    const trashed = join(w.operator, ".Trash/app-20260927T101112Z");
    expect(readFileSync(join(trashed, "AGENTS.md"), "utf8")).toBe("# Agents\n");
    expect(result.lines).toContain("Trash: moved the source copy to ~/.Trash/app-20260927T101112Z");
    expect(result.events.slice(-2)).toEqual(["start:Moving the local copy to the Trash", "done"]);
  });

  test("--remove does not run when a checksum does not match", async () => {
    const w = world();
    const app = project(w, w.operator);
    write(join(app, "AGENTS.md"), "# Agents\n");
    const tampering: Pick<Link, "run"> = {
      async run(command, options) {
        if (command.startsWith("tar -xf -")) {
          const result = await w.link.run(command, options);
          write(join(w.box, "Developer/app/AGENTS.md"), "changed\n");
          return result;
        }
        return w.link.run(command, options);
      },
    };

    const result = await move(w, { path: "Developer/app", remove: true }, { createLink: () => tampering });

    expect(result.error?.message).toContain("The checksum of AGENTS.md on the box does not match");
    expect(result.events).toContain("fail");
    expect(existsSync(app)).toBe(true);
    expect(existsSync(join(w.operator, ".Trash"))).toBe(false);
  });

  test("--dry-run changes nothing on either side", async () => {
    const w = world();
    const app = project(w, w.operator);
    write(join(app, "AGENTS.md"), "# Agents\n");
    write(join(app, ".env.local"), "PORT=3000\n");
    const before = { operator: listTree(w.operator), box: listTree(w.box) };

    const result = await move(w, { path: "Developer/app", dryRun: true, remove: true, includeEnv: true });

    expect(result.error).toBeNull();
    expect(result.lines[0]).toBe("Move plan (no changes will be made):");
    expect(result.lines).toContain("Carry: AGENTS.md");
    expect(result.lines).toContain("Carry: .env.local");
    expect({ operator: listTree(w.operator), box: listTree(w.box) }).toEqual(before);
  });

  test("refuses a path outside the home and an existing destination", async () => {
    const w = world();
    project(w, w.operator);
    mkdirSync(join(w.box, "Developer/app"), { recursive: true });

    const outside = await move(w, { path: w.root });
    const existing = await move(w, { path: "Developer/app" });

    expect(outside.error?.message).toContain("is not inside the home directory");
    expect(existing.lines).toContain("Problem: ~/Developer/app already exists on the box.");
  });

  test("copies a folder without git as a whole, with the skip list", async () => {
    const w = world();
    const folder = join(w.operator, "notes");
    write(join(folder, "a.md"), "a\n");
    write(join(folder, "sub/b.md"), "b\n");
    write(join(folder, "node_modules/x.js"), "x\n");

    const result = await move(w, { path: "notes" });

    expect(result.error).toBeNull();
    expect(listTree(join(w.box, "notes"))).toEqual(["a.md", "sub", "sub/b.md"]);
    expect(result.lines).toContain("Clone: none, the folder has no git repository; Ferry copies the folder");
  });
});

describe("ferry move --from-box", () => {
  test("clones on this machine, carries the box files, and moves the box copy to the Ferry trash", async () => {
    const w = world();
    const boxApp = project(w, w.box);
    write(join(boxApp, "AGENTS.md"), "# Agents\n");
    write(join(boxApp, ".claude/settings.local.json"), "{}\n");
    write(join(boxApp, ".env.local"), "PORT=3000\n");

    const result = await move(w, { path: "Developer/app", fromBox: true, remove: true, includeEnv: true });

    expect(result.error).toBeNull();
    const localApp = join(w.operator, "Developer/app");
    expect(readFileSync(join(localApp, "AGENTS.md"), "utf8")).toBe("# Agents\n");
    expect(existsSync(join(localApp, ".claude/settings.local.json"))).toBe(true);
    expect(existsSync(join(localApp, ".env.local"))).toBe(true);
    expect(existsSync(boxApp)).toBe(false);
    expect(existsSync(join(w.box, ".ferry/trash/app-20260927T101112Z/AGENTS.md"))).toBe(true);
    expect(result.events).toContain("start:Moving the box copy to the Ferry trash");
  });

  test("accepts a branch whose pull request is merged, with gh on the box", async () => {
    const w = world();
    const boxApp = project(w, w.box);
    const { other, tip } = squashMerged(w, boxApp);
    commit(other, "feature.ts", "export const a = 2;\n", "Change feature again");
    git(other, "push", "-q", "origin", "HEAD:main");
    git(boxApp, "fetch", "-q", "origin");
    const ghLog = join(w.root, "gh.log");
    write(
      join(w.root, "box-bin/gh"),
      `#!/bin/sh\necho "$@" >> '${ghLog}'\necho '[{"number":12,"headRefOid":"${tip}"}]'\n`,
    );
    chmodSync(join(w.root, "box-bin/gh"), 0o755);

    const result = await move(w, { path: "Developer/app", fromBox: true, dryRun: true });

    expect(result.error).toBeNull();
    expect(result.lines).toContain(
      "Note: Branch feature: Ferry accepts 3 commits that are not on origin, because gh finds merged pull request #12 with the branch tip as its head.",
    );
    expect(readFileSync(ghLog, "utf8")).toContain(`--state merged --search ${tip}`);
  });

  test("skips the pull request check when the box has no gh", async () => {
    const w = world();
    const boxApp = project(w, w.box);
    const { other } = squashMerged(w, boxApp);
    commit(other, "feature.ts", "export const a = 2;\n", "Change feature again");
    git(other, "push", "-q", "origin", "HEAD:main");
    git(boxApp, "fetch", "-q", "origin");
    const shim = join(w.root, "shim");
    mkdirSync(shim);
    for (const tool of ["sh", "git", "mktemp", "rm", "tar", "base64"]) {
      const found = Bun.which(tool);
      if (found) symlinkSync(found, join(shim, tool));
    }
    const noGh: Pick<Link, "run"> = {
      run: (command, options) => w.link.run(`PATH='${shim}'; export PATH; ${command}`, options),
    };

    const result = await move(w, { path: "Developer/app", fromBox: true, dryRun: true }, { createLink: () => noGh });

    expect(result.error?.message).toContain("Ferry refused to move ~/Developer/app: 3 problems.");
    expect(result.lines).toContain(
      "Note: gh is missing or cannot read origin, so Ferry did not look for merged pull requests.",
    );
    expect(result.lines.filter((line) => line.startsWith("Problem: Branch feature has commit"))).toHaveLength(3);
  });

  test("refuses an unpushed commit on the box", async () => {
    const w = world();
    const boxApp = project(w, w.box);
    write(join(boxApp, "work.ts"), "x\n");
    git(boxApp, "add", ".");
    git(boxApp, "commit", "-q", "-m", "Box work");

    const result = await move(w, { path: "Developer/app", fromBox: true });

    expect(result.lines.find((line) => line.startsWith("Problem: Branch main has commit"))).toContain('"Box work"');
    expect(existsSync(join(w.operator, "Developer/app"))).toBe(false);
  });
});
