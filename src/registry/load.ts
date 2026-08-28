/**
 * The registry loader merges operator entries into the builtin set.
 *
 * Entries are data. They arrive as the parsed `[[harness]]` and `[[tool]]`
 * tables of the operator config at `~/.ferry/config.toml`, so this function
 * never reads a file and never loads code. An entry may add a harness or a
 * tool. No entry may reuse a registered id, name a path outside the home, name
 * a path the deny set in Manifest already covers, take a path another harness
 * already owns, or root skills anywhere but a skills directory.
 */

import { isAbsolute } from "node:path";
import { deniedSegment } from "../manifest.ts";
import { BUILTIN_HARNESSES, BUILTIN_TOOLS } from "./builtin.ts";
import type {
  AuthCompletion,
  AuthFallback,
  HarnessDescriptor,
  ToolAuth,
  ToolDescriptor,
} from "./types.ts";

/** Parsed operator config. The keys are the TOML array-of-table names. */
export type RegistryConfig = {
  readonly harness?: readonly unknown[];
  readonly tool?: readonly unknown[];
};

export type Registry = {
  readonly harnesses: readonly HarnessDescriptor[];
  readonly tools: readonly ToolDescriptor[];
};

/** Why an entry was refused. The code is stable; the reason names the entry. */
export type RegistryProblem = {
  readonly code:
    | "invalid-entry"
    | "duplicate-id"
    | "unsafe-path"
    | "denied-path"
    | "invalid-skill-root"
    | "path-collision";
  readonly reason: string;
};

export type RegistryResult =
  | ({ readonly ok: true } & Registry)
  | { readonly ok: false; readonly problems: readonly RegistryProblem[] };

/** Merge the config into the builtin registry, or refuse and name every problem. */
export function loadRegistry(config: RegistryConfig = {}): RegistryResult {
  const problems: RegistryProblem[] = [];
  const harnesses = [...BUILTIN_HARNESSES];
  const tools = [...BUILTIN_TOOLS];

  for (const [index, entry] of (config.harness ?? []).entries()) {
    const harness = readHarness(entry, `harness ${index + 1}`, problems);
    if (!harness) continue;
    if (harnesses.some((known) => known.id === harness.id)) {
      problems.push({ code: "duplicate-id", reason: `harness ${harness.id} is already registered` });
      continue;
    }
    const collision = pathCollision(harness, harnesses);
    if (collision) {
      problems.push({ code: "path-collision", reason: `harness ${harness.id} ${collision}` });
      continue;
    }
    harnesses.push(harness);
  }

  for (const [index, entry] of (config.tool ?? []).entries()) {
    const tool = readTool(entry, `tool ${index + 1}`, problems);
    if (!tool) continue;
    if (tools.some((known) => known.id === tool.id)) {
      problems.push({ code: "duplicate-id", reason: `tool ${tool.id} is already registered` });
      continue;
    }
    tools.push(tool);
  }

  if (problems.length > 0) return { ok: false, problems };
  return { ok: true, harnesses, tools };
}

function readHarness(
  value: unknown,
  label: string,
  problems: RegistryProblem[],
): HarnessDescriptor | null {
  const entry = table(value, label, problems);
  if (!entry) return null;

  const id = text(entry, "id", label, problems);
  const name = text(entry, "name", label, problems);
  if (!id || !name) {
    problems.push({ code: "invalid-entry", reason: `${label} needs an id and a name` });
    return null;
  }
  if (entry.skillRoot === undefined && entry.instructionFile === undefined) {
    problems.push({
      code: "invalid-entry",
      reason: `${label} needs a skillRoot, an instructionFile, or both`,
    });
    return null;
  }

  const skillRoot = readPath(entry, "skillRoot", "directory", label, problems);
  const instructionFile = readPath(entry, "instructionFile", "file", label, problems);
  if (skillRoot === null || instructionFile === null) return null;
  // Every builtin root ends in a skills directory. A registered root must too,
  // so an entry cannot point the scanner at a vendor home such as `.config`.
  if (skillRoot && skillRoot.split("/").at(-1) !== "skills") {
    problems.push({
      code: "invalid-skill-root",
      reason: `${label} skillRoot ${skillRoot} must end in a skills directory`,
    });
    return null;
  }

  return {
    id,
    name,
    ...(skillRoot ? { skillRoot } : {}),
    ...(instructionFile ? { instructionFile } : {}),
  };
}

/**
 * Read one harness path in its plain form. A harness path stays inside the
 * home and clear of the deny set, so an absolute path, a `..` escape, and a
 * segment a deny rule covers are all refused. `null` means refused, and
 * `undefined` means the entry left the field out.
 */
