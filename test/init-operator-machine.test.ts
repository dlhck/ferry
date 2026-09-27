import { afterEach, describe, expect, test } from "bun:test";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { readConfig } from "../src/config.ts";
import { InitRefusal, runInit, type InitDependencies } from "../src/init.ts";
import { BunHostAdapter, Link } from "../src/link.ts";
import { BUILTIN_HARNESSES } from "../src/registry/builtin.ts";
import {
  RealGitRunner,
  openStore,
  type GitInvocation,
  type GitResult,
  type GitRunner,
} from "../src/store.ts";

const homes: string[] = [];
const skillRoots = [
  ".agents/skills",
  ".claude/skills",
  ".codex/skills",
  ".pi/agent/skills",
  ".cursor/skills",
] as const;
const ownedSkillRoots = [".agents/skills", ".claude/skills"] as const;
const clashNames = ["deploy", "review", "release"] as const;
const fourHarnessRoots = [
  ".agents/skills",
  ".claude/skills",
  ".codex/skills",
  ".cursor/skills",
] as const;
const SSH_DESTINATION = "box@test";
const PLACEHOLDER_SNAPSHOT = "git@example.test:operator/ferry-store.git";
const liveSshDestination = process.env.FERRY_LIVE_SSH?.trim() || "";

afterEach(() => {
  for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true });
});

describe("init on an operator-shaped machine", () => {
  test("four-way skill clashes refuse before Link, git, Apply, or config writes", async () => {
    const home = makeHome();
    for (const name of clashNames) {
      for (const [index, root] of fourHarnessRoots.entries()) {
        write(join(home, root, name, "SKILL.md"), `${name} from ${root} copy ${index}\n`);
      }
    }
    write(join(home, "AGENTS.md"), "Keep changes small.\n");
    const before = snapshotManagedPaths(home);

    await expect(
      runInit(
        {
          home,
          harnesses: BUILTIN_HARNESSES,
          sshDestination: SSH_DESTINATION,
          snapshotUrl: PLACEHOLDER_SNAPSHOT,
        },
        {
          createLink() {
            throw new Error("Link must not run after a Manifest refusal");
          },
          async openStore() {
            throw new Error("Store must not open after a Manifest refusal");
          },
        },
      ),
    ).rejects.toEqual(
      new InitRefusal(
        "manifest-refusal",
        `Manifest refused the source: clash deploy: ${clashPaths(home, "deploy")}; clash release: ${clashPaths(home, "release")}; clash review: ${clashPaths(home, "review")}`,
      ),
    );

    expect(existsSync(join(home, ".ferry"))).toBe(false);
    expect(snapshotManagedPaths(home)).toEqual(before);
    for (const root of fourHarnessRoots) {
      expect(lstatSync(join(home, root, "deploy")).isDirectory()).toBe(true);
    }
  });

  test("converts a Mac-shaped home through real git and Apply without touching $HOME", async () => {
    const home = makeHome();
    const operator = snapshotOperatorHome();
    writeMacShapedHome(home);
    const remote = await makeEmptyBareRemote();

    const result = await runInit(
      {
        home,
        harnesses: BUILTIN_HARNESSES,
        sshDestination: SSH_DESTINATION,
        snapshotUrl: remote,
      },
      realGitInitDeps(),
    );

    expect(resolve(home)).not.toBe(resolve(homedir()));
    expect(snapshotOperatorHome()).toEqual(operator);
    expect(result.published).toBe(true);
    expect(result.leftovers.map((leftover) => leftover.path)).toEqual([
      join(home, ".agents/skills/not-a-skill.txt"),
    ]);
    expect(readConfig(home)).toEqual({
      version: 1,
      publisher: "operator.test",
      snapshotUrl: remote,
      host: { transport: "ssh", destination: SSH_DESTINATION },
    });
    expect(existsSync(join(home, ".ferry/store/config.toml"))).toBe(false);

    const store = join(home, ".ferry/store");
    const union = ["agents-only", "claude-only", "shared", "tdd"];
    for (const root of ownedSkillRoots) {
      for (const name of union) {
        expect(realpathSync(join(home, root, name))).toBe(join(store, "skills", name));
      }
    }
    expect(readFileSync(join(home, ".agents/skills/not-a-skill.txt"), "utf8")).toBe("left behind\n");
    expect(readFileSync(join(home, "AGENTS.md"), "utf8")).toBe("Keep the laptop the source of truth.\n");
    expect(realpathSync(join(home, "AGENTS.md"))).toBe(join(store, "AGENTS.md"));
    expect(realpathSync(join(home, ".claude/CLAUDE.md"))).toBe(join(store, "AGENTS.md"));
    expect(realpathSync(join(home, ".codex/AGENTS.md"))).toBe(join(store, "AGENTS.md"));
    expect(realpathSync(join(home, ".pi/agent/AGENTS.md"))).toBe(join(store, "AGENTS.md"));
    expect(readFileSync(backupInStore(home, "agents", "AGENTS.md"), "utf8")).toBe(
      "Keep the laptop the source of truth.\n",
    );
    expect(readFileSync(backupInStore(home, "pi", "AGENTS.md"), "utf8")).toBe(
      "Pi-only instructions.\n",
    );
    expect(backupInStore(home, "claude", "CLAUDE.md", false)).toBeNull();
    expect(lstatSync(join(home, ".agents/skills/tdd")).isSymbolicLink()).toBe(true);
    expect(lstatSync(backupInStore(home, "agents", "tdd")!).isDirectory()).toBe(true);
  });

  test("init converts a clash-resolved synthetic multi-harness home", async () => {
    const home = makeHome();
    const operator = snapshotOperatorHome();
    writeClashResolvedHome(home);
    const remote = await makeEmptyBareRemote();

    const result = await runInit(
      {
        home,
        harnesses: BUILTIN_HARNESSES,
        sshDestination: SSH_DESTINATION,
        snapshotUrl: remote,
      },
      realGitInitDeps(),
    );

    expect(snapshotOperatorHome()).toEqual(operator);
    expect(result.published).toBe(true);
    expect(readConfig(home)?.host).toEqual({
      transport: "ssh",
      destination: SSH_DESTINATION,
    });
    const store = join(home, ".ferry/store");
    expect(realpathSync(join(home, "AGENTS.md"))).toBe(join(store, "AGENTS.md"));
    for (const name of ["deploy", "review", "shared"]) {
      for (const root of ownedSkillRoots) {
        expect(realpathSync(join(home, root, name))).toBe(join(store, "skills", name));
      }
    }
  });
});

