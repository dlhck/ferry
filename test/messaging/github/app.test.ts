import { afterEach, describe, expect, test } from "bun:test";
import { generateKeyPairSync, verify } from "node:crypto";
import { mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  appJwt,
  GitHubUnavailableError,
  githubRequest,
  InstallationGoneError,
  InstallationTokens,
  readAppCredentials,
  readRelayConfig,
  relayDir,
  writeAppKey,
  writeRelayConfig,
} from "../../../src/messaging/github/app.ts";
import { startFakeGitHub, type FakeGitHub } from "../fakes/github.ts";

const START = Date.parse("2026-01-05T09:00:00.000Z");
const clockAt = (start = START) => {
  let now = start;
  return { now: () => now, advance: (ms: number) => void (now += ms) };
};

const homes: string[] = [];
const fakes: FakeGitHub[] = [];
afterEach(async () => {
  for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true });
  for (const fake of fakes.splice(0)) await fake.stop();
});
const makeHome = () => {
  const home = mkdtempSync(join(tmpdir(), "ferry-relay-app-"));
  homes.push(home);
  return home;
};
const fake = async (clock?: { now(): number }) => {
  const github = await startFakeGitHub({ clock });
  fakes.push(github);
  return github;
};

describe("the App JWT", () => {
  test("is RS256 with the App id as issuer, issued 60 seconds back, and valid for 9 minutes", () => {
    const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
    const jwt = appJwt(123, privateKey, START);
    const [header = "", payload = "", signature = ""] = jwt.split(".");

    expect(JSON.parse(Buffer.from(header, "base64url").toString())).toEqual({ alg: "RS256", typ: "JWT" });
    expect(JSON.parse(Buffer.from(payload, "base64url").toString())).toEqual({
      iat: START / 1000 - 60,
      exp: START / 1000 + 540,
      iss: "123",
    });
    expect(verify("sha256", Buffer.from(`${header}.${payload}`), publicKey, Buffer.from(signature, "base64url"))).toBe(true);
  });
});

describe("installation tokens", () => {
  test("are minted once, kept in memory, and renewed 5 minutes before they expire", async () => {
    const clock = clockAt();
    const github = await fake(clock);
    const installation = github.install("acme");
    const tokens = new InstallationTokens({ appId: github.app.appId, privateKey: github.app.privateKeyPem, api: github.apiUrl, clock, fetch });
    const mints = () => github.requests().filter((request) => request.path.endsWith("/access_tokens")).length;

    const first = await tokens.token(installation);
    expect(await tokens.token(installation)).toBe(first);
    clock.advance(54 * 60_000);
    expect(await tokens.token(installation)).toBe(first);
    expect(mints()).toBe(1);

    clock.advance(60_000);
    const renewed = await tokens.token(installation);
    expect(renewed).not.toBe(first);
    expect(mints()).toBe(2);
  });

  test("two requests at the same time share one mint", async () => {
    const github = await fake();
    const installation = github.install("acme");
    const tokens = new InstallationTokens({ appId: github.app.appId, privateKey: github.app.privateKeyPem, api: github.apiUrl, clock: clockAt(Date.now()), fetch });

    const [one, two] = await Promise.all([tokens.token(installation), tokens.token(installation)]);

    expect(one).toBe(two);
    expect(github.requests().filter((request) => request.path.endsWith("/access_tokens"))).toHaveLength(1);
  });

  test("the fake refuses a JWT signed with another key", async () => {
    const github = await fake();
    const installation = github.install("acme");
    const other = generateKeyPairSync("rsa", { modulusLength: 2048 }).privateKey.export({ type: "pkcs8", format: "pem" }).toString();
    const tokens = new InstallationTokens({ appId: github.app.appId, privateKey: other, api: github.apiUrl, clock: clockAt(Date.now()), fetch });

    await expect(tokens.token(installation)).rejects.toThrow("answered 401");
  });

  test("an unknown installation is InstallationGoneError", async () => {
    const github = await fake();
    const tokens = new InstallationTokens({ appId: github.app.appId, privateKey: github.app.privateKeyPem, api: github.apiUrl, clock: clockAt(Date.now()), fetch });

    await expect(tokens.token(9999)).rejects.toBeInstanceOf(InstallationGoneError);
  });
});

describe("a GitHub request", () => {
  test.each([
    ["server-error", "answered 503"],
    ["rate-limit", "answered 403 (rate limit)"],
    ["drop", "got no answer"],
  ] as const)("with the fault %s is GitHubUnavailableError", async (fault, detail) => {
    const github = await fake();
    github.setFault(fault);

    const error = await githubRequest(fetch, `${github.apiUrl}/app`, { bearer: "example-jwt" }).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(GitHubUnavailableError);
    expect((error as Error).message).toBe(`GitHub is unavailable: GET /app ${detail}`);
  });

  test("a refused connection is GitHubUnavailableError", async () => {
    const github = await fake();
    await github.stop();
    fakes.splice(0);

    await expect(githubRequest(fetch, `${github.apiUrl}/app`)).rejects.toBeInstanceOf(GitHubUnavailableError);
  });
});

describe("the relay files", () => {
  test("hold the config and the key with mode 0600 in a directory with mode 0700", async () => {
    const github = await fake();
    const home = makeHome();
    const config = { schemaVersion: 1, github: { appId: 123, slug: "example-ferry-relay", clientId: "Iv23liExample" }, allowedOwners: ["acme"] } as const;

    writeRelayConfig(home, config);
    writeAppKey(home, github.app.privateKeyPem);

    expect(readRelayConfig(home)).toEqual(config);
    expect(readAppCredentials(home)).toEqual({ ...config.github, privateKeyPem: github.app.privateKeyPem });
    expect(statSync(relayDir(home)).mode & 0o777).toBe(0o700);
    expect(statSync(join(relayDir(home), "config.json")).mode & 0o777).toBe(0o600);
    expect(statSync(join(relayDir(home), "github-app.pem")).mode & 0o777).toBe(0o600);
  });

  test("a home without a relay has no config", () => {
    expect(readRelayConfig(makeHome())).toBeNull();
  });

  test("an invalid config or key is an error that has no part of the file", () => {
    const home = makeHome();
    writeRelayConfig(home, { schemaVersion: 1, github: { appId: 1, slug: "a", clientId: "b" }, allowedOwners: [] });
    writeFileSync(join(relayDir(home), "config.json"), '{"schemaVersion":1,"github":{"appId":"x"},"allowedOwners":[]}');
    expect(() => readRelayConfig(home)).toThrow("is not a valid relay config");

    expect(() => writeAppKey(home, "-----BEGIN PRIVATE KEY-----\nexample-secret\n-----END PRIVATE KEY-----\n")).toThrow(
      "The GitHub App key is not a PEM private key.",
    );
    const ec = generateKeyPairSync("ec", { namedCurve: "P-256" }).privateKey.export({ type: "pkcs8", format: "pem" }).toString();
    expect(() => writeAppKey(home, ec)).toThrow("not an RSA private key");
  });
});
