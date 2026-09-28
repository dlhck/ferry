import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { installTunnelService, uninstallTunnelService } from "../src/tunnel-service.ts";
import type { ServiceCommand } from "../src/watch-service.ts";

const homes: string[] = [];

afterEach(() => {
  for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true });
});

function home(): string {
  const path = mkdtempSync(join(tmpdir(), "ferry-tunnel-service-"));
  homes.push(path);
  return path;
}

function recorder(ok = true) {
  const commands: ServiceCommand[] = [];
  return {
    commands,
    run: async (command: ServiceCommand) => {
      commands.push(command);
      return { ok, stderr: ok ? "" : "not loaded" };
    },
  };
}

const darwin = (sourceHome: string, box: string) => ({
  box,
  home: sourceHome,
  platform: "darwin" as const,
  executable: "/Applications/Ferry/bin/ferry",
  uid: 501,
  path: "/opt/homebrew/bin:/usr/bin:/bin",
  sshAuthSock: "/private/tmp/agent.sock",
});

const linux = (sourceHome: string, box: string) => ({
  box,
  home: sourceHome,
  platform: "linux" as const,
  executable: "/home/me/.local/bin/ferry",
  uid: 1000,
  path: "/home/me/.local/bin:/usr/bin:/bin",
  sshAuthSock: "/run/user/1000/agent.sock",
});

describe("tunnel service installer", () => {
  test("writes and loads one launchd agent for each box", async () => {
    const sourceHome = home();
    const fake = recorder();

    const a = await installTunnelService(darwin(sourceHome, "a"), fake);
    const lab = await installTunnelService(darwin(sourceHome, "lab"), fake);

    expect(a).toEqual({ manager: "launchd", path: join(sourceHome, "Library/LaunchAgents/dev.ferry.tunnel.a.plist") });
    expect(lab.path).toBe(join(sourceHome, "Library/LaunchAgents/dev.ferry.tunnel.lab.plist"));
    const body = readFileSync(lab.path, "utf8");
    expect(body).toContain("<string>dev.ferry.tunnel.lab</string>");
    expect(body).toContain(`  <array>
    <string>/Applications/Ferry/bin/ferry</string>
    <string>tunnel</string>
    <string>--follow</string>
    <string>--box</string>
    <string>lab</string>
  </array>`);
    expect(body).toContain("<key>KeepAlive</key>\n  <true/>");
    expect(body).toContain(`<string>${join(sourceHome, "Library/Logs/ferry-tunnel-lab.log")}</string>`);
    expect(body).toContain("<string>/opt/homebrew/bin:/usr/bin:/bin</string>");
    expect(body).toContain("<key>SSH_AUTH_SOCK</key>\n    <string>/private/tmp/agent.sock</string>");
    expect(readFileSync(a.path, "utf8")).toContain("<string>a</string>");
    expect(fake.commands).toEqual([
      ["launchctl", "bootout", "gui/501/dev.ferry.tunnel.a"],
      ["launchctl", "bootstrap", "gui/501", a.path],
      ["launchctl", "bootout", "gui/501/dev.ferry.tunnel.lab"],
      ["launchctl", "bootstrap", "gui/501", lab.path],
    ]);
  });

  test("writes and enables one systemd user unit for each box that restarts after each exit", async () => {
    const sourceHome = home();
    const fake = recorder();

    const result = await installTunnelService(linux(sourceHome, "lab"), fake);

    expect(result).toEqual({ manager: "systemd", path: join(sourceHome, ".config/systemd/user/ferry-tunnel-lab.service") });
    expect(readFileSync(result.path, "utf8")).toBe(`[Unit]
Description=Ferry tunnel --follow for lab
After=network-online.target

[Service]
Type=simple
ExecStart="/home/me/.local/bin/ferry" tunnel --follow --box lab
Restart=always
RestartSec=5
Environment="PATH=/home/me/.local/bin:/usr/bin:/bin"
Environment="SSH_AUTH_SOCK=/run/user/1000/agent.sock"

[Install]
WantedBy=default.target
`);
    expect(fake.commands).toEqual([
      ["systemctl", "--user", "daemon-reload"],
      ["systemctl", "--user", "enable", "--now", "ferry-tunnel-lab.service"],
    ]);
  });

  test("refuses a relative executable path before writing", async () => {
    const sourceHome = home();

    await expect(installTunnelService({ ...linux(sourceHome, "a"), executable: "bin/ferry" }, recorder())).rejects.toThrow(
      "tunnel service needs an absolute Ferry executable path",
    );
    expect(existsSync(join(sourceHome, ".config"))).toBe(false);
  });

  test("uninstall stops the launchd agent of the box and removes its plist", async () => {
    const sourceHome = home();
    const a = await installTunnelService(darwin(sourceHome, "a"), recorder());
    const lab = await installTunnelService(darwin(sourceHome, "lab"), recorder());
    const fake = recorder();

    expect(await uninstallTunnelService({ box: "lab", home: sourceHome, platform: "darwin", uid: 501 }, fake)).toEqual({
      manager: "launchd",
      path: lab.path,
      removed: true,
    });
    expect(existsSync(lab.path)).toBe(false);
    expect(existsSync(a.path)).toBe(true);
    expect(fake.commands).toEqual([["launchctl", "bootout", "gui/501/dev.ferry.tunnel.lab"]]);
  });

  test("uninstall disables the systemd unit, removes it, and reloads", async () => {
    const sourceHome = home();
    const installed = await installTunnelService(linux(sourceHome, "lab"), recorder());
    const fake = recorder();

    expect(await uninstallTunnelService({ box: "lab", home: sourceHome, platform: "linux" }, fake)).toEqual({
      manager: "systemd",
      path: installed.path,
      removed: true,
    });
    expect(existsSync(installed.path)).toBe(false);
    expect(fake.commands).toEqual([
      ["systemctl", "--user", "disable", "--now", "ferry-tunnel-lab.service"],
      ["systemctl", "--user", "daemon-reload"],
    ]);
  });

  test("uninstall of a box without a service reports that nothing was removed", async () => {
    const sourceHome = home();
    const commands: ServiceCommand[] = [];
    // The stop command fails because nothing is loaded. Only that command can fail.
    const run = async (command: ServiceCommand, allowFailure?: boolean) => {
      commands.push(command);
      return { ok: allowFailure !== true, stderr: "" };
    };

    expect(await uninstallTunnelService({ box: "a", home: sourceHome, platform: "darwin", uid: 501 }, { run })).toEqual({
      manager: "launchd",
      path: join(sourceHome, "Library/LaunchAgents/dev.ferry.tunnel.a.plist"),
      removed: false,
    });
    expect(commands).toEqual([["launchctl", "bootout", "gui/501/dev.ferry.tunnel.a"]]);
  });
});
