import { afterEach, describe, expect, test } from "bun:test";
import {
  ACCESS_GRACE_MS,
  ACCESS_RECHECK_MS,
  applyPermissionCheck,
  checkAccess,
  createGitHubAccess,
  grantValid,
  recheckDue,
  type AccessGrant,
  type GitHubAccess,
  type PermissionLookup,
} from "../../../src/messaging/github/access.ts";
import { DeviceFlowDisabledError } from "../../../src/messaging/github/device-flow.ts";
import { GitHubUnavailableError } from "../../../src/messaging/github/app.ts";
import { startFakeGitHub, type FakeGitHub } from "../fakes/github.ts";

const ALICE = { login: "alice", githubUserId: 1001 };
const BOB = { login: "bob", githubUserId: 1002 };
const APP_REPO = { owner: "acme", name: "app", id: 501 };
const START = Date.parse("2026-01-05T09:00:00.000Z");
const MINUTE = 60_000;

const clockAt = (start = START) => {
  let now = start;
  return { now: () => now, advance: (ms: number) => void (now += ms) };
};

const fakes: FakeGitHub[] = [];
afterEach(async () => {
  for (const fake of fakes.splice(0)) await fake.stop();
});

async function setup(clock = clockAt()): Promise<{ github: FakeGitHub; access: GitHubAccess }> {
  const github = await startFakeGitHub({ users: [ALICE, BOB], repositories: [APP_REPO, { owner: "acme", name: "docs", id: 502 }], clock });
  fakes.push(github);
  const access = createGitHubAccess({
    appId: github.app.appId,
    clientId: github.app.clientId,
    slug: github.app.slug,
    privateKey: github.app.privateKeyPem,
    endpoints: { api: github.apiUrl, web: github.webUrl },
    clock,
  });
  return { github, access };
}

describe("the device flow against the fake GitHub", () => {
  test("goes from pending through slow-down to complete, and keeps only the user id and login", async () => {
    const { github, access } = await setup();
    const code = await access.startDeviceFlow();

    expect(code).toMatchObject({ userCode: github.pendingUserCodes()[0], verificationUri: "https://github.com/login/device", intervalS: 5 });
    expect(await access.pollDeviceFlow(code.deviceCode)).toEqual({ state: "pending" });
    github.slowDownDevice(code.userCode);
    expect(await access.pollDeviceFlow(code.deviceCode)).toEqual({ state: "slow-down" });
    github.authorizeDevice(code.userCode, ALICE.githubUserId);

    const result = await access.pollDeviceFlow(code.deviceCode);
    expect(result).toEqual({ state: "complete", user: { id: 1001, login: "alice" } });
    expect(JSON.stringify(result)).not.toContain("fake-user-token");
    expect(await access.pollDeviceFlow(code.deviceCode)).toEqual({ state: "expired" });
  });

  test("a denied and an expired code end the flow", async () => {
    const clock = clockAt();
    const { github, access } = await setup(clock);
    const denied = await access.startDeviceFlow();
    const expired = await access.startDeviceFlow();
    const late = await access.startDeviceFlow();
    github.denyDevice(denied.userCode);
    github.expireDevice(expired.userCode);

    expect(await access.pollDeviceFlow(denied.deviceCode)).toEqual({ state: "denied" });
    expect(await access.pollDeviceFlow(expired.deviceCode)).toEqual({ state: "expired" });
    clock.advance(late.expiresInS * 1000);
    expect(await access.pollDeviceFlow(late.deviceCode)).toEqual({ state: "expired" });
  });

  test("an App with the device flow off and an unavailable GitHub reject", async () => {
    const { github, access } = await setup();
    github.setDeviceFlow(false);
    await expect(access.startDeviceFlow()).rejects.toBeInstanceOf(DeviceFlowDisabledError);

    github.setDeviceFlow(true);
    github.setFault("server-error");
    await expect(access.startDeviceFlow()).rejects.toBeInstanceOf(GitHubUnavailableError);
  });
});

