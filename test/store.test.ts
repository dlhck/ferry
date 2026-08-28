import { afterEach, describe, expect, test } from "bun:test";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import type { Seed } from "../src/manifest.ts";
import {
  StoreRefusal,
  openStore,
  type GitInvocation,
  type GitResult,
  type GitRunner,
} from "../src/store.ts";

const homes: string[] = [];

afterEach(() => {
  for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true });
});

function makeHome(): string {
  const home = mkdtempSync(join(tmpdir(), "ferry-store-"));
  homes.push(home);
  return home;
}

function seed(body = "Use small commits.\n"): Seed {
  return {
    ok: true,
    skills: [
      {
        name: "tdd",
        files: [{ path: "SKILL.md", bytes: Buffer.from(body) }],
      },
    ],
    instructions: { bytes: Buffer.from("Keep changes surgical.\n") },
    identity: `seed-${body}`,
    leftovers: [],
  };
}

function expectedFiles(value = seed()): Map<string, Uint8Array> {
  return new Map([
    ["AGENTS.md", value.instructions?.bytes ?? new Uint8Array()],
    [
      "ferry.json",
      Buffer.from(
        `${JSON.stringify(
          {
            schemaVersion: 1,
            managedHarnesses: ["agents", "claude", "codex", "pi", "cursor"],
          },
          null,
          2,
        )}\n`,
      ),
    ],
    ["skills/tdd/SKILL.md", value.skills[0]?.files[0]?.bytes ?? new Uint8Array()],
  ]);
}

class FakeGit implements GitRunner {
  readonly invocations: GitInvocation[] = [];
  readonly commits: Array<{ authorName: string; authorEmail: string }> = [];
  remoteFiles: Map<string, Uint8Array>;
  remoteTip: string | null;
  localFiles = new Map<string, Uint8Array>();
  localTip: string | null = null;
  checkout = "";

  constructor(
    remoteFiles: Map<string, Uint8Array> = new Map(),
    readonly identity: { name?: string; email?: string } = {
      name: "Ferry Operator",
      email: "operator@example.com",
    },
  ) {
    this.remoteFiles = cloneFiles(remoteFiles);
    this.remoteTip = remoteFiles.size > 0 ? "remote-1" : null;
  }

  async run(invocation: GitInvocation): Promise<GitResult> {
    this.invocations.push(invocation);
    const args = [...invocation.args];

    if (args[0] === "clone") {
      this.checkout = args.at(-1) ?? "";
      mkdirSync(join(this.checkout, ".git"), { recursive: true });
      writeFiles(this.checkout, this.remoteFiles);
      this.localFiles = cloneFiles(this.remoteFiles);
      this.localTip = this.remoteTip;
      return ok();
    }
    if (args[0] === "remote" && args[1] === "get-url") return textResult("snapshot.git\n");
    if (args[0] === "config") {
      const value = args.at(-1) === "user.name" ? this.identity.name : this.identity.email;
      return value ? textResult(`${value}\n`) : fail();
    }
    if (args[0] === "ls-tree") return textResult([...this.remoteFiles.keys()].sort().join("\n") + "\n");
    if (args[0] === "show") {
      const path = args.at(-1)?.split(":", 2)[1] ?? "";
      const bytes = this.remoteFiles.get(path);
      return bytes ? { status: 0, stdout: bytes, stderr: new Uint8Array() } : fail();
    }
    if (args[0] === "add") return ok();
    if (args[0] === "diff") {
      return sameFiles(readManagedFiles(this.checkout), this.localFiles) ? ok() : fail(1);
    }
    if (args.includes("commit")) {
      const name = args.find((arg) => arg.startsWith("user.name="))?.slice("user.name=".length) ?? "";
      const email = args.find((arg) => arg.startsWith("user.email="))?.slice("user.email=".length) ?? "";
      this.commits.push({ authorName: name, authorEmail: email });
      this.localFiles = readManagedFiles(this.checkout);
      this.localTip = `local-${this.commits.length}`;
      return ok();
    }
    if (args[0] === "push") {
      this.remoteFiles = cloneFiles(this.localFiles);
      this.remoteTip = this.localTip;
      return ok();
    }
    if (args[0] === "fetch") return ok();
    if (args[0] === "ls-remote") {
      return this.remoteTip ? textResult(`${this.remoteTip}\tHEAD\n`) : fail(2);
    }
    if (args[0] === "rev-parse") {
      const ref = args.at(-1);
      const tip = ref === "FETCH_HEAD" ? this.remoteTip : this.localTip;
      return tip ? textResult(`${tip}\n`) : fail();
    }
    return fail(2, `unexpected git command: ${args.join(" ")}`);
  }
}

