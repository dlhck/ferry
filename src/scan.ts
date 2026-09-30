/**
 * Scan applies the deny rules to files on the machine that has them. A box
 * file that fails a rule must not reach the operator machine, so `ferry adopt
 * --from-box` and `ferry move --from-box` run the hidden command `ferry scan`
 * of the Ferry on the box.
 *
 * A scan gives the plan of a move: file paths, rule codes, rule reasons, and
 * SHA-256 hashes. It never has file content. A reason can name a key, never
 * its value. A hash of a small file is a test for its content, so a scan has
 * a hash only for a file that passes. The same applies to the session id from
 * the first line of a session. A name, a key, or an id with the form of a
 * token is not in the result: see `holdsToken`.
 *
 * A pack copies the files. The source reads each file one time, applies the
 * rules to those bytes, and sends exactly those bytes. So a file that changes
 * after the scan cannot leave the source without a check: the check and the
 * copy use the same bytes. A file with secrets leaves only in a pack, for a
 * path that the operator agreed to carry. The pack is a list of files with
 * their bytes. It has no links and no other kind of entry.
 *
 * The source can be a box with a Ferry that an attacker controls. Then no
 * check on the box is true. The operator machine reads each result against
 * its full form, takes only the files that it asked for, and applies its own
 * rules to the bytes that arrive before it writes them to the destination.
 *
 * Each result has `rules`, the `DENY_RULES_VERSION` of the machine that ran
 * the scan. The operator machine refuses a result with a lower number than its
 * own, because older rules can pass a file that it refuses.
 */

import { createHash } from "node:crypto";
import { chmodSync, lstatSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, relative } from "node:path";
import { BOX_MARKER } from "./box-ferry.ts";
import { FerryError } from "./errors.ts";
import type { Link } from "./link.ts";
import { carriedContentHits, carriedNameHit, DENY_RULES_VERSION, holdsToken, scanSkill, TOKEN_MARK } from "./manifest.ts";
import { sessionContentHits } from "./session-scan.ts";

export type ScanHit = { readonly path: string; readonly code: string; readonly reason: string };

/** Each `root` and each path of `sessions` is relative to the home. The paths of `files` are relative to `root`. */
export type ScanRequest =
  | { readonly kind: "skill"; readonly root: string }
  | { readonly kind: "files"; readonly root: string; readonly paths: readonly string[]; readonly allowSecrets: boolean }
  | { readonly kind: "sessions"; readonly paths: readonly string[]; readonly project: string };

/**
 * A request for the files themselves. `secrets` names the paths with secrets
 * that the operator agreed to carry. Each other path leaves the source only
 * when it passes the rules. A `skill` pack has each file of the skill that
 * passes, or no file when a rule refuses one.
 */
export type PackRequest =
  | { readonly kind: "skill"; readonly root: string }
  | { readonly kind: "files"; readonly root: string; readonly paths: readonly string[]; readonly secrets: readonly string[] }
  | { readonly kind: "sessions"; readonly paths: readonly string[]; readonly secrets: readonly string[]; readonly project: string };

/** The files of a skill directory that pass the rules of a publish. The paths are relative to the directory. */
export type SkillScan = {
  readonly files: readonly { readonly path: string; readonly sha256: string; readonly executable: boolean }[];
  readonly forbidden: readonly ScanHit[];
  readonly skipped: readonly ScanHit[];
};

/**
 * `secrets` holds the kinds of secret in a carried environment file, never the
 * values. `sha256` of a file with secrets is null: only a pack gives it.
 */
export type FilesScan = {
  readonly carry: readonly { readonly path: string; readonly sha256: string | null; readonly secrets: readonly string[] }[];
  readonly refused: readonly ScanHit[];
};

export type SessionsScan = {
  readonly files: readonly {
    readonly path: string;
    /** True when the first line records the project of the request and a session id. */
    readonly session: boolean;
    /** Null for a file with a hit. */
    readonly sha256: string | null;
    /** The session id in the first line of a session. Null when `sha256` is null. */
    readonly id: string | null;
    readonly hits: readonly ScanHit[];
    /** True when a hit refuses the file also with `--allow-secrets`. */
    readonly blocked: boolean;
  }[];
};

