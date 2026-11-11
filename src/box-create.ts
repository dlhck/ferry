/**
 * `ferry box create` and `ferry box destroy`: a box on a machine in the cloud
 * account of the operator. Ferry does not host machines.
 */

import { createHash, generateKeyPairSync, randomBytes } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { removeFromOperator, type BoxRemoveDependencies, type BoxRemoveResult } from "./box.ts";
import { hasNoBox, resolveBoxes, type ResolvedBox } from "./boxes.ts";
import { boxWorkLines, readBoxWork, type BoxWork } from "./box-work.ts";
import { isBoxName, withBoxes, type BoxesOperatorConfig, type OperatorHostConfig, type PartialOperatorConfig } from "./config.ts";
import { FerryError } from "./errors.ts";
import { keyOf, pinHostKey, unpinBox } from "./known-hosts.ts";
import type { LinkOptions, LinkResult, RunOptions } from "./link.ts";
import { step, type Progress } from "./progress.ts";
import { HETZNER_TOKEN, secretSources, TAILSCALE_AUTH_KEY, type Secret, type SecretName } from "./providers/credentials.ts";
import { HETZNER_DEFAULTS, MachineError, redact } from "./providers/hetzner.ts";
import type { Machine, MachineType, Provider } from "./providers/types.ts";
import { BUILTIN_TOOLS } from "./registry/builtin.ts";
import { acquireBoxLock } from "./sync.ts";

/** The SSH user that cloud-init makes on a new box. */
export const BOX_USER = "ferry";

/** The public keys that Ferry tries, in order, when `[provider.hetzner] ssh_public_key` is not set. */
const DEFAULT_PUBLIC_KEYS = [".ssh/id_ed25519.pub", ".ssh/id_ecdsa.pub", ".ssh/id_rsa.pub"];

const SSH_WAIT_MS = 5 * 60_000;
const TAILSCALE_LOGIN_WAIT_MS = 10 * 60_000;
const TAILNET_WAIT_MS = 2 * 60_000;
const POLL_MS = 5_000;
const LONG_COMMAND_MS = 10 * 60_000;

type BoxLink = { run(command: string, options?: RunOptions): Promise<LinkResult> };

export type BoxCreateInput = {
  readonly name: string;
  readonly dryRun: boolean;
  /** Do not ask before Ferry creates the machine, before a `[host]` config change, and before the install. */
  readonly yes: boolean;
};

export type BoxCreateDependencies = {
  readonly home: string;
  readonly readConfig: () => PartialOperatorConfig | null;
  /** Writes gh = "latest" for the new box after box add. */
  readonly writeConfig: (config: BoxesOperatorConfig) => void;
  /** The provider for the token. */
  readonly provider: (token: string) => Provider;
  readonly readSecret: (name: SecretName) => Promise<Secret | null>;
  readonly platform: string;
  readonly createLink: (options: LinkOptions) => BoxLink;
  /** `ferry box add` with the Tailscale host of the new box. Null when the operator cancels. */
  readonly addBox: (host: OperatorHostConfig) => Promise<unknown>;
  /** `ferry install --box <name>`. Null when the operator cancels. */
  readonly install: (box: string) => Promise<unknown>;
  /** `ferry sync --box <name>`. */
  readonly sync: (box: string) => Promise<unknown>;
  readonly confirm: (message: string) => Promise<boolean | symbol | undefined>;
  readonly writeLine: (line: string) => void;
  readonly progress: Progress;
  readonly sleep?: (ms: number) => Promise<void>;
  readonly now?: () => number;
  /** Makes the host key pair of the new machine. */
  readonly generateHostKey?: () => HostKeyPair;
};

export type BoxCreateResult = {
  readonly name: string;
  readonly dryRun: boolean;
  readonly provider: string;
  readonly serverType: string;
  readonly image: string;
  readonly location: string;
  /** The gross price for one month, such as "8.99", or null when Ferry has no price. */
  readonly monthlyPrice: string | null;
  readonly currency: string | null;
  readonly machine: Machine | null;
  /** The Tailscale host name of the box, or null for a dry run. */
  readonly tailscale: string | null;
};

