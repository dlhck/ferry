/** Carry managed Git plugins through Paseo's CLI. Plugin files and settings stay on each host. */
import { execFileSync } from "node:child_process";
import { readFileSync, realpathSync } from "node:fs";
import { join, relative, resolve, sep } from "node:path";
import { quoteShell, readCommand, writeCommand } from "../box-settings.ts";
import { carriedContentHits } from "../manifest.ts";
import { CONFIG_FILE, PaseoError } from "./paseo.ts";
import type { IntegrationLink } from "./types.ts";

export type PaseoPlugin = {
  readonly id: string;
  readonly remote: string;
  readonly path: string;
  readonly commit: string;
  readonly enabled: boolean;
};
export type PaseoPlugins = {
  readonly plugins: readonly PaseoPlugin[];
  readonly warnings: readonly string[];
};

function object(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readJson(path: string): Record<string, unknown> {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
    throw new PaseoError(`Ferry could not read ${path}`);
  }
  try {
    const value: unknown = JSON.parse(text);
    if (object(value)) return value;
  } catch { /* Report the path, never the contents. */ }
  throw new PaseoError(`${path} is not a JSON object`);
}

/** Accept network Git sources without embedded credentials or query parameters. */
function portableRemote(remote: string): boolean {
  if (/^[a-zA-Z0-9._-]+@[a-zA-Z0-9.-]+:[a-zA-Z0-9_./-]+$/.test(remote)) return true;
  try {
    const url = new URL(remote);
    return ["https:", "ssh:", "git:"].includes(url.protocol) && !!url.hostname &&
      !url.password && !url.search && !url.hash &&
      (url.protocol === "ssh:" || !url.username) && !/[\s\x00-\x1f]/.test(remote);
  } catch { return false; }
}

/** Paseo omits SSH URL usernames from its list output. */
function listedRemote(remote: string): string {
  if (!remote.startsWith("ssh://")) return remote;
  const url = new URL(remote);
  url.username = "";
  return url.href;
}

