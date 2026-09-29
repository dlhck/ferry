/** Install the foreground watcher under the platform user service manager. */

import { existsSync, mkdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join } from "node:path";

export type ServiceCommand = readonly string[];

export type WatchServiceInput = {
  readonly home?: string;
  readonly platform?: NodeJS.Platform;
  readonly executable?: string;
  readonly scriptPath?: string;
  readonly uid?: number;
  readonly path?: string;
  readonly sshAuthSock?: string;
};

export type WatchServiceDependencies = {
  readonly run?: (command: ServiceCommand, allowFailure?: boolean) => Promise<ServiceCommandResult>;
  readonly sleep?: (milliseconds: number) => Promise<void>;
  readonly now?: () => number;
};

export type WatchServiceResult = {
  readonly manager: "launchd" | "systemd";
  readonly path: string;
};

export type ServiceCommandResult = { readonly ok: boolean; readonly stderr: string };

/** One Ferry user service: its names for launchd and systemd, and the Ferry arguments that it runs. */
export type UserService = {
  /** The command in messages, such as `watch`. */
  readonly command: string;
  /** The launchd label. The plist is `~/Library/LaunchAgents/<label>.plist`. */
  readonly label: string;
  /** The file name of the launchd log in `~/Library/Logs/`. */
  readonly log: string;
  /** The systemd unit name in `~/.config/systemd/user/`. */
  readonly unit: string;
  readonly description: string;
  readonly args: readonly string[];
  /** The systemd `Restart=` value. launchd restarts the service each time it exits, except for `"no"`. */
  readonly restart: "no" | "on-failure" | "always";
  /** More environment variables of the service, after PATH and SSH_AUTH_SOCK. */
  readonly environment?: Readonly<Record<string, string>>;
};

export const WATCH_SERVICE: UserService = {
  command: "watch",
  label: "dev.ferry.watch",
  log: "ferry-watch.log",
  unit: "ferry-watch.service",
  description: "Ferry automatic sync",
  args: ["watch"],
  restart: "on-failure",
};

const LAUNCHD_REMOVAL_POLL_MS = 200;
const LAUNCHD_REMOVAL_TIMEOUT_MS = 5_000;

export async function installWatchService(
  input: WatchServiceInput = {},
  dependencies: WatchServiceDependencies = {},
): Promise<WatchServiceResult> {
  return installUserService(WATCH_SERVICE, input, dependencies);
}

export async function installUserService(
  service: UserService,
  input: WatchServiceInput = {},
  dependencies: WatchServiceDependencies = {},
): Promise<WatchServiceResult> {
  const home = input.home ?? homedir();
  const platform = input.platform ?? process.platform;
  const executable = input.executable ?? process.execPath;
  const scriptPath = input.scriptPath ?? process.argv[1];
  const uid = input.uid ?? process.getuid?.();
  const environmentPath = input.path ?? process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin";
  const sshAuthSock = input.sshAuthSock ?? process.env.SSH_AUTH_SOCK;
  const run = dependencies.run ?? runCommand;
  const sleep = dependencies.sleep ?? ((milliseconds: number) => Bun.sleep(milliseconds));
  const now = dependencies.now ?? Date.now;
  requireSafeAbsolute(service, executable, "Ferry executable");
  const command = [executable];
  if (basename(executable) === "bun") {
    if (scriptPath === undefined) throw new Error(`${service.command} service needs the Ferry script path`);
    requireSafeAbsolute(service, scriptPath, "Ferry script");
    command.push(scriptPath);
  }
  requireSafe(service, environmentPath, "PATH");
  if (sshAuthSock) requireSafeAbsolute(service, sshAuthSock, "SSH_AUTH_SOCK");
  for (const [name, value] of Object.entries(service.environment ?? {})) requireSafe(service, `${name}=${value}`, name);

  if (platform === "darwin") {
    if (uid === undefined) throw new Error("launchd setup needs the current user id");
    const path = launchdPath(service, home);
    const log = join(home, "Library", "Logs", service.log);
    mkdirSync(dirname(log), { recursive: true });
    writeService(path, launchdService(service, command, environmentPath, sshAuthSock, log));
    const target = `gui/${uid}/${service.label}`;
    await run(["launchctl", "bootout", target], true);
    await waitForLaunchdRemoval(service.label, target, run, sleep, now);
    await checked(run, ["launchctl", "bootstrap", `gui/${uid}`, path]);
    return { manager: "launchd", path };
  }

  if (platform === "linux") {
    const path = systemdPath(service, home);
    writeService(path, systemdService(service, command, environmentPath, sshAuthSock));
    await checked(run, ["systemctl", "--user", "daemon-reload"]);
    await checked(run, ["systemctl", "--user", "enable", "--now", service.unit]);
    return { manager: "systemd", path };
  }

  throw new Error(`ferry ${service.command} install does not support ${platform}`);
}

