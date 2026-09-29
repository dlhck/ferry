import { afterEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { installMenuBar, MENUBAR_ASSET, resolveFerryPath, uninstallMenuBar } from "../src/menubar.ts";
import type { ServiceCommand } from "../src/watch-service.ts";

const directories: string[] = [];

afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function directory(): string {
  const path = mkdtempSync(join(tmpdir(), "ferry-menubar-"));
  directories.push(path);
  return path;
}

function fakeRun(commands: ServiceCommand[], fail?: string) {
  return async (command: ServiceCommand) => {
    commands.push(command);
    if (command[1] === "print") return { ok: false, stderr: "Could not find service" };
    return command[0] === fail ? { ok: false, stderr: "denied" } : { ok: true, stderr: "" };
  };
}

const RELEASE = { platform: "darwin", uid: 501, version: "1.2.0", execPath: "/Users/me/.local/bin/ferry", path: "/opt/homebrew/bin:/usr/bin:/bin", sshAuthSock: "/private/tmp/agent.sock" } as const;

describe("menu bar app installer", () => {
  test("downloads the release zip, verifies its checksum, unpacks it, and loads the launchd agent", async () => {
    const home = directory();
    const commands: ServiceCommand[] = [];
    const zip = new TextEncoder().encode("zip bytes");
    const sum = createHash("sha256").update(zip).digest("hex");
    const urls: string[] = [];

    const result = await installMenuBar(
      { ...RELEASE, home },
      {
        run: fakeRun(commands),
        download: async (url) => {
          urls.push(url);
          return url.endsWith("SHA256SUMS")
            ? new TextEncoder().encode(`0000  ferry-darwin-arm64\n${sum}  ${MENUBAR_ASSET}\n`)
            : zip;
        },
      },
    );

    const app = join(home, "Applications", "Ferry Menu Bar.app");
    const plist = join(home, "Library", "LaunchAgents", "dev.ferry.menubar.plist");
    expect(result).toEqual({ app, path: plist, version: "1.2.0", ferryPath: "/Users/me/.local/bin/ferry" });
    expect(urls.sort()).toEqual([
      "https://github.com/dlhck/ferry/releases/download/v1.2.0/SHA256SUMS",
      `https://github.com/dlhck/ferry/releases/download/v1.2.0/${MENUBAR_ASSET}`,
    ]);
    expect(commands[0]).toEqual(["launchctl", "bootout", "gui/501/dev.ferry.menubar"]);
    expect(commands[1]?.slice(0, 3)).toEqual(["ditto", "-x", "-k"]);
    expect(commands[1]?.[4]).toBe(join(home, "Applications"));
    expect(commands.at(-1)).toEqual(["launchctl", "bootstrap", "gui/501", plist]);

    const body = readFileSync(plist, "utf8");
    expect(body).toContain(`<string>${app}/Contents/MacOS/FerryMenuBar</string>`);
    expect(body).toContain("<key>FERRY_PATH</key>\n    <string>/Users/me/.local/bin/ferry</string>");
    expect(body).toContain("<key>FERRY_MENUBAR_SOURCE</key>\n    <string>release</string>");
    expect(body).toContain("<string>/opt/homebrew/bin:/usr/bin:/bin</string>");
    expect(body).toContain("<key>RunAtLoad</key>\n  <true/>");
    expect(body).toContain("<key>KeepAlive</key>\n  <false/>");
    expect(body).toContain("<key>SSH_AUTH_SOCK</key>\n    <string>/private/tmp/agent.sock</string>");
  });

  test("refuses a download whose checksum does not match, before it unpacks", async () => {
    const commands: ServiceCommand[] = [];
    const install = installMenuBar(
      { ...RELEASE, home: directory() },
      {
        run: fakeRun(commands),
        download: async (url) => new TextEncoder().encode(url.endsWith("SHA256SUMS") ? `${"a".repeat(64)} *${MENUBAR_ASSET}\n` : "other"),
      },
    );
    await expect(install).rejects.toThrow(`Checksum mismatch for ${MENUBAR_ASSET}`);
    expect(commands.some((command) => command[0] === "ditto")).toBe(false);
  });

  test("refuses a release whose SHA256SUMS has no line for the app", async () => {
    const install = installMenuBar(
      { ...RELEASE, home: directory() },
      { run: fakeRun([]), download: async () => new TextEncoder().encode("0000  ferry-darwin-arm64\n") },
    );
    await expect(install).rejects.toThrow(`has no checksum for ${MENUBAR_ASSET}`);
  });

  test("a development build without --app names --app and macos/build.sh", async () => {
    const install = installMenuBar({ ...RELEASE, home: directory(), version: "0.0.0-dev" }, { run: fakeRun([]), download: async () => { throw new Error("downloaded"); } });
    await expect(install).rejects.toMatchObject({
      code: "usage",
      message: expect.stringContaining("development build"),
      hint: "Build the app with macos/build.sh, then run ferry menubar install --app <path>.",
    });
  });

  test("--app copies a local .app directory without a download", async () => {
    const home = directory();
    const build = join(directory(), "Ferry Menu Bar.app");
    mkdirSync(build);
    const commands: ServiceCommand[] = [];

    const result = await installMenuBar(
      { ...RELEASE, home, version: "0.0.0-dev", app: build },
      { run: fakeRun(commands), download: async () => { throw new Error("downloaded"); } },
    );

    expect(result.version).toBeNull();
    expect(commands[1]).toEqual(["ditto", build, join(home, "Applications", "Ferry Menu Bar.app")]);
    expect(readFileSync(result.path, "utf8")).toContain("<key>FERRY_MENUBAR_SOURCE</key>\n    <string>local</string>");
  });

  test("--app unpacks a local zip without a download", async () => {
    const home = directory();
    const zip = join(directory(), MENUBAR_ASSET);
    writeFileSync(zip, "zip");
    const commands: ServiceCommand[] = [];

    await installMenuBar(
      { ...RELEASE, home, version: "0.0.0-dev", app: zip },
      { run: fakeRun(commands), download: async () => { throw new Error("downloaded"); } },
    );

    expect(commands[1]).toEqual(["ditto", "-x", "-k", zip, join(home, "Applications")]);
  });

  test("--app refuses a path that does not exist", async () => {
    const missing = join(directory(), "missing.zip");
    await expect(installMenuBar({ ...RELEASE, home: directory(), app: missing }, { run: fakeRun([]) })).rejects.toThrow(`${missing} does not exist.`);
  });

  test("a failed unpack stops the install before the agent loads", async () => {
    const home = directory();
    const zip = join(directory(), MENUBAR_ASSET);
    writeFileSync(zip, "zip");
    const commands: ServiceCommand[] = [];
    await expect(installMenuBar({ ...RELEASE, home, app: zip }, { run: fakeRun(commands, "ditto") })).rejects.toThrow("ditto failed: denied");
    expect(existsSync(join(home, "Library", "LaunchAgents", "dev.ferry.menubar.plist"))).toBe(false);
  });

  test("install and uninstall refuse other platforms", async () => {
    await expect(installMenuBar({ ...RELEASE, platform: "linux", home: directory() }, { run: fakeRun([]) })).rejects.toMatchObject({
      code: "usage",
      message: "ferry menubar install runs only on macOS. This machine runs linux.",
    });
    await expect(uninstallMenuBar({ platform: "linux", home: directory() }, { run: fakeRun([]) })).rejects.toMatchObject({ code: "usage" });
  });

  test("uninstall stops the agent and removes the agent and the app", async () => {
    const home = directory();
    const commands: ServiceCommand[] = [];
    const app = join(home, "Applications", "Ferry Menu Bar.app");
    const plist = join(home, "Library", "LaunchAgents", "dev.ferry.menubar.plist");
    mkdirSync(join(app, "Contents"), { recursive: true });
    mkdirSync(join(home, "Library", "LaunchAgents"), { recursive: true });
    writeFileSync(plist, "plist");

    expect(await uninstallMenuBar({ platform: "darwin", uid: 501, home }, { run: fakeRun(commands) })).toEqual({ app, path: plist, removed: true });
    expect(commands).toEqual([["launchctl", "bootout", "gui/501/dev.ferry.menubar"]]);
    expect(existsSync(app)).toBe(false);
    expect(existsSync(plist)).toBe(false);

    expect((await uninstallMenuBar({ platform: "darwin", uid: 501, home }, { run: fakeRun([]) })).removed).toBe(false);
  });
});

describe("FERRY_PATH of the menu bar app", () => {
  const which = (found: string | null) => (name: string) => (name === "ferry" ? found : null);

  test("keeps the path of a compiled Ferry", () => {
    expect(resolveFerryPath("/Users/me/.local/bin/ferry", which("/other/ferry"))).toBe("/Users/me/.local/bin/ferry");
  });

  test("takes ferry from PATH when Ferry runs under bun", () => {
    expect(resolveFerryPath("/Users/me/.bun/bin/bun", which("/Users/me/.bun/bin/ferry"))).toBe("/Users/me/.bun/bin/ferry");
    expect(resolveFerryPath("C:/bun/bun.exe", which("/Users/me/.bun/bin/ferry"))).toBe("/Users/me/.bun/bin/ferry");
  });

  test("fails under bun when PATH has no ferry", () => {
    expect(() => resolveFerryPath("/Users/me/.bun/bin/bun", which(null))).toThrow("Ferry runs under bun, and PATH has no ferry.");
  });

  test("under bun, the agent runs only the app binary, and FERRY_PATH is the ferry on PATH", async () => {
    const home = directory();
    const build = join(directory(), "Ferry Menu Bar.app");
    mkdirSync(build);

    const result = await installMenuBar(
      { ...RELEASE, home, version: "0.0.0-dev", execPath: "/Users/me/.bun/bin/bun", app: build },
      { run: fakeRun([]), which: which("/Users/me/.bun/bin/ferry") },
    );

    const body = readFileSync(result.path, "utf8");
    const programArguments = [...body.split("<key>ProgramArguments</key>")[1]!.split("</array>")[0]!.matchAll(/<string>(.*)<\/string>/g)].map(
      (match) => match[1],
    );
    expect(programArguments).toEqual([join(home, "Applications", "Ferry Menu Bar.app", "Contents", "MacOS", "FerryMenuBar")]);
    expect(body).toContain("<key>FERRY_PATH</key>\n    <string>/Users/me/.bun/bin/ferry</string>");
  });

  test("install fails before it changes anything when PATH has no ferry", async () => {
    const commands: ServiceCommand[] = [];
    await expect(
      installMenuBar({ ...RELEASE, home: directory(), execPath: "/Users/me/.bun/bin/bun" }, { run: fakeRun(commands), which: () => null }),
    ).rejects.toMatchObject({ code: "usage", hint: "Run bun link in the Ferry checkout, or install a Ferry release." });
    expect(commands).toEqual([]);
  });
});
