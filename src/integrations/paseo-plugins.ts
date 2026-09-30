/** Carry managed Git and npm plugins through Paseo's CLI. Plugin files and settings stay on each host. */
import { execFileSync } from "node:child_process";
import { readFileSync, realpathSync } from "node:fs";
import { join, relative, resolve, sep } from "node:path";
import { jqCommandScript, quoteShell } from "../box-settings.ts";
import { carriedContentHits } from "../manifest.ts";
import { CONFIG_FILE, editBoxConfig, noJqWarning, PaseoError } from "./paseo.ts";
import type { IntegrationLink } from "./types.ts";

export type PaseoPlugin = {
  readonly kind: "git";
  readonly id: string;
  readonly remote: string;
  readonly path: string;
  readonly commit: string;
  readonly enabled: boolean;
} | {
  readonly kind: "npm";
  readonly id: string;
  readonly packageName: string;
  readonly path: string;
  /** The exact installed version from the lockfile, never a tag or range. */
  readonly version: string;
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

/** Paseo 0.10.1 accepts these npm names: lowercase `name` or `@scope/name`. */
const NPM_NAME = /^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/;
/** An exact semver version. Tags and ranges move, so Ferry never carries them. Numeric prerelease parts have no leading zero. */
const PRERELEASE_PART = "(?:0|[1-9]\\d*|\\d*[A-Za-z-][0-9A-Za-z-]*)";
const EXACT_VERSION = new RegExp(`^(?:0|[1-9]\\d*)\\.(?:0|[1-9]\\d*)\\.(?:0|[1-9]\\d*)(?:-${PRERELEASE_PART}(?:\\.${PRERELEASE_PART})*)?(?:\\+[0-9A-Za-z-]+(?:\\.[0-9A-Za-z-]+)*)?$`);

function portablePath(path: string): boolean {
  return path === "." || path.split("/").every((part) => /^[a-zA-Z0-9_.-]+$/.test(part) && part !== ".." && part !== ".");
}

function inside(parent: string, child: string): boolean {
  const realParent = realpathSync(parent);
  const realChild = realpathSync(child);
  return realChild === realParent || realChild.startsWith(`${realParent}${sep}`);
}

/**
 * Read an npm installation in Paseo's layout: `<id>/<uuid>/node_modules/<package>`.
 * The version comes from the lockfile, as in Paseo. Ferry never reads or carries the resolved URL.
 */
function readNpmPlugin(home: string, id: string, configured: string, enabled: boolean): PaseoPlugin {
  const root = join(home, ".paseo/plugins", id);
  const parts = relative(root, resolve(configured)).split(sep);
  const nameParts = parts[2]?.startsWith("@") ? 2 : 1;
  const packageName = parts.slice(2, 2 + nameParts).join("/");
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(parts[0] ?? "") ||
      parts[1] !== "node_modules" || parts.some((part) => part === "..") || !NPM_NAME.test(packageName)) {
    throw new PaseoError(`Paseo plugin ${id} is outside its managed npm installation`);
  }
  const path = parts.slice(2 + nameParts).join("/") || ".";
  if (!portablePath(path)) throw new PaseoError(`Paseo plugin ${id} has a nonportable plugin path`);
  const versionRoot = join(root, parts[0]!);
  const packageRoot = join(versionRoot, "node_modules", packageName);
  let version: unknown;
  try {
    if (!inside(root, versionRoot) || !inside(versionRoot, packageRoot) || !inside(packageRoot, configured)) {
      throw new Error("outside installation");
    }
    const lock: unknown = JSON.parse(readFileSync(join(versionRoot, "package-lock.json"), "utf8"));
    const installed: unknown = JSON.parse(readFileSync(join(packageRoot, "package.json"), "utf8"));
    const packages = object(lock) && object(lock.packages) ? lock.packages : {};
    const artifact = packages[`node_modules/${packageName}`];
    version = object(artifact) ? artifact.version : undefined;
    if (typeof version !== "string" || !object(installed) || installed.name !== packageName || installed.version !== version) {
      throw new Error("mismatched artifacts");
    }
  } catch {
    throw new PaseoError(`Ferry could not read the managed npm installation for Paseo plugin ${id}`);
  }
  if (!EXACT_VERSION.test(version) || carriedContentHits(id, Buffer.from(`${packageName}@${version}`)).length > 0) {
    throw new PaseoError(`Paseo plugin ${id} has a nonportable or credential-bearing npm package`);
  }
  return { kind: "npm", id, packageName, path, version, enabled };
}

