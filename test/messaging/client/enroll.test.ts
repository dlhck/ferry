import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { messagingDir, readClientConfig, readCredential, writeClientConfig, writeCredential } from "../../../src/messaging/client/credential.ts";
import { enroll, enrollBox } from "../../../src/messaging/client/enroll.ts";
import { createGitHubAccess, type GitHubAccess } from "../../../src/messaging/github/access.ts";
import { credentialSha256, newDeviceCredential, newId } from "../../../src/messaging/ids.ts";
import { startFakeGitHub, type FakeGitHub } from "../fakes/github.ts";

const ALICE = { login: "alice", githubUserId: 1001 };
const ISO = "2026-01-05T09:00:00.000Z";

const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});
const makeHome = () => {
  const home = mkdtempSync(join(tmpdir(), "ferry-enroll-"));
  cleanups.push(() => rmSync(home, { recursive: true, force: true }));
  return home;
};

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
const relayError = (status: number, code: string) => json(status, { error: { code, message: code, hint: null } });

/**
 * The enrollment endpoints of a relay, over the real `GitHubAccess` and the fake GitHub.
 * `forget()` drops all enrollments, as a relay restart does.
 */
function enrollmentRelay(access: GitHubAccess) {
  const enrollments = new Map<string, { deviceCode: string; deviceName: string; hash: string }>();
  const devices = new Map<string, { id: string; name: string; owner: string; revoked: boolean }>();
  const owner = { id: newId("owner"), githubUserId: ALICE.githubUserId, login: ALICE.login };
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      const path = new URL(request.url).pathname;
      const body = request.method === "POST" ? ((await request.json()) as Record<string, string>) : {};
      if (path === "/v1/enroll/start") {
        const code = await access.startDeviceFlow();
        const enrollmentId = `enr-${enrollments.size + 1}`;
        enrollments.set(enrollmentId, { deviceCode: code.deviceCode, deviceName: body.deviceName!, hash: body.credentialSha256! });
        return json(200, { enrollmentId, userCode: code.userCode, verificationUri: code.verificationUri, intervalMs: 1, expiresAt: ISO });
      }
      if (path === "/v1/enroll/poll") {
        const enrollment = enrollments.get(body.enrollmentId!);
        if (!enrollment) return relayError(404, "enrollment-unknown");
        const polled = await access.pollDeviceFlow(enrollment.deviceCode);
        if (polled.state === "pending" || polled.state === "slow-down") return json(202, { state: "pending", intervalMs: 1 });
        if (polled.state === "denied") return relayError(410, "enrollment-denied");
        if (polled.state === "expired") return relayError(410, "enrollment-expired");
        const device = { id: newId("device"), name: enrollment.deviceName, owner: polled.user.login, revoked: false };
        devices.set(enrollment.hash, device);
        return json(200, { state: "complete", owner: { ...owner, login: polled.user.login }, device: { id: device.id, name: device.name } });
      }
      const bearer = /^Bearer (fmr_.+)$/.exec(request.headers.get("authorization") ?? "")?.[1];
      const caller = bearer === undefined ? undefined : devices.get(credentialSha256(bearer));
      if (!caller || caller.revoked) return relayError(401, "unauthenticated");
      if (path === "/v1/devices") {
        const device = { id: newId("device"), name: body.name!, owner: caller.owner, revoked: false };
        devices.set(body.credentialSha256!, device);
        return json(200, { device: { id: device.id, name: device.name } });
      }
      const revoke = /^\/v1\/devices\/([^/]+)\/revoke$/.exec(path);
      if (revoke) {
        for (const device of devices.values()) if (device.id === revoke[1]) device.revoked = true;
        return json(200, { device: { id: revoke[1], revokedAt: ISO } });
      }
      return relayError(404, "not-found");
    },
  });
  cleanups.push(() => server.stop(true));
  return { url: `http://127.0.0.1:${server.port}`, devices, forget: () => enrollments.clear() };
}