type Settings = {
  readonly serverType: string;
  readonly image: string;
  readonly location: string;
  readonly sshKeyPath: string;
};

/**
 * Create a machine at the provider, pin its host key, join it to the
 * tailnet, then run `ferry box add`, `ferry install`, and `ferry sync` for it.
 * A failure after the provider created the machine names the machine and
 * `ferry box destroy <name>`. Returns null when the operator cancels before
 * the machine exists.
 */
export async function runBoxCreate(input: BoxCreateInput, dependencies: BoxCreateDependencies): Promise<BoxCreateResult | null> {
  const { name } = input;
  if (!isBoxName(name)) throw new FerryError("usage", `invalid box name ${name}. Use 1 to 32 characters from a-z, 0-9, and -, with no - at the start. The name all is reserved.`);
  const config = dependencies.readConfig();
  if (config?.version !== 1 || config.publisher === undefined || config.snapshotUrl === undefined) {
    throw new FerryError("config-missing", "Ferry config is not complete. Run ferry init first. ferry box create adds a box to an existing config.");
  }
  if (configBox(config, name) !== null) {
    throw new FerryError("refused", `box ${name} is already in the config. Use another name.`);
  }
  const settings = settingsOf(config, dependencies.home);
  const sshPublicKey = readPublicKey(settings.sshKeyPath);
  const write = dependencies.writeLine;
  const token = await dependencies.readSecret(HETZNER_TOKEN);
  const authKey = await dependencies.readSecret(TAILSCALE_AUTH_KEY);
  const provider = token === null ? null : dependencies.provider(token.value);
  const secrets = [token?.value, authKey?.value].filter((value): value is string => value !== undefined);
  const clean = (text: string) => secrets.reduce((result, secret) => redact(result, secret), text);

  let type: MachineType | null = null;
  if (provider !== null) {
    type = await provider.machineType(settings.serverType, settings.location).catch((cause) => {
      throw new FerryError("failed", clean(messageOf(cause)));
    });
    const existing = (await provider.list()).filter((machine) => machine.box === name);
    if (existing.length > 0) {
      throw new FerryError("refused", `Hetzner Cloud already has a machine for box ${name}: ${existing.map(machineText).join(", ")}.`, {
        hint: `Remove it with ferry box destroy ${name}, or use another name.`,
      });
    }
  }

  write(`Create box ${name} at Hetzner Cloud:`);
  write(`  Machine: ferry-${name}, ${settings.serverType}${type ? ` (${type.cores} vCPU ${type.architecture}, ${type.memoryGb} GB memory, ${type.diskGb} GB disk)` : ""}, ${settings.image}, ${settings.location}`);
  write(`  Price: ${type?.monthlyPrice ? `${type.currency} ${type.monthlyPrice} per month with VAT, the list price of Hetzner Cloud. The machine costs money until ferry box destroy ${name}.` : "Ferry needs the token to read the price."}`);
  write(`  Token: ${token ? `from the ${token.source}` : `not found. Ferry reads ${secretSources(HETZNER_TOKEN, dependencies.platform).join(", then ")}.`}`);
  write(`  SSH: user ${BOX_USER} with your key ${settings.sshKeyPath} (${sha256Fingerprint(sshPublicKey)}). No password login. Ferry does the root steps as root with your key, then turns off root login.`);
  write(`  Sudo: ${SUDOERS_RULE.replace(`${BOX_USER} ALL=(root) NOPASSWD: `, "")} only.`);
  write("  Firewall: inbound TCP port 22 only.");
  write("  Host key: Ferry makes the first host key, pins it in ~/.ssh/known_hosts, and replaces it on the box after the first connection.");
  write(
    `  Tailscale: ${authKey ? `join with the auth key from the ${authKey.source}, sent on SSH stdin` : "Ferry prints a login URL. Open it to add the box to your tailnet"}.`,
  );
  write(`  Then: ferry box add ${name}, ferry install --box ${name}, ferry sync --box ${name}.`);

  const result = {
    name,
    provider: "hetzner",
    serverType: settings.serverType,
    image: settings.image,
    location: settings.location,
    monthlyPrice: type?.monthlyPrice ?? null,
    currency: type ? type.currency : null,
  };
  if (input.dryRun) {
    write("Dry run: Ferry made no changes.");
    return { ...result, dryRun: true, machine: null, tailscale: null };
  }
  if (provider === null) {
    throw new FerryError("missing-values", "Ferry found no Hetzner Cloud token.", {
      hint: `Create an API token with read and write access in the Hetzner Cloud console, then put it in ${secretSources(HETZNER_TOKEN, dependencies.platform).join(", or ")}.`,
    });
  }
  if (!input.yes) {
    dependencies.progress.pause();
    if ((await dependencies.confirm(`Create the machine ferry-${name} at Hetzner Cloud?`)) !== true) {
      write("Box create cancelled.");
      return null;
    }
  }

  const hostKey = (dependencies.generateHostKey ?? generateHostKey)();
  let machine: Machine;
  try {
    machine = await step(dependencies.progress, "Creating the machine", () =>
      provider.create({
        box: name,
        serverType: settings.serverType,
        image: settings.image,
        location: settings.location,
        sshPublicKey,
        userData: cloudConfig(sshPublicKey, hostKey),
      }),
    );
  } catch (cause) {
    if (cause instanceof MachineError) throw leftover(cause.machine, name, cause, clean);
    throw new FerryError("failed", `Ferry could not create the machine: ${clean(messageOf(cause))}`, {
      hint: `Look for a machine with the label ferry-box=${name} in the Hetzner Cloud console. ferry box destroy ${name} removes it.`,
    });
  }
  write(`Created ${machineText(machine)}.`);

  try {
    const tailscale = await setUpMachine(name, machine, hostKey, authKey, dependencies);
    const host: OperatorHostConfig = { tailscale, sshUser: BOX_USER };
    if ((await dependencies.addBox(host)) === null) throw new Error("box add was cancelled");
    setGhLatest(name, dependencies);
    if ((await dependencies.install(name)) === null) throw new Error("install was cancelled");
    await dependencies.sync(name);
    write(`Box ${name} is ready. Run ferry status --box ${name} to check it.`);
    return { ...result, dryRun: false, machine, tailscale };
  } catch (cause) {
    throw leftover(machine, name, cause, clean);
  }
}

