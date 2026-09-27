/** Plan and commit one-way links from a target home into a store checkout. */

import {
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readlinkSync,
  renameSync,
  rmdirSync,
  statSync,
  symlinkSync,
  unlinkSync,
} from "node:fs";
import { dirname, join, posix, resolve } from "node:path";
import {
  RemoteTargetError,
  commitRemoteTarget,
  inspectRemoteTarget,
  type InspectedEntry,
  type InspectedPath,
  type TargetAction,
  type TargetInspection,
  type TargetInspectionRequest,
} from "./apply-remote.ts";
import type { Link } from "./link.ts";
import { CODEX_SYSTEM_SKILLS } from "./manifest.ts";
import { ownsSkills, type HarnessDescriptor } from "./registry/types.ts";

export type ApplyInput = {
  readonly checkout: string;
  readonly targetHome: string;
  /** The harnesses to link. Apply owns the plan, not the layout. */
  readonly harnesses: readonly HarnessDescriptor[];
  readonly force?: boolean;
  readonly dryRun?: boolean;
  /** Fixed value for reproducible plans. The default is the current UTC time. */
  readonly timestamp?: string;
};

export type RemoteApplyInput = ApplyInput & {
  readonly link: Pick<Link, "run">;
};

type LinkAction = {
  readonly harness: string;
  readonly path: string;
  readonly target: string;
};

export type ApplyAction =
  | ({ readonly kind: "create-symlink" } & LinkAction)
  | ({ readonly kind: "repair-symlink" } & LinkAction)
  | {
      readonly kind: "refuse-live-directory";
      readonly harness: string;
      readonly path: string;
    }
  | ({ readonly kind: "backup-and-link"; readonly backupPath: string } & LinkAction)
  | {
      readonly kind: "delete-managed-name";
      readonly harness: string;
      readonly path: string;
      readonly name: string;
    };

export type UnmanagedExtra = {
  readonly harness: string;
  readonly path: string;
  readonly name: string;
};

export type ApplyPlan = {
  readonly checkout: string;
  readonly targetHome: string;
  readonly actions: readonly ApplyAction[];
  readonly unmanaged: readonly UnmanagedExtra[];
};

export class ApplyError extends Error {
  readonly code: "refused" | "commit-failed";
  readonly harness: string;
  readonly path: string;

  constructor(
    code: "refused" | "commit-failed",
    harness: string,
    path: string,
    options?: ErrorOptions,
  ) {
    super(
      code === "refused"
        ? `${harness}: refusing live path ${path}`
        : `${harness}: failed to apply ${path}`,
      options,
    );
    this.name = "ApplyError";
    this.code = code;
    this.harness = harness;
    this.path = path;
  }
}

/** Read the local checkout and target home. This function does not write. */
export function planApply(input: ApplyInput): ApplyPlan {
  const checkout = resolve(input.checkout);
  const targetHome = resolve(input.targetHome);
  const timestamp = input.timestamp ?? currentTimestamp();
  const request = inspectionRequest(input.harnesses, checkout, targetHome, timestamp, join);
  return planInspection(
    input.harnesses,
    checkout,
    targetHome,
    input.force ?? false,
    timestamp,
    inspectLocalTarget(request),
    join,
  );
}

/** Commit a complete plan. A refusal stops all writes. */
export function commitApply(plan: ApplyPlan): void {
  refusePlan(plan);

  for (const action of plan.actions) {
    try {
      commitAction(action, plan.checkout);
    } catch (cause) {
      throw new ApplyError("commit-failed", action.harness, action.path, { cause });
    }
  }
}

/** Plan and apply to a local target, or to a remote target when Link is present. */
export function apply(input: RemoteApplyInput): Promise<ApplyPlan>;
export function apply(input: ApplyInput): ApplyPlan;
export function apply(input: ApplyInput | RemoteApplyInput): ApplyPlan | Promise<ApplyPlan> {
  if ("link" in input) return applyRemote(input);
  const plan = planApply(input);
  if (!input.dryRun) commitApply(plan);
  return plan;
}

