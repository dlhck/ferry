import { createHash } from "node:crypto";
import { chmodSync, linkSync, lstatSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, posix, relative, resolve } from "node:path";
import { resolveTargetBox } from "./boxes.ts";
import { readConfig, resolveLinkOptions, type PartialOperatorConfig } from "./config.ts";
import { FerryError } from "./errors.ts";
import { Link, type LinkOptions } from "./link.ts";
import { carriedNameHit } from "./manifest.ts";
import { boxSide, loadConfig, localSide, must, quoteShell } from "./move.ts";
import { recheckPack, tokenNameHit, writePack } from "./scan.ts";
import { boxLockError, type BoxLocker } from "./sync.ts";

export type CpInput = {
  readonly source: string;
  readonly destination: string;
  readonly box?: string;
  readonly force: boolean;
};

export type CpDependencies = {
  readonly readConfig: () => PartialOperatorConfig | null;
  readonly createLink: (options: LinkOptions) => Pick<Link, "run">;
  readonly home: string;
  readonly cwd: string;
  readonly lockBox?: BoxLocker;
};

export type CpResult = {
  readonly box: string;
  readonly source: string;
  readonly destination: string;
  readonly sha256: string;
};

/** A colon before any slash marks the box endpoint. Use ./ for a local name with a colon. */
function endpoint(value: string): { box: string; path: string } | null {
  const match = /^([^/:]*):(.*)$/s.exec(value);
  return match ? { box: match[1]!, path: match[2]! } : null;
}

function checkedPath(value: string, source = false): void {
  if (!value || /[\0\r\n]/.test(value)) throw new FerryError("usage", "Give a file path without NUL or line breaks.");
  const hit = tokenNameHit(value) ?? (source ? carriedNameHit(value) : null);
  if (hit) throw new FerryError("deny-rule-match", `Ferry refused the path: ${hit.reason}.`);
}