/**
 * Pin the host key, then do each root step over the pinned root session:
 * replace the host key, join the tailnet, install gh, and write the sudoers
 * rule. Then turn off root login and check the box as the ferry user.
 * Returns the Tailscale DNS name of the box.
 */
async function setUpMachine(
  name: string,
  machine: Machine,
  hostKey: HostKeyPair,
  authKey: Secret | null,
  dependencies: BoxCreateDependencies,
): Promise<string> {
  const { progress, home } = dependencies;
  const sleep = dependencies.sleep ?? ((ms: number) => Bun.sleep(ms));
  const now = dependencies.now ?? Date.now;
  if (machine.ipv4 === null) throw new Error("the machine has no public IPv4 address");
  const ip = machine.ipv4;
  pinHostKey(home, name, [ip], hostKey.publicKey);
  const root = dependencies.createLink({ destination: `root@${ip}` });
  const asRoot = async (command: string, options: RunOptions = {}): Promise<string> => {
    const result = await root.run(command, options);
    if (!result.ok) throw new Error(result.error.message);
    return result.stdout;
  };

  await step(progress, "Waiting for SSH on the machine", async () => {
    const deadline = now() + SSH_WAIT_MS;
    for (;;) {
      const result = await root.run("true");
      if (result.ok) return;
      // A wrong host key is never a reason to try again.
      if (/host key verification failed|identification has changed/i.test(result.error.message)) {
        throw new Error(`the SSH host key of ${ip} is not the key that Ferry gave the machine: ${result.error.message}`);
      }
      if (now() > deadline) throw new Error(`SSH on ${ip} did not answer in ${SSH_WAIT_MS / 60_000} minutes: ${result.error.message}`);
      await sleep(POLL_MS);
    }
  });

  const rotated = await step(progress, "Replacing the host key", async () => {
    const output = await asRoot(ROTATE_HOST_KEY, { timeoutMs: LONG_COMMAND_MS });
    const key = output.trim().split("\n").at(-1) ?? "";
    if (!/^ssh-ed25519 [A-Za-z0-9+/]+=*(\s|$)/.test(key)) throw new Error("the box did not print a new ed25519 host key");
    if (keyOf(key) === keyOf(hostKey.publicKey)) throw new Error("the box kept the first host key");
    // The first key is in the user data at the provider, so Ferry stops to trust it.
    unpinBox(home, name);
    pinHostKey(home, name, [ip], key);
    await asRoot("true");
    return key;
  });

  await step(progress, "Installing Tailscale", () => asRoot(INSTALL_TAILSCALE, { timeoutMs: LONG_COMMAND_MS }));
  const self = await step(progress, "Joining the tailnet", async () => {
    // --operator lets the ferry user run tailscale without sudo, for example tailscale logout in ferry box destroy.
    const up = `tailscale up --hostname=ferry-${name} --operator=${BOX_USER}`;
    if (authKey !== null) {
      // The auth key goes on stdin only: not in the argv, not in a file on the box, not at the provider.
      await asRoot(`${up} --auth-key=file:/dev/stdin`, {
        input: new TextEncoder().encode(authKey.value),
        timeoutMs: LONG_COMMAND_MS,
      }).catch((cause) => {
        throw new Error(`tailscale up failed: ${redact(messageOf(cause), authKey.value)}`);
      });
    } else {
      await asRoot(`sh -c 'nohup ${up} </dev/null >/dev/null 2>&1 &'`);
    }
    const deadline = now() + TAILSCALE_LOGIN_WAIT_MS;
    let shown = "";
    for (;;) {
      const status = parseStatus(await asRoot("tailscale status --json"));
      if (status.BackendState === "Running" && status.Self?.DNSName) return status.Self;
      if (status.AuthURL && status.AuthURL !== shown) {
        shown = status.AuthURL;
        progress.pause();
        dependencies.writeLine(`Open this URL to add box ${name} to your tailnet: ${status.AuthURL}`);
      }
      if (now() > deadline) throw new Error(`the box did not join the tailnet in ${TAILSCALE_LOGIN_WAIT_MS / 60_000} minutes`);
      await sleep(POLL_MS);
    }
  });

  // The gh apt source needs root beyond the sudoers rule. Later installs and updates of gh need only the rule.
  await step(progress, "Installing gh", () => asRoot(GH_INSTALL, { timeoutMs: LONG_COMMAND_MS }));
  // Linger keeps the user services of the box, such as Paseo, running. The ferry user cannot turn it on without sudo.
  await step(progress, "Turning on linger for the ferry user", () => asRoot(`loginctl enable-linger ${BOX_USER}`));
  await step(progress, "Writing the sudoers rule", () => asRoot(WRITE_SUDOERS));
  await step(progress, "Turning off root login", () => asRoot(CLOSE_ROOT_LOGIN));
  await step(progress, "Checking the ferry user", async () => {
    const user = dependencies.createLink({ destination: `${BOX_USER}@${ip}` });
    const result = await user.run("sudo -n /usr/bin/true");
    if (!result.ok) throw new Error(`the ferry user cannot run sudo -n /usr/bin/true: ${result.error.message}`);
  });

  const dnsName = (self.DNSName ?? "").replace(/\.$/, "");
  pinHostKey(home, name, [dnsName, ...(self.TailscaleIPs ?? [])], rotated);
  await step(progress, "Waiting for the box in the tailnet", async () => {
    const tailnet = dependencies.createLink({ host: dnsName, user: BOX_USER });
    const deadline = now() + TAILNET_WAIT_MS;
    for (;;) {
      const result = await tailnet.run("true");
      if (result.ok) return;
      if (/host key verification failed|identification has changed/i.test(result.error.message)) throw new Error(result.error.message);
      if (now() > deadline) throw new Error(`this machine cannot reach ${dnsName} over Tailscale: ${result.error.message}`);
      await sleep(POLL_MS);
    }
  });
  return dnsName;
}

