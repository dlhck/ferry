import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { chmod, mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

// The tests run install.sh against a fake release on disk through file:// URLs.
// A fake `uname` on PATH selects the platform, so the results do not depend on the host.
const installScript = join(import.meta.dir, "..", "install.sh");

// `sh` is dash on Ubuntu and bash in POSIX mode on macOS.
const shells = ["sh", "dash", "bash"].filter((shell) => Bun.which(shell) !== null);

const stub = (version: string) => `#!/bin/sh\necho ${version}\n`;

let root: string;
let fakeBin: string;
let counter = 0;

async function writeRelease(dir: string, assets: Record<string, string>, sums?: string) {
  await mkdir(dir, { recursive: true });
  const lines: string[] = [];
  for (const [name, content] of Object.entries(assets)) {
    await writeFile(join(dir, name), content);
    lines.push(`${createHash("sha256").update(content).digest("hex")}  ${name}`);
  }
  if (sums !== "none") await writeFile(join(dir, "SHA256SUMS"), sums ?? `${lines.join("\n")}\n`);
}

// Layout of a GitHub releases URL: <base>/latest/download/<asset> and <base>/download/<tag>/<asset>.
async function fakeReleases(options: { readonly latestSums?: string } = {}) {
  const base = join(root, `releases-${counter++}`);
  await writeRelease(
    join(base, "latest", "download"),
    { "ferry-linux-x64": stub("0.3.0"), "ferry-darwin-arm64": stub("0.3.0") },
    options.latestSums,
  );
  await writeRelease(join(base, "download", "v0.2.0"), { "ferry-linux-x64": stub("0.2.0") });
  return pathToFileURL(base).href;
}

async function run(
  shell: string,
  env: Record<string, string>,
  platform: { readonly os?: string; readonly arch?: string } = {},
) {
  const child = Bun.spawn([shell, installScript], {
    stdout: "pipe",
    stderr: "pipe",
    env: {
      HOME: join(root, "home"),
      TMPDIR: root,
      PATH: `${fakeBin}:${process.env.PATH}`,
      FAKE_OS: platform.os ?? "Linux",
      FAKE_ARCH: platform.arch ?? "x86_64",
      ...env,
    },
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  return { stdout, stderr, exitCode };
}

async function installedVersion(dir: string) {
  const child = Bun.spawn([join(dir, "ferry"), "--version"], { stdout: "pipe" });
  return (await new Response(child.stdout).text()).trim();
}

async function newInstallDir() {
  return join(root, `install-${counter++}`, "bin");
}

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "ferry-install-script-"));
  fakeBin = join(root, "fake-bin");
  await mkdir(fakeBin);
  await writeFile(
    join(fakeBin, "uname"),
    '#!/bin/sh\ncase "$1" in\n  -s) echo "$FAKE_OS" ;;\n  -m) echo "$FAKE_ARCH" ;;\n  *) exit 1 ;;\nesac\n',
  );
  await chmod(join(fakeBin, "uname"), 0o755);
});

afterAll(async () => {
  await rm(root, { recursive: true, force: true });
});

