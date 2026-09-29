/**
 * Carry the portable fields of Paseo provider definitions (`agents.providers`).
 * Credentials, env blocks, params, command paths, and enabled and order states stay on each host.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { quoteShell, readCommand, writeCommand } from "../box-settings.ts";
import { carriedContentHits } from "../manifest.ts";
import { CONFIG_FILE, PaseoError } from "./paseo.ts";
import type { IntegrationLink } from "./types.ts";

/** The fields that Ferry carries. Paseo 0.10.1 reloads them without a restart. */
const PORTABLE_FIELDS = ["extends", "label", "description", "models", "additionalModels", "disallowedTools", "paseoTools"] as const;
/** The Paseo 0.10.1 built-in provider IDs. A custom provider extends one of them or `acp`. */
const BUILTIN_IDS = ["claude", "codex", "copilot", "opencode", "pi", "omp"];
const ID_PATTERN = /^[a-z][a-z0-9-]*$/;
/** A command name that the box resolves through its PATH. */
const BARE_EXECUTABLE = /^[A-Za-z0-9][A-Za-z0-9._+-]*$/;
/** Shells and interpreters run a script argument that Ferry cannot check. */
const SCRIPT_RUNNERS = new Set([
  "sh", "bash", "zsh", "dash", "ksh", "fish", "csh", "tcsh", "env", "node", "deno", "bun",
  "python", "python3", "perl", "ruby", "php", "lua", "pwsh", "powershell", "cmd", "osascript",
]);
/** A file name with a config, key, script, or text extension. */
const FILE_ARGUMENT = /\.(?:json5?|jsonc|ya?ml|toml|env|ini|conf|cfg|pem|key|sh|[cm]?js|ts|py|rb|txt)$/i;
/** A scoped npm package, such as `@scope/name@1.2.3`. It is the one argument with a slash that is not a path. */
const SCOPED_PACKAGE = /^@[a-z0-9][a-z0-9._-]*\/[a-z0-9][a-z0-9._-]*(?:@[A-Za-z0-9._-]+)?$/;
const CREDENTIAL_ARGUMENT = /api[-_]?key|token|secret|passw|credential|auth/i;

export type PaseoProvider = {
  readonly id: string;
  /** The allowlisted fields, with only the model keys that Paseo knows. */
  readonly fields: Readonly<Record<string, unknown>>;
  /** The local command when it is portable, else null. Ferry uses it only to create a provider that the box lacks. */
  readonly command: readonly string[] | null;
  /** Why Ferry cannot create the provider on a box that lacks it, or null. It never holds a value. */
  readonly createBlocker: string | null;
};
export type PaseoProviders = {
  readonly providers: readonly PaseoProvider[];
  readonly warnings: readonly string[];
};