/**
 * Write gh = "latest" in [box.<name>.tools]. The sudoers rule allows only
 * apt install gh -y, so the box cannot install an exact gh version.
 */
function setGhLatest(name: string, dependencies: BoxCreateDependencies): void {
  const config = dependencies.readConfig();
  const boxes = config?.boxes;
  if (!boxes?.some((box) => box.name === name)) throw new Error(`box ${name} is not in the config after box add`);
  const updated = boxes.map((box) => (box.name === name ? { ...box, tools: { ...box.tools, gh: "latest" } } : box));
  dependencies.writeConfig(withBoxes(config, updated, config?.defaultBox));
}

/** The error for a failure after the machine exists. It names the machine and the command that removes it. */
function leftover(machine: Machine, name: string, cause: unknown, clean: (text: string) => string): FerryError {
  const code = cause instanceof FerryError ? cause.code : "failed";
  const hint = cause instanceof FerryError && cause.hint !== undefined ? ` ${cause.hint}` : "";
  return new FerryError(code, clean(`Ferry created ${machineText(machine)}, then failed: ${messageOf(cause)}${hint}`), {
    hint: `The machine still exists and costs money. To remove it, run ferry box destroy ${name}.`,
    details: { machine: { id: machine.id, name: machine.name, ipv4: machine.ipv4 } },
  });
}

