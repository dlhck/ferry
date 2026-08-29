/** Install the foreground watcher under the platform user service manager. */

import { mkdirSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join } from "node:path";

export type ServiceCommand = readonly string[];

export type WatchServiceInput = {
  readonly home?: string;
  readonly platform?: NodeJS.Platform;
  readonly executable?: string;
  readonly uid?: number;
  readonly path?: string;
  readonly sshAuthSock?: string;
};

export type WatchServiceDependencies = {
  readonly run?: (command: ServiceCommand, allowFailure?: boolean) => Promise<ServiceCommandResult>;
};

export type WatchServiceResult = {
  readonly manager: "launchd" | "systemd";
  readonly path: string;
};

type ServiceCommandResult = { readonly ok: boolean; readonly stderr: string };

export async function installWatchService(
  input: WatchServiceInput = {},
  dependencies: WatchServiceDependencies = {},
): Promise<WatchServiceResult> {
  const home = input.home ?? homedir();
  const platform = input.platform ?? process.platform;
  const executable = input.executable ?? process.execPath;
  const uid = input.uid ?? process.getuid?.();
  const environmentPath = input.path ?? process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin";
  const sshAuthSock = input.sshAuthSock ?? process.env.SSH_AUTH_SOCK;
  const run = dependencies.run ?? runCommand;
  requireSafeAbsolute(executable, "Ferry executable");
  requireSafe(environmentPath, "PATH");
  if (sshAuthSock) requireSafeAbsolute(sshAuthSock, "SSH_AUTH_SOCK");

  if (platform === "darwin") {
    if (uid === undefined) throw new Error("launchd setup needs the current user id");
    const path = join(home, "Library", "LaunchAgents", "dev.ferry.watch.plist");
    const log = join(home, "Library", "Logs", "ferry-watch.log");
    mkdirSync(dirname(log), { recursive: true });
    writeService(path, launchdService(executable, environmentPath, sshAuthSock, log));
    await run(["launchctl", "bootout", `gui/${uid}/dev.ferry.watch`], true);
    await checked(run, ["launchctl", "bootstrap", `gui/${uid}`, path]);
    return { manager: "launchd", path };
  }

  if (platform === "linux") {
    const path = join(home, ".config", "systemd", "user", "ferry-watch.service");
    writeService(path, systemdService(executable, environmentPath, sshAuthSock));
    await checked(run, ["systemctl", "--user", "daemon-reload"]);
    await checked(run, ["systemctl", "--user", "enable", "--now", "ferry-watch.service"]);
    return { manager: "systemd", path };
  }

  throw new Error(`ferry watch install does not support ${platform}`);
}

function launchdService(
  executable: string,
  environmentPath: string,
  sshAuthSock: string | undefined,
  log: string,
): string {
  const socket = sshAuthSock
    ? `\n    <key>SSH_AUTH_SOCK</key>\n    <string>${xml(sshAuthSock)}</string>`
    : "";
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>dev.ferry.watch</string>
  <key>ProgramArguments</key>
  <array>
    <string>${xml(executable)}</string>
    <string>watch</string>
  </array>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>StandardOutPath</key>
  <string>${xml(log)}</string>
  <key>StandardErrorPath</key>
  <string>${xml(log)}</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key>
    <string>${xml(environmentPath)}</string>${socket}
  </dict>
</dict>
</plist>
`;
}

function systemdService(
  executable: string,
  environmentPath: string,
  sshAuthSock: string | undefined,
): string {
  const socket = sshAuthSock ? `Environment="SSH_AUTH_SOCK=${systemd(sshAuthSock)}"\n` : "";
  return `[Unit]
Description=Ferry automatic sync
After=network-online.target

[Service]
Type=simple
ExecStart="${systemd(executable)}" watch
Restart=on-failure
RestartSec=5
Environment="PATH=${systemd(environmentPath)}"
${socket}
[Install]
WantedBy=default.target
`;
}

function writeService(path: string, body: string): void {
  const temporary = `${path}.tmp`;
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(temporary, body, { mode: 0o600 });
  renameSync(temporary, path);
}

async function checked(
  run: NonNullable<WatchServiceDependencies["run"]>,
  command: ServiceCommand,
): Promise<void> {
  const result = await run(command);
  if (!result.ok) throw new Error(`${command[0]} failed: ${result.stderr || "unknown error"}`);
}

async function runCommand(command: ServiceCommand, allowFailure = false): Promise<ServiceCommandResult> {
  const child = Bun.spawn([...command], { stdout: "ignore", stderr: "pipe" });
  const [status, stderr] = await Promise.all([child.exited, new Response(child.stderr).text()]);
  const result = { ok: status === 0, stderr: stderr.trim() };
  if (!result.ok && !allowFailure) return result;
  return result;
}

function requireSafeAbsolute(value: string, name: string): void {
  requireSafe(value, name);
  if (!isAbsolute(value)) throw new Error(`watch service needs an absolute ${name} path: ${value}`);
}

function requireSafe(value: string, name: string): void {
  if (/\r|\n|\0/.test(value)) throw new Error(`watch service refused invalid ${name}`);
}

function xml(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");
}

function systemd(value: string): string {
  return value.replaceAll("\\", "\\\\").replaceAll('"', '\\"');
}
