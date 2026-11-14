/**
 * The project of a checkout (design section 4): the remote selection and the
 * URL normalization.
 *
 * Ferry runs only read-only Git commands here, with `GIT_OPTIONAL_LOCKS=0` and
 * `-c core.fsmonitor=false`, so Git writes nothing into `.git`. It never runs
 * `git status`.
 *
 * Selection, for the worktree root of `cwd`:
 *
 * 1. The override in `~/.ferry/messaging/remotes.json` for the root.
 * 2. `origin`, if its URL is a GitHub URL.
 * 3. The only remote with a GitHub URL.
 * 4. Else a refusal that lists the remote names.
 *
 * The key `github.com/<owner>/<repo>` is a lookup hint. The relay resolves it
 * to the numeric repository id, and a remote URL never proves access. The URL
 * credential, if any, is never used, returned, or printed.
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { writePrivate } from "../github/app.ts";

export type NormalizedRemote =
  | { readonly ok: true; readonly key: string }
  | {
      readonly ok: false;
      readonly code: "unsupported-host" | "invalid-remote";
      /** The host of an SSH URL that is not a GitHub host. It can be an alias in the SSH config. */
      readonly sshAlias: string | null;
    };

const SSH_HOSTS = new Set(["github.com", "ssh.github.com"]);
const WEB_HOSTS = new Set(["github.com"]);
const OWNER = /^[a-z0-9](?:[a-z0-9-]{0,38})$/;
const REPO = /^[a-z0-9._-]{1,100}$/;
/** `[user@]host:path`, the scp form of an SSH URL. A slash before the colon makes it a local path. */
const SCP = /^(?:[^@/]+@)?([^:/]+):(.*)$/;

/**
 * The key of a remote URL. `sshHost` is the real host name of an SSH alias, from `ssh -G`.
 * Refuses a host other than GitHub.com, and a path with other than two parts.
 */
export function normalizeRemote(url: string, sshHost?: string): NormalizedRemote {
  const parsed = parseRemote(url.trim());
  if (parsed === null) return { ok: false, code: "invalid-remote", sshAlias: null };
  const host = (parsed.ssh && sshHost !== undefined ? sshHost : parsed.host).toLowerCase();
  if (!(parsed.ssh ? SSH_HOSTS : WEB_HOSTS).has(host)) {
    return { ok: false, code: "unsupported-host", sshAlias: parsed.ssh && sshHost === undefined ? parsed.host : null };
  }
  let path = parsed.path.replace(/^\/+/, "").replace(/\/+$/, "");
  if (path.endsWith(".git")) path = path.slice(0, -4);
  let parts: string[];
  try {
    parts = path.split("/").map((part) => decodeURIComponent(part).toLowerCase());
  } catch {
    return { ok: false, code: "invalid-remote", sshAlias: null };
  }
  const [owner = "", repo = ""] = parts;
  if (parts.length !== 2 || !OWNER.test(owner) || !REPO.test(repo) || repo === "." || repo === "..") {
    return { ok: false, code: "invalid-remote", sshAlias: null };
  }
  return { ok: true, key: `github.com/${owner}/${repo}` };
}

function parseRemote(url: string): { ssh: boolean; host: string; path: string } | null {
  if (!url.includes("://")) {
    const scp = SCP.exec(url);
    return scp ? { ssh: true, host: scp[1]!, path: scp[2]! } : null;
  }
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  const ssh = ["ssh:", "git+ssh:", "ssh+git:"].includes(parsed.protocol);
  if (!ssh && !["https:", "http:", "git:"].includes(parsed.protocol)) return null;
  if (parsed.hostname === "" || parsed.search !== "" || parsed.hash !== "") return null;
  return { ssh, host: parsed.hostname, path: parsed.pathname };
}

/** Runs `git <args>` in `cwd`. Null when Git fails. */
export type GitRunner = (args: readonly string[], cwd: string) => Promise<string | null>;
/** The `hostname` of an SSH alias, from `ssh -G <alias>`. Null when SSH fails. */
export type SshHostName = (alias: string) => Promise<string | null>;

export type RemoteSelection =
  | { readonly ok: true; readonly remote: string; readonly key: string }
  | {
      readonly ok: false;
      /**
       * `no-remote`: the checkout has no remote. `unknown-remote`: the override names a remote that does not exist.
       * `unsupported-host`: the selected remote, or each remote, is not on GitHub.com. `invalid-remote`: the selected
       * remote has a GitHub URL with another path form. `ambiguous-remote`: no override, `origin` is not a GitHub
       * remote, and more than one remote is.
       */
      readonly code: "no-remote" | "unknown-remote" | "unsupported-host" | "invalid-remote" | "ambiguous-remote";
      readonly remotes: readonly string[];
    };

