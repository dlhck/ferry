import { describe, expect, test } from "bun:test";
import { findSecret, HETZNER_TOKEN, TAILSCALE_AUTH_KEY, type SecretDependencies } from "../src/providers/credentials.ts";
import { createHetzner, HetznerError, MachineError, md5Fingerprint, type Fetch } from "../src/providers/hetzner.ts";

const TOKEN = "example-hcloud-token-0123456789abcdef";
const OPERATOR_KEY = "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIExampleOperatorKeyOnlyForTests0123456789ab operator@example.com";

type Call = { method: string; path: string; body: unknown; authorization: string };

/** A fake Hetzner Cloud API. Each route returns [status, body]. */
function fakeApi(routes: Record<string, (body: unknown, count: number) => [number, unknown]>) {
  const calls: Call[] = [];
  const counts = new Map<string, number>();
  const fetch: Fetch = async (url, init) => {
    const path = url.replace("https://api.hetzner.cloud/v1", "");
    const key = `${init.method} ${path}`;
    calls.push({ method: init.method, path, body: init.body ? JSON.parse(init.body) : undefined, authorization: init.headers.Authorization ?? "" });
    const route = Object.keys(routes).find((pattern) => key === pattern || key.startsWith(`${pattern}?`));
    if (!route) return new Response(JSON.stringify({ error: { code: "not_found", message: `no route ${key}` } }), { status: 404 });
    const count = (counts.get(route) ?? 0) + 1;
    counts.set(route, count);
    const [status, body] = routes[route]!(calls.at(-1)!.body, count);
    return new Response(JSON.stringify(body), { status });
  };
  return { fetch, calls };
}

const server = { id: 42, name: "ferry-b", labels: { "ferry-box": "b" }, public_net: { ipv4: { ip: "203.0.113.10" }, ipv6: { ip: "2001:db8::/64" } }, server_type: { name: "cax21" }, datacenter: { location: { name: "fsn1" } } };
const noSleep = async () => {};

