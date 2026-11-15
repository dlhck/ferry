/**
 * The actions of `ferry messaging` and `ferry relay` (section 11.7 of the
 * agent messaging design). `src/cli.ts` loads this module with `await
 * import(...)` in each action, so a command that does not use messaging loads
 * none of it.
 *
 * Each action loads the worker, the relay, and the GitHub modules with a
 * literal `await import("./...")`. `bun build --compile` bundles only the
 * modules that it can find, so the specifier must stay a literal.
 */

import { spawn, spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readFileSync, statSync } from "node:fs";
import { homedir, hostname } from "node:os";
import { join } from "node:path";
import { isRelayUrl, setBoxMessagingKey, setMessagingRelay } from "../config.ts";
import { FerryError } from "../errors.ts";
import type { LinkResult, RunOptions } from "../link.ts";
import { VERSION } from "../version.ts";
import { installUserService, launchdPath, systemdPath, uninstallUserService, type WatchServiceResult } from "../watch-service.ts";
import { readClientConfig, readCredential, writeClientConfig } from "./client/credential.ts";
import { RelayClient, RelayError } from "./client/relay-client.ts";
import type { GitHubAppResult } from "./github/manifest.ts";
import { callWorker } from "./hook.ts";
import type { StoreCounts } from "./relay/store.ts";
import { MESSAGING_SERVICE, RELAY_DIR, RELAY_SERVICE, type MessagingStatus } from "./setup.ts";
import type { WorkerStatus } from "./worker/worker.ts";
import { workerSocketPath } from "./worker/socket.ts";

/** The worker answers `status` from its local store, so the call is short. */
const STATUS_TIMEOUT_MS = 3000;

type Print = (line: string) => void;

/** `ferry messaging worker`: the worker with the relay client and the adapters of this host. On SIGINT or SIGTERM, it stops the worker. */
export async function runWorkerService(home: string, log: Print): Promise<void> {
  const { runWorker, defaultAdapters } = await import("./worker/worker.ts");
  const clock = { now: () => Date.now() };
  const worker = await runWorker({ home, client: openRelayClient(home), adapters: defaultAdapters(home, clock), clock, log });
  await new Promise<void>((resolve) => {
    for (const signal of ["SIGINT", "SIGTERM"] as const) process.once(signal, () => resolve());
  });
  await worker.stop();
}