export type BoxDestroyInput = { readonly name: string; readonly dryRun: boolean; readonly yes: boolean };

export type BoxDestroyDependencies = BoxRemoveDependencies & {
  readonly provider: (token: string) => Provider;
  readonly readSecret: (name: SecretName) => Promise<Secret | null>;
  readonly platform: string;
  readonly createLink: (options: LinkOptions) => BoxLink;
  /** Asks the operator to type the box name. Returns the text. */
  readonly confirmName: (message: string) => Promise<string | symbol | undefined>;
  readonly progress: Progress;
};

export type BoxDestroyResult = {
  readonly name: string;
  readonly dryRun: boolean;
  readonly machine: Machine;
  /** The result of the removal from the config, or null when the box was not in the config or for a dry run. */
  readonly removed: BoxRemoveResult | null;
  /** The number of known_hosts lines of the box that Ferry removed. */
  readonly knownHosts: number;
  /** The projects on the box with unsaved work, or null when the box is not in the config or Ferry could not reach it. */
  readonly unsavedWork: BoxWork | null;
};

/**
 * Print the plan, ask for the box name, remove the machine at the provider,
 * and then do what `ferry box remove` does on the operator machine. A box that
 * is not in the config, for example after a failed `ferry box create`, loses
 * only its machine. Returns null when the operator does not type the name.
 */