type Scans = { skill: SkillScan; files: FilesScan; sessions: SessionsScan };
/** `rules` is the `DENY_RULES_VERSION` of the machine that ran the scan. */
export type ScanOf<Request extends ScanRequest> = Scans[Request["kind"]] & { readonly rules: number };

/**
 * A file of a pack, with the bytes that the rules read. `secrets` holds the
 * kinds of secret in a file that the operator agreed to carry. `id` is the
 * session id of a session whose first line records the project.
 */
export type PackedFile = {
  readonly path: string;
  readonly sha256: string;
  /** The permission bits of the file. */
  readonly mode: number;
  readonly bytes: Uint8Array;
  readonly secrets: readonly string[];
  readonly id: string | null;
};

/** The files of a pack, the hits for the paths that stay on the source, and for a skill the files that a skip rule leaves out. */
export type Pack = { readonly files: readonly PackedFile[]; readonly refused: readonly ScanHit[]; readonly skipped: readonly ScanHit[] };

type PackEntry = { readonly file: PackedFile } | { readonly refused: ScanHit } | { readonly skipped: ScanHit };

/** Content rules that refuse a file also with `allowSecrets`. */
const ALWAYS_REFUSED = new Set(["private-key", "executable"]);
/** A session id that the scan returns: a UUID, as Codex writes it. Other text in its place is not an id. */
const SESSION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SHA256 = /^[0-9a-f]{64}$/;
/** A rule code, and the text of a reason: one line of printable text. */
const CODE = /^[a-z][a-z0-9-]{0,63}$/;
const REASON = /^[^\p{Cc}]{1,400}$/u;
const SCAN_TIMEOUT_MS = 15 * 60_000;
/** The bytes of a file in one data line of a pack. A multiple of 3, so the base64 text of the lines joins. */
const DATA_CHUNK = 3 * 1024 * 1024;
/** Prints `MISSING` when the box has no box install of Ferry. The exit code of Ferry does not fail the command. */
const BOX_SCAN_COMMAND = `if [ -f "$HOME/${BOX_MARKER}" ] && [ -x "$HOME/.local/bin/ferry" ]; then "$HOME/.local/bin/ferry" --json scan; else echo MISSING; fi; true`;
const WHY = "Ferry checks the files with the Ferry on the box before it copies them, so that a file with a secret stays on the box.";
const BUILD = "A development build of Ferry puts no Ferry on a box. Use a release of Ferry.";

/** Run `request` on this machine, whose home is `home`. */
export function runScan<Request extends ScanRequest>(request: Request, home: string): ScanOf<Request>;
export function runScan(request: ScanRequest, home: string): ScanOf<ScanRequest> {
  const rules = DENY_RULES_VERSION;
  if (request.kind === "skill") {
    const { files, forbidden, skipped } = checkSkill(join(home, request.root));
    return { rules, files: files.map((file) => ({ path: file.path, sha256: file.sha256, executable: (file.mode & 0o100) !== 0 })), forbidden, skipped };
  }
  if (request.kind === "files") {
    const carry: FilesScan["carry"][number][] = [];
    const refused: ScanHit[] = [];
    for (const path of request.paths) {
      const checked = checkFile(join(home, request.root), path, request.allowSecrets);
      if ("refused" in checked) refused.push(...checked.refused);
      else carry.push({ path, sha256: checked.secrets.length > 0 ? null : checked.sha256, secrets: checked.secrets });
    }
    return { rules, carry, refused };
  }
  const files = request.paths.map((path) => {
    const { file, session, hits, blocked } = checkSession(home, path, request.project);
    // Only a file that passes gives its hash and its id.
    const passes = file !== null && hits.length === 0;
    return { path, session, sha256: passes ? file.sha256 : null, id: passes ? file.id : null, hits, blocked };
  });
  return { rules, files };
}

