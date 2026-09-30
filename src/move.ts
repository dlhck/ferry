/**
 * Move continues a project on the other machine: from the operator machine to
 * a box, with `fromBox` from a box to the operator machine, or with `fromBox`
 * and `toBox` from one box to another box. For a move between boxes, the
 * operator process reads box A over Link, applies the same checks, and writes
 * to box B over Link. The two boxes do not connect to each other.
 *
 * The destination clones the project from its git remote at the same path
 * relative to the home directory. Ferry then carries the local-only files that
 * pass the Manifest deny rules, verifies each one with a SHA-256 checksum on
 * the destination. With `remove`, the source copy goes to a trash directory.
 * Ferry never deletes it.
 *
 * The deny rules run on the source machine. For a source box, the Ferry on the
 * box runs them with `ferry scan`, and the preflight copies no file. After the
 * plan and the confirmation, Ferry copies only the files that it carries, and
 * compares each one with the SHA-256 of the scan. The scan gives the hash of a
 * file with secrets only after the confirmation.
 *
 * The output of each command on a source box goes through `ferry redact` on
 * the box, so a file name, a branch name, or a commit subject with the form of
 * a token reaches this machine as `[token]`, and a credential in a URL as
 * `[credential]`. The destination clones from the origin URL without its
 * credential, so a credential in the origin URL stays on the source.
 *
 * With `sessions`, Ferry also carries the agent sessions of the project from
 * the session stores of the harness descriptors, with the same deny rules.
 * A session file on the destination stays, unless the source has the same
 * file. Ferry never removes a source session.
 *
 * Every source and destination step is a `sh` command string. The operator
 * machine runs it with `sh -c`. The box runs it through Link.
 */

import * as prompts from "@clack/prompts";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { isAbsolute, join, posix, relative, resolve } from "node:path";
import { BoxRequiredError, resolveBoxes, resolveTargetBox, type ResolvedBox } from "./boxes.ts";
import { ConfigMissingError, readConfig, resolveLinkOptions, type PartialOperatorConfig } from "./config.ts";
import { hasBoxPart, INTEGRATIONS, operatorIntegrations, type Integration } from "./integrations/index.ts";
import { paseoSourceHint } from "./integrations/paseo.ts";
import type { IntegrationId, MovedSession } from "./integrations/types.ts";
import { Link, type LinkOptions } from "./link.ts";
import { carriedNameHit, CREDENTIAL_MARK, holdsToken, redactTokens, redactUrlCredentials, TOKEN_MARK } from "./manifest.ts";
import { FerryError } from "./errors.ts";
import { noProgress, plural, step, type Progress } from "./progress.ts";
import { BUILTIN_HARNESSES } from "./registry/builtin.ts";
import type { HarnessDescriptor } from "./registry/types.ts";
import { changedFiles, runScan, scanOnBox, tokenNameHit, type ScanOf, type ScanRequest } from "./scan.ts";
import { groupSessions, listSessionFiles, stageSessions, UNKNOWN_ID, type Session } from "./sessions.ts";

export type MoveInput = {
  /** The project path on the operator machine, or the same path for the source box with `fromBox`. */
  readonly path: string;
  /** The source box. Without it, the source is this machine. */
  readonly fromBox?: string;
  /**
   * The destination box. Without it, the destination is this machine with `fromBox`, else the target box of
   * the config: `default_box` or the only box.
   */
  readonly toBox?: string;
  readonly dryRun: boolean;
  readonly remove: boolean;
  readonly includeEnv: boolean;
  /** Also carry the agent sessions and the project memory of the project. */
  readonly sessions: boolean;
  /**
   * Also carry a session, and with `includeEnv` an environment file, that fails the token or secret-field
   * rules.
   */
  readonly allowSecrets: boolean;
  /** Carry the files with secrets without a question. Without a terminal, Ferry refuses them without it. */
  readonly yes: boolean;
};

export type MoveDependencies = {
  readonly readConfig: () => PartialOperatorConfig | null;
  readonly createLink: (options: LinkOptions) => Pick<Link, "run">;
  /** The home directory of the operator machine. */
  readonly home: string;
  /** Relative paths resolve from here. */
  readonly cwd: string;
  readonly platform: NodeJS.Platform;
  readonly now: () => Date;
  readonly writeLine: (line: string) => void;
  /** Records a warning for the --json envelope. The warning line also goes to `writeLine`. */
  readonly warn?: (line: string) => void;
  readonly progress: Progress;
  /** The harnesses whose session stores Move reads. */
  readonly harnesses: readonly HarnessDescriptor[];
  /** All built-in integrations. Move uses the ones that the config enables. */
  readonly integrations: readonly Integration[];
  /** True when Ferry can ask a question on a terminal. */
  readonly interactive: boolean;
  readonly confirm: (message: string) => Promise<boolean | symbol | undefined>;
};

/** The line for `--remove`. Ferry never removes the source project from an integration. */
const SOURCE_HINTS: Partial<Record<IntegrationId, (path: string, side: string) => string>> = { paseo: paseoSourceHint };

export class MoveError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MoveError";
  }
}

/** The plan of a move, and what the move did. The paths are relative to the project folder. */
export type MoveResult = {
  /** The project path, relative to the home, as `~/<path>`. */
  readonly path: string;
  /** "this machine", "the box", or "box <name>". */
  readonly source: string;
  readonly destination: string;
  readonly dryRun: boolean;
  /** The git remote and branch of the clone, or null when Ferry copies a folder without git. */
  readonly git: GitSource | null;
  /**
   * `secrets` holds the kinds of secret in a carried environment file, never the values. `sha256` is null for
   * a file with secrets on a box, in a dry run: the box gives that hash only after the confirmation.
   */
  readonly carry: readonly Planned[];
  readonly refused: readonly Hit[];
  readonly skipped: readonly Hit[];
  readonly notes: readonly string[];
  /** The trash path of the source copy, after --remove. */
  readonly trash: string | null;
  /**
   * The carried sessions and the refused session files. A memory file is a session with a null `id`. A Codex
   * session with secrets on a box also has a null `id` in a dry run.
   */
  readonly sessions: {
    readonly carry: readonly { harness: string; id: string | null; files: readonly string[]; secrets: readonly string[] }[];
    readonly refused: readonly Hit[];
  };
};

/**
 * Directory and file names that Ferry does not carry: build output, caches,
 * IDE state, and macOS metadata. A tracked file in one of them still arrives
 * with the clone. An entry with a `/` is a path that matches at any depth.
 */