export async function runBoxDestroy(input: BoxDestroyInput, dependencies: BoxDestroyDependencies): Promise<BoxDestroyResult | null> {
  const { name } = input;
  const write = dependencies.writeLine;
  const token = await dependencies.readSecret(HETZNER_TOKEN);
  if (token === null) {
    throw new FerryError("missing-values", "Ferry found no Hetzner Cloud token.", {
      hint: `Put the token in ${secretSources(HETZNER_TOKEN, dependencies.platform).join(", or ")}.`,
    });
  }
  const clean = (text: string) => redact(text, token.value);
  const provider = dependencies.provider(token.value);
  const box = configBox(dependencies.readConfig(), name);
  const machines = await step(dependencies.progress, "Reading the machines at Hetzner Cloud", () => provider.list()).catch((cause) => {
    throw new FerryError("failed", clean(messageOf(cause)));
  });
  const found = machines.filter((machine) => machine.box === name);
  if (found.length === 0) {
    throw new FerryError("unknown-box", `Hetzner Cloud has no machine with the label ferry-box=${name}.`, {
      hint: box !== null ? `To remove the box from the config only, run ferry box remove ${name}.` : "Run ferry box list to see the boxes.",
    });
  }
  if (found.length > 1) {
    throw new FerryError("refused", `Hetzner Cloud has more than one machine for box ${name}: ${found.map(machineText).join(", ")}. Ferry removes none.`, {
      hint: "Remove the extra machines in the Hetzner Cloud console.",
    });
  }
  const machine = found[0]!;
  write(`Destroy box ${name}:`);
  write(`  At Hetzner Cloud: remove ${machineText(machine)} and its firewall. The data on the machine is lost.`);
  if (box !== null) {
    write(`  On the box: tailscale logout, so the box leaves the tailnet.`);
    write(`  On this machine: remove box ${name} from the config and its tunnel service, as ferry box remove ${name} does.`);
  } else write(`  Box ${name} is not in the config. Ferry removes the machine only.`);
  write(`  On this machine: remove the lines of box ${name} from ~/.ssh/known_hosts.`);
  let unsavedWork: BoxWork | null = null;
  if (box !== null) {
    const link = dependencies.createLink(linkOptionsOf(box.host));
    unsavedWork = await step(dependencies.progress, "Reading the unsaved work", () => readBoxWork(link, box.projects)).catch((cause) => {
      write(`Unsaved work: unavailable. Ferry cannot reach box ${name}: ${messageOf(cause)}`);
      return null;
    });
    if (unsavedWork !== null) for (const line of boxWorkLines(unsavedWork, name)) write(line);
  }
  if (input.dryRun) {
    write("Dry run: Ferry made no changes.");
    return { name, dryRun: true, machine, removed: null, knownHosts: 0, unsavedWork };
  }
  if (!input.yes) {
    dependencies.progress.pause();
    if ((await dependencies.confirmName(`Type ${name} to destroy the machine ${machine.name}.`)) !== name) {
      write("Box destroy cancelled.");
      return null;
    }
  }
  const release = box === null ? () => {} : acquireBoxLock(dependencies.home, box, "box destroy");
  try {
    if (box !== null) {
      const logout = await dependencies
        .createLink(linkOptionsOf(box.host))
        .run("tailscale logout", { timeoutMs: 30_000 })
        .catch((cause: unknown) => ({ ok: false as const, error: { message: messageOf(cause) } }));
      if (!logout.ok) {
        const warning = `Warning: Ferry could not log box ${name} out of the tailnet: ${logout.error.message}. Remove the machine in the Tailscale admin console.`;
        dependencies.warn?.(warning);
        write(warning);
      }
    }
    await step(dependencies.progress, "Removing the machine", () => provider.destroy(machine)).catch((cause) => {
      throw new FerryError("failed", clean(`Ferry could not remove ${machineText(machine)}: ${messageOf(cause)}`), {
        hint: `The box stays in the config. Run ferry box destroy ${name} again, or remove the machine in the Hetzner Cloud console.`,
      });
    });
    write(`Removed ${machineText(machine)}.`);
    const knownHosts = unpinBox(dependencies.home, name);
    const config = dependencies.readConfig();
    const removed = box !== null && configBox(config, name) !== null ? await removeFromOperator(config!, name, dependencies, "") : null;
    return { name, dryRun: false, machine, removed, knownHosts, unsavedWork };
  } finally {
    release();
  }
}

function linkOptionsOf(host: OperatorHostConfig): LinkOptions {
  return host.transport === "ssh" ? { destination: host.destination } : { host: host.tailscale, user: host.sshUser };
}

/** The box of the config with this name, or null. */
function configBox(config: PartialOperatorConfig | null, name: string): ResolvedBox | null {
  if (config === null || hasNoBox(config)) return null;
  try {
    return resolveBoxes(config).find((box) => box.name === name) ?? null;
  } catch {
    return null;
  }
}

