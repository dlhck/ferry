/**
 * The actions of `ferry messaging` and `ferry relay` (section 11.7 of the
 * agent messaging design). `src/cli.ts` loads this module with `await
 * import(...)` in each action, so a command that does not use messaging loads
 * none of it.
 *
 * The relay, the GitHub App, the enrollment, and the relay client come from
 * other modules of the feature. `part` loads each of them through one narrow
 * interface. When a module is not in this build, the command fails with a
 * clear error.
 */

import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir, hostname } from "node:os";
import { join } from "node:path";
import { quoteShell } from "../box-settings.ts";
import { isRelayUrl, setBoxMessagingKey, setMessagingRelay } from "../config.ts";
import { FerryError } from "../errors.ts";
import { LOGIN } from "./ids.ts";
import type { GitHubAccess } from "./relay/access.ts";
import type { LinkResult, RunOptions } from "../link.ts";
import { spawnSync } from "node:child_process";
import { installUserService, launchdPath, systemdPath, uninstallUserService, type WatchServiceResult } from "../watch-service.ts";
import { callWorker, MESSAGING_DIR, workerSocketPath } from "./hook.ts";
import { MESSAGING_SERVICE, RELAY_DIR, RELAY_SERVICE, type MessagingStatus, type WorkerStatusView } from "./setup.ts";

/** The worker answers `status` from its local store, so the call is short. */
const STATUS_TIMEOUT_MS = 3000;

/** `enroll` of the enrollment module: the device flow, then `credential` and `client.json` in `~/.ferry/messaging`. */
export type EnrollPart = {
  enroll(input: { relayUrl: string; home: string; deviceName: string; print: (line: string) => void }): Promise<{
    owner: { login: string };
    device: { id: string; name: string };
  }>;
  /** A new device of the same owner for a box. `client` is the `client.json` of the box. Nothing goes to disk on this machine. */
  enrollBox(input: { home: string; deviceName: string }): Promise<{ credential: string; client: Readonly<Record<string, unknown>> }>;
};

/**
 * The relay client, with the device credential of this host. It is the
 * `RelayTransport` of the worker (`src/messaging/worker/outbox.ts`): one
 * call of the relay API of section 7, which gives the status and the JSON body.
 */
export type RelayTransport = {
  request(call: { method: "GET" | "POST" | "PATCH"; path: string; body?: unknown; idempotencyKey?: string; signal?: AbortSignal }): Promise<{ status: number; body: unknown }>;
};
export type RelayClientPart = { openRelayClient(input: { home: string }): Promise<RelayTransport> };

/** Remote selection (section 5.1). `projectKey` gives `github.com/<owner>/<repo>` of the checkout of `cwd`, or throws a coded error. */
export type RemotePart = {
  projectKey(input: { cwd: string; home: string }): Promise<string>;
  /** Set or clear (`remote` null) the remote override of the checkout of `cwd` in `remotes.json`. Returns the checkout root. */
  setRemoteOverride(input: { cwd: string; home: string; remote: string | null }): Promise<{ root: string }>;
};

/** The GitHub App of the relay. */
export type GitHubAppPart = {
  setupGitHubApp(input: { home: string; org?: string; public: boolean; name?: string; print: (line: string) => void }): Promise<{ slug: string; appId: number }>;
  importGitHubApp(input: { home: string; appId: number; clientId: string; slug: string; keyFile: string }): Promise<{ slug: string; appId: number }>;
};

/** The GitHub access of the relay (`src/messaging/github/access.ts`). `app` is the `github` value of the relay config. */
export type GitHubAccessPart = {
  createGitHubAccess(config: { app: unknown; privateKey: string }): GitHubAccess;
};

/** The worker (`src/messaging/worker/worker.ts`). */
export type WorkerPart = {
  runWorker(input: { home: string; client: RelayTransport; adapters: readonly unknown[]; clock: { now(): number }; log?: (line: string) => void }): Promise<{ stop(): Promise<void> }>;
  defaultAdapters(home: string, clock: { now(): number }): readonly unknown[];
};