/** Run `request` on this machine, whose home is `home`: read each file one time, check those bytes, and return them. */
export function runPack(request: PackRequest, home: string): Pack {
  const entries = [...packEntries(request, home)];
  return {
    files: entries.flatMap((entry) => ("file" in entry ? [entry.file] : [])),
    refused: entries.flatMap((entry) => ("refused" in entry ? [entry.refused] : [])),
    skipped: entries.flatMap((entry) => ("skipped" in entry ? [entry.skipped] : [])),
  };
}

/**
 * The lines that `ferry scan` prints for a pack: a header with the rules
 * version, then for each file one line with its path, hash, size, and mode,
 * and the lines with its bytes as base64, then the refused and skipped paths,
 * and a last line with the number of files. One file is in memory at a time.
 */
export function* packLines(request: PackRequest, home: string): Generator<string> {
  yield JSON.stringify({ pack: 1, rules: DENY_RULES_VERSION });
  let count = 0;
  for (const entry of packEntries(request, home)) {
    if (!("file" in entry)) {
      yield JSON.stringify(entry);
      continue;
    }
    const { bytes, ...file } = entry.file;
    yield JSON.stringify({ file: { ...file, size: bytes.length } });
    for (let start = 0; start < bytes.length; start += DATA_CHUNK) {
      yield JSON.stringify({ data: Buffer.from(bytes.subarray(start, start + DATA_CHUNK)).toString("base64") });
    }
    count++;
  }
  yield JSON.stringify({ end: count });
}

/** The scan request or the pack request in the JSON text `text`. A pack request has `pack: true`. */
export function parseScanRequest(text: string): (ScanRequest & { readonly pack?: false }) | (PackRequest & { readonly pack: true }) {
  const invalid = new FerryError("usage", "ferry scan reads one JSON request on stdin.");
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw invalid;
  }
  if (typeof value !== "object" || value === null) throw invalid;
  const { kind, root, paths, allowSecrets, project, pack, secrets } = value as Record<string, unknown>;
  const strings = (list: unknown) => (Array.isArray(list) && list.every((entry): entry is string => typeof entry === "string") ? list : null);
  const list = strings(paths);
  if (pack === true) {
    const agreed = strings(secrets);
    if (kind === "skill" && typeof root === "string") return { pack, kind, root };
    if (kind === "files" && typeof root === "string" && list && agreed) return { pack, kind, root, paths: list, secrets: agreed };
    if (kind === "sessions" && list && agreed && typeof project === "string") return { pack, kind, paths: list, secrets: agreed, project };
    throw invalid;
  }
  if (kind === "skill" && typeof root === "string") return { kind, root };
  if (kind === "files" && typeof root === "string" && list) return { kind, root, paths: list, allowSecrets: allowSecrets === true };
  if (kind === "sessions" && list && typeof project === "string") return { kind, paths: list, project };
  throw invalid;
}

/**
 * Run `request` with the Ferry on the box. `label` names the box in an error.
 * Ferry refuses when the box has no Ferry, a Ferry without `ferry scan`, or a
 * Ferry with older deny rules. It never copies a file to check it on this
 * machine.
 */
export async function scanOnBox<Request extends ScanRequest>(
  link: Pick<Link, "run">,
  label: string,
  request: Request,
): Promise<ScanOf<Request>> {
  const stdout = await runOnBox(link, label, request);
  const envelope = parseJson(stdout);
  if (!isRecord(envelope) || envelope.ok !== true || !isRecord(envelope.result)) throw boxFailure(envelope, label);
  requireRules(envelope.result.rules, label);
  const scan = readScan(request, envelope.result);
  if (scan === null) throw unreadable(label);
  return { rules: envelope.result.rules, ...scan } as unknown as ScanOf<Request>;
}

/**
 * Run the pack `request` with the Ferry on the box, and read the files. Ferry
 * refuses the whole pack when a line is not in the form of `packLines`, when
 * a file is not one of the request, when a path leaves its root, or when the
 * bytes do not have the size and the SHA-256 of their line.
 */