/** Paseo omits SSH URL usernames from its list output. */
function listedRemote(remote: string): string {
  if (!remote.startsWith("ssh://")) return remote;
  const url = new URL(remote);
  url.username = "";
  return url.href;
}

/** Read acquisition records, Git HEAD, and npm lockfiles, rather than copying host-specific plugin paths. */
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
    // Paseo 0.10.1 stores legacy Git records without a kind.
    const kind = object(record) ? (record.kind === undefined ? "git" : record.kind) : undefined;
    if (!object(record) || (kind !== "git" && kind !== "npm")) {
      warnings.push(`Paseo plugin ${id} was skipped: only managed Git and npm plugins can sync.`);
      continue;
    }
    if (!object(source) || source.source !== "directory" || typeof source.path !== "string" ||
        (source.enabled !== undefined && typeof source.enabled !== "boolean")) {
      throw new PaseoError(`Paseo plugin ${id} has invalid acquisition metadata`);
    }
    if (kind === "npm") {
      plugins.push(readNpmPlugin(home, id, source.path, source.enabled !== false));
      continue;
    }
    if (typeof record.remote !== "string") throw new PaseoError(`Paseo plugin ${id} has invalid acquisition metadata`);
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
    plugins.push({ kind: "git", id, remote: record.remote, path, commit, enabled: source.enabled !== false });
  }
  return { plugins, warnings };
}

/**
 * Set the global `pluginsEnabled` switch in the box config and keep all other keys.
 * Paseo has no CLI command for the switch. `paseo daemon reload` applies it without a restart.
 * The box edits the file with jq. Without jq, the file stays as it is, and the result is a warning.
 */
async function enableGlobalSwitch(link: IntegrationLink): Promise<readonly string[]> {
  const run = async (command: string, what: string): Promise<string> => {
    const result = await link.run(command, { timeoutMs: 30_000 });
    if (!result.ok) throw new PaseoError(what);
    return result.stdout;
  };
  const edit = await editBoxConfig(run, {
    args: "",
    valid: 'type == "object"',
    filter: ".pluginsEnabled = true",
    what: "the Paseo plugin switch",
  });
  if (edit === "invalid") throw new PaseoError(`~/${CONFIG_FILE} on the box is not a JSON object`);
  return edit === "no-jq" ? [noJqWarning("the Paseo plugin switch")] : [];
}

/**
 * A jq filter for the output of `paseo plugin ls --json`: print
 * `<id>\t<source>\t<enabled>\t<revision>` for each plugin of `$p`. Each
 * entry of `$p` has the local `id`, `identity`, and `revision`. The source is
 * `absent`, `differs` for a box plugin with another identity, or `same`. The
 * enabled state is `on` or `off`. The revision is `current` or `stale`. The
 * filter prints `E` for an input that is not a plugin list.
 * A box remote can hold a credential. Only the IDs that Ferry sent and these
 * fixed words leave the box.
 */
const STATES = [
  'if type == "array" and all(.[]; type == "object" and (.id | type) == "string" and (.enabled | type) == "boolean") then',
  ". as $b | $p[] | . as $x | ([$b[] | select(.id == $x.id)][0]) as $c |",
  '($c.installation | if type == "object" then . else {} end) as $i | ($i.identity | if type == "object" then . else {} end) as $n |',
  '[$x.id, (if $c == null then "absent" elif ($x.identity | to_entries | all(.[]; $n[.key] == .value)) then "same" else "differs" end),',
  '(if $c.enabled then "on" else "off" end), (if $i.currentRevision == $x.revision then "current" else "stale" end)] | join("\\t")',
  'else "E" end',
].join(" ");