/** `ferry messaging worker`: the worker with the relay client and the adapters of this host, until SIGINT or SIGTERM. */
export async function runWorkerService(home: string, log: Print): Promise<void> {
  const { runWorker, defaultAdapters } = await part<WorkerPart>("worker");
  const { openRelayClient } = await part<RelayClientPart>("client");
  const clock = { now: () => Date.now() };
  const worker = await runWorker({ home, client: await openRelayClient({ home }), adapters: defaultAdapters(home, clock), clock, log });
  await new Promise<void>((resolve) => {
    for (const signal of ["SIGINT", "SIGTERM"] as const) process.once(signal, () => resolve());
  });
  await worker.stop();
}

const PARTS = {
  enroll: { specifier: "./client/enroll.ts", what: "messaging enrollment" },
  client: { specifier: "./client/relay-client.ts", what: "relay client" },
  remote: { specifier: "./client/remote.ts", what: "remote selection" },
  app: { specifier: "./github/manifest.ts", what: "GitHub App setup" },
  access: { specifier: "./github/access.ts", what: "GitHub access" },
  worker: { specifier: "./worker/worker.ts", what: "messaging worker" },
} as const;

/**
 * Load a module of the feature. The specifier is a variable, so the build
 * does not need the module.
 */
export async function part<T>(name: keyof typeof PARTS): Promise<T> {
  const { specifier, what } = PARTS[name];
  try {
    return (await import(specifier)) as T;
  } catch (cause) {
    // Only a missing module means that the build has no such part. Other errors of the module stay.
    if (!/cannot find module|module not found/i.test(String(cause))) throw cause;
    throw new FerryError("failed", `This Ferry build has no ${what}.`, { hint: "Install a Ferry release with agent messaging." });
  }
}

type Print = (line: string) => void;

/** `ferry messaging status`: ask the worker. A worker that does not answer gives `stopped`, with the local files. */
export async function messagingStatus(home = homedir(), call = callWorker): Promise<MessagingStatus> {
  const client = readClient(home);
  const enrolled = client !== null && existsSync(join(home, MESSAGING_DIR, "credential"));
  const relayUrl = typeof client?.relayUrl === "string" ? client.relayUrl : null;
  const response = await call(workerSocketPath(home), "status", {}, STATUS_TIMEOUT_MS);
  const running = response.ok && typeof response.result === "object" && response.result !== null;
  return { worker: running ? "running" : "stopped", enrolled, relayUrl, status: running ? (response.result as WorkerStatusView) : null };
}

export function messagingStatusLines(result: MessagingStatus): string[] {
  if (!result.enrolled) return ["This machine has no messaging enrollment. Run ferry messaging enroll --relay <url>."];
  const lines = [`Worker: ${result.worker}`, `Relay: ${result.relayUrl ?? "unknown"}`];
  const { status } = result;
  if (status === null) return [...lines, `Start it with ferry messaging setup, or see the log of ${MESSAGING_SERVICE.unit}.`];
  const live = status.sessions.filter((session) => session.state === "live");
  lines.push(
    `Relay state: ${status.relay.reachable ? "reachable" : `unreachable, last contact ${status.relay.lastContactAt ?? "never"}`}`,
    ...(status.revoked ? ["The relay revoked the credential of this machine. Run ferry messaging enroll again."] : []),
    ...live.map((session) => `Session ${session.runtime} ${session.runtimeVersion}: ${session.adapter}`),
    ...(status.unregisteredCodex.length > 0 ? ["Codex has not trusted the Ferry hooks. Open /hooks in Codex once."] : []),
    `Live sessions: ${live.length}. Held deliveries: ${status.deliveries.held}. Failed deliveries: ${status.deliveries.failed}. Outbox: ${status.outbox.pending}, ${status.outbox.failed.length} failed.`,
  );
  return lines;
}

/** `ferry messaging enroll --relay <url>`: enroll this machine, and write the URL into `[messaging]`. */
export async function enrollMachine(input: { relayUrl: string; home?: string; print: Print }): Promise<{ owner: string; device: string; relayUrl: string }> {
  const home = input.home ?? homedir();
  if (!isRelayUrl(input.relayUrl)) {
    throw new FerryError("usage", `${input.relayUrl} is not a relay URL. Use https://<host>, or http:// only for localhost.`);
  }
  const { enroll } = await part<EnrollPart>("enroll");
  const result = await enroll({ relayUrl: input.relayUrl, home, deviceName: hostname(), print: input.print });
  setMessagingRelay(input.relayUrl, home);
  return { owner: result.owner.login, device: result.device.id, relayUrl: input.relayUrl };
}

