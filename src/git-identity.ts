/** Git identity reads for the operator machine and the box, and the guarded box write. */

import { configuredValue, type GitRunner } from "./store.ts";

export type GitIdentity = {
  readonly name: string | null;
  readonly email: string | null;
};

/** Print the global box identity. Prints nothing when git or the values are missing. */
export const BOX_GIT_IDENTITY_COMMAND =
  "git config --global --get-regexp '^user\\.(name|email)$' 2>/dev/null || true";

/** Read the identity that Store uses for snapshot commits. */
export async function readOperatorGitIdentity(git: GitRunner, cwd: string): Promise<GitIdentity> {
  return {
    name: await configuredValue(git, cwd, "user.name"),
    email: await configuredValue(git, cwd, "user.email"),
  };
}

/** Parse the output of BOX_GIT_IDENTITY_COMMAND. The last value of a key wins, as in git. */
export function parseGitIdentity(stdout: string): GitIdentity {
  let name: string | null = null;
  let email: string | null = null;
  for (const line of stdout.split(/\r?\n/)) {
    const match = /^user\.(name|email) (.*)$/.exec(line);
    const value = match?.[2]?.trim() || null;
    if (match?.[1] === "name") name = value;
    if (match?.[1] === "email") email = value;
  }
  return { name, email };
}

/** Set each global box key that has no value. Keys that have a value stay unchanged. */
export function setBoxGitIdentityCommand(identity: { name: string; email: string }): string {
  return [
    setMissingKey("user.name", identity.name),
    setMissingKey("user.email", identity.email),
  ].join(" && ");
}

function setMissingKey(key: string, value: string): string {
  return `{ git config --global --get ${key} >/dev/null || git config --global ${key} ${quoteShell(value)}; }`;
}

function quoteShell(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}
