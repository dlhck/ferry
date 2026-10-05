/** Publish the operator snapshot and apply it to the selected boxes. */

import { spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { linkSync, mkdirSync, readFileSync, renameSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { hostname, homedir } from "node:os";
import { basename, dirname, join, posix } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { apply as applyStore, type ApplyPlan, type RemoteApplyInput } from "./apply.ts";
import {
  BOX_IDENTITY,
  BOX_INSTRUCTIONS,
  boxInstructionsInput,
  readBoxInstructions,
  recordManagedPathsCommand,
  writeBoxFilesCommand,
} from "./box-identity.ts";
import {
  ConfigMissingError,
  readConfig as readOperatorConfig,
  resolveLinkOptions,
  type GitAuth,
  type OperatorConfig,
  type OperatorHostConfig,
  type PartialOperatorConfig,
} from "./config.ts";
import { hasNoBox, resolveBoxes, snapshotGit, type ResolvedBox } from "./boxes.ts";
import { carriedContentHits, denyRules, readSeed as readManifest, type StoreUpdate } from "./manifest.ts";
import { Link, type LinkOptions, type LinkResult, type RunOptions } from "./link.ts";
import {
  loadRegistry as loadEffectiveRegistry,
  offHarnesses,
  type Registry,
  type RegistryConfig,
} from "./registry/load.ts";
import type { HarnessDescriptor } from "./registry/types.ts";
import { openStore as openSnapshotStore, skillChanged, type PublishResult } from "./store.ts";
import { adoptPublishedSkills } from "./adopt.ts";
import { installBoxPlugins, mergeBoxSettings } from "./box-settings.ts";
import { registerBoxMcp } from "./box-mcp.ts";
import {
  carryAgentProfiles,
  boxPaseoPreferences,
  carryPaseoPreferences,
  profileName,
  readAgentProfiles,
  readPaseoPreferences,
  refreshUnit,
  UNIT_PLAN,
  type AgentProfile,
  type MetadataProvider,
  type PaseoPreferences,
} from "./integrations/paseo.ts";
import { carryPaseoPlugins, readPaseoPlugins, type PaseoPlugins } from "./integrations/paseo-plugins.ts";
import { carryPaseoProviders, readPaseoProviders, type PaseoProviders } from "./integrations/paseo-providers.ts";
import {
  carryPaseoTerminalProfiles,
  readPaseoTerminalProfiles,
  type PaseoTerminalProfiles,
} from "./integrations/paseo-terminal-profiles.ts";
import { denyRuleCause, FerryError, linkFailure } from "./errors.ts";
import { groupProgress, noProgress, plural, step, type Progress } from "./progress.ts";
import { boxPathDirs, profileBlockCommand } from "./tools/path.ts";

export type SyncInput = {
  readonly home?: string;
  readonly dryRun?: boolean;
  readonly force?: boolean;
  readonly message?: string;
  /** The names from `--box`. None selects all boxes. */
  readonly boxes?: readonly string[];
  /**
   * False skips the publish: the boxes update to the published tip. The watch
   * uses it for a box retry, when the snapshot already has the current identity.
   */
  readonly publish?: boolean;
  /** The command that runs the sync, for the lock files, such as `watch` or `revert`. The default is `sync`. */
  readonly command?: string;
};

export type SyncDependencies = {
  readonly readConfig?: (home: string) => SyncConfig | null;
  readonly loadRegistry?: typeof loadEffectiveRegistry;
  readonly readSeed?: typeof readManifest;
  readonly publisher?: () => string;
  readonly createLink?: (options: LinkOptions) => SyncLink;
  readonly openStore?: (
    remote: string,
    seed: Seed,
    options: SyncStoreOptions,
  ) => Promise<SyncStore>;
  /** Lock the box steps for one target. It fails at once when another sync holds the lock. */
  readonly acquireLock?: (home: string, host: string, box: string, command: string) => () => void;
  /** Lock the local store around the publish. It waits while another sync publishes. */
  readonly acquireStoreLock?: (home: string, command: string) => Promise<() => void>;
  readonly apply?: (input: RemoteApplyInput) => Promise<ApplyPlan>;
  readonly adopt?: typeof adoptPublishedSkills;
  readonly writePlan?: (plan: SyncPlan) => void;
  readonly writeLine?: (line: string) => void;
  /** Records a warning for the --json envelope. The warning line also goes to `writeLine`. */
  readonly warn?: (line: string) => void;
  readonly progress?: Progress;
};

type SyncConfig = PartialOperatorConfig & RegistryConfig;
type Seed = Extract<ReturnType<typeof readManifest>, { ok: true }>;
type SyncStoreOptions = {
  readonly home: string;
  readonly harnesses: readonly HarnessDescriptor[];
};

type SyncLink = {
  run(command: string, options?: RunOptions): Promise<LinkResult>;
};

type SyncStore = {
  readonly path: string;
  publish(seed: Seed, message?: string): Promise<PublishResult>;
};

export type SyncPlan = {
  readonly operator: string;
  readonly gitRemote: string;
  readonly box: string;
  readonly localCheckout: string;
  readonly remoteHome: string | null;
  readonly remoteCheckout: string | null;
  readonly message: string | null;
  readonly force: boolean;
  /** The per-box instruction file of this box on the operator machine. Not set when the file is missing or blank. */
  readonly boxInstructions?: string;
  /** Carried settings keys whose local value differs from the local store checkout. */
  readonly settingsChanges: readonly SettingsChange[];
  /** The carried MCP servers, as `harness/server`. */
  readonly mcpServers: readonly string[];
  /** Skills whose store copy the publish replaces with a real directory in one harness root. */
  readonly storeUpdates: readonly StoreUpdate[];
  /** The names of the local Paseo agent profiles, or `null` when the Paseo integration is off. */
  readonly paseoProfiles: readonly string[] | null;
  /** Managed Git and npm sources and local skip reasons, or null when Paseo is off. */
  readonly paseoPlugins?: PaseoPlugins | null;
  /** The local Paseo provider definitions and skip reasons, or null when Paseo is off. It never holds a value or a command. */
  readonly paseoProviders?: {
    readonly providers: readonly {
      readonly id: string;
      /** The names of the carried fields. */
      readonly fields: readonly string[];
      /** The model IDs of `models`, in order. */
      readonly models: readonly string[];
      /** True when a box that lacks the provider needs its command executable on the box PATH. */
      readonly command: boolean;
      readonly createBlocker: string | null;
    }[];
    readonly warnings: readonly string[];
  } | null;
  /** The set Paseo preferences, or null when Paseo is off. It holds the length of the shared instructions, never the text. */
  readonly paseoPreferences?: {
    readonly metadataProviders: readonly MetadataProvider[] | null;
    readonly appendSystemPromptLength: number | null;
    /** Null unless the box has `paseo_auto_archive = true` and the local config sets the value. */
    readonly autoArchiveAfterMerge: boolean | null;
  } | null;
  /**
   * The portable local Paseo terminal profiles and skip reasons, or null when Paseo is off or the
   * local config does not set the list. It never holds an argument.
   */
  readonly paseoTerminalProfiles?: {
    readonly profiles: readonly {
      readonly id: string;
      readonly name: string;
      readonly command: string;
      readonly argCount: number;
    }[];
    readonly warnings: readonly string[];
  } | null;
  /** The box PATH directories, relative to the home, for the `~/.profile` block and the Paseo unit. */
  readonly pathDirs: readonly string[];
  /** The harnesses whose agent CLI is off for the box. Apply removes only Ferry's links there. */
  readonly offHarnesses: readonly string[];
};

export type SettingsChange = { readonly harness: string; readonly keys: readonly string[] };

export type SyncResult = {
  readonly dryRun: boolean;
  readonly published: boolean;
  /** The plan of the first selected box. `boxes` has the plan of each box. */
  readonly plan: SyncPlan;
  /** The Apply plan of the first selected box. */
  readonly applyPlan?: ApplyPlan;
  /** Box checkout paths that the update discarded on the first selected box, relative to the checkout. */
  readonly discarded?: readonly string[];
  /** One result for each selected box, in config order. */
  readonly boxes: readonly BoxSyncResult[];
};

export type BoxSyncResult = {
  readonly name: string;
  readonly plan: SyncPlan;
  readonly applyPlan?: ApplyPlan;
  readonly discarded?: readonly string[];
  /** The step that failed on this box, and its error. */
  readonly failure?: { readonly step: string; readonly error: unknown };
  /** The reason Ferry did not connect to this box. The box left the config, or its target changed, during the sync. It is not a failure. */
  readonly skipped?: string;
};

export type SyncErrorCode =
  | "invalid-config"
  | "wrong-publisher"
  | "registry-failure"
  | "registry-refusal"
  | "manifest-failure"
  | "manifest-refusal"
  | "box-instructions-refusal"
  | "invalid-box-home"
  | "link-failure"
  | "concurrent-sync"
  | "lock-failure"
  | "publish-failure"
  | "remote-update-failure"
  | "apply-failure"
  | "box-failure";
export type SyncErrorOrigin = "operator" | "git remote" | "box";

export class SyncError extends Error {
  constructor(
    readonly code: SyncErrorCode,
    readonly origin: SyncErrorOrigin,
    message: string,
    options?: ErrorOptions,
  ) {
    super(`${origin}: ${message}`, options);
    this.name = "SyncError";
  }
}

/** One or more of the selected boxes failed. `results` has the result of each box. `published` is true when the publish made a commit. */
export class BoxesSyncError extends SyncError {
  constructor(
    readonly results: readonly BoxSyncResult[],
    readonly published: boolean,
  ) {
    const failed = results.filter((result) => result.failure !== undefined);
    super(
      "box-failure",
      "box",
      [
        `sync failed on ${failed.length} of ${plural(results.length, "box", "boxes")}.`,
        ...failed.map((result) => `[${result.name}] ${result.failure?.step}: ${messageOf(result.failure?.error)}`),
      ].join("\n"),
    );
    this.name = "BoxesSyncError";
  }
}

/** The number of boxes that sync at the same time. */
const BOX_LIMIT = 4;

/** Box steps without the Paseo steps: connect, update, box instructions, Apply, plugins, settings, MCP, PATH. */
const BOX_STEPS = 8;

export async function runSync(
  input: SyncInput,
  dependencies: SyncDependencies = {},
): Promise<SyncResult> {
  const home = input.home ?? homedir();
  const command = input.command ?? "sync";
  const progress = dependencies.progress ?? noProgress;
  const writeLine = dependencies.writeLine ?? console.log;
  const warn = (line: string) => {
    dependencies.warn?.(line);
    writeLine(line);
  };
  // The operator steps are the read, the publish, and the adopt.
  const operatorSteps = input.publish === false ? 2 : 3;
  progress.plan(input.dryRun ? 1 : operatorSteps + BOX_STEPS);
  const { config, registry, harnesses, seed, boxes } = await step(
    progress,
    "Reading the portable set",
    async () => {
      const source = inspectSyncSource(home, dependencies, input.boxes);
      await refuseChangedStoreCopies(home, source.config, source.seed);
      const profiles = source.boxes.some((box) => box.integrations.paseo === true) ? paseoProfiles(home) : null;
      let plugins: PaseoPlugins | null = null;
      let providers: PaseoProviders | null = null;
      let preferences: PaseoPreferences | null = null;
      let terminals: PaseoTerminalProfiles = null;
      try {
        if (profiles !== null) {
          plugins = readPaseoPlugins(home);
          providers = readPaseoProviders(home);
          preferences = readPaseoPreferences(home);
          terminals = readPaseoTerminalProfiles(home);
        }
      } catch (cause) {
        throw new SyncError("manifest-refusal", "operator", messageOf(cause), { cause });
      }
      // A box tools override changes only a version policy, so all boxes have the PATH directories of the registry.
      const pathDirs = pathDirsOf(source.registry);
      return {
        ...source,
        boxes: source.boxes.map((box) => ({
          ...box,
          profiles: box.integrations.paseo === true ? profiles : null,
          plugins: box.integrations.paseo === true ? plugins : null,
          providers: box.integrations.paseo === true ? providers : null,
          preferences: box.integrations.paseo === true && preferences !== null ? boxPaseoPreferences(preferences, box.integrations) : null,
          terminals: box.integrations.paseo === true ? terminals : null,
          pathDirs,
        })),
      };
    },
    undefined,
    (source) => plural(source.seed.skills.length, "skill"),
  );
  const planned = input.dryRun
    ? 1
    : boxes.reduce((total, box) => {
        const plugins = box.plugins;
        const pluginStep = plugins && (plugins.plugins.length > 0 || plugins.warnings.length > 0) ? 1 : 0;
        return total + BOX_STEPS + (box.profiles === null ? 0 : 2) + pluginStep +
          (hasProviders(box.providers) ? 1 : 0) + (hasPreferences(box.preferences) ? 1 : 0) +
          (hasTerminals(box.terminals) ? 1 : 0);
      }, operatorSteps);
  if (planned !== (input.dryRun ? 1 : operatorSteps + BOX_STEPS)) progress.plan(planned);
  for (const leftover of seed.leftovers) {
    const label = leftover.code === "hook-path" ? "hook" : leftover.code === "mcp-local" || leftover.code === "mcp-path" || leftover.code === "mcp-script" || leftover.code === "mcp-app-bundle" ? "MCP server" : null;
    if (!label) continue;
    warn(`Skipped ${label}: ${leftover.reason}: ${leftover.path}`);
  }

  // With one box, the output stays as before. With more boxes, each box line and step starts with `[<name>] `.
  const several = boxes.length > 1;
  const output = (box: SyncBox) => {
    const prefixed = (line: string) => (several ? line.split("\n").map((part) => `[${box.name}] ${part}`).join("\n") : line);
    const boxLine = (line: string) => writeLine(prefixed(line));
    return {
      progress: several ? groupProgress(progress, box.name) : progress,
      writeLine: boxLine,
      warn: (line: string) => warn(prefixed(line)),
      writePlan: dependencies.writePlan ?? ((plan: SyncPlan) => printPlan(plan, box.gitAuth, boxLine)),
    };
  };

  if (input.dryRun) {
    const results = boxes.map((box) => {
      const plan = makePlan(input, config, box, home, null, registry, seed, boxInstructions(home, box.name));
      output(box).writePlan(plan);
      return { name: box.name, plan };
    });
    return { dryRun: true, published: false, plan: results[0]!.plan, boxes: results };
  }

  for (const box of boxes) refuseActiveSync(home, box);
  // Without a publish, Ferry does not write the local store, and a null tip updates each box to the upstream tip.
  let storePath = join(home, ".ferry", "store");
  let publication: PublishResult = { published: false, tip: null };
  if (input.publish !== false) {
    try {
      ({ storePath, publication } = await step(
        progress,
        "Publishing the snapshot",
        async () => {
          const releaseStore = await takeStoreLock(dependencies, home, command);
          try {
            // A revert can change the files while this sync waits for the lock. Then the seed is old, and a publish would undo the revert.
            const current = (dependencies.readSeed ?? readManifest)(home, harnesses, { storeUpdates: true });
            if (!current.ok || current.identity !== seed.identity) {
              throw new SyncError(
                "publish-failure",
                "operator",
                "the portable set changed while the sync waited for the store; run the sync again",
              );
            }
            const store = dependencies.openStore
              ? await dependencies.openStore(config.snapshotUrl, seed, {
                  home,
                  harnesses: registry.harnesses,
                })
              : await openSnapshotStore(config.snapshotUrl, seed, {
                  home,
                  harnesses: registry.harnesses,
                });
            return { storePath: store.path, publication: await store.publish(seed, input.message) };
          } finally {
            releaseStore();
          }
        },
        undefined,
        ({ publication }) =>
          publication.published ? `published ${publication.tip?.slice(0, 7) ?? ""}`.trim() : "no changes",
      ));
    } catch (cause) {
      if (cause instanceof SyncError) throw cause;
      throw new SyncError(
        "publish-failure",
        "git remote",
        `failed to publish ${config.snapshotUrl}: ${messageOf(cause)}`,
        { cause },
      );
    }
    for (const update of seed.storeUpdates) {
      writeLine(`Updated store skill ${update.name} from ${update.path}`);
    }
  }

  /** Run the box steps on one box. A failure ends this box only. */
  const syncBox = async (box: SyncBox): Promise<BoxSyncResult> => {
    const { progress, writeLine, warn, writePlan } = output(box);
    let current = "Locking the box";
    const boxStep = <T>(
      name: string,
      work: () => T | Promise<T>,
      describe?: (result: T) => string | undefined,
    ): Promise<T> => {
      current = name;
      return step(progress, name, work, undefined, describe);
    };
    const target = { ...resolveLinkOptions(box.host), pathDirs: box.pathDirs };
    let plan = makePlan(input, config, box, home, null, registry, seed);
    try {
      current = "Reading the box instructions";
      const instructions = boxInstructions(home, box.name);
      current = "Locking the box";
      // Another sync for this box can take the box lock after refuseActiveSync. Then this box fails here, after the publish.
      const release = takeLock(dependencies, home, box, command);
      try {
        // `ferry box remove --uninstall` can remove the box while this sync waits in the publish. The config read is in the lock, so the box cannot leave after it.
        const skipped = staleBox(loadConfig(home, dependencies.readConfig ?? readOperatorConfig).source, box, "sync");
        if (skipped !== null) {
          progress.skip(`Connecting to ${targetLabel(box.host)}`, skipped);
          warn(`Warning: ${skipped}. Ferry did not connect to it.`);
          return { name: box.name, plan, skipped };
        }
        const link = dependencies.createLink?.(target) ?? new Link(target);
        const remoteHome = await boxStep(`Connecting to ${targetLabel(box.host)}`, () =>
          resolveRemoteHome(link, box.host),
        );
        plan = makePlan(input, config, box, home, remoteHome, registry, seed, instructions);
        writePlan(plan);
        const { applyPlan, discarded } = await applyOnBox({
          plan,
          box,
          instructions,
          link,
          publication,
          config,
          registry,
          seed,
          force: input.force === true,
          apply: dependencies.apply ?? applyStore,
          boxStep,
          progress,
          writeLine,
          warn,
        });
        return { name: box.name, plan, applyPlan, discarded };
      } finally {
        release();
      }
    } catch (error) {
      return { name: box.name, plan, failure: { step: current, error } };
    }
  };
  const results = await mapLimit(boxes, BOX_LIMIT, syncBox);
  const failed = results.filter((result) => result.failure !== undefined);

  // Adopt changes only the operator machine and needs only the publish, so it runs once, after all boxes end.
  try {
    await step(progress, "Adopting published local skills", () =>
      (dependencies.adopt ?? adoptPublishedSkills)(home, storePath, harnesses, seed),
    );
  } catch (cause) {
    const error = new SyncError(
      "apply-failure",
      "operator",
      `could not adopt a published local skill: ${messageOf(cause)}`,
      { cause },
    );
    if (failed.length === 0) throw error;
    warn(`Warning: ${error.message}`);
  }

  if (failed.length > 0) throw several ? new BoxesSyncError(results, publication.published) : failed[0]!.failure!.error;
  const first = results[0]!;
  return {
    dryRun: false,
    published: publication.published,
    plan: first.plan,
    applyPlan: first.applyPlan,
    discarded: first.discarded,
    boxes: results,
  };
}

/** A selected box with its Paseo profiles (`null` when Paseo is off for it) and its PATH directories. */
type SyncBox = ResolvedBox & {
  readonly profiles: readonly AgentProfile[] | null;
  readonly plugins: PaseoPlugins | null;
  readonly providers: PaseoProviders | null;
  readonly preferences: PaseoPreferences | null;
  readonly terminals: PaseoTerminalProfiles;
  readonly pathDirs: readonly string[];
};

function hasProviders(providers: PaseoProviders | null): providers is PaseoProviders {
  return providers !== null && (providers.providers.length > 0 || providers.warnings.length > 0);
}

function hasTerminals(terminals: PaseoTerminalProfiles): terminals is NonNullable<PaseoTerminalProfiles> {
  return terminals !== null && (terminals.profiles.length > 0 || terminals.warnings.length > 0);
}

function hasPreferences(preferences: PaseoPreferences | null): preferences is PaseoPreferences {
  return preferences !== null && Object.keys(preferences).length > 0;
}

/** The box steps after the connect: checkout update, Apply, plugins, settings, MCP, PATH, and Paseo. */
async function applyOnBox(context: {
  readonly plan: SyncPlan;
  readonly box: SyncBox;
  readonly instructions: BoxInstructions | null;
  readonly link: SyncLink;
  readonly publication: PublishResult;
  readonly config: SyncOperatorConfig;
  readonly registry: Registry;
  readonly seed: Seed;
  readonly force: boolean;
  readonly apply: (input: RemoteApplyInput) => Promise<ApplyPlan>;
  readonly boxStep: <T>(name: string, work: () => T | Promise<T>, describe?: (result: T) => string | undefined) => Promise<T>;
  readonly progress: Progress;
  readonly writeLine: (line: string) => void;
  readonly warn: (line: string) => void;
}): Promise<{ applyPlan: ApplyPlan; discarded: string[] }> {
  const { plan, box, instructions, link, publication, config, registry, seed, boxStep, progress, writeLine, warn } = context;
  const { profiles, pathDirs } = box;
  // An off agent gets no links, plugins, settings, or MCP servers. Apply removes Ferry's earlier links in its harness.
  const off = offHarnesses(registry, box.tools);
  const harnesses = registry.harnesses.filter((harness) => !off.includes(harness));
  const tools = registry.tools.filter((tool) => !off.some((harness) => harness.id === tool.id));
  const settings = seed.settings.filter((entry) => harnesses.some((harness) => harness.id === entry.harness));
  const update = await boxStep(
    "Updating the box checkout",
    async () => {
      const result = await link.run(
        remoteUpdateCommand(required(plan.remoteCheckout), config.snapshotUrl, publication.tip, box.gitAuth),
        box.gitAuth === "agent" ? { agentForwarding: "git" } : undefined,
      );
      if (!result.ok) {
        throw new SyncError(
          "remote-update-failure",
          "box",
          `failed to update ${plan.box} from ${config.snapshotUrl}: ${result.error.origin}/${result.error.code}: ${result.error.message}`,
          { cause: linkFailure(result.error) },
        );
      }
      return result;
    },
    (result) => {
      const discarded = changedPaths(result.stdout).length;
      return discarded > 0 ? `discarded ${plural(discarded, "box change")}` : undefined;
    },
  );
  const discarded = changedPaths(update.stdout);
  for (const path of discarded) {
    writeLine(`Discarded box change: ${posix.join(required(plan.remoteCheckout), path)}`);
  }

  // The instruction links of the box point at the generated file, so it must be there before Apply.
  await boxStep("Writing the box instructions", async () => {
    // The per-box text goes on the standard input, so it is not in the command line on the box.
    const result = await link.run(
      writeBoxFilesCommand(required(plan.remoteHome), required(plan.remoteCheckout), box.name, instructions !== null),
      instructions ? { input: boxInstructionsInput(instructions.bytes) } : undefined,
    );
    if (!result.ok) {
      throw new SyncError(
        "apply-failure",
        "box",
        `could not write ~/${BOX_INSTRUCTIONS} on ${plan.box}: ${result.error.origin}/${result.error.code}: ${result.error.message}`,
        { cause: linkFailure(result.error) },
      );
    }
  });
  if (instructions && seed.instructions === null) {
    warn(`Warning: Ferry did not apply ${instructions.path}, because this machine has no ~/AGENTS.md. The box gets no instruction file.`);
  }

  let applyPlan: ApplyPlan;
  try {
    applyPlan = await boxStep(
      "Applying the snapshot on the box",
      async () => {
        const applied = await context.apply({
          checkout: required(plan.remoteCheckout),
          targetHome: required(plan.remoteHome),
          harnesses,
          offHarnesses: off,
          force: context.force,
          dryRun: false,
          link,
        });
        // The box has no operator config, so ferry whoami on the box reads the paths from this record.
        const result = await link.run(
          recordManagedPathsCommand(required(plan.remoteHome), box.name, instructions !== null, applied.managed),
        );
        if (!result.ok) {
          throw new Error(
            `could not write ~/${BOX_IDENTITY}: ${result.error.origin}/${result.error.code}: ${result.error.message}`,
            { cause: linkFailure(result.error) },
          );
        }
        return applied;
      },
      (result) => plural(result.actions.length, "change"),
    );
  } catch (cause) {
    throw new SyncError(
      "apply-failure",
      "box",
      `Apply failed on ${plan.box}: ${messageOf(cause)}`,
      { cause },
    );
  }

  // Claude rewrites a marketplace entry when it adds one, so the merge runs last.
  try {
    const warnings = await boxStep(
      "Installing Claude plugins",
      () => installBoxPlugins({ settings, link, progress, gitAuth: box.gitAuth }),
      (warnings) => (warnings.length > 0 ? plural(warnings.length, "warning") : undefined),
    );
    for (const warning of warnings) warn(`Box plugins: ${warning}`);
    const merged = await boxStep(
      "Merging settings on the box",
      () =>
        mergeBoxSettings({
          remoteHome: required(plan.remoteHome),
          harnesses,
          settings,
          link,
        }),
      (result) => (result.warnings.length > 0 ? plural(result.warnings.length, "warning") : undefined),
    );
    for (const warning of merged.warnings) warn(`Box settings: ${warning}`);
  } catch (cause) {
    throw new SyncError(
      "apply-failure",
      "box",
      `could not apply the carried settings keys on ${plan.box}: ${messageOf(cause)}`,
      { cause },
    );
  }

  try {
    const warnings = await boxStep(
      "Declaring MCP servers",
      () =>
        registerBoxMcp({
          remoteHome: required(plan.remoteHome),
          harnesses,
          tools,
          mcp: seed.mcp,
          link,
          progress,
        }),
      (warnings) =>
        [plural(plan.mcpServers.length, "server"), warnings.length > 0 && plural(warnings.length, "warning")]
          .filter(Boolean)
          .join(", "),
    );
    for (const warning of warnings) warn(`Box MCP: ${warning}`);
  } catch (cause) {
    throw new SyncError(
      "apply-failure",
      "box",
      `could not declare the carried MCP servers on ${plan.box}: ${messageOf(cause)}`,
      { cause },
    );
  }

  await boxStep(
    "Writing the box PATH",
    async () => {
      const result = await link.run(profileBlockCommand(pathDirs));
      if (!result.ok) {
        throw new SyncError(
          "apply-failure",
          "box",
          `could not write the PATH block of ~/.profile on ${plan.box}: ${result.error.origin}/${result.error.code}: ${result.error.message}`,
          { cause: linkFailure(result.error) },
        );
      }
      return result.stdout.trim() === "unchanged" ? "no changes" : "updated ~/.profile";
    },
    (detail) => detail,
  );

  // The Paseo steps run last and only warn on failure, so the Paseo daemon never blocks the core sync.
  if (profiles !== null) {
    const plugins = box.plugins;
    if (plugins && (plugins.plugins.length > 0 || plugins.warnings.length > 0)) {
      try {
        const warnings = await boxStep("Carrying Paseo plugins", () => carryPaseoPlugins(link, plugins));
        for (const warning of warnings) warn(`Warning: ${warning}`);
      } catch (cause) {
        warn(`Warning: Ferry could not carry the Paseo plugins: ${messageOf(cause)}. The core sync is complete.`);
      }
    }
    // Provider definitions go before the profiles, so a profile can use a provider that this sync creates.
    const providers = box.providers;
    if (hasProviders(providers)) {
      try {
        const carry = await boxStep(
          "Carrying Paseo providers",
          () => carryPaseoProviders(link, providers),
          (carry) => [
            plural(carry.carried.length, "provider"),
            carry.warnings.length > 0 && `${carry.warnings.length} skipped`,
            carry.carried.length > 0 && !carry.changed && "no changes",
          ].filter(Boolean).join(", "),
        );
        for (const warning of carry.warnings) warn(`Warning: ${warning}`);
      } catch (cause) {
        warn(`Warning: Ferry could not carry the Paseo providers: ${messageOf(cause)}. The core sync is complete.`);
      }
    }
    try {
      const carry = await boxStep(
        "Carrying Paseo agent profiles",
        () => carryAgentProfiles(link, profiles),
        (carry) =>
          profiles.length === 0
            ? "no profiles"
            : [
                plural(carry.carried.length, "profile"),
                carry.warnings.length > 0 && `${carry.warnings.length} skipped`,
                carry.carried.length > 0 && !carry.changed && "no changes",
              ]
                .filter(Boolean)
                .join(", "),
      );
      for (const warning of carry.warnings) warn(`Warning: ${warning}`);
    } catch (cause) {
      warn(`Warning: Ferry could not carry the Paseo agent profiles: ${messageOf(cause)}. The sync is complete.`);
    }
    const preferences = box.preferences;
    if (hasPreferences(preferences)) {
      try {
        const carry = await boxStep(
          "Carrying Paseo preferences",
          () => carryPaseoPreferences(link, preferences),
          (carry) => (carry.changed ? "updated" : "no changes"),
        );
        for (const warning of carry.warnings) warn(`Warning: ${warning}`);
      } catch (cause) {
        warn(`Warning: Ferry could not carry the Paseo preferences: ${messageOf(cause)}. The sync is complete.`);
      }
    }
    // The command check uses the new unit PATH, so the terminal profiles go before the PATH refresh.
    const terminals = box.terminals;
    if (hasTerminals(terminals)) {
      try {
        const carry = await boxStep(
          "Carrying Paseo terminal profiles",
          () => carryPaseoTerminalProfiles(link, terminals, pathDirs),
          (carry) => [
            plural(carry.carried.length, "profile"),
            carry.warnings.length > 0 && `${carry.warnings.length} skipped`,
            carry.carried.length > 0 && !carry.changed && "no changes",
          ].filter(Boolean).join(", "),
        );
        for (const warning of carry.warnings) warn(`Warning: ${warning}`);
      } catch (cause) {
        warn(`Warning: Ferry could not carry the Paseo terminal profiles: ${messageOf(cause)}. The sync is complete.`);
      }
    }
    // The restart also applies the profiles, so it runs after the carry.
    try {
      const refresh = await boxStep(
        "Updating the Paseo unit",
        () => refreshUnit(link, pathDirs),
        (refresh) => refresh.detail,
      );
      if (refresh.note !== null) warn(refresh.note);
    } catch (cause) {
      warn(`Warning: Ferry could not update ferry-paseo.service: ${messageOf(cause)}. The sync is complete.`);
    }
  }
  return { applyPlan, discarded };
}

/** Run `work` for each item, with at most `limit` items at the same time. The results keep the item order. */
async function mapLimit<T, R>(items: readonly T[], limit: number, work: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const index = next++;
      results[index] = await work(items[index]!);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

/** Read the config, the registry, and the seed, and select the boxes. None in `selection` selects all boxes. */
export function inspectSyncSource(
  home: string,
  dependencies: Pick<SyncDependencies, "readConfig" | "loadRegistry" | "readSeed" | "publisher"> = {},
  selection: readonly string[] = [],
): {
  readonly config: SyncOperatorConfig;
  readonly boxes: readonly ResolvedBox[];
  readonly registry: Registry;
  /** The harnesses that Manifest reads on this machine: each harness that is on for at least one box of the config. */
  readonly harnesses: readonly HarnessDescriptor[];
  readonly seed: Seed;
} {
  const loadedConfig = loadConfig(home, dependencies.readConfig ?? readOperatorConfig);
  const config = loadedConfig.operator;
  let boxes: ResolvedBox[];
  try {
    boxes = resolveBoxes(loadedConfig.source, selection);
  } catch (cause) {
    throw new SyncError("invalid-config", "operator", messageOf(cause), { cause });
  }
  const currentPublisher = dependencies.publisher?.() ?? hostname();
  if (currentPublisher !== config.publisher) {
    throw new SyncError(
      "wrong-publisher",
      "operator",
      `configured publisher ${config.publisher} does not match this machine ${currentPublisher}`,
    );
  }
  const registry = resolveRegistry(loadedConfig.source, dependencies.loadRegistry ?? loadEffectiveRegistry);
  // The snapshot is the same for all boxes, so the selection does not change what Manifest reads.
  const everyBox = resolveBoxes(loadedConfig.source);
  const harnesses = registry.harnesses.filter((harness) =>
    everyBox.some((box) => !offHarnesses(registry, box.tools).includes(harness)),
  );
  let seed: ReturnType<typeof readManifest>;
  try {
    seed = (dependencies.readSeed ?? readManifest)(home, harnesses, { storeUpdates: true });
  } catch (cause) {
    throw new SyncError("manifest-failure", "operator", `Manifest could not read publisher ${config.publisher}: ${messageOf(cause)}`, { cause });
  }
  if (!seed.ok) {
    const details = [
      ...seed.clashes.map((clash) => `clash ${clash.name}: ${clash.paths.join(", ")}`),
      ...seed.forbidden.map((hit) => `${hit.reason}: ${hit.path}`),
    ];
    throw new SyncError(
      "manifest-refusal",
      "operator",
      `Manifest refused publisher ${config.publisher}: ${details.join("; ")}`,
      denyRuleCause(seed.forbidden),
    );
  }
  return { config, boxes, registry, harnesses, seed };
}

/**
 * A store update replaces the store copy, so the store copy must hold no
 * unpublished changes. Otherwise the update is a clash, as Manifest reports it
 * without store updates.
 */
async function refuseChangedStoreCopies(home: string, config: SyncOperatorConfig, seed: Seed): Promise<void> {
  const checkout = join(home, ".ferry", "store");
  const changed: string[] = [];
  for (const update of seed.storeUpdates) {
    let dirty: boolean;
    try {
      dirty = await skillChanged(checkout, update.name);
    } catch (cause) {
      throw new SyncError("manifest-failure", "operator", `could not read the store state of skill ${update.name}: ${messageOf(cause)}`, { cause });
    }
    if (dirty) {
      changed.push(
        `clash ${update.name}: ${update.path}, ${join(checkout, "skills", update.name)} (the store copy has unpublished changes)`,
      );
    }
  }
  if (changed.length > 0) {
    throw new SyncError("manifest-refusal", "operator", `Manifest refused publisher ${config.publisher}: ${changed.join("; ")}`);
  }
}

type BoxInstructions = NonNullable<ReturnType<typeof readBoxInstructions>>;

/**
 * Read the per-box instructions of one box. They get the deny rules of the
 * shared instructions and the private key rule. A hit refuses this box only,
 * with the file name and never the value.
 */
function boxInstructions(home: string, box: string): BoxInstructions | null {
  const instructions = readBoxInstructions(home, box);
  if (instructions === null) return null;
  const forbidden = carriedContentHits(instructions.path, instructions.bytes);
  if (forbidden.length === 0) return instructions;
  throw new SyncError(
    "box-instructions-refusal",
    "operator",
    `Manifest refused the instructions of box ${box}: ${forbidden.map((hit) => `${hit.reason}: ${hit.path}`).join("; ")}`,
    denyRuleCause(forbidden),
  );
}

/** Read the local Paseo agent profiles. A refused profile refuses the sync before it publishes. */
function paseoProfiles(home: string): readonly AgentProfile[] {
  try {
    return readAgentProfiles(home);
  } catch (cause) {
    throw new SyncError("manifest-refusal", "operator", messageOf(cause), { cause });
  }
}

function makePlan(
  input: SyncInput,
  config: SyncOperatorConfig,
  box: SyncBox,
  home: string,
  remoteHome: string | null,
  registry: Registry,
  seed: Seed,
  instructions: BoxInstructions | null = null,
): SyncPlan {
  const localCheckout = join(home, ".ferry", "store");
  const off = offHarnesses(registry, box.tools);
  const harnesses = registry.harnesses.filter((harness) => !off.includes(harness));
  const on = (entry: { readonly harness: string }) => harnesses.some((harness) => harness.id === entry.harness);
  return {
    operator: config.publisher,
    gitRemote: config.snapshotUrl,
    box: targetLabel(box.host),
    localCheckout,
    remoteHome,
    remoteCheckout: remoteHome ? posix.join(remoteHome, ".ferry", "store") : null,
    message: input.message ?? null,
    force: input.force === true,
    ...(instructions ? { boxInstructions: instructions.path } : {}),
    settingsChanges: settingsChanges(localCheckout, harnesses, seed),
    mcpServers: seed.mcp.filter(on).flatMap((entry) => entry.servers.map((server) => `${entry.harness}/${server.name}`)),
    storeUpdates: seed.storeUpdates,
    paseoProfiles: box.profiles === null ? null : box.profiles.map(profileName),
    paseoPlugins: box.plugins,
    paseoProviders: box.providers === null ? null : {
      providers: box.providers.providers.map((provider) => ({
        id: provider.id,
        fields: Object.keys(provider.fields),
        models: ((provider.fields.models ?? []) as { readonly id: string }[]).map((model) => model.id),
        command: provider.command !== null,
        createBlocker: provider.createBlocker,
      })),
      warnings: box.providers.warnings,
    },
    paseoPreferences: box.preferences === null ? null : {
      metadataProviders: box.preferences.metadataProviders ?? null,
      appendSystemPromptLength: box.preferences.appendSystemPrompt?.length ?? null,
      autoArchiveAfterMerge: box.preferences.autoArchiveAfterMerge ?? null,
    },
    paseoTerminalProfiles: box.terminals === null ? null : {
      profiles: box.terminals.profiles.map((profile) => ({
        id: profile.id,
        name: profile.name,
        command: profile.command,
        argCount: profile.args?.length ?? 0,
      })),
      warnings: box.terminals.warnings,
    },
    pathDirs: box.pathDirs,
    offHarnesses: off.map((harness) => harness.id),
  };
}

/**
 * Compare the carried settings keys of the seed with the last published ones
 * in the local store checkout. It reads local files only, so a dry run stays
 * offline. The box can differ from the store; sync replaces these keys there too.
 */
function settingsChanges(
  localCheckout: string,
  harnesses: readonly HarnessDescriptor[],
  seed: Seed,
): SettingsChange[] {
  const changes: SettingsChange[] = [];
  for (const entry of seed.settings) {
    const keys = harnesses.find((harness) => harness.id === entry.harness)?.settings?.keys ?? [];
    const local = JSON.parse(Buffer.from(entry.bytes).toString()) as Record<string, unknown>;
    let stored: Record<string, unknown> = {};
    try {
      stored = JSON.parse(readFileSync(join(localCheckout, "settings", `${entry.harness}.json`), "utf8"));
    } catch {
      // No published settings yet: every carried key the operator has is a change.
    }
    const changed = keys.filter((key) => JSON.stringify(local[key]) !== JSON.stringify(stored[key]));
    if (changed.length > 0) changes.push({ harness: entry.harness, keys: changed });
  }
  return changes;
}

function printPlan(plan: SyncPlan, gitAuth: GitAuth, writeLine: (line: string) => void): void {
  const remoteCheckout = plan.remoteCheckout ?? "$HOME/.ferry/store";
  const remoteHome = plan.remoteHome ?? "$HOME";
  writeLine(
    [
      "Sync plan:",
      `Operator: ${plan.operator}`,
      `Git remote: ${plan.gitRemote}`,
      `Box: ${plan.box}`,
      `Publish: ${plan.localCheckout} (${plan.message ?? "Store default message"})`,
      `Update: ${remoteCheckout} with git clone, or fetch and reset --hard to the pushed commit (box changes are discarded)`,
      gitAuth === "agent"
        ? "SSH agent forwarding: only for the box snapshot update and the Claude plugin installs"
        : "SSH agent forwarding: none (git_auth = box)",
      `Apply: ${remoteCheckout} -> ${remoteHome} (force: ${plan.force ? "yes" : "no"})`,
      ...(plan.boxInstructions === undefined
        ? []
        : [`Box instructions: ${plan.boxInstructions} -> ${remoteHome}/${BOX_INSTRUCTIONS}, between the Ferry header and the shared AGENTS.md`]),
      `Off harnesses: ${
        plan.offHarnesses.length === 0
          ? "none"
          : `${plan.offHarnesses.join(", ")}. Apply writes nothing there and removes only its own earlier links`
      }`,
      "Plugins: claude plugin marketplace add and install for the carried Claude declarations",
      "Settings: carried keys replace their box values; other box keys are kept",
      `Changed settings keys since the last publish: ${
        plan.settingsChanges.map((change) => `${change.harness}: ${change.keys.join(", ")}`).join("; ") ||
        "none"
      }`,
      `MCP servers: declare on the box, and keep the other box servers: ${plan.mcpServers.join(", ") || "none"}`,
      `Box PATH: ${plan.pathDirs.map((dir) => `~/${dir}`).join(", ")} -> the ferry block of ~/.profile${
        plan.paseoProfiles === null ? "" : UNIT_PLAN
      }`,
      `Store updates from a harness root: ${
        plan.storeUpdates.map((update) => `${update.name} (${update.path})`).join(", ") || "none"
      }`,
      ...(plan.paseoProfiles === null
        ? []
        : [
            plan.paseoProfiles.length === 0
              ? "Paseo agent profiles: no profiles"
              : `Paseo agent profiles: ${plan.paseoProfiles.join(", ")} -> box ~/.paseo/config.json daemon.agentProfiles, then paseo daemon reload. Ferry skips each profile whose provider is not available on the box.`,
          ]),
      ...(plan.paseoPlugins == null ? [] : [
        `Paseo plugins: ${plan.paseoPlugins.plugins.map((plugin) => `${plugin.id}@${plugin.kind === "git" ? plugin.commit : `npm:${plugin.packageName}@${plugin.version}`} (${plugin.enabled ? "enabled" : "disabled"})`).join(", ") || "none"}. Keep box-only plugins. Turn on the global plugin switch when an enabled plugin is current on the box, which also starts enabled box-only plugins. The box daemon needs Git access, and npm with registry access for npm plugins.`,
        ...plan.paseoPlugins.warnings,
      ]),
      ...(plan.paseoProviders == null ? [] : providerLines(plan.paseoProviders)),
      ...(plan.paseoPreferences == null ? [] : [preferencesLine(plan.paseoPreferences)]),
      ...(plan.paseoTerminalProfiles == null ? [] : terminalProfileLines(plan.paseoTerminalProfiles)),
      ...denyListLines(),
    ].join("\n"),
  );
}

/** The dry-run lines of the Paseo providers. They never hold a value or a command. */
function providerLines(plan: NonNullable<SyncPlan["paseoProviders"]>): string[] {
  const providers = plan.providers.map((provider) =>
    `${provider.id} (${provider.fields.map((field) =>
      field === "models" ? `models: ${provider.models.join(", ") || "none"}` : field).join(", ") || "no portable fields"})`);
  return [
    `Paseo providers: ${providers.join("; ") || "none"} -> merge into box ~/.paseo/config.json agents.providers, then paseo daemon reload. ` +
      "Keep box env, command, params, enabled, order, and box-only providers. " +
      "Create a provider that the box lacks only when it needs no env or params and its command executable is on the box PATH.",
    ...plan.providers.flatMap((provider) => provider.createBlocker === null ? [] :
      [`Paseo provider ${provider.id} is created only when the box defines it first: ${provider.createBlocker}.`]),
    ...plan.warnings,
  ];
}

/** The dry-run lines of the Paseo terminal profiles. They never hold an argument. */
function terminalProfileLines(plan: NonNullable<SyncPlan["paseoTerminalProfiles"]>): string[] {
  const profiles = plan.profiles.map((profile) => `${profile.name} (${profile.command}, ${plural(profile.argCount, "argument")})`);
  return [
    `Paseo terminal profiles: ${profiles.join(", ") || "none"} -> merge by ID into box ~/.paseo/config.json daemon.terminalProfiles, then paseo daemon reload. ` +
      "Keep box-only profiles, the Paseo defaults when the box has no list, and the other box fields of each profile. " +
      "Ferry skips each profile whose command is not on the PATH of ferry-paseo.service on the box.",
    ...plan.warnings,
  ];
}

/** The dry-run line of the Paseo preferences. It never holds the text of the shared instructions. */
function preferencesLine(preferences: NonNullable<SyncPlan["paseoPreferences"]>): string {
  const { metadataProviders: providers, appendSystemPromptLength: length, autoArchiveAfterMerge: autoArchive } = preferences;
  if (providers === null && length === null && autoArchive === null) return "Paseo preferences: none set locally. Ferry keeps the box values.";
  const fields = [
    providers !== null && `agents.metadataGeneration.providers ${
      providers.length === 0
        ? "[] (clears the box list)"
        : providers.map((entry) => `${entry.provider}${entry.model ? `/${entry.model}` : ""}${entry.thinkingOptionId ? ` (thinking ${entry.thinkingOptionId})` : ""}`).join(", ")
    }`,
    length !== null && `daemon.appendSystemPrompt ${
      length === 0 ? "empty (clears the box instructions)" : `${plural(length, "character")}, text not shown. It changes the instructions of each agent on the box`
    }`,
    autoArchive !== null && `daemon.autoArchiveAfterMerge ${autoArchive}`,
  ].filter(Boolean);
  return `Paseo preferences: ${fields.join("; ")} -> box ~/.paseo/config.json, then paseo daemon reload. Ferry skips each metadata provider that is not available on the box. An unset local field keeps the box value.`;
}

/** List the deny rules in the `ferry status` format. It reads no remote state. */
export function denyListLines(): string[] {
  return ["Deny list:", ...denyRules().map((rule) => `  ${rule.code}: ${rule.behavior} ${rule.description}`)];
}

/**
 * Clone the snapshot on the box when missing. Otherwise print the box changes, then reset the
 * existing checkout to the pushed commit and remove its untracked files, so the box never wins.
 */
export function remoteUpdateCommand(checkout: string, remote: string, tip: string | null, gitAuth: GitAuth = "agent"): string {
  const quotedCheckout = quoteShell(checkout);
  const quotedRemote = quoteShell(remote);
  const target = tip === null ? "@{upstream}" : tip;
  const git = snapshotGit(gitAuth);
  return [
    `if [ -d ${quoteShell(`${checkout}/.git`)} ]; then`,
    `${boxChangesCommand(checkout)} &&`,
    `${git} -C ${quotedCheckout} fetch --quiet &&`,
    `git -C ${quotedCheckout} reset --quiet --hard ${quoteShell(target)} &&`,
    `git -C ${quotedCheckout} clean --quiet --force -d;`,
    `else`,
    `mkdir -p ${quoteShell(posix.dirname(checkout))} && ${git} clone ${quotedRemote} ${quotedCheckout};`,
    `fi`,
  ].join(" ");
}

/** List modified and untracked files in the box checkout as NUL-separated porcelain output. */
export function boxChangesCommand(checkout: string): string {
  return `git -C ${quoteShell(checkout)} status --porcelain=v1 -z --untracked-files=all`;
}

/** Read the paths from `boxChangesCommand` output. */
export function changedPaths(stdout: string): string[] {
  const entries = stdout.split("\0");
  const paths: string[] = [];
  for (let index = 0; index < entries.length; index += 1) {
    const entry = entries[index]!;
    if (entry.length < 4) continue;
    paths.push(entry.slice(3));
    // A rename or copy entry is followed by its source path.
    if (entry[0] === "R" || entry[0] === "C") index += 1;
  }
  return paths.sort();
}

async function resolveRemoteHome(link: SyncLink, host: OperatorHostConfig): Promise<string> {
  const box = targetLabel(host);
  const result = await link.run(`printf '%s\\n' "$HOME"`);
  if (!result.ok) {
    throw new SyncError(
      "link-failure",
      result.error.origin === "operator" ? "operator" : "box",
      `failed to resolve home on ${box}: ${result.error.origin}/${result.error.code}: ${result.error.message}`,
      { cause: linkFailure(result.error) },
    );
  }
  const remoteHome = result.stdout.replace(/\r?\n$/, "");
  if (!posix.isAbsolute(remoteHome) || /[\r\n\0]/.test(remoteHome)) {
    throw new SyncError(
      "invalid-box-home",
      "box",
      `${box} returned an invalid absolute home path`,
    );
  }
  return remoteHome;
}

function takeLock(
  dependencies: SyncDependencies,
  home: string,
  box: Pick<ResolvedBox, "name" | "host">,
  command: string,
): () => void {
  const host = targetKey(box.host);
  try {
    return (dependencies.acquireLock ?? acquireSyncLock)(home, host, box.name, command);
  } catch (cause) {
    if (cause instanceof SyncError) throw cause;
    throw new SyncError("lock-failure", "operator", `could not lock sync for ${host}`, { cause });
  }
}

async function takeStoreLock(dependencies: SyncDependencies, home: string, command: string): Promise<() => void> {
  try {
    return await (dependencies.acquireStoreLock ?? acquireStoreLock)(home, command);
  } catch (cause) {
    throw new SyncError("lock-failure", "operator", "could not lock the local store", { cause });
  }
}

/**
 * Compare the box that a command read at its start with the box in `config`, which the command
 * read again in the box lock. Return the reason to skip the box, or null when the config has the
 * box with the same target and git auth. `command` names the command, such as `sync`.
 */
function staleBox(config: PartialOperatorConfig, box: Pick<ResolvedBox, "name" | "host" | "gitAuth">, command: string): string | null {
  const current = hasNoBox(config) ? undefined : resolveBoxes(config).find((entry) => entry.name === box.name);
  if (current === undefined) return `box ${box.name} left the config during the ${command}`;
  if (targetKey(current.host) !== targetKey(box.host) || current.gitAuth !== box.gitAuth) {
    return `box ${box.name} changed in the config during the ${command}`;
  }
  return null;
}

/** Fail before the publish when a live sync or another command holds the lock of the box. */
function refuseActiveSync(home: string, box: Pick<ResolvedBox, "name" | "host">): void {
  const owner = boxLockOwner(home, box);
  if (owner !== null) throw busyError(box.name, owner);
}

/** The path of the lock file of a box on this machine. */
export function boxLockFile(home: string, box: Pick<ResolvedBox, "host">): string {
  return boxLockPath(home, targetKey(box.host));
}

/** The key stays the target string, so a running watch of an earlier version and a new CLI share the lock. */
function boxLockPath(home: string, host: string): string {
  const digest = createHash("sha256").update(host).digest("hex").slice(0, 16);
  return join(home, ".ferry", `sync-${digest}.lock`);
}

/** The live process that holds a lock. */
export type LockOwner = {
  readonly pid: number;
  /** The command that holds the lock, such as `watch` or `update`. Null when a Ferry version before the command record wrote the lock. */
  readonly command: string | null;
  /**
   * True when the lock has no command and no process start. A Ferry version before 0.10.0 wrote
   * it, and Ferry keeps it while a process has the pid.
   */
  readonly earlierVersion: boolean;
  /**
   * True when the lock is of an earlier version and the process with the pid is not a Ferry
   * process, or Ferry cannot read its command. Then a different program has the pid of an owner
   * that stopped. Ferry still keeps the lock.
   */
  readonly otherProgram: boolean;
};

/** The live owner of the lock of a box, or null when no live process holds the lock. It only reads the lock. */
export function boxLockOwner(home: string, box: Pick<ResolvedBox, "host">): LockOwner | null {
  return liveOwner(boxLockFile(home, box));
}

function liveOwner(path: string): LockOwner | null {
  const lock = readLock(path);
  if (lock === null || staleLock(lock)) return null;
  const owner = lockOwner(lock);
  const command = owner?.command;
  // The command goes into a message, so Ferry reads only a short name.
  const named = typeof command === "string" && /^[a-z][a-z -]{0,39}$/.test(command);
  const pid = owner?.pid as number;
  const earlierVersion = !named && typeof owner?.start !== "string";
  return { pid, command: named ? command : null, earlierVersion, otherProgram: earlierVersion && ferryProcess(pid) === null };
}

/**
 * What the owner of the lock of box `box` does, such as `The watch service syncs box fsn1 now
 * (pid 1234).` `owner` is null when the owner released the lock before Ferry read it.
 */
export function lockOwnerLine(box: string, owner: LockOwner | null): string {
  if (owner === null) return `A sync or another Ferry command works on box ${box} now.`;
  const pid = `(pid ${owner.pid})`;
  if (owner.otherProgram) {
    return `The lock of an earlier Ferry version for box ${box} names pid ${owner.pid}, which another program has now, so the lock stays.`;
  }
  if (owner.earlierVersion) return `A process of an earlier Ferry version holds the lock of box ${box} ${pid}.`;
  if (owner.command === null) return `A sync or another Ferry command works on box ${box} now ${pid}.`;
  if (owner.command === "watch") return `The watch service syncs box ${box} now ${pid}.`;
  if (owner.command === "watch update") return `The watch service updates box ${box} now ${pid}.`;
  return `ferry ${owner.command} works on box ${box} now ${pid}.`;
}

/** The error of a command that did not get the lock of box `box`. The JSON error has `box` and `owner` in `details`. */
function busyError(box: string, owner: LockOwner | null): SyncError {
  const advice = owner?.otherProgram
    ? "Run ferry doctor for the fix."
    : owner?.earlierVersion
    ? "Wait for it to end, then try again. If the lock stays, run ferry watch install to start the watch service with this version, or stop that process."
    : owner?.command?.startsWith("watch")
      ? "Try again in a moment."
      : "Wait for it to end, then try again.";
  const message = `${lockOwnerLine(box, owner)} ${advice}`;
  return new SyncError("concurrent-sync", "operator", message, {
    cause: new FerryError("sync-busy", message, {
      ...(owner?.earlierVersion ? { hint: "Run ferry doctor. It gives the fix for the lock of an earlier Ferry version." } : {}),
      details: { box, owner },
    }),
  });
}

function acquireSyncLock(home: string, host: string, box: string, command: string): () => void {
  const path = boxLockPath(home, host);
  const release = tryLock(path, command);
  if (!release) throw busyError(box, liveOwner(path));
  return release;
}

/**
 * Take the box lock for a command that is not a sync, such as `ferry box
 * remove --uninstall`. `command` names the command in the lock file, such as
 * `box remove`. While the command holds the lock, a sync for the box fails
 * with `concurrent-sync`. Throws that error when a sync holds the lock.
 */
export function acquireBoxLock(home: string, box: Pick<ResolvedBox, "name" | "host">, command: string): () => void {
  return acquireSyncLock(home, targetKey(box.host), box.name, command);
}

/**
 * Why a command did not get the lock of a box. `busy` is true when a sync or another command
 * holds the lock. Then `owner` is the live owner, or null when it released the lock before Ferry
 * read it.
 */
export type BoxLockRefusal =
  | { readonly busy: false; readonly reason: string }
  | { readonly busy: true; readonly reason: string; readonly box: string; readonly owner: LockOwner | null };

/** Takes the lock of a box. Returns the function that releases the lock, or why the command must not change the box. */
export type BoxLocker = (box: Pick<ResolvedBox, "name" | "host" | "gitAuth">) => (() => void) | BoxLockRefusal;

/**
 * The box lock for a command that changes a box and is not a sync, such as
 * `ferry update`. The command reads the box, and then waits for the box or
 * for the operator. So the locker reads the config again in the lock. It
 * refuses a box that left the config or that has a new target or git auth.
 * `command` names the command in the reason, such as `update`. `owner` names
 * it in the lock file, such as `integrations enable`.
 *
 * While the command holds the lock, a sync for the box fails with
 * `concurrent-sync`, and `ferry box remove --uninstall` does not start.
 */
export function boxLocker(home: string, readConfig: () => PartialOperatorConfig | null, command: string, owner = command): BoxLocker {
  return (box) => {
    const release = tryLock(boxLockPath(home, targetKey(box.host)), owner);
    if (!release) {
      const holder = boxLockOwner(home, box);
      return { busy: true, reason: lockOwnerLine(box.name, holder).slice(0, -1), box: box.name, owner: holder };
    }
    let reason: string | null;
    try {
      reason = staleBox(readConfig() ?? {}, box, command);
    } catch (error) {
      release();
      throw error;
    }
    if (reason === null) return release;
    release();
    return { busy: false, reason };
  };
}

/** The error of a command for one box that did not get the lock of the box. */
export function boxLockError(refusal: BoxLockRefusal): Error {
  return refusal.busy
    ? busyError(refusal.box, refusal.owner)
    : new FerryError("refused", `${refusal.reason}. Ferry did not change the box.`);
}

/** Wait while another sync publishes. Only the publish holds this lock, so the wait is short. */
export async function acquireStoreLock(home: string, command: string): Promise<() => void> {
  const path = join(home, ".ferry", "store.lock");
  for (;;) {
    const release = tryLock(path, command);
    if (release) return release;
    await sleep(100);
  }
}

/** The start of this process, or `""` when it is not known. Ferry reads it for the first lock. */
let ownStart: string | undefined;

/**
 * Take the lock at `path`. Return `null` when a live process holds it, or when another process
 * replaces a stale lock at this time.
 *
 * The lock file has the pid and the start of its process, the command that holds the lock, and a
 * token. A claim has no command. A stale lock is the lock of
 * a process that stopped, or a file that is not a lock. A process makes a new lock with a hard
 * link, which fails when the lock exists. It replaces a stale lock in three steps:
 *
 * 1. It takes the claim of the stale lock. The claim is a lock, and its path has a digest of the
 *    content of the stale lock. Thus only one process at a time can replace that lock.
 * 2. It reads the lock again. If a different process replaced the lock, the content is different.
 * 3. It renames its file to `path`. The rename is atomic, so no process sees `path` without a lock.
 *
 * No step removes the lock file. Thus a process that read a stale lock cannot remove the live lock
 * that replaced it.
 */
function tryLock(path: string, command?: string): (() => void) | null {
  const token = randomUUID();
  const temporary = `${path}.${process.pid}.${token}`;
  mkdirSync(dirname(path), { recursive: true });
  ownStart ??= processStart(process.pid) ?? "";
  writeFileSync(temporary, JSON.stringify({ pid: process.pid, ...(ownStart ? { start: ownStart } : {}), ...(command ? { command } : {}), token }), { mode: 0o600 });
  try {
    for (;;) {
      try {
        linkSync(temporary, path);
        break;
      } catch (cause) {
        if (!isCode(cause, "EEXIST")) throw cause;
      }
      const lock = readLock(path);
      // The owner released the lock after the link failed.
      if (lock === null) continue;
      if (!staleLock(lock)) return null;
      const digest = createHash("sha256").update(lock).digest("hex").slice(0, 16);
      const releaseClaim = tryLock(`${path}.${digest}.claim`);
      if (!releaseClaim) return null;
      try {
        if (readLock(path) !== lock) continue;
        renameSync(temporary, path);
        break;
      } finally {
        releaseClaim();
      }
    }
  } finally {
    rmSync(temporary, { force: true });
  }
  // Only the owner removes a live lock, and no process replaces the lock of a live owner. Thus the
  // lock cannot change between the read and the unlink.
  return () => {
    const lock = readLock(path);
    if (lock !== null && lockOwner(lock)?.token === token) unlinkSync(path);
  };
}

/** The content of the lock file at `path`, or `null` when there is no file. */
function readLock(path: string): string | null {
  try {
    return readFileSync(path, "utf8");
  } catch (error) {
    if (isCode(error, "ENOENT")) return null;
    throw error;
  }
}

function lockOwner(
  lock: string,
): { readonly pid?: unknown; readonly start?: unknown; readonly command?: unknown; readonly token?: unknown } | null {
  try {
    const value: unknown = JSON.parse(lock);
    return typeof value === "object" ? value : null;
  } catch {
    return null;
  }
}

/**
 * True when no live process owns the lock with this content. A file that is empty or that is not
 * a lock has no owner: a process writes the full content before it makes the lock file.
 */
function staleLock(lock: string): boolean {
  const owner = lockOwner(lock);
  const pid = owner?.pid;
  if (typeof pid !== "number" || !Number.isInteger(pid) || pid <= 0) return true;
  try {
    process.kill(pid, 0);
  } catch (error) {
    return isCode(error, "ESRCH");
  }
  // A process has the pid. It is the owner only if it started when the owner started. A lock of
  // an earlier Ferry version has no start, and Ferry keeps it while a process has the pid.
  if (typeof owner?.start !== "string") return false;
  const start = processStart(pid);
  return start !== null && start !== owner.start;
}

/**
 * The start of the process `pid`, as a string that a later process with the same pid does not
 * have. `null` when the start is not known. Then the caller must not decide that the process stopped.
 */
function processStart(pid: number): string | null {
  try {
    if (process.platform === "linux") {
      // Field 22 of the stat file is the start in clock ticks after the boot. The boot id makes it
      // different after a restart of the machine. The command name in field 2 can have spaces.
      const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
      const ticks = stat.slice(stat.lastIndexOf(")") + 2).split(" ")[19];
      return ticks ? `${readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim()}:${ticks}` : null;
    }
    // macOS has no /proc. A fixed locale and time zone give the same text in each process.
    const ps = spawnSync("/bin/ps", ["-o", "lstart=", "-p", String(pid)], { encoding: "utf8", env: { LC_ALL: "C", TZ: "UTC" } });
    return ps.status === 0 && ps.stdout.trim() ? ps.stdout.trim() : null;
  } catch {
    return null;
  }
}

/** The command line of the process `pid`, as its arguments. `null` when Ferry cannot read it. */
function processCommand(pid: number): readonly string[] | null {
  try {
    if (process.platform === "linux") {
      const command = readFileSync(`/proc/${pid}/cmdline`, "utf8").split("\0").filter(Boolean);
      return command.length > 0 ? command : null;
    }
    const ps = spawnSync("/bin/ps", ["-o", "command=", "-p", String(pid)], { encoding: "utf8", env: { LC_ALL: "C" } });
    return ps.status === 0 && ps.stdout.trim() ? ps.stdout.trim().split(/\s+/) : null;
  } catch {
    return null;
  }
}

/**
 * The command line of the process `pid` when it is a Ferry process: the `ferry` binary, node with
 * the npm launcher, or bun with the Ferry `cli.ts`. `null` for another program, and when Ferry
 * cannot read the command.
 */
export function ferryProcess(pid: number): string | null {
  const command = processCommand(pid);
  if (command === null) return null;
  const [program = "", first = "", second = ""] = command;
  const runtime = basename(program);
  const script = first === "run" ? second : first;
  const ferry =
    runtime === "ferry" ||
    (/^node/.test(runtime) && /^ferry(\.js)?$/.test(basename(script))) ||
    (/^bun(\.[^.]+)?$/.test(runtime) &&
      (basename(script) === "ferry" || script === process.argv[1] || /(^|\/)ferry\/src\/cli\.ts$/.test(script)));
  return ferry ? command.join(" ") : null;
}

function quoteShell(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

function required(value: string | null): string {
  return value as string;
}

function messageOf(error: unknown): string {
  return error instanceof Error && error.message ? error.message : String(error);
}

function isCode(error: unknown, code: string): boolean {
  return error instanceof Error && "code" in error && error.code === code;
}

function loadConfig(
  home: string,
  read: (home: string) => SyncConfig | null,
): { readonly source: SyncConfig; readonly operator: SyncOperatorConfig } {
  try {
    const source = read(home);
    return { source: source ?? {}, operator: completeConfig(source) };
  } catch (cause) {
    if (cause instanceof SyncError) throw cause;
    throw new SyncError("invalid-config", "operator", `could not read Ferry config: ${messageOf(cause)}`, {
      cause,
    });
  }
}

function resolveRegistry(
  config: RegistryConfig,
  load: typeof loadEffectiveRegistry,
): Registry {
  let result: ReturnType<typeof loadEffectiveRegistry>;
  try {
    result = load(config);
  } catch (cause) {
    throw new SyncError(
      "registry-failure",
      "operator",
      `could not load the configured registry: ${messageOf(cause)}`,
      { cause },
    );
  }
  if (!result.ok) {
    throw new SyncError(
      "registry-refusal",
      "operator",
      `registry refused the operator config: ${result.problems
        .map((problem) => problem.reason)
        .join("; ")}`,
    );
  }
  return result;
}

function pathDirsOf(registry: Registry): readonly string[] {
  try {
    return boxPathDirs(registry.tools);
  } catch (cause) {
    throw new SyncError("registry-refusal", "operator", `registry refused the operator config: ${messageOf(cause)}`, { cause });
  }
}

/** The shared part of the config. Each box has its own host, integrations, and tools. */
type SyncOperatorConfig = Pick<OperatorConfig, "version" | "publisher" | "snapshotUrl">;

function completeConfig(config: PartialOperatorConfig | null): SyncOperatorConfig {
  // A config without a box passes. `resolveBoxes` refuses it with the message for it.
  if (config?.version !== 1 || !config.publisher || !config.snapshotUrl) {
    throw new SyncError("invalid-config", "operator", "Ferry config is incomplete. Run ferry init.", {
      cause: new ConfigMissingError("Ferry config is incomplete."),
    });
  }
  return { version: 1, publisher: config.publisher, snapshotUrl: config.snapshotUrl };
}

function targetLabel(host: OperatorHostConfig): string {
  return host.transport === "ssh" ? host.destination : `${host.sshUser}@${host.tailscale}`;
}

function targetKey(host: OperatorHostConfig): string {
  return `${host.transport === "ssh" ? "ssh" : "tailscale"}:${targetLabel(host)}`;
}