export const SKIPPED_NAMES = [
  "node_modules",
  ".next",
  ".nuxt",
  ".output",
  ".svelte-kit",
  ".turbo",
  ".vite",
  ".velite",
  ".docusaurus",
  ".expo",
  ".vercel/output",
  ".cache",
  ".parcel-cache",
  ".pnpm-store",
  "*.tsbuildinfo",
  "dist",
  "build",
  "coverage",
  "target",
  "__pycache__",
  ".venv",
  "venv",
  ".gradle",
  ".terraform",
  ".idea",
  ".vscode",
  ".DS_Store",
  "._*",
] as const;

type Hit = { readonly path: string; readonly code: string; readonly reason: string };
/** `secrets` holds the kinds of secret in a carried environment file, never the values. */
type Carried = { readonly path: string; readonly sha256: string; readonly secrets: readonly string[] };
/** A file of the plan. The hash of a file with secrets is null until the source gives it, after the confirmation. */
type Planned = Omit<Carried, "sha256"> & { readonly sha256: string | null };

type SideResult = { readonly ok: true; readonly stdout: string } | { readonly ok: false; readonly message: string };

/** One machine of the move. `home` is a shell word for its home directory. */
type Side = {
  /** "the box", "this machine", or "box <name>" for a move between boxes. */
  readonly label: string;
  readonly home: string;
  readonly trash: string;
  /** With `raw`, the output of a source box does not go through `ferry redact`. Only the file archive is raw. */
  run(command: string, options?: { readonly input?: Uint8Array; readonly timeoutMs?: number; readonly raw?: boolean }): Promise<SideResult>;
  /** Apply the deny rules to files of this machine, on this machine. */
  scan<Request extends ScanRequest>(request: Request): Promise<ScanOf<Request>>;
};

type GitSource = {
  readonly url: string;
  /** The branch to clone, or null for the default branch of the remote. */
  readonly branch: string | null;
};

/** A session or memory file to carry. `secrets` holds the kinds of secret in its files, never the values. */
type CarriedSession = Session & { readonly secrets: readonly string[] };

type SessionPlan = {
  readonly carry: readonly CarriedSession[];
  /** The paths are relative to the home, as `~/<path>`. */
  readonly refused: readonly Hit[];
  /** One line for each refused file. */
  readonly warnings: readonly string[];
  /** The SHA-256 of each source file that the scan gave a hash for, by its path relative to the source home. */
  readonly sha256: ReadonlyMap<string, string>;
  /** The absolute project paths on the source and on the destination. */
  readonly sourceProject: string;
  readonly targetProject: string;
};

type Plan = {
  readonly git: GitSource | null;
  readonly carry: readonly Planned[];
  readonly refused: readonly Hit[];
  readonly skipped: readonly Hit[];
  readonly notes: readonly string[];
  readonly problems: readonly string[];
};

const PROBE_TIMEOUT_MS = 30_000;
const NETWORK_TIMEOUT_MS = 120_000;
const GH_TIMEOUT_MS = 15_000;
const TRANSFER_TIMEOUT_MS = 15 * 60_000;
const SECTION = "ferry-section";