export async function packOnBox(link: Pick<Link, "run">, label: string, request: PackRequest): Promise<Pack> {
  const stdout = await runOnBox(link, label, { ...request, pack: true });
  const lines = stdout.split("\n").filter((line) => line !== "");
  const header = parseJson(lines[0] ?? "");
  // A Ferry without the pack answers with the result of a scan, or with an error.
  if (!isRecord(header) || header.pack !== 1) {
    if (isRecord(header) && header.ok === true && isRecord(header.result)) requireRules(header.result.rules, label);
    throw boxFailure(header, label);
  }
  requireRules(header.rules, label);

  const asked = request.kind === "skill" ? null : new Set(request.paths);
  const agreed = new Set(request.kind === "skill" ? [] : request.secrets);
  const files: PackedFile[] = [];
  const refused: ScanHit[] = [];
  const skipped: ScanHit[] = [];
  const seen = new Set<string>();
  let ended = false;
  for (let index = 1; index < lines.length; index++) {
    const line = parseJson(lines[index]!);
    if (ended || !isRecord(line)) throw unreadable(label);
    if (typeof line.end === "number") {
      if (line.end !== files.length) throw unreadable(label);
      ended = true;
    } else if (isHit(line.refused)) refused.push(line.refused);
    else if (isHit(line.skipped)) skipped.push(line.skipped);
    else if (isRecord(line.file)) {
      const { path, sha256: hash, size, mode, secrets, id } = line.file;
      const valid =
        typeof path === "string" &&
        isInside(path) &&
        !holdsToken(path) &&
        (asked === null || asked.has(path)) &&
        !seen.has(path) &&
        typeof hash === "string" &&
        SHA256.test(hash) &&
        typeof size === "number" &&
        Number.isInteger(size) &&
        size >= 0 &&
        typeof mode === "number" &&
        Number.isInteger(mode) &&
        mode >= 0 &&
        mode <= 0o777 &&
        isReasons(secrets) &&
        // Only a path that the operator agreed to can come with secrets.
        (secrets.length === 0 || agreed.has(path)) &&
        (id === null || (typeof id === "string" && SESSION_ID.test(id)));
      if (!valid) throw unreadable(label);
      const chunks: Buffer[] = [];
      for (let length = 0; length < size; length += chunks.at(-1)!.length) {
        const data = parseJson(lines[++index] ?? "");
        if (!isRecord(data) || typeof data.data !== "string" || data.data === "") throw unreadable(label);
        chunks.push(Buffer.from(data.data, "base64"));
      }
      const bytes = Buffer.concat(chunks);
      if (bytes.length !== size || sha256(bytes) !== hash) throw unreadable(label);
      seen.add(path);
      files.push({ path, sha256: hash, mode, bytes, secrets, id });
    } else throw unreadable(label);
  }
  if (!ended) throw unreadable(label);
  return { files, refused, skipped };
}

/** Write the files of a pack under `directory`, each one as a regular file with its mode. */
export function writePack(directory: string, files: readonly PackedFile[]): void {
  for (const file of files) {
    const path = join(directory, file.path);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, file.bytes);
    chmodSync(path, file.mode);
  }
}

/**
 * The hits of the rules of this machine for the files of a pack from a box,
 * after `writePack` wrote them under `directory`. A file with `secrets` is one
 * that the operator agreed to carry, so only a rule that refuses it also with
 * `--allow-secrets` is a hit. For a pack of sessions, `project` is the
 * project of the request.
 */
export function recheckPack(directory: string, files: readonly PackedFile[], project?: string): ScanHit[] {
  return files.flatMap((file) => {
    const agreed = file.secrets.length > 0;
    if (project === undefined) {
      const checked = checkFile(directory, file.path, agreed);
      return "refused" in checked ? checked.refused : [];
    }
    const { hits, blocked } = checkSession(directory, file.path, project);
    return agreed && !blocked ? [] : hits;
  });
}