async function applyRemote(input: RemoteApplyInput): Promise<ApplyPlan> {
  const checkout = posix.resolve(input.checkout);
  const targetHome = posix.resolve(input.targetHome);
  const timestamp = input.timestamp ?? currentTimestamp();
  const request = inspectionRequest(input.harnesses, checkout, targetHome, timestamp, posix.join);
  let inspection: TargetInspection;
  try {
    inspection = await inspectRemoteTarget(request, input.link);
  } catch (cause) {
    throw new ApplyError("commit-failed", "Remote target", targetHome, { cause });
  }
  const plan = planInspection(
    input.harnesses,
    checkout,
    targetHome,
    input.force ?? false,
    timestamp,
    inspection,
    posix.join,
  );
  if (input.dryRun) return plan;
  refusePlan(plan);

  const mutations = plan.actions.map((action) => targetAction(action, inspection));
  try {
    await commitRemoteTarget(mutations, input.link);
  } catch (cause) {
    const index = cause instanceof RemoteTargetError ? cause.actionIndex : undefined;
    const failed = index === undefined ? undefined : plan.actions[index];
    throw new ApplyError(
      "commit-failed",
      failed?.harness ?? "Remote target",
      failed?.path ?? targetHome,
      { cause },
    );
  }
  return plan;
}

function inspectionRequest(
  harnesses: readonly HarnessDescriptor[],
  checkout: string,
  targetHome: string,
  timestamp: string,
  joinPath: (...paths: string[]) => string,
): TargetInspectionRequest {
  return {
    storeSkills: joinPath(checkout, "skills"),
    instructions: joinPath(checkout, "AGENTS.md"),
    targetRoots: harnesses.flatMap((harness) =>
      harness.skillRoot
        ? [{
            root: joinPath(targetHome, harness.skillRoot),
            backupDirectory: backupDirectory(joinPath, targetHome, timestamp, harness.id),
          }]
        : [],
    ),
    instructionTargets: harnesses.flatMap((harness) =>
      harness.instructionFile
        ? [{
            path: joinPath(targetHome, harness.instructionFile),
            backupPath: joinPath(
              backupDirectory(joinPath, targetHome, timestamp, harness.id),
              nameOf(harness.instructionFile),
            ),
          }]
        : [],
    ),
    rootTargets: harnesses.flatMap((harness) =>
      (harness.extraRoots ?? []).map((root) => ({
        source: joinPath(checkout, "roots", root),
        path: joinPath(targetHome, root),
        backupPath: joinPath(backupDirectory(joinPath, targetHome, timestamp, harness.id), root),
      })),
    ),
  };
}

/** Backups live outside harness skill roots so harnesses never scan them. */
function backupDirectory(
  joinPath: (...paths: string[]) => string,
  targetHome: string,
  timestamp: string,
  harnessId: string,
): string {
  return joinPath(targetHome, ".ferry", "backups", timestamp, harnessId);
}

function nameOf(path: string): string {
  return path.split(/[\\/]/).at(-1)!;
}

