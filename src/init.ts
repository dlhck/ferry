/** Orchestrate the operator-side init workflow through the deep modules. */

import { createHash } from "node:crypto";
import { hostname, homedir } from "node:os";
import { join } from "node:path";
import { commitApply, planApply, type ApplyPlan } from "./apply.ts";
import { BOX_SNAPSHOT_KEY, resolveTargetBox, snapshotGit } from "./boxes.ts";
import {
  configPath,
  readConfig as readOperatorConfig,
  resolveLinkOptions,
  writeConfig as writeOperatorConfig,
  type BoxesOperatorConfig,
  type GitAuth,
  type OperatorConfig,
  type OperatorHostConfig,
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
import { denyRuleCause, linkFailure } from "./errors.ts";
import { noProgress, step, type Progress } from "./progress.ts";
import { ownsSkills, type HarnessDescriptor } from "./registry/types.ts";
import { openStore as openSnapshotStore, type PublishResult } from "./store.ts";
import { captureInitState, writeInitState } from "./uninstall.ts";

export type InitInput = {
  readonly dryRun?: boolean;
  readonly home?: string;
  /** The harnesses to seed from and to link. The CLI resolves them once. */
  readonly harnesses: readonly HarnessDescriptor[];
  readonly host?: string;
  readonly sshUser?: string;
  readonly sshDestination?: string;
  readonly snapshotUrl?: string;
  /** The box to init again when the config has `[box.<name>]` tables. The default is `default_box` or the only box. */
  readonly box?: string;
};

export type InitField = "host" | "sshUser" | "sshDestination" | "snapshotUrl";

export type InitPrompt = (
  missing: readonly InitField[],
  current: InitInput,
) => Promise<Pick<InitInput, InitField>>;

export type InitLink = {
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
  readonly progress?: Progress;
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
    options?: ErrorOptions,
  ) {
    super(message, options);
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
  const progress = dependencies.progress ?? noProgress;
  const readConfig = dependencies.readConfig ?? readOperatorConfig;
  const existing = readConfig(home);
  refuseMixedTarget(input);
  const boxes = existing?.boxes;
  if (boxes && (nonempty(input.host) || nonempty(input.sshUser) || nonempty(input.sshDestination))) {
    throw new InitRefusal(
      "invalid-values",
      "the config has [box.<name>] tables, so ferry init does not change a box host. Use ferry box add to add a box.",
    );
  }
  if (!boxes && input.box !== undefined) {
    throw new InitRefusal("invalid-values", "--box needs [box.<name>] tables in the config. Use ferry box add to add a box.");
  }
  // With boxes, init runs again for one box and keeps all box tables.
  const targetBox = existing && boxes ? resolveTargetBox(existing, input.box) : undefined;
  let values = mergeValues(input, targetBox ? { ...existing, host: targetBox.host } : existing);
  let missing = missingFields(values);

  if (missing.length > 0 && dependencies.prompt) {
    progress.pause();
    const answers = await dependencies.prompt(missing, values);
    values = mergeValues({ ...answers, harnesses: input.harnesses }, values);
    missing = missingFields(values);
  }
  if (missing.length > 0) {
    throw new InitRefusal("missing-values", `missing init values: ${missing.join(", ")}`);
  }

  const host: OperatorHostConfig = values.sshDestination
    ? { transport: "ssh", destination: values.sshDestination }
    : { tailscale: required(values.host), sshUser: required(values.sshUser) };
  const shared = {
    version: 1 as const,
    publisher: existing?.publisher ?? dependencies.publisher?.() ?? hostname(),
    snapshotUrl: required(values.snapshotUrl),
    harness: existing?.harness,
    update: existing?.update,
    status: existing?.status,
    integrations: existing?.integrations,
    tools: existing?.tools,
  };
  const config: OperatorConfig | BoxesOperatorConfig = boxes
    ? { ...shared, ...(existing?.defaultBox !== undefined ? { defaultBox: existing.defaultBox } : {}), boxes }
    : { ...shared, host };
  const gitAuth = targetBox?.gitAuth ?? "agent";
  progress.plan(input.dryRun ? 1 : 3 + boxCheckSteps(config.snapshotUrl, gitAuth));

  const seed = await step(
    progress,
    "Reading the portable set",
    () => (dependencies.readSeed ?? readManifest)(home, input.harnesses),
    (result) => !result.ok,
  );
  if (!seed.ok) throw manifestRefusal(seed);
  if (input.dryRun) {
    return {
      dryRun: true,
      plan: makeInitPlan(home, config, host, seed, input.harnesses),
      leftovers: seed.leftovers,
    };
  }

  const target = resolveLinkOptions(host);
  await checkBoxAccess(dependencies.createLink?.(target) ?? new Link(target), config.snapshotUrl, dependencies, gitAuth);

  const uninstallState = captureInitState({
    home,
    harnesses: input.harnesses,
    skillNames: seed.skills.map((skill) => skill.name),
    rootPaths: seed.roots.map((root) => root.path),
  });

  const { store, publication } = await step(
    progress,
    "Publishing the snapshot",
    async () => {
      const store = dependencies.openStore
        ? await dependencies.openStore(config.snapshotUrl, seed, home)
        : await openSnapshotStore(config.snapshotUrl, seed, { home, harnesses: input.harnesses });
      return { store, publication: await store.publish(seed) };
    },
    undefined,
    ({ publication }) => (publication.published ? "published" : "no changes"),
  );
  const applyInput = {
    checkout: store.path,
    targetHome: home,
    harnesses: input.harnesses,
    force: true as const,
  };
  await step(progress, "Linking managed paths", () => {
    if (dependencies.apply) {
      const plan = dependencies.apply(applyInput);
      writeInitState(home, uninstallState, plan);
    } else {
      const plan = planApply(applyInput);
      writeInitState(home, uninstallState, plan);
      commitApply(plan);
    }
  });
  (dependencies.writeConfig ?? writeOperatorConfig)(config, home);

  return {
    dryRun: false,
    leftovers: seed.leftovers,
    published: publication.published,
  };
}

/** The progress steps of `checkBoxAccess`. */
export function boxCheckSteps(snapshotUrl: string, gitAuth: GitAuth = "agent"): number {
  if (!snapshotSshTarget(snapshotUrl)) return 1;
  return gitAuth === "box" ? 4 : 5;
}

/**
 * The checks of init for a box. For an SSH snapshot: the operator SSH agent,
 * agent forwarding to the box, the Git host key on the box, and read access to
 * the snapshot through the forwarded agent. Else: an SSH connection to the box.
 * With `gitAuth` `"box"`, see `checkBoxDeployKey`.
 */
export async function checkBoxAccess(
  link: InitLink,
  snapshotUrl: string,
  dependencies: Pick<InitDependencies, "checkAgent" | "approveHostKeys" | "progress">,
  gitAuth: GitAuth = "agent",
): Promise<void> {
  const progress = dependencies.progress ?? noProgress;
  const snapshotTarget = snapshotSshTarget(snapshotUrl);
  if (gitAuth === "box") {
    if (!snapshotTarget) {
      throw new InitRefusal(
        "invalid-values",
        `git_auth = "box" needs an SSH snapshot URL, such as git@github.com:you/ferry-snapshot.git, because a deploy key works over SSH only. ${snapshotUrl} is not an SSH URL.`,
      );
    }
    await checkBoxDeployKey(link, snapshotUrl, snapshotTarget, progress, dependencies.approveHostKeys);
    return;
  }
  if (snapshotTarget) {
    const agent = await step(
      progress,
      "Checking the operator SSH agent",
      dependencies.checkAgent ?? checkOperatorAgent,
      (check) => !check.ok,
    );
    if (!agent.ok) {
      throw new InitRefusal(
        "agent-refusal",
        `operator SSH agent is unavailable or has no identities: ${agent.message} Run ssh-add before ferry init.`,
      );
    }
  }

  const probe = await step(
    progress,
    "Connecting to the box",
    () =>
      snapshotTarget
        ? link.run(
            'if [ -z "$SSH_AUTH_SOCK" ]; then printf "%s\\n" "SSH agent forwarding is unavailable" >&2; exit 1; fi; ssh-add -l',
            { agentForwarding: "git" },
          )
        : link.run("true"),
    (result) => !result.ok,
  );
  if (!probe.ok) {
    throw new InitRefusal(
      snapshotTarget ? "agent-refusal" : "link-refusal",
      `${probe.error.origin}: ${probe.error.message}`,
      { cause: linkFailure(probe.error) },
    );
  }
  if (snapshotTarget) {
    await approveSnapshotHostKey(link, snapshotTarget, dependencies.approveHostKeys, progress);
    const access = await step(
      progress,
      "Checking access to the snapshot",
      () => link.run(`git ls-remote ${quoteShell(snapshotUrl)} HEAD`, { agentForwarding: "git" }),
      (result) => !result.ok,
    );
    if (!access.ok) {
      throw new InitRefusal(
        "snapshot-access-refusal",
        `${access.error.origin}: could not read ${snapshotUrl} through the forwarded agent: ${access.error.message}`,
      );
    }
  }
}

/**
 * The checks for a `git_auth = "box"` box. Ferry forwards no agent. It makes
 * the deploy key on the box if it is missing, trusts the Git host key on the
 * box, and reads the snapshot with the deploy key. Ferry does not add the key
 * to the snapshot repository. The refusal prints the public key for the operator.
 */
async function checkBoxDeployKey(
  link: InitLink,
  snapshotUrl: string,
  snapshotTarget: SnapshotSshTarget,
  progress: Progress,
  approve: InitDependencies["approveHostKeys"],
): Promise<void> {
  const key = await step(
    progress,
    "Making the snapshot deploy key on the box",
    () => link.run(deployKeyCommand()),
    (result) => !result.ok,
  );
  if (!key.ok) throw new InitRefusal("link-refusal", `${key.error.origin}: ${key.error.message}`, { cause: linkFailure(key.error) });
  const publicKey = key.stdout.trim();
  await approveSnapshotHostKey(link, snapshotTarget, approve, progress);
  const access = await step(
    progress,
    "Checking access to the snapshot",
    () => link.run(`${snapshotGit("box")} ls-remote ${quoteShell(snapshotUrl)} HEAD`),
    (result) => !result.ok,
  );
  if (!access.ok) {
    throw new InitRefusal(
      "snapshot-access-refusal",
      `${access.error.origin}: could not read ${snapshotUrl} with the box deploy key ~/${BOX_SNAPSHOT_KEY}: ${access.error.message}\n` +
        "Add this public key as a read-only deploy key on the snapshot repository. Do not give it write access. Then run the command again.\n" +
        publicKey,
    );
  }
}

/** Make the ed25519 deploy key without a passphrase if it is missing, then print its public key. */
function deployKeyCommand(): string {
  const key = `"$HOME/${BOX_SNAPSHOT_KEY}"`;
  return [
    "umask 077;",
    'install -d -m 700 "$HOME/.ssh" &&',
    `{ [ -f ${key} ] || ssh-keygen -q -t ed25519 -N '' -C ferry-snapshot -f ${key} </dev/null >/dev/null; } &&`,
    `cat "$HOME/${BOX_SNAPSHOT_KEY}.pub"`,
  ].join(" ");
}

function makeInitPlan(
  home: string,
  config: OperatorConfig | BoxesOperatorConfig,
  host: OperatorHostConfig,
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
  const seedRoots = new Set(seed.roots.map((root) => root.path));
  for (const harness of harnesses) {
    for (const root of harness.extraRoots ?? []) {
      if (!seedRoots.has(root)) continue;
      links.push({
        harness: harness.name,
        path: join(home, root),
        target: join(localCheckout, "roots", root),
      });
    }
  }

  return {
    operator: config.publisher,
    box: host.transport === "ssh" ? host.destination : `${host.sshUser}@${host.tailscale}`,
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

/** The SSH host of a snapshot URL. An https, file, or other non-SSH URL, or a local path, has none. */
function snapshotSshTarget(remote: string): SnapshotSshTarget | null {
  const scheme = /^([A-Za-z][A-Za-z0-9+.-]*):\/\//.exec(remote)?.[1]?.toLowerCase();
  if (scheme !== undefined) {
    if (scheme !== "ssh" && scheme !== "git+ssh") return null;
    const url = URL.parse(remote);
    if (!url?.hostname) return null;
    return url.port
      ? { host: url.hostname, knownHost: `[${url.hostname}]:${url.port}`, scanPort: `-p ${url.port} ` }
      : { host: url.hostname, knownHost: url.hostname, scanPort: "" };
  }
  const match = /^(?:[^@/:\s]+@)?([^:/\s]+):.+$/.exec(remote);
  if (!match?.[1]) return null;
  return { host: match[1], knownHost: match[1], scanPort: "" };
}

async function approveSnapshotHostKey(
  link: InitLink,
  target: SnapshotSshTarget,
  approve: InitDependencies["approveHostKeys"],
  progress: Progress,
): Promise<void> {
  // The approval prompt must not run inside a step, so the read step ends before it.
  const scan = await step(progress, `Reading the SSH host keys of ${target.knownHost} on the box`, async () => {
    const trust = await link.run(
      `if ssh-keygen -F ${quoteShell(target.knownHost)} -f "$HOME/.ssh/known_hosts" >/dev/null 2>&1; then printf "trusted\\n"; else printf "missing\\n"; fi`,
    );
    if (!trust.ok) {
      throw new InitRefusal("host-key-refusal", `${trust.error.origin}: ${trust.error.message}`);
    }
    if (trust.stdout.trim() === "trusted") return null;

    const scan = await link.run(
      `ssh-keyscan -T 10 ${target.scanPort}${quoteShell(target.host)} 2>/dev/null`,
    );
    if (!scan.ok) {
      throw new InitRefusal("host-key-refusal", `${scan.error.origin}: ${scan.error.message}`);
    }
    return scan;
  });
  if (scan === null) {
    progress.skip(`Trusting the SSH host keys of ${target.knownHost} on the box`, "already trusted");
    return;
  }
  const keys = parseHostKeys(scan.stdout, target.knownHost);
  if (keys.length === 0) {
    throw new InitRefusal(
      "host-key-refusal",
      `the box could not read an SSH host key for ${target.host}`,
    );
  }
  progress.pause();
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
  const install = await step(
    progress,
    `Trusting the SSH host keys of ${target.knownHost} on the box`,
    () => link.run(installHostKeysCommand(keys)),
    (result) => !result.ok,
  );
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
  return new InitRefusal("manifest-refusal", `Manifest refused the source: ${details.join("; ")}`, denyRuleCause(refusal.forbidden));
}