/** `ferry messaging status`: ask the worker. A worker that does not answer gives `stopped`, with the local files. */
export async function messagingStatus(home = homedir(), call = callWorker): Promise<MessagingStatus> {
  let relayUrl: string | null = null;
  let enrolled = false;
  try {
    relayUrl = readClientConfig(home)?.relayUrl ?? null;
    enrolled = relayUrl !== null && readCredential(home) !== null;
  } catch {
    // An invalid credential or client.json is no enrollment. ferry messaging enroll writes them again.
  }
  const response = await call(workerSocketPath(home), "status", {}, STATUS_TIMEOUT_MS);
  const running = response.ok && typeof response.result === "object" && response.result !== null;
  return { worker: running ? "running" : "stopped", enrolled, relayUrl, status: running ? (response.result as WorkerStatus) : null };
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
export async function enrollMachine(
  input: { relayUrl: string; home?: string; print: Print },
  load: () => Promise<Pick<typeof import("./client/enroll.ts"), "enroll" | "currentPlatform">> = () => import("./client/enroll.ts"),
): Promise<{ owner: string; device: string; relayUrl: string }> {
  const home = input.home ?? homedir();
  if (!isRelayUrl(input.relayUrl)) {
    throw new FerryError("usage", `${input.relayUrl} is not a relay URL. Use https://<host>, or http:// only for localhost.`);
  }
  const { enroll, currentPlatform } = await load();
  let result: Awaited<ReturnType<typeof enroll>>;
  try {
    result = await enroll({ home, relayUrl: input.relayUrl, deviceName: hostname(), platform: currentPlatform(), ferryVersion: VERSION, print: input.print });
  } catch (error) {
    throw relayFailure(error);
  }
  setMessagingRelay(input.relayUrl, home);
  return { owner: result.owner.login, device: result.device.id, relayUrl: input.relayUrl };
}

type BoxLink = { run(command: string, options?: RunOptions): Promise<LinkResult> };

/**
 * `ferry messaging enroll --box <b>`: a new device credential for the box.
 * The enrollment module writes it on the box over the link, never into a
 * file on this machine or into an argument. The box key `messaging` becomes
 * true.
 */
export async function enrollBox(input: { box: string; link: BoxLink; home?: string }): Promise<{ box: string; device: string; keyChanged: boolean }> {
  const home = input.home ?? homedir();
  const { enrollBox: create } = await import("./client/enroll.ts");
  let device: { id: string };
  try {
    ({ device } = await create({ home, box: input.box, link: input.link, ferryVersion: VERSION }));
  } catch (error) {
    throw relayFailure(error);
  }
  return { box: input.box, device: device.id, keyChanged: setBoxMessagingKey(input.box, "messaging", true, home) };
}

/** `ferry messaging relay-url <url>`: the new relay URL in `[messaging]` and in `client.json` of this machine. Sync writes it to the boxes. */
export function changeRelayUrl(relayUrl: string, home = homedir()): { relayUrl: string; client: boolean } {
  if (!isRelayUrl(relayUrl)) throw new FerryError("usage", `${relayUrl} is not a relay URL. Use https://<host>, or http:// only for localhost.`);
  setMessagingRelay(relayUrl, home);
  const client = readClientConfig(home);
  if (client === null) return { relayUrl, client: false };
  writeClientConfig(home, { ...client, relayUrl });
  return { relayUrl, client: true };
}

/** `ferry messaging remote set <name>|clear`. */
export async function setRemote(remote: string | null, cwd = process.cwd(), home = homedir()): Promise<{ root: string; remote: string | null }> {
  const { findProject, setRemoteOverride } = await import("./client/remote.ts");
  const project = await findProject(cwd, { home });
  if (project === null) throw new FerryError("usage", "The current directory is not in a Git checkout.");
  setRemoteOverride(home, project.root, remote);
  return { root: project.root, remote };
}

/** One relay call for a view. A JSON error body of the relay becomes a FerryError with its code and message. */
export type RelayCall = (method: "GET" | "POST", path: string, query?: Readonly<Record<string, string>>, body?: unknown) => Promise<unknown>;

/** A read-only view, or a device action: relay calls with the credential of this host. `project` gives the project of the current directory. */
export async function relayView(read: (call: RelayCall, project: () => Promise<{ id: string }>) => Promise<unknown>, cwd = process.cwd(), home = homedir()): Promise<unknown> {
  const client = openRelayClient(home);
  const call: RelayCall = async (method, path, query = {}, body) => {
    const search = new URLSearchParams(query).toString();
    const answer = await client.request({ method, path: search === "" ? path : `${path}?${search}`, ...(body === undefined ? {} : { body }) });
    if (answer.status >= 200 && answer.status < 300) return answer.body;
    throw relayRefusal(answer.status, answer.body);
  };
  const project = async () => {
    const { findProject } = await import("./client/remote.ts");
    const found = await findProject(cwd, { home });
    if (found === null) throw new FerryError("usage", "The current directory is not in a Git checkout.");
    if (!found.ok) throw new FerryError("usage", `Ferry cannot select the GitHub remote of ${found.root}: ${found.code}.`, { hint: "Run ferry messaging remote set <name>." });
    const key = found.key;
    return ((await call("GET", "/v1/projects", { key })) as { project: { id: string } }).project;
  };
  return read(call, project);
}

/**
 * A refusal of the relay as a FerryError. The message is the message of the
 * relay, then its hint, because the human output of the CLI shows only the
 * message. `details` has the HTTP status and the relay error code.
 */
export function relayRefusal(status: number, body: unknown): FerryError {
  const error = (body as { error?: { code?: unknown; message?: unknown; hint?: unknown } } | null)?.error;
  const message = typeof error?.message === "string" ? error.message : `The relay answered HTTP ${status}.`;
  return refusal(message, error?.hint, status, error?.code);
}

/** A `RelayError` of the relay client becomes the FerryError of `relayRefusal`. Other errors stay. */
export function relayFailure(error: unknown): unknown {
  return error instanceof RelayError ? refusal(error.message, error.hint, error.status, error.code) : error;
}

function refusal(message: string, hint: unknown, status: number, code: unknown): FerryError {
  const text = typeof hint === "string" && hint !== "" ? `${message} ${hint}` : message;
  return new FerryError("failed", text, { details: { status, code: typeof code === "string" ? code : null } });
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

/**
 * `ferry relay owners [add|remove <owner>]`. A change writes `allowedOwners`
 * of `~/.ferry/relay/config.json` with `changeAllowedOwners`, then restarts
 * the relay service when this machine has it, so that the relay reads it.
 */
export async function relayOwners(
  input: { readonly add?: string; readonly remove?: string },
  home = homedir(),
  restart: () => boolean = () => restartRelay(home),
): Promise<{ owners: readonly string[]; changed: boolean; restarted: boolean }> {
  const { readRelayConfig } = await import("./github/app.ts");
  const before = readRelayConfig(home)?.allowedOwners ?? [];
  const owner = input.add ?? input.remove;
  if (owner === undefined) return { owners: before, changed: false, restarted: false };
  const { changeAllowedOwners } = await import("./github/manifest.ts");
  const { allowedOwners } = changeAllowedOwners(home, input.add !== undefined ? "add" : "remove", owner);
  const changed = allowedOwners.length !== before.length;
  return { owners: allowedOwners, changed, restarted: changed && restart() };
}

/** The relay store and the GitHub App key, relative to the home. */
export const RELAY_DB_FILE = `${RELAY_DIR}/relay.db`;
const RELAY_KEY_FILE = `${RELAY_DIR}/github-app.pem`;

/** `ferry relay serve`: the relay with the config of `~/.ferry/relay`, until SIGINT or SIGTERM. */
export async function serveRelay(listen: string, version: string, log: Print, home = homedir()): Promise<void> {
  const { readAppCredentials, readRelayConfig } = await import("./github/app.ts");
  const { createGitHubAccess } = await import("./github/access.ts");
  const { startRelay } = await import("./relay/server.ts");
  // readAppCredentials throws when the relay has no App config or no key.
  const github = createGitHubAccess(readAppCredentials(home));
  const { allowedOwners } = readRelayConfig(home)!;
  const relay = await startRelay({
    dbPath: join(home, RELAY_DB_FILE),
    listen,
    github,
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

/** `ferry relay status`: the local state of the relay host. It reads the counts of the store and takes no lock, so it works while the relay runs. */
export async function relayStatus(version: string, home = homedir()): Promise<{
  version: string;
  service: boolean;
  database: { path: string; bytes: number | null };
  lastBackup: string | null;
  githubApp: boolean;
  owners: readonly string[];
  counts: StoreCounts | null;
}> {
  const { latestBackup } = await import("./relay/backup.ts");
  const { storeCounts } = await import("./relay/store.ts");
  const { readRelayConfig } = await import("./github/app.ts");
  const db = join(home, RELAY_DB_FILE);
  const config = readRelayConfig(home);
  const service = process.platform === "darwin" ? launchdPath(RELAY_SERVICE, home) : systemdPath(RELAY_SERVICE, home);
  return {
    version,
    service: existsSync(service),
    database: { path: db, bytes: existsSync(db) ? statSync(db).size : null },
    lastBackup: latestBackup(db),
    githubApp: config !== null && existsSync(join(home, RELAY_KEY_FILE)),
    owners: config?.allowedOwners ?? [],
    counts: storeCounts(db),
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

/** The relay client with the device credential of this host. */
function openRelayClient(home: string): RelayClient {
  const config = readClientConfig(home);
  const credential = readCredential(home);
  if (config === null || credential === null) {
    throw new FerryError("failed", "This machine has no messaging enrollment.", { hint: "Run ferry messaging enroll --relay <url>." });
  }
  return new RelayClient({ url: config.relayUrl, credential, ferryVersion: VERSION });
}

/** `ferry relay setup github-app`: the manifest flow. The App key goes to this machine, or to the box of `box`. */
export async function setupApp(input: { home: string; box?: string; org?: string; public: boolean; name?: string; print: Print }): Promise<GitHubAppResult> {
  const { openRelayHost, setupGitHubApp } = await import("./github/manifest.ts");
  const relayHost = await openRelayHost({ home: input.home, ...(input.box === undefined ? {} : { box: input.box }) });
  return setupGitHubApp({
    relayHost,
    public: input.public,
    print: input.print,
    openUrl,
    ...(input.org === undefined ? {} : { org: input.org }),
    ...(input.name === undefined ? {} : { name: input.name }),
  });
}

/** `ferry relay import-github-app`: an existing App. The key goes to this machine, or to the box of `box`. */
export async function importApp(input: { home: string; box?: string; appId: number; clientId: string; slug: string; keyFile: string; print: Print }): Promise<GitHubAppResult> {
  const { openRelayHost, importGitHubApp } = await import("./github/manifest.ts");
  const relayHost = await openRelayHost({ home: input.home, ...(input.box === undefined ? {} : { box: input.box }) });
  return importGitHubApp({ relayHost, appId: input.appId, clientId: input.clientId, slug: input.slug, keyFile: input.keyFile, print: input.print });
}

/** Open a URL in the browser. The manifest flow prints the URL too, so a machine without a browser still works. */
function openUrl(url: string): void {
  const command = process.platform === "darwin" ? "open" : "xdg-open";
  try {
    spawn(command, [url], { stdio: "ignore", detached: true }).on("error", () => {}).unref();
  } catch {
    // No browser on this machine.
  }
}
