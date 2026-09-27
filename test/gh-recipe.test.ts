import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BUILTIN_TOOLS } from "../src/registry/builtin.ts";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

/**
 * Fake box commands. `sudo` writes its arguments to the log and
 * changes nothing. `apt-cache madison gh` lists the versions in `$VERSIONS`.
 */
const FAKES: Record<string, string> = {
  sudo: 'echo "sudo $*" >> "$LOG"; [ "$1" = tee ] && cat > /dev/null; exit 0',
  wget: 'for arg in "$@"; do case "$arg" in -O*) : > "${arg#-O}" ;; esac; done',
  dpkg: "echo amd64",
  mktemp: 'f="$HOME/keyring.$$"; : > "$f"; echo "$f"',
  "apt-cache": `[ "$1 $2" = "madison gh" ] || exit 1
for version in $VERSIONS; do echo "        gh | $version | https://cli.github.com/packages stable/main amd64 Packages"; done`,
};

async function run(command: string, versions: string): Promise<{ stdout: string; log: string[] }> {
  const root = mkdtempSync(join(tmpdir(), "ferry-gh-recipe-"));
  roots.push(root);
  const bin = join(root, "bin");
  mkdirSync(bin);
  for (const [name, body] of Object.entries(FAKES)) {
    writeFileSync(join(bin, name), `#!/bin/sh\n${body}\n`);
    chmodSync(join(bin, name), 0o755);
  }
  const log = join(root, "log");
  writeFileSync(log, "");
  const process = Bun.spawn(["sh", "-c", command], {
    cwd: root,
    env: { PATH: `${bin}:${Bun.env.PATH ?? "/usr/bin:/bin"}`, HOME: root, LOG: log, VERSIONS: versions },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(process.stdout).text(),
    new Response(process.stderr).text(),
    process.exited,
  ]);
  if (exitCode !== 0) throw new Error(`exit ${exitCode}: ${stderr}`);
  return { stdout, log: readFileSync(log, "utf8").split("\n").filter((line) => line !== "") };
}

const gh = BUILTIN_TOOLS.find((tool) => tool.id === "gh");
const recipe = gh?.recipe;
if (!recipe) throw new Error("gh has no recipe");

describe("gh version recipe", () => {
  test("installs the exact version when the GitHub apt repository has it", async () => {
    const { stdout, log } = await run(recipe.install("2.63.0"), "2.64.0 2.63.0 2.62.0");

    expect(log).toContain("sudo apt update");
    expect(log.at(-1)).toBe("sudo apt install gh=2.63.0 -y --allow-downgrades");
    expect(stdout).not.toContain("Warning");
  });

  test("installs the latest version with a warning when the version is missing", async () => {
    const { stdout, log } = await run(recipe.install("2.10.1"), "2.64.0 2.63.0");

    expect(log.at(-1)).toBe("sudo apt install gh -y");
    expect(stdout).toContain(
      "Warning: the GitHub apt repository has no gh 2.10.1. Ferry installs the latest gh.",
    );
  });

  test("a version is not a pattern: 2.6 does not match 2.63.0", async () => {
    const { log } = await run(recipe.install("2.6"), "2.63.0");

    expect(log.at(-1)).toBe("sudo apt install gh -y");
  });

  test("the install adds the GitHub apt source before the version check", async () => {
    const { log } = await run(recipe.install("2.63.0"), "2.63.0");

    expect(log.some((line) => line.startsWith("sudo tee /etc/apt/sources.list.d/github-cli.list"))).toBe(true);
  });

  test("the update pins the version without the apt source setup", async () => {
    const { log } = await run(recipe.update("2.63.0"), "2.63.0");

    expect(log).toEqual(["sudo apt update", "sudo apt install gh=2.63.0 -y --allow-downgrades"]);
  });

  test("the update falls back to the latest version with a warning", async () => {
    const { stdout, log } = await run(recipe.update("9.9.9"), "2.63.0");

    expect(log).toEqual(["sudo apt update", "sudo apt install gh -y"]);
    expect(stdout).toContain("Warning: the GitHub apt repository has no gh 9.9.9.");
  });

  test("the version is shell-quoted", () => {
    expect(recipe.install("1.0'; reboot; '")).toContain(`'1.0'"'"'; reboot; '"'"''`);
  });

  test("the latest recipes stay", () => {
    expect(gh?.install?.command).toEndWith("&& sudo apt install gh -y");
    expect(gh?.update?.command).toBe("sudo apt update && sudo apt install gh -y");
  });
});