/**
 * The hit for a path with a token in a name, or with `TOKEN_MARK` from the
 * listing of a box in the place of one. It names the directories before that
 * name, never the name. Null for a path that Ferry prints.
 */
export function tokenNameHit(path: string): ScanHit | null {
  const marked = (name: string) => holdsToken(name) || name.includes(TOKEN_MARK);
  if (!marked(path)) return null;
  const names = path.split("/");
  const parent = names.slice(0, Math.max(0, names.findIndex(marked))).join("/") || ".";
  return { path: parent, code: "token-name", reason: `a file or directory in ${parent} has a token in its name` };
}

/** True for a path of a result that stays inside its root. */
export function isInside(path: string): boolean {
  return path !== "" && !isAbsolute(path) && !path.split("/").includes("..");
}

/** Read each file of the request one time, and give the file with those bytes or the hits that keep it on this machine. */
function* packEntries(request: PackRequest, home: string): Generator<PackEntry> {
  if (request.kind === "skill") {
    const { files, forbidden, skipped } = checkSkill(join(home, request.root));
    for (const hit of forbidden) yield { refused: hit };
    for (const hit of skipped) yield { skipped: hit };
    // A rule refuses a file of the skill, so no file of the skill leaves.
    if (forbidden.length === 0) for (const file of files) yield { file };
    return;
  }
  const agreed = new Set(request.secrets);
  for (const path of request.paths) {
    if (request.kind === "files") {
      const checked = checkFile(join(home, request.root), path, agreed.has(path));
      if ("refused" in checked) for (const hit of checked.refused) yield { refused: hit };
      else yield { file: checked };
      continue;
    }
    const { file, hits, blocked } = checkSession(home, path, request.project);
    if (file !== null && (hits.length === 0 || (agreed.has(path) && !blocked))) {
      yield { file: { ...file, secrets: [...new Set(hits.map((hit) => hit.reason))] } };
    } else for (const hit of hits) yield { refused: hit };
  }
}

/** The files of a skill directory that pass the rules of a publish, with their bytes, and the hits. */
function checkSkill(directory: string): { files: PackedFile[]; forbidden: ScanHit[]; skipped: ScanHit[] } {
  const scan = scanSkill(directory);
  const named = new Map<string, ScanHit>();
  /** The path relative to the skill, or null after a hit for a name with a token. */
  const shown = (path: string): string | null => {
    const hit = tokenNameHit(path);
    if (hit) named.set(hit.path, hit);
    return hit ? null : path;
  };
  const hits = (found: readonly ScanHit[]) =>
    found.flatMap((hit) => {
      const path = shown(relative(directory, hit.path));
      return path === null ? [] : [{ path, code: hit.code, reason: hit.reason }];
    });
  const files = scan.files.flatMap((file) =>
    shown(file.path) === null
      ? []
      : [{ path: file.path, sha256: sha256(file.bytes), mode: file.executable ? 0o755 : 0o644, bytes: file.bytes, secrets: [], id: null }],
  );
  const forbidden = hits(scan.forbidden);
  const skipped = hits(scan.leftovers);
  return { files, forbidden: [...forbidden, ...named.values()], skipped };
}

/**
 * Read the file `path` under `root` one time and apply the content rules of a
 * move to those bytes. With `allowSecrets`, an environment file that fails
 * only the token or secret-field rules passes, and `secrets` names the kinds
 * of secret.
 */
function checkFile(root: string, path: string, allowSecrets: boolean): PackedFile | { refused: ScanHit[] } {
  const named = tokenNameHit(path);
  if (named) return { refused: [named] };
  const full = join(root, path);
  let stat;
  try {
    stat = lstatSync(full);
  } catch {
    return { refused: [{ path, code: "missing", reason: "file changed during the preflight" }] };
  }
  if (stat.isSymbolicLink()) return { refused: [{ path, code: "symlink", reason: "symbolic link" }] };
  if (!stat.isFile()) return { refused: [{ path, code: "not-a-file", reason: "not a regular file" }] };
  const bytes = readFileSync(full);
  const file = { path, sha256: sha256(bytes), mode: stat.mode & 0o777, bytes, id: null };
  const hits = carriedContentHits(path, bytes);
  if (hits.length === 0) return { ...file, secrets: [] };
  if (!allowSecrets || carriedNameHit(path)?.code !== "dotenv") return { refused: hits };
  const all = [...hits, ...envLineHits(path, bytes)];
  const kept = all.find((hit) => ALWAYS_REFUSED.has(hit.code));
  return kept ? { refused: [kept] } : { ...file, secrets: [...new Set(all.map((hit) => hit.reason))] };
}