function planInspection(
  harnesses: readonly HarnessDescriptor[],
  checkout: string,
  targetHome: string,
  force: boolean,
  timestamp: string,
  inspection: TargetInspection,
  joinPath: (...paths: string[]) => string,
): ApplyPlan {
  const storeSkills = joinPath(checkout, "skills");
  // An older snapshot can still hold the Codex system skills. Links to them are leftovers.
  const skillNames = inspection.skillNames.filter((name) => name !== CODEX_SYSTEM_SKILLS);
  const snapshotNames = new Set(skillNames);
  const actions: ApplyAction[] = [];
  const unmanaged: UnmanagedExtra[] = [];

  for (const harness of harnesses) {
    if (!harness.skillRoot) continue;
    const root = joinPath(targetHome, harness.skillRoot);
    const owns = ownsSkills(harness);
    const backups = backupDirectory(joinPath, targetHome, timestamp, harness.id);
    if (owns) {
      for (const name of skillNames) {
        planLink(
          harness.name,
          joinPath(root, name),
          joinPath(storeSkills, name),
          force,
          joinPath(backups, name),
          inspection,
          actions,
        );
      }
    }
    planRemovedNames(
      harness.name,
      root,
      storeSkills,
      snapshotNames,
      inspection.roots.get(root) ?? [],
      actions,
      unmanaged,
      joinPath,
      !owns,
    );
  }

  if (inspection.instructionExists) {
    const instructions = joinPath(checkout, "AGENTS.md");
    for (const harness of harnesses) {
      if (!harness.instructionFile) continue;
      planLink(
        harness.name,
        joinPath(targetHome, harness.instructionFile),
        instructions,
        force,
        joinPath(
          backupDirectory(joinPath, targetHome, timestamp, harness.id),
          nameOf(harness.instructionFile),
        ),
        inspection,
        actions,
      );
    }
  }

  // An extra root links whole. A root the checkout lacks stays as it is.
  for (const harness of harnesses) {
    for (const root of harness.extraRoots ?? []) {
      const source = joinPath(checkout, "roots", root);
      if (!inspection.rootSources.has(source)) continue;
      planLink(
        harness.name,
        joinPath(targetHome, root),
        source,
        force,
        joinPath(backupDirectory(joinPath, targetHome, timestamp, harness.id), root),
        inspection,
        actions,
      );
    }
  }

  return { checkout, targetHome, actions, unmanaged };
}

function planLink(
  harness: string,
  path: string,
  target: string,
  force: boolean,
  backupPath: string,
  inspection: TargetInspection,
  actions: ApplyAction[],
): void {
  const state = inspection.paths.get(path) ?? { kind: "missing" };
  if (state.kind === "missing") {
    actions.push({ kind: "create-symlink", harness, path, target });
    return;
  }
  if (state.kind === "symlink") {
    if (state.resolvedLink !== target) {
      actions.push({ kind: "repair-symlink", harness, path, target });
    }
    return;
  }
  if (state.kind === "empty-directory") {
    actions.push({ kind: "repair-symlink", harness, path, target });
    return;
  }
  if (!force) {
    actions.push({ kind: "refuse-live-directory", harness, path });
    return;
  }

  if ((inspection.paths.get(backupPath) ?? { kind: "missing" }).kind !== "missing") {
    throw new ApplyError("refused", harness, backupPath);
  }
  actions.push({ kind: "backup-and-link", harness, path, target, backupPath });
}

function planRemovedNames(
  harness: string,
  root: string,
  storeSkills: string,
  snapshotNames: ReadonlySet<string>,
  entries: readonly InspectedEntry[],
  actions: ApplyAction[],
  unmanaged: UnmanagedExtra[],
  joinPath: (...paths: string[]) => string,
  dropStoreLinks: boolean,
): void {
  for (const entry of entries) {
    if (snapshotNames.has(entry.name) && !dropStoreLinks) continue;
    const path = joinPath(root, entry.name);
    if (
      entry.state.kind === "symlink" &&
      entry.state.resolvedLink === joinPath(storeSkills, entry.name)
    ) {
      actions.push({ kind: "delete-managed-name", harness, path, name: entry.name });
    } else {
      unmanaged.push({ harness, path, name: entry.name });
    }
  }
}