type BoxLink = { run(command: string, options?: RunOptions): Promise<LinkResult> };

/**
 * `ferry messaging enroll --box <b>`: a new device credential for the box. It
 * goes to the box on SSH standard input, and never into a file on this
 * machine or into an argument. The box key `messaging` becomes true.
 */
export async function enrollBox(input: { box: string; link: BoxLink; home?: string }): Promise<{ box: string; keyChanged: boolean }> {
  const home = input.home ?? homedir();
  const { enrollBox: create } = await part<EnrollPart>("enroll");
  const { credential, client } = await create({ home, deviceName: input.box });
  const script = [
    "umask 077",
    `d="$HOME/${MESSAGING_DIR}"`,
    'mkdir -p "$d" && chmod 700 "$d" || exit 1',
    'IFS= read -r credential || exit 1',
    'IFS= read -r client || exit 1',
    `printf '%s\\n' "$client" > "$d/client.json.tmp" && mv -f "$d/client.json.tmp" "$d/client.json" || exit 1`,
    `printf '%s' "$credential" > "$d/credential.tmp" && mv -f "$d/credential.tmp" "$d/credential" || exit 1`,
  ].join("\n");
  const result = await input.link.run(`sh -c ${quoteShell(script)}`, {
    input: new TextEncoder().encode(`${credential}\n${JSON.stringify(client)}\n`),
  });
  if (!result.ok) {
    throw new FerryError("box-command-failed", `Ferry could not write the messaging credential on box ${input.box}: ${result.error.message}`, {
      hint: `Revoke the new device with ferry messaging revoke, then run ferry messaging enroll --box ${input.box} again.`,
    });
  }
  return { box: input.box, keyChanged: setBoxMessagingKey(input.box, "messaging", true, home) };
}

/** `ferry messaging relay-url <url>`: the new relay URL in `[messaging]` and in `client.json` of this machine. Sync writes it to the boxes. */
export function changeRelayUrl(relayUrl: string, home = homedir()): { relayUrl: string; client: boolean } {
  if (!isRelayUrl(relayUrl)) throw new FerryError("usage", `${relayUrl} is not a relay URL. Use https://<host>, or http:// only for localhost.`);
  setMessagingRelay(relayUrl, home);
  const client = readClient(home);
  if (client === null) return { relayUrl, client: false };
  const path = join(home, MESSAGING_DIR, "client.json");
  writeFileSync(`${path}.tmp`, `${JSON.stringify({ ...client, relayUrl }, null, 2)}\n`, { mode: 0o600 });
  renameSync(`${path}.tmp`, path);
  return { relayUrl, client: true };
}

/** `ferry messaging remote set <name>|clear`. */
export async function setRemote(remote: string | null, cwd = process.cwd(), home = homedir()): Promise<{ root: string; remote: string | null }> {
  const { setRemoteOverride } = await part<RemotePart>("remote");
  const { root } = await setRemoteOverride({ cwd, home, remote });
  return { root, remote };
}

/** One relay call for a view. A JSON error body of the relay becomes a FerryError with its code and message. */
export type RelayCall = (method: "GET" | "POST", path: string, query?: Readonly<Record<string, string>>, body?: unknown) => Promise<unknown>;

/** A read-only view, or a device action: relay calls with the credential of this host. `project` gives the project of the current directory. */
export async function relayView(read: (call: RelayCall, project: () => Promise<{ id: string }>) => Promise<unknown>, cwd = process.cwd(), home = homedir()): Promise<unknown> {
  const { openRelayClient } = await part<RelayClientPart>("client");
  const client = await openRelayClient({ home });
  const call: RelayCall = async (method, path, query = {}, body) => {
    const search = new URLSearchParams(query).toString();
    const answer = await client.request({ method, path: search === "" ? path : `${path}?${search}`, ...(body === undefined ? {} : { body }) });
    if (answer.status >= 200 && answer.status < 300) return answer.body;
    const error = (answer.body as { error?: { code?: unknown; message?: unknown } } | null)?.error;
    throw new FerryError("failed", `The relay refused the call: ${typeof error?.code === "string" ? error.code : `HTTP ${answer.status}`}${typeof error?.message === "string" ? `. ${error.message}` : ""}`);
  };
  const project = async () => {
    const { projectKey } = await part<RemotePart>("remote");
    const key = await projectKey({ cwd, home });
    return ((await call("GET", "/v1/projects", { key })) as { project: { id: string } }).project;
  };
  return read(call, project);
}

