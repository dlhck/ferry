/** Plan and commit one-way links from a target home into a store checkout. */

import {
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readlinkSync,
  renameSync,
  rmdirSync,
  symlinkSync,
  unlinkSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";

const SKILL_HARNESSES = [
  { name: "Shared agents", path: ".agents/skills" },
  { name: "Claude", path: ".claude/skills" },
  { name: "Codex", path: ".codex/skills" },
  { name: "Pi", path: ".pi/agent/skills" },
  { name: "Cursor Agent", path: ".cursor/skills" },
] as const;

const INSTRUCTION_TARGETS = [
  { name: "Home instructions", path: "AGENTS.md" },
  { name: "Claude", path: ".claude/CLAUDE.md" },
  { name: "Codex", path: ".codex/AGENTS.md" },
  { name: "Pi", path: ".pi/agent/AGENTS.md" },
] as const;

export type ApplyInput = {
  readonly checkout: string;
  readonly targetHome: string;
  readonly force?: boolean;
  readonly dryRun?: boolean;
  /** Fixed value for reproducible plans. The default is the current UTC time. */
  readonly timestamp?: string;
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

/** Read the checkout and target home. This function does not write. */
export function planApply(input: ApplyInput): ApplyPlan {
  const checkout = resolve(input.checkout);
  const targetHome = resolve(input.targetHome);
  const storeSkills = join(checkout, "skills");
  const skillNames = readdirSync(storeSkills, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort(compare);
  const snapshotNames = new Set(skillNames);
  const timestamp = input.timestamp ?? currentTimestamp();
  const actions: ApplyAction[] = [];
  const unmanaged: UnmanagedExtra[] = [];

  for (const harness of SKILL_HARNESSES) {
    const root = join(targetHome, harness.path);
    for (const name of skillNames) {
      planLink(
        harness.name,
        join(root, name),
        join(storeSkills, name),
        input.force ?? false,
        timestamp,
        actions,
      );
    }
    planRemovedNames(harness.name, root, storeSkills, snapshotNames, actions, unmanaged);
  }

  const instructions = join(checkout, "AGENTS.md");
  if (existsSync(instructions)) {
    for (const target of INSTRUCTION_TARGETS) {
      planLink(
        target.name,
        join(targetHome, target.path),
        instructions,
        input.force ?? false,
        timestamp,
        actions,
      );
    }
  }

  return { checkout, targetHome, actions, unmanaged };
}

/** Commit a complete plan. A refusal stops all writes. */
export function commitApply(plan: ApplyPlan): void {
  const refusal = plan.actions.find(
    (action): action is Extract<ApplyAction, { kind: "refuse-live-directory" }> =>
      action.kind === "refuse-live-directory",
  );
  if (refusal) throw new ApplyError("refused", refusal.harness, refusal.path);

  for (const action of plan.actions) {
    try {
      commitAction(action, plan.checkout);
    } catch (cause) {
      throw new ApplyError("commit-failed", action.harness, action.path, { cause });
    }
  }
}

/** Plan an apply and commit it unless the caller requests a dry-run. */
export function apply(input: ApplyInput): ApplyPlan {
  const plan = planApply(input);
  if (!input.dryRun) commitApply(plan);
  return plan;
}

function planLink(
  harness: string,
  path: string,
  target: string,
  force: boolean,
  timestamp: string,
  actions: ApplyAction[],
): void {
  let stat;
  try {
    stat = lstatSync(path);
  } catch (error) {
    if (isMissing(error) || isNotDirectory(error)) {
      actions.push({ kind: "create-symlink", harness, path, target });
      return;
    }
    throw error;
  }

  if (stat.isSymbolicLink()) {
    if (resolvedLink(path) !== target) {
      actions.push({ kind: "repair-symlink", harness, path, target });
    }
    return;
  }

  if (stat.isDirectory() && readdirSync(path).length === 0) {
    actions.push({ kind: "repair-symlink", harness, path, target });
    return;
  }

  if (!force) {
    actions.push({ kind: "refuse-live-directory", harness, path });
    return;
  }

  const backupPath = `${path}.ferry-backup-${timestamp}`;
  if (pathExists(backupPath)) {
    throw new ApplyError("refused", harness, backupPath);
  }
  actions.push({ kind: "backup-and-link", harness, path, target, backupPath });
}

function planRemovedNames(
  harness: string,
  root: string,
  storeSkills: string,
  snapshotNames: ReadonlySet<string>,
  actions: ApplyAction[],
  unmanaged: UnmanagedExtra[],
): void {
  let entries;
  try {
    entries = readdirSync(root, { withFileTypes: true });
  } catch (error) {
    if (isMissing(error) || isNotDirectory(error)) return;
    throw error;
  }

  for (const entry of entries.sort((a, b) => compare(a.name, b.name))) {
    if (snapshotNames.has(entry.name)) continue;
    const path = join(root, entry.name);
    if (entry.isSymbolicLink() && resolvedLink(path) === join(storeSkills, entry.name)) {
      actions.push({ kind: "delete-managed-name", harness, path, name: entry.name });
    } else {
      unmanaged.push({ harness, path, name: entry.name });
    }
  }
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

function pathExists(path: string): boolean {
  try {
    lstatSync(path);
    return true;
  } catch (error) {
    if (isMissing(error) || isNotDirectory(error)) return false;
    throw error;
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
