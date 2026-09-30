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
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { HostAdapter, Link, LinkResult, RunOptions } from "../src/link.ts";
import { createPaseo } from "../src/integrations/paseo.ts";
import type { Integration, MovedSession } from "../src/integrations/types.ts";
import { runMove, type MoveDependencies, type MoveInput, type MoveResult } from "../src/move.ts";
import { projectDirectoryName } from "../src/sessions.ts";
import { boxLocker } from "../src/sync.ts";
import { resolveTargetBox } from "../src/boxes.ts";
import type { PartialOperatorConfig } from "../src/config.ts";
import { errorInfo } from "../src/output.ts";
import { installBoxFerry } from "./box-ferry-shim.ts";
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

  installBoxFerry(box);
  const commands: { command: string; options: RunOptions }[] = [];
  const received: string[] = [];
  const link = boxLink(box, bin, commands, received);
  return { root, operator, box, origin, bin, link, commands, received };
}

/**
 * Runs each box command in `sh` with the box home, as OpenSSH would on the box.
 * `received` gets the stdout and the stderr of each command: all that this machine gets from the box.
 */
function boxLink(
  home: string,
  bin: string,
  commands: { command: string; options: RunOptions }[],
  received: string[] = [],
): Pick<Link, "run"> {
  return {
    async run(command, options = {}) {
      commands.push({ command, options });
      const child = Bun.spawnSync(["sh", "-c", command], {
        stdin: options.input ?? "ignore",
        env: { ...process.env, HOME: home, PATH: `${bin}:${process.env.PATH}` },
      });
      const stdout = child.stdout.toString();
      const stderr = child.stderr.toString();
      received.push(stdout, stderr);
      const result: LinkResult =
        child.exitCode === 0
          ? { ok: true, address: "user@box.example", stdout, stderr }
          : { ok: false, error: { code: "command-failed", origin: "box", message: stderr.trim() || "failed" } };
      return result;
    },
  };
}

type World = ReturnType<typeof world>;

