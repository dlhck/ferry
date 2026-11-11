import { afterEach, describe, expect, test } from "bun:test";
import { createPrivateKey, createPublicKey } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { cloudConfig, generateHostKey, runBoxCreate, runBoxDestroy, type BoxCreateDependencies, type BoxDestroyDependencies } from "../src/box-create.ts";
import { readConfig, withBoxes, writeConfig, type BoxesOperatorConfig, type OperatorHostConfig } from "../src/config.ts";
import type { LinkOptions, LinkResult, RunOptions } from "../src/link.ts";
import { noProgress } from "../src/progress.ts";
import type { SecretName } from "../src/providers/credentials.ts";
import type { Machine, MachineSpec, Provider } from "../src/providers/types.ts";

const TOKEN = "example-hcloud-token-0123456789abcdef";
const AUTH_KEY = "tskey-auth-example0123456789";
const OPERATOR_KEY = "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIExampleOperatorKeyOnlyForTests0123456789ab operator@example.com";
const FIRST_KEY = { privateKey: "-----BEGIN OPENSSH PRIVATE KEY-----\nexample\n-----END OPENSSH PRIVATE KEY-----\n", publicKey: "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIFirstHostKeyExample" };
const NEW_KEY = "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAINewHostKeyExample";
const DNS_NAME = "ferry-b.tail0000.ts.net";

const CONFIG = [
  "version = 1",
  'publisher = "operator"',
  'snapshot_url = "git@github.com:you/ferry-snapshot.git"',
  "",
  "[box.a]",
  'transport = "ssh"',
  'destination = "user@box.example"',
  "",
].join("\n");

const homes: string[] = [];
afterEach(() => {
  for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true });
});

function makeHome(config = CONFIG): string {
  const home = realpathSync(mkdtempSync(join(tmpdir(), "ferry-box-create-")));
  homes.push(home);
  mkdirSync(join(home, ".ferry"), { recursive: true });
  writeFileSync(join(home, ".ferry/config.toml"), config);
  mkdirSync(join(home, ".ssh"));
  writeFileSync(join(home, ".ssh/id_ed25519.pub"), `${OPERATOR_KEY}\n`);
  return home;
}

const MACHINE: Machine = { id: "42", name: "ferry-b", box: "b", ipv4: "203.0.113.10", ipv6: null, serverType: "cax21", location: "fsn1" };

function fakeProvider(overrides: Partial<Provider> = {}) {
  const created: MachineSpec[] = [];
  const destroyed: Machine[] = [];
  const machines: Machine[] = [];
  const tokens: string[] = [];
  const provider: Provider = {
    id: "hetzner",
    label: "Hetzner Cloud",
    machineType: async (name) => ({ name, cores: 4, memoryGb: 8, diskGb: 80, architecture: "arm", monthlyPrice: "8.99", currency: "EUR" }),
    create: async (spec) => {
      created.push(spec);
      machines.push(MACHINE);
      return MACHINE;
    },
    destroy: async (machine) => {
      destroyed.push(machine);
    },
    list: async () => machines,
    ...overrides,
  };
  return { factory: (token: string) => (tokens.push(token), provider), created, destroyed, machines, tokens };
}

type Command = { options: LinkOptions; command: string; run: RunOptions };

/** A fake box: SSH works at once, the host key rotation prints NEW_KEY, and Tailscale asks for a login first. */
function fakeLink(respond: (command: string, count: number) => LinkResult | undefined = () => undefined) {
  const commands: Command[] = [];
  let statusCalls = 0;
  const ok = (stdout = ""): LinkResult => ({ ok: true, address: "203.0.113.10", stdout, stderr: "" });
  const createLink = (options: LinkOptions) => ({
    async run(command: string, run: RunOptions = {}) {
      commands.push({ options, command, run });
      const custom = respond(command, commands.length);
      if (custom) return custom;
      if (command.includes("ssh-keygen")) return ok(`${NEW_KEY}\n`);
      if (command === "tailscale status --json") {
        statusCalls += 1;
        return ok(
          JSON.stringify(
            statusCalls < 2
              ? { BackendState: "NeedsLogin", AuthURL: "https://login.tailscale.com/a/example" }
              : { BackendState: "Running", Self: { DNSName: `${DNS_NAME}.`, TailscaleIPs: ["100.64.0.10", "fd7a:115c:a1e0::a"] } },
          ),
        );
      }
      return ok();
    },
  });
  return { createLink, commands };
}