describe("Hetzner Cloud provider", () => {
  test("create adds the SSH key and a firewall for port 22, then waits for the server action", async () => {
    const api = fakeApi({
      "GET /ssh_keys": () => [200, { ssh_keys: [] }],
      "POST /ssh_keys": () => [201, { ssh_key: { id: 7 } }],
      "GET /firewalls": () => [200, { firewalls: [] }],
      "POST /firewalls": () => [201, { firewall: { id: 9 } }],
      "POST /servers": () => [201, { server, action: { id: 100, status: "running" } }],
      "GET /actions/100": (_, count) => [200, { action: { id: 100, status: count < 2 ? "running" : "success" } }],
    });
    const provider = createHetzner(TOKEN, { fetch: api.fetch, sleep: noSleep });
    const machine = await provider.create({ box: "b", serverType: "cax21", image: "ubuntu-24.04", location: "fsn1", sshPublicKey: OPERATOR_KEY, userData: "#cloud-config\n" });

    expect(machine).toEqual({ id: "42", name: "ferry-b", box: "b", ipv4: "203.0.113.10", ipv6: "2001:db8::/64", serverType: "cax21", location: "fsn1" });
    expect(api.calls.every((call) => call.authorization === `Bearer ${TOKEN}`)).toBe(true);
    expect(api.calls[0]?.path).toBe(`/ssh_keys?fingerprint=${encodeURIComponent(md5Fingerprint(OPERATOR_KEY))}`);
    const firewall = api.calls.find((call) => call.method === "POST" && call.path === "/firewalls")?.body as { rules: unknown[] };
    expect(firewall.rules).toEqual([{ direction: "in", protocol: "tcp", port: "22", source_ips: ["0.0.0.0/0", "::/0"], description: "SSH" }]);
    expect(api.calls.find((call) => call.path === "/servers")?.body).toMatchObject({
      name: "ferry-b",
      server_type: "cax21",
      image: "ubuntu-24.04",
      location: "fsn1",
      ssh_keys: [7],
      firewalls: [{ firewall: 9 }],
      labels: { "ferry-box": "b" },
      user_data: "#cloud-config\n",
    });
    expect(api.calls.filter((call) => call.path === "/actions/100")).toHaveLength(2);
  });

  test("a failed server action gives a MachineError that names the machine", async () => {
    const api = fakeApi({
      "GET /ssh_keys": () => [200, { ssh_keys: [{ id: 7 }] }],
      "GET /firewalls": () => [200, { firewalls: [{ id: 9 }] }],
      "POST /servers": () => [201, { server, action: { id: 100, status: "error", error: { code: "x", message: "no capacity" } } }],
    });
    const provider = createHetzner(TOKEN, { fetch: api.fetch, sleep: noSleep });
    const error = await provider
      .create({ box: "b", serverType: "cax21", image: "ubuntu-24.04", location: "fsn1", sshPublicKey: OPERATOR_KEY, userData: "" })
      .catch((cause: unknown) => cause);
    expect(error).toBeInstanceOf(MachineError);
    expect((error as MachineError).machine.id).toBe("42");
    expect(api.calls.some((call) => call.method === "POST" && call.path === "/ssh_keys")).toBe(false);
    expect(api.calls.some((call) => call.method === "POST" && call.path === "/firewalls")).toBe(false);
  });

  test("an API error never has the token in its message", async () => {
    const api = fakeApi({ "GET /servers": () => [401, { error: { code: "unauthorized", message: `token ${TOKEN} is invalid` } }] });
    const error = (await createHetzner(TOKEN, { fetch: api.fetch }).list().catch((cause: unknown) => cause)) as HetznerError;
    expect(error).toBeInstanceOf(HetznerError);
    expect(error.message).not.toContain(TOKEN);
    expect(error.message).toContain("[token]");
    expect(error.code).toBe("unauthorized");

    const thrown = (await createHetzner(TOKEN, {
      fetch: async () => {
        throw new Error(`connect failed for ${TOKEN}`);
      },
    })
      .list()
      .catch((cause: unknown) => cause)) as Error;
    expect(thrown.message).not.toContain(TOKEN);
  });

  test("list reads each page of the servers with the Ferry label", async () => {
    const api = fakeApi({
      "GET /servers": (_, count) => [200, { servers: [{ ...server, id: count }], meta: { pagination: { next_page: count < 2 ? 2 : null } } }],
    });
    const machines = await createHetzner(TOKEN, { fetch: api.fetch }).list();
    expect(machines.map((machine) => machine.id)).toEqual(["1", "2"]);
    expect(api.calls.map((call) => call.path)).toEqual([
      "/servers?label_selector=ferry-box&per_page=50&page=1",
      "/servers?label_selector=ferry-box&per_page=50&page=2",
    ]);
  });

  test("destroy removes the server, then its firewall, and tries again while the firewall is in use", async () => {
    const api = fakeApi({
      "DELETE /servers/42": () => [200, { action: { id: 5, status: "success" } }],
      "GET /firewalls": () => [200, { firewalls: [{ id: 9 }] }],
      "DELETE /firewalls/9": (_, count) => (count < 3 ? [409, { error: { code: "resource_in_use", message: "in use" } }] : [204, {}]),
    });
    await createHetzner(TOKEN, { fetch: api.fetch, sleep: noSleep }).destroy({
      id: "42", name: "ferry-b", box: "b", ipv4: null, ipv6: null, serverType: "cax21", location: "fsn1",
    });
    expect(api.calls.map((call) => `${call.method} ${call.path}`)).toEqual([
      "DELETE /servers/42",
      `GET /firewalls?label_selector=${encodeURIComponent("ferry-box=b")}`,
      "DELETE /firewalls/9",
      "DELETE /firewalls/9",
      "DELETE /firewalls/9",
    ]);
  });

  test("destroy warns with the firewall name when the firewall stays after the server is gone", async () => {
    const api = fakeApi({
      "DELETE /servers/42": () => [200, { action: { id: 5, status: "success" } }],
      "GET /firewalls": () => [200, { firewalls: [{ id: 9, name: "ferry-b" }] }],
      "DELETE /firewalls/9": () => [403, { error: { code: "forbidden", message: `no access for ${TOKEN}` } }],
    });
    const warnings = await createHetzner(TOKEN, { fetch: api.fetch, sleep: noSleep }).destroy({
      id: "42", name: "ferry-b", box: "b", ipv4: null, ipv6: null, serverType: "cax21", location: "fsn1",
    });
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("the firewall ferry-b (id 9)");
    expect(warnings[0]).toContain("Remove it in the Hetzner Cloud console");
    expect(warnings[0]).not.toContain(TOKEN);

    const unread = fakeApi({
      "DELETE /servers/42": () => [200, {}],
      "GET /firewalls": () => [500, { error: { code: "server_error", message: "down" } }],
    });
    const listed = await createHetzner(TOKEN, { fetch: unread.fetch, sleep: noSleep }).destroy({
      id: "42", name: "ferry-b", box: "b", ipv4: null, ipv6: null, serverType: "cax21", location: "fsn1",
    });
    expect(listed).toEqual([expect.stringContaining("the firewall ferry-b at Hetzner Cloud")]);
  });

  test("machineType gives the size and the gross monthly price of the location", async () => {
    const api = fakeApi({
      "GET /server_types": () => [200, {
        server_types: [{ name: "cax21", cores: 4, memory: 8, disk: 80, architecture: "arm", prices: [{ location: "fsn1", price_monthly: { gross: "8.9900000000" } }] }],
      }],
    });
    const provider = createHetzner(TOKEN, { fetch: api.fetch });
    expect(await provider.machineType("cax21", "fsn1")).toEqual({
      name: "cax21", cores: 4, memoryGb: 8, diskGb: 80, architecture: "arm", monthlyPrice: "8.99", currency: "EUR",
    });
    expect((await provider.machineType("cax21", "ash")).monthlyPrice).toBeNull();
    await expect(provider.machineType("cx99", "fsn1")).rejects.toThrow("no server type cx99");
  });
});