describe("production process adapters init depends on", () => {
  test("BunHostAdapter returns a local command result", async () => {
    const result = await new BunHostAdapter().run({ argv: ["true"], timeoutMs: 2_000 });
    expect(result).toEqual({ exitCode: 0, stdout: "", stderr: "", timedOut: false });
  });

  test("BunHostAdapter kills a command that exceeds its timeout", async () => {
    const result = await new BunHostAdapter().run({ argv: ["sleep", "5"], timeoutMs: 80 });
    expect(result.timedOut).toBe(true);
    expect(result.exitCode).toBeNull();
  });

  test.skipIf(!liveSshDestination)("OpenSSH probes FERRY_LIVE_SSH without Tailscale", async () => {
    const result = await new Link({
      destination: liveSshDestination,
      connectTimeoutMs: 5_000,
      commandTimeoutMs: 8_000,
    }).run("true");
    expect(result).toMatchObject({ ok: true, address: liveSshDestination });
  });
});

function makeHome(): string {
  const home = realpathSync(mkdtempSync(join(tmpdir(), "ferry-init-machine-")));
  homes.push(home);
  return home;
}

function write(path: string, body: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, body);
}

function clashPaths(home: string, name: string): string {
  return fourHarnessRoots.map((root) => join(home, root, name)).join(", ");
}

