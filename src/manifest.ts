/**
 * Manifest decides what leaves the operator machine.
 *
 * Callers hand it a source home and the harness registry and get back a seed
 * (skill bodies, extra root files, and the one instruction file) or a refusal
 * that names every clash and every forbidden hit. Callers pass harnesses, never
 * a path set: the union rule and the deny set live here, out of reach of any
 * registry entry.
 */

import { createHash } from "node:crypto";
import { readFileSync, readdirSync, realpathSync, statSync } from "node:fs";
import type { Dirent } from "node:fs";
import { join, posix, relative, sep } from "node:path";
import { ownsSkills, type HarnessDescriptor } from "./registry/types.ts";

/** The one instruction file of the seed, relative to the source home. */
const INSTRUCTION_FILE = "AGENTS.md";

type DenyVerdict = "refuse" | "skip";

/** Why ferry set something aside. The code is stable; the reason is for people. */
type Note = { readonly code: string; readonly reason: string };

type DenyRule = Note & { readonly verdict: DenyVerdict };

export type DenyRuleDescription = {
  readonly code: string;
  readonly description: string;
  readonly behavior: DenyVerdict;
};

const DENY_RULES = {
  dotenv: { code: "dotenv", reason: "environment file", verdict: "refuse" },
  credentials: { code: "credentials", reason: "vendor auth or credential file", verdict: "refuse" },
  "private-key": { code: "private-key", reason: "private key", verdict: "refuse" },
  token: { code: "token", reason: "host token, daemon key, or MCP token", verdict: "refuse" },
  "symlink-escape": {
    code: "symlink-escape",
    reason: "symlink that leaves the skill directory",
    verdict: "refuse",
  },
  "github-token": { code: "github-token", reason: "GitHub token in file content", verdict: "refuse" },
  "anthropic-key": {
    code: "anthropic-key",
    reason: "Anthropic API key in file content",
    verdict: "refuse",
  },
  "openai-key": { code: "openai-key", reason: "OpenAI API key in file content", verdict: "refuse" },
  "slack-token": { code: "slack-token", reason: "Slack token in file content", verdict: "refuse" },
  "aws-access-key": {
    code: "aws-access-key",
    reason: "AWS access key ID in file content",
    verdict: "refuse",
  },
  "settings-credential": {
    code: "settings-credential",
    reason: "request headers in a carried settings key",
    verdict: "refuse",
  },
  "hook-path": {
    code: "hook-path",
    reason: "hook entry that refers to a home path outside the managed set",
    verdict: "skip",
  },
  history: { code: "history", reason: "session history", verdict: "skip" },
  database: { code: "database", reason: "sqlite or other database file", verdict: "skip" },
  cache: { code: "cache", reason: "cache or build output", verdict: "skip" },
  settings: {
    code: "settings",
    reason: "whole harness settings file; only listed keys are carried",
    verdict: "skip",
  },
} as const satisfies Record<string, DenyRule>;

/** Return Manifest's deny rules without scanning or writing the source home. */
export function denyRules(): readonly DenyRuleDescription[] {
  return Object.values(DENY_RULES).map((rule) => ({
    code: rule.code,
    description: rule.reason,
    behavior: rule.verdict,
  }));
}

/** Notes for entries no deny rule covers. */
const NOTES = {
  "not-a-directory": { code: "not-a-directory", reason: "not a skill directory" },
  "broken-link": { code: "broken-link", reason: "broken symlink" },
  "not-a-file": { code: "not-a-file", reason: "not a regular file" },
  "ferry-backup": { code: "ferry-backup", reason: "Ferry backup directory" },
  "invalid-settings": { code: "invalid-settings", reason: "settings file that is not a JSON object" },
} as const satisfies Record<string, Note>;

