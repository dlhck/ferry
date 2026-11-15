/**
 * The Ferry agent skills of this build. The binary embeds `skills/ferry/SKILL.md`
 * and `skills/ferry-messaging/SKILL.md`. `ferry init` writes the Ferry skill to
 * `~/.agents/skills/ferry`, a carried root, and `ferry self-update` writes the
 * skill of the new version. The messaging skill goes to
 * `~/.agents/skills/ferry-messaging` in the same way, but only on a machine
 * with agent messaging. Ferry does not change a skill folder that it did not
 * write: the operator changed it, or another tool manages it.
 */

import { createHash } from "node:crypto";
import { lstatSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { ownsSkills, type HarnessDescriptor } from "./registry/types.ts";
import BUNDLED_SKILL from "../skills/ferry/SKILL.md" with { type: "text" };
import MESSAGING_SKILL from "../skills/ferry-messaging/SKILL.md" with { type: "text" };

/** The skill folder, relative to the home. */
export const SKILL_RELATIVE_PATH = ".agents/skills/ferry";
/** The folder of the messaging skill, relative to the home. */
export const MESSAGING_SKILL_RELATIVE_PATH = ".agents/skills/ferry-messaging";
const STATE_RELATIVE_PATH = ".ferry/skill.json";

/**
 * `disabled` records `ferry init --no-skill`, for the Ferry skill only.
 * `written` and `messagingWritten` are the SHA-256 of the last SKILL.md that
 * Ferry wrote for each skill.
 */
type SkillState = {
  readonly disabled?: boolean;
  readonly written?: string;
  readonly messagingWritten?: string;
};

/** One bundled skill: its folder, its name in the messages, and the state key of its hash. */
type BundledSkill = {
  readonly relativePath: string;
  readonly label: string;
  readonly stateKey: "written" | "messagingWritten";
  readonly text: string;
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
  const statePath = join(input.home, STATE_RELATIVE_PATH);
  const state = readState(statePath);
  const enabled = input.enabled ?? state.disabled !== true;
  if (input.enabled !== undefined && input.enabled !== (state.disabled !== true)) {
    writeState(statePath, { ...state, disabled: !input.enabled });
  }
  if (!enabled) {
    return { action: "off", path: join(input.home, SKILL_RELATIVE_PATH), message: "Skipped the Ferry skill: ferry init --no-skill turned it off." };
  }
  return installSkill(
    { relativePath: SKILL_RELATIVE_PATH, label: "the Ferry skill", stateKey: "written", text: input.skill ?? BUNDLED_SKILL },
    input,
  );
}

/**
 * Write the bundled messaging skill with the rules of `installBundledSkill`.
 * `ferry messaging setup` calls it, and `ferry self-update` calls it on a
 * machine with agent messaging. `--no-skill` does not apply to it.
 */
export function installMessagingSkill(input: Omit<SkillInstallInput, "enabled">): SkillInstallResult {
  return installSkill(
    { relativePath: MESSAGING_SKILL_RELATIVE_PATH, label: "the Ferry messaging skill", stateKey: "messagingWritten", text: input.skill ?? MESSAGING_SKILL },
    input,
  );
}

function installSkill(bundled: BundledSkill, input: Pick<SkillInstallInput, "home" | "harnesses">): SkillInstallResult {
  const skill = bundled.text;
  const directory = join(input.home, bundled.relativePath);
  const display = `~/${bundled.relativePath}`;
  const statePath = join(input.home, STATE_RELATIVE_PATH);
  const state = readState(statePath);
  const name = basename(bundled.relativePath);
  const label = bundled.label.charAt(0).toUpperCase() + bundled.label.slice(1);

  const bundledHash = sha256(skill);
  const current = readSkillFolder(directory);
  if (current === null) {
    const other = input.harnesses
      .filter((harness) => ownsSkills(harness) && harness.skillRoot !== dirname(bundled.relativePath))
      .map((harness) => join(harness.skillRoot as string, name))
      .find((path) => exists(join(input.home, path)));
    if (other !== undefined) {
      return {
        action: "kept",
        path: directory,
        message: `Skipped ${bundled.label}: ~/${other} is a skill with the same name. Remove it to get the bundled skill at the next ferry init or ferry self-update.`,
      };
    }
  }
  if (current === "other") {
    return {
      action: "kept",
      path: directory,
      message: `Kept ${display}: it is not ${bundled.label} that Ferry wrote. Remove it to get the bundled skill at the next ferry init or ferry self-update.`,
    };
  }
  if (current !== null) {
    const currentHash = sha256(current);
    if (currentHash === bundledHash) {
      if (state[bundled.stateKey] !== bundledHash) writeState(statePath, { ...readState(statePath), [bundled.stateKey]: bundledHash });
      return { action: "unchanged", path: directory, message: `${label} in ${display} is current.` };
    }
    if (currentHash !== state[bundled.stateKey]) {
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
  writeState(statePath, { ...readState(statePath), [bundled.stateKey]: bundledHash });
  return current === null
    ? { action: "installed", path: directory, message: `Installed ${bundled.label} in ${display}.` }
    : { action: "updated", path: directory, message: `Updated ${bundled.label} in ${display}.` };
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
