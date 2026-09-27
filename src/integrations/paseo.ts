/** The Paseo integration. The Paseo daemon runs on the box, and Paseo Desktop connects to it over SSH. */

import { existsSync } from "node:fs";
import { join } from "node:path";
import { BunHostAdapter, type HostAdapter } from "../link.ts";
import type { Integration, IntegrationHealth, IntegrationLink, LocalVersion } from "./types.ts";

export type PaseoOptions = {
  readonly platform?: NodeJS.Platform;
  /** The macOS app bundle. */
  readonly macApp?: string;
  /** The install directory of the Linux `.deb` and `.rpm` packages. */
  readonly linuxInstallDir?: string;
  readonly host?: HostAdapter;
};

const VERSION_PATTERN = /\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?/;
const UNIT = "ferry-paseo.service";
/** The unit that operators wrote by hand before Ferry managed Paseo. */
const OLD_UNIT = "paseo.service";
const SECTION = "ferry-section";
const BOX_TIMEOUT_MS = 30_000;
/**
 * Read the units and the daemon status in one box command. The command always
 * exits with 0. `paseo daemon status --json` also prints `serverId` and
 * `hostname`. `parseHealth` keeps only the fields that it names.
 */
const HEALTH_COMMAND = [
  `printf 'active=%s\\n' "$(systemctl --user is-active ${UNIT} 2>/dev/null)"`,
  `printf 'enabled=%s\\n' "$(systemctl --user is-enabled ${UNIT} 2>/dev/null)"`,
  `printf 'old=%s\\n' "$(systemctl --user is-active ${OLD_UNIT} 2>/dev/null)"`,
  `if command -v paseo >/dev/null 2>&1; then echo ${SECTION}; paseo daemon status --json 2>/dev/null; else echo missing; fi`,
  "true",
].join("; ");

export function createPaseo(options: PaseoOptions = {}): Integration {
  const platform = options.platform ?? process.platform;
  const macApp = options.macApp ?? "/Applications/Paseo.app";
  const linuxInstallDir = options.linuxInstallDir ?? "/opt/Paseo";
  const host = options.host ?? new BunHostAdapter();

  return {
    id: "paseo",
    name: "Paseo",
    description: "Paseo daemon on the box",
    async localVersion(): Promise<LocalVersion> {
      if (platform === "darwin") {
        const cli = join(macApp, "Contents/Resources/bin/paseo");
        const fromCli = await cliVersion(host, cli);
        if (fromCli) return { version: fromCli, source: cli };
        const plist = join(macApp, "Contents/Info.plist");
        const fromPlist = await plistVersion(host, plist);
        if (fromPlist) return { version: fromPlist, source: plist };
      } else if (platform === "linux") {
        const cli = join(linuxInstallDir, "resources/bin/paseo");
        const fromCli = await cliVersion(host, cli);
        if (fromCli) return { version: fromCli, source: cli };
      }
      return { version: null, source: null };
    },
    plan: notImplemented("plan"),
    enable: notImplemented("enable"),
    disable: notImplemented("disable"),
    update: notImplemented("update"),
    async health(link: IntegrationLink): Promise<IntegrationHealth> {
      const [result, local] = await Promise.all([
        link.run(HEALTH_COMMAND, { timeoutMs: BOX_TIMEOUT_MS }),
        this.localVersion(),
      ]);
      if (!result.ok) {
        const error = `${result.error.origin}/${result.error.code}`;
        return { lines: [`Box: unavailable (${error})`], warnings: [], json: { error } };
      }
      return parseHealth(result.stdout, local.version);
    },
    async onProjectMoved(link: IntegrationLink, path: string): Promise<void> {
      // `project create` is idempotent. It returns the existing project for a known directory.
      const result = await link.run(`paseo project create ${boxPath(path)} >/dev/null`, { timeoutMs: BOX_TIMEOUT_MS });
      if (!result.ok) throw new Error(`paseo project create failed: ${result.error.message}`);
    },
    connectSteps(destination: string): readonly string[] {
      // Paseo Desktop keeps its hosts in app storage and has no command to add one.
      return [
        "Open Paseo Desktop.",
        "Open Settings → Add host → Remote SSH.",
        `Enter ${sshUri(destination)}.`,
      ];
    },
  };
}

export const paseo = createPaseo();

function cliVersion(host: HostAdapter, cli: string): Promise<string | null> {
  return existsSync(cli) ? runVersion(host, [cli, "--version"]) : Promise.resolve(null);
}

/** plutil reads both the XML and the binary plist format. */
function plistVersion(host: HostAdapter, plist: string): Promise<string | null> {
  return existsSync(plist)
    ? runVersion(host, ["plutil", "-extract", "CFBundleShortVersionString", "raw", "-o", "-", plist])
    : Promise.resolve(null);
}

async function runVersion(host: HostAdapter, argv: readonly string[]): Promise<string | null> {
  try {
    const result = await host.run({ argv, timeoutMs: 10_000 });
    if (result.timedOut || result.exitCode !== 0) return null;
    return VERSION_PATTERN.exec(result.stdout)?.[0] ?? null;
  } catch {
    return null;
  }
}

/** The line that `ferry move --remove` prints. Ferry never deletes a Paseo project (issue #99, decision 4). */
export function paseoSourceHint(path: string, side: string): string {
  return `Paseo still lists ${path} on ${side}. Ferry does not remove it. To remove it from Paseo, run paseo project ls to find its ID, then paseo project delete <id>. The files stay.`;
}

type DaemonStatus = {
  readonly localDaemon: string | null;
  readonly connectedDaemon: string | null;
  readonly daemonVersion: string | null;
  readonly listen: string | null;
  readonly relay: boolean | null;
  readonly providers: readonly { readonly provider: string; readonly available: boolean }[];
};

