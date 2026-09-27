import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { chmod, copyFile, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

// The launcher runs under Node, so the test starts it with `node`.
const launcherSource = join(import.meta.dir, "..", "npm", "ferry", "bin", "ferry.js");

// The stub prints its arguments, copies stdin to stdout, writes to stderr, and exits with STUB_EXIT.
// With STUB_WAIT set, it waits for SIGTERM and exits 7.
const stubBinary = `#!/bin/sh
if [ -n "$STUB_WAIT" ]; then
  trap 'echo got-term; exit 7' TERM
  echo ready
  while :; do sleep 0.05; done
fi
for arg in "$@"; do echo "arg:$arg"; done
cat
echo "stub-stderr" >&2
exit "\${STUB_EXIT:-0}"
`;

let root: string;
let launcher: string;
let emptyLauncher: string;
let fakeWin32: string;

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "ferry-launcher-"));

  const installed = join(root, "installed", "node_modules", "@dlhck");
  await mkdir(join(installed, "ferry", "bin"), { recursive: true });
  launcher = join(installed, "ferry", "bin", "ferry.js");
  await copyFile(launcherSource, launcher);
  const platformPackage = join(installed, `ferry-${process.platform}-${process.arch}`);
  await mkdir(join(platformPackage, "bin"), { recursive: true });
  await writeFile(join(platformPackage, "package.json"), '{"name":"stub"}\n');
  await writeFile(join(platformPackage, "bin", "ferry"), stubBinary);
  await chmod(join(platformPackage, "bin", "ferry"), 0o755);

  const empty = join(root, "empty", "node_modules", "@dlhck", "ferry", "bin");
  await mkdir(empty, { recursive: true });
  emptyLauncher = join(empty, "ferry.js");
  await copyFile(launcherSource, emptyLauncher);

  fakeWin32 = join(root, "win32.cjs");
  await writeFile(fakeWin32, 'Object.defineProperty(process, "platform", { value: "win32" });\n');
});

afterAll(async () => {
  await rm(root, { recursive: true, force: true });
});

async function run(
  args: readonly string[],
  options: { readonly stdin?: string; readonly env?: Record<string, string> } = {},
) {
  const child = Bun.spawn(["node", ...args], {
    stdin: new Blob([options.stdin ?? ""]),
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env, ...options.env },
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  return { stdout, stderr, exitCode };
}

describe("npm launcher", () => {
  test("passes arguments, stdin, stdout, and stderr through to the platform binary", async () => {
    const result = await run([launcher, "sync", "--dry-run", "two words"], { stdin: "from-stdin\n" });

    expect(result.stdout).toBe("arg:sync\narg:--dry-run\narg:two words\nfrom-stdin\n");
    expect(result.stderr).toBe("stub-stderr\n");
    expect(result.exitCode).toBe(0);
  });

  test("exits with the exit code of the platform binary", async () => {
    const result = await run([launcher], { env: { STUB_EXIT: "3" } });

    expect(result.exitCode).toBe(3);
  });

  test("forwards SIGTERM to the platform binary", async () => {
    const child = Bun.spawn(["node", launcher], {
      stdout: "pipe",
      stderr: "pipe",
      env: { ...process.env, STUB_WAIT: "1" },
    });
    const reader = child.stdout.getReader();
    let stdout = "";
    while (!stdout.includes("ready")) {
      const chunk = await reader.read();
      if (chunk.done) break;
      stdout += new TextDecoder().decode(chunk.value);
    }
    child.kill("SIGTERM");
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) break;
      stdout += new TextDecoder().decode(chunk.value);
    }

    expect(stdout).toBe("ready\ngot-term\n");
    expect(await child.exited).toBe(7);
  });

  test("names the supported platforms on an unsupported platform", async () => {
    const result = await run(["--require", fakeWin32, launcher, "--help"]);

    expect(result.exitCode).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain(`Ferry has no binary for win32-${process.arch}.`);
    expect(result.stderr).toContain("darwin-arm64, darwin-x64, linux-arm64, linux-x64");
  });

  test("names the missing platform package when npm did not install it", async () => {
    const result = await run([emptyLauncher, "--help"]);

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain(`@dlhck/ferry-${process.platform}-${process.arch}`);
    expect(result.stderr).toContain("npm i -g @dlhck/ferry");
  });
});
