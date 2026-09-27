/**
 * Put the carried settings keys into box settings files and install the
 * Claude plugins they declare.
 *
 * The box keeps every settings key that ferry does not carry. A carried key
 * that the operator no longer has is removed, because the box never wins.
 */

import { posix } from "node:path";
import type { LinkResult, RunOptions } from "./link.ts";
import type { SeedSettings } from "./manifest.ts";
import type { HarnessDescriptor } from "./registry/types.ts";

/** The harness whose carried keys declare plugins for the `claude` CLI. */
const CLAUDE_HARNESS = "claude";
/** Marketplace installs clone git repositories, so they get more time than one command. */
const PLUGIN_TIMEOUT_MS = 600_000;

export type BoxSettingsLink = {
  run(command: string, options?: RunOptions): Promise<LinkResult>;
};

export class BoxSettingsError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BoxSettingsError";
  }
}

/** Replace `keys` in the box settings text with the carried values. Keep all other keys. */
export function mergeSettings(
  box: string | null,
  carried: Readonly<Record<string, unknown>>,
  keys: readonly string[],
): string {
  let settings: unknown = {};
  if (box !== null && box.trim() !== "") {
    try {
      settings = JSON.parse(box);
    } catch {
      settings = null;
    }
  }
  if (typeof settings !== "object" || settings === null || Array.isArray(settings)) {
    throw new BoxSettingsError("the box settings file is not a JSON object");
  }
  const merged = settings as Record<string, unknown>;
  for (const key of keys) {
    if (Object.hasOwn(carried, key)) merged[key] = carried[key];
    else delete merged[key];
  }
  return `${JSON.stringify(merged, null, 2)}\n`;
}

/** Merge each carried settings entry into the box. Return the files ferry wrote. */
export async function mergeBoxSettings(input: {
  readonly remoteHome: string;
  readonly harnesses: readonly HarnessDescriptor[];
  readonly settings: readonly SeedSettings[];
  readonly link: BoxSettingsLink;
}): Promise<readonly string[]> {
  const written: string[] = [];
  for (const entry of input.settings) {
    const descriptor = input.harnesses.find((harness) => harness.id === entry.harness)?.settings;
    if (!descriptor) continue;
    const path = posix.join(input.remoteHome, descriptor.file);

    const read = await checked(input.link, readCommand(path));
    const current = read.stdout.startsWith("F") ? read.stdout.slice(1) : null;
    let merged: string;
    try {
      merged = mergeSettings(current, parse(entry), descriptor.keys);
    } catch (error) {
      throw new BoxSettingsError(`${path}: ${messageOf(error)}`);
    }
    if (merged === current) continue;

    await checked(input.link, writeCommand(path, merged));
    written.push(path);
  }
  return written;
}

/**
 * Add each carried marketplace and install each enabled plugin with the box
 * `claude` CLI. Claude does not install a plugin from settings alone. Return
 * one warning for each marketplace or plugin the box could not take.
 */
export async function installBoxPlugins(input: {
  readonly settings: readonly SeedSettings[];
  readonly link: BoxSettingsLink;
}): Promise<readonly string[]> {
  const entry = input.settings.find((candidate) => candidate.harness === CLAUDE_HARNESS);
  if (!entry) return [];
  const carried = parse(entry);
  const warnings: string[] = [];
  const steps: string[] = [];

  for (const [name, value] of Object.entries(record(carried.extraKnownMarketplaces))) {
    const source = record(record(value).source);
    // A directory, file, or inline source names nothing the box can fetch.
    const location =
      source.source === "github"
        ? source.repo
        : source.source === "git" || source.source === "url"
          ? source.url
          : undefined;
    if (typeof location !== "string") {
      warnings.push(
        `marketplace ${name} has a ${String(source.source)} source; add it on the box by hand`,
      );
      continue;
    }
    steps.push(step("M", name, `claude plugin marketplace add ${quoteShell(location)}`));
  }
  for (const [id, enabled] of Object.entries(record(carried.enabledPlugins))) {
    if (enabled === true) steps.push(step("P", id, `claude plugin install ${quoteShell(id)}`));
  }
  if (steps.length === 0) return warnings;

  const script = [
    "command -v claude >/dev/null 2>&1 || { printf 'C\\n'; exit 0; }",
    ...steps,
  ].join("\n");
  const result = await checked(input.link, `sh -c ${quoteShell(script)}`, {
    agentForwarding: "git",
    timeoutMs: PLUGIN_TIMEOUT_MS,
  });

  for (const line of result.stdout.split("\n")) {
    const [kind, name, ...message] = line.split("\t");
    const detail = message.join("\t").trim();
    if (kind === "C") warnings.push("the claude CLI is not on the box PATH; no plugin was installed");
    if (kind === "M") warnings.push(`could not add marketplace ${name}: ${detail}`);
    if (kind === "P") warnings.push(`could not install plugin ${name}: ${detail}`);
  }
  return warnings;
}

/** One `claude` call. On failure it prints the kind, the name, and the last output line. */
function step(kind: "M" | "P", name: string, command: string): string {
  return [
    `if ! out=$(${command} 2>&1); then`,
    `printf '${kind}\\t%s\\t%s\\n' ${quoteShell(name)} "$(printf '%s\\n' "$out" | tail -n 1)";`,
    "fi",
  ].join(" ");
}

function readCommand(path: string): string {
  const quoted = quoteShell(path);
  return `if [ -e ${quoted} ]; then printf 'F' && cat ${quoted}; else printf 'M'; fi`;
}

/** Write through a temporary file, so Claude never reads a half-written file. */
function writeCommand(path: string, text: string): string {
  const temporary = quoteShell(`${path}.ferry-tmp`);
  return [
    "umask 077 &&",
    `mkdir -p ${quoteShell(posix.dirname(path))} &&`,
    `printf '%s' ${quoteShell(text)} > ${temporary} &&`,
    `mv ${temporary} ${quoteShell(path)}`,
  ].join(" ");
}

async function checked(
  link: BoxSettingsLink,
  command: string,
  options?: RunOptions,
): Promise<Extract<LinkResult, { ok: true }>> {
  const result = await link.run(command, options);
  if (!result.ok) {
    throw new BoxSettingsError(`${result.error.origin}/${result.error.code}: ${result.error.message}`);
  }
  return result;
}

function parse(entry: SeedSettings): Record<string, unknown> {
  return record(JSON.parse(Buffer.from(entry.bytes).toString()));
}

function record(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function quoteShell(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

function messageOf(error: unknown): string {
  return error instanceof Error && error.message ? error.message : String(error);
}