/** `ferry relay install`: the relay service on this machine, with `~/.ferry/relay` (0700). */
export async function installRelay(home = homedir()): Promise<WatchServiceResult> {
  mkdirSync(join(home, RELAY_DIR), { recursive: true, mode: 0o700 });
  chmodSync(join(home, RELAY_DIR), 0o700);
  return installUserService(RELAY_SERVICE, { home });
}

/** `ferry relay uninstall`: remove the service. Without `keepData`, remove `~/.ferry/relay` too, with the data of the team. */
export async function uninstallRelay(keepData: boolean, home = homedir()): Promise<{ removed: boolean; dataRemoved: boolean }> {
  const result = await uninstallUserService(RELAY_SERVICE, { home });
  if (keepData || !existsSync(join(home, RELAY_DIR))) return { removed: result.removed, dataRemoved: false };
  const { rmSync } = await import("node:fs");
  rmSync(join(home, RELAY_DIR), { recursive: true, force: true });
  return { removed: result.removed, dataRemoved: true };
}

/** The relay config file, relative to the home. The GitHub App setup writes `github`, and `ferry relay owners` writes `allowedOwners`. */
export const RELAY_CONFIG_FILE = `${RELAY_DIR}/config.json`;

/** The relay config. A missing file is an empty config. */
export function readRelayConfig(home = homedir()): { readonly github: unknown; readonly allowedOwners: readonly string[]; readonly rest: Record<string, unknown> } {
  let value: unknown = {};
  try {
    value = JSON.parse(readFileSync(join(home, RELAY_CONFIG_FILE), "utf8"));
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code !== "ENOENT") throw new FerryError("failed", `~/${RELAY_CONFIG_FILE} is not valid JSON.`);
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new FerryError("failed", `~/${RELAY_CONFIG_FILE} is not a JSON object.`);
  const rest = value as Record<string, unknown>;
  const owners = Array.isArray(rest.allowedOwners) ? rest.allowedOwners.filter((owner): owner is string => typeof owner === "string") : [];
  return { github: rest.github ?? null, allowedOwners: owners, rest };
}

/**
 * `ferry relay owners [add|remove <owner>]`. A change writes
 * `allowedOwners` of the relay config (0600, atomic), keeps the other keys,
 * and restarts the relay service when this machine has it. GitHub logins
 * compare without case.
 */
export function relayOwners(
  input: { readonly add?: string; readonly remove?: string },
  home = homedir(),
  restart: () => boolean = () => restartRelay(home),
): { owners: readonly string[]; changed: boolean; restarted: boolean } {
  const config = readRelayConfig(home);
  const owner = input.add ?? input.remove;
  if (owner === undefined) return { owners: config.allowedOwners, changed: false, restarted: false };
  if (!LOGIN.test(owner)) throw new FerryError("usage", `${owner} is not a GitHub user or organization name.`);
  const same = (entry: string) => entry.toLowerCase() === owner.toLowerCase();
  const owners =
    input.add !== undefined
      ? config.allowedOwners.some(same) ? config.allowedOwners : [...config.allowedOwners, owner]
      : config.allowedOwners.filter((entry) => !same(entry));
  if (owners.length === config.allowedOwners.length) return { owners, changed: false, restarted: false };
  const path = join(home, RELAY_CONFIG_FILE);
  mkdirSync(join(home, RELAY_DIR), { recursive: true, mode: 0o700 });
  writeFileSync(`${path}.tmp`, `${JSON.stringify({ ...config.rest, allowedOwners: owners }, null, 2)}\n`, { mode: 0o600 });
  chmodSync(`${path}.tmp`, 0o600);
  renameSync(`${path}.tmp`, path);
  return { owners, changed: true, restarted: restart() };
}

/** The relay store and the GitHub App key, relative to the home. */
export const RELAY_DB_FILE = `${RELAY_DIR}/relay.db`;
const RELAY_KEY_FILE = `${RELAY_DIR}/github-app.pem`;

