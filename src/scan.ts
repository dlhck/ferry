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
 */

import { createHash } from "node:crypto";
import { lstatSync, readFileSync } from "node:fs";
import { isAbsolute, join, relative } from "node:path";
import { BOX_MARKER } from "./box-ferry.ts";
import { FerryError } from "./errors.ts";
import type { Link } from "./link.ts";
import { carriedContentHits, carriedNameHit, scanSkill } from "./manifest.ts";
import { sessionContentHits } from "./session-scan.ts";

export type ScanHit = { readonly path: string; readonly code: string; readonly reason: string };

/** Each `root` and each path of `sessions` is relative to the home. The paths of `files` are relative to `root`. */
export type ScanRequest =
  | { readonly kind: "skill"; readonly root: string }
  | { readonly kind: "files"; readonly root: string; readonly paths: readonly string[]; readonly allowSecrets: boolean }
  | { readonly kind: "sessions"; readonly paths: readonly string[]; readonly project: string };

/** The files of a skill directory that pass the rules of a publish. The paths are relative to the directory. */
export type SkillScan = {
  readonly files: readonly { readonly path: string; readonly sha256: string; readonly executable: boolean }[];
  readonly forbidden: readonly ScanHit[];
  readonly skipped: readonly ScanHit[];
};

/** `secrets` holds the kinds of secret in a carried environment file, never the values. */
export type FilesScan = {
  readonly carry: readonly { readonly path: string; readonly sha256: string; readonly secrets: readonly string[] }[];
  readonly refused: readonly ScanHit[];
};

export type SessionsScan = {
  readonly files: readonly {
    readonly path: string;
    readonly sha256: string;
    /** The session id in the first line, when that line records the project of the request. */
    readonly id: string | null;
    readonly hits: readonly ScanHit[];
    /** True when a hit refuses the file also with `--allow-secrets`. */
    readonly blocked: boolean;
  }[];
};

type Scans = { skill: SkillScan; files: FilesScan; sessions: SessionsScan };
export type ScanOf<Request extends ScanRequest> = Scans[Request["kind"]];

/** Content rules that refuse a file also with `allowSecrets`. */
const ALWAYS_REFUSED = new Set(["private-key", "executable"]);
/** A session id that the scan returns. Other text in its place is not an id. */
const SESSION_ID = /^[\w.-]{1,128}$/;
const SCAN_TIMEOUT_MS = 15 * 60_000;
/** Prints `MISSING` when the box has no box install of Ferry. The exit code of Ferry does not fail the command. */
const BOX_SCAN_COMMAND = `if [ -f "$HOME/${BOX_MARKER}" ] && [ -x "$HOME/.local/bin/ferry" ]; then "$HOME/.local/bin/ferry" --json scan; else echo MISSING; fi; true`;

/** Run `request` on this machine, whose home is `home`. */
export function runScan<Request extends ScanRequest>(request: Request, home: string): ScanOf<Request>;
export function runScan(request: ScanRequest, home: string): SkillScan | FilesScan | SessionsScan {
  if (request.kind === "skill") return scanSkillFiles(join(home, request.root));
  if (request.kind === "files") return scanFiles(join(home, request.root), request.paths, request.allowSecrets);
  return scanSessionFiles(home, request.paths, request.project);
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
  const list = Array.isArray(paths) && paths.every((path): path is string => typeof path === "string") ? paths : null;
  if (kind === "skill" && typeof root === "string") return { kind, root };
  if (kind === "files" && typeof root === "string" && list) return { kind, root, paths: list, allowSecrets: allowSecrets === true };
  if (kind === "sessions" && list && typeof project === "string") return { kind, paths: list, project };
  throw invalid;
}

/**
 * Run `request` with the Ferry on the box. `label` names the box in an error.
 * Ferry refuses when the box has no Ferry, or a Ferry without `ferry scan`.
 * It never copies a file to check it on this machine.
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
    return envelope.result as ScanOf<Request>;
  }
  if (envelope.ok === false && envelope.error && envelope.error.code !== "usage") {
    throw new FerryError("box-command-failed", `Ferry could not check the files on ${label}: ${String(envelope.error.message)}`);
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

function scanSkillFiles(directory: string): SkillScan {
  const scan = scanSkill(directory);
  const hit = (found: ScanHit): ScanHit => ({ path: relative(directory, found.path), code: found.code, reason: found.reason });
  return {
    files: scan.files.map((file) => ({ path: file.path, sha256: sha256(file.bytes), executable: file.executable })),
    forbidden: scan.forbidden.map(hit),
    skipped: scan.leftovers.map(hit),
  };
}

/**
 * The files of `paths` under `root` that pass the content rules of a move.
 * With `allowSecrets`, an environment file that fails only the token or
 * secret-field rules is carried, and `secrets` names the kinds of secret.
 */
function scanFiles(root: string, paths: readonly string[], allowSecrets: boolean): FilesScan {
  const carry: FilesScan["carry"][number][] = [];
  const refused: ScanHit[] = [];
  for (const path of paths) {
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
    else if (!allowSecrets || carriedNameHit(path)?.code !== "dotenv") refused.push(...hits);
    else {
      const all = [...hits, ...envLineHits(path, bytes)];
      const kept = all.find((hit) => ALWAYS_REFUSED.has(hit.code));
      if (kept) refused.push(kept);
      else carry.push({ path, sha256: sha256(bytes), secrets: [...new Set(all.map((hit) => hit.reason))] });
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

/** The hits of the name rules, the content rules, and the session scan for each session or memory file of `paths`. */
function scanSessionFiles(home: string, paths: readonly string[], project: string): SessionsScan {
  const files = paths.map((path) => {
    let bytes: Buffer;
    try {
      bytes = readFileSync(join(home, path));
    } catch {
      const hits = [{ path, code: "missing", reason: "file changed during the preflight" }];
      return { path, sha256: "", id: null, hits, blocked: true };
    }
    const nameHit = carriedNameHit(path);
    const hits = nameHit ? [nameHit] : [...carriedContentHits(path, bytes), ...sessionContentHits(path, bytes)];
    // A name rule, a private key, or an executable refuses the file also with allowSecrets.
    const blocked = nameHit !== null || hits.some((hit) => ALWAYS_REFUSED.has(hit.code));
    return { path, sha256: sha256(bytes), id: sessionId(bytes, project), hits, blocked };
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