/** Read acquisition records and Git HEAD, rather than copying host-specific plugin paths. */
export function readPaseoPlugins(home: string): PaseoPlugins {
  const config = readJson(join(home, ".paseo/config.json"));
  if (config.plugins === undefined) return { plugins: [], warnings: [] };
  if (!object(config.plugins)) throw new PaseoError("Paseo plugins is not an object");
  const records = readJson(join(home, ".paseo/plugins/sources.json"));
  const plugins: PaseoPlugin[] = [];
  const warnings: string[] = [];
  for (const [id, source] of Object.entries(config.plugins)) {
    if (!/^[a-z][a-z0-9-]*$/.test(id)) throw new PaseoError("Paseo has an invalid plugin ID");
    const record = records[id];
    if (!object(record) || (record.kind !== undefined && record.kind !== "git")) {
      warnings.push(`Paseo plugin ${id} was skipped: only managed Git plugins can sync.`);
      continue;
    }
    if (!object(source) || source.source !== "directory" || typeof source.path !== "string" ||
        (source.enabled !== undefined && typeof source.enabled !== "boolean") ||
        typeof record.remote !== "string") {
      throw new PaseoError(`Paseo plugin ${id} has invalid acquisition metadata`);
    }
    if (!portableRemote(record.remote) || carriedContentHits(id, Buffer.from(record.remote)).length > 0) {
      throw new PaseoError(`Paseo plugin ${id} has a nonportable or credential-bearing Git remote`);
    }
    const root = join(home, ".paseo/plugins", id);
    const parts = relative(root, resolve(source.path)).split(sep);
    if (!/^(?:[0-9a-f]{12}-)?[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(parts[0] ?? "") ||
        parts[1] !== "checkout" || parts.some((part) => part === "..")) {
      throw new PaseoError(`Paseo plugin ${id} is outside its managed Git checkout`);
    }
    const checkout = join(root, parts[0]!, "checkout");
    const path = parts.slice(2).join("/") || ".";
    if (path !== "." && !path.split("/").every((part) => /^[a-zA-Z0-9_.-]+$/.test(part) && part !== ".." && part !== ".")) {
      throw new PaseoError(`Paseo plugin ${id} has a nonportable plugin path`);
    }
    let commit: string;
    try {
      const realRoot = realpathSync(root);
      if (!realpathSync(checkout).startsWith(`${realRoot}${sep}`) ||
          (realpathSync(source.path) !== realpathSync(checkout) && !realpathSync(source.path).startsWith(`${realpathSync(checkout)}${sep}`))) {
        throw new Error("outside checkout");
      }
      const git = (args: string[]) => execFileSync("git", ["-C", checkout, ...args], {
        encoding: "utf8", timeout: 10_000, stdio: ["ignore", "pipe", "pipe"],
      }).trim();
      commit = git(["rev-parse", "--verify", "HEAD^{commit}"]);
      if (!/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(commit)) throw new Error("invalid commit");
      if (git(["status", "--porcelain", "--untracked-files=normal"])) {
        warnings.push(`Paseo plugin ${id} was skipped: its Git checkout has local changes.`);
        continue;
      }
    } catch {
      throw new PaseoError(`Ferry could not read the managed Git checkout for Paseo plugin ${id}`);
    }
    plugins.push({ id, remote: record.remote, path, commit, enabled: source.enabled !== false });
  }
  return { plugins, warnings };
}

/**
 * Set the global `pluginsEnabled` switch in the box config and keep all other keys.
 * Paseo has no CLI command for the switch. `paseo daemon reload` applies it without a restart.
 */
async function enableGlobalSwitch(link: IntegrationLink): Promise<void> {
  const run = async (command: string, what: string): Promise<string> => {
    const result = await link.run(command, { timeoutMs: 30_000 });
    if (!result.ok) throw new PaseoError(`${what} on the box`);
    return result.stdout;
  };
  const current = await run(readCommand(CONFIG_FILE), `Ferry could not read ~/${CONFIG_FILE}`);
  let config: unknown = {};
  if (current.startsWith("F") && current.slice(1).trim() !== "") {
    try { config = JSON.parse(current.slice(1)); } catch { config = null; }
  }
  if (!object(config)) throw new PaseoError(`~/${CONFIG_FILE} on the box is not a JSON object`);
  if (config.pluginsEnabled === true) return;
  const text = `${JSON.stringify({ ...config, pluginsEnabled: true }, null, 2)}\n`;
  await run(writeCommand(CONFIG_FILE, text), `Ferry could not write ~/${CONFIG_FILE}`);
  await run("paseo daemon reload", "paseo daemon reload failed");
}

/**
 * Keep box-only plugins. A conflicting ID requires the operator to resolve its source.
 * After at least one enabled plugin is current, enable the box's global plugin switch.
 * The switch also starts enabled box-only plugins. Disabled plugins are disabled first.
 */
export async function carryPaseoPlugins(link: IntegrationLink, source: PaseoPlugins): Promise<readonly string[]> {
  const warnings = [...source.warnings];
  if (source.plugins.length === 0) return warnings;
  const run = async (command: string): Promise<string> => {
    const result = await link.run(command, { timeoutMs: 600_000 });
    if (!result.ok) throw new PaseoError("Paseo plugin command failed on the box. Check paseo plugin ls and the box daemon's Git access.");
    return result.stdout;
  };
  let installed: unknown;
  try { installed = JSON.parse(await run("paseo plugin ls --json")); }
  catch { throw new PaseoError("Ferry could not read paseo plugin ls --json on the box"); }
  if (!Array.isArray(installed) || !installed.every((item) => object(item) && typeof item.id === "string" && typeof item.enabled === "boolean")) {
    throw new PaseoError("paseo plugin ls --json on the box did not return a plugin list");
  }
  let reconciled = false;
  for (const plugin of source.plugins) {
    const current = installed.find((item) => item.id === plugin.id);
    const installation = current?.installation;
    const identity = object(installation) ? installation.identity : undefined;
    if (current && (!object(identity) || identity.kind !== "git" ||
        identity.remote !== listedRemote(plugin.remote) || identity.pluginPath !== plugin.path)) {
      warnings.push(`Paseo plugin ${plugin.id} was skipped: the box has the same ID with a different source.`);
      continue;
    }
    const id = quoteShell(plugin.id);
    if (!current) {
      // Paseo install enables new plugins. Do not briefly execute a disabled local plugin.
      if (!plugin.enabled) {
        warnings.push(`Paseo plugin ${plugin.id} was skipped: it is disabled locally and is not installed on the box.`);
        continue;
      }
      const reference = `git:${plugin.remote}${plugin.path === "." ? "" : `:${plugin.path}`}`;
      await run(`paseo plugin install ${quoteShell(reference)} --id ${id} --ref ${quoteShell(plugin.commit)} --json`);
    } else {
      if (!plugin.enabled && current.enabled) await run(`paseo plugin disable ${id} --json`);
      if (installation.currentRevision !== plugin.commit) {
        await run(`paseo plugin update ${id} --ref ${quoteShell(plugin.commit)} --json`);
      }
      if (plugin.enabled && !current.enabled) await run(`paseo plugin enable ${id} --json`);
    }
    if (plugin.enabled) reconciled = true;
  }
  if (reconciled) await enableGlobalSwitch(link);
  return warnings;
}