describe.each(shells)("install.sh with %s", (shell) => {
  test("installs the latest release and prints the version", async () => {
    const dir = await newInstallDir();
    const result = await run(shell, { FERRY_DOWNLOAD_BASE: await fakeReleases(), FERRY_INSTALL_DIR: dir });

    expect(result.stderr).toBe("");
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain(`Installed ferry 0.3.0 to ${join(dir, "ferry")}`);
    expect(await installedVersion(dir)).toBe("0.3.0");
  });

  test("selects the asset for the platform", async () => {
    const dir = await newInstallDir();
    const result = await run(
      shell,
      { FERRY_DOWNLOAD_BASE: await fakeReleases(), FERRY_INSTALL_DIR: dir },
      { os: "Darwin", arch: "arm64" },
    );

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("Downloading ferry-darwin-arm64");
  });

  test("installs the release in FERRY_VERSION", async () => {
    const dir = await newInstallDir();
    const result = await run(shell, {
      FERRY_DOWNLOAD_BASE: await fakeReleases(),
      FERRY_INSTALL_DIR: dir,
      FERRY_VERSION: "v0.2.0",
    });

    expect(result.exitCode).toBe(0);
    expect(await installedVersion(dir)).toBe("0.2.0");
  });

  test("replaces an existing binary", async () => {
    const dir = await newInstallDir();
    const base = await fakeReleases();
    await run(shell, { FERRY_DOWNLOAD_BASE: base, FERRY_INSTALL_DIR: dir, FERRY_VERSION: "v0.2.0" });
    const result = await run(shell, { FERRY_DOWNLOAD_BASE: base, FERRY_INSTALL_DIR: dir });

    expect(result.exitCode).toBe(0);
    expect(await installedVersion(dir)).toBe("0.3.0");
  });

  test("installs to ~/.local/bin without FERRY_INSTALL_DIR", async () => {
    const home = join(root, `home-${counter++}`);
    const result = await run(shell, { FERRY_DOWNLOAD_BASE: await fakeReleases(), HOME: home });

    expect(result.exitCode).toBe(0);
    expect(await installedVersion(join(home, ".local", "bin"))).toBe("0.3.0");
  });

  test("prints a PATH hint only when the install directory is not on PATH", async () => {
    const dir = await newInstallDir();
    const base = await fakeReleases();
    const off = await run(shell, { FERRY_DOWNLOAD_BASE: base, FERRY_INSTALL_DIR: dir });
    const on = await run(shell, {
      FERRY_DOWNLOAD_BASE: base,
      FERRY_INSTALL_DIR: dir,
      PATH: `${fakeBin}:${dir}:${process.env.PATH}`,
    });

    expect(off.stdout).toContain(`${dir} is not on your PATH`);
    expect(off.stdout).toContain(`export PATH="${dir}:$PATH"`);
    expect(on.exitCode).toBe(0);
    expect(on.stdout).not.toContain("is not on your PATH");
  });

  test("refuses a checksum mismatch and keeps the existing binary", async () => {
    const dir = await newInstallDir();
    await run(shell, { FERRY_DOWNLOAD_BASE: await fakeReleases(), FERRY_INSTALL_DIR: dir, FERRY_VERSION: "v0.2.0" });
    const bad = await fakeReleases({ latestSums: `${"0".repeat(64)}  ferry-linux-x64\n` });
    const result = await run(shell, { FERRY_DOWNLOAD_BASE: bad, FERRY_INSTALL_DIR: dir });

    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain("Checksum mismatch for ferry-linux-x64");
    expect(await installedVersion(dir)).toBe("0.2.0");
  });

  test("refuses an asset that SHA256SUMS does not list", async () => {
    const dir = await newInstallDir();
    const bad = await fakeReleases({ latestSums: `${"0".repeat(64)}  ferry-linux-arm64\n` });
    const result = await run(shell, { FERRY_DOWNLOAD_BASE: bad, FERRY_INSTALL_DIR: dir });

    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain("SHA256SUMS has no checksum for ferry-linux-x64");
    expect(await Bun.file(join(dir, "ferry")).exists()).toBe(false);
  });

  test("refuses a release without SHA256SUMS unless FERRY_SKIP_CHECKSUM=1", async () => {
    const dir = await newInstallDir();
    const base = await fakeReleases({ latestSums: "none" });
    const refused = await run(shell, { FERRY_DOWNLOAD_BASE: base, FERRY_INSTALL_DIR: dir });

    expect(refused.exitCode).not.toBe(0);
    expect(refused.stderr).toContain("Cannot download SHA256SUMS");
    expect(await Bun.file(join(dir, "ferry")).exists()).toBe(false);

    const skipped = await run(shell, { FERRY_DOWNLOAD_BASE: base, FERRY_INSTALL_DIR: dir, FERRY_SKIP_CHECKSUM: "1" });

    expect(skipped.exitCode).toBe(0);
    expect(skipped.stderr).toContain("Warning: FERRY_SKIP_CHECKSUM=1");
    expect(await installedVersion(dir)).toBe("0.3.0");
  });

  test("refuses an unsupported operating system", async () => {
    const dir = await newInstallDir();
    const result = await run(
      shell,
      { FERRY_DOWNLOAD_BASE: await fakeReleases(), FERRY_INSTALL_DIR: dir },
      { os: "FreeBSD" },
    );

    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain("Ferry does not support the operating system FreeBSD");
    expect(await Bun.file(join(dir, "ferry")).exists()).toBe(false);
  });

  test("refuses an unsupported CPU architecture", async () => {
    const dir = await newInstallDir();
    const result = await run(
      shell,
      { FERRY_DOWNLOAD_BASE: await fakeReleases(), FERRY_INSTALL_DIR: dir },
      { arch: "riscv64" },
    );

    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain("Ferry does not support the CPU architecture riscv64");
    expect(await Bun.file(join(dir, "ferry")).exists()).toBe(false);
  });

  test("leaves no temporary files", async () => {
    const dir = await newInstallDir();
    await run(shell, { FERRY_DOWNLOAD_BASE: await fakeReleases(), FERRY_INSTALL_DIR: dir });

    const bad = await fakeReleases({ latestSums: `${"0".repeat(64)}  ferry-linux-x64\n` });
    await run(shell, { FERRY_DOWNLOAD_BASE: bad, FERRY_INSTALL_DIR: dir });

    expect(await readdir(dir)).toEqual(["ferry"]);
    expect((await readdir(root)).filter((name) => name.startsWith("ferry-install."))).toEqual([]);
  });
});
