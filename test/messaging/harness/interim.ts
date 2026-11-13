/**
 * Stand-ins for the lane B parts, so that the suites run before lane B merges:
 * an in-process fake GitHub that implements both lane A's `GitHubAccess` and the
 * `FakeGitHub` controls of `contracts.ts`, and a relay transport with `fetch`.
 *
 * `system.ts` uses lane B's fake GitHub server, `createGitHubAccess`, and
 * `RelayClient` when they exist. Remove this file when lane B is on `main`.
 */

import type { GitHubAccess } from "../../../src/messaging/relay/access.ts";
import type { FakeGitHub, FakeGitHubFault, FakePermission, FakeRepository, StartFakeGitHubOptions } from "./contracts.ts";

type DeviceState = { userCode: string; state: "pending" | "slow-down" | "expired" | "denied" | "complete"; userId: number | null };

export class InProcessGitHub implements FakeGitHub, GitHubAccess {
  readonly apiUrl = "http://127.0.0.1:0/in-process";
  readonly webUrl = "http://127.0.0.1:0/in-process";
  readonly app = { appId: 1, clientId: "Iv23example", slug: "acme-ferry-relay", privateKeyPem: "" };
  private readonly users = new Map<number, string>();
  private readonly repositories = new Map<string, FakeRepository>();
  private readonly installations = new Map<string, { id: number; repositories: readonly string[] | null }>();
  private readonly permissions = new Map<string, { permission: FakePermission; roleName: string | null }>();
  private readonly devices = new Map<string, DeviceState>();
  private fault: FakeGitHubFault | null = null;
  private readonly log: { method: string; path: string }[] = [];
  private codes = 0;

  constructor(options: StartFakeGitHubOptions = {}) {
    for (const user of options.users ?? []) this.addUser(user);
    for (const repository of options.repositories ?? []) this.addRepository(repository);
  }

  addUser(user: { login: string; githubUserId: number }): void {
    this.users.set(user.githubUserId, user.login);
  }
  renameUser(githubUserId: number, login: string): void {
    this.users.set(githubUserId, login);
  }
  addRepository(repository: FakeRepository): void {
    this.repositories.set(`${repository.owner}/${repository.name}`.toLowerCase(), repository);
  }
  install(owner: string, repositories?: readonly string[]): number {
    const id = 100 + this.installations.size;
    this.installations.set(owner.toLowerCase(), { id, repositories: repositories?.map((name) => name.toLowerCase()) ?? null });
    return id;
  }
  uninstall(owner: string): void {
    this.installations.delete(owner.toLowerCase());
  }
  setPermission(fullName: string, login: string, permission: FakePermission, roleName: string | null = null): void {
    this.permissions.set(`${fullName.toLowerCase()} ${login.toLowerCase()}`, { permission, roleName });
  }
  pendingUserCodes(): string[] {
    return [...this.devices.values()].filter((device) => device.state === "pending").map((device) => device.userCode);
  }
  authorizeDevice(userCode: string, githubUserId: number): void {
    const device = this.device(userCode);
    device.state = "complete";
    device.userId = githubUserId;
  }
  denyDevice(userCode: string): void {
    this.device(userCode).state = "denied";
  }
  expireDevice(userCode: string): void {
    this.device(userCode).state = "expired";
  }
  slowDownDevice(userCode: string): void {
    this.device(userCode).state = "slow-down";
  }
  setFault(fault: FakeGitHubFault | null): void {
    this.fault = fault;
  }
  requests(): readonly { method: string; path: string }[] {
    return this.log;
  }
  async stop(): Promise<void> {}

  // The `GitHubAccess` interface of the relay (design 14.1).

  async startDeviceFlow() {
    this.record("POST", "/login/device/code");
    this.failIfFaulty();
    this.codes++;
    const deviceCode = `device-code-${this.codes}`;
    const userCode = `ABCD-${1000 + this.codes}`;
    this.devices.set(deviceCode, { userCode, state: "pending", userId: null });
    return { deviceCode, userCode, verificationUri: "https://github.com/login/device", expiresInS: 900, intervalS: 5 };
  }

  async pollDeviceFlow(deviceCode: string) {
    this.record("POST", "/login/oauth/access_token");
    this.failIfFaulty();
    const device = this.devices.get(deviceCode);
    if (device === undefined) return { state: "expired" as const };
    if (device.state === "slow-down") {
      device.state = "pending";
      return { state: "slow-down" as const };
    }
    if (device.state !== "complete") return { state: device.state };
    const id = device.userId!;
    return { state: "complete" as const, user: { id, login: this.users.get(id) ?? `user-${id}` } };
  }

  async resolveRepository(owner: string, repo: string) {
    this.record("GET", `/repos/${owner}/${repo}`);
    if (this.fault !== null) return { state: "unavailable" as const };
    const fullName = `${owner}/${repo}`.toLowerCase();
    const repository = this.repositories.get(fullName);
    if (repository === undefined) return { state: "not-found" as const };
    const installation = this.installations.get(owner.toLowerCase());
    if (installation === undefined || (installation.repositories !== null && !installation.repositories.includes(repo.toLowerCase()))) {
      return { state: "app-not-installed" as const };
    }
    return { state: "ok" as const, repoId: repository.id, fullName, installationId: installation.id };
  }

  async permission(_installationId: number, fullName: string, login: string) {
    this.record("GET", `/repos/${fullName}/collaborators/${login}/permission`);
    if (this.fault !== null) return { state: "unavailable" as const };
    const [owner = ""] = fullName.split("/");
    if (!this.installations.has(owner.toLowerCase())) return { state: "unavailable" as const };
    const found = this.permissions.get(`${fullName.toLowerCase()} ${login.toLowerCase()}`);
    return { state: "ok" as const, permission: found?.permission ?? "none", roleName: found?.roleName ?? null };
  }

  async currentLogin(userId: number) {
    this.record("GET", `/user/${userId}`);
    return this.fault !== null ? null : (this.users.get(userId) ?? null);
  }

  appSlug(): string {
    return this.app.slug;
  }

  private device(userCode: string): DeviceState {
    const device = [...this.devices.values()].find((candidate) => candidate.userCode === userCode);
    if (device === undefined) throw new Error(`no device flow with the user code ${userCode}`);
    return device;
  }

  private record(method: string, path: string): void {
    this.log.push({ method, path });
  }

  private failIfFaulty(): void {
    if (this.fault !== null) throw new Error(`fake GitHub fault: ${this.fault}`);
  }
}

/** A relay transport (lane C's `RelayTransport`) with `fetch` and the device credential. */
export function fetchTransport(url: string, credential: string, ferryVersion: string) {
  return {
    async request(call: { method: string; path: string; body?: unknown; idempotencyKey?: string; signal?: AbortSignal }) {
      const headers: Record<string, string> = { Authorization: `Bearer ${credential}`, "Ferry-Protocol": "1", "Ferry-Version": ferryVersion };
      if (call.idempotencyKey !== undefined) headers["Idempotency-Key"] = call.idempotencyKey;
      if (call.body !== undefined) headers["Content-Type"] = "application/json";
      const response = await fetch(`${url}${call.path}`, {
        method: call.method,
        headers,
        body: call.body === undefined ? undefined : JSON.stringify(call.body),
        signal: call.signal,
      });
      const text = await response.text();
      let body: unknown = null;
      try {
        body = text === "" ? null : JSON.parse(text);
      } catch {
        body = { error: { code: "invalid-response", message: text.slice(0, 200), hint: null } };
      }
      return { status: response.status, body };
    },
  };
}