function parseHealth(stdout: string, localVersion: string | null): IntegrationHealth {
  const [head = "", status] = stdout.split(`\n${SECTION}\n`);
  const fields = new Map<string, string>();
  for (const line of head.split("\n")) {
    const equals = line.indexOf("=");
    if (equals > 0) fields.set(line.slice(0, equals), line.slice(equals + 1).trim());
  }
  const value = (key: string) => fields.get(key) || null;
  const service = { unit: UNIT, active: value("active"), enabled: value("enabled") };
  const oldService = { unit: OLD_UNIT, active: value("old") };
  const lines = [`Service: ${UNIT} ${service.active ?? "unknown"}, ${service.enabled ?? "unknown"}`];
  const warnings: string[] = [];
  if (oldService.active === "active") {
    warnings.push(
      `The old ${OLD_UNIT} is active, so two Paseo daemons can run. Run ferry integrations enable paseo to replace it.`,
    );
  }
  const base = { installed: status !== undefined, service, oldService, localVersion, pinned: localVersion !== null };
  const empty = { localDaemon: null, connectedDaemon: null, daemonVersion: null, listen: null, relay: null, providers: [] };

  if (status === undefined) {
    lines.push("Paseo: not installed on the box");
    warnings.push("Paseo is not installed on the box. Run ferry integrations enable paseo.");
    return { lines, warnings, json: { ...base, ...empty, error: null } };
  }
  const daemon = parseDaemonStatus(status);
  if (daemon === null) {
    lines.push("Daemon: unknown, paseo daemon status printed no valid JSON");
    warnings.push("Ferry cannot read the output of paseo daemon status --json on the box.");
    return { lines, warnings, json: { ...base, ...empty, error: "malformed-status" } };
  }

  const state = daemon.localDaemon ?? "unknown";
  lines.push(
    `Daemon: ${state}${daemon.connectedDaemon ? `, ${daemon.connectedDaemon}` : ""}`,
    `Version: box ${daemon.daemonVersion ?? "unknown"}, ${localVersion === null ? "not pinned (no local Paseo app)" : `local app ${localVersion}`}`,
    `Listen: ${daemon.listen ?? "unknown"}, relay ${daemon.relay === true ? "ON" : daemon.relay === false ? "off" : "unknown"}`,
    `Providers: ${
      daemon.providers.length === 0
        ? "none"
        : daemon.providers.map((entry) => `${entry.provider} ${entry.available ? "available" : "unavailable"}`).join(", ")
    }`,
  );
  if (daemon.localDaemon !== "running") {
    warnings.push(`The Paseo daemon on the box is ${state}. Run ferry integrations enable paseo to start it.`);
  }
  if (localVersion !== null && daemon.daemonVersion !== null && daemon.daemonVersion !== localVersion) {
    warnings.push(`The box runs Paseo ${daemon.daemonVersion} and the local app is ${localVersion}. Run ferry update.`);
  }
  if (daemon.listen !== null && !loopback(daemon.listen)) {
    warnings.push(
      `Paseo listens on ${daemon.listen}, which is not a loopback address. Other hosts can control the daemon.`,
    );
  }
  if (daemon.relay === true) warnings.push("The Paseo relay is on. Ferry keeps it off on the box.");
  return { lines, warnings, json: { ...base, ...daemon, error: null } };
}

/** Keep only the named fields. The status also has `serverId` and `hostname`, which Ferry never shows. */
function parseDaemonStatus(text: string): DaemonStatus | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return null;
  const status = parsed as Record<string, unknown>;
  const field = (key: string) => (typeof status[key] === "string" ? (status[key] as string) : null);
  const relay = status.relay as { enabled?: unknown } | null | undefined;
  const providers = Array.isArray(status.providers) ? status.providers : [];
  return {
    localDaemon: field("localDaemon"),
    connectedDaemon: field("connectedDaemon"),
    daemonVersion: field("daemonVersion"),
    listen: field("listen"),
    relay: typeof relay?.enabled === "boolean" ? relay.enabled : null,
    providers: providers.flatMap((entry: { provider?: unknown; available?: unknown } | null) =>
      typeof entry?.provider === "string" ? [{ provider: entry.provider, available: entry.available === true }] : [],
    ),
  };
}

/** A socket path, `localhost`, `::1`, or an address in 127.0.0.0/8. */
function loopback(listen: string): boolean {
  if (listen.includes("/")) return true;
  const colon = listen.lastIndexOf(":");
  const host = listen.startsWith("[") ? listen.slice(1, listen.indexOf("]")) : colon === -1 ? listen : listen.slice(0, colon);
  return host === "localhost" || host === "::1" || host.startsWith("127.");
}

/** A shell word for a box path. A leading `~/` becomes the box home. */
function boxPath(path: string): string {
  return path.startsWith("~/") ? `"$HOME"/${quoteShell(path.slice(2))}` : quoteShell(path);
}

function quoteShell(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

/** Paseo Desktop takes an `ssh://` URI. An IPv6 host must be in brackets. */
function sshUri(destination: string): string {
  if (destination.startsWith("ssh://")) return destination;
  const at = destination.lastIndexOf("@");
  const host = destination.slice(at + 1);
  const bracketed = host.includes(":") && !host.startsWith("[") ? `[${host}]` : host;
  return `ssh://${destination.slice(0, at + 1)}${bracketed}`;
}

/** Lane B of issue #99 adds the box steps. No command calls these methods before then. */
function notImplemented(method: string): () => Promise<never> {
  return async () => {
    throw new Error(`Paseo ${method} is not implemented in this release`);
  };
}
