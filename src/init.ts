/** Orchestrate the operator-side init workflow through the deep modules. */

import { hostname, homedir } from "node:os";
import { apply as applyStore, type ApplyPlan } from "./apply.ts";
import {
  readConfig as readOperatorConfig,
  resolveLinkOptions,
  writeConfig as writeOperatorConfig,
  type OperatorConfig,
  type PartialOperatorConfig,
} from "./config.ts";
import { Link, type LinkOptions, type LinkResult, type RunOptions } from "./link.ts";
import { readSeed as readManifest, type Leftover, type Seed } from "./manifest.ts";
import type { HarnessDescriptor } from "./registry/types.ts";
import { openStore as openSnapshotStore, type PublishResult } from "./store.ts";

export const PASEO_DAEMON_PORT = 6767;

export type InitInput = {
  readonly home?: string;
  /** The harnesses to seed from and to link. The CLI resolves them once. */
  readonly harnesses: readonly HarnessDescriptor[];
  readonly host?: string;
  readonly sshUser?: string;
  readonly sshDestination?: string;
  readonly snapshotUrl?: string;
};

export type InitField = "host" | "sshUser" | "snapshotUrl";

export type InitPrompt = (
  missing: readonly InitField[],
  current: InitInput,
) => Promise<Pick<InitInput, InitField>>;

type InitLink = {
  run(command: string, options?: RunOptions): Promise<LinkResult>;
};

type InitStore = {
  readonly path: string;
  publish(seed: Seed): Promise<PublishResult>;
};

export type InitDependencies = {
  readonly readSeed?: typeof readManifest;
  readonly readConfig?: typeof readOperatorConfig;
  readonly writeConfig?: typeof writeOperatorConfig;
  readonly createLink?: (options: LinkOptions) => InitLink;
  readonly openStore?: (remote: string, seed: Seed, home: string) => Promise<InitStore>;
  readonly apply?: (input: {
    readonly checkout: string;
    readonly targetHome: string;
    readonly harnesses: readonly HarnessDescriptor[];
    readonly force: true;
  }) => ApplyPlan;
  readonly publisher?: () => string;
  readonly prompt?: InitPrompt;
};

export type InitResult = {
  readonly address: string;
  readonly paseoPort: 6767;
  readonly leftovers: readonly Leftover[];
  readonly published: boolean;
};

export type InitRefusalCode =
  | "invalid-values"
  | "missing-values"
  | "manifest-refusal"
  | "link-refusal";

export class InitRefusal extends Error {
  constructor(
    readonly code: InitRefusalCode,
    message: string,
  ) {
    super(message);
    this.name = "InitRefusal";
  }
}

export async function runInit(
  input: InitInput,
  dependencies: InitDependencies = {},
): Promise<InitResult> {
  const home = input.home ?? homedir();
  const readConfig = dependencies.readConfig ?? readOperatorConfig;
  const existing = readConfig(home);
  refuseMixedTarget(input);
  let values = mergeValues(input, existing);
  let missing = missingFields(values);

  if (missing.length > 0 && dependencies.prompt) {
    const answers = await dependencies.prompt(missing, values);
    values = mergeValues({ ...answers, harnesses: input.harnesses }, values);
    missing = missingFields(values);
  }
  if (missing.length > 0) {
    throw new InitRefusal("missing-values", `missing init values: ${missing.join(", ")}`);
  }

  const config: OperatorConfig = {
    version: 1,
    publisher: existing?.publisher ?? dependencies.publisher?.() ?? hostname(),
    snapshotUrl: required(values.snapshotUrl),
    host: values.sshDestination
      ? { transport: "ssh", destination: values.sshDestination }
      : { tailscale: required(values.host), sshUser: required(values.sshUser) },
  };

  const seed = (dependencies.readSeed ?? readManifest)(home, input.harnesses);
  if (!seed.ok) throw manifestRefusal(seed);

  const target = requiredTarget(config);
  const link = dependencies.createLink?.(target) ?? new Link(target);
  const probe = await link.run("true");
  if (!probe.ok) {
    throw new InitRefusal("link-refusal", `${probe.error.origin}: ${probe.error.message}`);
  }

  const store = dependencies.openStore
    ? await dependencies.openStore(config.snapshotUrl, seed, home)
    : await openSnapshotStore(config.snapshotUrl, seed, { home, harnesses: input.harnesses });
  const publication = await store.publish(seed);
  (dependencies.apply ?? applyStore)({
    checkout: store.path,
    targetHome: home,
    harnesses: input.harnesses,
    force: true,
  });
  (dependencies.writeConfig ?? writeOperatorConfig)(config, home);

  return {
    address: probe.address,
    paseoPort: PASEO_DAEMON_PORT,
    leftovers: seed.leftovers,
    published: publication.published,
  };
}

function mergeValues(
  provided: InitInput,
  fallback: PartialOperatorConfig | InitInput | null,
): InitInput {
  const fallbackHost = fallback && "host" in fallback ? fallback.host : undefined;
  const host = typeof fallbackHost === "string" ? fallbackHost : fallbackHost?.tailscale;
  const direct = nonempty(provided.sshDestination);
  const tailscale = nonempty(provided.host) || nonempty(provided.sshUser);
  return {
    home: provided.home,
    harnesses: provided.harnesses,
    host: direct ? undefined : nonempty(provided.host) ?? nonempty(host),
    sshUser: direct
      ? undefined
      : nonempty(provided.sshUser) ??
        nonempty(typeof fallbackHost === "object" ? fallbackHost?.sshUser : undefined),
    sshDestination: tailscale
      ? undefined
      : direct ?? nonempty(typeof fallbackHost === "object" ? fallbackHost?.destination : undefined),
    snapshotUrl: nonempty(provided.snapshotUrl) ?? nonempty(fallback?.snapshotUrl),
  };
}

function missingFields(input: InitInput): InitField[] {
  const missing: InitField[] = [];
  if (!nonempty(input.sshDestination)) {
    if (!nonempty(input.host)) missing.push("host");
    if (!nonempty(input.sshUser)) missing.push("sshUser");
  }
  if (!nonempty(input.snapshotUrl)) missing.push("snapshotUrl");
  return missing;
}

function refuseMixedTarget(input: InitInput): void {
  if (nonempty(input.sshDestination) && (nonempty(input.host) || nonempty(input.sshUser))) {
    throw new InitRefusal(
      "invalid-values",
      "--ssh-destination cannot be combined with --host or --ssh-user",
    );
  }
}

function requiredTarget(config: OperatorConfig) {
  return resolveLinkOptions(config.host) as NonNullable<ReturnType<typeof resolveLinkOptions>>;
}

function nonempty(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

function required(value: string | undefined): string {
  return value as string;
}

function manifestRefusal(
  refusal: Extract<ReturnType<typeof readManifest>, { ok: false }>,
): InitRefusal {
  const details = [
    ...refusal.clashes.map((clash) => `clash ${clash.name}: ${clash.paths.join(", ")}`),
    ...refusal.forbidden.map((hit) => `${hit.reason}: ${hit.path}`),
  ];
  return new InitRefusal("manifest-refusal", `Manifest refused the source: ${details.join("; ")}`);
}
