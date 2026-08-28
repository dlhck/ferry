/**
 * The registry loader merges operator entries into the builtin set.
 *
 * Entries are data. They arrive as the parsed `[[harness]]` and `[[tool]]`
 * tables of the operator config at `~/.ferry/config.toml`, so this function
 * never reads a file and never loads code. An entry may add a harness or a
 * tool. No entry may reuse a registered id, name a path outside the home, or
 * name a path the deny set in Manifest already covers.
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
  readonly code: "invalid-entry" | "duplicate-id" | "unsafe-path" | "denied-path";
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
  const skillRoot = text(entry, "skillRoot", label, problems);
  const instructionFile = text(entry, "instructionFile", label, problems);
  if (!id || !name) {
    problems.push({ code: "invalid-entry", reason: `${label} needs an id and a name` });
    return null;
  }

  const safe =
    checkPath(skillRoot, "directory", label, problems) &&
    checkPath(instructionFile, "file", label, problems);
  if (!safe) return null;

  return {
    id,
    name,
    ...(skillRoot ? { skillRoot } : {}),
    ...(instructionFile ? { instructionFile } : {}),
  };
}

/**
 * A harness path stays inside the home and clear of the deny set. An absolute
 * path, a `..` escape, and a segment a deny rule covers are all refused, so a
 * registered harness cannot reach what Manifest already refuses.
 */
function checkPath(
  path: string | undefined,
  leaf: "directory" | "file",
  label: string,
  problems: RegistryProblem[],
): boolean {
  if (path === undefined) return true;
  if (isAbsolute(path) || path.split("/").some((segment) => segment === "..")) {
    problems.push({ code: "unsafe-path", reason: `${label} path ${path} leaves the home` });
    return false;
  }
  const denied = deniedSegment(path, leaf);
  if (denied) {
    problems.push({ code: "denied-path", reason: `${label} path ${path} names a ${denied.reason}` });
    return false;
  }
  return true;
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

  const kind = text(entry, "kind", label, problems);
  if (kind === "device-url") {
    const url = text(entry, "url", label, problems);
    const codePattern = text(entry, "codePattern", label, problems);
    if (url) return { kind, url, ...(codePattern ? { codePattern } : {}) };
  }
  if (kind === "printed-url") {
    const allowedHosts = textList(entry, "allowedHosts", label, problems);
    if (allowedHosts && allowedHosts.length > 0) return { kind, allowedHosts };
  }
  if (kind === "manual") {
    const command = text(entry, "command", label, problems);
    const instruction = text(entry, "instruction", label, problems);
    if (command && instruction) return { kind, command, instruction };
  }

  problems.push({
    code: "invalid-entry",
    reason: `${label} must be a complete device-url, printed-url, or manual completion`,
  });
  return null;
}

function readFallback(
  value: unknown,
  label: string,
  problems: RegistryProblem[],
): AuthFallback | null {
  const entry = table(value, label, problems);
  if (!entry) return null;

  const login = text(entry, "login", label, problems);
  const allowedHosts = textList(entry, "allowedHosts", label, problems);
  const forward = table(entry.forward, `${label} forward`, problems);
  const localPort = forward && count(forward, "localPort", `${label} forward`, problems);
  const remotePort = forward && count(forward, "remotePort", `${label} forward`, problems);
  const remoteHost = forward && text(forward, "remoteHost", `${label} forward`, problems);
  const timeoutMs = forward && count(forward, "timeoutMs", `${label} forward`, problems);

  if (!login || !allowedHosts?.length || !localPort || !remotePort || !remoteHost || !timeoutMs) {
    problems.push({
      code: "invalid-entry",
      reason: `${label} needs a login, allowed hosts, and a complete forward`,
    });
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