function createDependencies(home: string, overrides: Partial<BoxCreateDependencies> = {}) {
  const lines: string[] = [];
  const calls: string[] = [];
  const provider = fakeProvider();
  const link = fakeLink();
  let time = 0;
  const secrets: Partial<Record<string, string>> = { HCLOUD_TOKEN: TOKEN };
  const dependencies: BoxCreateDependencies = {
    home,
    readConfig: () => readConfig(home),
    provider: provider.factory,
    readSecret: async (name: SecretName) => (secrets[name.env] ? { value: secrets[name.env]!, source: `environment variable ${name.env}` } : null),
    platform: "linux",
    createLink: link.createLink,
    addBox: async (host: OperatorHostConfig) => {
      calls.push(`add ${JSON.stringify(host)}`);
      const config = readConfig(home)!;
      writeConfig(withBoxes(config, [...(config.boxes ?? []), { name: "b", host }], config.defaultBox), home);
      return {};
    },
    install: async (box) => (calls.push(`install ${box}`), {}),
    sync: async (box) => (calls.push(`sync ${box}`), {}),
    confirm: async () => true,
    writeLine: (line) => lines.push(line),
    progress: noProgress,
    sleep: async (ms) => {
      time += ms;
    },
    now: () => time,
    generateHostKey: () => FIRST_KEY,
    ...overrides,
  };
  return { dependencies, lines, calls, provider, link, secrets };
}

const knownHosts = (home: string) => readFileSync(join(home, ".ssh/known_hosts"), "utf8");

