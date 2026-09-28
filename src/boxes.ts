/** Select the boxes of the operator config, and merge the global values with the overrides of each box. */

import {
  ConfigError,
  completeHostConfig,
  type BoxConfig,
  type GitAuth,
  type IntegrationsConfig,
  type OperatorHostConfig,
  type PartialOperatorConfig,
  type ToolsConfig,
} from "./config.ts";

/** A box with its effective values. */
export type ResolvedBox = {
  readonly name: string;
  readonly host: OperatorHostConfig;
  /** `git_auth` of the box, or `"agent"`. */
  readonly gitAuth: GitAuth;
  /** `[integrations]`, with the keys of `[box.<name>.integrations]` on top. */
  readonly integrations: IntegrationsConfig;
  /**
   * `[tools]`, with the policies of `[box.<name>.tools]` on top. A box policy
   * for a `[tools.<id>]` table replaces its `version`. Use it where the code
   * uses the global `tools` today, for example with `toolPolicy`.
   */
  readonly tools: ToolsConfig;
};

/**
 * The selected boxes, in config order. An empty selection selects all boxes.
 * A `[host]` config has one box, named `default`. Commands that converge all
 * boxes (`sync`, `watch`, `status`, `update`) use this function. `default_box`
 * does not narrow their selection.
 */
export function resolveBoxes(config: PartialOperatorConfig, selection: readonly string[] = []): ResolvedBox[] {
  const boxes = configuredBoxes(config);
  const names = boxes.map((box) => box.name);
  const unknown = selection.find((name) => !names.includes(name));
  if (unknown !== undefined) throw new ConfigError(`unknown box ${unknown}. Known boxes: ${names.join(", ")}.`);
  return boxes
    .filter((box) => selection.length === 0 || selection.includes(box.name))
    .map((box) => resolveBox(config, box));
}

/**
 * The one box of a command that changes one box on purpose (`install`,
 * `auth`, `move`, `integrations enable|disable`). Without a name, it is
 * `default_box` or the only box. With more than one box and no
 * `default_box`, the operator must name a box.
 */
export function resolveTargetBox(config: PartialOperatorConfig, name?: string): ResolvedBox {
  const selected = name ?? config.defaultBox;
  const [box, ...others] = resolveBoxes(config, selected === undefined ? [] : [selected]);
  if (box && others.length === 0) return box;
  throw new ConfigError(
    `More than one box is configured (${configuredBoxes(config).map((known) => known.name).join(", ")}). ` +
      "Add --box <name>, or set default_box in the config.",
  );
}

function configuredBoxes(config: PartialOperatorConfig): readonly BoxConfig[] {
  if (config.boxes) return config.boxes;
  const host = completeHostConfig(config.host);
  if (!host) throw new ConfigError("Ferry config has no complete box. Run ferry init.");
  return [{ name: "default", host }];
}

function resolveBox(config: PartialOperatorConfig, box: BoxConfig): ResolvedBox {
  const tools: { [id: string]: ToolsConfig[string] } = { ...config.tools };
  for (const [id, policy] of Object.entries(box.tools ?? {})) {
    const entry = tools[id];
    tools[id] = entry === undefined || typeof entry === "string" ? policy : { ...entry, version: policy };
  }
  return {
    name: box.name,
    host: box.host,
    gitAuth: box.gitAuth ?? "agent",
    integrations: { ...config.integrations, ...box.integrations },
    tools,
  };
}

/** The deploy key of a `git_auth = "box"` box, relative to the box home. */
export const BOX_SNAPSHOT_KEY = ".ssh/ferry_snapshot";

/**
 * The `git` of a box command that reads the snapshot remote. With `"box"`,
 * `-c core.sshCommand` makes this one git command use the box deploy key and
 * no other identity. It does not write the setting to the box checkout.
 */
export function snapshotGit(gitAuth: GitAuth): string {
  return gitAuth === "box" ? `git -c core.sshCommand='ssh -i ~/${BOX_SNAPSHOT_KEY} -o IdentitiesOnly=yes'` : "git";
}