function readPath(
  entry: Record<string, unknown>,
  key: string,
  leaf: "directory" | "file",
  label: string,
  problems: RegistryProblem[],
): string | null | undefined {
  if (entry[key] === undefined) return undefined;
  const path = text(entry, key, label, problems);
  if (!path) return null;

  if (isAbsolute(path)) {
    problems.push({ code: "unsafe-path", reason: `${label} ${key} ${path} leaves the home` });
    return null;
  }
  const plain = plainPath(path);
  if (plain === "" || plain.split("/").some((segment) => segment === "..")) {
    problems.push({ code: "unsafe-path", reason: `${label} ${key} ${path} leaves the home` });
    return null;
  }
  const denied = deniedSegment(plain, leaf);
  if (denied) {
    problems.push({ code: "denied-path", reason: `${label} ${key} ${path} names a ${denied.reason}` });
    return null;
  }
  return plain;
}

/** One spelling per path, so a trailing slash cannot hide a collision. */
function plainPath(path: string): string {
  return path
    .split("/")
    .filter((segment) => segment !== "" && segment !== ".")
    .join("/");
}

/**
 * Two harnesses that link the same path fight over it while apply commits. No
 * path of a new harness may equal or nest inside any path a known harness
 * holds, whether the two are skill roots, instruction files, or one of each.
 */
function pathCollision(
  harness: HarnessDescriptor,
  known: readonly HarnessDescriptor[],
): string | null {
  const mine = [harness.skillRoot, harness.instructionFile];
  for (const other of known) {
    for (const path of mine) {
      for (const held of [other.skillRoot, other.instructionFile]) {
        if (path && held && nests(path, held)) {
          return `path ${path} collides with ${other.id} at ${held}`;
        }
      }
    }
  }
  return null;
}

function nests(one: string, other: string): boolean {
  return one === other || one.startsWith(`${other}/`) || other.startsWith(`${one}/`);
}

function readTool(
  value: unknown,
  label: string,
  problems: RegistryProblem[],
): ToolDescriptor | null {
  const entry = table(value, label, problems);
  if (!entry) return null;

  const id = text(entry, "id", label, problems);
  if (!id) {
    problems.push({ code: "invalid-entry", reason: `${label} needs an id` });
    return null;
  }
  if (entry.install === undefined && entry.auth === undefined) {
    problems.push({
      code: "invalid-entry",
      reason: `${label} needs an install command, a login recipe, or both`,
    });
    return null;
  }

  let install: ToolDescriptor["install"];
  if (entry.install !== undefined) {
    const installEntry = table(entry.install, `${label} install`, problems);
    const command = installEntry && text(installEntry, "command", `${label} install`, problems);
    if (!command) {
      problems.push({ code: "invalid-entry", reason: `${label} install needs a command` });
      return null;
    }
    install = { command };
  }

  let auth: ToolAuth | undefined;
  if (entry.auth !== undefined) {
    auth = readAuth(entry.auth, `${label} auth`, problems) ?? undefined;
    if (!auth) return null;
  }

  return { id, ...(install ? { install } : {}), ...(auth ? { auth } : {}) };
}

function readAuth(value: unknown, label: string, problems: RegistryProblem[]): ToolAuth | null {
  const entry = table(value, label, problems);
  if (!entry) return null;

  const probe = text(entry, "probe", label, problems);
  const login = text(entry, "login", label, problems);
  const completion = readCompletion(entry.completion, `${label} completion`, problems);
  if (!completion) return null;

  // Ferry can only start a login it has both commands for.
  if (completion.kind !== "manual" && (!probe || !login)) {
    problems.push({ code: "invalid-entry", reason: `${label} needs a probe and a login` });
    return null;
  }

  let fallback: AuthFallback | undefined;
  if (entry.fallback !== undefined) {
    fallback = readFallback(entry.fallback, `${label} fallback`, problems) ?? undefined;
    if (!fallback) return null;
  }

  return {
    ...(probe ? { probe } : {}),
    ...(login ? { login } : {}),
    completion,
    ...(fallback ? { fallback } : {}),
  };
}