describe("ferry box create", () => {
  test("creates the machine, replaces the host key, joins the tailnet, then adds, installs, and syncs the box", async () => {
    const home = makeHome();
    const { dependencies, lines, calls, provider, link } = createDependencies(home);
    const result = await runBoxCreate({ name: "b", dryRun: false, yes: true }, dependencies);

    expect(result).toMatchObject({ name: "b", dryRun: false, serverType: "cax21", image: "ubuntu-24.04", location: "fsn1", monthlyPrice: "8.99", tailscale: DNS_NAME });
    expect(provider.created).toHaveLength(1);
    expect(provider.created[0]).toMatchObject({ box: "b", sshPublicKey: OPERATOR_KEY });
    expect(provider.created[0]?.userData).toBe(cloudConfig(OPERATOR_KEY, FIRST_KEY));
    expect(calls).toEqual([`add ${JSON.stringify({ tailscale: DNS_NAME, sshUser: "ferry" })}`, "install b", "sync b"]);

    // The first key is in the user data at the provider, so it is not trusted after the rotation.
    const hosts = knownHosts(home);
    expect(hosts).not.toContain(FIRST_KEY.publicKey);
    expect(hosts).toBe(`203.0.113.10 ${NEW_KEY} ferry:b\n${DNS_NAME},100.64.0.10,fd7a:115c:a1e0::a ${NEW_KEY} ferry:b\n`);
    expect(link.commands[0]?.options).toEqual({ destination: "ferry@203.0.113.10" });
    expect(link.commands.at(-1)?.options).toEqual({ host: DNS_NAME, user: "ferry" });
    expect(lines).toContain("Open this URL to add box b to your tailnet: https://login.tailscale.com/a/example");
    expect(readConfig(home)?.boxes?.map((box) => box.name)).toEqual(["a", "b"]);
  });

  test("the Tailscale auth key goes on SSH stdin only, and no secret is in the output, the user data, or the result", async () => {
    const home = makeHome();
    const { dependencies, lines, provider, link, secrets } = createDependencies(home);
    secrets.FERRY_TAILSCALE_AUTHKEY = AUTH_KEY;
    const result = await runBoxCreate({ name: "b", dryRun: false, yes: true }, dependencies);

    const up = link.commands.find((entry) => entry.command.includes("tailscale up"))!;
    expect(up.command).toBe("sudo -n tailscale up --hostname=ferry-b --auth-key=file:/dev/stdin");
    expect(new TextDecoder().decode(up.run.input)).toBe(AUTH_KEY);
    expect(provider.tokens).toEqual([TOKEN]);
    const visible = [
      ...lines,
      JSON.stringify(result),
      provider.created[0]!.userData,
      ...link.commands.map((entry) => entry.command),
      readFileSync(join(home, ".ferry/config.toml"), "utf8"),
      knownHosts(home),
    ].join("\n");
    expect(visible).not.toContain(TOKEN);
    expect(visible).not.toContain(AUTH_KEY);
    expect(lines.some((line) => line.includes("FERRY_TAILSCALE_AUTHKEY"))).toBe(true);
  });

  test("--dry-run prints the plan and the price and creates nothing", async () => {
    const home = makeHome();
    const { dependencies, lines, provider, calls } = createDependencies(home);
    const result = await runBoxCreate({ name: "b", dryRun: true, yes: false }, dependencies);
    expect(result).toMatchObject({ dryRun: true, machine: null, monthlyPrice: "8.99", currency: "EUR" });
    expect(provider.created).toEqual([]);
    expect(calls).toEqual([]);
    expect(existsSync(join(home, ".ssh/known_hosts"))).toBe(false);
    expect(lines.join("\n")).toContain("cax21 (4 vCPU arm, 8 GB memory, 80 GB disk), ubuntu-24.04, fsn1");
    expect(lines.join("\n")).toContain("EUR 8.99 per month");
    expect(lines.join("\n")).toContain("Firewall: inbound TCP port 22 only.");
    expect(lines.join("\n")).not.toContain(TOKEN);
  });

  test("the [provider.hetzner] keys change the machine", async () => {
    const home = makeHome(`${CONFIG}[provider.hetzner]\nserver_type = "cx33"\nimage = "debian-13"\nlocation = "hel1"\nssh_public_key = "~/keys/ops.pub"\n`);
    mkdirSync(join(home, "keys"));
    writeFileSync(join(home, "keys/ops.pub"), OPERATOR_KEY);
    const { dependencies, provider } = createDependencies(home);
    await runBoxCreate({ name: "b", dryRun: false, yes: true }, dependencies);
    expect(provider.created[0]).toMatchObject({ serverType: "cx33", image: "debian-13", location: "hel1", sshPublicKey: OPERATOR_KEY });
  });

  test("without a token, a dry run names the token places and a real run stops before it creates anything", async () => {
    const home = makeHome();
    const { dependencies, lines, provider, secrets } = createDependencies(home);
    delete secrets.HCLOUD_TOKEN;
    await runBoxCreate({ name: "b", dryRun: true, yes: true }, dependencies);
    expect(lines.join("\n")).toContain("not found. Ferry reads the environment variable HCLOUD_TOKEN, then the Secret Service");
    await expect(runBoxCreate({ name: "b", dryRun: false, yes: true }, dependencies)).rejects.toMatchObject({ code: "missing-values" });
    expect(provider.created).toEqual([]);
  });

  test("refuses a name in the config, a machine that exists for the name, and a private key as the public key", async () => {
    const home = makeHome();
    await expect(runBoxCreate({ name: "a", dryRun: true, yes: true }, createDependencies(home).dependencies)).rejects.toMatchObject({ code: "refused" });

    const existing = createDependencies(home);
    existing.provider.machines.push(MACHINE);
    await expect(runBoxCreate({ name: "b", dryRun: true, yes: true }, existing.dependencies)).rejects.toMatchObject({
      code: "refused",
      hint: expect.stringContaining("ferry box destroy b"),
    });

    writeFileSync(join(home, ".ssh/id_ed25519.pub"), FIRST_KEY.privateKey);
    await expect(runBoxCreate({ name: "b", dryRun: true, yes: true }, createDependencies(home).dependencies)).rejects.toThrow("not an OpenSSH public key");
  });

  test("a cancel at the question creates nothing", async () => {
    const home = makeHome();
    const { dependencies, provider } = createDependencies(home, { confirm: async () => false });
    expect(await runBoxCreate({ name: "b", dryRun: false, yes: false }, dependencies)).toBeNull();
    expect(provider.created).toEqual([]);
  });

  test("a failure after the machine exists names the machine and ferry box destroy, without the token", async () => {
    const home = makeHome();
    const { dependencies } = createDependencies(home, {
      install: async () => {
        throw new Error(`apt failed near ${TOKEN}`);
      },
    });
    const error = (await runBoxCreate({ name: "b", dryRun: false, yes: true }, dependencies).catch((cause: unknown) => cause)) as Error & {
      hint: string;
      details: unknown;
    };
    expect(error.message).toContain("Ferry created the machine ferry-b (id 42, 203.0.113.10), then failed: apt failed near [token]");
    expect(error.hint).toBe("The machine still exists and costs money. To remove it, run ferry box destroy b.");
    expect(error.details).toEqual({ machine: { id: "42", name: "ferry-b", ipv4: "203.0.113.10" } });
    expect(JSON.stringify({ message: error.message, hint: error.hint, details: error.details })).not.toContain(TOKEN);
  });

  test("a provider error during create has no token in its message", async () => {
    const home = makeHome();
    const { dependencies } = createDependencies(home, {
      provider: () => ({
        ...fakeProvider().factory(TOKEN),
        create: async () => {
          throw new Error(`HTTP 403 for Bearer ${TOKEN}`);
        },
      }),
    });
    const error = (await runBoxCreate({ name: "b", dryRun: false, yes: true }, dependencies).catch((cause: unknown) => cause)) as Error & { hint: string };
    expect(error.message).not.toContain(TOKEN);
    expect(error.hint).toContain("ferry-box=b");
  });

  test("another key in known_hosts for the new address stops the create and keeps the operator's line", async () => {
    const home = makeHome();
    const old = `203.0.113.10 ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIOldServerKey\n`;
    writeFileSync(join(home, ".ssh/known_hosts"), old);
    const { dependencies, link } = createDependencies(home);
    const error = await runBoxCreate({ name: "b", dryRun: false, yes: true }, dependencies).catch((cause: unknown) => cause);
    expect(error).toMatchObject({ code: "refused", hint: "The machine still exists and costs money. To remove it, run ferry box destroy b." });
    expect((error as Error).message).toContain("ssh-keygen -R 203.0.113.10");
    expect(knownHosts(home)).toBe(old);
    expect(link.commands).toEqual([]);
  });

  test("a wrong host key on the first connection stops at once", async () => {
    const home = makeHome();
    const link = fakeLink((command) =>
      command === "true" ? { ok: false, error: { code: "ssh-failed", origin: "network", message: "Host key verification failed." } } : undefined,
    );
    const { dependencies } = createDependencies(home, { createLink: link.createLink });
    await expect(runBoxCreate({ name: "b", dryRun: false, yes: true }, dependencies)).rejects.toThrow("not the key that Ferry gave the machine");
    expect(link.commands.map((entry) => entry.command)).toEqual(["true"]);
  });

  test("SSH that does not answer yet is tried again until it answers", async () => {
    const home = makeHome();
    const link = fakeLink((command, count) =>
      command === "true" && count < 3 ? { ok: false, error: { code: "ssh-failed", origin: "network", message: "Connection refused" } } : undefined,
    );
    const { dependencies } = createDependencies(home, { createLink: link.createLink });
    await runBoxCreate({ name: "b", dryRun: false, yes: true }, dependencies);
    expect(link.commands.slice(0, 3).map((entry) => entry.command)).toEqual(["true", "true", "true"]);
  });
});

