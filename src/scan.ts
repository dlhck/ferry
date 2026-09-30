/**
 * Scan applies the deny rules to files on the machine that has them. A box
 * file that fails a rule must not reach the operator machine, so `ferry adopt
 * --from-box` and `ferry move --from-box` run the hidden command `ferry scan`
 * of the Ferry on the box, and then copy only the files that pass.
 *
 * The result has file paths, rule codes, rule reasons, and SHA-256 hashes. It
 * never has file content. A reason can name a key, never its value. The
 * operator machine compares the hash of each file that arrives with the hash
 * of the scan, so the check applies to the bytes that it gets.
 *
 * A hash of a small file is a test for its content, so the result has a hash
 * only for a file that leaves the machine: a file that passes, and with
 * `confirmed` a file with secrets that the operator agreed to carry. The same
 * applies to the session id from the first line of a session. A name, a key,
 * or an id with the form of a token is not in the result: see `holdsToken`.
 *
 * Each result has `rules`, the `DENY_RULES_VERSION` of the machine that ran
 * the scan. The operator machine refuses a result with a lower number than its
 * own, because older rules can pass a file that it refuses.
 */

import { createHash } from "node:crypto";
import { lstatSync, readFileSync } from "node:fs";
import { isAbsolute, join, relative } from "node:path";
import { BOX_MARKER } from "./box-ferry.ts";
import { FerryError } from "./errors.ts";
import type { Link } from "./link.ts";
import { carriedContentHits, carriedNameHit, DENY_RULES_VERSION, holdsToken, scanSkill, TOKEN_MARK } from "./manifest.ts";
import { sessionContentHits } from "./session-scan.ts";

export type ScanHit = { readonly path: string; readonly code: string; readonly reason: string };

/**
 * Each `root` and each path of `sessions` is relative to the home. The paths
 * of `files` are relative to `root`. `confirmed` is true after the operator
 * agreed to carry the files with secrets. Only then the result has their
 * hashes and session ids.
 */
export type ScanRequest =
  | { readonly kind: "skill"; readonly root: string }
  | {
      readonly kind: "files";
      readonly root: string;
      readonly paths: readonly string[];
      readonly allowSecrets: boolean;
      readonly confirmed: boolean;
    }
  | { readonly kind: "sessions"; readonly paths: readonly string[]; readonly project: string; readonly confirmed: boolean };

/** The files of a skill directory that pass the rules of a publish. The paths are relative to the directory. */
export type SkillScan = {
  readonly files: readonly { readonly path: string; readonly sha256: string; readonly executable: boolean }[];
  readonly forbidden: readonly ScanHit[];
  readonly skipped: readonly ScanHit[];
};

/**
 * `secrets` holds the kinds of secret in a carried environment file, never the
 * values. `sha256` of a file with secrets is null in a scan that is not confirmed.
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
    /** Null for a file with a hit, unless the scan is confirmed and the file is not blocked. */
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

/** Content rules that refuse a file also with `allowSecrets`. */
const ALWAYS_REFUSED = new Set(["private-key", "executable"]);
/** A session id that the scan returns: a UUID, as Codex writes it. Other text in its place is not an id. */
const SESSION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SCAN_TIMEOUT_MS = 15 * 60_000;
/** Prints `MISSING` when the box has no box install of Ferry. The exit code of Ferry does not fail the command. */
const BOX_SCAN_COMMAND = `if [ -f "$HOME/${BOX_MARKER}" ] && [ -x "$HOME/.local/bin/ferry" ]; then "$HOME/.local/bin/ferry" --json scan; else echo MISSING; fi; true`;

/** Run `request` on this machine, whose home is `home`. */
export function runScan<Request extends ScanRequest>(request: Request, home: string): ScanOf<Request>;
export function runScan(request: ScanRequest, home: string): ScanOf<ScanRequest> {
  const rules = DENY_RULES_VERSION;
  if (request.kind === "skill") return { rules, ...scanSkillFiles(join(home, request.root)) };
  if (request.kind === "files") return { rules, ...scanFiles(join(home, request.root), request) };
  return { rules, ...scanSessionFiles(home, request) };
}

