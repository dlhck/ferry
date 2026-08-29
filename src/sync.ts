/** Publish the operator snapshot and apply it to the configured box. */

import { createHash, randomUUID } from "node:crypto";
import { linkSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { hostname, homedir } from "node:os";
import { dirname, join, posix } from "node:path";
import { apply as applyStore, type ApplyPlan, type RemoteApplyInput } from "./apply.ts";
import {
  readConfig as readOperatorConfig,
  type OperatorConfig,
  type PartialOperatorConfig,
} from "./config.ts";
import { readSeed as readManifest } from "./manifest.ts";
import { Link, type LinkResult, type RunOptions } from "./link.ts";
import {
  loadRegistry as loadEffectiveRegistry,
  type Registry,
  type RegistryConfig,
} from "./registry/load.ts";
import type { HarnessDescriptor } from "./registry/types.ts";
import { openStore as openSnapshotStore, type PublishResult } from "./store.ts";
import { adoptPublishedSkills } from "./adopt.ts";

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
  readonly createLink?: (host: string, user: string) => SyncLink;
  readonly openStore?: (
    remote: string,
    seed: Seed,
    options: SyncStoreOptions,
  ) => Promise<SyncStore>;
  readonly acquireLock?: (home: string, host: string) => () => void;
  readonly apply?: (input: RemoteApplyInput) => Promise<ApplyPlan>;
  readonly adopt?: typeof adoptPublishedSkills;
  readonly writePlan?: (plan: SyncPlan) => void;
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
};

export type SyncResult = {
  readonly dryRun: boolean;
  readonly published: boolean;
  readonly plan: SyncPlan;
  readonly applyPlan?: ApplyPlan;
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

  if (input.dryRun) {
    const plan = makePlan(input, config, home, null);
    (dependencies.writePlan ?? printPlan)(plan);
    return { dryRun: true, published: false, plan };
  }

  const link =
    dependencies.createLink?.(config.host.tailscale, config.host.sshUser) ??
    new Link({ host: config.host.tailscale, user: config.host.sshUser });
  const remoteHome = await resolveRemoteHome(link, config);
  const plan = makePlan(input, config, home, remoteHome);
  (dependencies.writePlan ?? printPlan)(plan);

  const release = takeLock(dependencies, home, config.host.tailscale);
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
      `git -C ${quoteShell(required(plan.remoteCheckout))} pull --ff-only`,
      { agentForwarding: "git" },
    );
    if (!update.ok) {
      throw new SyncError(
        "remote-update-failure",
        "box",
        `failed to update ${plan.box} from ${config.snapshotUrl}: ${update.error.origin}/${update.error.code}: ${update.error.message}`,
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

    return { dryRun: false, published: publication.published, plan, applyPlan };
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
): SyncPlan {
  return {
    operator: config.publisher,
    gitRemote: config.snapshotUrl,
    box: `${config.host.sshUser}@${config.host.tailscale}`,
    localCheckout: join(home, ".ferry", "store"),
    remoteHome,
    remoteCheckout: remoteHome ? posix.join(remoteHome, ".ferry", "store") : null,
    message: input.message ?? null,
    force: input.force === true,
  };
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
      `Update: ${remoteCheckout} with git pull --ff-only`,
      "SSH agent forwarding is limited to the box git update.",
      `Apply: ${remoteCheckout} -> ${remoteHome} (force: ${plan.force ? "yes" : "no"})`,
    ].join("\n"),
  );
}

async function resolveRemoteHome(link: SyncLink, config: OperatorConfig): Promise<string> {
  const result = await link.run(`printf '%s\\n' "$HOME"`);
  if (!result.ok) {
    throw new SyncError(
      "link-failure",
      result.error.origin === "operator" ? "operator" : "box",
      `failed to resolve home on ${config.host.sshUser}@${config.host.tailscale}: ${result.error.origin}/${result.error.code}: ${result.error.message}`,
    );
  }
  const remoteHome = result.stdout.replace(/\r?\n$/, "");
  if (!posix.isAbsolute(remoteHome) || /[\r\n\0]/.test(remoteHome)) {
    throw new SyncError(
      "invalid-box-home",
      "box",
      `${config.host.sshUser}@${config.host.tailscale} returned an invalid absolute home path`,
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
  if (
    config?.version !== 1 ||
    !config.publisher ||
    !config.snapshotUrl ||
    !config.host?.tailscale ||
    !config.host.sshUser
  ) {
    throw new SyncError("invalid-config", "operator", "Ferry config is incomplete. Run ferry init.");
  }
  return {
    version: 1,
    publisher: config.publisher,
    snapshotUrl: config.snapshotUrl,
    host: { tailscale: config.host.tailscale, sshUser: config.host.sshUser },
  };
}