describe("host key and user data", () => {
  test("generateHostKey writes an OpenSSH private key whose ed25519 seed gives the public key", () => {
    const pair = generateHostKey();
    const body = Buffer.from(pair.privateKey.split("\n").filter((line) => !line.startsWith("-----")).join(""), "base64");
    expect(body.subarray(0, 15).toString()).toBe("openssh-key-v1\0");
    const blob = Buffer.from(pair.publicKey.split(" ")[1]!, "base64");
    const publicRaw = blob.subarray(blob.length - 32);
    // The private section ends with the 64-byte key (seed and public key), an empty comment, and the padding.
    const seedAt = body.indexOf(Buffer.concat([Buffer.from([0, 0, 0, 64])]), body.length - 120) + 4;
    const seed = body.subarray(seedAt, seedAt + 32);
    const derived = createPublicKey(
      createPrivateKey({ key: { kty: "OKP", crv: "Ed25519", d: seed.toString("base64url"), x: publicRaw.toString("base64url") }, format: "jwk" }),
    ).export({ format: "jwk" });
    expect(Buffer.from(derived.x!, "base64url")).toEqual(publicRaw);
    expect(body.subarray(seedAt + 32, seedAt + 64)).toEqual(publicRaw);
  });

  test("the user data has no password login, no root login, and only the ferry user with the operator key", () => {
    const data = cloudConfig(OPERATOR_KEY, FIRST_KEY);
    expect(data.startsWith("#cloud-config\n")).toBe(true);
    expect(data).toContain("ssh_pwauth: false");
    expect(data).toContain("disable_root: true");
    expect(data).toContain("lock_passwd: true");
    expect(data).toContain("ssh_genkeytypes: []");
    expect(data).toContain(`      - ${JSON.stringify(OPERATOR_KEY)}`);
    expect(data).toContain("    -----BEGIN OPENSSH PRIVATE KEY-----\n    example\n");
  });
});

