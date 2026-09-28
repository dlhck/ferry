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
import type { Link, LinkResult, RunOptions } from "../src/link.ts";
import { runMove, type MoveDependencies, type MoveInput, type MoveResult } from "../src/move.ts";
import { errorInfo } from "../src/output.ts";
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
  const link = boxLink(box, bin, commands);
  return { root, operator, box, origin, bin, link, commands };
}

/** Runs each box command in `sh` with the box home, as OpenSSH would on the box. */
function boxLink(home: string, bin: string, commands: { command: string; options: RunOptions }[]): Pick<Link, "run"> {
  return {
    async run(command, options = {}) {
      commands.push({ command, options });
      const child = Bun.spawnSync(["sh", "-c", command], {
        stdin: options.input ?? "ignore",
        env: { ...process.env, HOME: home, PATH: `${bin}:${process.env.PATH}` },
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
  let value: MoveResult | null = null;
  try {
    value = await runMove(
      { dryRun: false, remove: false, includeEnv: false, allowSecrets: false, yes: false, ...input },
      {
        readConfig: () => ({ host: { transport: "ssh", destination: "user@box.example" } }),
        createLink: () => w.link,
        home: w.operator,
        cwd: w.operator,
        platform: "darwin",
        now: () => new Date("2026-09-27T10:11:12.345Z"),
        writeLine: (line) => lines.push(line),
        progress,
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

  test("--allow-secrets without --include-env is refused before any change", async () => {
    const w = world();
    secretApp(w);

    const result = await move(w, { path: "Developer/app", allowSecrets: true });

    expect(result.error?.message).toBe("--allow-secrets works only together with --include-env.");
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
      "WARNING: Ferry could not register ~/Developer/app in Paseo: paseo project create failed: directory_not_found. The move is complete.",
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

  test("--from-box does not register the project on this machine, and --remove hints for the box", async () => {
    const w = world();
    project(w, w.box);
    const log = boxPaseo(w);

    const result = await move(w, { path: "Developer/app", fromBox: "default", remove: true }, { readConfig: PASEO_ON });

    expect(result.error).toBeNull();
    expect(existsSync(log)).toBe(false);
    expect(result.events.join("\n")).not.toContain("Registering");
    expect(result.lines).toContain(
      "Paseo still lists ~/Developer/app on the box. Ferry does not remove it. To remove it from Paseo, run paseo project ls to find its ID, then paseo project delete <id>. The files stay.",
    );
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
    expect(t.commandsB.some(({ command }) => command.includes("tar --null -cf"))).toBe(false);
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