describe("credentials", () => {
  const deps = (overrides: Partial<SecretDependencies> = {}) => {
    const calls: string[][] = [];
    const dependencies: SecretDependencies = {
      env: {},
      platform: "linux",
      which: (program) => `/usr/bin/${program}`,
      readProcess: async (argv) => {
        calls.push([...argv]);
        return { exitCode: 0, stdout: "from-store\n" };
      },
      ...overrides,
    };
    return { dependencies, calls };
  };

  test("the environment variable comes first", async () => {
    const { dependencies, calls } = deps({ env: { HCLOUD_TOKEN: " env-token " } });
    expect(await findSecret(HETZNER_TOKEN, dependencies)).toEqual({ value: "env-token", source: "environment variable HCLOUD_TOKEN" });
    expect(calls).toEqual([]);
  });

  test("macOS reads the login keychain", async () => {
    const { dependencies, calls } = deps({ platform: "darwin" });
    expect(await findSecret(TAILSCALE_AUTH_KEY, dependencies)).toEqual({ value: "from-store", source: "macOS keychain" });
    expect(calls).toEqual([["security", "find-generic-password", "-s", "ferry", "-a", "tailscale", "-w"]]);
  });

  test("Linux reads the Secret Service only when secret-tool is on the PATH", async () => {
    const present = deps();
    expect(await findSecret(HETZNER_TOKEN, present.dependencies)).toEqual({ value: "from-store", source: "Secret Service" });
    expect(present.calls).toEqual([["secret-tool", "lookup", "service", "ferry", "account", "hetzner"]]);

    const absent = deps({ which: () => null });
    expect(await findSecret(HETZNER_TOKEN, absent.dependencies)).toBeNull();
    expect(absent.calls).toEqual([]);
  });

  test("a failed or empty lookup gives no secret", async () => {
    expect(await findSecret(HETZNER_TOKEN, deps({ readProcess: async () => ({ exitCode: 1, stdout: "x" }) }).dependencies)).toBeNull();
    expect(await findSecret(HETZNER_TOKEN, deps({ readProcess: async () => ({ exitCode: 0, stdout: "\n" }) }).dependencies)).toBeNull();
    expect(await findSecret(HETZNER_TOKEN, deps({ platform: "win32" }).dependencies)).toBeNull();
  });
});
