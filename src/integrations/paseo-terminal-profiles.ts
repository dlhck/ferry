/**
 * Carry portable Paseo terminal profiles (`daemon.terminalProfiles`). Env
 * blocks, unknown fields, paths, and script payloads stay on each host.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { quoteShell } from "../box-settings.ts";
import { carriedContentHits } from "../manifest.ts";
import { CONFIG_FILE, editBoxConfig, jqObjects, noJqWarning, PaseoError, SYSTEM_PATH } from "./paseo.ts";
import type { IntegrationLink } from "./types.ts";

/** The fields that Ferry carries. Paseo 0.10.1 reloads `daemon.terminalProfiles` without a restart. */
const PORTABLE_FIELDS = ["id", "name", "command", "args", "icon"] as const;
const FIELD = "daemon.terminalProfiles";
/**
 * The profiles that Paseo 0.10.1 shows when `daemon.terminalProfiles` is not
 * set (`DEFAULT_TERMINAL_PROFILES` in @getpaseo/protocol). Paseo resolves them
 * in the app and has no command that reads them, so Ferry keeps this copy. A
 * box on a later Paseo with other defaults gets these four when Ferry writes
 * the list for the first time.
 */
export const PASEO_DEFAULT_TERMINAL_PROFILES: readonly TerminalProfile[] = [
  { id: "claude", name: "Claude Code", command: "claude", args: ["{{{prompt}}}"], icon: "claude" },
  { id: "codex", name: "Codex", command: "codex", args: ["{{{prompt}}}"], icon: "codex" },
  { id: "opencode", name: "OpenCode", command: "opencode", args: ["--prompt={{{prompt}}}"], icon: "opencode" },
  { id: "pi", name: "Pi", command: "pi", args: ["{{{prompt}}}"], icon: "pi" },
];
/** A command name that the daemon resolves through its PATH. It cannot start with `-` or `.`. */
const BARE_EXECUTABLE = /^[A-Za-z0-9_][A-Za-z0-9._+-]*$/;
/** Shells and interpreters. A profile may start one only with the flags in `INTERACTIVE_FLAGS`. */
const SCRIPT_RUNNERS = new Set([
  "sh", "bash", "zsh", "dash", "ksh", "fish", "csh", "tcsh", "env", "node", "deno", "bun",
  "python", "python3", "perl", "ruby", "php", "lua", "pwsh", "powershell", "cmd", "osascript",
]);
/** Flags that start an interactive or login session and take no script. */
const INTERACTIVE_FLAGS = new Set(["-l", "-i", "-il", "-li", "--login", "--interactive", "--noprofile", "--norc"]);
/** A file name with a config, key, script, or text extension. */
const FILE_ARGUMENT = /\.(?:json5?|jsonc|ya?ml|toml|env|ini|conf|cfg|pem|key|sh|[cm]?js|ts|py|rb|txt)$/i;
/** A scoped npm package, such as `@scope/name@1.2.3`. It is the one argument with a slash that is not a path. */
const SCOPED_PACKAGE = /^@[a-z0-9][a-z0-9._-]*\/[a-z0-9][a-z0-9._-]*(?:@[A-Za-z0-9._-]+)?$/;
/** A loopback host, alone, with a port, or as a URL host. It names a service on one machine. */
const LOOPBACK_HOST = /^(?:localhost|[^:/]*\.localhost|127(?:\.\d{1,3}){3}|0\.0\.0\.0|\[?::1?\]?)(?::\d+)?$/i;
const CREDENTIAL_ARGUMENT = /api[-_]?key|token|secret|passw|credential|auth/i;
const BOX_TIMEOUT_MS = 30_000;
/** A jq test: the box config has a `daemon.terminalProfiles` list of profiles with unique IDs, or does not set the list. */
const VALID = [
  jqObjects(".daemon"),
  '(.daemon.terminalProfiles | type | . == "null" or . == "array")',
  '((.daemon.terminalProfiles // []) | all(.[]; type == "object" and (.id | type) == "string" and .id != "") and (map(.id) | length == (unique | length)))',
].join(" and ");
/**
 * A jq filter: merge the profiles `$p` by `id` into the box list, or into the
 * defaults `$d` when the box does not set the list. A matching box profile
 * gets the local fields, loses each field of `$a` that the local profile does
 * not set, and keeps its other fields, such as `env`. New profiles go at the
 * end. An equal list stays as it is, so the box does not write the defaults.
 */
const MERGE = [
  "(.daemon.terminalProfiles // $d) as $b",
  "| ([$b[] | . as $e | ([$p[] | select(.id == $e.id)][0]) as $l | if $l == null then $e",
  "else ($e | with_entries(select(.key as $k | all($a[]; . != $k) or ($l | has($k))))) + $l end]",
  "+ [$p[] | select(.id as $i | all($b[]; .id != $i))]) as $n",
  "| if $n == $b then . else .daemon.terminalProfiles = $n end",
].join(" ");

