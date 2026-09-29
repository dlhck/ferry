/**
 * Sessions finds the agent sessions of a project in the session stores that
 * the harness descriptors name, and stages them for the destination home.
 * `ferry move` applies the deny rules to the staged files and carries them.
 *
 * A store has one of two layouts. Claude keeps one directory for each project
 * path under `~/.claude/projects`. Codex keeps all sessions under
 * `~/.codex/sessions`, and the first line of each session records its project
 * path. For Codex, the staged copy records the destination project path.
 */

import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { quoteShell } from "./box-settings.ts";
import type { HarnessDescriptor, SessionStore } from "./registry/types.ts";

/** A file of a session. Both paths are relative to the home. */
export type SessionFile = { readonly source: string; readonly target: string };

/** A session, or one project memory file with a null `id`. `harness` is the harness id. */
export type Session = { readonly harness: string; readonly id: string | null; readonly files: readonly SessionFile[] };

/** The sessions of a project, and the local directory that holds their files at the target paths, or null without sessions. */
export type StagedSessions = { readonly sessions: readonly Session[]; readonly stage: string | null };

/** Claude shortens a longer directory name and adds a hash of the path. */
const MAX_NAME_LENGTH = 200;

/** The directory name of the project `path` in a `project-directory` store, as Claude makes it. */
export function projectDirectoryName(path: string): string {
  const name = path.replace(/[^a-zA-Z0-9]/g, "-");
  if (name.length <= MAX_NAME_LENGTH) return name;
  let hash = 0;
  for (let index = 0; index < path.length; index++) hash = ((hash << 5) - hash + path.charCodeAt(index)) | 0;
  return `${name.slice(0, MAX_NAME_LENGTH)}-${Math.abs(hash).toString(36)}`;
}

/**
 * Find the sessions of `sourceProject` and stage them for `targetProject`.
 * Both are absolute paths. `run` runs a command in the source home and returns
 * its stdout. `fetch` copies home-relative paths from the source home to a new
 * local directory and returns that directory. The caller removes `stage`.
 */
export async function stageSessions(options: {
  readonly harnesses: readonly HarnessDescriptor[];
  readonly sourceProject: string;
  readonly targetProject: string;
  readonly run: (command: string) => Promise<string>;
  readonly fetch: (paths: readonly string[]) => Promise<string>;
}): Promise<StagedSessions> {
  const listed: { harness: string; store: SessionStore; paths: string[] }[] = [];
  for (const harness of options.harnesses) {
    if (!harness.sessions) continue;
    const output = await options.run(listCommand(harness.sessions, options.sourceProject));
    const paths = output.split("\0").filter((path) => path !== "");
    if (paths.length > 0) listed.push({ harness: harness.id, store: harness.sessions, paths });
  }
  if (listed.length === 0) return { sessions: [], stage: null };
  const stage = mkdtempSync(join(tmpdir(), "ferry-sessions-"));
  let fetched: string | null = null;
  try {
    fetched = await options.fetch(listed.flatMap((entry) => entry.paths));
    const sessions: Session[] = [];
    for (const { harness, store, paths } of listed) {
      const found =
        store.layout === "project-directory"
          ? projectSessions(harness, store, paths, options.sourceProject, options.targetProject)
          : cwdSessions(harness, paths, fetched, options.sourceProject);
      for (const file of found.flatMap((session) => session.files)) {
        const from = join(fetched, file.source);
        const to = join(stage, file.target);
        const bytes = readFileSync(from);
        mkdirSync(dirname(to), { recursive: true });
        writeFileSync(to, store.layout === "first-line-cwd" ? retarget(bytes, options.targetProject) : bytes);
        chmodSync(to, statSync(from).mode & 0o777);
      }
      sessions.push(...found);
    }
    return { sessions, stage };
  } catch (error) {
    rmSync(stage, { recursive: true, force: true });
    throw error;
  } finally {
    if (fetched) rmSync(fetched, { recursive: true, force: true });
  }
}

/** A command that prints the home-relative path of each candidate file, each one followed by NUL. */
function listCommand(store: SessionStore, project: string): string {
  if (store.layout === "project-directory") {
    const directory = quoteShell(`${store.root}/${projectDirectoryName(project)}`);
    return `if [ -d ${directory} ]; then find ${directory} -type f -print0; fi`;
  }
  // A quick text match on the first line. `cwdSessions` parses the line.
  const needle = quoteShell(`"cwd":${JSON.stringify(project)}`);
  const root = quoteShell(store.root);
  return `if [ -d ${root} ]; then find ${root} -type f -name ${quoteShell(store.files)} -exec sh -c 'n=$1; shift; for f; do head -n 1 "$f" | grep -qF -- "$n" && printf "%s\\0" "$f"; done; true' sh ${needle} {} +; fi`;
}

/**
 * The sessions in the project directory: each `<id>.jsonl` with the files in
 * the directory `<id>`, and each memory file alone. Ferry leaves out other files.
 */
function projectSessions(
  harness: string,
  store: Extract<SessionStore, { layout: "project-directory" }>,
  paths: readonly string[],
  sourceProject: string,
  targetProject: string,
): Session[] {
  const sourceDirectory = `${store.root}/${projectDirectoryName(sourceProject)}`;
  const targetDirectory = `${store.root}/${projectDirectoryName(targetProject)}`;
  const file = (rest: string): SessionFile => ({ source: `${sourceDirectory}/${rest}`, target: `${targetDirectory}/${rest}` });
  const rests = paths.map((path) => path.slice(sourceDirectory.length + 1));
  const sessions = new Map<string, SessionFile[]>();
  for (const rest of rests) {
    if (!rest.includes("/") && rest.endsWith(".jsonl")) sessions.set(rest.slice(0, -".jsonl".length), [file(rest)]);
  }
  const memory: Session[] = [];
  for (const rest of rests) {
    const [first = ""] = rest.split("/");
    if (!rest.includes("/")) continue;
    if (first === store.memory) memory.push({ harness, id: null, files: [file(rest)] });
    else sessions.get(first)?.push(file(rest));
  }
  return [...[...sessions].map(([id, files]) => ({ harness, id, files })), ...memory];
}

/** The sessions whose first line records `project` as `payload.cwd`. */
function cwdSessions(harness: string, paths: readonly string[], fetched: string, project: string): Session[] {
  return paths.flatMap((path) => {
    const meta = firstLine(join(fetched, path));
    if (meta?.payload?.cwd !== project || typeof meta.payload.id !== "string") return [];
    return [{ harness, id: meta.payload.id, files: [{ source: path, target: path }] }];
  });
}

type FirstLine = { payload?: { cwd?: unknown; id?: unknown } };

function firstLine(path: string): FirstLine | null {
  const text = readFileSync(path, "utf8");
  const end = text.indexOf("\n");
  try {
    return JSON.parse(end === -1 ? text : text.slice(0, end)) as FirstLine;
  } catch {
    return null;
  }
}

/** Record `project` as `payload.cwd` in the first line. The other lines stay as they are. */
function retarget(bytes: Buffer, project: string): Buffer {
  const end = bytes.indexOf("\n");
  const head = JSON.parse(bytes.subarray(0, end === -1 ? bytes.length : end).toString("utf8")) as { payload: { cwd: string } };
  head.payload.cwd = project;
  return Buffer.concat([Buffer.from(JSON.stringify(head)), end === -1 ? Buffer.alloc(0) : bytes.subarray(end)]);
}