const FERRY_BACKUP_NAME = /\.ferry-backup-\d{8}T\d{6}Z$/;
const CREDENTIAL_NAMES = new Set([
  "credentials.json",
  ".credentials.json",
  "auth.json",
  ".auth.json",
  ".netrc",
]);
const TOKEN_NAMES = new Set([
  "token.json",
  ".token",
  "daemon.key",
  "tailscaled.state",
  ".tailscaled.state",
]);
const PRIVATE_KEY_NAMES = new Set(["id_rsa", "id_dsa", "id_ecdsa", "id_ed25519"]);
const PRIVATE_KEY_EXTS = [".pem", ".key", ".p12", ".pfx"];
const HISTORY_NAMES = new Set(["history.jsonl", "history.json"]);
const DATABASE_EXTS = [".sqlite", ".sqlite3", ".db"];
const CACHE_DIRS = new Set([".git", "node_modules", ".cache", "__pycache__"]);
const SETTINGS_NAMES = new Set(["settings.json", "settings.local.json", "mcp.json", ".mcp.json"]);
const PRIVATE_KEY_HEADER = /-----BEGIN (?:[A-Z0-9 ]+ )?PRIVATE KEY-----/;
// A bare prefix in prose is not a token. Each pattern needs a token-length tail.
// Group 1 is the body after the prefix.
const TOKEN_PATTERNS = [
  [/\bgh[opsu]_([A-Za-z0-9]{30,})/g, DENY_RULES["github-token"]],
  [/\bgithub_pat_([A-Za-z0-9_]{40,})/g, DENY_RULES["github-token"]],
  [/\bsk-ant-([A-Za-z0-9_-]{20,})/g, DENY_RULES["anthropic-key"]],
  [/\bsk-proj-([A-Za-z0-9_-]{20,})/g, DENY_RULES["openai-key"]],
  [/\bxox[bp]-([A-Za-z0-9-]{20,})/g, DENY_RULES["slack-token"]],
  [/\bAKIA([0-9A-Z]{16})\b/g, DENY_RULES["aws-access-key"]],
] as const satisfies readonly (readonly [RegExp, DenyRule])[];
/**
 * A documentation placeholder, not a token: a body that is one character
 * (`x`, `X`, or `0`) repeated, or a body of only `x`/`X` with the `-`/`_`
 * separators of the vendor format, such as `xxxx-xxxx`. Other repeated
 * characters, such as `aaaa`, still count as a token.
 */