async function setup() {
  const github: FakeGitHub = await startFakeGitHub({ users: [ALICE] });
  cleanups.push(() => github.stop());
  const access = createGitHubAccess({
    appId: github.app.appId,
    clientId: github.app.clientId,
    slug: github.app.slug,
    privateKeyPem: github.app.privateKeyPem,
    apiUrl: github.apiUrl,
    webUrl: github.webUrl,
  });
  return { github, relay: enrollmentRelay(access) };
}

/** Every file under `dir`, as text. */
const allText = (dir: string): string =>
  readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => readFileSync(join(entry.parentPath, entry.name), "utf8"))
    .join("\n");

describe("ferry messaging enroll", () => {
  test("runs the device flow through the relay and writes only the credential and the client config", async () => {
    const { github, relay } = await setup();
    const home = makeHome();
    const lines: string[] = [];

    const result = await enroll({
      home,
      relayUrl: `${relay.url}/`,
      deviceName: "alice-laptop",
      platform: "linux",
      ferryVersion: "0.12.0",
      print: (line) => lines.push(line),
      sleep: async () => {
        const [code] = github.pendingUserCodes();
        if (code) github.authorizeDevice(code, ALICE.githubUserId);
      },
    });

    const credential = readCredential(home)!;
    const device = relay.devices.get(credentialSha256(credential));
    expect(device).toMatchObject({ name: "alice-laptop", owner: "alice" });
    expect(result).toMatchObject({ owner: { login: "alice", githubUserId: 1001 }, device: { id: device!.id, name: "alice-laptop" }, relayUrl: relay.url });
    expect(readClientConfig(home)).toEqual({ schemaVersion: 1, relayUrl: relay.url, deviceId: device!.id, ownerLogin: "alice" });
    expect(statSync(messagingDir(home)).mode & 0o777).toBe(0o700);
    expect(statSync(join(messagingDir(home), "credential")).mode & 0o777).toBe(0o600);
    expect(statSync(join(messagingDir(home), "client.json")).mode & 0o777).toBe(0o600);
    expect(lines[0]).toMatch(/^Open https:\/\/github\.com\/login\/device and enter the code [0-9A-F]{4}-[0-9A-F]{4}\.$/);
    expect(lines.join("\n")).not.toContain(credential);
    expect(allText(home)).not.toContain("fake-user-token");
  });

  test("starts again with a new code when the relay lost the enrollment", async () => {
    const { github, relay } = await setup();
    const home = makeHome();
    const lines: string[] = [];
    let sleeps = 0;

    await enroll({
      home,
      relayUrl: relay.url,
      deviceName: "alice-laptop",
      platform: "linux",
      ferryVersion: "0.12.0",
      print: (line) => lines.push(line),
      sleep: async () => {
        sleeps++;
        if (sleeps === 1) relay.forget();
        const [code] = github.pendingUserCodes().slice(-1);
        if (sleeps > 1 && code) github.authorizeDevice(code, ALICE.githubUserId);
      },
    });

    expect(lines.filter((line) => line.startsWith("Open "))).toHaveLength(2);
    expect(lines).toContain("The relay lost the enrollment, for example after a restart. Ferry starts it again with a new code.");
    expect(relay.devices.has(credentialSha256(readCredential(home)!))).toBe(true);
  });

  test.each([
    ["deny", "GitHub denied the authorization."],
    ["expire", "The code expired before the GitHub authorization."],
  ] as const)("a code that GitHub flags with %s writes nothing", async (action, message) => {
    const { github, relay } = await setup();
    const home = makeHome();

    const run = enroll({
      home,
      relayUrl: relay.url,
      deviceName: "alice-laptop",
      platform: "linux",
      ferryVersion: "0.12.0",
      print: () => {},
      sleep: async () => {
        const [code] = github.pendingUserCodes();
        if (code) (action === "deny" ? github.denyDevice(code) : github.expireDevice(code));
      },
    });

    await expect(run).rejects.toThrow(message);
    expect(readCredential(home)).toBeNull();
    expect(readClientConfig(home)).toBeNull();
  });

  test("refuses a relay URL with plain http to another host", async () => {
    await expect(
      enroll({ home: makeHome(), relayUrl: "http://relay.example.com", deviceName: "x", platform: "linux", ferryVersion: "0.12.0", print: () => {} }),
    ).rejects.toThrow("must use https://");
  });
});

