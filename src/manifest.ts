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
/** The skills of the local store checkout, relative to the source home. */
const STORE_SKILLS = ".ferry/store/skills";

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
  "mcp-credential": {
    code: "mcp-credential",
    reason: "remote MCP server declaration with headers, environment values, arguments, or a credential",
    verdict: "refuse",
  },
  "mcp-name": {
    code: "mcp-name",
    reason: "MCP server name with characters other than letters, digits, dot, underscore, and hyphen",
    verdict: "refuse",
  },
  "secret-field": {
    code: "secret-field",
    reason: "password or secret key with a value in a JSON, YAML, or TOML file",
    verdict: "refuse",
  },
  executable: {
    code: "executable",
    reason: "executable binary (ELF, Mach-O, or PE)",
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
  "mcp-local": {
    code: "mcp-local",
    reason: "local or non-HTTPS MCP server; only remote HTTPS servers are carried",
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
/**
 * Codex writes its bundled skills to this entry of its skill root and rewrites
 * them when it updates. Each machine gets its own copy from Codex, so Ferry
 * does not read, carry, or link this entry in any skill root.
 */
export const CODEX_SYSTEM_SKILLS = ".system";
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
/**
 * Config keys that hold a password or secret. Ferry compares each key in lower
 * case with `-` and `_` removed, so `clientSecret` and `client-secret` match too.
 */
const SECRET_KEYS = new Set(["password", "passwd", "secret", "clientsecret", "privatekey", "apikey"]);
const CONFIG_EXTS = { ".json": "json", ".yaml": "yaml", ".yml": "yaml", ".toml": "toml" } as const;
/**
 * A `key: value` or `key = value` line, for a config file that does not parse.
 * Group 1 is the key, group 2 the value. The match does not see a key in a
 * flow mapping such as `{ password: value }`, or a value on the next line.
 */
const CONFIG_LINE = /^\s*(?:-\s+)?["']?([\w-]+)["']?\s*[:=]\s*(.*)$/;
/** Mach-O magic numbers, thin and universal, as the first four bytes of the file. */
const MACHO_MAGICS = new Set(["feedface", "feedfacf", "cefaedfe", "cffaedfe", "cafebabe", "cafebabf"]);
/** A carried MCP server name reaches remote shell commands, so it may hold only these characters. */
const MCP_SERVER_NAME = /^[A-Za-z0-9._-]+$/;
/** Declaration keys that send headers or start a process. A remote server carries none of them. */
const MCP_CREDENTIAL_KEYS = [
  "headers",
  "headersHelper",
  "http_headers",
  "env_http_headers",
  "http_headers_helper",
  "bearer_token_env_var",
  "env",
  "env_vars",
  "args",
];
const SECRET_PARAMETER = /token|secret|credential|password|api.?key/i;
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

/** One remote MCP server. Ferry carries nothing else from a declaration. */
export type McpServer = { readonly name: string; readonly type: "http" | "sse"; readonly url: string };

/** The remote MCP servers one harness declares. `harness` is the harness id. */
export type SeedMcp = { readonly harness: string; readonly servers: readonly McpServer[] };

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
  /** The remote MCP servers of each harness that declares at least one. */
  readonly mcp: readonly SeedMcp[];
  /** Content hash of the whole seed. Changes when any skill or byte changes. */
  readonly identity: string;
  readonly leftovers: readonly Leftover[];
  /** Skills that one harness root has as a newer real directory. Empty unless the caller asks. */
  readonly storeUpdates: readonly StoreUpdate[];
};

/**
 * One skill whose store copy the seed replaces with the real directory at
 * `path`. Only Sync asks for these, because only Sync checks that the store
 * copy has no unpublished changes before it publishes.
 */
export type StoreUpdate = { readonly name: string; readonly path: string };

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
 *
 * With `storeUpdates`, a skill is not a clash when exactly one directory is a
 * real directory in a harness root and every other root reaches the store copy
 * in `.ferry/store/skills`. The seed then carries the real directory and names
 * it in `storeUpdates`.
 */
export function readSeed(
  home: string,
  harnesses: readonly HarnessDescriptor[],
  options: { readonly storeUpdates?: boolean } = {},
): Seed | Refusal {
  const clashes: Clash[] = [];
  const storeUpdates: StoreUpdate[] = [];
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
    const byInode = new Map<string, SeedFile[]>();
    for (const occurrence of distinct.values()) {
      const scan = scanSkill(occurrence.path);
      forbidden.push(...scan.forbidden);
      leftovers.push(...scan.leftovers);
      byInode.set(occurrence.inode, scan.files);
      const key = contentKey(scan.files);
      if (!variants.has(key)) variants.set(key, scan.files);
    }

    if (variants.size > 1) {
      const update = options.storeUpdates ? storeUpdateSource(home, name, found) : null;
      if (!update) {
        clashes.push({ name, paths: found.map((o) => o.path).sort(compare) });
        continue;
      }
      storeUpdates.push({ name, path: update.path });
      skills.push({ name, files: byInode.get(update.inode) ?? [] });
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

  const mcp: SeedMcp[] = [];
  for (const harness of harnesses) {
    if (!harness.mcp) continue;
    const servers = readMcp(home, harness.mcp, forbidden, leftovers);
    if (servers.length > 0) mcp.push({ harness: harness.id, servers });
  }

  const instructions = readInstructions(home, leftovers);
  if (instructions) forbidden.push(...contentHits(join(home, INSTRUCTION_FILE), instructions.bytes));

  if (clashes.length > 0 || forbidden.length > 0) {
    return { ok: false, clashes, forbidden };
  }
  return {
    ok: true,
    skills,
    instructions,
    roots,
    settings,
    mcp,
    identity: identify(skills, instructions, roots, settings, mcp, harnesses),
    leftovers,
    storeUpdates,
  };
}

/** `link` is true when the root entry itself is a symlink. */
type Occurrence = { readonly path: string; readonly inode: string; readonly link: boolean };

/**
 * The one real directory that may replace the store copy of `name`, or `null`.
 * Every occurrence must be that directory or reach the store copy. A link to the
 * real directory is not allowed, because that root does not link into the store.
 */
function storeUpdateSource(home: string, name: string, found: readonly Occurrence[]): Occurrence | null {
  let stat;
  try {
    stat = statSync(join(home, STORE_SKILLS, name));
  } catch {
    return null;
  }
  const storeInode = `${stat.dev}:${stat.ino}`;
  const local = found.filter((occurrence) => occurrence.inode !== storeInode);
  const source = local[0];
  if (!source || local.some((occurrence) => occurrence.link || occurrence.inode !== source.inode)) {
    return null;
  }
  return source;
}

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
      if (entry.name === CODEX_SYSTEM_SKILLS) continue;
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
      found.push({ path, inode: `${stat.dev}:${stat.ino}`, link: entry.isSymbolicLink() });
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
    const hits = contentHits(path, bytes);
    if (hits.length > 0) {
      scan.forbidden.push(...hits);
      continue;
    }
    scan.files.push({ path: relative(root, path), bytes });
  }
}

/** The forbidden hits of one file in a managed root, found from its bytes. */
function contentHits(path: string, bytes: Uint8Array): ForbiddenHit[] {
  if (isExecutable(bytes)) return [note(path, DENY_RULES.executable)];
  return [...tokenHits(path, bytes), ...secretFieldHits(path, bytes)];
}

/**
 * True when `bytes` start with an ELF, Mach-O, or PE header. A script with a
 * shebang is text and passes. `cafebabe` also starts a Java class file. A
 * universal Mach-O has its architecture count after the magic, and a class
 * file has its version there, which is 45 or more. Ferry refuses only the
 * universal Mach-O. A PE file needs the `PE\0\0` signature at the offset in
 * its MS-DOS header, so a text file that starts with `MZ` passes.
 */
function isExecutable(bytes: Uint8Array): boolean {
  const buffer = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (buffer.length < 8) return false;
  const magic = buffer.subarray(0, 4).toString("hex");
  if (magic === "7f454c46") return true;
  if (MACHO_MAGICS.has(magic)) return !magic.startsWith("cafeba") || buffer.readUInt32BE(4) < 45;
  if (buffer.subarray(0, 2).toString("latin1") !== "MZ" || buffer.length < 0x40) return false;
  const offset = buffer.readUInt32LE(0x3c);
  return buffer.subarray(offset, offset + 4).toString("latin1") === "PE\0\0";
}

/**
 * Name each secret key with a value in a JSON, YAML, or TOML file. The hit
 * names the key, never the value. An empty value and a placeholder value pass.
 * A file that does not parse is matched line by line with `CONFIG_LINE`.
 */
function secretFieldHits(path: string, bytes: Uint8Array): ForbiddenHit[] {
  const ext = Object.keys(CONFIG_EXTS).find((candidate) => path.toLowerCase().endsWith(candidate));
  if (!ext) return [];
  const text = Buffer.from(bytes).toString("utf8");
  const format = CONFIG_EXTS[ext as keyof typeof CONFIG_EXTS];
  let keys: string[];
  try {
    const parsed: unknown =
      format === "json" ? JSON.parse(text) : format === "yaml" ? Bun.YAML.parse(text) : Bun.TOML.parse(text);
    keys = secretKeys(parsed);
  } catch {
    keys = secretLineKeys(text);
  }
  return secretKeyHits(path, keys);
}

/** The secret keys with a value in the `key: value` or `key = value` lines of `text`. */
function secretLineKeys(text: string): string[] {
  return text.split("\n").flatMap((line) => {
    const match = line.match(CONFIG_LINE);
    if (!match || !isSecretKey(match[1]!)) return [];
    const value = match[2]!.trim().replace(/,$/, "").replace(/^(["'])(.*)\1$/, "$2");
    return isSecretValue(value) ? [match[1]!] : [];
  });
}

function secretKeyHits(path: string, keys: readonly string[]): ForbiddenHit[] {
  return [...new Set(keys)].map((key) => ({
    path,
    code: DENY_RULES["secret-field"].code,
    reason: `key ${key} holds a password or secret`,
  }));
}

/** Every secret key under `value`, at any depth, whose value is a secret string. */
function secretKeys(value: unknown): string[] {
  if (typeof value !== "object" || value === null) return [];
  return Object.entries(value).flatMap(([key, child]) =>
    !Array.isArray(value) && isSecretKey(key) && typeof child === "string" && isSecretValue(child)
      ? [key]
      : secretKeys(child),
  );
}

function isSecretKey(key: string): boolean {
  return SECRET_KEYS.has(key.toLowerCase().replace(/[-_]/g, ""));
}

/** A non-empty string that is not a placeholder by the token placeholder rule. */
function isSecretValue(value: string): boolean {
  return value !== "" && !PLACEHOLDER_BODY.test(value);
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
 * The refusal of a file outside a managed root, such as a local-only project
 * file, from its name alone. Only rules that refuse apply. With `allowEnv`,
 * an environment file passes this check and `carriedContentHits` checks it.
 */
export function carriedNameHit(
  path: string,
  options: { readonly allowEnv?: boolean } = {},
): ForbiddenHit | null {
  const rule = denyRuleFor(posix.basename(path), false);
  if (!rule || rule.verdict !== "refuse") return null;
  if (options.allowEnv && rule === DENY_RULES.dotenv) return null;
  return note(path, rule);
}

/**
 * The refusals of a file outside a managed root, from its bytes: a private key
 * header, then the rules of `contentHits`. An environment file also gets the
 * secret-field rule, line by line.
 */
export function carriedContentHits(path: string, bytes: Uint8Array): ForbiddenHit[] {
  if (PRIVATE_KEY_HEADER.test(Buffer.from(bytes.subarray(0, 4096)).toString("latin1"))) {
    return [note(path, DENY_RULES["private-key"])];
  }
  const hits = contentHits(path, bytes);
  if (hits.length > 0 || denyRuleFor(posix.basename(path), false) !== DENY_RULES.dotenv) return hits;
  return secretKeyHits(path, secretLineKeys(Buffer.from(bytes).toString("utf8")));
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
 * Read the remote MCP servers from the declared key of an MCP file. The file
 * never leaves the machine, and a server keeps only its name, type, and URL.
 * A local or non-HTTPS server is noted in `leftovers`. A remote server with
 * headers, environment values, arguments, or a credential refuses the seed.
 */
function readMcp(
  home: string,
  mcp: NonNullable<HarnessDescriptor["mcp"]>,
  forbidden: ForbiddenHit[],
  leftovers: Leftover[],
): McpServer[] {
  const path = join(home, mcp.file);
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch {
    return [];
  }
  let parsed: unknown;
  try {
    parsed = mcp.format === "toml" ? Bun.TOML.parse(text) : JSON.parse(text);
  } catch {
    parsed = null;
  }
  if (!isRecord(parsed)) {
    forbidden.push(note(path, NOTES["invalid-settings"]));
    return [];
  }

  const servers: McpServer[] = [];
  const declared = parsed[mcp.key];
  const entries = isRecord(declared) ? Object.entries(declared) : [];
  for (const [name, declaration] of entries.sort(([a], [b]) => compare(a, b))) {
    const remote = isRecord(declaration) ? remoteServer(declaration) : null;
    if (!remote) {
      leftovers.push({
        path,
        code: DENY_RULES["mcp-local"].code,
        reason: `MCP server ${name} is not a remote HTTPS server`,
      });
      continue;
    }
    if (!MCP_SERVER_NAME.test(name)) {
      forbidden.push({
        path,
        code: DENY_RULES["mcp-name"].code,
        reason: "an MCP server name has characters other than letters, digits, dot, underscore, and hyphen",
      });
      continue;
    }
    const url = new URL(remote.url);
    const credential =
      MCP_CREDENTIAL_KEYS.some((key) => hasKey(declaration, key)) ||
      url.username !== "" ||
      url.password !== "" ||
      [...url.searchParams.keys()].some((key) => SECRET_PARAMETER.test(key)) ||
      tokenHits(path, Buffer.from(JSON.stringify(declaration))).length > 0;
    if (credential) {
      forbidden.push({
        path,
        code: DENY_RULES["mcp-credential"].code,
        reason: `MCP server ${name} has headers, environment values, arguments, or a credential`,
      });
      continue;
    }
    servers.push({ name, ...remote });
  }
  return servers;
}

/** The type and URL of a declaration with an HTTPS URL and an HTTP or SSE transport, else `null`. */
function remoteServer(declaration: Record<string, unknown>): Omit<McpServer, "name"> | null {
  const { type, url } = declaration;
  if (type !== undefined && type !== "http" && type !== "sse" && type !== "streamable_http") {
    return null;
  }
  if (typeof url !== "string" || !URL.canParse(url) || new URL(url).protocol !== "https:") {
    return null;
  }
  return { type: type === "sse" ? "sse" : "http", url };
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
  mcp: readonly SeedMcp[],
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
  for (const entry of mcp) hash.update(`mcp:${entry.harness}:${JSON.stringify(entry.servers)}\n`);
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