/** Returns null when the operator does not confirm. */
export async function runMove(input: MoveInput, overrides: Partial<MoveDependencies> = {}): Promise<MoveResult | null> {
  const dependencies: MoveDependencies = { ...defaultDependencies(), ...overrides };
  if (input.allowSecrets && !input.includeEnv && !input.sessions) {
    throw new MoveError("--allow-secrets needs --include-env or the sessions. Add --include-env, or leave out --no-sessions.");
  }
  const fromBox = input.fromBox !== undefined;
  const home = realpathSync(dependencies.home);
  const rel = homeRelative(input, home, dependencies.cwd);
  const config = loadConfig(dependencies.readConfig);
  const sourceBox = fromBox ? resolveTargetBox(config, input.fromBox) : null;
  const destinationBox = !fromBox || input.toBox !== undefined ? destinationTarget(config, input.toBox) : null;
  // A move between boxes names both boxes in the output. A move with this machine keeps "the box".
  const relay = sourceBox !== null && destinationBox !== null;
  if (relay && sourceBox.name === destinationBox.name) {
    throw new MoveError(`--from-box and --to-box both name box ${sourceBox.name}. Name two different boxes.`);
  }
  const label = (box: ResolvedBox) => (relay ? `box ${box.name}` : "the box");
  const enabled = (box: ResolvedBox | null) =>
    dependencies.integrations.filter(hasBoxPart).filter((integration) => box?.integrations[integration.id] === true);
  const local = localSide(home, dependencies.platform);
  const source = sourceBox ? boxSide(dependencies.createLink(resolveLinkOptions(sourceBox.host)), label(sourceBox), true) : local;
  const destinationLink = destinationBox && dependencies.createLink(resolveLinkOptions(destinationBox.host));
  const destination = destinationBox && destinationLink ? boxSide(destinationLink, label(destinationBox)) : local;
  // The box part registers a project on a box. The operator part registers a project that comes back to this machine.
  const registered = destinationLink
    ? enabled(destinationBox).map((integration) => ({
        name: integration.name,
        onProjectMoved: (sessions: readonly MovedSession[]) => integration.box.onProjectMoved(destinationLink, `~/${rel}`, sessions),
      }))
    : operatorIntegrations(config, dependencies.integrations).flatMap(({ name, operator }) =>
        operator.onProjectMoved && operator.available()
          ? [{ name, onProjectMoved: (sessions: readonly MovedSession[]) => operator.onProjectMoved!(join(home, rel), sessions) }]
          : [],
      );
  const sourcePath = `${source.home}/${quoteShell(rel)}`;
  const destinationPath = `${destination.home}/${quoteShell(rel)}`;
  const writeLine = dependencies.writeLine;
  const progress = dependencies.progress;

  progress.plan(input.dryRun ? 1 : (input.remove ? 5 : 4) + (fromBox ? 1 : 0) + (input.sessions ? 1 : 0) + registered.length);
  const plan = await step(
    progress,
    "Preflight",
    async () => {
      const plan = await preflight(input, rel, source, sourcePath, destination, destinationPath);
      const sessions = input.sessions
        ? await sessionPreflight(input, rel, source, destination, dependencies.harnesses)
        : NO_SESSIONS;
      return { ...plan, sessions };
    },
    undefined,
    (plan) =>
      [
        `carry ${plan.carry.length}`,
        `refuse ${plan.refused.length}`,
        `skip ${plan.skipped.length}`,
        input.sessions && plural(plan.sessions.carry.length, "session"),
        plan.problems.length > 0 && plural(plan.problems.length, "problem"),
      ]
        .filter(Boolean)
        .join(", "),
  );
  const warnings: string[] = [];
  // The local directory with the carried files: the project on this machine, or a copy of the files of a source box.
  let stage: string | null = fromBox ? null : join(home, rel);
  let sessionStage: string | null = null;
  try {
    writeLine(input.dryRun ? "Move plan (no changes will be made):" : "Move plan:");
    writeLine(`Source: ${source.label} ~/${rel}`);
    writeLine(`Destination: ${destination.label} ~/${rel}`);
    writeLine(
      plan.git
        ? `Clone: ${plan.git.url} ${plan.git.branch ? `at branch ${plan.git.branch}` : "at the default branch"}`
        : "Clone: none, the folder has no git repository; Ferry copies the folder",
    );
    for (const file of plan.carry) {
      writeLine(
        file.secrets.length > 0 ? `Carry with secrets: ${file.path} (${file.secrets.join("; ")})` : `Carry: ${file.path}`,
      );
    }
    for (const hit of plan.refused) writeLine(`Refuse: ${hit.path} (${hit.reason})`);
    for (const hit of plan.skipped) writeLine(`Skip: ${hit.path} (${hit.reason})`);
    for (const note of plan.notes) writeLine(`Note: ${note}`);
    for (const problem of plan.problems) writeLine(`Problem: ${problem}`);
    const counts = new Map<string, number>();
    for (const session of plan.sessions.carry) {
      const key = session.id === null ? `${session.harness} memory files` : session.harness;
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
    if (counts.size > 0) writeLine(`Carry sessions: ${[...counts].map(([key, count]) => `${key} ${count}`).join(", ")}`);
    for (const session of plan.sessions.carry) {
      if (session.secrets.length > 0) {
        writeLine(`Carry session with secrets: ~/${session.files[0]!.target} (${session.secrets.join("; ")})`);
      }
    }
    for (const warning of plan.sessions.warnings) {
      dependencies.warn?.(warning);
      writeLine(warning);
    }
    if (plan.problems.length > 0) {
      throw new MoveError(
        `Ferry refused to move ~/${rel}: ${plan.problems.length} ${plan.problems.length === 1 ? "problem" : "problems"}.`,
      );
    }
    const result = (files: readonly Planned[], sessions: readonly CarriedSession[]) => ({
      path: `~/${rel}`,
      source: source.label,
      destination: destination.label,
      dryRun: input.dryRun,
      git: plan.git,
      carry: files,
      refused: plan.refused,
      skipped: plan.skipped,
      notes: plan.notes,
      sessions: {
        carry: sessions.map((session) => ({
          harness: session.harness,
          id: session.id === UNKNOWN_ID ? null : session.id,
          files: session.files.map((file) => `~/${file.target}`),
          secrets: session.secrets,
        })),
        refused: plan.sessions.refused,
      },
    });
    if (input.dryRun) return { ...result(plan.carry, plan.sessions.carry), trash: null };

    const secretSessions = plan.sessions.carry.filter((session) => session.secrets.length > 0);
    const secretFiles = plan.carry.filter((file) => file.secrets.length > 0);
    const secrets = [...secretFiles, ...secretSessions.flatMap((session) => session.files)];
    if (secrets.length > 0 && !input.yes) {
      if (!dependencies.interactive) {
        throw new FerryError(
          "confirmation-required",
          `Ferry found ${plural(secrets.length, "file")} with secrets. Without a terminal, add --yes to carry them.`,
        );
      }
      progress.pause();
      const readers = destinationBox === null ? "" : " Anyone with access to the box user can read them.";
      const question = `Carry ${plural(secrets.length, "file")} with secrets to ${destination.label}?${readers}`;
      if ((await dependencies.confirm(question)) !== true) {
        writeLine("Move cancelled.");
        return null;
      }
    }

    // After the confirmation, the source gives the hashes of the files with secrets.
    const changedSince = (paths: readonly string[]) =>
      new MoveError(`${paths.join(", ")} changed on ${source.label} after the check. Run the move again.`);
    const pending = plan.carry.filter((file) => file.sha256 === null).map((file) => file.path);
    const confirmed =
      pending.length > 0
        ? (await source.scan({ kind: "files", root: rel, paths: pending, allowSecrets: true, confirmed: true })).carry
        : [];
    const carry: Carried[] = plan.carry.map((file) => {
      const sha256 = file.sha256 ?? confirmed.find((entry) => entry.path === file.path)?.sha256;
      if (typeof sha256 !== "string") throw changedSince([file.path]);
      return { ...file, sha256 };
    });
    let carriedSessions = plan.sessions.carry;

    if (fromBox && carry.length === 0) progress.skip("Reading the files", "no files to carry");
    else if (fromBox) {
      await step(progress, `Reading ${plural(carry.length, "file")} on ${source.label}`, async () => {
        stage = await fetchFiles(source, sourcePath, carry.map((file) => file.path));
        const changed = changedFiles(stage, carry);
        if (changed.length > 0) throw changedSince(changed);
      });
    }

    const incomplete = `The copy at ~/${rel} on ${destination.label} is incomplete. Move it away before you try again.`;
    await step(progress, `Cloning on ${destination.label}`, async () => {
      const parent = posix.dirname(rel) === "." ? destination.home : `${destination.home}/${quoteShell(posix.dirname(rel))}`;
      const command = plan.git
        ? `mkdir -p ${parent} && GIT_TERMINAL_PROMPT=0 git clone${plan.git.branch ? ` --branch ${quoteShell(plan.git.branch)}` : ""} -- ${quoteShell(plan.git.url)} ${destinationPath}`
        : `mkdir -p ${destinationPath}`;
      await must(destination.run(command, { timeoutMs: TRANSFER_TIMEOUT_MS }), "The clone failed");
    });

    if (carry.length === 0) {
      progress.skip("Carrying files", "no files to carry");
      progress.skip("Verifying", "no files to carry");
    } else {
      await step(progress, `Carrying ${carry.length} ${carry.length === 1 ? "file" : "files"}`, async () => {
        const archive = await createArchive(stage!, carry.map((file) => file.path));
        // tar keeps the source mode, so the files with secrets get mode 600 after the extraction.
        // `carrySessions` sets the mode of the session files, whose paths are relative to the home.
        const chmod =
          secretFiles.length > 0
            ? ` && cd ${destinationPath} && chmod 600 ${secretFiles.map((file) => quoteShell(`./${file.path}`)).join(" ")}`
            : "";
        await must(
          destination.run(`tar -xf - -C ${destinationPath}${chmod}`, { input: archive, timeoutMs: TRANSFER_TIMEOUT_MS }),
          `Ferry could not carry the files. ${incomplete}`,
        );
      });
      await step(progress, "Verifying", async () => {
        const mismatched = await verify(destination, destinationPath, carry);
        if (mismatched.length > 0) {
          throw new MoveError(
            `The checksum of ${mismatched.join(", ")} on ${destination.label} does not match. ${incomplete}`,
          );
        }
      });
    }

    let moved: MovedSession[] = [];
    if (input.sessions && plan.sessions.carry.length === 0) progress.skip("Carrying sessions", "no sessions");
    else if (input.sessions) {
      progress.start(`Carrying ${plural(carriedSessions.flatMap((session) => session.files).length, "session file")}`);
      try {
        // After the confirmation, the source gives the hashes and the ids of the sessions with secrets.
        const sha256 = new Map(plan.sessions.sha256);
        const held = carriedSessions.flatMap((session) => session.files.map((file) => file.source)).filter((path) => !sha256.has(path));
        const given =
          held.length > 0
            ? (await source.scan({ kind: "sessions", paths: held, project: plan.sessions.sourceProject, confirmed: true })).files
            : [];
        for (const file of given) if (file.sha256 !== null) sha256.set(file.path, file.sha256);
        carriedSessions = carriedSessions.map((session) =>
          session.id === UNKNOWN_ID
            ? { ...session, id: given.find((file) => file.path === session.files[0]!.source)?.id ?? UNKNOWN_ID }
            : session,
        );
        const staged = await stageSessions({
          // A session that still has no id is not the checked session. It has no hash, so it counts as changed.
          sessions: carriedSessions,
          sha256,
          targetProject: plan.sessions.targetProject,
          fetch: (paths) => fetchFiles(source, source.home, paths),
        });
        sessionStage = staged.stage;
        for (const session of staged.changed) {
          const what = session.id === null ? "the memory file" : "the session of";
          warnings.push(
            `WARNING: Ferry skips ${what} ~/${session.files[0]!.source} (a file changed after the check). Run the move again to carry it.`,
          );
        }
        const secret = new Set(carriedSessions.filter((session) => session.secrets.length > 0).map((session) => session.files[0]!.source));
        await carrySessions(destination, staged.stage, staged.sessions, secret);
        progress.done();
        moved = staged.sessions.flatMap((session) => (session.id === null ? [] : [{ provider: session.harness, id: session.id }]));
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        progress.fail(message);
        warnings.push(`WARNING: Ferry could not carry the sessions: ${message}. The move of the project is complete.`);
      }
    }

    let trash: string | null = null;
    if (input.remove) {
      const name = `${posix.basename(rel)}-${timestamp(dependencies.now())}`;
      await step(
        progress,
        relay
          ? `Moving the copy on ${source.label} to the Ferry trash`
          : fromBox
            ? "Moving the box copy to the Ferry trash"
            : "Moving the local copy to the Trash",
        async () => {
          await must(
            source.run(`mkdir -p ${source.trash} && mv -- ${sourcePath} ${source.trash}/${quoteShell(name)}`),
            "Ferry could not move the source copy to the trash",
          );
        },
      );
      trash = `${source.trash.replace(source.home, "~")}/${name}`;
    }

    for (const integration of registered) {
      progress.start(`Registering the project in ${integration.name}`);
      try {
        await integration.onProjectMoved(moved);
        progress.done();
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        progress.fail(message);
        warnings.push(
          `WARNING: Ferry could not register ~/${rel} in ${integration.name}: ${message}. The move is complete.`,
        );
      }
    }

    if (trash) writeLine(`Trash: moved the source copy to ${trash}`);
    writeLine(
      `Moved ~/${rel}${relay ? ` from ${source.label}` : ""} to ${destination.label}: carried ${carry.length}, refused ${plan.refused.length}, skipped ${plan.skipped.length}.`,
    );
    if (moved.length > 0) writeLine(`Carried ${plural(moved.length, "session")}. Resume them in ~/${rel} on ${destination.label}.`);
    for (const warning of warnings) {
      dependencies.warn?.(warning);
      writeLine(warning);
    }
    if (input.remove) {
      for (const integration of enabled(sourceBox ?? destinationBox)) {
        const hint = SOURCE_HINTS[integration.id];
        if (hint) writeLine(hint(`~/${rel}`, source.label));
      }
    }
    return { ...result(carry, carriedSessions), trash };
  } finally {
    if (fromBox && stage) rmSync(stage, { recursive: true, force: true });
    if (sessionStage) rmSync(sessionStage, { recursive: true, force: true });
  }
}

/** The project path relative to the home. Ferry refuses a path outside the home. */
function homeRelative(input: MoveInput, home: string, cwd: string): string {
  let path = resolve(cwd, input.path);
  if (input.fromBox === undefined) {
    if (!existsSync(path)) throw new MoveError(`${path} does not exist.`);
    path = realpathSync(path);
  }
  const rel = relative(home, path);
  if (rel === "" || rel === ".." || rel.startsWith("../") || isAbsolute(rel)) {
    throw new MoveError(`${path} is not inside the home directory ${home}. Ferry moves only folders inside the home.`);
  }
  return rel.split("\\").join("/");
}

async function preflight(
  input: MoveInput,
  rel: string,
  source: Side,
  sourcePath: string,
  destination: Side,
  destinationPath: string,
): Promise<Plan> {
  const problems: string[] = [];
  const notes: string[] = [];

  // A source box must have a Ferry with the rules of this machine, before it runs a command that lists its files.
  await source.scan({ kind: "files", root: rel, paths: [], allowSecrets: false, confirmed: false });

  const kind = await must(
    source.run(
      `if [ ! -d ${sourcePath} ]; then echo missing; elif cd ${sourcePath} && git rev-parse --is-inside-work-tree >/dev/null 2>&1; then echo git; git rev-parse --show-prefix; else echo plain; fi`,
      { timeoutMs: PROBE_TIMEOUT_MS },
    ),
    `Ferry could not read ~/${rel} on ${source.label}`,
  );
  const [shape, prefix] = kind.split("\n");
  if (shape === "missing") throw new MoveError(`~/${rel} does not exist on ${source.label}.`);
  if (shape === "git" && prefix) {
    throw new MoveError(`~/${rel} is inside a git repository. Move the repository root.`);
  }

  const exists = await must(
    destination.run(`if [ -e ${destinationPath} ] || [ -L ${destinationPath} ]; then echo exists; fi`, {
      timeoutMs: PROBE_TIMEOUT_MS,
    }),
    `Ferry could not read ~/${rel} on ${destination.label}`,
  );
  if (exists.includes("exists")) problems.push(`~/${rel} already exists on ${destination.label}.`);

  const git = shape === "git" ? await gitPreflight(source, sourcePath, problems, notes) : null;

  const listed = await must(
    source.run(`cd ${sourcePath} && ${shape === "git" ? GIT_LIST : FIND_LIST}`, { timeoutMs: PROBE_TIMEOUT_MS }),
    `Ferry could not list the files of ~/${rel} on ${source.label}`,
  );
  const [candidates = "", skippedList = ""] = listed.split(`\0${SECTION}\0`);
  const skipped: Hit[] = entries(skippedList)
    .map((path) => path.replace(/\/$/, ""))
    .filter(isSkipped)
    .map((path) => ({ path, code: "skip", reason: "build output, cache, IDE state, or macOS metadata" }));

  const refused: Hit[] = [];
  const wanted: string[] = [];
  for (const path of entries(candidates)) {
    // The box put the mark in the place of a name with a token. The file stays on the source.
    const named = tokenNameHit(path);
    if (named) {
      if (!refused.some((hit) => hit.code === named.code && hit.path === named.path)) refused.push(named);
      continue;
    }
    if (path.endsWith("/")) {
      refused.push({ path: path.slice(0, -1), code: "nested-repository", reason: "nested git repository" });
      continue;
    }
    const hit = carriedNameHit(path, { allowEnv: input.includeEnv });
    if (hit) refused.push(hit);
    else wanted.push(path);
  }

  // The source machine reads the files. A source box returns the hits and the hashes, never the content.
  const scanned =
    wanted.length > 0
      ? await source.scan({ kind: "files", root: rel, paths: wanted, allowSecrets: input.allowSecrets, confirmed: false })
      : { carry: [], refused: [] };
  const carry = scanned.carry.filter((file) => wanted.includes(file.path));
  refused.push(...scanned.refused);

  if (input.remove && refused.length > 0) {
    problems.push(
      `--remove needs every local-only file carried, and Ferry refuses ${refused.length}. Move them by hand or leave out --remove.`,
    );
  }
  return { git, carry, refused, skipped, notes, problems };
}

const NO_SESSIONS: SessionPlan = { carry: [], refused: [], warnings: [], sha256: new Map(), sourceProject: "", targetProject: "" };

/**
 * List the sessions of the project and apply the deny rules to each file on
 * the source machine. A transcript also gets the session scan, which reads
 * each record. A hit refuses the whole session. With `allowSecrets`, a session
 * whose files fail only the token or secret-field rules is carried. The
 * preflight copies no session file.
 */
async function sessionPreflight(
  input: MoveInput,
  rel: string,
  source: Side,
  destination: Side,
  harnesses: readonly HarnessDescriptor[],
): Promise<SessionPlan> {
  const homeOf = async (side: Side) =>
    must(side.run(`printf '%s' ${side.home}`, { timeoutMs: PROBE_TIMEOUT_MS }), `Ferry could not read the home on ${side.label}`);
  const sourceProject = `${await homeOf(source)}/${rel}`;
  const targetProject = `${await homeOf(destination)}/${rel}`;
  const listed = await listSessionFiles({
    harnesses,
    sourceProject,
    run: (command) =>
      must(source.run(`cd ${source.home} && ${command}`, { timeoutMs: PROBE_TIMEOUT_MS }), `Ferry could not list the sessions on ${source.label}`),
  });
  const paths = listed.flatMap((entry) => entry.paths);
  if (paths.length === 0) return NO_SESSIONS;
  // The box put the mark in the place of a name with a token. Such a file has no scan: its session stays on the source.
  const named = paths.filter((path) => path.includes(TOKEN_MARK));
  const scanned = new Map(
    (await source.scan({ kind: "sessions", paths: paths.filter((path) => !named.includes(path)), project: sourceProject, confirmed: false })).files.map(
      (file) => [file.path, file],
    ),
  );
  for (const path of named) scanned.set(path, { path, session: true, sha256: null, id: null, hits: [tokenNameHit(path)!], blocked: true });
  const unscanned = paths.filter((path) => !scanned.has(path));
  if (unscanned.length > 0) throw new MoveError(`The check on ${source.label} gave no result for ~/${unscanned.join(", ~/")}.`);
  const carry: CarriedSession[] = [];
  const refused: Hit[] = [];
  const warnings: string[] = [];
  for (const session of groupSessions(listed, scanned, sourceProject, targetProject)) {
    const files = session.files.map((file) => scanned.get(file.source)!);
    const hits = files.flatMap((file) => file.hits.map((hit) => ({ ...hit, path: `~/${hit.path}` })));
    // A name rule, a private key, or an executable refuses the session also with allowSecrets.
    const blocked = files.some((file) => file.blocked);
    if (hits.length === 0 || (input.allowSecrets && !blocked)) {
      carry.push({ ...session, secrets: [...new Set(hits.map((hit) => hit.reason))] });
      continue;
    }
    refused.push(...hits);
    const hint = input.allowSecrets || blocked ? "" : " Add --allow-secrets to carry it.";
    const what = session.id === null ? "the memory file" : "the session of";
    for (const hit of hits) warnings.push(`WARNING: Ferry skips ${what} ${hit.path} (${hit.reason}).${hint}`);
  }
  const sha256 = new Map([...scanned].flatMap(([path, file]) => (file.sha256 === null ? [] : [[path, file.sha256] as const])));
  return { carry, refused, warnings, sha256, sourceProject, targetProject };
}

/**
 * Write the staged session files into the destination home and verify each
 * one. A file there with the same path gets the source bytes. `secret` names
 * each session with secrets by the source path of its first file. Its files
 * get mode 600.
 */
async function carrySessions(
  destination: Side,
  stage: string,
  sessions: readonly Session[],
  secret: ReadonlySet<string>,
): Promise<void> {
  const files: Carried[] = sessions.flatMap((session) =>
    session.files.map((file) => ({
      path: file.target,
      sha256: createHash("sha256").update(readFileSync(join(stage, file.target))).digest("hex"),
      secrets: [],
    })),
  );
  if (files.length === 0) return;
  const modes = sessions.filter((session) => secret.has(session.files[0]!.source)).flatMap((session) => session.files);
  const archive = await createArchive(stage, files.map((file) => file.path));
  const chmod =
    modes.length > 0 ? ` && cd ${destination.home} && chmod 600 ${modes.map((file) => quoteShell(`./${file.target}`)).join(" ")}` : "";
  await must(
    destination.run(`tar -xf - -C ${destination.home}${chmod}`, { input: archive, timeoutMs: TRANSFER_TIMEOUT_MS }),
    `Ferry could not write the session files on ${destination.label}`,
  );
  const mismatched = await verify(destination, destination.home, files);
  if (mismatched.length > 0) throw new MoveError(`the checksum of ~/${mismatched.join(", ~/")} does not match`);
}

async function gitPreflight(source: Side, path: string, problems: string[], notes: string[]): Promise<GitSource | null> {
  const origin = await source.run(`cd ${path} && git remote get-url origin`, { timeoutMs: PROBE_TIMEOUT_MS });
  if (!origin.ok) {
    problems.push("The repository has no origin remote.");
    return null;
  }
  // A source box puts the marks in its output. For this machine, the same functions run here, before the URL goes to a box.
  const marked = redactUrlCredentials(redactTokens(origin.stdout.trim()));
  const url = marked
    .replace(`${CREDENTIAL_MARK}@`, "")
    .replace(/([?&#])[^=&#?]+=\[credential\](&?)/g, (_parameter, separator: string, next: string) => (next ? separator : ""));
  if (url.includes(CREDENTIAL_MARK) || url.includes(TOKEN_MARK)) {
    problems.push("The origin URL has a credential that Ferry cannot take out. Set an origin URL without a credential.");
    return null;
  }
  if (url !== marked) {
    notes.push("The origin URL has a credential. Ferry carries the URL without it, so the destination needs its own login for the clone.");
  }

  const remote = await source.run(
    `cd ${path} && git ls-remote --symref origin HEAD && git ls-remote --heads --tags origin`,
    { timeoutMs: NETWORK_TIMEOUT_MS },
  );
  if (!remote.ok) {
    problems.push(`Ferry could not read origin: ${redactUrlCredentials(remote.message)}`);
    return null;
  }
  const remoteShas = new Set<string>();
  const remoteBranches = new Set<string>();
  let defaultSha: string | null = null;
  for (const line of remote.stdout.split("\n")) {
    const [sha, ref] = line.split("\t");
    if (!sha || !ref || sha.startsWith("ref:")) continue;
    remoteShas.add(sha);
    if (ref === "HEAD") defaultSha = sha;
    if (ref.startsWith("refs/heads/")) remoteBranches.add(ref.slice("refs/heads/".length));
  }

  const state = await must(
    source.run(
      `cd ${path} && git status --porcelain --untracked-files=no && echo ${SECTION} && git stash list --format='%gd %s' && echo ${SECTION} && (git symbolic-ref -q --short HEAD || true)`,
      { timeoutMs: PROBE_TIMEOUT_MS },
    ),
    "Ferry could not read the git state",
  );
  const [changes = "", stashes = "", head = ""] = state.split(`${SECTION}\n`);
  for (const change of lines(changes)) problems.push(`Uncommitted change: ${change.trim()}. Commit or stash it.`);
  for (const stash of lines(stashes)) notes.push(`Stash ${stash} stays in the source copy. The clone does not have it.`);

  const log = await must(
    source.run(`cd ${path} && git log --topo-order --ignore-missing --stdin --branches HEAD --format='%H%x09%S%x09%s'`, {
      input: new TextEncoder().encode([...remoteShas].map((sha) => `^${sha}\n`).join("")),
      timeoutMs: PROBE_TIMEOUT_MS,
    }),
    "Ferry could not list the local commits",
  );
  const unpushed = new Map<string, { sha: string; subject: string }[]>();
  for (const line of lines(log)) {
    const [sha = "", ref = "", ...subject] = line.split("\t");
    const commits = unpushed.get(ref) ?? [];
    commits.push({ sha, subject: subject.join("\t") });
    unpushed.set(ref, commits);
  }
  // A commit that is not on origin passes when git cherry finds an equivalent patch on the default branch of
  // origin, when git merge-tree shows that the default branch has its changes (a squash merge), or when gh
  // finds a merged pull request with the branch tip as its head.
  let mergeTreeUnused = false;
  let ghUnused = false;
  for (const [ref, commits] of unpushed) {
    const cherry = defaultSha
      ? await source.run(`cd ${path} && git cherry ${defaultSha} ${quoteShell(ref)}`, { timeoutMs: PROBE_TIMEOUT_MS })
      : null;
    const equivalent = new Set(
      cherry?.ok ? lines(cherry.stdout).filter((line) => line.startsWith("- ")).map((line) => line.slice(2)) : [],
    );
    let left = commits.filter((commit) => !equivalent.has(commit.sha));
    const accepted: [number, string][] = [[commits.length - left.length, "git cherry finds an equivalent patch on origin"]];
    if (defaultSha && left.length > 0) {
      const merged = await mergedCommits(source, path, defaultSha, commits, remoteShas);
      if (merged === null) mergeTreeUnused = true;
      else {
        const count = left.length;
        left = left.filter((commit) => !merged.has(commit.sha));
        accepted.push([count - left.length, "git merge-tree shows that the default branch of origin has their changes"]);
      }
    }
    if (left.length > 0 && !ghUnused) {
      const pull = await mergedPull(source, path, url, ref);
      if (pull === null) ghUnused = true;
      else if (pull !== undefined) {
        accepted.push([left.length, `gh finds merged pull request #${pull} with the branch tip as its head`]);
        left = [];
      }
    }
    for (const [count, reason] of accepted) {
      if (count === 0) continue;
      notes.push(
        `Branch ${ref}: Ferry accepts ${count} ${count === 1 ? "commit that is" : "commits that are"} not on origin, because ${reason}.`,
      );
    }
    for (const commit of left) {
      const name = `${commit.sha.slice(0, 12)} "${commit.subject}"`;
      problems.push(`Branch ${ref} has commit ${name} that is not on origin. Push it. If an equivalent patch is on origin, run git fetch first.`);
    }
  }
  if (mergeTreeUnused) {
    notes.push(
      "Ferry could not compare branches with git merge-tree. It needs git 2.38 or later and the commit of the default branch of origin. Run git fetch.",
    );
  }
  if (ghUnused) notes.push("gh is missing or cannot read origin, so Ferry did not look for merged pull requests.");

  const branch = head.trim();
  // A branch name with a token does not go to the destination. A source box sends it with the mark.
  if (holdsToken(branch) || branch.includes(TOKEN_MARK)) {
    notes.push("The name of the branch has the form of a token. The clone uses the default branch.");
    return { url, branch: null };
  }
  if (branch && remoteBranches.has(branch)) return { url, branch };
  notes.push(
    branch
      ? `Branch ${branch} is not on origin. The clone uses the default branch.`
      : "HEAD is detached. The clone uses the default branch.",
  );
  return { url, branch: null };
}

/**
 * The commits not on origin that the default branch of origin already has: the ancestors of the newest
 * commit in `commits` that merges into `defaultSha` with no change to its tree. Null if git cannot do the
 * check, for example a git before 2.38 or no local copy of `defaultSha`.
 *
 * `git merge-tree --write-tree` writes the merged objects. The preflight must not write to the repository,
 * so git writes them to a temporary object directory and reads the repository objects as alternates.
 */
async function mergedCommits(
  source: Side,
  path: string,
  defaultSha: string,
  commits: readonly { sha: string }[],
  remoteShas: ReadonlySet<string>,
): Promise<Set<string> | null> {
  const base = quoteShell(defaultSha);
  const script = [
    `cd ${path} || exit 1`,
    "objects=$(git rev-parse --path-format=absolute --git-path objects) || { echo unavailable; exit 0; }",
    `tmp=$(mktemp -d) || exit 1`,
    `trap 'rm -rf "$tmp"' EXIT`,
    `export GIT_OBJECT_DIRECTORY="$tmp" GIT_ALTERNATE_OBJECT_DIRECTORIES="$objects"`,
    `want=$(git rev-parse --verify -q ${base}^{tree}) || { echo unavailable; exit 0; }`,
    `for c in ${commits.map((commit) => commit.sha).join(" ")}; do`,
    `  tree=$(git merge-tree --write-tree ${base} "$c" 2>/dev/null)`,
    "  case $? in",
    `    0) if [ "$tree" = "$want" ]; then git rev-list --ignore-missing --stdin "$c"; exit; fi ;;`,
    "    1) ;;",
    "    *) echo unavailable; exit 0 ;;",
    "  esac",
    "done",
  ].join("\n");
  const result = await source.run(script, {
    input: new TextEncoder().encode([...remoteShas].map((sha) => `^${sha}\n`).join("")),
    timeoutMs: PROBE_TIMEOUT_MS,
  });
  if (!result.ok || result.stdout.startsWith("unavailable")) return null;
  return new Set(lines(result.stdout));
}

/**
 * The number of a merged pull request whose head is the tip of `ref`, or undefined if gh finds none. Null if
 * gh is missing, cannot read origin, or does not answer in time.
 */
async function mergedPull(source: Side, path: string, url: string, ref: string): Promise<number | null | undefined> {
  const result = await source.run(
    `cd ${path} && tip=$(git rev-parse --verify ${quoteShell(`${ref}^{commit}`)}) && echo "$tip" && GH_PROMPT_DISABLED=1 gh pr list -R ${quoteShell(url)} --state merged --search "$tip" --json number,headRefOid`,
    { timeoutMs: GH_TIMEOUT_MS },
  );
  if (!result.ok) return null;
  const [tip, ...json] = result.stdout.split("\n");
  try {
    const pulls = JSON.parse(json.join("\n")) as { number: number; headRefOid: string }[];
    return pulls.find((pull) => pull.headRefOid === tip)?.number;
  } catch {
    return null;
  }
}

const X_SKIPPED = SKIPPED_NAMES.map((name) => `-x ${quoteShell(name.includes("/") ? `**/${name}` : name)}`).join(" ");
const FIND_SKIPPED = `\\( ${SKIPPED_NAMES.map((name) => (name.includes("/") ? `-path ${quoteShell(`*/${name}`)}` : `-name ${quoteShell(name)}`)).join(" -o ")} \\)`;
/**
 * The untracked and ignored files, then the skipped entries. Without
 * `--exclude-standard`, only the skip list excludes a file. An entry that ends
 * in `/` is a nested git repository.
 */
const GIT_LIST = `git ls-files -z --others ${X_SKIPPED} && printf '\\0${SECTION}\\0' && git ls-files -z --others --ignored --directory ${X_SKIPPED}`;
const FIND_LIST = `find . ${FIND_SKIPPED} -prune -o ! -type d -print0 && printf '\\0${SECTION}\\0' && find . -mindepth 1 ${FIND_SKIPPED} -prune -print0`;

/**
 * True when `path` matches an entry of `SKIPPED_NAMES`. For a skipped file name
 * such as `*.tsbuildinfo`, `git ls-files --directory` also lists its parent
 * directories.
 */
function isSkipped(path: string): boolean {
  return SKIPPED_NAMES.some((name) =>
    name.includes("/") ? path === name || path.endsWith(`/${name}`) : new Bun.Glob(name).match(posix.basename(path)),
  );
}

/** Copy `paths` under `path` on the source into a new local temporary directory. The source scan names the paths. */
async function fetchFiles(source: Side, path: string, paths: readonly string[]): Promise<string> {
  const stage = mkdtempSync(join(tmpdir(), "ferry-move-"));
  if (paths.length === 0) return stage;
  try {
    const encoded = await must(
      source.run(`cd ${path} && tar --null -cf - -T - | base64`, {
        input: nulList(paths),
        timeoutMs: TRANSFER_TIMEOUT_MS,
        raw: true,
      }),
      `Ferry could not read the local-only files on ${source.label}`,
    );
    const extracted = await exec(["tar", "-xf", "-", "-C", stage], { input: Buffer.from(encoded, "base64") });
    if (extracted.exitCode !== 0) throw new MoveError(`Ferry could not unpack the box files: ${extracted.stderr.trim()}`);
  } catch (error) {
    rmSync(stage, { recursive: true, force: true });
    throw error;
  }
  return stage;
}

/**
 * A tar archive of `paths` under `stage`. `COPYFILE_DISABLE` and `--no-xattrs`
 * keep macOS tar from adding `._*` AppleDouble entries and extended attributes.
 */
async function createArchive(stage: string, paths: readonly string[]): Promise<Uint8Array> {
  const result = await exec(["tar", "--null", "--no-xattrs", "-cf", "-", "-C", stage, "-T", "-"], {
    input: nulList(paths),
    env: { COPYFILE_DISABLE: "1" },
  });
  if (result.exitCode !== 0) throw new MoveError(`Ferry could not pack the files: ${result.stderr.trim()}`);
  return result.stdout;
}

/** The carried paths whose SHA-256 on the destination differs from the checked bytes. */
async function verify(destination: Side, path: string, carry: readonly Carried[]): Promise<string[]> {
  const output = await must(
    destination.run(
      `cd ${path} && if command -v sha256sum >/dev/null 2>&1; then xargs -0 sha256sum --; else xargs -0 shasum -a 256 --; fi`,
      { input: nulList(carry.map((file) => file.path)), timeoutMs: TRANSFER_TIMEOUT_MS },
    ),
    `Ferry could not compute checksums on ${destination.label}`,
  );
  // Both tools print one line for each file in input order. An escaped name starts with `\`.
  const sums = lines(output).map((line) => line.replace(/^\\/, "").slice(0, 64));
  return carry.filter((file, index) => sums[index] !== file.sha256).map((file) => file.path);
}

/**
 * Run `command` on a box and send its stdout and its stderr through `ferry
 * redact` there. The exit code is the code of the command.
 */
function redacted(command: string): string {
  return [
    'ferry_out=$(mktemp) && ferry_err=$(mktemp) || exit 1',
    `( ${command}\n) >"$ferry_out" 2>"$ferry_err"`,
    "ferry_rc=$?",
    '[ ! -s "$ferry_out" ] || "$HOME/.local/bin/ferry" redact <"$ferry_out" || ferry_rc=1',
    '[ ! -s "$ferry_err" ] || "$HOME/.local/bin/ferry" redact <"$ferry_err" >&2',
    'rm -f "$ferry_out" "$ferry_err"',
    'exit "$ferry_rc"',
  ].join("\n");
}

/** With `redact`, the box is the source: its output goes through `ferry redact`, except the file archive. */
function boxSide(link: Pick<Link, "run">, label: string, redact = false): Side {
  return {
    label,
    home: '"$HOME"',
    trash: '"$HOME"/.ferry/trash',
    async run(command, { raw, ...options } = {}) {
      const result = await link.run(redact && !raw ? redacted(command) : command, options);
      return result.ok ? { ok: true, stdout: result.stdout } : { ok: false, message: result.error.message };
    },
    scan: (request) => scanOnBox(link, label, request),
  };
}

function localSide(home: string, platform: NodeJS.Platform): Side {
  const quoted = quoteShell(home);
  return {
    label: "this machine",
    home: quoted,
    trash: platform === "darwin" ? `${quoted}/.Trash` : `${quoted}/.ferry/trash`,
    async run(command, options = {}) {
      const result = await exec(["sh", "-c", command], options);
      if (result.timedOut) return { ok: false, message: "the command timed out" };
      const stdout = Buffer.from(result.stdout).toString("utf8");
      if (result.exitCode === 0) return { ok: true, stdout };
      return { ok: false, message: result.stderr.trim() || stdout.trim() || `the command exited with ${result.exitCode}` };
    },
    // No hash leaves this machine in a scan, so the scan gives each hash at once.
    scan: async (request) => runScan((request.kind === "skill" ? request : { ...request, confirmed: true }) as typeof request, home),
  };
}

type ExecResult = { exitCode: number | null; stdout: Uint8Array; stderr: string; timedOut: boolean };

/** Run a local command with binary stdout. */
async function exec(
  argv: readonly string[],
  options: { readonly input?: Uint8Array; readonly env?: Record<string, string>; readonly timeoutMs?: number } = {},
): Promise<ExecResult> {
  const child = Bun.spawn([...argv], {
    stdin: options.input ?? "ignore",
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env, ...options.env },
  });
  const stdout = new Response(child.stdout).bytes();
  const stderr = new Response(child.stderr).text();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<"timeout">((done) => {
    timer = setTimeout(() => done("timeout"), options.timeoutMs ?? TRANSFER_TIMEOUT_MS);
  });
  const settled = await Promise.race([child.exited, timeout]);
  if (timer) clearTimeout(timer);
  if (settled === "timeout") child.kill();
  return {
    exitCode: settled === "timeout" ? null : settled,
    stdout: await stdout,
    stderr: await stderr,
    timedOut: settled === "timeout",
  };
}

async function must(result: Promise<SideResult>, context: string): Promise<string> {
  const settled = await result;
  if (!settled.ok) throw new MoveError(`${context}: ${settled.message}`);
  return settled.stdout;
}

function loadConfig(read: () => PartialOperatorConfig | null): PartialOperatorConfig {
  let config: PartialOperatorConfig | null;
  try {
    config = read();
  } catch {
    throw new ConfigMissingError("Could not read Ferry config. Run ferry init.");
  }
  if (!config) throw new ConfigMissingError("Ferry config has no complete host. Run ferry init.");
  return config;
}

/** `resolveTargetBox`, with an error that names `--to-box` instead of `--box`. */
function destinationTarget(config: PartialOperatorConfig, name: string | undefined): ResolvedBox {
  const names = resolveBoxes(config).map((box) => box.name);
  if (name === undefined && config.defaultBox === undefined && names.length > 1) {
    throw new BoxRequiredError(
      `More than one box is configured (${names.join(", ")}). Add --to-box <name>, or set default_box in the config.`,
    );
  }
  return resolveTargetBox(config, name);
}

function defaultDependencies(): MoveDependencies {
  return {
    readConfig,
    createLink: (options) => new Link(options),
    home: homedir(),
    cwd: process.cwd(),
    platform: process.platform,
    now: () => new Date(),
    writeLine: console.log,
    progress: noProgress,
    harnesses: BUILTIN_HARNESSES,
    integrations: INTEGRATIONS,
    interactive: process.stdin.isTTY === true && process.stdout.isTTY === true,
    confirm: (message) => prompts.confirm({ message, initialValue: false }),
  };
}

function entries(list: string): string[] {
  return list.split("\0").filter((entry) => entry !== "").map((entry) => entry.replace(/^\.\//, ""));
}

function lines(text: string): string[] {
  return text.split("\n").filter((line) => line.trim() !== "");
}

function nulList(paths: readonly string[]): Uint8Array {
  return new TextEncoder().encode(paths.map((path) => `${path}\0`).join(""));
}

function timestamp(date: Date): string {
  return date.toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z");
}

function quoteShell(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}
