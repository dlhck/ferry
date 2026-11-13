/**
 * TEMPORARY, until lane B merges `src/messaging/client/remote.ts` (design
 * section 4). The types and the signature of `findProject` are the same as
 * there, so the swap is one import. This copy has no `remotes.json` override,
 * no SSH host alias, and no `invalid-remote`: `origin` when it is a GitHub
 * URL, else the only GitHub remote.
 */
export type GitRunner = (args: readonly string[], cwd: string) => Promise<string | null>;
export type SshHostName = (alias: string) => Promise<string | null>;
export type RemoteSelection =
  | { readonly ok: true; readonly remote: string; readonly key: string }
  | { readonly ok: false; readonly code: "no-remote" | "unknown-remote" | "unsupported-host" | "invalid-remote" | "ambiguous-remote"; readonly remotes: readonly string[] };
export type CheckoutProject = { readonly root: string } & RemoteSelection;

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

export async function findProject(
  cwd: string,
  options: { readonly home: string; readonly git?: GitRunner; readonly sshHostName?: SshHostName },
): Promise<CheckoutProject | null> {
  const git = options.git ?? readOnlyGit;
  const root = (await git(["rev-parse", "--show-toplevel"], cwd))?.trim();
  if (!root) return null;
  const github = (url: string): string | null => {
    const match = /^(?:https?:\/\/(?:[^@/]+@)?|ssh:\/\/(?:[^@/]+@)?|git:\/\/|[^@/]+@)(?:ssh\.)?github\.com(?::443)?[:/]([^/]+)\/([^/]+?)(?:\.git)?\/*$/i.exec(url.trim());
    return match ? `github.com/${match[1]!.toLowerCase()}/${match[2]!.toLowerCase()}` : null;
  };
  const names = ((await git(["remote"], root)) ?? "").split("\n").filter((name) => name !== "");
  if (names.length === 0) return { root, ok: false, code: "no-remote", remotes: names };
  const keys = new Map<string, string>();
  for (const name of names) {
    const key = github((await git(["remote", "get-url", name], root)) ?? "");
    if (key) keys.set(name, key);
  }
  const origin = keys.get("origin");
  if (origin) return { root, ok: true, remote: "origin", key: origin };
  if (keys.size === 1) {
    const [remote, key] = [...keys][0]!;
    return { root, ok: true, remote, key };
  }
  return { root, ok: false, code: keys.size === 0 ? "unsupported-host" : "ambiguous-remote", remotes: names };
}