const PLACEHOLDER_BODY = /^(?:([xX0])\1*|[xX]+(?:[-_]+[xX]+)*)$/;
/** Words in a hook command that name a file under the home: `~/x`, `$HOME/x`, `${HOME}/x`. */
const HOME_REFERENCE = /^(?:~|\$HOME|\$\{HOME\})\/(.*)$/;
/** Shell quotes, operators, and `=` separate the words of a hook command. */
const COMMAND_SEPARATORS = /[\s"'`;|&()<>=]+/;

/** A file whose path relative to its skill directory is `path`. */
export type SeedFile = { readonly path: string; readonly bytes: Uint8Array };

export type SeedSkill = { readonly name: string; readonly files: readonly SeedFile[] };

export type Instructions = { readonly bytes: Uint8Array };

/** One extra root, such as `.claude/agents`. `path` is relative to the home. */
export type SeedRoot = { readonly path: string; readonly files: readonly SeedFile[] };

/** The carried keys of one harness settings file, as JSON. `harness` is the harness id. */
export type SeedSettings = { readonly harness: string; readonly bytes: Uint8Array };

/** Something ferry found and did not import. Init prints these. */
export type Leftover = Note & { readonly path: string };

export type Seed = {
  readonly ok: true;
  readonly skills: readonly SeedSkill[];
  readonly instructions: Instructions | null;
  /** The extra roots of the harnesses that exist in the home, empty ones too. */
  readonly roots: readonly SeedRoot[];
  /** The carried settings keys of each harness whose settings file exists. */
  readonly settings: readonly SeedSettings[];
  /** Content hash of the whole seed. Changes when any skill or byte changes. */
  readonly identity: string;
  readonly leftovers: readonly Leftover[];
};

/** One skill name found with different bytes in more than one harness. */
export type Clash = { readonly name: string; readonly paths: readonly string[] };

export type ForbiddenHit = Note & { readonly path: string };

export type Refusal = {
  readonly ok: false;
  readonly clashes: readonly Clash[];
  readonly forbidden: readonly ForbiddenHit[];
};

/**
 * Read the seed for `home`.
 *
 * Only the skill roots and extra roots of `harnesses` and the home instruction
 * file are read. Project skill directories sit outside those roots, so they
 * are never seen.
 */
export function readSeed(home: string, harnesses: readonly HarnessDescriptor[]): Seed | Refusal {
  const clashes: Clash[] = [];
  const forbidden: ForbiddenHit[] = [];
  const leftovers: Leftover[] = [];
  const occurrences = collectOccurrences(home, harnesses, leftovers);
  const skills: SeedSkill[] = [];

  for (const [name, found] of [...occurrences].sort(([a], [b]) => compare(a, b))) {
    // The same inode reached through two harnesses is one directory. Read it once.
    const distinct = new Map<string, Occurrence>();
    for (const occurrence of found) {
      if (!distinct.has(occurrence.inode)) distinct.set(occurrence.inode, occurrence);
    }

    const variants = new Map<string, SeedFile[]>();
    for (const occurrence of distinct.values()) {
      const scan = scanSkill(occurrence.path);
      forbidden.push(...scan.forbidden);
      leftovers.push(...scan.leftovers);
      const key = contentKey(scan.files);
      if (!variants.has(key)) variants.set(key, scan.files);
    }

    if (variants.size > 1) {
      clashes.push({ name, paths: found.map((o) => o.path).sort(compare) });
      continue;
    }
    skills.push({ name, files: [...variants.values()][0] ?? [] });
  }

  const roots: SeedRoot[] = [];
  for (const path of harnesses.flatMap((harness) => harness.extraRoots ?? [])) {
    const root = join(home, path);
    let stat;
    try {
      stat = statSync(root);
    } catch {
      continue;
    }
    if (!stat.isDirectory()) {
      leftovers.push(note(root, NOTES["not-a-directory"]));
      continue;
    }
    const scan = scanSkill(root);
    forbidden.push(...scan.forbidden);
    leftovers.push(...scan.leftovers);
    roots.push({ path, files: scan.files });
  }

  const settings: SeedSettings[] = [];
  for (const harness of harnesses) {
    if (!harness.settings) continue;
    const carried = readSettings(home, harness.settings, harnesses, forbidden, leftovers);
    if (carried) settings.push({ harness: harness.id, bytes: carried });
  }

  const instructions = readInstructions(home, leftovers);
  if (instructions) forbidden.push(...tokenHits(join(home, INSTRUCTION_FILE), instructions.bytes));

  if (clashes.length > 0 || forbidden.length > 0) {
    return { ok: false, clashes, forbidden };
  }
  return {
    ok: true,
    skills,
    instructions,
    roots,
    settings,
    identity: identify(skills, instructions, roots, settings, harnesses),
    leftovers,
  };
}

type Occurrence = { readonly path: string; readonly inode: string };

function collectOccurrences(
  home: string,
  harnesses: readonly HarnessDescriptor[],
  leftovers: Leftover[],
): Map<string, Occurrence[]> {
  const occurrences = new Map<string, Occurrence[]>();

  for (const harness of harnesses) {
    if (!harness.skillRoot) continue;
    const root = join(home, harness.skillRoot);
    let entries: Dirent[];
    try {
      entries = readdirSync(root, { withFileTypes: true });
    } catch {
      continue;
    }

    for (const entry of entries.sort(byName)) {
      const path = join(root, entry.name);
      let stat;
      try {
        stat = statSync(path);
      } catch {
        leftovers.push(note(path, NOTES["broken-link"]));
        continue;
      }
      if (!stat.isDirectory()) {
        leftovers.push(note(path, NOTES["not-a-directory"]));
        continue;
      }
      if (FERRY_BACKUP_NAME.test(entry.name)) {
        leftovers.push(note(path, NOTES["ferry-backup"]));
        continue;
      }
      const rule = denyRuleFor(entry.name, true);
      if (rule) {
        leftovers.push(note(path, rule));
        continue;
      }
      const found = occurrences.get(entry.name) ?? [];
      found.push({ path, inode: `${stat.dev}:${stat.ino}` });
      occurrences.set(entry.name, found);
    }
  }
  return occurrences;
}

type Scan = { files: SeedFile[]; leftovers: Leftover[]; forbidden: ForbiddenHit[] };

function scanSkill(skillDir: string): Scan {
  const scan: Scan = { files: [], leftovers: [], forbidden: [] };
  walk(skillDir, skillDir, realpathSync(skillDir), new Set(), scan);
  scan.files.sort((a, b) => compare(a.path, b.path));
  return scan;
}

function walk(root: string, dir: string, rootReal: string, seen: Set<string>, scan: Scan): void {
  for (const entry of readdirSync(dir, { withFileTypes: true }).sort(byName)) {
    const path = join(dir, entry.name);

    if (entry.isSymbolicLink()) {
      let target: string;
      try {
        target = realpathSync(path);
      } catch {
        scan.leftovers.push(note(path, NOTES["broken-link"]));
        continue;
      }
      if (target !== rootReal && !target.startsWith(rootReal + sep)) {
        scan.forbidden.push(note(path, DENY_RULES["symlink-escape"]));
        continue;
      }
    }

    const stat = statSync(path);
    const rule = denyRuleFor(entry.name, stat.isDirectory());
    if (rule) {
      if (rule.verdict === "refuse") scan.forbidden.push(note(path, rule));
      else scan.leftovers.push(note(path, rule));
      continue;
    }

    if (stat.isDirectory()) {
      const real = realpathSync(path);
      if (seen.has(real)) continue;
      seen.add(real);
      walk(root, path, rootReal, seen, scan);
      continue;
    }
    if (!stat.isFile()) {
      scan.leftovers.push(note(path, NOTES["not-a-file"]));
      continue;
    }

    const bytes = readFileSync(path);
    // A key renamed to notes.md is still a key. Read the header, not the name.
    if (PRIVATE_KEY_HEADER.test(bytes.subarray(0, 4096).toString("latin1"))) {
      scan.forbidden.push(note(path, DENY_RULES["private-key"]));
      continue;
    }
    const tokens = tokenHits(path, bytes);
    if (tokens.length > 0) {
      scan.forbidden.push(...tokens);
      continue;
    }
    scan.files.push({ path: relative(root, path), bytes });
  }
}

/** Name each token kind found in `bytes`. The hit never holds the token itself. */
function tokenHits(path: string, bytes: Uint8Array): ForbiddenHit[] {
  const text = Buffer.from(bytes).toString("latin1");
  const hits = new Map<string, ForbiddenHit>();
  for (const [pattern, rule] of TOKEN_PATTERNS) {
    if (hits.has(rule.code)) continue;
    for (const match of text.matchAll(pattern)) {
      if (PLACEHOLDER_BODY.test(match[1]!)) continue;
      hits.set(rule.code, note(path, rule));
      break;
    }
  }
  return [...hits.values()];
}

/**
 * Report the first segment of a relative path that a deny rule covers.
 *
 * The registry loader calls this so a harness entry cannot name a path the
 * deny set already refuses. The rules stay here; nothing can widen them.
 */
export function deniedSegment(
  path: string,
  leaf: "directory" | "file",
): (Note & { readonly segment: string }) | null {
  const segments = path.split("/");
  for (const [index, segment] of segments.entries()) {
    const isDirectory = leaf === "directory" || index < segments.length - 1;
    const rule = denyRuleFor(segment, isDirectory);
    if (rule) return { segment, code: rule.code, reason: rule.reason };
  }
  return null;
}

function denyRuleFor(entryName: string, isDirectory: boolean): DenyRule | null {
  // A case-folding filesystem opens Credentials.json under either spelling.
  const name = entryName.toLowerCase();
  if (isDirectory) return CACHE_DIRS.has(name) ? DENY_RULES.cache : null;
  if (name === ".env" || name.startsWith(".env.")) return DENY_RULES.dotenv;
  if (CREDENTIAL_NAMES.has(name)) return DENY_RULES.credentials;
  if (TOKEN_NAMES.has(name)) return DENY_RULES.token;
  if (PRIVATE_KEY_NAMES.has(name)) return DENY_RULES["private-key"];
  if (PRIVATE_KEY_EXTS.some((ext) => name.endsWith(ext))) return DENY_RULES["private-key"];
  if (name === ".ds_store") return DENY_RULES.cache;
  if (DATABASE_EXTS.some((ext) => name.endsWith(ext))) return DENY_RULES.database;
  if (HISTORY_NAMES.has(name)) return DENY_RULES.history;
  if (SETTINGS_NAMES.has(name)) return DENY_RULES.settings;
  return null;
}

/**
 * Read only the listed keys from a JSON settings file. The file itself never
 * leaves the machine. `null` means the file is missing or refused. A hook entry
 * that refers to an unmanaged home path is left out and noted in `leftovers`.
 */
function readSettings(
  home: string,
  settings: { readonly file: string; readonly keys: readonly string[] },
  harnesses: readonly HarnessDescriptor[],
  forbidden: ForbiddenHit[],
  leftovers: Leftover[],
): Uint8Array | null {
  const path = join(home, settings.file);
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch {
    return null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    parsed = null;
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    forbidden.push(note(path, NOTES["invalid-settings"]));
    return null;
  }

  const carried: Record<string, unknown> = {};
  for (const key of settings.keys) {
    if (Object.hasOwn(parsed, key)) carried[key] = (parsed as Record<string, unknown>)[key];
  }
  if (Object.hasOwn(carried, "hooks")) {
    carried.hooks = withoutUnmanagedHooks(path, carried.hooks, home, harnesses, leftovers);
  }
  const bytes = Buffer.from(`${JSON.stringify(carried, null, 2)}\n`);
  // A marketplace or hook can send request headers, and a header can hold a credential.
  if (hasKey(carried, "headers")) {
    forbidden.push(note(path, DENY_RULES["settings-credential"]));
    return null;
  }
  const hits = [...tokenHits(path, bytes), ...hookPathHits(path, carried.hooks, home, harnesses)];
  if (hits.length > 0) {
    forbidden.push(...hits);
    return null;
  }
  return bytes;
}

/**
 * Return `hooks` without the hook entries that refer to unmanaged home paths,
 * and note each entry left out. A matcher group with no hooks left and an event
 * with no groups left are removed too.
 */
function withoutUnmanagedHooks(
  path: string,
  hooks: unknown,
  home: string,
  harnesses: readonly HarnessDescriptor[],
  leftovers: Leftover[],
): unknown {
  if (!isRecord(hooks)) return hooks;
  const kept: Record<string, unknown> = {};
  for (const [event, groups] of Object.entries(hooks)) {
    if (!Array.isArray(groups)) {
      kept[event] = groups;
      continue;
    }
    const keptGroups: unknown[] = [];
    groups.forEach((group, groupIndex) => {
      if (!isRecord(group) || !Array.isArray(group.hooks)) {
        keptGroups.push(group);
        return;
      }
      const entries = group.hooks.filter((entry, entryIndex) => {
        if (!isRecord(entry) || typeof entry.command !== "string") return true;
        const words = unmanagedWords(entry.command, home, harnesses);
        if (words.length === 0) return true;
        const at = `hooks.${event}[${groupIndex}].hooks[${entryIndex}].command`;
        leftovers.push({
          path,
          code: DENY_RULES["hook-path"].code,
          reason: `hook ${at} refers to ${words.join(", ")}, outside the managed set`,
        });
        return false;
      });
      if (entries.length > 0) keptGroups.push({ ...group, hooks: entries });
    });
    if (keptGroups.length > 0) kept[event] = keptGroups;
  }
  return kept;
}

/**
 * Refuse each hook command word that refers to a file the box will not have.
 * `withoutUnmanagedHooks` already left out such entries in the usual shape, so
 * a hit here is a command in a place that shape does not cover.
 */
function hookPathHits(
  path: string,
  hooks: unknown,
  home: string,
  harnesses: readonly HarnessDescriptor[],
): ForbiddenHit[] {
  const hits: ForbiddenHit[] = [];
  for (const { at, command } of hookCommands(hooks, "hooks")) {
    for (const word of unmanagedWords(command, home, harnesses)) {
      hits.push({
        path,
        code: DENY_RULES["hook-path"].code,
        reason: `hook command ${at} refers to ${word}, outside the managed set`,
      });
    }
  }
  return hits;
}

/**
 * The words of a hook command that refer to a file the box will not have.
 *
 * A `~/`, `$HOME/`, or `${HOME}/` word must lead into a managed skill root,
 * extra root, or instruction file. An absolute path under the operator home
 * never passes, because the box home has a different path. Programs on PATH,
 * `$CLAUDE_PROJECT_DIR` paths, and absolute paths outside the home pass.
 */
function unmanagedWords(
  command: string,
  home: string,
  harnesses: readonly HarnessDescriptor[],
): string[] {
  return command.split(COMMAND_SEPARATORS).filter((word) => {
    const relativePath = word.match(HOME_REFERENCE)?.[1];
    return relativePath === undefined
      ? word === home || word.startsWith(`${home}/`)
      : !managedPath(relativePath, harnesses);
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Every string `command` property under `value`, with its JSON location. */
function hookCommands(value: unknown, at: string): { at: string; command: string }[] {
  if (typeof value !== "object" || value === null) return [];
  const found: { at: string; command: string }[] = [];
  for (const [key, child] of Object.entries(value)) {
    const next = Array.isArray(value) ? `${at}[${key}]` : `${at}.${key}`;
    if (key === "command" && typeof child === "string") found.push({ at: next, command: child });
    else found.push(...hookCommands(child, next));
  }
  return found;
}

/** True when a home-relative path is inside a root or file ferry puts on the box. */
function managedPath(path: string, harnesses: readonly HarnessDescriptor[]): boolean {
  const normal = posix.normalize(path);
  const files = [INSTRUCTION_FILE, ...harnesses.flatMap((harness) => harness.instructionFile ?? [])];
  const roots = harnesses.flatMap((harness) => [
    ...(ownsSkills(harness) ? [harness.skillRoot as string] : []),
    ...(harness.extraRoots ?? []),
  ]);
  return files.includes(normal) || roots.some((root) => normal.startsWith(`${root}/`));
}

function hasKey(value: unknown, key: string): boolean {
  if (typeof value !== "object" || value === null) return false;
  if (!Array.isArray(value) && Object.hasOwn(value, key)) return true;
  return Object.values(value).some((child) => hasKey(child, key));
}

function readInstructions(home: string, leftovers: Leftover[]): Instructions | null {
  const path = join(home, INSTRUCTION_FILE);
  let stat;
  try {
    stat = statSync(path);
  } catch {
    return null;
  }
  if (!stat.isFile()) {
    leftovers.push(note(path, NOTES["not-a-file"]));
    return null;
  }
  return { bytes: readFileSync(path) };
}

function note(path: string, of: Note): Note & { readonly path: string } {
  return { path, code: of.code, reason: of.reason };
}

/** Hash of one skill body. Two harnesses that produce the same key hold the same bytes. */
function contentKey(files: readonly SeedFile[]): string {
  const hash = createHash("sha256");
  for (const file of files) hash.update(`${file.path}:${digest(file.bytes)}\n`);
  return hash.digest("hex");
}

function identify(
  skills: readonly SeedSkill[],
  instructions: Instructions | null,
  roots: readonly SeedRoot[],
  settings: readonly SeedSettings[],
  harnesses: readonly HarnessDescriptor[],
): string {
  const hash = createHash("sha256");
  for (const harness of harnesses) {
    hash.update(
      `harness:${harness.id}:${harness.skillRoot ?? "none"}:${harness.instructionFile ?? "none"}:${(harness.extraRoots ?? []).join(",")}\n`,
    );
  }
  for (const skill of skills) hash.update(`skill:${skill.name}:${contentKey(skill.files)}\n`);
  for (const root of roots) hash.update(`root:${root.path}:${contentKey(root.files)}\n`);
  for (const entry of settings) hash.update(`settings:${entry.harness}:${digest(entry.bytes)}\n`);
  hash.update(`instructions:${instructions ? digest(instructions.bytes) : "none"}\n`);
  return hash.digest("hex");
}

function digest(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function byName(a: Dirent, b: Dirent): number {
  return compare(a.name, b.name);
}

function compare(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}