/** True when `text` reached this machine from the box, as plain text or as base64, in a line of a pack too. */
function crossed(w: World, text: string): boolean {
  return w.received.some((output) => output.includes(text) || output.split(/[\n"]/).some((part) => Buffer.from(part, "base64").includes(text)));
}

/** True for a command that tells a box to pack files: the only command that gives file content. */
function isPack(options: RunOptions): boolean {
  return Buffer.from(options.input ?? []).includes('"pack":true');
}

/** True when a box packed files for this machine. */
function packed(commands: readonly { options: RunOptions }[]): boolean {
  return commands.some(({ options }) => isPack(options));
}

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
  let value: MoveResult | null = null;
  try {
    value = await runMove(
      { dryRun: false, remove: false, includeEnv: false, sessions: true, allowSecrets: false, yes: false, ...input },
      {
        readConfig: () => ({ host: { transport: "ssh", destination: "user@box.example" } }),
        createLink: () => w.link,
        home: w.operator,
        cwd: w.operator,
        platform: "darwin",
        now: () => new Date("2026-09-27T10:11:12.345Z"),
        writeLine: (line) => lines.push(line),
        progress,
        // No test runs the real `paseo` of this machine.
        integrations: [createPaseo({ platform: "win32", which: () => null })],
        interactive: false,
        ...overrides,
      },
    );
  } catch (caught) {
    error = caught;
  }
  return { lines, events: progress.events, error: error as Error | null, value };
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
      "skip:Carrying sessions",
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
    expect(result.value).toMatchObject({
      path: "~/Developer/app",
      source: "this machine",
      destination: "the box",
      dryRun: true,
      trash: null,
    });
    expect(result.value?.carry.map((file) => file.path)).toEqual(expect.arrayContaining(["AGENTS.md", ".env.local"]));
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

  const GENERATED = [
    ".velite/posts.json",
    "tsconfig.tsbuildinfo",
    "packages/ui/tsconfig.app.tsbuildinfo",
    ".vercel/output/config.json",
    "apps/web/.vercel/output/config.json",
    ".output/server/index.mjs",
    ".vite/deps/_metadata.json",
    ".docusaurus/registry.js",
    ".expo/devices.json",
    ".pnpm-store/v3/index",
  ];
  const SKIPPED = [
    ".velite",
    "tsconfig.tsbuildinfo",
    "packages/ui/tsconfig.app.tsbuildinfo",
    ".vercel/output",
    "apps/web/.vercel/output",
    ".output",
    ".vite",
    ".docusaurus",
    ".expo",
    ".pnpm-store",
  ];

  for (const [label, setUp] of [
    ["a git repository", (w: World) => project(w, w.operator)],
    ["a folder without git", (w: World) => join(w.operator, "Developer/app")],
  ] as const) {
    test(`skips generated build output in ${label} and carries files next to it`, async () => {
      const w = world();
      const app = setUp(w);
      for (const path of GENERATED) write(join(app, path), "generated\n");
      write(join(app, ".vercel/project.json"), '{"projectId":"prj_example"}\n');
      write(join(app, "apps/web/.vercel/project.json"), '{"projectId":"prj_example"}\n');

      const result = await move(w, { path: "Developer/app" });

      expect(result.error).toBeNull();
      const boxApp = join(w.box, "Developer/app");
      for (const path of GENERATED) expect(existsSync(join(boxApp, path))).toBe(false);
      expect(existsSync(join(boxApp, ".vercel/project.json"))).toBe(true);
      expect(existsSync(join(boxApp, "apps/web/.vercel/project.json"))).toBe(true);
      const skipped = result.lines.filter((line) => line.startsWith("Skip: ")).map((line) => line.split(" ")[1]);
      expect(skipped.sort()).toEqual([...SKIPPED].sort());
    });
  }
});

describe("ferry move --allow-secrets", () => {
  // Fake credentials, built at runtime so that no secret scanner flags this file.
  const AWS_KEY_ID = "AK" + "IA" + "Q2W3E4R5T6Y7U8I9";
  const DB_PASSWORD = "hunt" + "er2-" + "example";
  const GITHUB_TOKEN = "gh" + "p_" + "a".repeat(36);
  const ENV_LOCAL = `AWS_ACCESS_KEY_ID=${AWS_KEY_ID}\nPASSWORD=${DB_PASSWORD}\nPORT=3000\n`;

  function secretApp(w: World): string {
    const app = project(w, w.operator);
    write(join(app, ".env.local"), ENV_LOCAL);
    chmodSync(join(app, ".env.local"), 0o644);
    return app;
  }

  function expectNoSecretValue(result: { lines: string[]; events: string[]; error: Error | null }): void {
    const text = [...result.lines, ...result.events, result.error?.message ?? ""].join("\n");
    for (const value of [AWS_KEY_ID, DB_PASSWORD, GITHUB_TOKEN]) expect(text).not.toContain(value);
  }

  test("--include-env alone refuses an .env file with an AWS access key ID", async () => {
    const w = world();
    secretApp(w);

    const result = await move(w, { path: "Developer/app", includeEnv: true });

    expect(result.error).toBeNull();
    expect(existsSync(join(w.box, "Developer/app/.env.local"))).toBe(false);
    expect(result.lines).toContain("Refuse: .env.local (AWS access key ID in file content)");
    expectNoSecretValue(result);
  });

  test("carries the .env file with mode 600, lists the secret kinds, and verifies its checksum", async () => {
    const w = world();
    secretApp(w);

    const result = await move(w, { path: "Developer/app", includeEnv: true, allowSecrets: true, yes: true });

    expect(result.error).toBeNull();
    const carried = join(w.box, "Developer/app/.env.local");
    expect(readFileSync(carried, "utf8")).toBe(ENV_LOCAL);
    expect(statSync(carried).mode & 0o777).toBe(0o600);
    expect(result.lines).toContain(
      "Carry with secrets: .env.local (AWS access key ID in file content; key PASSWORD holds a password or secret)",
    );
    const verified = w.commands.find((entry) => entry.command.includes("sha256sum"));
    expect(Buffer.from(verified?.options.input ?? []).toString()).toContain(".env.local");
    expect(result.lines.at(-1)).toMatch(/^Moved ~\/Developer\/app to the box: carried 1, refused 0,/);
    expectNoSecretValue(result);
  });

  test("a changed .env file on the destination fails the checksum check", async () => {
    const w = world();
    secretApp(w);
    const tampering: Pick<Link, "run"> = {
      async run(command, options) {
        const result = await w.link.run(command, options);
        if (command.startsWith("tar -xf -")) write(join(w.box, "Developer/app/.env.local"), "PORT=1\n");
        return result;
      },
    };

    const result = await move(
      w,
      { path: "Developer/app", includeEnv: true, allowSecrets: true, yes: true },
      { createLink: () => tampering },
    );

    expect(result.error?.message).toContain("The checksum of .env.local on the box does not match");
  });

  test("--allow-secrets without --include-env and with --no-sessions is refused before any change", async () => {
    const w = world();
    secretApp(w);

    const result = await move(w, { path: "Developer/app", allowSecrets: true, sessions: false });

    expect(result.error?.message).toBe(
      "--allow-secrets needs --include-env or the sessions. Add --include-env, or leave out --no-sessions.",
    );
    expect(w.commands).toEqual([]);
    expect(existsSync(join(w.box, "Developer"))).toBe(false);
  });

  test("other files keep every deny rule", async () => {
    const w = world();
    const app = secretApp(w);
    write(join(app, "notes/token.md"), `GITHUB_TOKEN=${GITHUB_TOKEN}\n`);
    write(join(app, "deploy.pem"), "-----BEGIN RSA PRIVATE KEY-----\nMIIB\n-----END RSA PRIVATE KEY-----\n");
    write(join(app, ".env.keys"), "-----BEGIN OPENSSH PRIVATE KEY-----\nb3Bl\n-----END OPENSSH PRIVATE KEY-----\n");
    write(join(app, ".env.bin"), new Uint8Array([0x7f, 0x45, 0x4c, 0x46, 2, 1, 1, 0]));

    const result = await move(w, { path: "Developer/app", includeEnv: true, allowSecrets: true, yes: true });

    expect(result.error).toBeNull();
    const boxApp = join(w.box, "Developer/app");
    for (const path of ["notes/token.md", "deploy.pem", ".env.keys", ".env.bin"]) {
      expect(existsSync(join(boxApp, path))).toBe(false);
    }
    expect(existsSync(join(boxApp, ".env.local"))).toBe(true);
    expect(result.lines).toContain("Refuse: notes/token.md (GitHub token in file content)");
    expect(result.lines).toContain("Refuse: deploy.pem (private key)");
    expect(result.lines).toContain("Refuse: .env.keys (private key)");
    expect(result.lines).toContain("Refuse: .env.bin (executable binary (ELF, Mach-O, or PE))");
    expectNoSecretValue(result);
  });

  test("--dry-run lists the secret files and changes nothing, also without a terminal and --yes", async () => {
    const w = world();
    const app = secretApp(w);
    const before = { operator: listTree(w.operator), box: listTree(w.box) };
    let asked = 0;

    const result = await move(
      w,
      { path: "Developer/app", includeEnv: true, allowSecrets: true, dryRun: true },
      { interactive: false, confirm: async () => ++asked > 0 },
    );

    expect(result.error).toBeNull();
    expect(result.lines).toContain(
      "Carry with secrets: .env.local (AWS access key ID in file content; key PASSWORD holds a password or secret)",
    );
    expect(asked).toBe(0);
    expect({ operator: listTree(w.operator), box: listTree(w.box) }).toEqual(before);
    expect(statSync(join(app, ".env.local")).mode & 0o777).toBe(0o644);
    expectNoSecretValue(result);
  });

  test("on a terminal, asks before the transfer and stops when the operator declines", async () => {
    const w = world();
    secretApp(w);
    const questions: string[] = [];

    const result = await move(
      w,
      { path: "Developer/app", includeEnv: true, allowSecrets: true },
      {
        interactive: true,
        confirm: async (question) => {
          questions.push(question);
          return false;
        },
      },
    );

    expect(questions).toEqual([
      "Carry 1 file with secrets to the box? Anyone with access to the box user can read them.",
    ]);
    expect(result.error).toBeNull();
    expect(result.lines.at(-1)).toBe("Move cancelled.");
    expect(result.events).toEqual(["start:Preflight", "done", "pause"]);
    expect(existsSync(join(w.box, "Developer"))).toBe(false);
    expectNoSecretValue(result);
  });

  test("on a terminal, carries the secret files after the operator agrees", async () => {
    const w = world();
    secretApp(w);
    let asked = 0;

    const result = await move(
      w,
      { path: "Developer/app", includeEnv: true, allowSecrets: true },
      { interactive: true, confirm: async () => ++asked > 0 },
    );

    expect(result.error).toBeNull();
    expect(asked).toBe(1);
    expect(existsSync(join(w.box, "Developer/app/.env.local"))).toBe(true);
  });

  for (const interactive of [true, false]) {
    test(`--yes carries the secret files without a question ${interactive ? "on" : "without"} a terminal`, async () => {
      const w = world();
      secretApp(w);
      let asked = 0;

      const result = await move(
        w,
        { path: "Developer/app", includeEnv: true, allowSecrets: true, yes: true },
        { interactive, confirm: async () => ++asked > 0 },
      );

      expect(result.error).toBeNull();
      expect(asked).toBe(0);
      expect(existsSync(join(w.box, "Developer/app/.env.local"))).toBe(true);
    });
  }

  test("without a terminal and without --yes, refuses before any change", async () => {
    const w = world();
    secretApp(w);
    let asked = 0;

    const result = await move(
      w,
      { path: "Developer/app", includeEnv: true, allowSecrets: true },
      { interactive: false, confirm: async () => ++asked > 0 },
    );

    expect(result.error?.message).toBe("Ferry found 1 file with secrets. Without a terminal, add --yes to carry them.");
    expect(errorInfo(result.error).code).toBe("confirmation-required");
    expect(asked).toBe(0);
    expect(existsSync(join(w.box, "Developer"))).toBe(false);
    expect(w.commands.some(({ command }) => command.includes("git clone") || command.startsWith("tar -xf"))).toBe(false);
    expectNoSecretValue(result);
  });

  test("--from-box writes the secret files with mode 600 on this machine", async () => {
    const w = world();
    const boxApp = project(w, w.box);
    write(join(boxApp, ".env.local"), ENV_LOCAL);
    chmodSync(join(boxApp, ".env.local"), 0o644);

    const result = await move(w, {
      path: "Developer/app",
      fromBox: "default",
      includeEnv: true,
      allowSecrets: true,
      yes: true,
    });

    expect(result.error).toBeNull();
    expect(statSync(join(w.operator, "Developer/app/.env.local")).mode & 0o777).toBe(0o600);
  });
});

describe("ferry move --from-box", () => {
  test("clones on this machine, carries the box files, and moves the box copy to the Ferry trash", async () => {
    const w = world();
    const boxApp = project(w, w.box);
    write(join(boxApp, "AGENTS.md"), "# Agents\n");
    write(join(boxApp, ".claude/settings.local.json"), "{}\n");
    write(join(boxApp, ".env.local"), "PORT=3000\n");

    const result = await move(w, { path: "Developer/app", fromBox: "default", remove: true, includeEnv: true });

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

    const result = await move(w, { path: "Developer/app", fromBox: "default", dryRun: true });

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

    const result = await move(w, { path: "Developer/app", fromBox: "default", dryRun: true }, { createLink: () => noGh });

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

    const result = await move(w, { path: "Developer/app", fromBox: "default" });

    expect(result.lines.find((line) => line.startsWith("Problem: Branch main has commit"))).toContain('"Box work"');
    expect(existsSync(join(w.operator, "Developer/app"))).toBe(false);
  });
});

describe("ferry move --from-box checks the files on the box", () => {
  // Fake tokens, built at runtime so that no secret scanner flags this file.
  const FILE_TOKEN = "gh" + "p_" + "d".repeat(36);
  const SESSION_TOKEN = "gh" + "p_" + "e".repeat(36);
  const copies = (w: World) => w.commands.filter(({ options }) => isPack(options)).map(({ options }) => JSON.parse(Buffer.from(options.input!).toString()));

  /** A box project with a clean file and a file with a token, and a clean session and a session with a token. */
  function leakyBox(w: World): { boxApp: string; sessions: string } {
    const boxApp = project(w, w.box);
    write(join(boxApp, "AGENTS.md"), "# Agents\n");
    write(join(boxApp, "notes.md"), `token ${FILE_TOKEN}\n`);
    const sessions = join(w.box, ".claude/projects", projectDirectoryName(boxApp));
    write(join(sessions, "clean.jsonl"), `${JSON.stringify({ type: "user", message: "hello" })}\n`);
    write(join(sessions, "leaky.jsonl"), `${JSON.stringify({ type: "user", message: `use ${SESSION_TOKEN}` })}\n`);
    return { boxApp, sessions };
  }

  test("a file and a session with a token stay on the box, and no byte of them reaches this machine", async () => {
    const w = world();
    leakyBox(w);

    const result = await move(w, { path: "Developer/app", fromBox: "default" });

    expect(result.error).toBeNull();
    expect(result.lines).toContain("Refuse: notes.md (GitHub token in file content)");
    expect(result.value?.sessions.refused.map((hit) => hit.code)).toEqual(["github-token"]);
    expect(crossed(w, FILE_TOKEN)).toBe(false);
    expect(crossed(w, SESSION_TOKEN)).toBe(false);
    const localApp = join(w.operator, "Developer/app");
    expect(readFileSync(join(localApp, "AGENTS.md"), "utf8")).toBe("# Agents\n");
    expect(existsSync(join(localApp, "notes.md"))).toBe(false);
    const local = join(w.operator, ".claude/projects", projectDirectoryName(localApp));
    expect(existsSync(join(local, "clean.jsonl"))).toBe(true);
    expect(existsSync(join(local, "leaky.jsonl"))).toBe(false);
    expect(result.events).toContain("start:Reading 1 file on the box");
    // The box packs only the files of the plan. It reads each one one time and checks those bytes.
    expect(copies(w).map((request) => [request.kind, request.paths, request.secrets])).toEqual([
      ["files", ["AGENTS.md"], []],
      ["sessions", [join(".claude/projects", projectDirectoryName(join(w.box, "Developer/app")), "clean.jsonl")], []],
    ]);
    expect(w.commands.some(({ command }) => command.includes("tar ") && !command.startsWith("tar -xf"))).toBe(false);
  });

  test("--dry-run names the refused file and session, and copies no file from the box", async () => {
    const w = world();
    leakyBox(w);

    const result = await move(w, { path: "Developer/app", fromBox: "default", dryRun: true });

    expect(result.error).toBeNull();
    expect(result.lines).toContain("Carry: AGENTS.md");
    expect(result.lines).toContain("Refuse: notes.md (GitHub token in file content)");
    expect(result.lines).toContain("Carry sessions: claude 1");
    expect(result.value?.sessions.refused.map((hit) => hit.code)).toEqual(["github-token"]);
    expect(result.value?.carry.map((file) => file.sha256)).toEqual([new Bun.CryptoHasher("sha256").update("# Agents\n").digest("hex")]);
    expect(packed(w.commands)).toBe(false);
    expect(crossed(w, FILE_TOKEN)).toBe(false);
    expect(crossed(w, SESSION_TOKEN)).toBe(false);
    expect(crossed(w, "# Agents")).toBe(false);
    expect(listTree(w.operator)).toEqual([]);
  });

  test("--allow-secrets --dry-run names the session with secrets and copies no file, and the move then carries it", async () => {
    const w = world();
    leakyBox(w);

    const planned = await move(w, { path: "Developer/app", fromBox: "default", allowSecrets: true, dryRun: true });

    expect(planned.error).toBeNull();
    expect(planned.lines.some((line) => line.startsWith("Carry session with secrets: ") && line.endsWith("leaky.jsonl (GitHub token in file content)"))).toBe(true);
    expect(planned.lines).toContain("Refuse: notes.md (GitHub token in file content)");
    expect(packed(w.commands)).toBe(false);
    expect(crossed(w, SESSION_TOKEN)).toBe(false);

    const result = await move(w, { path: "Developer/app", fromBox: "default", allowSecrets: true, yes: true });

    expect(result.error).toBeNull();
    const local = join(w.operator, ".claude/projects", projectDirectoryName(join(w.operator, "Developer/app")));
    expect(readFileSync(join(local, "leaky.jsonl"), "utf8")).toContain(SESSION_TOKEN);
    expect(statSync(join(local, "leaky.jsonl")).mode & 0o777).toBe(0o600);
    expect(crossed(w, FILE_TOKEN)).toBe(false);
  });

  test("without a confirmation, the files with secrets stay on the box", async () => {
    const w = world();
    leakyBox(w);

    const result = await move(w, { path: "Developer/app", fromBox: "default", allowSecrets: true });

    expect(errorInfo(result.error).code).toBe("confirmation-required");
    expect(packed(w.commands)).toBe(false);
    expect(crossed(w, SESSION_TOKEN)).toBe(false);
  });

  test("the hash of a refused file and of a file with secrets does not reach this machine before the confirmation", async () => {
    const sha = (body: string) => new Bun.CryptoHasher("sha256").update(body).digest("hex");
    const env = "PASSWORD=73" + "42\n";
    const session = `${JSON.stringify({ password: "73" + "42" })}\n`;
    const w = world();
    const boxApp = project(w, w.box);
    write(join(boxApp, ".env"), env);
    write(join(w.box, ".claude/projects", projectDirectoryName(boxApp), "leaky.jsonl"), session);
    const input = { path: "Developer/app", fromBox: "default", includeEnv: true };

    const refused = await move(w, { ...input, dryRun: true });
    const planned = await move(w, { ...input, allowSecrets: true, dryRun: true });
    const cancelled = await move(w, { ...input, allowSecrets: true }, { interactive: true, confirm: async () => false });

    expect(refused.lines).toContain("Refuse: .env (key PASSWORD holds a password or secret)");
    expect(planned.lines).toContain("Carry with secrets: .env (key PASSWORD holds a password or secret)");
    expect(planned.value?.carry).toEqual([{ path: ".env", sha256: null, secrets: ["key PASSWORD holds a password or secret"] }]);
    expect(cancelled.value).toBeNull();
    expect(cancelled.lines.at(-1)).toBe("Move cancelled.");
    expect(crossed(w, sha(env))).toBe(false);
    expect(crossed(w, sha(session))).toBe(false);

    const moved = await move(w, { ...input, allowSecrets: true, yes: true });

    expect(moved.error).toBeNull();
    expect(moved.value?.carry).toEqual([{ path: ".env", sha256: sha(env), secrets: ["key PASSWORD holds a password or secret"] }]);
    expect(readFileSync(join(w.operator, "Developer/app/.env"), "utf8")).toBe(env);
    expect(existsSync(join(w.operator, ".claude/projects", projectDirectoryName(join(w.operator, "Developer/app")), "leaky.jsonl"))).toBe(true);
  });

  test("the id of a Codex session with secrets reaches this machine only after the confirmation", async () => {
    const id = "55555555-eeee-4eee-8eee-eeeeeeeeeeee";
    const w = world();
    const boxApp = project(w, w.box);
    const path = `.codex/sessions/2026/09/20/rollout-2026-09-20T10-00-00-${id}.jsonl`;
    const meta = { type: "session_meta", payload: { id, cwd: boxApp } };
    write(join(w.box, path), `${JSON.stringify(meta)}\n${JSON.stringify({ text: SESSION_TOKEN })}\n`);

    const refused = await move(w, { path: "Developer/app", fromBox: "default", dryRun: true });
    const planned = await move(w, { path: "Developer/app", fromBox: "default", allowSecrets: true, dryRun: true });

    expect(refused.value?.sessions.refused.map((hit) => [hit.path, hit.code])).toEqual([[`~/${path}`, "github-token"]]);
    expect(planned.value?.sessions.carry).toEqual([
      { harness: "codex", id: null, files: [`~/${path}`], secrets: ["GitHub token in file content"] },
    ]);
    // The id is in the file name of this fixture, so look for it in the scan results only.
    const scans = w.received.filter((output) => output.startsWith('{"schemaVersion"'));
    expect(scans.length).toBeGreaterThan(0);
    expect(scans.some((output) => output.includes(`"id":"${id}"`))).toBe(false);

    const moved = await move(w, { path: "Developer/app", fromBox: "default", allowSecrets: true, yes: true });

    expect(moved.error).toBeNull();
    expect(moved.value?.sessions.carry.map((session) => session.id)).toEqual([id]);
    expect(readFileSync(join(w.operator, path), "utf8")).toContain(SESSION_TOKEN);
    expect(moved.lines.at(-1)).toBe("Carried 1 session. Resume them in ~/Developer/app on this machine.");
  });

  test("a file name, a session name, a branch name, and a commit subject with a token do not reach this machine", async () => {
    const name = "gh" + "p_" + "1".repeat(36);
    const w = world();
    const boxApp = project(w, w.box);
    git(boxApp, "switch", "-q", "-c", `topic-${name}`);
    commit(boxApp, "work.ts", "x\n", `Add work for ${name}`);
    write(join(boxApp, "AGENTS.md"), "# Agents\n");
    write(join(boxApp, "notes", `${name}.md`), "notes\n");
    const sessions = join(w.box, ".claude/projects", projectDirectoryName(boxApp));
    write(join(sessions, "clean.jsonl"), `${JSON.stringify({ type: "user", message: "hello" })}\n`);
    write(join(sessions, `${name}.jsonl`), `${JSON.stringify({ type: "user", message: "hello" })}\n`);
    const warnings: string[] = [];

    const result = await move(w, { path: "Developer/app", fromBox: "default", dryRun: true }, { warn: (line) => warnings.push(line) });

    expect(crossed(w, name)).toBe(false);
    expect(result.lines).toContain("Carry: AGENTS.md");
    expect(result.lines).toContain("Refuse: notes (a file or directory in notes has a token in its name)");
    expect(result.lines.find((line) => line.startsWith("Problem: Branch topic-"))).toContain('Branch topic-[token] has commit');
    expect(result.lines.find((line) => line.startsWith("Problem: Branch topic-"))).toContain('"Add work for [token]"');
    const parent = `~/${sessions.slice(w.box.length + 1)}`;
    expect(warnings).toEqual([`WARNING: Ferry skips the session of ${parent} (a file or directory in ${parent.slice(2)} has a token in its name).`]);
    expect(result.lines).toContain("Carry sessions: claude 1");
    expect([...result.lines, JSON.stringify(result.value)].join("\n")).not.toContain(name);
  });

  test("refuses when the box has no Ferry, and when its Ferry has no scan command, before it copies a file", async () => {
    const cases: [string | null, string, string][] = [
      [null, "Ferry is not installed on the box.", "Run ferry install."],
      [`echo "error: unknown command 'scan'" >&2; exit 1`, "The Ferry on the box is too old to check the files there.", "Run ferry update."],
    ];
    for (const [script, message, hint] of cases) {
      for (const dryRun of [true, false]) {
        const w = world();
        leakyBox(w);
        if (script === null) rmSync(join(w.box, ".ferry/box.json"));
        else installBoxFerry(w.box, script);

        const result = await move(w, { path: "Developer/app", fromBox: "default", dryRun });

        expect(errorInfo(result.error).code).toBe("refused");
        expect(result.error?.message).toStartWith(message);
        expect(errorInfo(result.error).hint).toStartWith(hint);
        expect(packed(w.commands)).toBe(false);
        expect(crossed(w, "# Agents")).toBe(false);
        expect(crossed(w, FILE_TOKEN)).toBe(false);
        expect(listTree(w.operator)).toEqual([]);
      }
    }
  });

  test("a box without Ferry refuses also for a project that has no file to check, before a command lists its files", async () => {
    const w = world();
    project(w, w.box);
    rmSync(join(w.box, ".local"), { recursive: true });

    const result = await move(w, { path: "Developer/app", fromBox: "default" });

    expect(result.error?.message).toStartWith("Ferry is not installed on the box.");
    expect(w.commands).toHaveLength(1);
    expect(listTree(w.operator)).toEqual([]);
  });

  test("a project file that gets a secret after the check stays on the box: no byte of it reaches this machine, and the move stops", async () => {
    const w = world();
    const { boxApp } = leakyBox(w);
    const racing: Pick<Link, "run"> = {
      run: (command, options = {}) => {
        // The file changes between the two phases: after the scan of the preflight, before the box packs the files.
        if (isPack(options)) writeFileSync(join(boxApp, "AGENTS.md"), `token ${FILE_TOKEN}\n`);
        return w.link.run(command, options);
      },
    };

    const result = await move(w, { path: "Developer/app", fromBox: "default", sessions: false }, { createLink: () => racing });

    expect(result.error?.message).toBe("AGENTS.md changed on the box after the check. Run the move again.");
    expect(packed(w.commands)).toBe(true);
    expect(crossed(w, FILE_TOKEN)).toBe(false);
    expect(listTree(w.operator)).toEqual([]);
    expect(existsSync(boxApp)).toBe(true);
  });

  test("a project file that changes after the check and still passes moves with its new bytes", async () => {
    const w = world();
    const { boxApp } = leakyBox(w);
    const racing: Pick<Link, "run"> = {
      run: (command, options = {}) => {
        if (isPack(options)) writeFileSync(join(boxApp, "AGENTS.md"), "# Agents\nnew line\n");
        return w.link.run(command, options);
      },
    };

    const result = await move(w, { path: "Developer/app", fromBox: "default", sessions: false }, { createLink: () => racing });

    expect(result.error).toBeNull();
    expect(readFileSync(join(w.operator, "Developer/app/AGENTS.md"), "utf8")).toBe("# Agents\nnew line\n");
    expect(result.value?.carry.map((file) => file.sha256)).toEqual([new Bun.CryptoHasher("sha256").update("# Agents\nnew line\n").digest("hex")]);
  });

  test("a file of this machine that gets a secret after the check does not go to the box", async () => {
    const w = world();
    const app = project(w, w.operator);
    write(join(app, "AGENTS.md"), "# Agents\n");
    const lines: string[] = [];

    const result = await move(w, { path: "Developer/app", sessions: false }, {
      writeLine: (line) => {
        // The plan is printed between the scan and the pack of the files.
        if (line === "Move plan:") writeFileSync(join(app, "AGENTS.md"), `token ${FILE_TOKEN}\n`);
        lines.push(line);
      },
    });

    expect(lines).toContain("Carry: AGENTS.md");
    expect(result.error?.message).toBe("AGENTS.md changed on this machine after the check. Run the move again.");
    const sent = w.commands.map(({ command, options }) => `${command}\n${Buffer.from(options.input ?? []).toString("latin1")}`).join("\n");
    expect(sent).not.toContain(FILE_TOKEN);
    expect(existsSync(join(w.box, "Developer"))).toBe(false);
  });

  test("applies the rules of this machine to the files of a box that gives a file with a secret, and writes nothing to the destination", async () => {
    const sha = (body: string) => new Bun.CryptoHasher("sha256").update(body).digest("hex");
    const body = `token ${FILE_TOKEN}\n`;
    const session = `${JSON.stringify({ type: "user", message: `use ${SESSION_TOKEN}` })}\n`;
    const w = world();
    const boxApp = project(w, w.box);
    write(join(boxApp, "notes.md"), body);
    const path = join(".claude/projects", projectDirectoryName(boxApp), "leaky.jsonl");
    write(join(w.box, path), session);
    const boxB = join(w.root, "box-b");
    mkdirSync(boxB);
    const commandsB: { command: string; options: RunOptions }[] = [];
    const linkB = boxLink(boxB, w.bin, commandsB);
    // A Ferry that an attacker controls: each scan says that the file passes, and each pack gives its bytes.
    const envelope = (result: object) => JSON.stringify({ schemaVersion: 1, command: "scan", ok: true, result: { rules: 1_000_000, ...result }, warnings: [], error: null });
    const pack = (file: string, bytes: string) =>
      [{ pack: 1, rules: 1_000_000 }, { file: { path: file, sha256: sha(bytes), size: bytes.length, mode: 0o644, secrets: [], id: null } }, { data: Buffer.from(bytes).toString("base64") }, { end: 1 }]
        .map((line) => `'${JSON.stringify(line)}'`)
        .join(" ");
    installBoxFerry(
      w.box,
      [
        'if [ "$1" = redact ]; then exec cat; fi',
        "input=$(cat)",
        'case "$input" in',
        `  *'"pack":true'*'"kind":"files"'*|*'"kind":"files"'*'"pack":true'*) printf '%s\\n' ${pack("notes.md", body)} ;;`,
        `  *'"pack":true'*) printf '%s\\n' ${pack(path, session)} ;;`,
        `  *'"kind":"sessions"'*) printf '%s\\n' '${envelope({ files: [{ path, session: false, sha256: sha(session), id: null, hits: [], blocked: false }] })}' ;;`,
        `  *'"paths":[]'*) printf '%s\\n' '${envelope({ carry: [], refused: [] })}' ;;`,
        `  *) printf '%s\\n' '${envelope({ carry: [{ path: "notes.md", sha256: sha(body), secrets: [] }], refused: [] })}' ;;`,
        "esac",
      ].join("\n"),
    );
    const boxes = () => ({
      boxes: [
        { name: "a", host: { transport: "ssh" as const, destination: "user@a.example" } },
        { name: "b", host: { transport: "ssh" as const, destination: "user@b.example" } },
      ],
    });
    const warnings: string[] = [];

    const files = await move(w, { path: "Developer/app", fromBox: "a", toBox: "b", sessions: false }, {
      readConfig: boxes,
      createLink: ((options: { destination?: string }) => (options.destination === "user@a.example" ? w.link : linkB)) as MoveDependencies["createLink"],
    });

    expect(errorInfo(files.error).code).toBe("deny-rule-match");
    expect(files.error?.message).toBe(
      "Ferry refused files from box a after the copy, and removed the copy from this machine: github-token GitHub token in file content: notes.md",
    );
    expect(listTree(boxB)).toEqual([]);

    rmSync(join(boxApp, "notes.md"));
    const sessions = await move(w, { path: "Developer/app", fromBox: "a", toBox: "b" }, {
      readConfig: boxes,
      createLink: ((options: { destination?: string }) => (options.destination === "user@a.example" ? w.link : linkB)) as MoveDependencies["createLink"],
      warn: (line) => warnings.push(line),
    });

    expect(sessions.error).toBeNull();
    expect(warnings).toEqual([`WARNING: Ferry skips the session of ~/${path} (the rules of this machine refuse a file that box a gave). Run ferry update.`]);
    expect(existsSync(join(boxB, ".claude"))).toBe(false);
    const sent = Buffer.concat(commandsB.map(({ options }) => Buffer.from(options.input ?? [])));
    expect(sent.includes(FILE_TOKEN) || sent.includes(SESSION_TOKEN)).toBe(false);
  });

  test("a session that gets a secret after the check stays on the box, no byte of it reaches this machine, and the other sessions move", async () => {
    const w = world();
    const boxApp = project(w, w.box);
    const sessions = join(w.box, ".claude/projects", projectDirectoryName(boxApp));
    write(join(sessions, "clean.jsonl"), `${JSON.stringify({ type: "user", message: "hello" })}\n`);
    write(join(sessions, "active.jsonl"), `${JSON.stringify({ type: "user", message: "hello" })}\n`);
    const racing: Pick<Link, "run"> = {
      run: (command, options = {}) => {
        if (isPack(options)) writeFileSync(join(sessions, "active.jsonl"), `use ${SESSION_TOKEN}\n`);
        return w.link.run(command, options);
      },
    };
    const warnings: string[] = [];

    const result = await move(w, { path: "Developer/app", fromBox: "default" }, { createLink: () => racing, warn: (line) => warnings.push(line) });

    expect(result.error).toBeNull();
    const local = join(w.operator, ".claude/projects", projectDirectoryName(join(w.operator, "Developer/app")));
    expect(existsSync(join(local, "clean.jsonl"))).toBe(true);
    expect(existsSync(join(local, "active.jsonl"))).toBe(false);
    const active = `~/${join(sessions, "active.jsonl").slice(w.box.length + 1)}`;
    expect(warnings).toEqual([`WARNING: Ferry skips the session of ${active} (a file changed after the check). Run the move again to carry it.`]);
    expect(result.lines.at(-2)).toBe("Carried 1 session. Resume them in ~/Developer/app on this machine.");
    expect(crossed(w, SESSION_TOKEN)).toBe(false);
  });

  test("a move between boxes checks the files on the source box, and no byte of a refused file reaches this machine or the other box", async () => {
    const w = world();
    leakyBox(w);
    const boxB = join(w.root, "box-b");
    mkdirSync(boxB);
    const commandsB: { command: string; options: RunOptions }[] = [];
    const linkB = boxLink(boxB, w.bin, commandsB);
    const boxes = () => ({
      boxes: [
        { name: "a", host: { transport: "ssh" as const, destination: "user@a.example" } },
        { name: "b", host: { transport: "ssh" as const, destination: "user@b.example" } },
      ],
    });

    const result = await move(
      w,
      { path: "Developer/app", fromBox: "a", toBox: "b" },
      { readConfig: boxes, createLink: ((options: { destination?: string }) => (options.destination === "user@a.example" ? w.link : linkB)) as MoveDependencies["createLink"] },
    );

    expect(result.error).toBeNull();
    expect(readFileSync(join(boxB, "Developer/app/AGENTS.md"), "utf8")).toBe("# Agents\n");
    expect(existsSync(join(boxB, ".claude/projects", projectDirectoryName(join(boxB, "Developer/app")), "clean.jsonl"))).toBe(true);
    expect(crossed(w, FILE_TOKEN)).toBe(false);
    expect(crossed(w, SESSION_TOKEN)).toBe(false);
    const sent = Buffer.concat(commandsB.map(({ options }) => Buffer.from(options.input ?? [])));
    expect(sent.includes(FILE_TOKEN) || sent.includes(SESSION_TOKEN)).toBe(false);
    // Box b has no Ferry. Only the source box checks the files.
    expect(existsSync(join(boxB, ".local"))).toBe(false);
  });
});

describe("ferry move and a credential in the origin URL", () => {
  const SECRET = "box-only" + "-password";
  const CLEAN = "https://example.invalid/app.git";
  const ORIGINS: [string, string][] = [
    ["a password before the host", `https://alice:${SECRET}@example.invalid/app.git`],
    ["a token as the user", `https://${SECRET}@example.invalid/app.git`],
    ["a secret query parameter", `https://example.invalid/app.git?access_token=${SECRET}`],
  ];
  const NOTE = "Note: The origin URL has a credential. Ferry carries the URL without it, so the destination needs its own login for the clone.";

  const previous = process.env.PATH;
  afterEach(() => {
    process.env.PATH = previous;
  });

  /**
   * A project in `home` whose origin is `url`. A `git` in front of the PATH of both machines reads `url` and the
   * URL without the credential from the bare origin of the world, for `ls-remote` and `clone`, so no command
   * needs the network. `git remote get-url` still prints `url`.
   */
  function credentialProject(w: World, home: string, url: string): string {
    const app = project(w, home);
    const rewrite = [url, CLEAN].map((from) => `-c 'url.${w.origin}.insteadOf=${from}'`).join(" ");
    write(
      join(w.bin, "git"),
      `#!/bin/sh\ncase " $* " in *" ls-remote "*|*" clone "*) exec '${Bun.which("git")}' ${rewrite} "$@" ;; esac\nexec '${Bun.which("git")}' "$@"\n`,
    );
    chmodSync(join(w.bin, "git"), 0o755);
    process.env.PATH = `${w.bin}:${previous}`;
    git(app, "remote", "set-url", "origin", url);
    return app;
  }

  /** Each text that this machine sends to a box: the commands and their input. */
  function sent(commands: { command: string; options: RunOptions }[]): string {
    return commands.map(({ command, options }) => `${command}\n${Buffer.from(options.input ?? []).toString("latin1")}`).join("\n");
  }

  test.each(ORIGINS)("from a box with %s, the credential stays on the box, also in a dry run", async (_name, url) => {
    const w = world();
    credentialProject(w, w.box, url);

    const planned = await move(w, { path: "Developer/app", fromBox: "default", dryRun: true });
    const moved = await move(w, { path: "Developer/app", fromBox: "default" });

    expect(planned.error).toBeNull();
    expect(planned.lines).toContain(`Clone: ${CLEAN} at branch main`);
    expect(planned.lines).toContain(NOTE);
    expect(planned.value?.git).toEqual({ url: CLEAN, branch: "main" });
    expect(moved.error).toBeNull();
    expect(git(join(w.operator, "Developer/app"), "remote", "get-url", "origin")).toBe(CLEAN);
    expect(crossed(w, SECRET)).toBe(false);
    expect([...planned.lines, ...moved.lines, JSON.stringify(moved.value)].join("\n")).not.toContain(SECRET);
  });

  test.each(ORIGINS)("to a box with %s, the credential stays on this machine", async (_name, url) => {
    const w = world();
    credentialProject(w, w.operator, url);

    const result = await move(w, { path: "Developer/app" });

    expect(result.error).toBeNull();
    expect(result.lines).toContain(`Clone: ${CLEAN} at branch main`);
    expect(result.lines).toContain(NOTE);
    expect(git(join(w.box, "Developer/app"), "remote", "get-url", "origin")).toBe(CLEAN);
    expect(sent(w.commands)).not.toContain(SECRET);
    expect([...result.lines, JSON.stringify(result.value)].join("\n")).not.toContain(SECRET);
  });

  test("between two boxes, the credential stays on the source box", async () => {
    const w = world();
    credentialProject(w, w.box, ORIGINS[0]![1]);
    const boxB = join(w.root, "box-b");
    mkdirSync(boxB);
    const commandsB: { command: string; options: RunOptions }[] = [];
    const linkB = boxLink(boxB, w.bin, commandsB);
    const boxes = () => ({
      boxes: [
        { name: "a", host: { transport: "ssh" as const, destination: "user@a.example" } },
        { name: "b", host: { transport: "ssh" as const, destination: "user@b.example" } },
      ],
    });

    const result = await move(
      w,
      { path: "Developer/app", fromBox: "a", toBox: "b" },
      { readConfig: boxes, createLink: ((options: { destination?: string }) => (options.destination === "user@a.example" ? w.link : linkB)) as MoveDependencies["createLink"] },
    );

    expect(result.error).toBeNull();
    expect(git(join(boxB, "Developer/app"), "remote", "get-url", "origin")).toBe(CLEAN);
    expect(crossed(w, SECRET)).toBe(false);
    expect(sent(commandsB)).not.toContain(SECRET);
  });

  test("an error text of git with the origin URL does not show the credential", async () => {
    const w = world();
    const app = project(w, w.box);
    git(app, "remote", "set-url", "origin", `https://alice:${SECRET}@example.invalid/app.git`);
    const failing: Pick<Link, "run"> = {
      run: (command, options) =>
        w.link.run(command.replace("git ls-remote --symref origin HEAD", `{ echo "fatal: unable to access '$(git remote get-url origin)/'" >&2; false; }`), options),
    };

    const result = await move(w, { path: "Developer/app", fromBox: "default", dryRun: true }, { createLink: () => failing });

    expect(result.lines).toContain("Problem: Ferry could not read origin: fatal: unable to access 'https://[credential]@example.invalid/app.git/'");
    expect(crossed(w, SECRET)).toBe(false);
  });

  test("a branch name with a token does not go to the destination", async () => {
    const name = "gh" + "p_" + "2".repeat(36);
    const w = world();
    const app = project(w, w.operator);
    git(app, "switch", "-q", "-c", `topic-${name}`);
    git(app, "push", "-q", "origin", `topic-${name}`);

    const result = await move(w, { path: "Developer/app" });

    expect(result.error).toBeNull();
    expect(result.lines).toContain("Note: The name of the branch has the form of a token. The clone uses the default branch.");
    expect(git(join(w.box, "Developer/app"), "rev-parse", "--abbrev-ref", "HEAD")).toBe("main");
    expect(sent(w.commands)).not.toContain(name);
  });

  test("an origin URL without a credential, and a login name, stay as they are", async () => {
    const w = world();
    const app = project(w, w.operator);

    const result = await move(w, { path: "Developer/app", dryRun: true });

    expect(result.lines).toContain(`Clone: ${w.origin} at branch main`);
    expect(result.lines).not.toContain(NOTE);
    expect(app).toBe(join(w.operator, "Developer/app"));
  });
});

describe("ferry move and the box lock", () => {
  const HOST = () => ({ host: { transport: "ssh" as const, destination: "user@box.example" } });
  const BOXES = () => ({
    boxes: [
      { name: "a", host: { transport: "ssh" as const, destination: "user@a.example" } },
      { name: "b", host: { transport: "ssh" as const, destination: "user@b.example" } },
    ],
  });
  /** Try to take the lock of box `name`, as a sync or another command does. Returns "free" and gives the lock back, or "busy". */
  function probe(w: World, config: () => PartialOperatorConfig, name?: string): "free" | "busy" {
    const lock = boxLocker(w.operator, config, "test")(resolveTargetBox(config(), name));
    if (typeof lock !== "function") return "busy";
    lock();
    return "free";
  }
  function twoBoxes(w: World) {
    const boxB = join(w.root, "box-b");
    mkdirSync(boxB);
    const commandsB: { command: string; options: RunOptions }[] = [];
    const linkB = boxLink(boxB, w.bin, commandsB);
    const createLink = ((options: { destination?: string }) => (options.destination === "user@a.example" ? w.link : linkB)) as MoveDependencies["createLink"];
    return { boxB, commandsB, createLink };
  }

  test("holds the lock of the destination box while it changes the box, and gives it back", async () => {
    const w = world();
    const app = project(w, w.operator);
    write(join(app, "AGENTS.md"), "# Agents\n");
    const seen: string[] = [];
    const watching: Pick<Link, "run"> = {
      run: (command, options) => {
        if (command.includes("git clone") || command.startsWith("tar -xf")) seen.push(probe(w, HOST));
        return w.link.run(command, options);
      },
    };

    const result = await move(w, { path: "Developer/app" }, { readConfig: HOST, createLink: () => watching, lockBox: boxLocker(w.operator, HOST, "move") });

    expect(result.error).toBeNull();
    expect(seen).toEqual(["busy", "busy"]);
    expect(probe(w, HOST)).toBe("free");
  });

  test("holds the lock of the source box while the box packs the files", async () => {
    const w = world();
    const boxApp = project(w, w.box);
    write(join(boxApp, "AGENTS.md"), "# Agents\n");
    const seen: string[] = [];
    const watching: Pick<Link, "run"> = {
      run: (command, options = {}) => {
        if (isPack(options)) seen.push(probe(w, HOST));
        return w.link.run(command, options);
      },
    };

    const result = await move(w, { path: "Developer/app", fromBox: "default" }, { readConfig: HOST, createLink: () => watching, lockBox: boxLocker(w.operator, HOST, "move") });

    expect(result.error).toBeNull();
    expect(seen).toEqual(["busy"]);
    expect(probe(w, HOST)).toBe("free");
  });

  test("fails with sync-busy when a sync or another command holds the lock, before it changes a box", async () => {
    const w = world();
    const app = project(w, w.operator);
    write(join(app, "AGENTS.md"), "# Agents\n");
    const held = boxLocker(w.operator, HOST, "update")(resolveTargetBox(HOST()));

    const result = await move(w, { path: "Developer/app" }, { readConfig: HOST, lockBox: boxLocker(w.operator, HOST, "move") });
    if (typeof held === "function") held();

    expect(typeof held).toBe("function");
    expect(errorInfo(result.error).code).toBe("sync-busy");
    expect(result.error?.message).toBe("operator: box default is busy: a sync or another Ferry command is active for it");
    expect(w.commands.some(({ command }) => command.includes("git clone") || command.startsWith("tar -xf"))).toBe(false);
    expect(existsSync(join(w.box, "Developer"))).toBe(false);
    expect(probe(w, HOST)).toBe("free");
  });

  test("refuses a box that left the config after the preflight, and changes nothing", async () => {
    const w = world();
    const app = project(w, w.operator);
    write(join(app, "AGENTS.md"), "# Agents\n");
    let config: PartialOperatorConfig = HOST();

    const result = await move(w, { path: "Developer/app" }, {
      readConfig: () => config,
      lockBox: boxLocker(w.operator, () => config, "move"),
      writeLine: (line) => {
        // ferry box remove and ferry box add run while the move prints its plan.
        if (line === "Move plan:") config = { boxes: [{ name: "other", host: { transport: "ssh", destination: "user@other.example" } }] };
      },
    });

    expect(errorInfo(result.error).code).toBe("refused");
    expect(result.error?.message).toBe("box default left the config during the move. Ferry did not change the box.");
    expect(existsSync(join(w.box, "Developer"))).toBe(false);
    expect(probe(w, HOST)).toBe("free");
  });

  test("gives the lock back when the move fails and when the operator declines", async () => {
    const w = world();
    const app = project(w, w.operator);
    write(join(app, ".env"), "AWS_ACCESS_KEY_ID=AK" + "IA" + "Q2W3E4R5T6Y7U8I9\n");
    const failing: Pick<Link, "run"> = {
      run: (command, options) =>
        command.includes("git clone")
          ? Promise.resolve({ ok: false, error: { code: "command-failed", origin: "box", message: "disk full" } })
          : w.link.run(command, options),
    };
    const lockBox = boxLocker(w.operator, HOST, "move");

    const failed = await move(w, { path: "Developer/app" }, { readConfig: HOST, createLink: () => failing, lockBox });
    const declined = await move(w, { path: "Developer/app", includeEnv: true, allowSecrets: true }, { readConfig: HOST, lockBox, interactive: true, confirm: async () => false });

    expect(failed.error?.message).toBe("The clone failed: disk full");
    expect(declined.value).toBeNull();
    expect(probe(w, HOST)).toBe("free");
  });

  test("a move between boxes takes the lock of each box, and gives the first back when the second is busy", async () => {
    const w = world();
    const boxApp = project(w, w.box);
    write(join(boxApp, "AGENTS.md"), "# Agents\n");
    const t = twoBoxes(w);
    const lockBox = boxLocker(w.operator, BOXES, "move");
    const seen: string[] = [];
    const held = boxLocker(w.operator, BOXES, "update")(resolveTargetBox(BOXES(), "b"));

    const busy = await move(w, { path: "Developer/app", fromBox: "a", toBox: "b" }, { readConfig: BOXES, createLink: t.createLink, lockBox });
    const afterBusy = [probe(w, BOXES, "a"), probe(w, BOXES, "b")];
    if (typeof held === "function") held();
    const watching = ((options: { destination?: string }) => {
      const link = t.createLink(options as Parameters<MoveDependencies["createLink"]>[0]);
      return {
        run: (command: string, runOptions: RunOptions = {}) => {
          if (isPack(runOptions) || command.includes("git clone")) seen.push(`${probe(w, BOXES, "a")} ${probe(w, BOXES, "b")}`);
          return link.run(command, runOptions);
        },
      };
    }) as MoveDependencies["createLink"];
    const moved = await move(w, { path: "Developer/app", fromBox: "a", toBox: "b" }, { readConfig: BOXES, createLink: watching, lockBox });

    expect(errorInfo(busy.error).code).toBe("sync-busy");
    expect(busy.error?.message).toBe("operator: box b is busy: a sync or another Ferry command is active for it");
    expect(afterBusy).toEqual(["free", "busy"]);
    expect(moved.error).toBeNull();
    expect(seen).toEqual(["busy busy", "busy busy"]);
    expect([probe(w, BOXES, "a"), probe(w, BOXES, "b")]).toEqual(["free", "free"]);
    expect(existsSync(join(t.boxB, "Developer/app/AGENTS.md"))).toBe(true);
  });

  test("--dry-run takes no lock", async () => {
    const w = world();
    const app = project(w, w.operator);
    write(join(app, "AGENTS.md"), "# Agents\n");
    const held = boxLocker(w.operator, HOST, "update")(resolveTargetBox(HOST()));

    const result = await move(w, { path: "Developer/app", dryRun: true }, { readConfig: HOST, lockBox: boxLocker(w.operator, HOST, "move") });
    if (typeof held === "function") held();

    expect(result.error).toBeNull();
    expect(result.lines).toContain("Carry: AGENTS.md");
  });
});

describe("ferry move with integrations", () => {
  const PASEO_ON = () => ({
    host: { transport: "ssh" as const, destination: "user@box.example" },
    integrations: { paseo: true },
  });

  /** A `paseo` on the box PATH that logs its arguments to ~/paseo.log and exits with `exitCode`. */
  function boxPaseo(w: World, exitCode = 0): string {
    const log = join(w.box, "paseo.log");
    const bin = join(w.root, "box-bin", "paseo");
    write(bin, `#!/bin/sh\necho "$*" >> "${log}"\n${exitCode === 0 ? "" : "echo directory_not_found >&2\n"}exit ${exitCode}\n`);
    chmodSync(bin, 0o755);
    return log;
  }

  test("registers the moved project in Paseo as its own step", async () => {
    const w = world();
    project(w, w.operator);
    const log = boxPaseo(w);

    const result = await move(w, { path: "Developer/app" }, { readConfig: PASEO_ON });

    expect(result.error).toBeNull();
    expect(readFileSync(log, "utf8")).toBe(`project create ${join(w.box, "Developer/app")}\n`);
    expect(result.events.slice(-2)).toEqual(["start:Registering the project in Paseo", "done"]);
    expect(result.lines.at(-1)).toMatch(/^Moved ~\/Developer\/app to the box:/);
  });

  for (const [label, config] of [
    ["no [integrations] section", {}],
    ["paseo = false", { integrations: { paseo: false } }],
  ] as const) {
    test(`runs no Paseo step and prints nothing about Paseo with ${label}`, async () => {
      const w = world();
      project(w, w.operator);
      const log = boxPaseo(w);

      const result = await move(
        w,
        { path: "Developer/app", remove: true },
        { readConfig: () => ({ host: { transport: "ssh", destination: "user@box.example" }, ...config }) },
      );

      expect(result.error).toBeNull();
      expect(existsSync(log)).toBe(false);
      expect(result.events.join("\n")).not.toMatch(/paseo/i);
      expect(result.lines.join("\n")).not.toMatch(/paseo/i);
    });
  }

  test("a failed Paseo step only warns, and the move completes", async () => {
    const w = world();
    project(w, w.operator);
    boxPaseo(w, 1);

    const result = await move(w, { path: "Developer/app" }, { readConfig: PASEO_ON });

    expect(result.error).toBeNull();
    expect(existsSync(join(w.box, "Developer/app/README.md"))).toBe(true);
    expect(result.events.slice(-2)).toEqual(["start:Registering the project in Paseo", "fail"]);
    expect(result.lines).toContain(
      "WARNING: Ferry could not register ~/Developer/app in Paseo: paseo project create failed: Paseo did not find the directory on the box (directory_not_found). The move is complete.",
    );
  });

  test("--remove prints a hint and never deletes the source Paseo project", async () => {
    const w = world();
    project(w, w.operator);
    const log = boxPaseo(w);

    const result = await move(w, { path: "Developer/app", remove: true }, { readConfig: PASEO_ON });

    expect(result.error).toBeNull();
    expect(readFileSync(log, "utf8")).not.toContain("delete");
    expect(w.commands.some(({ command }) => /project (delete|archive)/.test(command))).toBe(false);
    expect(result.lines).toContain(
      "Paseo still lists ~/Developer/app on this machine. Ferry does not remove it. To remove it from Paseo, run paseo project ls to find its ID, then paseo project delete <id>. The files stay.",
    );
  });

  /** A Paseo with a local `paseo` that records each argv. `answer` gives the stderr of a failed command, or null. */
  function localPaseo(answer: (argv: readonly string[]) => string | null = () => null) {
    const calls: string[][] = [];
    const host: HostAdapter = {
      async run(command) {
        calls.push([...command.argv]);
        const stderr = answer(command.argv);
        return { exitCode: stderr === null ? 0 : 1, stdout: "", stderr: stderr ?? "", timedOut: false };
      },
    };
    return { calls, integrations: [createPaseo({ platform: "win32", which: () => "paseo", host })] };
  }

  /** A Claude session of the box project, in the box home. */
  function boxSession(w: World, id: string): void {
    const directory = join(w.box, ".claude/projects", projectDirectoryName(join(w.box, "Developer/app")));
    write(join(directory, `${id}.jsonl`), `${JSON.stringify({ type: "user", sessionId: id, message: "hello" })}\n`);
  }

  test("--from-box registers the project and imports the sessions in the local Paseo, and --remove hints for the box", async () => {
    const w = world();
    project(w, w.box);
    boxSession(w, "11111111-aaaa");
    const log = boxPaseo(w);
    const local = localPaseo();

    const result = await move(
      w,
      { path: "Developer/app", fromBox: "default", remove: true },
      { readConfig: PASEO_ON, integrations: local.integrations },
    );

    expect(result.error).toBeNull();
    expect(existsSync(log)).toBe(false);
    const app = join(w.operator, "Developer/app");
    expect(existsSync(join(w.operator, ".claude/projects", projectDirectoryName(app), "11111111-aaaa.jsonl"))).toBe(true);
    expect(local.calls).toEqual([
      ["paseo", "project", "create", app],
      ["paseo", "import", "11111111-aaaa", "--provider", "claude", "--cwd", app],
    ]);
    expect(result.events.slice(-2)).toEqual(["start:Registering the project in Paseo", "done"]);
    expect(result.lines.some((line) => line.startsWith("WARNING:"))).toBe(false);
    expect(result.lines).toContain(
      "Paseo still lists ~/Developer/app on the box. Ferry does not remove it. To remove it from Paseo, run paseo project ls to find its ID, then paseo project delete <id>. The files stay.",
    );
  });
});

describe("ferry move --from-box with integrations on this machine", () => {
  const PASEO_ON = () => ({
    host: { transport: "ssh" as const, destination: "user@box.example" },
    integrations: { paseo: true },
  });

  /** A Paseo whose local `paseo` fails each command with `stderr`. */
  function failingPaseo(stderr: (argv: readonly string[]) => string | null): Integration[] {
    const host: HostAdapter = {
      async run(command) {
        const message = stderr(command.argv);
        return { exitCode: message === null ? 0 : 1, stdout: "", stderr: message ?? "", timedOut: false };
      },
    };
    return [createPaseo({ platform: "win32", which: () => "paseo", host })];
  }

  test("a session that the local Paseo already has gives no warning", async () => {
    const w = world();
    const app = project(w, w.box);
    const directory = join(w.box, ".claude/projects", projectDirectoryName(app));
    write(join(directory, "11111111-aaaa.jsonl"), `${JSON.stringify({ type: "user", sessionId: "11111111-aaaa" })}\n`);
    const integrations = failingPaseo((argv) =>
      argv[1] === "import" ? "Error: Failed to import agent: Provider session is already imported: 11111111-aaaa" : null,
    );

    const result = await move(w, { path: "Developer/app", fromBox: "default" }, { readConfig: PASEO_ON, integrations });

    expect(result.error).toBeNull();
    expect(result.events.slice(-2)).toEqual(["start:Registering the project in Paseo", "done"]);
    expect(result.lines.some((line) => line.startsWith("WARNING:"))).toBe(false);
  });

  test("a failed local import only warns, and the move completes", async () => {
    const w = world();
    const app = project(w, w.box);
    const directory = join(w.box, ".claude/projects", projectDirectoryName(app));
    write(join(directory, "11111111-aaaa.jsonl"), `${JSON.stringify({ type: "user", sessionId: "11111111-aaaa" })}\n`);
    const integrations = failingPaseo((argv) => (argv[1] === "import" ? "Error: no session" : null));
    const warnings: string[] = [];

    const result = await move(
      w,
      { path: "Developer/app", fromBox: "default" },
      { readConfig: PASEO_ON, integrations, warn: (line) => warnings.push(line) },
    );

    expect(result.error).toBeNull();
    expect(existsSync(join(w.operator, "Developer/app/README.md"))).toBe(true);
    expect(result.events.slice(-2)).toEqual(["start:Registering the project in Paseo", "fail"]);
    expect(warnings).toEqual([
      "WARNING: Ferry could not register ~/Developer/app in Paseo: paseo import failed for claude session 11111111-aaaa (Error: no session). The move is complete.",
    ]);
    expect(result.lines).toEqual(expect.arrayContaining(warnings));
  });

  test("a machine without a paseo command only warns, and the move completes", async () => {
    const w = world();
    project(w, w.box);

    const result = await move(w, { path: "Developer/app", fromBox: "default" }, { readConfig: PASEO_ON });

    expect(result.error).toBeNull();
    expect(existsSync(join(w.operator, "Developer/app/README.md"))).toBe(true);
    expect(result.lines).toContain(
      "WARNING: Ferry could not register ~/Developer/app in Paseo: Ferry found no paseo command on this machine. The move is complete.",
    );
  });

  test("calls an enabled and available operator part with the local path, and calls none without one", async () => {
    const calls: { path: string; sessions: readonly MovedSession[] }[] = [];
    const fake = (available: boolean) =>
      ({
        id: "paseo",
        name: "Fake",
        description: "records the moved project",
        operator: {
          available: () => available,
          async onProjectMoved(path: string, sessions: readonly MovedSession[]) {
            calls.push({ path, sessions });
          },
        },
      }) as unknown as Integration;
    const run = async (enabled: boolean, available: boolean) => {
      const w = world();
      project(w, w.box);
      const result = await move(
        w,
        { path: "Developer/app", fromBox: "default" },
        {
          integrations: [fake(available)],
          readConfig: () => ({ host: { transport: "ssh", destination: "user@box.example" }, integrations: { paseo: enabled } }),
        },
      );
      expect(result.error).toBeNull();
      return { w, result };
    };

    const on = await run(true, true);
    expect(calls).toEqual([{ path: join(on.w.operator, "Developer/app"), sessions: [] }]);
    expect(on.result.events.slice(-2)).toEqual(["start:Registering the project in Fake", "done"]);

    for (const [enabled, available] of [[false, true], [true, false]] as const) {
      const off = await run(enabled, available);
      expect(off.result.events.join("\n")).not.toContain("Registering");
      expect(off.result.lines.join("\n")).not.toMatch(/fake|paseo/i);
    }
    expect(calls).toHaveLength(1);
  });

  test("a move to a box does not call the operator part", async () => {
    const w = world();
    project(w, w.operator);
    const calls: string[] = [];
    const fake = {
      id: "paseo",
      name: "Fake",
      description: "records the moved project",
      operator: { available: () => true, onProjectMoved: async (path: string) => void calls.push(path) },
    } as unknown as Integration;

    const result = await move(w, { path: "Developer/app" }, { readConfig: PASEO_ON, integrations: [fake] });

    expect(result.error).toBeNull();
    expect(calls).toEqual([]);
  });
});

describe("ferry move --from-box --to-box", () => {
  // A fake credential, built at runtime so that no secret scanner flags this file.
  const AWS_KEY_ID = "AK" + "IA" + "Q2W3E4R5T6Y7U8I9";
  const ENV_LOCAL = `AWS_ACCESS_KEY_ID=${AWS_KEY_ID}\nPORT=3000\n`;
  const BOXES = () => ({
    integrations: { paseo: true },
    boxes: [
      { name: "a", host: { transport: "ssh" as const, destination: "user@a.example" } },
      { name: "b", host: { transport: "ssh" as const, destination: "user@b.example" }, integrations: { paseo: false } },
      { name: "c", host: { transport: "ssh" as const, destination: "user@c.example" } },
    ],
  });

  /** A world where box a is the `box` home of `world`, boxes b and c share another home, and TMPDIR is empty. */
  function twoBoxes() {
    const w = world();
    const boxB = join(w.root, "box-b");
    const stage = join(w.root, "tmp");
    mkdirSync(boxB);
    mkdirSync(stage);
    const commandsB: { command: string; options: RunOptions }[] = [];
    const linkB = boxLink(boxB, w.bin, commandsB);
    const targets: string[] = [];
    const createLink = (options: { destination?: string }) => {
      targets.push(options.destination ?? "");
      return options.destination === "user@a.example" ? w.link : linkB;
    };
    return { w, boxA: w.box, boxB, stage, linkB, commandsB, targets, createLink: createLink as MoveDependencies["createLink"] };
  }

  const previousTmp = process.env.TMPDIR;
  afterEach(() => {
    if (previousTmp === undefined) delete process.env.TMPDIR;
    else process.env.TMPDIR = previousTmp;
  });

  async function relay(
    t: ReturnType<typeof twoBoxes>,
    input: Partial<MoveInput> = {},
    overrides: Partial<MoveDependencies> = {},
  ) {
    process.env.TMPDIR = t.stage;
    return move(
      t.w,
      { path: "Developer/app", fromBox: "a", toBox: "b", ...input },
      { readConfig: BOXES, createLink: t.createLink, ...overrides },
    );
  }

  test("relays the project from box a to box b through this machine and leaves nothing on this machine", async () => {
    const t = twoBoxes();
    const appA = project(t.w, t.boxA);
    write(join(appA, "AGENTS.md"), "# Agents\n");
    write(join(appA, ".env.local"), "PORT=3000\n");
    write(join(appA, "node_modules/pkg/index.js"), "x\n");
    const paseoA = join(t.w.root, "box-bin/paseo");
    write(paseoA, "#!/bin/sh\nexit 0\n");
    chmodSync(paseoA, 0o755);

    const result = await relay(t, { remove: true, includeEnv: true });

    expect(result.error).toBeNull();
    expect(t.targets).toEqual(["user@a.example", "user@b.example"]);
    const appB = join(t.boxB, "Developer/app");
    expect(git(appB, "rev-parse", "--abbrev-ref", "HEAD")).toBe("main");
    expect(readFileSync(join(appB, "AGENTS.md"), "utf8")).toBe("# Agents\n");
    expect(readFileSync(join(appB, ".env.local"), "utf8")).toBe("PORT=3000\n");
    expect(existsSync(join(appB, "node_modules"))).toBe(false);
    expect(existsSync(appA)).toBe(false);
    expect(existsSync(join(t.boxA, ".ferry/trash/app-20260927T101112Z/AGENTS.md"))).toBe(true);
    expect(result.lines).toContain("Source: box a ~/Developer/app");
    expect(result.lines).toContain("Destination: box b ~/Developer/app");
    expect(result.lines).toContain("Moved ~/Developer/app from box a to box b: carried 2, refused 0, skipped 1.");
    expect(result.events).toContain("start:Cloning on box b");
    expect(result.events).toContain("start:Moving the copy on box a to the Ferry trash");
    // Box b turns off Paseo, so Ferry registers nothing. The --remove hint is for box a.
    expect(result.events.join("\n")).not.toContain("Registering");
    expect(result.lines.join("\n")).toContain("Paseo still lists ~/Developer/app on box a.");
    // Box a only gets reads and the trash move. Box b only gets the destination writes.
    expect(t.w.commands.some(({ command }) => command.includes("git clone") || command.startsWith("tar -xf"))).toBe(false);
    expect(packed(t.commandsB)).toBe(false);
    // The relay forwards no SSH agent to either box, also for a git_auth = "box" box.
    expect([...t.w.commands, ...t.commandsB].every(({ options }) => options.agentForwarding === undefined)).toBe(true);
    expect(listTree(t.w.operator)).toEqual([]);
    expect(readdirSync(t.stage)).toEqual([]);
  });

  test("applies the .env rules and the secret question to box b, and prints no secret value", async () => {
    const t = twoBoxes();
    const appA = project(t.w, t.boxA);
    write(join(appA, ".env.local"), ENV_LOCAL);
    write(join(appA, "id_rsa"), "-----BEGIN OPENSSH PRIVATE KEY-----\nx\n-----END OPENSSH PRIVATE KEY-----\n");
    const questions: string[] = [];

    const declined = await relay(
      t,
      { includeEnv: true, allowSecrets: true },
      { interactive: true, confirm: async (message) => (questions.push(message), false) },
    );
    const refused = await relay(t, { includeEnv: true, allowSecrets: true });
    const carried = await relay(t, { includeEnv: true, allowSecrets: true, yes: true });

    expect(questions).toEqual(["Carry 1 file with secrets to box b? Anyone with access to the box user can read them."]);
    expect(declined.lines.at(-1)).toBe("Move cancelled.");
    expect(refused.error?.message).toBe("Ferry found 1 file with secrets. Without a terminal, add --yes to carry them.");
    expect(carried.error).toBeNull();
    expect(carried.lines).toContain("Carry with secrets: .env.local (AWS access key ID in file content)");
    expect(carried.lines.some((line) => line.startsWith("Refuse: id_rsa"))).toBe(true);
    expect(existsSync(join(t.boxB, "Developer/app/id_rsa"))).toBe(false);
    expect(statSync(join(t.boxB, "Developer/app/.env.local")).mode & 0o777).toBe(0o600);
    for (const result of [declined, refused, carried]) {
      expect([...result.lines, ...result.events, result.error?.message ?? ""].join("\n")).not.toContain(AWS_KEY_ID);
    }
    expect(readdirSync(t.stage)).toEqual([]);
  });

  test("refuses the move when the project already exists on box b", async () => {
    const t = twoBoxes();
    project(t.w, t.boxA);
    mkdirSync(join(t.boxB, "Developer/app"), { recursive: true });

    const result = await relay(t);

    expect(result.lines).toContain("Problem: ~/Developer/app already exists on box b.");
    expect(result.error?.message).toBe("Ferry refused to move ~/Developer/app: 1 problem.");
    expect(listTree(join(t.boxB, "Developer/app"))).toEqual([]);
    expect(readdirSync(t.stage)).toEqual([]);
  });

  test("--dry-run changes nothing on either box and leaves nothing on this machine", async () => {
    const t = twoBoxes();
    const appA = project(t.w, t.boxA);
    write(join(appA, "AGENTS.md"), "# Agents\n");
    const before = { a: listTree(t.boxA), b: listTree(t.boxB) };

    const result = await relay(t, { dryRun: true, remove: true });

    expect(result.error).toBeNull();
    expect(result.lines[0]).toBe("Move plan (no changes will be made):");
    expect(result.lines).toContain("Carry: AGENTS.md");
    expect({ a: listTree(t.boxA), b: listTree(t.boxB) }).toEqual(before);
    expect(readdirSync(t.stage)).toEqual([]);
  });

  test("removes the temporary copy on this machine when the write to box b fails", async () => {
    const t = twoBoxes();
    const appA = project(t.w, t.boxA);
    write(join(appA, "AGENTS.md"), "# Agents\n");
    let staged: string[] = [];
    const failing: Pick<Link, "run"> = {
      run: (command, options) => {
        if (!command.startsWith("tar -xf")) return t.linkB.run(command, options);
        staged = readdirSync(t.stage);
        return Promise.resolve({ ok: false, error: { code: "command-failed", origin: "box", message: "disk full" } });
      },
    };

    const result = await relay(t, {}, {
      createLink: (options) => ("destination" in options && options.destination === "user@b.example" ? failing : t.w.link),
    });

    expect(result.error?.message).toContain("Ferry could not carry the files. The copy at ~/Developer/app on box b is incomplete.");
    expect(existsSync(appA)).toBe(true);
    expect(staged).toHaveLength(1);
    expect(readdirSync(t.stage)).toEqual([]);
  });

  test("refuses the same box twice and an unknown box before it connects", async () => {
    const t = twoBoxes();
    project(t.w, t.boxA);

    const same = await relay(t, { toBox: "a" });
    const unknownSource = await relay(t, { fromBox: "d" });
    const unknownDestination = await relay(t, { toBox: "d" });

    expect(same.error?.message).toBe("--from-box and --to-box both name box a. Name two different boxes.");
    expect(unknownSource.error?.message).toBe("unknown box d. Known boxes: a, b, c.");
    expect(unknownDestination.error?.message).toBe("unknown box d. Known boxes: a, b, c.");
    expect(t.targets).toEqual([]);
  });

  test("selects the box of --to-box, else default_box, else asks for a box, and --from-box alone moves to this machine", async () => {
    const t = twoBoxes();
    const app = project(t.w, t.w.operator);
    const appA = join(t.boxA, "Developer/app");
    write(join(appA, "notes.md"), "notes\n");
    const withDefault = () => ({ ...BOXES(), defaultBox: "b" });

    const named = await relay(t, { fromBox: undefined, toBox: "c", dryRun: true });
    const byDefault = await relay(t, { fromBox: undefined, toBox: undefined, dryRun: true }, { readConfig: withDefault });
    const unnamed = await relay(t, { fromBox: undefined, toBox: undefined, dryRun: true });
    rmSync(app, { recursive: true, force: true });
    const toThisMachine = await relay(t, { toBox: undefined });

    expect(named.error).toBeNull();
    expect(named.lines).toContain("Destination: the box ~/Developer/app");
    expect(byDefault.error).toBeNull();
    expect(unnamed.error?.message).toBe(
      "More than one box is configured (a, b, c). Add --to-box <name>, or set default_box in the config.",
    );
    expect(toThisMachine.error).toBeNull();
    expect(readFileSync(join(t.w.operator, "Developer/app/notes.md"), "utf8")).toBe("notes\n");
    expect(t.targets).toEqual(["user@c.example", "user@b.example", "user@a.example"]);
  });
});

describe("ferry move sessions", () => {
  // A fake token, built at runtime so that no secret scanner flags this file.
  const GITHUB_TOKEN = "gh" + "p_" + "b".repeat(36);

  /** A Claude session of the project `project` in `home`, with a subagent file next to it. */
  function claudeSession(home: string, project: string, id: string, text = "hello"): string {
    const directory = join(home, ".claude/projects", projectDirectoryName(project));
    write(join(directory, `${id}.jsonl`), `${JSON.stringify({ type: "user", sessionId: id, cwd: project, message: text })}\n`);
    write(join(directory, id, "subagents/agent-1.jsonl"), `${JSON.stringify({ type: "user", message: "sub" })}\n`);
    chmodSync(join(directory, `${id}.jsonl`), 0o600);
    return directory;
  }

  /** A Codex session whose first line records `cwd`. Returns the path relative to the home. */
  function codexSession(home: string, cwd: string, id: string, text = "hello"): string {
    const path = `.codex/sessions/2026/09/20/rollout-2026-09-20T10-00-00-${id}.jsonl`;
    const meta = { timestamp: "2026-09-20T10:00:00.000Z", type: "session_meta", payload: { id, cwd, cli_version: "0.0.0" } };
    const message = { timestamp: "2026-09-20T10:00:01.000Z", type: "event_msg", payload: { type: "user_message", message: text } };
    write(join(home, path), `${JSON.stringify(meta)}\n${JSON.stringify(message)}\n`);
    return path;
  }

  function firstLine(path: string): { payload: { cwd: string } } {
    return JSON.parse(readFileSync(path, "utf8").split("\n")[0]!);
  }

  test("projectDirectoryName changes each character that is not a letter or a digit, and shortens a long name", () => {
    expect(projectDirectoryName("/home/user/Developer/my_app.v2")).toBe("-home-user-Developer-my-app-v2");
    const long = projectDirectoryName(`/home/user/${"a".repeat(300)}`);
    expect(long).toMatch(/^-home-user-a{189}-[0-9a-z]+$/);
  });

  test("carries the Claude sessions, the Claude memory, and the Codex sessions of the project to the box", async () => {
    const w = world();
    const app = project(w, w.operator);
    const source = claudeSession(w.operator, app, "11111111-aaaa");
    write(join(source, "memory/MEMORY.md"), "- note\n");
    claudeSession(w.operator, join(w.operator, "Developer/other"), "22222222-bbbb");
    const codex = codexSession(w.operator, app, "33333333-cccc-4ccc-8ccc-cccccccccccc");
    const otherCodex = codexSession(w.operator, join(w.operator, "Developer/other"), "44444444-dddd-4ddd-8ddd-dddddddddddd");

    const result = await move(w, { path: "Developer/app" });

    expect(result.error).toBeNull();
    const boxApp = join(w.box, "Developer/app");
    const target = join(w.box, ".claude/projects", projectDirectoryName(boxApp));
    expect(readFileSync(join(target, "11111111-aaaa.jsonl"), "utf8")).toBe(readFileSync(join(source, "11111111-aaaa.jsonl"), "utf8"));
    expect(statSync(join(target, "11111111-aaaa.jsonl")).mode & 0o777).toBe(0o600);
    expect(existsSync(join(target, "11111111-aaaa/subagents/agent-1.jsonl"))).toBe(true);
    expect(readFileSync(join(target, "memory/MEMORY.md"), "utf8")).toBe("- note\n");
    expect(existsSync(join(w.box, ".claude/projects", projectDirectoryName(join(w.box, "Developer/other"))))).toBe(false);
    expect(firstLine(join(w.box, codex)).payload.cwd).toBe(boxApp);
    expect(readFileSync(join(w.box, codex), "utf8").split("\n")[1]).toBe(readFileSync(join(w.operator, codex), "utf8").split("\n")[1]);
    expect(existsSync(join(w.box, otherCodex))).toBe(false);
    // The source keeps its sessions, and its Codex session keeps its project path.
    expect(existsSync(join(source, "11111111-aaaa.jsonl"))).toBe(true);
    expect(firstLine(join(w.operator, codex)).payload.cwd).toBe(app);
    expect(result.lines).toContain("Carry sessions: claude 1, claude memory files 1, codex 1");
    expect(result.lines.at(-1)).toBe("Carried 2 sessions. Resume them in ~/Developer/app on the box.");
    expect(result.events.slice(-2)).toEqual(["start:Carrying 4 session files", "done"]);
    expect(result.value?.sessions.carry.map((session) => [session.harness, session.id])).toEqual([
      ["claude", "11111111-aaaa"],
      ["claude", null],
      ["codex", "33333333-cccc-4ccc-8ccc-cccccccccccc"],
    ]);
  });

  test("--no-sessions carries no session and does not read the session stores", async () => {
    const w = world();
    const app = project(w, w.operator);
    claudeSession(w.operator, app, "11111111-aaaa");
    codexSession(w.operator, app, "33333333-cccc-4ccc-8ccc-cccccccccccc");

    const result = await move(w, { path: "Developer/app", sessions: false });

    expect(result.error).toBeNull();
    expect(existsSync(join(w.box, ".claude"))).toBe(false);
    expect(existsSync(join(w.box, ".codex"))).toBe(false);
    expect(result.events.join("\n")).not.toContain("session");
  });

  test("a move back keeps the sessions only on the destination and takes the source copy of a session on both sides", async () => {
    const w = world();
    const boxApp = project(w, w.box);
    const app = join(w.operator, "Developer/app");
    claudeSession(w.box, boxApp, "both", "from the box");
    const codex = codexSession(w.box, boxApp, "aaaaaaaa-0000-4000-8000-00000000b07b", "from the box");
    const local = claudeSession(w.operator, app, "both", "old on this machine");
    claudeSession(w.operator, app, "only-here", "only on this machine");
    codexSession(w.operator, app, "aaaaaaaa-0000-4000-8000-00000000b07b", "old on this machine");

    const result = await move(w, { path: "Developer/app", fromBox: "default" });

    expect(result.error).toBeNull();
    expect(readFileSync(join(local, "both.jsonl"), "utf8")).toContain("from the box");
    expect(readFileSync(join(local, "only-here.jsonl"), "utf8")).toContain("only on this machine");
    expect(readFileSync(join(w.operator, codex), "utf8")).toContain("from the box");
    expect(firstLine(join(w.operator, codex)).payload.cwd).toBe(app);
  });

  test("skips a session with a token, names the file and the rule, and carries the other sessions", async () => {
    const w = world();
    const app = project(w, w.operator);
    const source = claudeSession(w.operator, app, "clean");
    claudeSession(w.operator, app, "leaky", `use ${GITHUB_TOKEN}`);
    const codex = codexSession(w.operator, app, "aaaaaaaa-0000-4000-8000-0000000001ea", `token ${GITHUB_TOKEN}`);
    const warnings: string[] = [];

    const result = await move(w, { path: "Developer/app" }, { warn: (line) => warnings.push(line) });

    expect(result.error).toBeNull();
    const target = join(w.box, ".claude/projects", projectDirectoryName(join(w.box, "Developer/app")));
    expect(existsSync(join(target, "clean.jsonl"))).toBe(true);
    expect(existsSync(join(target, "leaky.jsonl"))).toBe(false);
    expect(existsSync(join(target, "leaky"))).toBe(false);
    expect(existsSync(join(w.box, codex))).toBe(false);
    const leaky = `~/${join(source, "leaky.jsonl").slice(w.operator.length + 1)}`;
    expect(warnings).toEqual([
      `WARNING: Ferry skips the session of ${leaky} (GitHub token in file content). Add --allow-secrets to carry it.`,
      `WARNING: Ferry skips the session of ~/${codex} (GitHub token in file content). Add --allow-secrets to carry it.`,
    ]);
    expect(result.lines).toEqual(expect.arrayContaining(warnings));
    expect(result.value?.sessions.refused.map((hit) => hit.path)).toEqual([leaky, `~/${codex}`]);
    expect([...result.lines, ...result.events, ...warnings].join("\n")).not.toContain(GITHUB_TOKEN);
  });

  test("--allow-secrets carries a session with a token with mode 600, after the question", async () => {
    const w = world();
    const app = project(w, w.operator);
    const source = claudeSession(w.operator, app, "leaky", `use ${GITHUB_TOKEN}`);
    chmodSync(join(source, "leaky.jsonl"), 0o644);

    const refused = await move(w, { path: "Developer/app", allowSecrets: true });
    expect(refused.error?.message).toContain("with secrets. Without a terminal, add --yes to carry them.");

    rmSync(join(w.box, "Developer"), { recursive: true, force: true });
    const result = await move(w, { path: "Developer/app", allowSecrets: true, yes: true });

    expect(result.error).toBeNull();
    const target = join(w.box, ".claude/projects", projectDirectoryName(join(w.box, "Developer/app")));
    expect(readFileSync(join(target, "leaky.jsonl"), "utf8")).toContain(GITHUB_TOKEN);
    expect(statSync(join(target, "leaky.jsonl")).mode & 0o777).toBe(0o600);
    expect(result.lines.some((line) => line.startsWith("Carry session with secrets: ") && line.includes("(GitHub token in file content)"))).toBe(true);
    expect(result.lines.join("\n")).not.toContain(GITHUB_TOKEN);
  });

  test("--allow-secrets carries a project file, a secret .env file, and a session with a token in one move", async () => {
    const w = world();
    const app = project(w, w.operator);
    write(join(app, "note.txt"), "hello\n");
    write(join(app, ".env"), "AWS_ACCESS_KEY_ID=AK" + "IA" + "Q2W3E4R5T6Y7U8I9\n");
    const source = claudeSession(w.operator, app, "leaky", `use ${GITHUB_TOKEN}`);
    chmodSync(join(source, "leaky.jsonl"), 0o644);

    const result = await move(w, { path: "Developer/app", includeEnv: true, allowSecrets: true, yes: true });

    expect(result.error).toBeNull();
    const boxApp = join(w.box, "Developer/app");
    const target = join(w.box, ".claude/projects", projectDirectoryName(boxApp));
    expect(readFileSync(join(boxApp, "note.txt"), "utf8")).toBe("hello\n");
    expect(statSync(join(boxApp, ".env")).mode & 0o777).toBe(0o600);
    expect(readFileSync(join(target, "leaky.jsonl"), "utf8")).toContain(GITHUB_TOKEN);
    expect(statSync(join(target, "leaky.jsonl")).mode & 0o777).toBe(0o600);
    expect(w.commands.filter(({ command }) => command.includes("chmod 600")).map(({ command }) => command.includes("leaky"))).toEqual([false, true]);
  });

  test("skips a session with a password in a tool call, names the file and the key, and carries it with --allow-secrets", async () => {
    const password = "example" + "-pass";
    const w = world();
    const app = project(w, w.operator);
    const source = claudeSession(w.operator, app, "clean");
    const write_ = { type: "tool_use", name: "Write", input: { file_path: "config.json", content: JSON.stringify({ password }) } };
    const records = [
      { type: "user", sessionId: "leaky", cwd: app, message: "write the config" },
      { type: "assistant", message: { content: [write_] } },
    ];
    write(join(source, "leaky.jsonl"), records.map((record) => `${JSON.stringify(record)}\n`).join(""));
    const codex = codexSession(w.operator, app, "aaaaaaaa-0000-4000-8000-0000000001ea", "hello");
    const call = { type: "response_item", payload: { type: "function_call", arguments: JSON.stringify({ cmd: `psql --password ${password}` }) } };
    writeFileSync(join(w.operator, codex), `${readFileSync(join(w.operator, codex), "utf8")}${JSON.stringify(call)}\n`);
    const warnings: string[] = [];

    const result = await move(w, { path: "Developer/app" }, { warn: (line) => warnings.push(line) });

    expect(result.error).toBeNull();
    const target = join(w.box, ".claude/projects", projectDirectoryName(join(w.box, "Developer/app")));
    expect(existsSync(join(target, "clean.jsonl"))).toBe(true);
    expect(existsSync(join(target, "leaky.jsonl"))).toBe(false);
    expect(existsSync(join(w.box, codex))).toBe(false);
    const leaky = `~/${join(source, "leaky.jsonl").slice(w.operator.length + 1)}`;
    expect(warnings).toEqual([
      `WARNING: Ferry skips the session of ${leaky} (key password holds a password or secret). Add --allow-secrets to carry it.`,
      `WARNING: Ferry skips the session of ~/${codex} (key password holds a password or secret). Add --allow-secrets to carry it.`,
    ]);
    expect(result.value?.sessions.refused.map((hit) => [hit.path, hit.code])).toEqual([
      [leaky, "secret-field"],
      [`~/${codex}`, "secret-field"],
    ]);
    expect([...result.lines, ...result.events, ...warnings, JSON.stringify(result.value)].join("\n")).not.toContain(password);
    expect(w.commands.map(({ options }) => Buffer.from(options.input ?? []).toString("latin1")).join("\n")).not.toContain(password);

    rmSync(join(w.box, "Developer"), { recursive: true, force: true });
    const allowed = await move(w, { path: "Developer/app", allowSecrets: true, yes: true });

    expect(allowed.error).toBeNull();
    expect(readFileSync(join(target, "leaky.jsonl"), "utf8")).toContain(password);
    expect(statSync(join(target, "leaky.jsonl")).mode & 0o777).toBe(0o600);
    expect(readFileSync(join(w.box, codex), "utf8")).toContain(password);
    expect(allowed.lines.filter((line) => line.startsWith("Carry session with secrets: ")).map((line) => line.slice(line.indexOf("(")))).toEqual([
      "(key password holds a password or secret)",
      "(key password holds a password or secret)",
    ]);
    expect(allowed.lines.join("\n")).not.toContain(password);
  });

  test("skips a session with a token that is written with a JSON escape", async () => {
    const w = world();
    const app = project(w, w.operator);
    const source = claudeSession(w.operator, app, "clean");
    const escaped = GITHUB_TOKEN.replace("_", "\\u005f");
    write(join(source, "escaped.jsonl"), `{"type":"user","sessionId":"escaped","message":"use ${escaped}"}\n`);
    const warnings: string[] = [];

    const result = await move(w, { path: "Developer/app" }, { warn: (line) => warnings.push(line) });

    expect(result.error).toBeNull();
    const target = join(w.box, ".claude/projects", projectDirectoryName(join(w.box, "Developer/app")));
    expect(existsSync(join(target, "clean.jsonl"))).toBe(true);
    expect(existsSync(join(target, "escaped.jsonl"))).toBe(false);
    const path = `~/${join(source, "escaped.jsonl").slice(w.operator.length + 1)}`;
    expect(warnings).toEqual([`WARNING: Ferry skips the session of ${path} (GitHub token in file content). Add --allow-secrets to carry it.`]);
    expect(result.value?.sessions.refused).toEqual([{ path, code: "github-token", reason: "GitHub token in file content" }]);
    const sent = Buffer.concat(w.commands.map(({ options }) => Buffer.from(options.input ?? [])));
    expect(sent.includes(escaped) || sent.includes(GITHUB_TOKEN)).toBe(false);
  });

  test("passes the carried sessions to an enabled integration, and calls none without one", async () => {
    const calls: { path: string; sessions: readonly MovedSession[] }[] = [];
    const fake = {
      id: "paseo",
      name: "Fake",
      description: "records the moved sessions",
      box: {
        async onProjectMoved(_link: unknown, path: string, sessions: readonly MovedSession[]) {
          calls.push({ path, sessions });
        },
      },
    } as unknown as Integration;
    for (const enabled of [true, false]) {
      const w = world();
      const app = project(w, w.operator);
      const source = claudeSession(w.operator, app, "11111111-aaaa");
      write(join(source, "memory/MEMORY.md"), "- note\n");
      codexSession(w.operator, app, "33333333-cccc-4ccc-8ccc-cccccccccccc");

      const result = await move(
        w,
        { path: "Developer/app" },
        {
          integrations: [fake],
          readConfig: () => ({ host: { transport: "ssh", destination: "user@box.example" }, integrations: { paseo: enabled } }),
        },
      );
      expect(result.error).toBeNull();
    }

    expect(calls).toEqual([
      {
        path: "~/Developer/app",
        sessions: [
          { provider: "claude", id: "11111111-aaaa" },
          { provider: "codex", id: "33333333-cccc-4ccc-8ccc-cccccccccccc" },
        ],
      },
    ]);
  });

  test("relays the sessions from box a to box b with the project path of box b", async () => {
    const w = world();
    const boxB = join(w.root, "box-b");
    mkdirSync(boxB);
    const linkB = boxLink(boxB, w.bin, []);
    const appA = project(w, w.box);
    claudeSession(w.box, appA, "11111111-aaaa");
    const codex = codexSession(w.box, appA, "33333333-cccc-4ccc-8ccc-cccccccccccc");
    const boxes = () => ({
      boxes: [
        { name: "a", host: { transport: "ssh" as const, destination: "user@a.example" } },
        { name: "b", host: { transport: "ssh" as const, destination: "user@b.example" } },
      ],
    });

    const result = await move(
      w,
      { path: "Developer/app", fromBox: "a", toBox: "b" },
      { readConfig: boxes, createLink: ((options: { destination?: string }) => (options.destination === "user@a.example" ? w.link : linkB)) as MoveDependencies["createLink"] },
    );

    expect(result.error).toBeNull();
    const appB = join(boxB, "Developer/app");
    expect(existsSync(join(boxB, ".claude/projects", projectDirectoryName(appB), "11111111-aaaa.jsonl"))).toBe(true);
    expect(firstLine(join(boxB, codex)).payload.cwd).toBe(appB);
    expect(listTree(w.operator)).toEqual([]);
  });
});