function destroyDependencies(home: string, overrides: Partial<BoxDestroyDependencies> = {}) {
  const lines: string[] = [];
  const warnings: string[] = [];
  const provider = fakeProvider();
  provider.machines.push(MACHINE);
  const link = fakeLink();
  const services: string[] = [];
  const dependencies: BoxDestroyDependencies = {
    home,
    readConfig: () => readConfig(home),
    writeConfig: (config: BoxesOperatorConfig) => writeConfig(config, home),
    uninstallTunnelService: async ({ box }) => services.push(box),
    warn: (line) => warnings.push(line),
    provider: provider.factory,
    readSecret: async (name) => (name.env === "HCLOUD_TOKEN" ? { value: TOKEN, source: "environment variable HCLOUD_TOKEN" } : null),
    platform: "linux",
    createLink: link.createLink,
    confirmName: async () => "b",
    writeLine: (line) => lines.push(line),
    progress: noProgress,
    ...overrides,
  };
  return { dependencies, lines, warnings, provider, link };
}

const CREATED_CONFIG = `${CONFIG}[box.b]\ntailscale = "${DNS_NAME}"\nssh_user = "ferry"\n`;

describe("ferry box destroy", () => {
  test("logs the box out of the tailnet, removes the machine, its known_hosts lines, and the box table", async () => {
    const home = makeHome(CREATED_CONFIG);
    writeFileSync(join(home, ".ssh/known_hosts"), `keep.example ${NEW_KEY}\n203.0.113.10 ${NEW_KEY} ferry:b\n`);
    const { dependencies, provider, link, lines } = destroyDependencies(home);
    const result = await runBoxDestroy({ name: "b", dryRun: false, yes: false }, dependencies);

    expect(result).toMatchObject({ name: "b", dryRun: false, machine: MACHINE, knownHosts: 1, removed: { name: "b" } });
    expect(provider.destroyed).toEqual([MACHINE]);
    expect(link.commands.map((entry) => [entry.options, entry.command])).toEqual([[{ host: DNS_NAME, user: "ferry" }, "sudo -n tailscale logout"]]);
    expect(readConfig(home)?.boxes?.map((box) => box.name)).toEqual(["a"]);
    expect(knownHosts(home)).toBe(`keep.example ${NEW_KEY}\n`);
    expect(lines.join("\n")).not.toContain(TOKEN);
  });

  test("removes the last box too", async () => {
    const home = makeHome(`version = 1\npublisher = "operator"\nsnapshot_url = "git@github.com:you/ferry-snapshot.git"\n\n[box.b]\ntailscale = "${DNS_NAME}"\nssh_user = "ferry"\n`);
    const { dependencies } = destroyDependencies(home);
    await runBoxDestroy({ name: "b", dryRun: false, yes: true }, dependencies);
    expect(readConfig(home)?.boxes).toBeUndefined();
  });

  test("a box that is not in the config loses only its machine, and a failed logout is a warning", async () => {
    const home = makeHome();
    const { dependencies, provider, link } = destroyDependencies(home);
    const result = await runBoxDestroy({ name: "b", dryRun: false, yes: true }, dependencies);
    expect(result?.removed).toBeNull();
    expect(provider.destroyed).toEqual([MACHINE]);
    expect(link.commands).toEqual([]);

    const configured = makeHome(CREATED_CONFIG);
    const failing = destroyDependencies(configured, {
      createLink: fakeLink(() => ({ ok: false, error: { code: "ssh-failed", origin: "network", message: "offline" } })).createLink,
    });
    await runBoxDestroy({ name: "b", dryRun: false, yes: true }, failing.dependencies);
    expect(failing.warnings[0]).toContain("Remove the machine in the Tailscale admin console");
    expect(failing.provider.destroyed).toEqual([MACHINE]);
  });

  test("--dry-run and a wrong name change nothing", async () => {
    const home = makeHome(CREATED_CONFIG);
    const dry = destroyDependencies(home);
    expect(await runBoxDestroy({ name: "b", dryRun: true, yes: false }, dry.dependencies)).toMatchObject({ dryRun: true, removed: null });
    expect(dry.lines.join("\n")).toContain("remove the machine ferry-b (id 42, 203.0.113.10) and its firewall");

    const cancelled = destroyDependencies(home, { confirmName: async () => "a" });
    expect(await runBoxDestroy({ name: "b", dryRun: false, yes: false }, cancelled.dependencies)).toBeNull();
    for (const run of [dry, cancelled]) expect(run.provider.destroyed).toEqual([]);
    expect(readConfig(home)?.boxes?.map((box) => box.name)).toEqual(["a", "b"]);
  });

  test("a failed removal at the provider keeps the box in the config, without the token in the error", async () => {
    const home = makeHome(CREATED_CONFIG);
    const { dependencies } = destroyDependencies(home, {
      provider: () => ({
        ...fakeProvider().factory(TOKEN),
        list: async () => [MACHINE],
        destroy: async () => {
          throw new Error(`denied for ${TOKEN}`);
        },
      }),
    });
    const error = (await runBoxDestroy({ name: "b", dryRun: false, yes: true }, dependencies).catch((cause: unknown) => cause)) as Error & { hint: string };
    expect(error.message).not.toContain(TOKEN);
    expect(error.hint).toContain("The box stays in the config");
    expect(readConfig(home)?.boxes?.map((box) => box.name)).toEqual(["a", "b"]);
  });

  test("no machine for the name, or more than one, is refused", async () => {
    const home = makeHome(CREATED_CONFIG);
    const none = destroyDependencies(home);
    none.provider.machines.splice(0);
    await expect(runBoxDestroy({ name: "b", dryRun: false, yes: true }, none.dependencies)).rejects.toMatchObject({
      code: "unknown-box",
      hint: "To remove the box from the config only, run ferry box remove b.",
    });
    const two = destroyDependencies(home);
    two.provider.machines.push({ ...MACHINE, id: "43" });
    await expect(runBoxDestroy({ name: "b", dryRun: false, yes: true }, two.dependencies)).rejects.toMatchObject({ code: "refused" });
    expect(two.provider.destroyed).toEqual([]);
    expect(existsSync(dirname(join(home, ".ferry/config.toml")))).toBe(true);
  });
});

