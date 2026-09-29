import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { installWatchService, type ServiceCommand } from "../src/watch-service.ts";

const homes: string[] = [];

afterEach(() => {
  for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true });
});

function home(): string {
  const path = mkdtempSync(join(tmpdir(), "ferry-service-"));
  homes.push(path);
  return path;
}

describe("watch service installer", () => {
  test("writes and loads a launchd service with an absolute Ferry path", async () => {
    const sourceHome = home();
    const commands: ServiceCommand[] = [];

    const result = await installWatchService(
      {
        home: sourceHome,
        platform: "darwin",
        executable: "/Applications/Ferry/bin/ferry",
        uid: 501,
        path: "/opt/homebrew/bin:/usr/bin:/bin",
        sshAuthSock: "/private/tmp/agent.sock",
      },
      { run: async (command) => { commands.push(command); return { ok: true, stderr: "" }; } },
    );

    const body = readFileSync(result.path, "utf8");
    expect(body).toContain("<string>/Applications/Ferry/bin/ferry</string>");
    expect(body).toContain("<string>watch</string>");
    expect(body).toContain("SSH_AUTH_SOCK");
    expect(commands).toEqual([
      ["launchctl", "bootout", "gui/501/dev.ferry.watch"],
      ["launchctl", "bootstrap", "gui/501", result.path],
    ]);
  });

  test("runs the Ferry script with bun in a launchd service", async () => {
    const sourceHome = home();

    const result = await installWatchService(
      {
        home: sourceHome,
        platform: "darwin",
        executable: "/opt/homebrew/bin/bun",
        scriptPath: "/home/user/ferry/src/cli.ts",
        uid: 501,
        path: "/opt/homebrew/bin:/usr/bin:/bin",
      },
      { run: async () => ({ ok: true, stderr: "" }) },
    );

    expect(readFileSync(result.path, "utf8")).toContain(`  <array>
    <string>/opt/homebrew/bin/bun</string>
    <string>/home/user/ferry/src/cli.ts</string>
    <string>watch</string>
  </array>`);
  });

  test("writes and enables a systemd user service", async () => {
    const sourceHome = home();
    const commands: ServiceCommand[] = [];

    const result = await installWatchService(
      {
        home: sourceHome,
        platform: "linux",
        executable: "/home/me/.local/bin/ferry",
        uid: 1000,
        path: "/home/me/.local/bin:/usr/bin:/bin",
      },
      { run: async (command) => { commands.push(command); return { ok: true, stderr: "" }; } },
    );

    const body = readFileSync(result.path, "utf8");
    expect(body).toContain('ExecStart="/home/me/.local/bin/ferry" watch');
    expect(body).not.toMatch(/token|private.?key/i);
    expect(commands).toEqual([
      ["systemctl", "--user", "daemon-reload"],
      ["systemctl", "--user", "enable", "--now", "ferry-watch.service"],
    ]);
  });

  test("keeps the file names and the content of the watch service", async () => {
    const sourceHome = home();
    const run = async () => ({ ok: true, stderr: "" });
    const input = { home: sourceHome, executable: "/usr/local/bin/ferry", uid: 501, path: "/usr/bin:/bin", sshAuthSock: "/tmp/agent.sock" };

    const launchd = await installWatchService({ ...input, platform: "darwin" }, { run });
    const systemd = await installWatchService({ ...input, platform: "linux" }, { run });

    expect(launchd.path).toBe(join(sourceHome, "Library/LaunchAgents/dev.ferry.watch.plist"));
    expect(readFileSync(launchd.path, "utf8")).toBe(`<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>dev.ferry.watch</string>
  <key>ProgramArguments</key>
  <array>
    <string>/usr/local/bin/ferry</string>
    <string>watch</string>
  </array>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>StandardOutPath</key>
  <string>${sourceHome}/Library/Logs/ferry-watch.log</string>
  <key>StandardErrorPath</key>
  <string>${sourceHome}/Library/Logs/ferry-watch.log</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key>
    <string>/usr/bin:/bin</string>
    <key>SSH_AUTH_SOCK</key>
    <string>/tmp/agent.sock</string>
  </dict>
</dict>
</plist>
`);
    expect(systemd.path).toBe(join(sourceHome, ".config/systemd/user/ferry-watch.service"));
    expect(readFileSync(systemd.path, "utf8")).toBe(`[Unit]
Description=Ferry automatic sync
After=network-online.target

[Service]
Type=simple
ExecStart="/usr/local/bin/ferry" watch
Restart=on-failure
RestartSec=5
Environment="PATH=/usr/bin:/bin"
Environment="SSH_AUTH_SOCK=/tmp/agent.sock"

[Install]
WantedBy=default.target
`);
  });

  test("refuses a relative executable path before writing", async () => {
    const sourceHome = home();

    await expect(installWatchService({
      home: sourceHome,
      platform: "linux",
      executable: "bin/ferry",
      uid: 1000,
      path: "/usr/bin:/bin",
    })).rejects.toThrow("absolute Ferry executable path");
  });

  test("refuses a relative Ferry script path before writing", async () => {
    const sourceHome = home();

    await expect(installWatchService({
      home: sourceHome,
      platform: "linux",
      executable: "/home/user/.bun/bin/bun",
      scriptPath: "src/cli.ts",
      uid: 1000,
      path: "/usr/bin:/bin",
    })).rejects.toThrow("absolute Ferry script path");
  });
});