async function waitForLaunchdRemoval(
  label: string,
  target: string,
  run: NonNullable<WatchServiceDependencies["run"]>,
  sleep: NonNullable<WatchServiceDependencies["sleep"]>,
  now: NonNullable<WatchServiceDependencies["now"]>,
): Promise<void> {
  const deadline = now() + LAUNCHD_REMOVAL_TIMEOUT_MS;
  while ((await run(["launchctl", "print", target], true)).ok) {
    if (now() >= deadline) {
      throw new Error(`launchd did not remove ${label} within 5 seconds. Run launchctl bootout ${target} and retry.`);
    }
    await sleep(LAUNCHD_REMOVAL_POLL_MS);
  }
}

/** Stop the service and remove its file. `removed` is false when the file was not there. The launchd log stays. */
export async function uninstallUserService(
  service: UserService,
  input: Pick<WatchServiceInput, "home" | "platform" | "uid"> = {},
  dependencies: WatchServiceDependencies = {},
): Promise<WatchServiceResult & { readonly removed: boolean }> {
  const home = input.home ?? homedir();
  const platform = input.platform ?? process.platform;
  const uid = input.uid ?? process.getuid?.();
  const run = dependencies.run ?? runCommand;

  if (platform === "darwin") {
    if (uid === undefined) throw new Error("launchd setup needs the current user id");
    const path = launchdPath(service, home);
    const removed = existsSync(path);
    await run(["launchctl", "bootout", `gui/${uid}/${service.label}`], true);
    rmSync(path, { force: true });
    return { manager: "launchd", path, removed };
  }

  if (platform === "linux") {
    const path = systemdPath(service, home);
    const removed = existsSync(path);
    await run(["systemctl", "--user", "disable", "--now", service.unit], true);
    rmSync(path, { force: true });
    await checked(run, ["systemctl", "--user", "daemon-reload"]);
    return { manager: "systemd", path, removed };
  }

  throw new Error(`ferry ${service.command} uninstall does not support ${platform}`);
}

export function launchdPath(service: UserService, home: string): string {
  return join(home, "Library", "LaunchAgents", `${service.label}.plist`);
}

export function systemdPath(service: UserService, home: string): string {
  return join(home, ".config", "systemd", "user", service.unit);
}

function launchdService(
  service: UserService,
  command: readonly string[],
  environmentPath: string,
  sshAuthSock: string | undefined,
  log: string,
): string {
  const environment = Object.entries({ ...(sshAuthSock ? { SSH_AUTH_SOCK: sshAuthSock } : {}), ...service.environment })
    .map(([name, value]) => `\n    <key>${xml(name)}</key>\n    <string>${xml(value)}</string>`)
    .join("");
  const args = [...command, ...service.args].map((arg) => `\n    <string>${xml(arg)}</string>`).join("");
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${xml(service.label)}</string>
  <key>ProgramArguments</key>
  <array>${args}
  </array>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <${service.restart === "no" ? "false" : "true"}/>
  <key>StandardOutPath</key>
  <string>${xml(log)}</string>
  <key>StandardErrorPath</key>
  <string>${xml(log)}</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key>
    <string>${xml(environmentPath)}</string>${environment}
  </dict>
</dict>
</plist>
`;
}

function systemdService(
  service: UserService,
  command: readonly string[],
  environmentPath: string,
  sshAuthSock: string | undefined,
): string {
  const environment = Object.entries({ ...(sshAuthSock ? { SSH_AUTH_SOCK: sshAuthSock } : {}), ...service.environment })
    .map(([name, value]) => `Environment="${name}=${systemd(value)}"\n`)
    .join("");
  // The arguments are fixed words and box names, so they need no quotes.
  const commandLine = command.map((arg) => `"${systemd(arg)}"`).join(" ");
  return `[Unit]
Description=${service.description}
After=network-online.target

[Service]
Type=simple
ExecStart=${commandLine} ${service.args.join(" ")}
Restart=${service.restart}
RestartSec=5
Environment="PATH=${systemd(environmentPath)}"
${environment}
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

export async function checked(
  run: NonNullable<WatchServiceDependencies["run"]>,
  command: ServiceCommand,
): Promise<void> {
  const result = await run(command);
  if (!result.ok) throw new Error(`${command[0]} failed: ${result.stderr || "unknown error"}`);
}

export async function runCommand(command: ServiceCommand, allowFailure = false): Promise<ServiceCommandResult> {
  const child = Bun.spawn([...command], { stdout: "ignore", stderr: "pipe" });
  const [status, stderr] = await Promise.all([child.exited, new Response(child.stderr).text()]);
  const result = { ok: status === 0, stderr: stderr.trim() };
  if (!result.ok && !allowFailure) return result;
  return result;
}

function requireSafeAbsolute(service: UserService, value: string, name: string): void {
  requireSafe(service, value, name);
  if (!isAbsolute(value)) throw new Error(`${service.command} service needs an absolute ${name} path: ${value}`);
}

function requireSafe(service: UserService, value: string, name: string): void {
  if (/\r|\n|\0/.test(value)) throw new Error(`${service.command} service refused invalid ${name}`);
}

function xml(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");
}

function systemd(value: string): string {
  return value.replaceAll("\\", "\\\\").replaceAll('"', '\\"');
}
