/**
 * Store owns the private snapshot checkout and its tracked layout.
 *
 * Git execution sits behind GitRunner. Callers provide a Seed, not paths to
 * stage, so only skills, AGENTS.md, and ferry.json enter snapshot commits.
 */

import {
  existsSync,
  mkdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { Seed } from "./manifest.ts";

const STORE_DIRECTORY = ".ferry/store";
const DEFAULT_COMMIT_MESSAGE = "chore: update ferry snapshot";
const MANAGED_HARNESSES = ["agents", "claude", "codex", "pi", "cursor"] as const;
const STORE_METADATA = `${JSON.stringify(
  { schemaVersion: 1, managedHarnesses: MANAGED_HARNESSES },
  null,
  2,
)}\n`;

export type GitInvocation = {
  readonly args: readonly string[];
  readonly cwd?: string;
};

export type GitResult = {
  readonly status: number;
  readonly stdout: Uint8Array;
  readonly stderr: Uint8Array;
};

export interface GitRunner {
  run(invocation: GitInvocation): Promise<GitResult>;
}

export class RealGitRunner implements GitRunner {
  async run(invocation: GitInvocation): Promise<GitResult> {
    const process = Bun.spawn(["git", ...invocation.args], {
      cwd: invocation.cwd,
      stdout: "pipe",
      stderr: "pipe",
    });
    const [status, stdout, stderr] = await Promise.all([
      process.exited,
      new Response(process.stdout).arrayBuffer(),
      new Response(process.stderr).arrayBuffer(),
    ]);
    return {
      status,
      stdout: new Uint8Array(stdout),
      stderr: new Uint8Array(stderr),
    };
  }
}

export type StoreRefusalCode = "remote-clash" | "missing-git-identity";

export class StoreRefusal extends Error {
  constructor(
    readonly code: StoreRefusalCode,
    message: string,
    readonly paths: readonly string[] = [],
  ) {
    super(message);
    this.name = "StoreRefusal";
  }
}

export class GitCommandError extends Error {
  constructor(
    readonly args: readonly string[],
    readonly status: number,
    readonly stderr: string,
  ) {
    super(`git ${args.join(" ")} failed with status ${status}`);
    this.name = "GitCommandError";
  }
}

export type PublishResult = {
  readonly published: boolean;
  readonly tip: string | null;
};

export type TipReport = {
  readonly local: string | null;
  readonly remote: string | null;
  readonly box: string | null;
  readonly localMatchesRemote: boolean;
  readonly remoteMatchesBox: boolean;
  readonly allMatch: boolean;
};

export type OpenStoreOptions = {
  readonly git?: GitRunner;
  /** Source home. The checkout remains at the locked `.ferry/store` path below it. */
  readonly home?: string;
};

export async function openStore(
  remote: string,
  seed: Seed,
  options: OpenStoreOptions = {},
): Promise<Store> {
  const git = options.git ?? new RealGitRunner();
  const path = join(options.home ?? homedir(), STORE_DIRECTORY);
  const freshClone = !existsSync(join(path, ".git"));

  if (freshClone) {
    mkdirSync(dirname(path), { recursive: true });
    await checked(git, ["clone", remote, path]);
    const tip = await optionalTip(git, path, "HEAD");
    if (tip) await refuseRemoteClash(git, path, tip, seed);
  }

  return new Store(git, path);
}

export class Store {
  constructor(
    private readonly git: GitRunner,
    readonly path: string,
  ) {}

  async publish(seed: Seed, message = DEFAULT_COMMIT_MESSAGE): Promise<PublishResult> {
    const identity = await this.readIdentity();
    writeSeed(this.path, seed);

    await checked(this.git, ["add", "-A", "--", "skills", "AGENTS.md", "ferry.json"], this.path);
    const diff = await this.git.run({ args: ["diff", "--cached", "--quiet", "--"], cwd: this.path });
    if (diff.status === 0) return { published: false, tip: await this.localTip() };
    if (diff.status !== 1) throw commandError(["diff", "--cached", "--quiet", "--"], diff);

    await checked(
      this.git,
      [
        "-c",
        `user.name=${identity.name}`,
        "-c",
        `user.email=${identity.email}`,
        "commit",
        "-m",
        message,
        "--",
      ],
      this.path,
    );
    await checked(this.git, ["push", "origin", "HEAD"], this.path);
    return { published: true, tip: await this.localTip() };
  }

  async fetchTip(): Promise<string | null> {
    await checked(this.git, ["fetch", "origin"], this.path);
    return optionalTip(this.git, this.path, "FETCH_HEAD");
  }

  async compareTips(box: string | null): Promise<TipReport> {
    const local = await this.localTip();
    const remote = await this.fetchTip();
    const localMatchesRemote = local !== null && local === remote;
    const remoteMatchesBox = remote !== null && remote === box;
    return {
      local,
      remote,
      box,
      localMatchesRemote,
      remoteMatchesBox,
      allMatch: localMatchesRemote && remoteMatchesBox,
    };
  }

  private async localTip(): Promise<string | null> {
    return optionalTip(this.git, this.path, "HEAD");
  }

  private async readIdentity(): Promise<{ name: string; email: string }> {
    const name = await configuredValue(this.git, this.path, "user.name");
    const email = await configuredValue(this.git, this.path, "user.email");
    if (!name || !email) {
      throw new StoreRefusal(
        "missing-git-identity",
        "git user.name and user.email must both be configured",
      );
    }
    return { name, email };
  }
}

async function configuredValue(git: GitRunner, cwd: string, key: string): Promise<string | null> {
  const result = await git.run({ args: ["config", "--get", key], cwd });
  if (result.status !== 0) return null;
  return decode(result.stdout).trim() || null;
}

async function optionalTip(git: GitRunner, cwd: string, ref: string): Promise<string | null> {
  const result = await git.run({ args: ["rev-parse", "--verify", ref], cwd });
  if (result.status !== 0) return null;
  return decode(result.stdout).trim() || null;
}

async function refuseRemoteClash(
  git: GitRunner,
  cwd: string,
  tip: string,
  seed: Seed,
): Promise<void> {
  const expected = seedFiles(seed);
  const listed = await checked(git, ["ls-tree", "-r", "--name-only", tip], cwd);
  const remotePaths = decode(listed.stdout)
    .split("\n")
    .filter(Boolean);
  const clashes = new Set<string>();

  for (const path of remotePaths) {
    const expectedBytes = expected.get(path);
    if (!expectedBytes) {
      clashes.add(path);
      continue;
    }
    const shown = await checked(git, ["show", `${tip}:${path}`], cwd);
    if (!Buffer.from(shown.stdout).equals(Buffer.from(expectedBytes))) clashes.add(path);
  }
  for (const path of expected.keys()) {
    if (!remotePaths.includes(path)) clashes.add(path);
  }

  if (clashes.size > 0) {
    const paths = [...clashes].sort(compare);
    throw new StoreRefusal(
      "remote-clash",
      `snapshot remote differs from the seed at: ${paths.join(", ")}`,
      paths,
    );
  }
}

function writeSeed(root: string, seed: Seed): void {
  const skills = join(root, "skills");
  rmSync(skills, { recursive: true, force: true });
  mkdirSync(skills, { recursive: true });

  for (const skill of seed.skills) {
    for (const file of skill.files) {
      const target = join(skills, skill.name, file.path);
      mkdirSync(dirname(target), { recursive: true });
      writeFileSync(target, file.bytes);
    }
  }

  writeFileSync(join(root, "AGENTS.md"), seed.instructions?.bytes ?? new Uint8Array());
  writeFileSync(join(root, "ferry.json"), STORE_METADATA);
}

function seedFiles(seed: Seed): Map<string, Uint8Array> {
  const files = new Map<string, Uint8Array>();
  files.set("AGENTS.md", seed.instructions?.bytes ?? new Uint8Array());
  files.set("ferry.json", Buffer.from(STORE_METADATA));
  for (const skill of seed.skills) {
    for (const file of skill.files) files.set(`skills/${skill.name}/${file.path}`, file.bytes);
  }
  return files;
}

async function checked(
  git: GitRunner,
  args: readonly string[],
  cwd?: string,
): Promise<GitResult> {
  const result = await git.run({ args, cwd });
  if (result.status !== 0) throw commandError(args, result);
  return result;
}

function commandError(args: readonly string[], result: GitResult): GitCommandError {
  return new GitCommandError(args, result.status, decode(result.stderr).trim());
}

function decode(bytes: Uint8Array): string {
  return new TextDecoder().decode(bytes);
}

function compare(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}
