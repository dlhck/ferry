/**
 * The registry loader merges operator entries into the builtin set.
 *
 * Entries are data. They arrive as the parsed `[[harness]]` and
 * `[tools.<id>]` tables of the operator config at `~/.ferry/config.toml`, so
 * this function never reads a file and never loads code. An entry may add a
 * harness or a tool. No entry may reuse a registered id or name a path outside
 * the home. No harness may name a path the deny set in Manifest already
 * covers, take a path another harness already owns, or root skills anywhere
 * but a skills directory. No tool may depend on an unknown tool or on itself
 * through a cycle.
 */

import { isAbsolute } from "node:path";
import { quoteShell } from "../box-settings.ts";
import type { ToolDefinition, ToolsConfig } from "../config.ts";
import { deniedSegment } from "../manifest.ts";
import { BUILTIN_HARNESSES, BUILTIN_TOOLS } from "./builtin.ts";
import type { HarnessDescriptor, ToolDescriptor } from "./types.ts";

/** Parsed operator config: the `[[harness]]` entries and the `[tools]` table. */
export type RegistryConfig = {
  readonly harness?: readonly unknown[];
  readonly tools?: ToolsConfig;
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
    | "path-collision"
    | "unknown-dependency"
    | "dependency-cycle";
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

  for (const [id, entry] of Object.entries(config.tools ?? {})) {
    // A string is the policy of a builtin tool. The config parser checked the id.
    if (typeof entry === "string") continue;
    if (tools.some((known) => known.id === id)) {
      problems.push({
        code: "duplicate-id",
        reason: `tool ${id} is built in. Set its policy with ${id} = "<policy>" in [tools], or pick another id.`,
      });
      continue;
    }
    const unsafe = (entry.path ?? []).find((dir) => {
      const plain = plainPath(dir);
      return isAbsolute(dir) || plain === "" || plain.split("/").includes("..");
    });
    if (unsafe !== undefined) {
      problems.push({ code: "unsafe-path", reason: `tool ${id} path ${unsafe} must be a directory inside the home` });
      continue;
    }
    tools.push(configTool(id, entry));
  }
  problems.push(...dependencyProblems(tools));

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
 * home and clear of the deny set, so an absolute path, a `..` escape, a path
 * inside `.ferry`, and a segment a deny rule covers are all refused. `null` means refused, and
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
  // Ferry keeps its own state there: the store, the config, backups, and on the box `box.json` and `exposed/`.
  if (plain.split("/")[0] === ".ferry") {
    problems.push({ code: "unsafe-path", reason: `${label} ${key} ${path} is inside ~/.ferry, which holds the state of Ferry` });
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
 * holds, whether the two are skill roots, instruction files, extra roots, or a mix.
 */
function pathCollision(
  harness: HarnessDescriptor,
  known: readonly HarnessDescriptor[],
): string | null {
  const mine = [harness.skillRoot, harness.instructionFile];
  for (const other of known) {
    for (const path of mine) {
      for (const held of [other.skillRoot, other.instructionFile, ...(other.extraRoots ?? [])]) {
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

/** A `[tools.<id>]` table as a tool of kind `tool`. */
function configTool(id: string, definition: ToolDefinition): ToolDescriptor {
  const fill = (command: string) => (version: string) => command.replaceAll("{version}", quoteShell(version));
  return {
    id,
    kind: "tool",
    localVersion: definition.local,
    ...(definition.box ? { boxVersion: definition.box } : {}),
    ...(definition.latest ? { latestVersion: definition.latest } : {}),
    recipe: { install: fill(definition.install), update: fill(definition.update ?? definition.install) },
    ...(definition.path ? { pathDirs: definition.path.map(plainPath) } : {}),
    ...(definition.depends ? { dependsOn: definition.depends } : {}),
  };
}

/** Each dependency must name a known tool, and no tool may depend on itself through others. */
function dependencyProblems(tools: readonly ToolDescriptor[]): RegistryProblem[] {
  const problems: RegistryProblem[] = [];
  const byId = new Map(tools.map((tool) => [tool.id, tool]));
  for (const tool of tools) {
    for (const dependency of tool.dependsOn ?? []) {
      if (!byId.has(dependency)) {
        problems.push({ code: "unknown-dependency", reason: `tool ${tool.id} depends on ${dependency}, which is not a known tool` });
      }
    }
  }

  const done = new Set<string>();
  const visit = (id: string, trail: readonly string[]): void => {
    const start = trail.indexOf(id);
    if (start !== -1) {
      const cycle = [...trail.slice(start), id].join(" -> ");
      problems.push({ code: "dependency-cycle", reason: `tools depend on each other in a cycle: ${cycle}` });
      return;
    }
    if (done.has(id)) return;
    for (const dependency of byId.get(id)?.dependsOn ?? []) visit(dependency, [...trail, id]);
    done.add(id);
  };
  for (const tool of tools) visit(tool.id, []);
  return problems;
}
