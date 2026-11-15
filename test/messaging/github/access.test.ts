import { afterEach, describe, expect, test } from "bun:test";
import { createGitHubAccess, type GitHubAccess } from "../../../src/messaging/github/access.ts";
import { DeviceFlowDisabledError } from "../../../src/messaging/github/device-flow.ts";
import { GitHubUnavailableError } from "../../../src/messaging/github/app.ts";
import { startFakeGitHub, type FakeGitHub } from "../fakes/github.ts";

const ALICE = { login: "alice", githubUserId: 1001 };
const BOB = { login: "bob", githubUserId: 1002 };
const APP_REPO = { owner: "acme", name: "app", id: 501 };
const START = Date.parse("2026-01-05T09:00:00.000Z");

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
    privateKeyPem: github.app.privateKeyPem,
    apiUrl: github.apiUrl,
    webUrl: github.webUrl,
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

  test("a removed installation and GitHub problems are unavailable, and the repository lookup tells removal from a new install", async () => {
    const { github, access } = await setup();
    const installation = github.install("acme");
    github.setPermission("acme/app", "alice", "admin");
    expect(await access.permission(installation, "acme/app", "alice")).toMatchObject({ permission: "admin" });

    github.setFault("drop");
    expect(await access.permission(installation, "acme/app", "alice")).toEqual({ state: "unavailable" });
    github.setFault(null);

    github.uninstall("acme");
    // GitHub refuses the cached token. The retry mints a new token, and the mint finds no installation.
    expect(await access.permission(installation, "acme/app", "alice")).toEqual({ state: "unavailable" });
    expect(await access.resolveRepository("acme", "app")).toEqual({ state: "app-not-installed" });

    const reinstalled = github.install("acme");
    expect(reinstalled).not.toBe(installation);
    expect(await access.permission(installation, "acme/app", "alice")).toEqual({ state: "unavailable" });
    expect(await access.resolveRepository("acme", "app")).toMatchObject({ state: "ok", installationId: reinstalled });
    expect(await access.permission(reinstalled, "acme/app", "alice")).toMatchObject({ state: "ok", permission: "admin" });
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