function settingsOf(config: PartialOperatorConfig, home: string): Settings {
  const hetzner = config.provider?.hetzner;
  const configured = hetzner?.sshPublicKey?.replace(/^~(?=\/|$)/, home);
  const sshKeyPath = configured ?? DEFAULT_PUBLIC_KEYS.map((path) => join(home, path)).find((path) => existsSync(path));
  if (sshKeyPath === undefined) {
    throw new FerryError("missing-values", "Ferry found no public SSH key in ~/.ssh.", {
      hint: 'Set ssh_public_key = "<path of a .pub file>" in the [provider.hetzner] table of ~/.ferry/config.toml.',
    });
  }
  return {
    serverType: hetzner?.serverType ?? HETZNER_DEFAULTS.serverType,
    image: hetzner?.image ?? HETZNER_DEFAULTS.image,
    location: hetzner?.location ?? HETZNER_DEFAULTS.location,
    sshKeyPath,
  };
}

/** The first line of the public key file. The file must be an OpenSSH public key, never a private key. */
function readPublicKey(path: string): string {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch {
    throw new FerryError("missing-values", `Ferry cannot read the public SSH key ${path}.`);
  }
  const line = text.trim().split("\n")[0]?.trim() ?? "";
  if (!/^(ssh-ed25519|ssh-rsa|ecdsa-sha2-nistp(256|384|521)|sk-ssh-ed25519@openssh\.com|sk-ecdsa-sha2-nistp256@openssh\.com) [A-Za-z0-9+/]+=*(\s|$)/.test(line)) {
    throw new FerryError("refused", `${path} is not an OpenSSH public key.`);
  }
  return line;
}

/** The SHA256 fingerprint of an OpenSSH public key, as ssh-keygen -l prints it. */
export function sha256Fingerprint(publicKey: string): string {
  const blob = Buffer.from(publicKey.split(/\s+/)[1] ?? "", "base64");
  return `SHA256:${createHash("sha256").update(blob).digest("base64").replace(/=+$/, "")}`;
}

