/** Orchestrate the operator-side init workflow through the deep modules. */

import { createHash } from "node:crypto";
import { hostname, homedir } from "node:os";
import { join } from "node:path";
import { commitApply, planApply, type ApplyPlan } from "./apply.ts";
import {
  configPath,
  readConfig as readOperatorConfig,
  resolveLinkOptions,
  writeConfig as writeOperatorConfig,
  type OperatorConfig,
  type PartialOperatorConfig,
} from "./config.ts";
import {
  BunHostAdapter,
  Link,
  type LinkOptions,
  type LinkResult,
  type RunOptions,
} from "./link.ts";
import { readSeed as readManifest, type Leftover, type Seed } from "./manifest.ts";
import { ownsSkills, type HarnessDescriptor } from "./registry/types.ts";
import { openStore as openSnapshotStore, type PublishResult } from "./store.ts";
import { captureInitState, writeInitState } from "./uninstall.ts";

export const PASEO_DAEMON_PORT = 6767;

export type InitInput = {
  readonly dryRun?: boolean;
  readonly home?: string;
  /** The harnesses to seed from and to link. The CLI resolves them once. */
  readonly harnesses: readonly HarnessDescriptor[];
  readonly host?: string;
  readonly sshUser?: string;
  readonly sshDestination?: string;
  readonly snapshotUrl?: string;
};

export type InitField = "host" | "sshUser" | "sshDestination" | "snapshotUrl";

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

export type OperatorAgentCheck =
  | { readonly ok: true }
  | { readonly ok: false; readonly message: string };

export type SnapshotHostKeyApproval = {
  readonly host: string;
  readonly keys: readonly {
    readonly algorithm: string;
    readonly fingerprint: string;
  }[];
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
  readonly checkAgent?: () => Promise<OperatorAgentCheck>;
  readonly approveHostKeys?: (request: SnapshotHostKeyApproval) => Promise<boolean>;
};

export type InitManagedLink = {
  readonly harness: string;
  readonly path: string;
  readonly target: string;
};

export type InitPlan = {
  readonly operator: string;
  readonly box: string;
  readonly gitRemote: string;
  readonly localCheckout: string;
  readonly configPath: string;
  readonly skills: readonly string[];
  readonly instructions: boolean;
  readonly links: readonly InitManagedLink[];
};

export type InitDryRunResult = {
  readonly dryRun: true;
  readonly plan: InitPlan;
  readonly leftovers: readonly Leftover[];
};

export type InitExecutedResult = {
  readonly dryRun: false;
  readonly address: string;
  readonly paseoPort: 6767;
  readonly leftovers: readonly Leftover[];
  readonly published: boolean;
};

export type InitResult = InitDryRunResult | InitExecutedResult;

export type InitRefusalCode =
  | "invalid-values"
  | "missing-values"
  | "manifest-refusal"
  | "agent-refusal"
  | "host-key-refusal"
  | "snapshot-access-refusal"
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