/**
 * Keep box-only plugins. A conflicting ID requires the operator to resolve its source.
 * After at least one enabled plugin is current, enable the box's global plugin switch.
 * The switch also starts enabled box-only plugins. Disabled plugins are disabled first.
 * The box compares its plugin list with the local plugins with jq, and prints back
 * only state words for each plugin ID. Without jq, the box plugins stay as they are.
 */
export async function carryPaseoPlugins(link: IntegrationLink, source: PaseoPlugins): Promise<readonly string[]> {
  const warnings = [...source.warnings];
  if (source.plugins.length === 0) return warnings;
  // A box can echo a remote with a credential. Report only the command and the plugin ID.
  const run = async (command: string, failed: string): Promise<string> => {
    const result = await link.run(command, { timeoutMs: 600_000 });
    if (!result.ok) throw new PaseoError(`${failed} Check paseo plugin ls and the box daemon's Git or npm registry access.`);
    return result.stdout;
  };
  const want = source.plugins.map((plugin) => ({
    id: plugin.id,
    identity: plugin.kind === "git"
      ? { kind: plugin.kind, pluginPath: plugin.path, remote: listedRemote(plugin.remote) }
      : { kind: plugin.kind, pluginPath: plugin.path, packageName: plugin.packageName },
    revision: plugin.kind === "git" ? plugin.commit : plugin.version,
  }));
  const script = jqCommandScript("paseo plugin ls --json", `--argjson p ${quoteShell(JSON.stringify(want))}`, STATES);
  const lines = (await run(`sh -c ${quoteShell(script)}`, "paseo plugin ls failed on the box.")).split("\n");
  if (lines.includes("J")) return [...warnings, noJqWarning("the Paseo plugins")];
  const invalid = new PaseoError("paseo plugin ls --json on the box did not return a plugin list");
  if (lines.includes("E")) throw invalid;
  const states = new Map(lines.map((line) => { const [id, ...state] = line.split("\t"); return [id, state]; }));
  let reconciled = false;
  for (const plugin of source.plugins) {
    const [state, enabled, revision] = states.get(plugin.id) ?? [];
    if (state !== "absent" && state !== "same" && state !== "differs") throw invalid;
    if (state === "differs") {
      warnings.push(`Paseo plugin ${plugin.id} was skipped: the box has the same ID with a different source.`);
      continue;
    }
    const id = quoteShell(plugin.id);
    // Ferry does not read the output of these commands, so it stays on the box.
    const paseo = (action: string, args: string) => run(
      `paseo plugin ${action} ${args} --json >/dev/null 2>&1`,
      `paseo plugin ${action} failed on the box for Paseo plugin ${plugin.id}.`,
    );
    if (state === "absent") {
      // Paseo install enables new plugins. Do not briefly execute a disabled local plugin.
      if (!plugin.enabled) {
        warnings.push(`Paseo plugin ${plugin.id} was skipped: it is disabled locally and is not installed on the box.`);
        continue;
      }
      // npm takes the exact version in the source. Paseo refuses --ref for npm.
      const source = plugin.kind === "git" ? `git:${plugin.remote}` : `npm:${plugin.packageName}@${plugin.version}`;
      const reference = `${source}${plugin.path === "." ? "" : `:${plugin.path}`}`;
      const ref = plugin.kind === "git" ? ` --ref ${quoteShell(plugin.commit)}` : "";
      await paseo("install", `${quoteShell(reference)} --id ${id}${ref}`);
    } else {
      if (!plugin.enabled && enabled === "on") await paseo("disable", id);
      if (revision !== "current") {
        const [target, flag] = plugin.kind === "git" ? [plugin.commit, "--ref"] : [plugin.version, "--version"];
        await paseo("update", `${id} ${flag} ${quoteShell(target)}`);
      }
      if (plugin.enabled && enabled !== "on") await paseo("enable", id);
    }
    if (plugin.enabled) reconciled = true;
  }
  if (reconciled) warnings.push(...await enableGlobalSwitch(link));
  return warnings;
}