/**
 * The content hits of each line of an environment file. `carriedContentHits`
 * reports only the first content rule that finds a secret in the file, so
 * Ferry checks each line alone to name all kinds of secret.
 */
function envLineHits(path: string, bytes: Uint8Array): ScanHit[] {
  return Buffer.from(bytes)
    .toString("utf8")
    .split("\n")
    .flatMap((line) => carriedContentHits(path, Buffer.from(line)));
}

/**
 * Read the session or memory file `path` under `home` one time, and apply the
 * name rules, the content rules, and the session scan to those bytes. `file`
 * is null when the file is not there or its name has a token.
 */
function checkSession(
  home: string,
  path: string,
  project: string,
): { file: PackedFile | null; session: boolean; hits: ScanHit[]; blocked: boolean } {
  // The list of the session store names the file, so it counts as a session of the project.
  const named = tokenNameHit(path);
  if (named) return { file: null, session: true, hits: [named], blocked: true };
  let bytes: Buffer;
  let mode: number;
  try {
    bytes = readFileSync(join(home, path));
    mode = lstatSync(join(home, path)).mode & 0o777;
  } catch {
    return { file: null, session: false, hits: [{ path, code: "missing", reason: "file changed during the preflight" }], blocked: true };
  }
  const nameHit = carriedNameHit(path);
  const content = nameHit ? [] : carriedContentHits(path, bytes);
  // The session scan finds a token in the file bytes again. One hit for each rule is enough.
  const session = nameHit ? [] : sessionContentHits(path, bytes).filter((hit) => !content.some((found) => found.code === hit.code && found.reason === hit.reason));
  const hits = nameHit ? [nameHit] : [...content, ...session];
  const id = sessionId(bytes, project);
  // A name rule, a private key, or an executable refuses the file also with allowSecrets.
  const blocked = nameHit !== null || hits.some((hit) => ALWAYS_REFUSED.has(hit.code));
  return { file: { path, sha256: sha256(bytes), mode, bytes, secrets: [], id }, session: id !== null, hits, blocked };
}

/** The `payload.id` of the first line, when the line records `project` as `payload.cwd`. */
function sessionId(bytes: Buffer, project: string): string | null {
  const end = bytes.indexOf("\n");
  try {
    const meta = JSON.parse(bytes.subarray(0, end === -1 ? bytes.length : end).toString("utf8")) as {
      payload?: { cwd?: unknown; id?: unknown };
    };
    const id = meta?.payload?.id;
    return meta?.payload?.cwd === project && typeof id === "string" && SESSION_ID.test(id) ? id : null;
  } catch {
    return null;
  }
}

/** Run `ferry scan` of the box install with `request` on stdin, and return its stdout. */
async function runOnBox(link: Pick<Link, "run">, label: string, request: object): Promise<string> {
  const result = await link.run(BOX_SCAN_COMMAND, {
    input: new TextEncoder().encode(JSON.stringify(request)),
    timeoutMs: SCAN_TIMEOUT_MS,
  });
  if (!result.ok) throw new FerryError("box-command-failed", `Ferry could not check the files on ${label}: ${result.error.message}`);
  if (result.stdout.trim() === "MISSING") {
    throw new FerryError("refused", `Ferry is not installed on ${label}. ${WHY}`, { hint: `Run ferry install. ${BUILD}` });
  }
  return result.stdout;
}

