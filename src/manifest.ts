/**
 * Manifest decides what leaves the operator machine.
 *
 * Callers hand it a source home and get back a seed (skill bodies plus the one
 * instruction file) or a refusal that names every clash and every forbidden
 * hit. Callers never pass a path set in: the managed harness set, the union
 * rule, and the deny set live here.
 */

import { createHash } from "node:crypto";
import { readFileSync, readdirSync, realpathSync, statSync } from "node:fs";
import type { Dirent } from "node:fs";
import { join, relative, sep } from "node:path";

export type HarnessName = "agents" | "claude" | "codex" | "pi" | "cursor";

export type Harness = {
  readonly name: HarnessName;
  /** Skill root, relative to the source home. */
  readonly skillsDir: string;
};

/** Every harness ferry keeps in the same shape. Nothing else is scanned. */
export const MANAGED_HARNESSES: readonly Harness[] = [
  { name: "agents", skillsDir: ".agents/skills" },
  { name: "claude", skillsDir: ".claude/skills" },
  { name: "codex", skillsDir: ".codex/skills" },
  { name: "pi", skillsDir: ".pi/skills" },
  { name: "cursor", skillsDir: ".cursor/skills" },
];

/** The one instruction file, relative to the source home. */
export const INSTRUCTION_FILE = "AGENTS.md";

export type DenyVerdict = "refuse" | "skip";

export type DenyRule = {
  /** Stable code. Refusal output and status quote it. */
  readonly code: string;
  readonly reason: string;
  readonly verdict: DenyVerdict;
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
  history: { code: "history", reason: "session history", verdict: "skip" },
  database: { code: "database", reason: "sqlite or other database file", verdict: "skip" },
  cache: { code: "cache", reason: "cache or build output", verdict: "skip" },
  settings: { code: "settings", reason: "harness settings, out of the v1 snapshot", verdict: "skip" },
} as const satisfies Record<string, DenyRule>;

/** The deny list, for dry-run and status to print. */
export const DENY_LIST: readonly DenyRule[] = Object.values(DENY_RULES);

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

/** A file whose path relative to its skill directory is `path`. */
export type SeedFile = { readonly path: string; readonly bytes: Uint8Array };

export type SeedSkill = {
  readonly name: string;
  /** Every managed harness the name was found in. */
  readonly sources: readonly HarnessName[];
  readonly files: readonly SeedFile[];
};

export type Instructions = { readonly bytes: Uint8Array };

/** Something ferry found and did not import. Init prints these. */
export type Leftover = { readonly path: string; readonly reason: string };

export type Seed = {
  readonly ok: true;
  readonly skills: readonly SeedSkill[];
  readonly instructions: Instructions | null;
  /** Content hash of the whole seed. Changes when any skill or byte changes. */
  readonly identity: string;
  readonly leftovers: readonly Leftover[];
};

/** One skill name found with different bytes in more than one harness. */
export type Clash = { readonly name: string; readonly paths: readonly string[] };

export type ForbiddenHit = {
  readonly path: string;
  readonly code: string;
  readonly reason: string;
};

export type Refusal = {
  readonly ok: false;
  readonly clashes: readonly Clash[];
  readonly forbidden: readonly ForbiddenHit[];
};

/**
 * Read the seed for `home`.
 *
 * Only the managed skill roots and the home instruction file are read. Project
 * skill directories sit outside those roots, so they are never seen.
 */
export function readSeed(home: string): Seed | Refusal {
  const clashes: Clash[] = [];
  const forbidden: ForbiddenHit[] = [];
  const leftovers: Leftover[] = [];
  const occurrences = collectOccurrences(home, leftovers);
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
    skills.push({
      name,
      sources: found.map((o) => o.harness),
      files: [...variants.values()][0] ?? [],
    });
  }

  const instructions = readInstructions(home, leftovers);

  if (clashes.length > 0 || forbidden.length > 0) {
    return { ok: false, clashes, forbidden };
  }
  return { ok: true, skills, instructions, identity: identify(skills, instructions), leftovers };
}

type Occurrence = { readonly harness: HarnessName; readonly path: string; readonly inode: string };

function collectOccurrences(home: string, leftovers: Leftover[]): Map<string, Occurrence[]> {
  const occurrences = new Map<string, Occurrence[]>();

  for (const harness of MANAGED_HARNESSES) {
    const root = join(home, harness.skillsDir);
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
        leftovers.push({ path, reason: "broken symlink" });
        continue;
      }
      if (!stat.isDirectory()) {
        leftovers.push({ path, reason: "not a skill directory" });
        continue;
      }
      const rule = denyRuleFor(entry.name, true);
      if (rule) {
        leftovers.push({ path, reason: rule.reason });
        continue;
      }
      const found = occurrences.get(entry.name) ?? [];
      found.push({ harness: harness.name, path, inode: `${stat.dev}:${stat.ino}` });
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
        scan.leftovers.push({ path, reason: "broken symlink" });
        continue;
      }
      if (target !== rootReal && !target.startsWith(rootReal + sep)) {
        scan.forbidden.push(hit(path, DENY_RULES["symlink-escape"]));
        continue;
      }
    }

    const stat = statSync(path);
    const rule = denyRuleFor(entry.name, stat.isDirectory());
    if (rule) {
      if (rule.verdict === "refuse") scan.forbidden.push(hit(path, rule));
      else scan.leftovers.push({ path, reason: rule.reason });
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
      scan.leftovers.push({ path, reason: "not a regular file" });
      continue;
    }

    const bytes = readFileSync(path);
    // A key renamed to notes.md is still a key. Read the header, not the name.
    if (PRIVATE_KEY_HEADER.test(bytes.subarray(0, 4096).toString("latin1"))) {
      scan.forbidden.push(hit(path, DENY_RULES["private-key"]));
      continue;
    }
    scan.files.push({ path: relative(root, path), bytes });
  }
}

function denyRuleFor(name: string, isDirectory: boolean): DenyRule | null {
  if (isDirectory) return CACHE_DIRS.has(name) ? DENY_RULES.cache : null;
  if (name === ".env" || name.startsWith(".env.")) return DENY_RULES.dotenv;
  if (CREDENTIAL_NAMES.has(name)) return DENY_RULES.credentials;
  if (TOKEN_NAMES.has(name)) return DENY_RULES.token;
  if (PRIVATE_KEY_NAMES.has(name)) return DENY_RULES["private-key"];
  if (PRIVATE_KEY_EXTS.some((ext) => name.endsWith(ext))) return DENY_RULES["private-key"];
  if (name === ".DS_Store") return DENY_RULES.cache;
  if (DATABASE_EXTS.some((ext) => name.endsWith(ext))) return DENY_RULES.database;
  if (HISTORY_NAMES.has(name)) return DENY_RULES.history;
  if (SETTINGS_NAMES.has(name)) return DENY_RULES.settings;
  return null;
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
    leftovers.push({ path, reason: "instruction file is not a regular file" });
    return null;
  }
  return { bytes: readFileSync(path) };
}

function hit(path: string, rule: DenyRule): ForbiddenHit {
  return { path, code: rule.code, reason: rule.reason };
}

/** Hash of one skill body. Two harnesses that produce the same key hold the same bytes. */
function contentKey(files: readonly SeedFile[]): string {
  const hash = createHash("sha256");
  for (const file of files) hash.update(`${file.path}:${digest(file.bytes)}\n`);
  return hash.digest("hex");
}

function identify(skills: readonly SeedSkill[], instructions: Instructions | null): string {
  const hash = createHash("sha256");
  for (const skill of skills) hash.update(`skill:${skill.name}:${contentKey(skill.files)}\n`);
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