export type TerminalProfile = {
  readonly id: string;
  readonly name: string;
  readonly command: string;
  readonly args?: readonly string[];
  readonly icon?: string;
};
/** Null when the local config does not set `daemon.terminalProfiles`. */
export type PaseoTerminalProfiles = {
  /** The portable profiles, with only the allowlisted fields. */
  readonly profiles: readonly TerminalProfile[];
  /** One line for each local profile that Ferry skips. It never holds an argument or a field name. */
  readonly warnings: readonly string[];
} | null;

function object(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

const filled = (value: unknown) => typeof value === "string" && value !== "";

/** True when the value has the Paseo schema shape of a terminal profile. Unknown keys are allowed here. */
function wellFormed(value: unknown): value is Record<string, unknown> & TerminalProfile {
  return object(value) && filled(value.id) && filled(value.name) && filled(value.command) &&
    (value.args === undefined || (Array.isArray(value.args) && value.args.every((arg) => typeof arg === "string"))) &&
    (value.icon === undefined || typeof value.icon === "string");
}

/**
 * Classify one argument, or its value after `=` for a flag. The prompt
 * sentinel is portable. Whitespace means embedded command text. A URL with a
 * user or a password is a credential, and one with a query or a fragment can
 * hold one. A `file:` URL, a slash or a backslash, a `~`, `.`, or drive
 * prefix, or a file extension means a host path.
 */
function argumentIssue(arg: string): "path" | "script" | "credential" | "endpoint" | null {
  if (/[\s\x00-\x1f]/.test(arg)) return "script";
  const value = arg.startsWith("-") && arg.includes("=") ? arg.slice(arg.indexOf("=") + 1) : arg;
  if (value === "{{{prompt}}}") return null;
  if (value.includes("://")) {
    try {
      const url = new URL(value);
      if (url.username || url.password || url.search || url.hash) return "credential";
      if (url.protocol === "file:") return "path";
      return url.protocol !== "http:" && url.protocol !== "https:" || LOOPBACK_HOST.test(url.host) ? "endpoint" : null;
    } catch {
      return "credential";
    }
  }
  if (LOOPBACK_HOST.test(value)) return "endpoint";
  if (/^(?:~|\.|[A-Za-z]:)/.test(value) || (/[\\/]/.test(value) && !SCOPED_PACKAGE.test(value)) || FILE_ARGUMENT.test(value)) {
    return "path";
  }
  return null;
}

/** Why the profile is not portable, or null. The reasons are fixed text and never hold a value. */
function skipReason(profile: Record<string, unknown> & TerminalProfile): string | null {
  if (Object.keys(profile).some((key) => !(PORTABLE_FIELDS as readonly string[]).includes(key))) {
    return "it has fields other than id, name, command, args, and icon, such as an env block";
  }
  if (!BARE_EXECUTABLE.test(profile.command)) return "its command is not a bare executable name";
  const args = profile.args ?? [];
  if (SCRIPT_RUNNERS.has(profile.command.toLowerCase()) && args.some((arg) => !INTERACTIVE_FLAGS.has(arg))) {
    return "it runs a shell or interpreter with a script or an unknown flag";
  }
  const issues = new Set(args.map(argumentIssue));
  if (issues.has("credential") || args.some((arg) => CREDENTIAL_ARGUMENT.test(arg))) return "it has a credential-like argument";
  if (issues.has("path")) return "it has a local path argument";
  if (issues.has("script")) return "it has an argument with spaces or control characters";
  if (issues.has("endpoint")) return "it has a loopback or non-HTTP URL argument";
  return null;
}

/** Copy only the allowlisted fields, in schema order. */
function portable(profile: TerminalProfile): TerminalProfile {
  return {
    id: profile.id,
    name: profile.name,
    command: profile.command,
    ...(profile.args === undefined ? {} : { args: [...profile.args] }),
    ...(profile.icon === undefined ? {} : { icon: profile.icon }),
  };
}

/**
 * Read `daemon.terminalProfiles` from the local Paseo config. A missing file or
 * key gives null. Throw a PaseoError before any publish for a list that the
 * Paseo schema rejects, a duplicate ID, or a carried field with a token or a
 * secret. The error names the profile by its position, never by a value.
 * Skip each profile that is not portable, with a warning.
 */
export function readPaseoTerminalProfiles(home: string): PaseoTerminalProfiles {
  const path = join(home, CONFIG_FILE);
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch {
    return null;
  }
  let config: unknown;
  try {
    config = JSON.parse(text);
  } catch {
    throw new PaseoError(`${path} is not valid JSON, so Ferry cannot read ${FIELD}`);
  }
  if (!object(config)) throw new PaseoError(`${path} is not a JSON object`);
  if (config.daemon !== undefined && !object(config.daemon)) throw new PaseoError(`daemon in ${path} is not an object`);
  const list = (config.daemon as Record<string, unknown> | undefined)?.terminalProfiles;
  if (list === undefined) return null;
  if (!Array.isArray(list)) throw new PaseoError(`${FIELD} in ${path} is not a list`);

  const refused: string[] = [];
  const ids = new Set<string>();
  for (const [index, profile] of list.entries()) {
    const label = `profile #${index + 1}`;
    if (!wellFormed(profile)) {
      refused.push(`${label} is not an object with a non-empty id, name, and command, string args, and a string icon`);
      continue;
    }
    if (ids.has(profile.id)) refused.push(`${label} repeats the ID of an earlier profile`);
    ids.add(profile.id);
    const hits = carriedContentHits(path, Buffer.from(JSON.stringify(portable(profile))));
    if (hits.length > 0) refused.push(`${label}: ${[...new Set(hits.map((hit) => hit.reason))].join("; ")}`);
  }
  if (refused.length > 0) throw new PaseoError(`Ferry refused to carry ${FIELD} in ${path}: ${refused.join("; ")}`);

  const profiles: TerminalProfile[] = [];
  const warnings: string[] = [];
  for (const profile of list as (Record<string, unknown> & TerminalProfile)[]) {
    const reason = skipReason(profile);
    if (reason === null) profiles.push(portable(profile));
    else warnings.push(`Paseo terminal profile ${profile.name} was not carried: ${reason}.`);
  }
  return { profiles, warnings };
}

export type TerminalProfileCarry = {
  /** The names of the carried profiles that the box config holds after the carry. */
  readonly carried: readonly string[];
  /** One line for each profile that Ferry did not carry. */
  readonly warnings: readonly string[];
  /** True when Ferry wrote the box config and reloaded the daemon. */
  readonly changed: boolean;
};

/**
 * Merge the portable profiles into `daemon.terminalProfiles` of the box Paseo
 * config by `id`. Skip each profile whose command is not on the PATH that
 * ferry-paseo.service gets from `pathDirs`. A matching box profile gets the
 * local allowlisted fields and keeps its other fields. Box-only profiles keep
 * their positions, and new profiles go at the end. When the box does not set
 * the list, the merge starts from the Paseo 0.10.1 defaults, so the box keeps
 * them. Ferry never removes a box profile. With nothing to carry, or no change,
 * it writes nothing. The box merges the list with jq and prints only a status
 * letter. Without jq, the file stays as it is. The errors never hold box output.
 */
export async function carryPaseoTerminalProfiles(
  link: IntegrationLink,
  source: NonNullable<PaseoTerminalProfiles>,
  pathDirs: readonly string[],
): Promise<TerminalProfileCarry> {
  const warnings = [...source.warnings];
  if (source.profiles.length === 0) return { carried: [], warnings, changed: false };

  const run = async (command: string, what: string): Promise<string> => {
    let result: Awaited<ReturnType<IntegrationLink["run"]>>;
    try {
      result = await link.run(command, { timeoutMs: BOX_TIMEOUT_MS });
    } catch {
      throw new PaseoError(what);
    }
    if (!result.ok) throw new PaseoError(what);
    return result.stdout;
  };

  // The daemon spawns the command directly with the unit PATH. The unit PATH refresh runs after this step.
  const names = [...new Set(source.profiles.map((profile) => profile.command))];
  const unitPath = [...pathDirs.map((dir) => `"$HOME"/${quoteShell(dir)}`), SYSTEM_PATH].join(":");
  const found = await run(
    [
      `PATH=${unitPath}`,
      // A shell builtin or function prints no path, and the daemon cannot spawn it.
      ...names.map((name) => `case "$(command -v -- ${quoteShell(name)} 2>/dev/null)" in /*) echo ok ${quoteShell(name)};; esac`),
      "true",
    ].join("\n"),
    "Ferry could not check the Paseo terminal profile commands on the box",
  );
  const onPath = new Set(found.split("\n").filter((line) => line.startsWith("ok ")).map((line) => line.slice(3)));
  const kept = source.profiles.filter((profile) => onPath.has(profile.command));
  for (const profile of source.profiles) {
    if (!onPath.has(profile.command)) {
      warnings.push(`Paseo terminal profile ${profile.name} was not carried: its command is not on the PATH of ferry-paseo.service on the box.`);
    }
  }
  if (kept.length === 0) return { carried: [], warnings, changed: false };

  const edit = await editBoxConfig(run, {
    args: [
      `--argjson p ${quoteShell(JSON.stringify(kept.map(portable)))}`,
      `--argjson d ${quoteShell(JSON.stringify(PASEO_DEFAULT_TERMINAL_PROFILES))}`,
      `--argjson a ${quoteShell(JSON.stringify(PORTABLE_FIELDS))}`,
    ].join(" "),
    valid: VALID,
    filter: MERGE,
    what: "the Paseo terminal profiles",
  });
  if (edit === "invalid") {
    throw new PaseoError(`~/${CONFIG_FILE} on the box is not a JSON object with a ${FIELD} list of profiles with unique IDs`);
  }
  if (edit === "no-jq") return { carried: [], warnings: [...warnings, noJqWarning("the Paseo terminal profiles")], changed: false };
  return { carried: kept.map((profile) => profile.name), warnings, changed: edit === "written" };
}