/** The error for an answer of the box that is not a result: an error of the scan, or the text of a Ferry without the command. */
function boxFailure(envelope: unknown, label: string): FerryError {
  if (isRecord(envelope) && envelope.ok === false && isRecord(envelope.error) && envelope.error.code !== "usage") {
    // The text is from the box and can name a file there.
    const text = String(envelope.error.message);
    const shown = holdsToken(text) ? ". Ferry does not show the error text of the box, because it has the form of a token." : `: ${text}`;
    return new FerryError("box-command-failed", `Ferry could not check the files on ${label}${shown}`);
  }
  // An old Ferry prints its help, a usage error, or the result of a scan for a pack request.
  return new FerryError("refused", `The Ferry on ${label} is too old to check the files there. ${WHY}`, { hint: `Run ferry update. ${BUILD}` });
}

/** Refuse a result whose rules version is lower than the version of this machine. A result without the number is from a Ferry before the number. */
function requireRules(rules: unknown, label: string): void {
  if (typeof rules === "number" && rules >= DENY_RULES_VERSION) return;
  throw new FerryError(
    "refused",
    `The Ferry on ${label} has older deny rules than this machine, so its check can pass a file that this machine refuses. Ferry copied no file.`,
    { hint: `Run ferry update to put the Ferry of this machine on ${label}.` },
  );
}

function unreadable(label: string): FerryError {
  return new FerryError("box-command-failed", `The Ferry on ${label} gave an answer that this Ferry cannot read. Ferry took no file from it.`, {
    hint: `Run ferry update to put the Ferry of this machine on ${label}.`,
  });
}

/**
 * The result of `request` in `value`, or null when `value` does not have the
 * full form of that result: each field has its type, each path is one of the
 * request or stays in its root, and no text has the form of a token.
 */
function readScan(request: ScanRequest, value: Record<string, unknown>): Scans[ScanRequest["kind"]] | null {
  const hash = (text: unknown): text is string => typeof text === "string" && SHA256.test(text);
  if (request.kind === "skill") {
    const { files, forbidden, skipped } = value;
    const valid =
      isList(files, (file) => isRecord(file) && isPath(file.path) && isInside(file.path) && hash(file.sha256) && typeof file.executable === "boolean") &&
      isList(forbidden, isHit) &&
      isList(skipped, isHit);
    return valid ? ({ files, forbidden, skipped } as SkillScan) : null;
  }
  const asked = new Set(request.paths);
  const seen = new Set<string>();
  const once = (path: unknown): path is string => isPath(path) && asked.has(path) && !seen.has(path) && seen.add(path) !== undefined;
  if (request.kind === "files") {
    const { carry, refused } = value;
    const valid =
      isList(carry, (file) => isRecord(file) && once(file.path) && (file.sha256 === null || hash(file.sha256)) && isReasons(file.secrets)) &&
      isList(refused, isHit);
    return valid ? ({ carry, refused } as FilesScan) : null;
  }
  const { files } = value;
  const valid = isList(
    files,
    (file) =>
      isRecord(file) &&
      once(file.path) &&
      typeof file.session === "boolean" &&
      (file.sha256 === null || hash(file.sha256)) &&
      (file.id === null || (typeof file.id === "string" && SESSION_ID.test(file.id))) &&
      isList(file.hits, isHit) &&
      typeof file.blocked === "boolean",
  );
  return valid ? ({ files } as SessionsScan) : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isList(value: unknown, item: (entry: unknown) => boolean): value is unknown[] {
  return Array.isArray(value) && value.every(item);
}

function isPath(value: unknown): value is string {
  return typeof value === "string" && value !== "" && !value.includes("\0") && !holdsToken(value);
}

function isReason(value: unknown): value is string {
  return typeof value === "string" && REASON.test(value) && !holdsToken(value);
}

function isReasons(value: unknown): value is string[] {
  return isList(value, isReason);
}

function isHit(value: unknown): value is ScanHit {
  return isRecord(value) && isPath(value.path) && typeof value.code === "string" && CODE.test(value.code) && isReason(value.reason);
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}