describe("ferry box create and destroy with --json", () => {
  async function runJson(args: string[], home: string, provider = fakeProvider()) {
    const { runCli } = await import("../src/cli.ts");
    const stdout: string[] = [];
    const stderr: string[] = [];
    await runCli(
      ["--json", ...args],
      {
        home: () => home,
        readConfig: () => readConfig(home),
        provider: provider.factory,
        readSecret: async (name) => (name.env === "HCLOUD_TOKEN" ? { value: TOKEN, source: "environment variable HCLOUD_TOKEN" } : null),
        createPlainProgress: () => noProgress,
        writeLine: (line) => stdout.push(line),
        writeError: (line) => stderr.push(line),
      },
      { renderError: () => {}, setExitCode: () => {} },
    );
    return { json: stdout.map((line) => JSON.parse(line)), text: [...stdout, ...stderr].join("\n"), provider };
  }

  test("--dry-run prints the plan in the envelope, and no output has the token", async () => {
    const home = makeHome();
    const result = await runJson(["box", "create", "b", "--dry-run"], home);
    expect(result.json[0]).toMatchObject({
      command: "box create",
      ok: true,
      result: { name: "b", dryRun: true, provider: "hetzner", serverType: "cax21", monthlyPrice: "8.99", machine: null },
    });
    expect(result.provider.created).toEqual([]);
    expect(result.text).not.toContain(TOKEN);
  });

  test("without --yes, create and destroy fail at the question and change nothing", async () => {
    const home = makeHome(CREATED_CONFIG);
    const create = await runJson(["box", "create", "c"], home);
    expect(create.json[0]).toMatchObject({ command: "box create", ok: false, error: { code: "confirmation-required" } });
    expect(create.provider.created).toEqual([]);

    const provider = fakeProvider();
    provider.machines.push(MACHINE);
    const destroy = await runJson(["box", "destroy", "b"], home, provider);
    expect(destroy.json[0]).toMatchObject({ command: "box destroy", ok: false, error: { code: "confirmation-required" } });
    expect(provider.destroyed).toEqual([]);
    expect(destroy.text).not.toContain(TOKEN);
  });
});