function object(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

const text = (value: unknown) => typeof value === "string";
const strings = (value: unknown) => Array.isArray(value) && value.every(text);

/** Copy a Paseo model entry with its known keys. Returns null for an entry that the Paseo schema rejects. */
function model(value: unknown): Record<string, unknown> | null {
  if (!object(value) || typeof value.id !== "string" || value.id === "" || typeof value.label !== "string" || value.label === "") {
    return null;
  }
  if ((value.description !== undefined && !text(value.description)) ||
      (value.isDefault !== undefined && typeof value.isDefault !== "boolean")) return null;
  const copy: Record<string, unknown> = { id: value.id, label: value.label };
  if (value.description !== undefined) copy.description = value.description;
  if (value.isDefault !== undefined) copy.isDefault = value.isDefault;
  if (value.thinkingOptions !== undefined) {
    if (!Array.isArray(value.thinkingOptions)) return null;
    const options = value.thinkingOptions.map((option: unknown) => {
      if (!object(option) || !text(option.id) || !text(option.label) ||
          (option.description !== undefined && !text(option.description)) ||
          (option.isDefault !== undefined && typeof option.isDefault !== "boolean")) return null;
      return Object.fromEntries(["id", "label", "description", "isDefault"]
        .filter((key) => option[key] !== undefined).map((key) => [key, option[key]]));
    });
    if (options.includes(null)) return null;
    copy.thinkingOptions = options;
  }
  return copy;
}

/** Copy the allowlisted fields. Returns the name of the first field that the Paseo schema rejects. */
function portableFields(entry: Record<string, unknown>): Record<string, unknown> | string {
  const fields: Record<string, unknown> = {};
  for (const key of PORTABLE_FIELDS) {
    const value = entry[key];
    if (value === undefined) continue;
    if (key === "models" || key === "additionalModels") {
      if (!Array.isArray(value)) return key;
      const copies = value.map(model);
      if (copies.includes(null)) return key;
      fields[key] = copies;
    } else if (key === "disallowedTools") {
      if (!strings(value)) return key;
      fields[key] = [...value as string[]];
    } else if (key === "paseoTools") {
      if (!object(value) || (value.enabled !== undefined && typeof value.enabled !== "boolean") ||
          (value.disabledTools !== undefined && !strings(value.disabledTools))) return key;
      fields[key] = Object.fromEntries(["enabled", "disabledTools"]
        .filter((name) => value[name] !== undefined).map((name) => [name, value[name]]));
    } else {
      if (!text(value)) return key;
      fields[key] = value;
    }
  }
  return fields;
}

/**
 * Classify one command argument, or its value after `=` for a flag. Whitespace
 * means embedded command text. A URL with a user, query, or fragment can hold
 * a credential. A slash, a `~`, `.`, or drive prefix, or a file extension
 * means a host path.
 */
function argumentIssue(arg: string): "path" | "script" | "credential" | null {
  if (/[\s\x00-\x1f]/.test(arg)) return "script";
  const value = arg.startsWith("-") && arg.includes("=") ? arg.slice(arg.indexOf("=") + 1) : arg;
  if (value.includes("://")) {
    try {
      const url = new URL(value);
      return url.username || url.password || url.search || url.hash ? "credential" : null;
    } catch {
      return "credential";
    }
  }
  if (/^(?:~|\.|[A-Za-z]:)/.test(value) || (/[\\/]/.test(value) && !SCOPED_PACKAGE.test(value)) || FILE_ARGUMENT.test(value)) {
    return "path";
  }
  return null;
}

/** Why a box that lacks the provider cannot get a working copy, or null. */
function createBlocker(entry: Record<string, unknown>, command: readonly string[] | undefined): string | null {
  const reasons: string[] = [];
  if (entry.env !== undefined) reasons.push("it has an env block");
  if (entry.params !== undefined) reasons.push("it has params");
  if (entry.enabled === false) reasons.push("it is disabled locally");
  if (command !== undefined) {
    const [executable = "", ...args] = command;
    if (!BARE_EXECUTABLE.test(executable)) reasons.push("its command is not a bare executable name");
    if (SCRIPT_RUNNERS.has(executable.toLowerCase())) reasons.push("its command runs a shell or interpreter");
    const issues = new Set(args.map(argumentIssue));
    if (issues.has("path")) reasons.push("its command has a local path argument");
    if (issues.has("script")) reasons.push("its command has a script-like argument");
    if (issues.has("credential") || command.some((arg) => CREDENTIAL_ARGUMENT.test(arg)) ||
        carriedContentHits(".env", Buffer.from(command.join("\n"))).length > 0) {
      reasons.push("its command has a credential-like argument");
    }
  }
  return reasons.length === 0 ? null : reasons.join(", ");
}

/**
 * Read `agents.providers` from the local Paseo config. A missing file or key
 * gives no providers. Throw a PaseoError for an entry that the Paseo schema
 * rejects, or for a carried field that holds a token or a secret. The error
 * names the provider and the rule, never a value.
 */
export function readPaseoProviders(home: string): PaseoProviders {
  const path = join(home, CONFIG_FILE);
  let content: string;
  try {
    content = readFileSync(path, "utf8");
  } catch {
    return { providers: [], warnings: [] };
  }
  let config: unknown;
  try {
    config = JSON.parse(content);
  } catch {
    throw new PaseoError(`${path} is not valid JSON, so Ferry cannot read agents.providers`);
  }
  if (!object(config)) throw new PaseoError(`${path} is not a JSON object`);
  if (config.agents !== undefined && !object(config.agents)) throw new PaseoError(`agents in ${path} is not an object`);
  const entries = config.agents?.providers;
  if (entries === undefined) return { providers: [], warnings: [] };
  if (!object(entries)) throw new PaseoError(`agents.providers in ${path} is not an object`);

  const providers: PaseoProvider[] = [];
  const warnings: string[] = [];
  const invalid = (id: string, rule: string) => new PaseoError(`Paseo provider ${id} in ${path} is invalid: ${rule}`);
  for (const [id, entry] of Object.entries(entries)) {
    if (!ID_PATTERN.test(id)) throw new PaseoError(`Paseo has a provider ID in ${path} that does not match ${ID_PATTERN}`);
    if (!object(entry)) throw invalid(id, "it is not a JSON object");
    if (object(entry.command)) {
      warnings.push(`Paseo provider ${id} was skipped: it uses the legacy provider format. Open and save it in Paseo to migrate it.`);
      continue;
    }
    const fields = portableFields(entry);
    if (typeof fields === "string") throw invalid(id, `${fields} does not match the Paseo schema`);
    const builtin = BUILTIN_IDS.includes(id);
    if (!builtin && fields.extends === undefined) throw invalid(id, "a custom provider needs extends");
    if (!builtin && fields.label === undefined) throw invalid(id, "a custom provider needs label");
    if (fields.extends !== undefined && ![...BUILTIN_IDS, "acp"].includes(fields.extends as string)) {
      throw invalid(id, "extends names an unknown provider");
    }
    const command = entry.command;
    if (command !== undefined && (!Array.isArray(command) || command.length === 0 || !command.every((arg) => text(arg) && arg !== ""))) {
      throw invalid(id, "command is not a list of non-empty strings");
    }
    if (fields.extends === "acp" && command === undefined) throw invalid(id, "a provider that extends acp needs command");
    const hits = carriedContentHits(path, Buffer.from(JSON.stringify(fields)));
    if (hits.length > 0) {
      throw new PaseoError(`Ferry refused to carry Paseo provider ${id} in ${path}: ${[...new Set(hits.map((hit) => hit.reason))].join("; ")}`);
    }
    const blocker = createBlocker(entry, command as string[] | undefined);
    providers.push({
      id,
      fields,
      command: command === undefined || blocker !== null ? null : [...command as string[]],
      createBlocker: blocker,
    });
  }
  return { providers, warnings };
}

export type ProviderCarry = {
  /** The IDs of the providers whose portable fields the box config holds after the carry. */
  readonly carried: readonly string[];
  /** One line for each provider that Ferry did not carry. */
  readonly warnings: readonly string[];
  /** True when Ferry wrote the box config and reloaded the daemon. */
  readonly changed: boolean;
};

/** Put the local portable fields over the box entry. `paseoTools` merges by key. */
function merge(box: Record<string, unknown>, fields: Readonly<Record<string, unknown>>): Record<string, unknown> {
  const merged = { ...box, ...fields };
  if (object(fields.paseoTools) && object(box.paseoTools)) merged.paseoTools = { ...box.paseoTools, ...fields.paseoTools };
  return merged;
}

/**
 * Merge the local providers into `agents.providers` of the box Paseo config.
 * A provider that the box defines keeps its box env, command, params, enabled,
 * order, and other box fields. A provider that the box lacks is created only
 * when it needs no local runtime field, and its command executable is on the
 * box PATH. Ferry never removes a box provider. `paseo daemon reload` applies
 * the change without a restart. With no local providers, it runs no box command.
 */
export async function carryPaseoProviders(link: IntegrationLink, source: PaseoProviders): Promise<ProviderCarry> {
  const warnings = [...source.warnings];
  if (source.providers.length === 0) return { carried: [], warnings, changed: false };

  // The box config holds box credentials, and a box can echo a failed command. Report only the action.
  const run = async (command: string, what: string): Promise<string> => {
    const result = await link.run(command, { timeoutMs: 30_000 });
    if (!result.ok) throw new PaseoError(what);
    return result.stdout;
  };
  const current = await run(readCommand(CONFIG_FILE), `Ferry could not read ~/${CONFIG_FILE} on the box`);
  let config: unknown = {};
  if (current.startsWith("F") && current.slice(1).trim() !== "") {
    try { config = JSON.parse(current.slice(1)); } catch { config = null; }
  }
  const agents = object(config) ? config.agents : undefined;
  const boxProviders = object(agents) ? agents.providers : undefined;
  if (!object(config) || (agents !== undefined && !object(agents)) || (boxProviders !== undefined && !object(boxProviders))) {
    throw new PaseoError(`~/${CONFIG_FILE} on the box is not a JSON object with agents and agents.providers objects`);
  }
  const before = (boxProviders ?? {}) as Record<string, unknown>;
  const next: Record<string, unknown> = { ...before };
  const verify: PaseoProvider[] = [];
  const kept = new Set<string>();
  for (const provider of source.providers) {
    // An own-key read, so a provider named `constructor` does not find Object.prototype.constructor.
    const existing = Object.hasOwn(before, provider.id) ? before[provider.id] : undefined;
    if (existing !== undefined) {
      if (object(existing) && object(existing.command)) {
        warnings.push(`Paseo provider ${provider.id} was skipped: the box entry uses the legacy provider format. Open and save it in Paseo on the box to migrate it.`);
        continue;
      }
      if (!object(existing) || existing.extends !== provider.fields.extends) {
        warnings.push(`Paseo provider ${provider.id} was skipped: the box defines it with a different extends value.`);
        continue;
      }
      next[provider.id] = merge(existing, provider.fields);
      kept.add(provider.id);
    } else if (provider.createBlocker !== null) {
      warnings.push(
        `Paseo provider ${provider.id} was not created on the box: ${provider.createBlocker}. Define it on the box first, then Ferry syncs its portable fields.`,
      );
    } else if (provider.command !== null) {
      verify.push(provider);
    } else {
      next[provider.id] = { ...provider.fields };
      kept.add(provider.id);
    }
  }
  if (verify.length > 0) {
    const names = [...new Set(verify.map((provider) => provider.command![0]!))];
    const found = await run(
      names.map((name) => `if command -v -- ${quoteShell(name)} >/dev/null 2>&1; then echo ok ${quoteShell(name)}; else echo missing ${quoteShell(name)}; fi`).join("\n"),
      "Ferry could not check the Paseo provider commands on the box",
    );
    const onPath = new Set(found.split("\n").filter((line) => line.startsWith("ok ")).map((line) => line.slice(3)));
    for (const provider of verify) {
      if (onPath.has(provider.command![0]!)) {
        next[provider.id] = { ...provider.fields, command: provider.command };
        kept.add(provider.id);
      } else {
        warnings.push(
          `Paseo provider ${provider.id} was not created on the box: its command executable is not on the box PATH. Install it on the box, or define the provider on the box first.`,
        );
      }
    }
  }
  const carried = source.providers.map((provider) => provider.id).filter((id) => kept.has(id));
  if (JSON.stringify(next) === JSON.stringify(before)) return { carried, warnings, changed: false };
  const merged = { ...config, agents: { ...(agents as Record<string, unknown> | undefined), providers: next } };
  await run(writeCommand(CONFIG_FILE, `${JSON.stringify(merged, null, 2)}\n`), `Ferry could not write the Paseo providers to ~/${CONFIG_FILE} on the box`);
  await run("paseo daemon reload", "paseo daemon reload failed on the box after Ferry wrote the Paseo providers");
  return { carried, warnings, changed: true };
}
