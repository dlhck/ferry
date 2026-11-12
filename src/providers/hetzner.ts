/** The Hetzner Cloud provider of `ferry box create`. It calls the Hetzner Cloud API with the token of the operator. */

import { createHash } from "node:crypto";
import { BOX_LABEL, type Machine, type MachineSpec, type Provider } from "./types.ts";

export const HETZNER_API = "https://api.hetzner.cloud/v1";

/**
 * The defaults of `[provider.hetzner]`. CAX21 is a shared Arm server with 4
 * vCPU, 8 GB memory, and 80 GB disk. Agent CLIs need more than the 4 GB of
 * the smallest types, and the shared x86 types cost more than twice as much.
 * Ubuntu 26.04 has Node 22 in apt, which the Node bootstrap of pi needs.
 */
export const HETZNER_DEFAULTS = { serverType: "cax21", image: "ubuntu-26.04", location: "fsn1" } as const;

export type Fetch = (url: string, init: { method: string; headers: Record<string, string>; body?: string }) => Promise<Response>;

export type HetznerDependencies = {
  readonly fetch?: Fetch;
  readonly sleep?: (ms: number) => Promise<void>;
  /** The time that Ferry waits for one action of the provider. */
  readonly actionTimeoutMs?: number;
};

/** A failed call to the Hetzner Cloud API. The message never has the token. */
export class HetznerError extends Error {
  constructor(
    message: string,
    readonly code: string | null,
  ) {
    super(message);
    this.name = "HetznerError";
  }
}

const ACTION_POLL_MS = 2_000;
const DEFAULT_ACTION_TIMEOUT_MS = 5 * 60_000;
/** The firewall stays in use for some seconds after its server goes. */
const FIREWALL_DELETE_TRIES = 10;

type ApiServer = {
  id: number;
  name: string;
  labels?: Record<string, string>;
  public_net?: { ipv4?: { ip?: string } | null; ipv6?: { ip?: string } | null };
  server_type?: { name?: string };
  datacenter?: { location?: { name?: string } };
};
type ApiAction = { id: number; status: "running" | "success" | "error"; error?: { code?: string; message?: string } | null };