function readCompletion(
  value: unknown,
  label: string,
  problems: RegistryProblem[],
): AuthCompletion | null {
  const entry = table(value, label, problems);
  if (!entry) return null;

  const named = problems.length;
  const kind = text(entry, "kind", label, problems);
  if (kind === "device-url") {
    const url = text(entry, "url", label, problems);
    const codePattern = text(entry, "codePattern", label, problems);
    if (url && !isHttpsUrl(url)) {
      problems.push({ code: "invalid-entry", reason: `${label} url ${url} is not an https URL` });
      return null;
    }
    // A pattern that cannot compile would throw while a login is already running.
    if (codePattern && !compiles(codePattern)) {
      problems.push({
        code: "invalid-entry",
        reason: `${label} codePattern is not a regular expression`,
      });
      return null;
    }
    if (url) return { kind, url, ...(codePattern ? { codePattern } : {}) };
  }
  if (kind === "printed-url") {
    const allowedHosts = hostList(entry, "allowedHosts", label, problems);
    if (allowedHosts && allowedHosts.length > 0) return { kind, allowedHosts };
  }
  if (kind === "manual") {
    const command = text(entry, "command", label, problems);
    const instruction = text(entry, "instruction", label, problems);
    if (command && instruction) return { kind, command, instruction };
  }

  // A field problem already says what is wrong. Only an unrecognised shape needs this.
  if (problems.length === named) {
    problems.push({
      code: "invalid-entry",
      reason: `${label} must be a complete device-url, printed-url, or manual completion`,
    });
  }
  return null;
}

function readFallback(
  value: unknown,
  label: string,
  problems: RegistryProblem[],
): AuthFallback | null {
  const entry = table(value, label, problems);
  if (!entry) return null;

  const named = problems.length;
  const login = text(entry, "login", label, problems);
  const allowedHosts = hostList(entry, "allowedHosts", label, problems);
  const forward = table(entry.forward, `${label} forward`, problems);
  const localPort = forward && count(forward, "localPort", `${label} forward`, problems);
  const remotePort = forward && count(forward, "remotePort", `${label} forward`, problems);
  const remoteHost = forward && text(forward, "remoteHost", `${label} forward`, problems);
  const timeoutMs = forward && count(forward, "timeoutMs", `${label} forward`, problems);

  if (!login || !allowedHosts?.length || !localPort || !remotePort || !remoteHost || !timeoutMs) {
    if (problems.length === named) {
      problems.push({
        code: "invalid-entry",
        reason: `${label} needs a login, allowed hosts, and a complete forward`,
      });
    }
    return null;
  }
  return { login, allowedHosts, forward: { localPort, remotePort, remoteHost, timeoutMs } };
}

function table(
  value: unknown,
  label: string,
  problems: RegistryProblem[],
): Record<string, unknown> | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    problems.push({ code: "invalid-entry", reason: `${label} is not a table` });
    return null;
  }
  return value as Record<string, unknown>;
}

/** Read a string field. A field that is present but not a non-empty string is a problem. */
function text(
  entry: Record<string, unknown>,
  key: string,
  label: string,
  problems: RegistryProblem[],
): string | undefined {
  const value = entry[key];
  if (value === undefined) return undefined;
  if (typeof value !== "string" || value === "") {
    problems.push({ code: "invalid-entry", reason: `${label} ${key} is not a string` });
    return undefined;
  }
  return value;
}

/** An allowed host names a domain. A bare label such as `com` would open a whole TLD. */
function hostList(
  entry: Record<string, unknown>,
  key: string,
  label: string,
  problems: RegistryProblem[],
): readonly string[] | undefined {
  const hosts = textList(entry, key, label, problems);
  if (!hosts) return undefined;
  if (hosts.some((host) => !host.includes("."))) {
    problems.push({ code: "invalid-entry", reason: `${label} ${key} must name domains` });
    return undefined;
  }
  return hosts;
}

function isHttpsUrl(value: string): boolean {
  try {
    return new URL(value).protocol === "https:";
  } catch {
    return false;
  }
}

function compiles(pattern: string): boolean {
  try {
    new RegExp(pattern);
    return true;
  } catch {
    return false;
  }
}

function textList(
  entry: Record<string, unknown>,
  key: string,
  label: string,
  problems: RegistryProblem[],
): readonly string[] | undefined {
  const value = entry[key];
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string" || item === "")) {
    problems.push({ code: "invalid-entry", reason: `${label} ${key} is not a list of strings` });
    return undefined;
  }
  return value as readonly string[];
}

function count(
  entry: Record<string, unknown>,
  key: string,
  label: string,
  problems: RegistryProblem[],
): number | undefined {
  const value = entry[key];
  if (value === undefined) return undefined;
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    problems.push({ code: "invalid-entry", reason: `${label} ${key} is not a positive number` });
    return undefined;
  }
  return value;
}