describe("repository lookup", () => {
  test("gives the repository id, the canonical name, and the installation", async () => {
    const { github, access } = await setup();
    const installation = github.install("acme");

    expect(await access.resolveRepository("Acme", "App")).toEqual({ state: "ok", repoId: 501, fullName: "acme/app", installationId: installation });
    expect(access.appSlug()).toBe("example-ferry-relay");
  });

  test("an App that is not installed, or not given the repository, is app-not-installed", async () => {
    const { github, access } = await setup();
    expect(await access.resolveRepository("acme", "app")).toEqual({ state: "app-not-installed" });

    github.install("acme", ["docs"]);
    expect(await access.resolveRepository("acme", "app")).toEqual({ state: "app-not-installed" });
    expect(await access.resolveRepository("acme", "docs")).toMatchObject({ state: "ok", repoId: 502 });
  });

  test.each(["server-error", "rate-limit", "drop"] as const)("GitHub with the fault %s is unavailable", async (fault) => {
    const { github, access } = await setup();
    github.install("acme");
    github.setFault(fault);

    expect(await access.resolveRepository("acme", "app")).toEqual({ state: "unavailable" });
  });
});

describe("permission lookup", () => {
  test("gives the permission and the role name, and a non-collaborator is none", async () => {
    const { github, access } = await setup();
    const installation = github.install("acme");
    github.setPermission("acme/app", "alice", "write", "maintain");
    github.setPermission("acme/app", "bob", "read", "triage");

    expect(await access.permission(installation, "acme/app", "alice")).toEqual({ state: "ok", permission: "write", roleName: "maintain" });
    expect(await access.permission(installation, "acme/app", "bob")).toEqual({ state: "ok", permission: "read", roleName: "triage" });
    expect(await access.permission(installation, "acme/docs", "alice")).toEqual({ state: "ok", permission: "none", roleName: null });
  });

  test("an uninstalled App means no access, and GitHub problems are unavailable", async () => {
    const { github, access } = await setup();
    const installation = github.install("acme");
    github.setPermission("acme/app", "alice", "admin");
    expect(await access.permission(installation, "acme/app", "alice")).toMatchObject({ permission: "admin" });

    github.setFault("drop");
    expect(await access.permission(installation, "acme/app", "alice")).toEqual({ state: "unavailable" });
    github.setFault(null);

    github.uninstall("acme");
    // GitHub refuses the cached token. The retry mints a new token, and the mint finds no installation.
    expect(await access.permission(installation, "acme/app", "alice")).toEqual({ state: "ok", permission: "none", roleName: null });
  });

  test("the current login follows a rename of the user id", async () => {
    const { github, access } = await setup();
    const installation = github.install("acme");
    github.setPermission("acme/app", "alice", "write");
    await access.permission(installation, "acme/app", "alice");

    github.renameUser(ALICE.githubUserId, "alice-example");
    expect(await access.currentLogin(ALICE.githubUserId)).toBe("alice-example");
    expect(await access.currentLogin(4040)).toBeNull();
    github.setFault("server-error");
    expect(await access.currentLogin(ALICE.githubUserId)).toBeNull();
  });
});