/** The request in the JSON text `text`. */
export function parseScanRequest(text: string): ScanRequest {
  const invalid = new FerryError("usage", "ferry scan reads one JSON request on stdin.");
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw invalid;
  }
  if (typeof value !== "object" || value === null) throw invalid;
  const { kind, root, paths, allowSecrets, project } = value as Record<string, unknown>;
  const confirmed = (value as Record<string, unknown>).confirmed === true;
  const list = Array.isArray(paths) && paths.every((path): path is string => typeof path === "string") ? paths : null;
  if (kind === "skill" && typeof root === "string") return { kind, root };
  if (kind === "files" && typeof root === "string" && list) return { kind, root, paths: list, allowSecrets: allowSecrets === true, confirmed };
  if (kind === "sessions" && list && typeof project === "string") return { kind, paths: list, project, confirmed };
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
  const result = await link.run(BOX_SCAN_COMMAND, {
    input: new TextEncoder().encode(JSON.stringify(request)),
    timeoutMs: SCAN_TIMEOUT_MS,
  });
  if (!result.ok) throw new FerryError("box-command-failed", `Ferry could not check the files on ${label}: ${result.error.message}`);
  const why = "Ferry checks the files with the Ferry on the box before it copies them, so that a file with a secret stays on the box.";
  const build = "A development build of Ferry puts no Ferry on a box. Use a release of Ferry.";
  if (result.stdout.trim() === "MISSING") {
    throw new FerryError("refused", `Ferry is not installed on ${label}. ${why}`, { hint: `Run ferry install. ${build}` });
  }
  let envelope: { ok?: unknown; result?: unknown; error?: { code?: unknown; message?: unknown } | null } = {};
  try {
    envelope = JSON.parse(result.stdout) as typeof envelope;
  } catch {
    // An old Ferry prints its help or an error text.
  }
  if (envelope.ok === true && typeof envelope.result === "object" && envelope.result !== null) {
    const scan = envelope.result as ScanOf<Request>;
    // A result without the number is from a Ferry before the number, so its rules are older.
    if (typeof scan.rules === "number" && scan.rules >= DENY_RULES_VERSION) return scan;
    throw new FerryError(
      "refused",
      `The Ferry on ${label} has older deny rules than this machine, so its check can pass a file that this machine refuses. Ferry copied no file.`,
      { hint: `Run ferry update to put the Ferry of this machine on ${label}.` },
    );
  }
  if (envelope.ok === false && envelope.error && envelope.error.code !== "usage") {
    // The text is from the box and can name a file there.
    const text = String(envelope.error.message);
    const shown = holdsToken(text) ? ". Ferry does not show the error text of the box, because it has the form of a token." : `: ${text}`;
    throw new FerryError("box-command-failed", `Ferry could not check the files on ${label}${shown}`);
  }
  throw new FerryError("refused", `The Ferry on ${label} is too old to check the files there. ${why}`, {
    hint: `Run ferry update. ${build}`,
  });
}

/** The paths of `files` under `stage` that are not a regular file with the SHA-256 of the scan. */
export function changedFiles(stage: string, files: readonly { readonly path: string; readonly sha256: string }[]): string[] {
  return files
    .filter((file) => {
      try {
        const path = join(stage, file.path);
        return !lstatSync(path).isFile() || sha256(readFileSync(path)) !== file.sha256;
      } catch {
        return true;
      }
    })
    .map((file) => file.path);
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

function scanSkillFiles(directory: string): SkillScan {
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
    shown(file.path) === null ? [] : [{ path: file.path, sha256: sha256(file.bytes), executable: file.executable }],
  );
  const forbidden = hits(scan.forbidden);
  const skipped = hits(scan.leftovers);
  return { files, forbidden: [...forbidden, ...named.values()], skipped };
}

/**
 * The files of `paths` under `root` that pass the content rules of a move.
 * With `allowSecrets`, an environment file that fails only the token or
 * secret-field rules is carried, and `secrets` names the kinds of secret.
 */
function scanFiles(root: string, request: Extract<ScanRequest, { kind: "files" }>): FilesScan {
  const carry: FilesScan["carry"][number][] = [];
  const refused: ScanHit[] = [];
  for (const path of request.paths) {
    const named = tokenNameHit(path);
    if (named) {
      refused.push(named);
      continue;
    }
    const full = join(root, path);
    let stat;
    try {
      stat = lstatSync(full);
    } catch {
      refused.push({ path, code: "missing", reason: "file changed during the preflight" });
      continue;
    }
    if (stat.isSymbolicLink()) {
      refused.push({ path, code: "symlink", reason: "symbolic link" });
      continue;
    }
    if (!stat.isFile()) {
      refused.push({ path, code: "not-a-file", reason: "not a regular file" });
      continue;
    }
    const bytes = readFileSync(full);
    const hits = carriedContentHits(path, bytes);
    if (hits.length === 0) carry.push({ path, sha256: sha256(bytes), secrets: [] });
    else if (!request.allowSecrets || carriedNameHit(path)?.code !== "dotenv") refused.push(...hits);
    else {
      const all = [...hits, ...envLineHits(path, bytes)];
      const kept = all.find((hit) => ALWAYS_REFUSED.has(hit.code));
      if (kept) refused.push(kept);
      else carry.push({ path, sha256: request.confirmed ? sha256(bytes) : null, secrets: [...new Set(all.map((hit) => hit.reason))] });
    }
  }
  return { carry, refused };
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

/** The hits of the name rules, the content rules, and the session scan for each session or memory file of the request. */
function scanSessionFiles(home: string, request: Extract<ScanRequest, { kind: "sessions" }>): SessionsScan {
  const files = request.paths.map((path) => {
    const denied = (hit: ScanHit, session: boolean) => ({ path, session, sha256: null, id: null, hits: [hit], blocked: true });
    // The list of the session store names the file, so it counts as a session of the project.
    const named = tokenNameHit(path);
    if (named) return denied(named, true);
    let bytes: Buffer;
    try {
      bytes = readFileSync(join(home, path));
    } catch {
      return denied({ path, code: "missing", reason: "file changed during the preflight" }, false);
    }
    const nameHit = carriedNameHit(path);
    const hits = nameHit ? [nameHit] : [...carriedContentHits(path, bytes), ...sessionContentHits(path, bytes)];
    const id = sessionId(bytes, request.project);
    // A name rule, a private key, or an executable refuses the file also with allowSecrets.
    const blocked = nameHit !== null || hits.some((hit) => ALWAYS_REFUSED.has(hit.code));
    // Only a file that leaves the machine gives its hash and its id.
    const leaves = hits.length === 0 || (request.confirmed && !blocked);
    return { path, session: id !== null, sha256: leaves ? sha256(bytes) : null, id: leaves ? id : null, hits, blocked };
  });
  return { files };
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

/** True for a path of a scan result that stays inside its root. */
export function isInside(path: string): boolean {
  return path !== "" && !isAbsolute(path) && !path.split("/").includes("..");
}

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}