function machineText(machine: Machine): string {
  return `the machine ${machine.name} (id ${machine.id}${machine.ipv4 ? `, ${machine.ipv4}` : ""})`;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

type TailscaleSelfStatus = {
  BackendState?: string;
  AuthURL?: string;
  Self?: { DNSName?: string; TailscaleIPs?: string[] };
};

function parseStatus(text: string): TailscaleSelfStatus {
  try {
    return JSON.parse(text) as TailscaleSelfStatus;
  } catch {
    return {};
  }
}

/**
 * As root: wait for cloud-init, make a new ed25519 host key, remove the other
 * host keys, and reload sshd. The open connection stays. It prints the new public key.
 */
const ROTATE_HOST_KEY = [
  "cloud-init status --wait >/dev/null 2>&1 || true",
  "rm -f /etc/ssh/ssh_host_*",
  "ssh-keygen -q -t ed25519 -N '' -C '' -f /etc/ssh/ssh_host_ed25519_key",
  "{ systemctl reload ssh 2>/dev/null || systemctl reload sshd; }",
  "cat /etc/ssh/ssh_host_ed25519_key.pub",
].join(" && ");

/** As root: the install script of Tailscale, when the box has no tailscale. */
const INSTALL_TAILSCALE = "command -v tailscale >/dev/null || { curl -fsSL https://tailscale.com/install.sh | sh; }";

/** As root: the install of gh with the "latest" policy, from the registry. It adds the GitHub CLI apt source. */
const GH_INSTALL = (() => {
  const command = BUILTIN_TOOLS.find((tool) => tool.id === "gh")?.install?.command;
  if (command === undefined) throw new Error("the registry has no gh install command");
  return command;
})();

/**
 * The sudoers rule of the ferry user. Each command has fixed arguments and no
 * wildcard, so an agent on the box cannot get root through it. They are the
 * apt commands of the gh, jq, and Node recipes, and the check of ferry status.
 */
export const SUDOERS_RULE = `${BOX_USER} ALL=(root) NOPASSWD: /usr/bin/true, /usr/bin/apt update, /usr/bin/apt update --error-on=any, /usr/bin/apt install gh -y, /usr/bin/apt install jq -y, /usr/bin/apt install nodejs npm -y`;

/** As root: write the rule with mode 0440 and check it with visudo before it takes effect. sudo skips a file name with a dot. */
const WRITE_SUDOERS = [
  `printf '%s\\n' '${SUDOERS_RULE}' > /etc/sudoers.d/ferry.new`,
  "chmod 0440 /etc/sudoers.d/ferry.new",
  "visudo -cf /etc/sudoers.d/ferry.new >/dev/null",
  "mv /etc/sudoers.d/ferry.new /etc/sudoers.d/ferry",
].join(" && ");

/** As root: turn off root login over SSH, remove the root keys, and reload sshd. The open connection stays. */
const CLOSE_ROOT_LOGIN = [
  "printf 'PermitRootLogin no\\n' > /etc/ssh/sshd_config.d/10-ferry.conf",
  "rm -f /root/.ssh/authorized_keys",
  "sshd -t",
  "{ systemctl reload ssh 2>/dev/null || systemctl reload sshd; }",
].join(" && ");

export type HostKeyPair = {
  /** The private key in the OpenSSH format. It goes only into the user data of the new machine. */
  readonly privateKey: string;
  /** One OpenSSH public key line. */
  readonly publicKey: string;
};

/** A new ed25519 key pair, with the private key in the unencrypted OpenSSH format of `/etc/ssh/ssh_host_ed25519_key`. */
export function generateHostKey(): HostKeyPair {
  const jwk = generateKeyPairSync("ed25519").privateKey.export({ format: "jwk" });
  const seed = Buffer.from(jwk.d ?? "", "base64url");
  const pub = Buffer.from(jwk.x ?? "", "base64url");
  const type = Buffer.from("ssh-ed25519");
  const publicBlob = Buffer.concat([sshString(type), sshString(pub)]);
  const check = randomBytes(4);
  const parts = [check, check, sshString(type), sshString(pub), sshString(Buffer.concat([seed, pub])), sshString(Buffer.alloc(0))];
  let secret = Buffer.concat(parts);
  const padding: number[] = [];
  for (let byte = 1; (secret.length + padding.length) % 8 !== 0; byte += 1) padding.push(byte);
  secret = Buffer.concat([secret, Buffer.from(padding)]);
  const none = sshString(Buffer.from("none"));
  const count = Buffer.alloc(4);
  count.writeUInt32BE(1);
  const body = Buffer.concat([Buffer.from("openssh-key-v1\0"), none, none, sshString(Buffer.alloc(0)), count, sshString(publicBlob), sshString(secret)]);
  const lines = body.toString("base64").match(/.{1,70}/g) ?? [];
  return {
    privateKey: ["-----BEGIN OPENSSH PRIVATE KEY-----", ...lines, "-----END OPENSSH PRIVATE KEY-----", ""].join("\n"),
    publicKey: `ssh-ed25519 ${publicBlob.toString("base64")}`,
  };
}

function sshString(value: Buffer): Buffer {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(value.length);
  return Buffer.concat([length, value]);
}

/**
 * The cloud-init user data. It has the public SSH key of the operator and the
 * first host key, and no other secret. The provider stores it, so Ferry
 * replaces that host key after the first connection.
 */
export function cloudConfig(operatorKey: string, hostKey: HostKeyPair): string {
  const indent = (text: string) => text.trimEnd().split("\n").map((line) => `    ${line}`).join("\n");
  return [
    "#cloud-config",
    "ssh_pwauth: false",
    // Ferry does the root steps over a root SSH session with the operator key, then turns off root login.
    "disable_root: false",
    "ssh_deletekeys: true",
    "ssh_genkeytypes: []",
    "ssh_keys:",
    "  ed25519_private: |",
    indent(hostKey.privateKey),
    `  ed25519_public: ${JSON.stringify(hostKey.publicKey)}`,
    "users:",
    `  - name: ${BOX_USER}`,
    "    shell: /bin/bash",
    "    lock_passwd: true",
    "    ssh_authorized_keys:",
    `      - ${JSON.stringify(operatorKey)}`,
    "",
  ].join("\n");
}
