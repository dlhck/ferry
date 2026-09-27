/** Publish the operator snapshot and apply it to the configured box. */

import { createHash, randomUUID } from "node:crypto";
import { linkSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { hostname, homedir } from "node:os";
import { dirname, join, posix } from "node:path";
import { apply as applyStore, type ApplyPlan, type RemoteApplyInput } from "./apply.ts";
import {
  completeHostConfig,
  readConfig as readOperatorConfig,
  resolveLinkOptions,
  type OperatorConfig,
  type PartialOperatorConfig,
} from "./config.ts";
import { readSeed as readManifest } from "./manifest.ts";
import { Link, type LinkOptions, type LinkResult, type RunOptions } from "./link.ts";
import {
  loadRegistry as loadEffectiveRegistry,
  type Registry,
  type RegistryConfig,
} from "./registry/load.ts";
import type { HarnessDescriptor } from "./registry/types.ts";
import { openStore as openSnapshotStore, type PublishResult } from "./store.ts";
import { adoptPublishedSkills } from "./adopt.ts";
import { installBoxPlugins, mergeBoxSettings } from "./box-settings.ts";

export type SyncInput = {
  readonly home?: string;
  readonly dryRun?: boolean;
  readonly force?: boolean;
  readonly message?: string;
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
  readonly acquireLock?: (home: string, host: string) => () => void;
  readonly apply?: (input: RemoteApplyInput) => Promise<ApplyPlan>;
  readonly adopt?: typeof adoptPublishedSkills;
  readonly writePlan?: (plan: SyncPlan) => void;
  readonly writeLine?: (line: string) => void;
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
  /** Carried settings keys whose local value differs from the local store checkout. */
  readonly settingsChanges: readonly SettingsChange[];
};

export type SettingsChange = { readonly harness: string; readonly keys: readonly string[] };

export type SyncResult = {
  readonly dryRun: boolean;
  readonly published: boolean;
  readonly plan: SyncPlan;
  readonly applyPlan?: ApplyPlan;
  /** Box checkout paths that the update discarded, relative to the checkout. */
  readonly discarded?: readonly string[];
};

export type SyncErrorCode =
  | "invalid-config"
  | "wrong-publisher"
  | "registry-failure"
  | "registry-refusal"
  | "manifest-failure"
  | "manifest-refusal"
  | "invalid-box-home"
  | "link-failure"
  | "concurrent-sync"
  | "lock-failure"
  | "publish-failure"
  | "remote-update-failure"
  | "apply-failure";
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

export async function runSync(
  input: SyncInput,
  dependencies: SyncDependencies = {},
): Promise<SyncResult> {
  const home = input.home ?? homedir();
  const { config, registry, seed } = inspectSyncSource(home, dependencies);
  for (const leftover of seed.leftovers) {
    if (leftover.code !== "hook-path") continue;
    (dependencies.writeLine ?? console.log)(`Skipped hook: ${leftover.reason}: ${leftover.path}`);
  }

  if (input.dryRun) {
    const plan = makePlan(input, config, home, null, registry, seed);
    (dependencies.writePlan ?? printPlan)(plan);
    return { dryRun: true, published: false, plan };
  }

  const target = resolveLinkOptions(config.host);
  const link = dependencies.createLink?.(target) ?? new Link(target);
  const remoteHome = await resolveRemoteHome(link, config);
  const plan = makePlan(input, config, home, remoteHome, registry, seed);
  (dependencies.writePlan ?? printPlan)(plan);

  const release = takeLock(dependencies, home, targetKey(config));
  try {
    let store: SyncStore;
    let publication: PublishResult;
    try {
      store = dependencies.openStore
        ? await dependencies.openStore(config.snapshotUrl, seed, {
            home,
            harnesses: registry.harnesses,
          })
        : await openSnapshotStore(config.snapshotUrl, seed, {
            home,
            harnesses: registry.harnesses,
          });
      publication = await store.publish(seed, input.message);
    } catch (cause) {
      throw new SyncError(
        "publish-failure",
        "git remote",
        `failed to publish ${config.snapshotUrl}: ${messageOf(cause)}`,
        { cause },
      );
    }

    const update = await link.run(
      remoteUpdateCommand(required(plan.remoteCheckout), config.snapshotUrl, publication.tip),
      { agentForwarding: "git" },
    );
    if (!update.ok) {
      throw new SyncError(
        "remote-update-failure",
        "box",
        `failed to update ${plan.box} from ${config.snapshotUrl}: ${update.error.origin}/${update.error.code}: ${update.error.message}`,
      );
    }
    const discarded = changedPaths(update.stdout);
    for (const path of discarded) {
      (dependencies.writeLine ?? console.log)(
        `Discarded box change: ${posix.join(required(plan.remoteCheckout), path)}`,
      );
    }

    let applyPlan: ApplyPlan;
    try {
      applyPlan = await (dependencies.apply ?? applyStore)({
        checkout: required(plan.remoteCheckout),
        targetHome: required(plan.remoteHome),
        harnesses: registry.harnesses,
        force: input.force === true,
        dryRun: false,
        link,
      });
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
      const warnings = await installBoxPlugins({ settings: seed.settings, link });
      for (const warning of warnings) (dependencies.writeLine ?? console.log)(`Box plugins: ${warning}`);
      await mergeBoxSettings({
        remoteHome: required(plan.remoteHome),
        harnesses: registry.harnesses,
        settings: seed.settings,
        link,
      });
    } catch (cause) {
      throw new SyncError(
        "apply-failure",
        "box",
        `could not apply the carried settings keys on ${plan.box}: ${messageOf(cause)}`,
        { cause },
      );
    }

    try {
      (dependencies.adopt ?? adoptPublishedSkills)(home, store.path, registry.harnesses, seed);
    } catch (cause) {
      throw new SyncError(
        "apply-failure",
        "operator",
        `could not adopt a published local skill: ${messageOf(cause)}`,
        { cause },
      );
    }

    return { dryRun: false, published: publication.published, plan, applyPlan, discarded };
  } finally {
    release();
  }
}

export function inspectSyncSource(
  home: string,
  dependencies: Pick<SyncDependencies, "readConfig" | "loadRegistry" | "readSeed" | "publisher"> = {},
): { readonly config: OperatorConfig; readonly registry: Registry; readonly seed: Seed } {
  const loadedConfig = loadConfig(home, dependencies.readConfig ?? readOperatorConfig);
  const config = loadedConfig.operator;
  const currentPublisher = dependencies.publisher?.() ?? hostname();
  if (currentPublisher !== config.publisher) {
    throw new SyncError(
      "wrong-publisher",
      "operator",
      `configured publisher ${config.publisher} does not match this machine ${currentPublisher}`,
    );
  }
  const registry = resolveRegistry(loadedConfig.source, dependencies.loadRegistry ?? loadEffectiveRegistry);
  let seed: ReturnType<typeof readManifest>;
  try {
    seed = (dependencies.readSeed ?? readManifest)(home, registry.harnesses);
  } catch (cause) {
    throw new SyncError("manifest-failure", "operator", `Manifest could not read publisher ${config.publisher}: ${messageOf(cause)}`, { cause });
  }
  if (!seed.ok) {
    const details = [
      ...seed.clashes.map((clash) => `clash ${clash.name}: ${clash.paths.join(", ")}`),
      ...seed.forbidden.map((hit) => `${hit.reason}: ${hit.path}`),
    ];
    throw new SyncError("manifest-refusal", "operator", `Manifest refused publisher ${config.publisher}: ${details.join("; ")}`);
  }
  return { config, registry, seed };
}

function makePlan(
  input: SyncInput,
  config: OperatorConfig,
  home: string,
  remoteHome: string | null,
  registry: Registry,
  seed: Seed,
): SyncPlan {
  const localCheckout = join(home, ".ferry", "store");
  return {
    operator: config.publisher,
    gitRemote: config.snapshotUrl,
    box: targetLabel(config),
    localCheckout,
    remoteHome,
    remoteCheckout: remoteHome ? posix.join(remoteHome, ".ferry", "store") : null,
    message: input.message ?? null,
    force: input.force === true,
    settingsChanges: settingsChanges(localCheckout, registry.harnesses, seed),
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

function printPlan(plan: SyncPlan): void {
  const remoteCheckout = plan.remoteCheckout ?? "$HOME/.ferry/store";
  const remoteHome = plan.remoteHome ?? "$HOME";
  console.log(
    [
      "Sync plan:",
      `Operator: ${plan.operator}`,
      `Git remote: ${plan.gitRemote}`,
      `Box: ${plan.box}`,
      `Publish: ${plan.localCheckout} (${plan.message ?? "Store default message"})`,
      `Update: ${remoteCheckout} with git clone, or fetch and reset --hard to the pushed commit (box changes are discarded)`,
      "SSH agent forwarding is limited to the box git update.",
      `Apply: ${remoteCheckout} -> ${remoteHome} (force: ${plan.force ? "yes" : "no"})`,
      "Plugins: claude plugin marketplace add and install for the carried Claude declarations",
      "Settings: carried keys replace their box values; other box keys are kept",
      `Changed settings keys since the last publish: ${
        plan.settingsChanges.map((change) => `${change.harness}: ${change.keys.join(", ")}`).join("; ") ||
        "none"
      }`,
    ].join("\n"),
  );
}

/**
 * Clone the snapshot on the box when missing. Otherwise print the box changes, then reset the
 * existing checkout to the pushed commit and remove its untracked files, so the box never wins.
 */
export function remoteUpdateCommand(checkout: string, remote: string, tip: string | null): string {
  const quotedCheckout = quoteShell(checkout);
  const quotedRemote = quoteShell(remote);
  const target = tip === null ? "@{upstream}" : tip;
  return [
    `if [ -d ${quoteShell(`${checkout}/.git`)} ]; then`,
    `${boxChangesCommand(checkout)} &&`,
    `git -C ${quotedCheckout} fetch --quiet &&`,
    `git -C ${quotedCheckout} reset --quiet --hard ${quoteShell(target)} &&`,
    `git -C ${quotedCheckout} clean --quiet --force -d;`,
    `else`,
    `mkdir -p ${quoteShell(posix.dirname(checkout))} && git clone ${quotedRemote} ${quotedCheckout};`,
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

async function resolveRemoteHome(link: SyncLink, config: OperatorConfig): Promise<string> {
  const box = targetLabel(config);
  const result = await link.run(`printf '%s\\n' "$HOME"`);
  if (!result.ok) {
    throw new SyncError(
      "link-failure",
      result.error.origin === "operator" ? "operator" : "box",
      `failed to resolve home on ${box}: ${result.error.origin}/${result.error.code}: ${result.error.message}`,
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
  host: string,
): () => void {
  try {
    return (dependencies.acquireLock ?? acquireSyncLock)(home, host);
  } catch (cause) {
    if (cause instanceof SyncError) throw cause;
    throw new SyncError("lock-failure", "operator", `could not lock sync for ${host}`, { cause });
  }
}

function acquireSyncLock(home: string, host: string): () => void {
  const digest = createHash("sha256").update(host).digest("hex").slice(0, 16);
  const path = join(home, ".ferry", `sync-${digest}.lock`);
  const token = randomUUID();
  const temporary = `${path}.${process.pid}.${token}`;
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(temporary, JSON.stringify({ pid: process.pid, token }), { mode: 0o600 });
  try {
    for (;;) {
      try {
        linkSync(temporary, path);
        break;
      } catch (cause) {
        if (!isCode(cause, "EEXIST")) throw cause;
        if (!staleLock(path)) {
          throw new SyncError("concurrent-sync", "operator", `another sync is active for ${host}`);
        }
        try {
          unlinkSync(path);
        } catch (unlinkError) {
          if (!isCode(unlinkError, "ENOENT")) throw unlinkError;
        }
      }
    }
  } finally {
    unlinkSync(temporary);
  }
  return () => {
    try {
      const value: unknown = JSON.parse(readFileSync(path, "utf8"));
      if ((value as { token?: unknown }).token === token) unlinkSync(path);
    } catch (error) {
      if (!isCode(error, "ENOENT")) throw error;
    }
  };
}

function staleLock(path: string): boolean {
  try {
    const value: unknown = JSON.parse(readFileSync(path, "utf8"));
    const pid = (value as { pid?: unknown }).pid;
    if (typeof pid !== "number" || !Number.isInteger(pid) || pid <= 0) return true;
    try {
      process.kill(pid, 0);
      return false;
    } catch (error) {
      return isCode(error, "ESRCH");
    }
  } catch {
    return true;
  }
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
): { readonly source: SyncConfig; readonly operator: OperatorConfig } {
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

function completeConfig(config: PartialOperatorConfig | null): OperatorConfig {
  const host = completeHostConfig(config?.host);
  if (config?.version !== 1 || !config.publisher || !config.snapshotUrl || !host) {
    throw new SyncError("invalid-config", "operator", "Ferry config is incomplete. Run ferry init.");
  }
  return {
    version: 1,
    publisher: config.publisher,
    snapshotUrl: config.snapshotUrl,
    host,
  };
}

function targetLabel(config: OperatorConfig): string {
  return config.host.transport === "ssh"
    ? config.host.destination
    : `${config.host.sshUser}@${config.host.tailscale}`;
}

function targetKey(config: OperatorConfig): string {
  return `${config.host.transport === "ssh" ? "ssh" : "tailscale"}:${targetLabel(config)}`;
}
