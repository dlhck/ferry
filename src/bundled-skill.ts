/**
 * The Ferry agent skill of this build. The binary embeds `skills/ferry/SKILL.md`.
 * `ferry init` writes it to `~/.agents/skills/ferry`, a carried root, and
 * `ferry self-update` writes the skill of the new version. Ferry does not
 * change a skill folder that it did not write: the operator changed it, or
 * another tool manages it.
 */

import { createHash } from "node:crypto";
import { lstatSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { ownsSkills, type HarnessDescriptor } from "./registry/types.ts";
import BUNDLED_SKILL from "../skills/ferry/SKILL.md" with { type: "text" };

/** The skill folder, relative to the home. */
export const SKILL_RELATIVE_PATH = ".agents/skills/ferry";
const STATE_RELATIVE_PATH = ".ferry/skill.json";

/** `disabled` records `ferry init --no-skill`. `written` is the SHA-256 of the last SKILL.md that Ferry wrote. */
type SkillState = {
  readonly disabled?: boolean;
  readonly written?: string;
};

export type SkillInstallAction = "installed" | "updated" | "unchanged" | "kept" | "off";

export type SkillInstallResult = {
  readonly action: SkillInstallAction;
  readonly path: string;
  readonly message: string;
};

export type SkillInstallInput = {
  readonly home: string;
  /** The harnesses whose skill roots Ferry reads. A skill named ferry in another root would clash. */
  readonly harnesses: readonly HarnessDescriptor[];
  /** Set by `ferry init`, which records the choice. Without it, Ferry reads the recorded choice. */
  readonly enabled?: boolean;
  /** The skill text. The default is the skill of this build. */
  readonly skill?: string;
};

/** Write the bundled skill unless the operator turned it off or the folder has other content. */
export function installBundledSkill(input: SkillInstallInput): SkillInstallResult {
  const skill = input.skill ?? BUNDLED_SKILL;
  const directory = join(input.home, SKILL_RELATIVE_PATH);
  const display = `~/${SKILL_RELATIVE_PATH}`;
  const statePath = join(input.home, STATE_RELATIVE_PATH);
  const state = readState(statePath);
  const enabled = input.enabled ?? state.disabled !== true;
  if (input.enabled !== undefined && input.enabled !== (state.disabled !== true)) {
    writeState(statePath, { ...state, disabled: !input.enabled });
  }
  if (!enabled) {
    return { action: "off", path: directory, message: "Skipped the Ferry skill: ferry init --no-skill turned it off." };
  }

  const bundledHash = sha256(skill);
  const current = readSkillFolder(directory);
  if (current === null) {
    const other = input.harnesses
      .filter((harness) => ownsSkills(harness) && harness.skillRoot !== dirname(SKILL_RELATIVE_PATH))
      .map((harness) => join(harness.skillRoot as string, "ferry"))
      .find((path) => exists(join(input.home, path)));
    if (other !== undefined) {
      return {
        action: "kept",
        path: directory,
        message: `Skipped the Ferry skill: ~/${other} is a skill with the same name. Remove it to get the bundled skill at the next ferry init or ferry self-update.`,
      };
    }
  }
  if (current === "other") {
    return {
      action: "kept",
      path: directory,
      message: `Kept ${display}: it is not the Ferry skill that Ferry wrote. Remove it to get the bundled skill at the next ferry init or ferry self-update.`,
    };
  }
  if (current !== null) {
    const currentHash = sha256(current);
    if (currentHash === bundledHash) {
      if (state.written !== bundledHash) writeState(statePath, { ...readState(statePath), written: bundledHash });
      return { action: "unchanged", path: directory, message: `The Ferry skill in ${display} is current.` };
    }
    if (currentHash !== state.written) {
      return {
        action: "kept",
        path: directory,
        message: `Kept ${display}: it has local changes. Remove it to get the bundled skill at the next ferry init or ferry self-update.`,
      };
    }
  }
  // The folder can be a link into the store. Ferry writes through it, and the next sync publishes the change.
  mkdirSync(directory, { recursive: true });
  writeFileSync(join(directory, "SKILL.md"), skill);
  writeState(statePath, { ...readState(statePath), written: bundledHash });
  return current === null
    ? { action: "installed", path: directory, message: `Installed the Ferry skill in ${display}.` }
    : { action: "updated", path: directory, message: `Updated the Ferry skill in ${display}.` };
}

/** The SKILL.md text, null when the folder is missing, or "other" when the folder has more or other entries. */
function readSkillFolder(directory: string): string | "other" | null {
  if (!exists(directory)) return null;
  try {
    if (!statSync(directory).isDirectory()) return "other";
    const entries = readdirSync(directory);
    if (entries.length === 0) return null;
    if (entries.length !== 1 || entries[0] !== "SKILL.md") return "other";
    const file = join(directory, "SKILL.md");
    if (!statSync(file).isFile()) return "other";
    return readFileSync(file, "utf8");
  } catch {
    return "other";
  }
}

function exists(path: string): boolean {
  try {
    lstatSync(path);
    return true;
  } catch {
    return false;
  }
}

function sha256(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

function readState(path: string): SkillState {
  try {
    const state = JSON.parse(readFileSync(path, "utf8")) as SkillState;
    return typeof state === "object" && state !== null ? state : {};
  } catch {
    return {};
  }
}

function writeState(path: string, state: SkillState): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(state)}\n`);
}