export async function runCp(input: CpInput, overrides: Partial<CpDependencies> = {}): Promise<CpResult> {
  const dependencies: CpDependencies = {
    readConfig,
    createLink: (options) => new Link(options),
    home: homedir(),
    cwd: process.cwd(),
    ...overrides,
  };
  const from = endpoint(input.source);
  const to = endpoint(input.destination);
  if ((from === null) === (to === null)) {
    throw new FerryError("usage", "ferry cp needs one box path and one local path.");
  }
  const remote = (from ?? to)!;
  if (remote.box && input.box !== undefined && remote.box !== input.box) {
    throw new FerryError("usage", "The box path conflicts with --box. Give the same box name or use :<path>.");
  }
  checkedPath(remote.path, from !== null);
  checkedPath(from ? input.destination : input.source, from === null);
  const box = resolveTargetBox(loadConfig(dependencies.readConfig), input.box ?? (remote.box || undefined));
  const link = dependencies.createLink(resolveLinkOptions(box.host));
  const local = localSide(dependencies.home, process.platform);
  const remoteSide = boxSide(link, `box ${box.name}`, from !== null);
  const source = from ? remoteSide : local;
  const destination = to ? remoteSide : local;
  const lock = dependencies.lockBox?.(box);
  if (lock !== undefined && typeof lock !== "function") throw boxLockError(lock);
  let stage: string | undefined;
  try {
    // Check the box rules before reading any source-box command output.
    if (from) await source.scan({ kind: "files", root: "", paths: [], allowSecrets: false });
    const remoteHome = await must(remoteSide.run(`printf '%s' ${remoteSide.home}`), "Ferry could not read the box home");
    const expand = (path: string, home: string, cwd: string) => {
      if (path === "~" || path.startsWith("~/")) return resolve(home, path.slice(2));
      return resolve(cwd, path);
    };
    const sourcePath = from
      ? expand(from.path, remoteHome, remoteHome)
      : expand(input.source, dependencies.home, dependencies.cwd);
    const destinationPath = to
      ? expand(to.path, remoteHome, remoteHome)
      : expand(input.destination, dependencies.home, dependencies.cwd);
    checkedPath(sourcePath, true);
    checkedPath(destinationPath);
    const target = quoteShell(destinationPath);
    const parent = quoteShell(posix.dirname(destinationPath));
    const existing = await must(destination.run(`if [ -e ${target} ] || [ -L ${target} ]; then echo exists; fi`), "Ferry could not check the destination");
    if (existing.trim() && !input.force) throw new FerryError("refused", "The destination exists. Add --force to replace it.");
    const shape = await must(source.run([
      `ferry_path=${quoteShell(sourcePath)}`,
      'while [ "$ferry_path" != / ]; do',
      '  if [ -L "$ferry_path" ]; then echo symlink; exit; fi',
      '  ferry_path=$(dirname "$ferry_path") || exit 1',
      'done',
    ].join("\n")), "Ferry could not check the source path");
    if (shape.trim()) throw new FerryError("refused", "Ferry does not copy a symbolic link or a file through a symbolic link.");
    // Keep the full source path in the request so the name checks see every segment.
    const sourceHome = from ? remoteHome : dependencies.home;
    const root = relative(sourceHome, "/");
    const path = sourcePath.slice(1);
    const pack = await source.pack({ kind: "files", root, paths: [path], secrets: [] });
    const file = pack.files[0];
    if (!file) {
      throw new FerryError("deny-rule-match", `Ferry refused the source file: ${pack.refused[0]?.reason ?? "no checked file"}.`);
    }
    // A source box can have older or modified rules. Apply the local rules before writing the destination.
    stage = mkdtempSync(join(tmpdir(), "ferry-cp-"));
    writePack(stage, pack.files);
    const hits = recheckPack(stage, pack.files);
    if (hits.length > 0) throw new FerryError("deny-rule-match", `Ferry refused the source file: ${hits[0]!.reason}.`);
    if (from) {
      // Native file operations name the exact destination, even if another process creates a directory there.
      if (existing.trim()) {
        const stat = lstatSync(destinationPath);
        if (!stat.isFile()) throw new FerryError("refused", "The destination is a directory or symbolic link.");
      }
      const directory = mkdtempSync(join(posix.dirname(destinationPath), ".ferry-cp-"));
      const temporary = join(directory, "file");
      try {
        writeFileSync(temporary, file.bytes);
        const hash = createHash("sha256").update(readFileSync(temporary)).digest("hex");
        if (hash !== file.sha256) throw new FerryError("failed", "SHA-256 verification failed.");
        chmodSync(temporary, file.mode);
        if (input.force) renameSync(temporary, destinationPath);
        else linkSync(temporary, destinationPath);
      } finally {
        rmSync(directory, { recursive: true, force: true });
      }
    } else await must(destination.run([
      `test -d ${parent} || { echo 'The destination parent is not a directory.' >&2; exit 1; }`,
      `if [ -d ${target} ] || [ -L ${target} ]; then echo 'The destination is a directory or symbolic link.' >&2; exit 1; fi`,
      `ferry_tmp=$(mktemp ${parent}/.ferry-cp.XXXXXX) || exit 1`,
      'trap \'rm -f "$ferry_tmp"\' EXIT',
      'cat >"$ferry_tmp" || exit 1',
      `chmod ${file.mode.toString(8)} "$ferry_tmp" || exit 1`,
      'if command -v sha256sum >/dev/null 2>&1; then ferry_sum=$(sha256sum "$ferry_tmp"); else ferry_sum=$(shasum -a 256 "$ferry_tmp"); fi || exit 1',
      `test "\${ferry_sum%% *}" = ${quoteShell(file.sha256)} || { echo 'SHA-256 verification failed.' >&2; exit 1; }`,
      input.force ? `mv -fT "$ferry_tmp" ${target}` : `ln -T "$ferry_tmp" ${target}`,
    ].join("\n"), { input: file.bytes, timeoutMs: 15 * 60_000 }), "Ferry could not copy the file");
    return { box: box.name, source: input.source, destination: input.destination, sha256: file.sha256 };
  } finally {
    if (stage) rmSync(stage, { recursive: true, force: true });
    if (typeof lock === "function") lock();
  }
}