export function createHetzner(token: string, dependencies: HetznerDependencies = {}): Provider {
  const fetcher = dependencies.fetch ?? ((url, init) => fetch(url, init));
  const sleep = dependencies.sleep ?? ((ms: number) => Bun.sleep(ms));
  const actionTimeoutMs = dependencies.actionTimeoutMs ?? DEFAULT_ACTION_TIMEOUT_MS;

  const call = async <T>(method: string, path: string, body?: unknown): Promise<T> => {
    let response: Response;
    try {
      response = await fetcher(`${HETZNER_API}${path}`, {
        method,
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
    } catch (cause) {
      throw new HetznerError(redact(`Ferry could not reach the Hetzner Cloud API: ${messageOf(cause)}`, token), null);
    }
    const text = await response.text();
    const parsed = parseJson(text) as { error?: { code?: string; message?: string } } | undefined;
    if (!response.ok) {
      const code = parsed?.error?.code ?? null;
      const detail = parsed?.error?.message ?? `HTTP ${response.status}`;
      throw new HetznerError(redact(`Hetzner Cloud API ${method} ${path.split("?")[0]} failed: ${detail}${code ? ` (${code})` : ""}`, token), code);
    }
    return (parsed ?? {}) as T;
  };

  const waitFor = async (action: ApiAction | undefined, what: string): Promise<void> => {
    if (action === undefined) return;
    const deadline = Date.now() + actionTimeoutMs;
    let current = action;
    while (current.status === "running") {
      if (Date.now() > deadline) throw new HetznerError(`Hetzner Cloud did not finish the step "${what}" in time`, "timeout");
      await sleep(ACTION_POLL_MS);
      current = (await call<{ action: ApiAction }>("GET", `/actions/${current.id}`)).action;
    }
    if (current.status === "error") {
      throw new HetznerError(redact(`Hetzner Cloud could not ${what}: ${current.error?.message ?? "unknown error"}`, token), current.error?.code ?? null);
    }
  };

  /** The id of the SSH key at Hetzner with the fingerprint of the operator key. Ferry adds the key when Hetzner does not have it. */
  const sshKeyId = async (publicKey: string): Promise<number> => {
    const fingerprint = md5Fingerprint(publicKey);
    const found = await call<{ ssh_keys: { id: number }[] }>("GET", `/ssh_keys?fingerprint=${encodeURIComponent(fingerprint)}`);
    const known = found.ssh_keys?.[0];
    if (known) return known.id;
    const created = await call<{ ssh_key: { id: number } }>("POST", "/ssh_keys", {
      name: `ferry-${fingerprint.replaceAll(":", "").slice(0, 12)}`,
      public_key: publicKey,
    });
    return created.ssh_key.id;
  };

  const firewalls = async (box: string) =>
    (await call<{ firewalls: { id: number; name?: string }[] }>("GET", `/firewalls?label_selector=${encodeURIComponent(`${BOX_LABEL}=${box}`)}`)).firewalls ?? [];

  return {
    id: "hetzner",
    label: "Hetzner Cloud",

    async machineType(serverType, location) {
      const result = await call<{
        server_types: {
          name: string;
          cores: number;
          memory: number;
          disk: number;
          architecture: string;
          prices?: { location: string; price_monthly?: { gross?: string } }[];
        }[];
      }>("GET", `/server_types?name=${encodeURIComponent(serverType)}`);
      const type = result.server_types?.find((known) => known.name === serverType);
      if (!type) throw new HetznerError(`Hetzner Cloud has no server type ${serverType}`, "not_found");
      const price = type.prices?.find((entry) => entry.location === location)?.price_monthly?.gross;
      return {
        name: type.name,
        cores: type.cores,
        memoryGb: type.memory,
        diskGb: type.disk,
        architecture: type.architecture,
        monthlyPrice: price === undefined ? null : Number(price).toFixed(2),
        currency: "EUR",
      };
    },

    async create(spec: MachineSpec): Promise<Machine> {
      const key = await sshKeyId(spec.sshPublicKey);
      const labels = { [BOX_LABEL]: spec.box };
      // The firewall allows SSH only. A firewall of an earlier try for this box is used again.
      const firewall =
        (await firewalls(spec.box))[0] ??
        (
          await call<{ firewall: { id: number } }>("POST", "/firewalls", {
            name: `ferry-${spec.box}`,
            labels,
            rules: [{ direction: "in", protocol: "tcp", port: "22", source_ips: ["0.0.0.0/0", "::/0"], description: "SSH" }],
          })
        ).firewall;
      const created = await call<{ server: ApiServer; action?: ApiAction }>("POST", "/servers", {
        name: `ferry-${spec.box}`,
        server_type: spec.serverType,
        image: spec.image,
        location: spec.location,
        ssh_keys: [key],
        firewalls: [{ firewall: firewall.id }],
        labels,
        user_data: spec.userData,
        start_after_create: true,
        public_net: { enable_ipv4: true, enable_ipv6: true },
      });
      const machine = machineOf(created.server);
      await waitFor(created.action, `create the server ${machine.name}`).catch((cause) => {
        throw new MachineError(machine, cause);
      });
      return machine;
    },

    async destroy(machine: Machine): Promise<string[]> {
      const removed = await call<{ action?: ApiAction }>("DELETE", `/servers/${encodeURIComponent(machine.id)}`);
      await waitFor(removed.action, `remove the server ${machine.name}`);
      // The server is gone, so a firewall that stays is a warning. The operator removes it in the console.
      const firewallName = `ferry-${machine.box}`;
      const warning = (what: string, cause: unknown) =>
        `Warning: Ferry could not remove ${what} at Hetzner Cloud: ${messageOf(cause)}. Remove it in the Hetzner Cloud console.`;
      let found: { id: number; name?: string }[];
      try {
        found = await firewalls(machine.box);
      } catch (cause) {
        return [warning(`the firewall ${firewallName}`, cause)];
      }
      const warnings: string[] = [];
      for (const firewall of found) {
        for (let attempt = 1; ; attempt += 1) {
          try {
            await call("DELETE", `/firewalls/${firewall.id}`);
            break;
          } catch (cause) {
            if (cause instanceof HetznerError && cause.code === "resource_in_use" && attempt < FIREWALL_DELETE_TRIES) {
              await sleep(ACTION_POLL_MS);
              continue;
            }
            warnings.push(warning(`the firewall ${firewall.name ?? firewallName} (id ${firewall.id})`, cause));
            break;
          }
        }
      }
      return warnings;
    },

    async list(): Promise<Machine[]> {
      const machines: Machine[] = [];
      for (let page: number | null = 1; page !== null; ) {
        const result: { servers: ApiServer[]; meta?: { pagination?: { next_page?: number | null } } } = await call(
          "GET",
          `/servers?label_selector=${BOX_LABEL}&per_page=50&page=${page}`,
        );
        machines.push(...(result.servers ?? []).map(machineOf));
        page = result.meta?.pagination?.next_page ?? null;
      }
      return machines;
    },
  };
}

/** The provider created the machine, and a later step failed. */
export class MachineError extends Error {
  constructor(
    readonly machine: Machine,
    cause: unknown,
  ) {
    super(messageOf(cause), { cause });
    this.name = "MachineError";
  }
}

function machineOf(server: ApiServer): Machine {
  return {
    id: String(server.id),
    name: server.name,
    box: server.labels?.[BOX_LABEL] ?? "",
    ipv4: server.public_net?.ipv4?.ip ?? null,
    ipv6: server.public_net?.ipv6?.ip ?? null,
    serverType: server.server_type?.name ?? "",
    location: server.datacenter?.location?.name ?? "",
  };
}

/** The MD5 fingerprint of an OpenSSH public key, as Hetzner shows it: hex pairs with colons. */
export function md5Fingerprint(publicKey: string): string {
  const blob = publicKey.trim().split(/\s+/)[1] ?? "";
  return (createHash("md5").update(Buffer.from(blob, "base64")).digest("hex").match(/../g) ?? []).join(":");
}

/** The text with `[token]` in the place of the token. */
export function redact(text: string, token: string): string {
  return token === "" ? text : text.replaceAll(token, "[token]");
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