export function runInit(
  input: InitInput & { readonly dryRun: true },
  dependencies?: InitDependencies,
): Promise<InitDryRunResult>;
export function runInit(
  input: InitInput & { readonly dryRun?: false },
  dependencies?: InitDependencies,
): Promise<InitExecutedResult>;
export function runInit(
  input: InitInput,
  dependencies?: InitDependencies,
): Promise<InitResult>;
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
    harness: existing?.harness,
  };

  const seed = (dependencies.readSeed ?? readManifest)(home, input.harnesses);
  if (!seed.ok) throw manifestRefusal(seed);
  if (input.dryRun) {
    return {
      dryRun: true,
      plan: makeInitPlan(home, config, seed, input.harnesses),
      leftovers: seed.leftovers,
    };
  }

  const snapshotTarget = snapshotSshTarget(config.snapshotUrl);
  if (snapshotTarget) {
    const agent = await (dependencies.checkAgent ?? checkOperatorAgent)();
    if (!agent.ok) {
      throw new InitRefusal(
        "agent-refusal",
        `operator SSH agent is unavailable or has no identities: ${agent.message} Run ssh-add before ferry init.`,
      );
    }
  }

  const uninstallState = captureInitState({
    home,
    harnesses: input.harnesses,
    skillNames: seed.skills.map((skill) => skill.name),
  });

  const target = resolveLinkOptions(config.host);
  const link = dependencies.createLink?.(target) ?? new Link(target);
  const probe = snapshotTarget
    ? await link.run(
        'if [ -z "$SSH_AUTH_SOCK" ]; then printf "%s\\n" "SSH agent forwarding is unavailable" >&2; exit 1; fi; ssh-add -l',
        { agentForwarding: "git" },
      )
    : await link.run("true");
  if (!probe.ok) {
    throw new InitRefusal(
      snapshotTarget ? "agent-refusal" : "link-refusal",
      `${probe.error.origin}: ${probe.error.message}`,
    );
  }
  if (snapshotTarget) {
    await approveSnapshotHostKey(link, snapshotTarget, dependencies.approveHostKeys);
    const access = await link.run(
      `git ls-remote ${quoteShell(config.snapshotUrl)} HEAD`,
      { agentForwarding: "git" },
    );
    if (!access.ok) {
      throw new InitRefusal(
        "snapshot-access-refusal",
        `${access.error.origin}: could not read ${config.snapshotUrl} through the forwarded agent: ${access.error.message}`,
      );
    }
  }

  const store = dependencies.openStore
    ? await dependencies.openStore(config.snapshotUrl, seed, home)
    : await openSnapshotStore(config.snapshotUrl, seed, { home, harnesses: input.harnesses });
  const publication = await store.publish(seed);
  const applyInput = {
    checkout: store.path,
    targetHome: home,
    harnesses: input.harnesses,
    force: true as const,
  };
  if (dependencies.apply) {
    const plan = dependencies.apply(applyInput);
    writeInitState(home, uninstallState, plan);
  } else {
    const plan = planApply(applyInput);
    writeInitState(home, uninstallState, plan);
    commitApply(plan);
  }
  (dependencies.writeConfig ?? writeOperatorConfig)(config, home);

  return {
    dryRun: false,
    address: probe.address,
    paseoPort: PASEO_DAEMON_PORT,
    leftovers: seed.leftovers,
    published: publication.published,
  };
}

function makeInitPlan(
  home: string,
  config: OperatorConfig,
  seed: Seed,
  harnesses: readonly HarnessDescriptor[],
): InitPlan {
  const localCheckout = join(home, ".ferry", "store");
  const links: InitManagedLink[] = [];

  for (const harness of harnesses) {
    if (ownsSkills(harness) && harness.skillRoot) {
      for (const skill of seed.skills) {
        links.push({
          harness: harness.name,
          path: join(home, harness.skillRoot, skill.name),
          target: join(localCheckout, "skills", skill.name),
        });
      }
    }
    if (seed.instructions && harness.instructionFile) {
      links.push({
        harness: harness.name,
        path: join(home, harness.instructionFile),
        target: join(localCheckout, "AGENTS.md"),
      });
    }
  }

  return {
    operator: config.publisher,
    box:
      config.host.transport === "ssh"
        ? config.host.destination
        : `${config.host.sshUser}@${config.host.tailscale}`,
    gitRemote: config.snapshotUrl,
    localCheckout,
    configPath: configPath(home),
    skills: seed.skills.map((skill) => skill.name),
    instructions: seed.instructions !== null,
    links,
  };
}

