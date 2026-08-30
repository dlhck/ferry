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
});