function writeMacShapedHome(home: string): void {
  write(join(home, "AGENTS.md"), "Keep the laptop the source of truth.\n");
  mkdirSync(join(home, ".claude"), { recursive: true });
  mkdirSync(join(home, ".codex"), { recursive: true });
  mkdirSync(join(home, ".pi/agent"), { recursive: true });
  symlinkSync("../AGENTS.md", join(home, ".claude/CLAUDE.md"));
  symlinkSync("../AGENTS.md", join(home, ".codex/AGENTS.md"));
  write(join(home, ".pi/agent/AGENTS.md"), "Pi-only instructions.\n");
  write(join(home, ".agents/skills/tdd/SKILL.md"), "test first\n");
  write(join(home, ".claude/skills/tdd/SKILL.md"), "test first\n");
  write(join(home, ".codex/skills/tdd/SKILL.md"), "test first\n");
  write(join(home, ".cursor/skills/tdd/SKILL.md"), "test first\n");
  write(join(home, ".agents/skills/shared/SKILL.md"), "same bytes\n");
  write(join(home, ".claude/skills/shared/SKILL.md"), "same bytes\n");
  write(join(home, ".agents/skills/agents-only/SKILL.md"), "agents body\n");
  write(join(home, ".claude/skills/claude-only/SKILL.md"), "claude body\n");
  write(join(home, ".agents/skills/not-a-skill.txt"), "left behind\n");
}

/** Same skill bytes in every harness root so Manifest accepts the seed. */
function writeClashResolvedHome(home: string): void {
  write(join(home, "AGENTS.md"), "Keep the laptop the source of truth.\n");
  for (const name of ["deploy", "review", "shared"] as const) {
    for (const root of skillRoots) {
      write(join(home, root, name, "SKILL.md"), `${name} body\n`);
    }
  }
}

function realGitInitDeps(): InitDependencies {
  return {
    publisher: () => "operator.test",
    createLink: () => ({
      async run() {
        return { ok: true, address: SSH_DESTINATION, stdout: "", stderr: "" };
      },
    }),
    async openStore(remote, seed, home) {
      return openStore(remote, seed, {
        home,
        harnesses: BUILTIN_HARNESSES,
        git: new RealGitWithIdentity("Ferry Test", "ferry-test@example.com"),
      });
    },
  };
}

class RealGitWithIdentity implements GitRunner {
  private readonly inner = new RealGitRunner();

  constructor(
    private readonly name: string,
    private readonly email: string,
  ) {}

  async run(invocation: GitInvocation): Promise<GitResult> {
    const result = await this.inner.run(invocation);
    if (invocation.args[0] === "clone" && result.status === 0) {
      const path = invocation.args.at(-1);
      if (path) {
        await this.inner.run({ args: ["config", "user.name", this.name], cwd: path });
        await this.inner.run({ args: ["config", "user.email", this.email], cwd: path });
      }
    }
    return result;
  }
}

async function makeEmptyBareRemote(): Promise<string> {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "ferry-snapshot-")));
  homes.push(root);
  const remote = join(root, "skills.git");
  const git = new RealGitRunner();
  const init = await git.run({ args: ["init", "--bare", remote] });
  if (init.status !== 0) {
    throw new Error(new TextDecoder().decode(init.stderr) || "git init --bare failed");
  }
  return remote;
}

function snapshotOperatorHome(): readonly PathSnapshot[] {
  return snapshotManagedPaths(homedir());
}

type PathSnapshot = {
  readonly rel: string;
  readonly ino: number;
  readonly size: number;
  readonly isSymlink: boolean;
  readonly link: string | null;
};

function snapshotManagedPaths(home: string): PathSnapshot[] {
  const rels = [
    ...skillRoots,
    "AGENTS.md",
    ".claude/CLAUDE.md",
    ".codex/AGENTS.md",
    ".pi/agent/AGENTS.md",
    ".ferry",
    ".ferry/config.toml",
    ".ferry/store",
  ];
  const snapshots: PathSnapshot[] = [];
  for (const rel of rels) {
    const path = join(home, rel);
    let stat;
    try {
      stat = lstatSync(path);
    } catch {
      continue;
    }
    snapshots.push({
      rel,
      ino: stat.ino,
      size: stat.size,
      isSymlink: stat.isSymbolicLink(),
      link: stat.isSymbolicLink() ? readlinkSync(path) : null,
    });
  }
  return snapshots;
}

function backupInStore(home: string, harness: string, name: string): string;
function backupInStore(home: string, harness: string, name: string, required: false): null;
function backupInStore(home: string, harness: string, name: string, required = true): string | null {
  const root = join(home, ".ferry", "backups");
  const matches = existsSync(root)
    ? readdirSync(root)
        .map((timestamp) => join(root, timestamp, harness, name))
        .filter((candidate) => existsSync(candidate))
    : [];
  if (required) {
    expect(matches).toHaveLength(1);
    return matches[0]!;
  }
  expect(matches).toHaveLength(0);
  return null;
}