describe("ferry messaging enroll --box", () => {
  /** A link that runs the command with sh in a home of the test, as SSH would on the box. */
  const shLink = (home: string, commands: string[] = []) => ({
    run: async (command: string, options: { input?: Uint8Array } = {}) => {
      commands.push(command);
      const result = Bun.spawnSync(["sh", "-c", command], { env: { HOME: home, PATH: process.env.PATH ?? "" }, stdin: options.input ? Buffer.from(options.input) : "ignore" });
      return result.exitCode === 0
        ? ({ ok: true, address: "box.example", stdout: result.stdout.toString(), stderr: "" } as const)
        : ({ ok: false, error: { code: "command-failed", origin: "box", message: "failed" } } as const);
    },
  });

  async function enrolledOperator() {
    const { relay } = await setup();
    const home = makeHome();
    const credential = newDeviceCredential();
    const id = newId("device");
    relay.devices.set(credentialSha256(credential), { id, name: "alice-laptop", owner: "alice", revoked: false });
    writeCredential(home, credential);
    writeClientConfig(home, { schemaVersion: 1, relayUrl: relay.url, deviceId: id, ownerLogin: "alice" });
    return { relay, home, credential };
  }

  test("creates a device for the same owner and sends its credential over standard input", async () => {
    const { relay, home, credential } = await enrolledOperator();
    const box = makeHome();
    const commands: string[] = [];

    const { device } = await enrollBox({ home, box: "fsn-example", link: shLink(box, commands), ferryVersion: "0.12.0" });

    const boxCredential = readCredential(box)!;
    expect(boxCredential).not.toBe(credential);
    expect(relay.devices.get(credentialSha256(boxCredential))).toMatchObject({ id: device.id, name: "fsn-example", owner: "alice" });
    expect(readClientConfig(box)).toEqual({ schemaVersion: 1, relayUrl: relay.url, deviceId: device.id, ownerLogin: "alice" });
    expect(statSync(join(messagingDir(box), "credential")).mode & 0o777).toBe(0o600);
    expect(statSync(messagingDir(box)).mode & 0o777).toBe(0o700);
    expect(commands.join("\n")).not.toContain("fmr_");
  });

  test("revokes the new device when the box does not get the credential", async () => {
    const { relay, home } = await enrolledOperator();
    const failing = { run: async () => ({ ok: false, error: { code: "command-failed", origin: "box", message: "failed" } }) as const };

    await expect(enrollBox({ home, box: "fsn-example", link: failing, ferryVersion: "0.12.0" })).rejects.toThrow(
      /^Ferry could not write the credential on box fsn-example\. It revoked the new device dev_/,
    );
    const created = [...relay.devices.values()].find((device) => device.name === "fsn-example");
    expect(created?.revoked).toBe(true);
  });

  test("needs an enrolled operator machine", async () => {
    await expect(enrollBox({ home: makeHome(), box: "fsn-example", link: shLink(makeHome()), ferryVersion: "0.12.0" })).rejects.toThrow("This machine is not enrolled.");
  });
});

describe("the credential files", () => {
  test("refuse a value that is not a device credential, and the error has no part of the file", () => {
    const home = makeHome();
    expect(() => writeCredential(home, "not-a-credential")).toThrow("not a device credential");
    writeCredential(home, newDeviceCredential());
    writeFileSync(join(messagingDir(home), "credential"), "fmr_example-secret\n");
    expect(() => readCredential(home)).toThrow("~/.ferry/messaging/credential is not a device credential.");
    try {
      readCredential(home);
    } catch (error) {
      expect((error as Error).message).not.toContain("example-secret");
    }
  });
});
