/**
 * The guard for the rule that a test does not start a real tool binary. `bunfig.toml`
 * loads this file one time before the test files.
 *
 * It puts a directory of stubs in front of PATH for the test run. Each stub has the
 * name of a program whose presence, version, login, or speed depends on the machine.
 * A stub records the call and exits with 127. The test that started it fails, with
 * the command in the message. The result is the same on each machine, and no real
 * tool can hang a test.
 *
 * A test that needs such a command injects a fake runner, or puts its own fake in a
 * directory in front of PATH. The guard does not see a program that a test starts
 * with a full path, or with a PATH that does not come from `process.env`.
 */

import { afterAll, afterEach } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const DENIED = [
  // The tools of the registry, and the programs of the integrations.
  "gh", "claude", "codex", "pi", "cursor-agent", "paseo", "sherlock",
  // The connection to a box.
  "ssh", "scp", "tailscale",
  // Service managers.
  "systemctl", "loginctl", "launchctl",
  // Package managers, and the programs that install with them.
  "npm", "npx", "pnpm", "yarn", "brew", "apt", "apt-get", "sudo",
];

const root = mkdtempSync(join(tmpdir(), "ferry-test-guard-"));
const bin = join(root, "bin");
const calls = join(root, "calls");
const stub = join(root, "stub");
mkdirSync(bin);
// The stub finds the record file from its own path, so it also works in a process with another environment.
writeFileSync(
  stub,
  `#!/bin/sh
printf '%s\\n' "\${0##*/} $*" >> "\${0%/*}/../calls"
echo "test guard: a test started the real \${0##*/}" >&2
exit 127
`,
  { mode: 0o755 },
);
for (const name of DENIED) symlinkSync(stub, join(bin, name));
process.env.PATH = `${bin}:${process.env.PATH ?? ""}`;

// Without `env`, Bun gives a child the environment from the start of the process, not `process.env`.
// Give it `process.env`, so the stubs are in front of the PATH of that child too.
type Options = { readonly env?: unknown };
const withEnv = (options?: Options): Options => (options?.env === undefined ? { ...options, env: process.env } : options);
for (const name of ["spawn", "spawnSync"] as const) {
  const real = Bun[name].bind(Bun) as (...args: unknown[]) => unknown;
  Object.assign(Bun, {
    [name]: (first: unknown, second?: Options) =>
      Array.isArray(first) ? real(first, withEnv(second)) : real(withEnv(first as Options)),
  });
}

afterEach(() => {
  if (!existsSync(calls)) return;
  const started = readFileSync(calls, "utf8").trim().split("\n");
  rmSync(calls);
  throw new Error(
    `This test started a real tool binary: ${started.join("; ")}. ` +
      "Inject a fake through the dependencies of the command, or put a fake program in front of PATH. See test/preload.ts.",
  );
});

afterAll(() => rmSync(root, { recursive: true, force: true }));