function inspectLocalTarget(request: TargetInspectionRequest): TargetInspection {
  const skillNames = readdirSync(request.storeSkills, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort(compare);
  const paths = new Map<string, InspectedPath>();
  const roots = new Map<string, readonly InspectedEntry[]>();

  for (const root of request.targetRoots) {
    const entries = inspectLocalEntries(root.root);
    roots.set(root.root, entries);
    for (const entry of entries) paths.set(join(root.root, entry.name), entry.state);
    for (const name of skillNames) {
      paths.set(join(root.root, name), inspectLocalPath(join(root.root, name)));
      const backup = join(root.backupDirectory, name);
      paths.set(backup, inspectLocalPath(backup));
    }
  }
  if (existsSync(request.instructions)) {
    for (const target of request.instructionTargets) {
      paths.set(target.path, inspectLocalPath(target.path));
      paths.set(target.backupPath, inspectLocalPath(target.backupPath));
    }
  }
  const rootSources = new Set<string>();
  for (const target of request.rootTargets) {
    if (!isDirectory(target.source)) continue;
    rootSources.add(target.source);
    paths.set(target.path, inspectLocalPath(target.path));
    paths.set(target.backupPath, inspectLocalPath(target.backupPath));
  }
  return {
    skillNames,
    instructionExists: existsSync(request.instructions),
    rootSources,
    paths,
    roots,
  };
}

function inspectLocalEntries(root: string): readonly InspectedEntry[] {
  let names: string[];
  try {
    names = readdirSync(root).sort(compare);
  } catch (error) {
    if (isMissing(error) || isNotDirectory(error)) return [];
    throw error;
  }
  return names.map((name) => ({ name, state: inspectLocalPath(join(root, name)) }));
}

function inspectLocalPath(path: string): InspectedPath {
  let stat;
  try {
    stat = lstatSync(path);
  } catch (error) {
    if (isMissing(error) || isNotDirectory(error)) return { kind: "missing" };
    throw error;
  }
  if (stat.isSymbolicLink()) {
    return { kind: "symlink", link: readlinkSync(path), resolvedLink: resolvedLink(path) };
  }
  if (stat.isDirectory() && readdirSync(path).length === 0) return { kind: "empty-directory" };
  return { kind: "other" };
}

function targetAction(action: ApplyAction, inspection: TargetInspection): TargetAction {
  switch (action.kind) {
    case "create-symlink":
    case "repair-symlink":
      return { kind: action.kind, path: action.path, target: action.target };
    case "backup-and-link":
      return {
        kind: action.kind,
        path: action.path,
        target: action.target,
        backupPath: action.backupPath,
      };
    case "delete-managed-name": {
      const state = inspection.paths.get(action.path);
      return {
        kind: action.kind,
        path: action.path,
        expectedLink: state?.kind === "symlink" ? state.link : "",
      };
    }
    case "refuse-live-directory":
      throw new Error("refusal reached target commit");
  }
}

function refusePlan(plan: ApplyPlan): void {
  const refusal = plan.actions.find(
    (action): action is Extract<ApplyAction, { kind: "refuse-live-directory" }> =>
      action.kind === "refuse-live-directory",
  );
  if (refusal) throw new ApplyError("refused", refusal.harness, refusal.path);
}

function commitAction(action: ApplyAction, checkout: string): void {
  switch (action.kind) {
    case "create-symlink":
      mkdirSync(dirname(action.path), { recursive: true });
      symlinkSync(action.target, action.path);
      return;
    case "repair-symlink": {
      const stat = lstatSync(action.path);
      if (stat.isDirectory()) rmdirSync(action.path);
      else if (stat.isSymbolicLink()) unlinkSync(action.path);
      else throw new Error("path changed after planning");
      symlinkSync(action.target, action.path);
      return;
    }
    case "backup-and-link":
      mkdirSync(dirname(action.backupPath), { recursive: true });
      renameSync(action.path, action.backupPath);
      symlinkSync(action.target, action.path);
      return;
    case "delete-managed-name":
      if (
        !lstatSync(action.path).isSymbolicLink() ||
        resolvedLink(action.path) !== join(checkout, "skills", action.name)
      ) {
        throw new Error("managed link changed after planning");
      }
      unlinkSync(action.path);
      return;
    case "refuse-live-directory":
      return;
  }
}

function resolvedLink(path: string): string {
  return resolve(dirname(path), readlinkSync(path));
}

function currentTimestamp(): string {
  return new Date().toISOString().replaceAll(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
}

function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

function isMissing(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}

function isNotDirectory(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOTDIR";
}

function compare(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}