/** Select the remote of the worktree at `root`, and normalize its URL. */
export async function selectRemote(
  root: string,
  git: GitRunner,
  options: { readonly override?: string; readonly sshHostName?: SshHostName } = {},
): Promise<RemoteSelection> {
  const names = ((await git(["remote"], root)) ?? "").split("\n").filter((name) => name !== "");
  const keyOf = async (name: string): Promise<NormalizedRemote> => {
    // `get-url` applies `url.<base>.insteadOf`.
    const url = (await git(["remote", "get-url", name], root))?.trim() ?? "";
    const first = normalizeRemote(url);
    if (first.ok || first.sshAlias === null || !options.sshHostName) return first;
    const host = await options.sshHostName(first.sshAlias);
    return host === null ? first : normalizeRemote(url, host);
  };
  const refuse = (code: Extract<RemoteSelection, { ok: false }>["code"]): RemoteSelection => ({ ok: false, code, remotes: names });

  if (options.override !== undefined) {
    if (!names.includes(options.override)) return refuse("unknown-remote");
    const key = await keyOf(options.override);
    return key.ok ? { ok: true, remote: options.override, key: key.key } : refuse(key.code);
  }
  if (names.length === 0) return refuse("no-remote");
  const keys = new Map<string, NormalizedRemote>();
  for (const name of names) keys.set(name, await keyOf(name));
  const origin = keys.get("origin");
  if (origin?.ok) return { ok: true, remote: "origin", key: origin.key };
  const github = names.filter((name) => keys.get(name)?.ok);
  if (github.length === 1) {
    const key = keys.get(github[0]!) as { ok: true; key: string };
    return { ok: true, remote: github[0]!, key: key.key };
  }
  return refuse(github.length === 0 ? "unsupported-host" : "ambiguous-remote");
}

/** Git with no optional locks and no fsmonitor, so a read writes nothing into `.git`. */
export const readOnlyGit: GitRunner = async (args, cwd) => {
  const child = Bun.spawn(["git", "-c", "core.fsmonitor=false", ...args], {
    cwd,
    env: { ...process.env, GIT_OPTIONAL_LOCKS: "0", GIT_TERMINAL_PROMPT: "0" },
    stdin: "ignore",
    stdout: "pipe",
    stderr: "ignore",
  });
  const [stdout, code] = await Promise.all([new Response(child.stdout).text(), child.exited]);
  return code === 0 ? stdout : null;
};

/** `ssh -G <alias>` prints the effective config. Its `hostname` line is the real host. */
export const sshConfigHostName: SshHostName = async (alias) => {
  // An alias that starts with `-` would be an option.
  if (alias.startsWith("-")) return null;
  const child = Bun.spawn(["ssh", "-G", "--", alias], { stdin: "ignore", stdout: "pipe", stderr: "ignore" });
  const [stdout, code] = await Promise.all([new Response(child.stdout).text(), child.exited]);
  if (code !== 0) return null;
  return /^hostname (\S+)$/m.exec(stdout)?.[1] ?? null;
};

export type CheckoutProject = { readonly root: string } & RemoteSelection;

/** The worktree root of `cwd` and its remote selection. Null outside a Git repository. */
export async function findProject(
  cwd: string,
  options: { readonly home: string; readonly git?: GitRunner; readonly sshHostName?: SshHostName },
): Promise<CheckoutProject | null> {
  const git = options.git ?? readOnlyGit;
  const root = (await git(["rev-parse", "--show-toplevel"], cwd))?.trim();
  if (!root) return null;
  const selection = await selectRemote(root, git, {
    override: readRemoteOverrides(options.home)[root],
    sshHostName: options.sshHostName ?? sshConfigHostName,
  });
  return { root, ...selection };
}

function remotesPath(home: string): string {
  return join(home, ".ferry", "messaging", "remotes.json");
}

/** The remote overrides: worktree root to remote name. A missing file has none. */
export function readRemoteOverrides(home: string): Readonly<Record<string, string>> {
  const path = remotesPath(home);
  if (!existsSync(path)) return {};
  const parsed = JSON.parse(readFileSync(path, "utf8")) as { schemaVersion?: unknown; remotes?: unknown };
  const remotes = parsed?.remotes;
  if (parsed?.schemaVersion !== 1 || typeof remotes !== "object" || remotes === null || Array.isArray(remotes) || !Object.values(remotes).every((name) => typeof name === "string")) {
    throw new Error("~/.ferry/messaging/remotes.json is not valid. Run ferry messaging remote clear in the checkout.");
  }
  return remotes as Record<string, string>;
}

/** Set the remote of the worktree at `root`. `null` removes the override. */
export function setRemoteOverride(home: string, root: string, remote: string | null): void {
  const remotes: Record<string, string> = { ...readRemoteOverrides(home) };
  if (remote === null) delete remotes[root];
  else remotes[root] = remote;
  writePrivate(remotesPath(home), `${JSON.stringify({ schemaVersion: 1, remotes }, null, 2)}\n`);
}