/** `ferry relay serve`: the relay with the config of `~/.ferry/relay`, until SIGINT or SIGTERM. */
export async function serveRelay(listen: string, version: string, log: Print, home = homedir()): Promise<void> {
  const { github, allowedOwners } = readRelayConfig(home);
  let privateKey: string;
  try {
    privateKey = readFileSync(join(home, RELAY_KEY_FILE), "utf8");
  } catch {
    privateKey = "";
  }
  if (github === null || privateKey === "") {
    throw new FerryError("failed", "The relay has no GitHub App.", { hint: "Run ferry relay setup github-app or ferry relay import-github-app." });
  }
  const { startRelay } = await import("./relay/server.ts");
  const { createGitHubAccess } = await part<GitHubAccessPart>("access");
  const relay = await startRelay({
    dbPath: join(home, RELAY_DB_FILE),
    listen,
    github: createGitHubAccess({ app: github, privateKey }),
    clock: { now: () => Date.now() },
    // The relay log events have no secret values. Each event is one JSON line on stderr, for the journal.
    log: (event, fields) => log(JSON.stringify({ event, ...fields })),
    allowedOwners,
    relayVersion: version,
  });
  await new Promise<void>((resolve) => {
    for (const signal of ["SIGINT", "SIGTERM"] as const) process.once(signal, () => resolve());
  });
  await relay.stop();
}

/**
 * `ferry relay backup`. With `to` "-", the copy goes to a private file in
 * `~/.ferry/relay` first, and Ferry returns its bytes and removes it.
 */
export async function backupRelay(to: string | null, home = homedir()): Promise<{ path: string | null; bytes: Uint8Array | null }> {
  const { backupStore } = await import("./relay/backup.ts");
  const db = join(home, RELAY_DB_FILE);
  if (to !== "-") return { path: backupStore(db, to ?? undefined), bytes: null };
  const temporary = join(home, RELAY_DIR, `.backup-stdout-${process.pid}.db`);
  const { rmSync } = await import("node:fs");
  try {
    backupStore(db, temporary);
    return { path: null, bytes: readFileSync(temporary) };
  } finally {
    rmSync(temporary, { force: true });
  }
}

/** `ferry relay restore`. Returns the path of the moved store, or null. */
export async function restoreRelay(file: string, home = homedir()): Promise<string | null> {
  const { restoreStore } = await import("./relay/backup.ts");
  return restoreStore(file, join(home, RELAY_DB_FILE));
}

/** `ferry relay status`: the local state of the relay host. It does not open the store. */
export async function relayStatus(version: string, home = homedir()): Promise<{
  version: string;
  service: boolean;
  database: { path: string; bytes: number | null };
  lastBackup: string | null;
  githubApp: boolean;
  owners: readonly string[];
}> {
  const { latestBackup } = await import("./relay/backup.ts");
  const { statSync } = await import("node:fs");
  const db = join(home, RELAY_DB_FILE);
  const config = readRelayConfig(home);
  const service = process.platform === "darwin" ? launchdPath(RELAY_SERVICE, home) : systemdPath(RELAY_SERVICE, home);
  return {
    version,
    service: existsSync(service),
    database: { path: db, bytes: existsSync(db) ? statSync(db).size : null },
    lastBackup: latestBackup(db),
    githubApp: config.github !== null && existsSync(join(home, RELAY_KEY_FILE)),
    owners: config.allowedOwners,
  };
}

/** Restart the relay service when this machine has it, so that it reads the new config. True when it restarted. */
function restartRelay(home: string): boolean {
  if (process.platform === "darwin") {
    if (!existsSync(launchdPath(RELAY_SERVICE, home))) return false;
    return spawnSync("launchctl", ["kickstart", "-k", `gui/${process.getuid?.()}/${RELAY_SERVICE.label}`], { stdio: "ignore" }).status === 0;
  }
  if (!existsSync(systemdPath(RELAY_SERVICE, home))) return false;
  return spawnSync("systemctl", ["--user", "try-restart", RELAY_SERVICE.unit], { stdio: "ignore" }).status === 0;
}

function readClient(home: string): Record<string, unknown> | null {
  try {
    const value = JSON.parse(readFileSync(join(home, MESSAGING_DIR, "client.json"), "utf8"));
    return typeof value === "object" && value !== null && !Array.isArray(value) ? value : null;
  } catch {
    return null;
  }
}