function mergeValues(
  provided: InitInput,
  fallback: PartialOperatorConfig | InitInput | null,
): InitInput {
  const fallbackHost = fallback && "host" in fallback ? fallback.host : undefined;
  const fallbackDestination =
    fallback && "sshDestination" in fallback
      ? fallback.sshDestination
      : typeof fallbackHost === "object"
        ? fallbackHost?.destination
        : undefined;
  const host = typeof fallbackHost === "string" ? fallbackHost : fallbackHost?.tailscale;
  const directProvided = nonempty(provided.sshDestination);
  const tailscaleProvided = nonempty(provided.host) || nonempty(provided.sshUser);
  return {
    home: provided.home,
    harnesses: provided.harnesses,
    host: directProvided ? undefined : nonempty(provided.host) ?? nonempty(host),
    sshUser: directProvided
      ? undefined
      : nonempty(provided.sshUser) ??
        nonempty(typeof fallbackHost === "object" ? fallbackHost?.sshUser : undefined),
    sshDestination: tailscaleProvided
      ? undefined
      : directProvided ?? nonempty(fallbackDestination),
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

function nonempty(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

function required(value: string | undefined): string {
  return value as string;
}

type SnapshotSshTarget = {
  readonly host: string;
  readonly knownHost: string;
  readonly scanPort: string;
};

type ScannedHostKey = {
  readonly line: string;
  readonly algorithm: string;
  readonly fingerprint: string;
};

function snapshotSshTarget(remote: string): SnapshotSshTarget | null {
  const match = /^(?:[^@/:\s]+@)?([^:/\s]+):.+$/.exec(remote);
  if (!match?.[1]) return null;
  return { host: match[1], knownHost: match[1], scanPort: "" };
}

async function approveSnapshotHostKey(
  link: InitLink,
  target: SnapshotSshTarget,
  approve: InitDependencies["approveHostKeys"],
): Promise<void> {
  const trust = await link.run(
    `if ssh-keygen -F ${quoteShell(target.knownHost)} -f "$HOME/.ssh/known_hosts" >/dev/null 2>&1; then printf "trusted\\n"; else printf "missing\\n"; fi`,
  );
  if (!trust.ok) {
    throw new InitRefusal("host-key-refusal", `${trust.error.origin}: ${trust.error.message}`);
  }
  if (trust.stdout.trim() === "trusted") return;

  const scan = await link.run(
    `ssh-keyscan -T 10 ${target.scanPort}${quoteShell(target.host)} 2>/dev/null`,
  );
  if (!scan.ok) {
    throw new InitRefusal("host-key-refusal", `${scan.error.origin}: ${scan.error.message}`);
  }
  const keys = parseHostKeys(scan.stdout, target.knownHost);
  if (keys.length === 0) {
    throw new InitRefusal(
      "host-key-refusal",
      `the box could not read an SSH host key for ${target.host}`,
    );
  }
  const accepted = await approve?.({
    host: target.knownHost,
    keys: keys.map(({ algorithm, fingerprint }) => ({ algorithm, fingerprint })),
  });
  if (accepted !== true) {
    throw new InitRefusal(
      "host-key-refusal",
      `operator did not trust the SSH host keys for ${target.knownHost}`,
    );
  }
  const install = await link.run(installHostKeysCommand(keys));
  if (!install.ok) {
    throw new InitRefusal("host-key-refusal", `${install.error.origin}: ${install.error.message}`);
  }
}

function parseHostKeys(stdout: string, knownHost: string): ScannedHostKey[] {
  const keys: ScannedHostKey[] = [];
  for (const source of stdout.split(/\r?\n/)) {
    if (source === "" || source.startsWith("#")) continue;
    const fields = source.trim().split(/\s+/);
    const algorithm = fields[1];
    const encoded = fields[2];
    if (!algorithm || !encoded) continue;
    const bytes = Buffer.from(encoded, "base64");
    if (bytes.length === 0) continue;
    const digest = createHash("sha256").update(bytes).digest("base64").replace(/=+$/, "");
    keys.push({
      line: `${knownHost} ${algorithm} ${encoded}`,
      algorithm,
      fingerprint: `SHA256:${digest}`,
    });
  }
  return keys;
}

function installHostKeysCommand(keys: readonly ScannedHostKey[]): string {
  const quotedKeys = keys.map((key) => quoteShell(key.line)).join(" ");
  return [
    "umask 077;",
    'install -d -m 700 "$HOME/.ssh";',
    'touch "$HOME/.ssh/known_hosts";',
    'chmod 600 "$HOME/.ssh/known_hosts";',
    `for key in ${quotedKeys}; do`,
    'grep -Fqx -- "$key" "$HOME/.ssh/known_hosts" || printf "%s\\n" "$key" >> "$HOME/.ssh/known_hosts";',
    "done",
  ].join(" ");
}

async function checkOperatorAgent(): Promise<OperatorAgentCheck> {
  try {
    const result = await new BunHostAdapter().run({ argv: ["ssh-add", "-l"], timeoutMs: 5_000 });
    if (!result.timedOut && result.exitCode === 0) return { ok: true };
    const message = result.timedOut
      ? "ssh-add timed out."
      : result.stderr.trim() || result.stdout.trim() || "ssh-add failed.";
    return { ok: false, message };
  } catch (error) {
    return {
      ok: false,
      message: error instanceof Error && error.message ? error.message : "could not run ssh-add.",
    };
  }
}

function quoteShell(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
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