describe("revalidation timing", () => {
  const ok = (permission: "admin" | "write" | "read" | "none"): PermissionLookup => ({ state: "ok", permission, roleName: null });
  const unavailable: PermissionLookup = { state: "unavailable" };
  const iso = (ms: number) => new Date(ms).toISOString();

  test("a grant needs a recheck 15 minutes after the last attempt", () => {
    const { grant } = applyPermissionCheck(null, ok("write"), START);

    expect(recheckDue(null, START)).toBe(true);
    expect(recheckDue(grant, START + ACCESS_RECHECK_MS - 1)).toBe(false);
    expect(recheckDue(grant, START + ACCESS_RECHECK_MS)).toBe(true);
  });

  test("write and admin qualify, read and none end the memberships", () => {
    const granted = applyPermissionCheck(null, ok("admin"), START);
    expect(granted).toEqual({
      grant: { permission: "admin", roleName: null, state: "granted", lastSuccessAt: iso(START), lastAttemptAt: iso(START), lastError: null },
      effect: "none",
    });
    expect(grantValid(granted.grant, START)).toBe(true);

    for (const permission of ["read", "none"] as const) {
      const lost = applyPermissionCheck(granted.grant, ok(permission), START + 15 * MINUTE);
      expect(lost.grant.state).toBe("lost");
      expect(lost.effect).toBe("end");
      expect(grantValid(lost.grant, START + 15 * MINUTE)).toBe(false);
      expect(applyPermissionCheck(lost.grant, ok(permission), START + 30 * MINUTE).effect).toBe("none");
    }
  });

  test("an outage keeps the grant for 1 hour after the last success, then suspends, and a success restores", () => {
    let { grant } = applyPermissionCheck(null, ok("write"), START);
    const effects: string[] = [];
    // The background check runs every 15 minutes while GitHub is down.
    for (const minute of [15, 30, 45]) {
      const result = applyPermissionCheck(grant, unavailable, START + minute * MINUTE);
      grant = result.grant;
      effects.push(result.effect);
      expect(grantValid(grant, START + minute * MINUTE)).toBe(true);
    }
    expect(grant).toMatchObject({ state: "granted", lastSuccessAt: iso(START), lastAttemptAt: iso(START + 45 * MINUTE), lastError: "GitHub unavailable" });
    expect(grantValid(grant, START + ACCESS_GRACE_MS - 1)).toBe(true);
    expect(grantValid(grant, START + ACCESS_GRACE_MS)).toBe(false);

    const suspended = applyPermissionCheck(grant, unavailable, START + ACCESS_GRACE_MS);
    expect(suspended).toMatchObject({ grant: { state: "unverifiable", lastSuccessAt: iso(START) }, effect: "suspend" });
    expect(applyPermissionCheck(suspended.grant, unavailable, START + 75 * MINUTE).effect).toBe("none");

    const restored = applyPermissionCheck(suspended.grant, ok("write"), START + 90 * MINUTE);
    expect(restored).toMatchObject({ grant: { state: "granted", lastSuccessAt: iso(START + 90 * MINUTE), lastError: null }, effect: "restore" });
    expect(effects).toEqual(["none", "none", "none"]);
  });

  test("no answer keeps a lost grant lost, and a first check without an answer is unverifiable", () => {
    const lost = applyPermissionCheck(null, ok("read"), START).grant;
    expect(applyPermissionCheck(lost, unavailable, START + MINUTE)).toMatchObject({ grant: { state: "lost" }, effect: "none" });
    expect(applyPermissionCheck(null, unavailable, START)).toMatchObject({ grant: { state: "unverifiable", lastSuccessAt: null }, effect: "none" });
  });

  test("a grant that no check has renewed for 1 hour is not valid", () => {
    const { grant } = applyPermissionCheck(null, ok("write"), START);
    expect(grantValid(grant, START + ACCESS_GRACE_MS)).toBe(false);
  });

  test("checkAccess loses access within one recheck period after the fake GitHub lowers the permission", async () => {
    const clock = clockAt();
    const { github, access } = await setup(clock);
    const installation = github.install("acme");
    github.setPermission("acme/app", "bob", "write");
    const target = { installationId: installation, fullName: "acme/app", login: "bob" };
    let grant: AccessGrant | null = (await checkAccess(access, target, null, clock)).grant;
    expect(grant.state).toBe("granted");

    github.setPermission("acme/app", "bob", "read");
    clock.advance(ACCESS_RECHECK_MS);
    expect(recheckDue(grant, clock.now())).toBe(true);
    const result = await checkAccess(access, target, grant, clock);
    grant = result.grant;

    expect(result.effect).toBe("end");
    expect(grant).toMatchObject({ state: "lost", permission: "read" });
  });
});