describe("store publish", () => {
  test("publishes the managed layout with the configured git identity", async () => {
    const home = makeHome();
    const git = new FakeGit();
    const value = seed();
    const store = await openStore("snapshot.git", value, { git, home });

    const result = await store.publish(value);

    expect(result).toEqual({ published: true, tip: "local-1" });
    expect(git.remoteFiles).toEqual(expectedFiles(value));
    expect(git.commits).toEqual([
      { authorName: "Ferry Operator", authorEmail: "operator@example.com" },
    ]);
    expect(JSON.parse(readFileSync(join(home, ".ferry/store/ferry.json"), "utf8"))).toEqual({
      schemaVersion: 1,
      managedHarnesses: ["agents", "claude", "codex", "pi", "cursor"],
    });
  });

  test("fetches the published tip and reports matching local, remote, and box tips", async () => {
    const git = new FakeGit();
    const value = seed();
    const store = await openStore("snapshot.git", value, { git, home: makeHome() });
    const published = await store.publish(value);

    expect(await store.fetchTip()).toBe(published.tip);
    expect(await store.compareTips(published.tip)).toEqual({
      local: published.tip,
      remote: published.tip,
      box: published.tip,
      localMatchesRemote: true,
      remoteMatchesBox: true,
      allMatch: true,
    });
  });

  test("inspects local and remote tips without fetching or changing refs", async () => {
    const git = new FakeGit();
    const value = seed();
    const store = await openStore("snapshot.git", value, { git, home: makeHome() });
    await store.publish(value);
    git.localTip = "local-2";
    const before = git.invocations.length;

    expect(await store.inspectTips("box-1")).toEqual({
      local: "local-2",
      remote: "local-1",
      box: "box-1",
      localMatchesRemote: false,
      remoteMatchesBox: false,
      allMatch: false,
    });
    expect(git.invocations.slice(before).map((invocation) => invocation.args)).toEqual([
      ["rev-parse", "--verify", "HEAD"],
      ["ls-remote", "--exit-code", "origin", "HEAD"],
    ]);
  });

  test("refuses a fresh clone whose remote bytes differ from the seed", async () => {
    const git = new FakeGit(new Map([["skills/tdd/SKILL.md", Buffer.from("remote version\n")]]));

    await expect(openStore("snapshot.git", seed(), { git, home: makeHome() })).rejects.toMatchObject({
      code: "remote-clash",
      paths: expect.arrayContaining(["AGENTS.md", "ferry.json", "skills/tdd/SKILL.md"]),
    });
  });

  test("refuses publish when git user.name is missing", async () => {
    const git = new FakeGit(new Map(), { email: "operator@example.com" });
    const value = seed();
    const store = await openStore("snapshot.git", value, { git, home: makeHome() });

    await expect(store.publish(value)).rejects.toBeInstanceOf(StoreRefusal);
    await expect(store.publish(value)).rejects.toMatchObject({ code: "missing-git-identity" });
    expect(git.commits).toHaveLength(0);
  });

  test("refuses publish when git user.email is missing", async () => {
    const git = new FakeGit(new Map(), { name: "Ferry Operator" });
    const value = seed();
    const store = await openStore("snapshot.git", value, { git, home: makeHome() });

    await expect(store.publish(value)).rejects.toMatchObject({ code: "missing-git-identity" });
    expect(git.commits).toHaveLength(0);
  });

  test("publishing identical bytes twice creates no second commit and never uses force", async () => {
    const git = new FakeGit();
    const value = seed();
    const store = await openStore("snapshot.git", value, { git, home: makeHome() });

    expect(await store.publish(value)).toEqual({ published: true, tip: "local-1" });
    expect(await store.publish(value)).toEqual({ published: false, tip: "local-1" });
    expect(git.commits).toHaveLength(1);
    expect(git.invocations.flatMap((invocation) => invocation.args)).not.toContain("--force");
    expect(git.invocations.flatMap((invocation) => invocation.args)).not.toContain("-f");
  });
});

function ok(): GitResult {
  return { status: 0, stdout: new Uint8Array(), stderr: new Uint8Array() };
}

function fail(status = 1, message = ""): GitResult {
  return { status, stdout: new Uint8Array(), stderr: Buffer.from(message) };
}

function textResult(value: string): GitResult {
  return { status: 0, stdout: Buffer.from(value), stderr: new Uint8Array() };
}

function cloneFiles(files: Map<string, Uint8Array>): Map<string, Uint8Array> {
  return new Map([...files].map(([path, bytes]) => [path, Uint8Array.from(bytes)]));
}

function writeFiles(root: string, files: Map<string, Uint8Array>): void {
  for (const [path, bytes] of files) {
    const target = join(root, path);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, bytes);
  }
}

function readManagedFiles(root: string): Map<string, Uint8Array> {
  const files = new Map<string, Uint8Array>();
  for (const path of ["AGENTS.md", "ferry.json"]) {
    try {
      files.set(path, readFileSync(join(root, path)));
    } catch {}
  }
  const skills = join(root, "skills");
  try {
    walk(skills, root, files);
  } catch {}
  return files;
}

function walk(dir: string, root: string, files: Map<string, Uint8Array>): void {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) walk(path, root, files);
    else if (entry.isFile()) files.set(relative(root, path), readFileSync(path));
  }
}

function sameFiles(a: Map<string, Uint8Array>, b: Map<string, Uint8Array>): boolean {
  if (a.size !== b.size) return false;
  for (const [path, bytes] of a) {
    const other = b.get(path);
    if (!other || !Buffer.from(bytes).equals(Buffer.from(other))) return false;
  }
  return true;
}
