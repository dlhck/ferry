import { afterEach, describe, expect, test } from "bun:test";
import { generateKeyPairSync } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readRelayConfig, relayDir, writeRelayConfig } from "../../../src/messaging/github/app.ts";
import {
  boxRelayHost,
  changeAllowedOwners,
  importGitHubApp,
  localRelayHost,
  setupGitHubApp,
} from "../../../src/messaging/github/manifest.ts";
import { startFakeGitHub, type FakeGitHub } from "../fakes/github.ts";

const homes: string[] = [];
const fakes: FakeGitHub[] = [];
afterEach(async () => {
  for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true });
  for (const fake of fakes.splice(0)) await fake.stop();
});
const makeHome = () => {
  const home = mkdtempSync(join(tmpdir(), "ferry-relay-setup-"));
  homes.push(home);
  return home;
};
const fake = async () => {
  const github = await startFakeGitHub();
  fakes.push(github);
  return github;
};

/** Plays the browser and GitHub: reads the start page, then follows the manifest redirect with a conversion code. */
function browser(github: FakeGitHub, owner: string, seen: { action?: string; manifest?: Record<string, unknown> }) {
  return (url: string) => {
    if (!url.endsWith("/start")) return;
    void (async () => {
      const page = await (await fetch(url)).text();
      const action = /action="([^"]+)"/.exec(page)![1]!.replaceAll("&amp;", "&");
      const manifest = JSON.parse(/value="([^"]+)"/.exec(page)![1]!.replaceAll("&quot;", '"').replaceAll("&amp;", "&")) as Record<string, unknown>;
      seen.action = action;
      seen.manifest = manifest;
      const state = new URL(action).searchParams.get("state");
      await fetch(`${manifest.redirect_url as string}?code=${github.manifestCode(owner)}&state=${state}`);
    })();
  };
}

describe("ferry relay setup github-app", () => {
  test("creates the App with the manifest, waits for the device flow, and writes the relay files", async () => {
    const github = await fake();
    const home = makeHome();
    const lines: string[] = [];
    const seen: { action?: string; manifest?: Record<string, unknown> } = {};
    github.setDeviceFlow(false);
    let checks = 0;

    const result = await setupGitHubApp({
      org: "Acme",
      relayHost: localRelayHost(home),
      print: (line) => lines.push(line),
      openUrl: browser(github, "Acme", seen),
      endpoints: { api: github.apiUrl, web: github.webUrl },
      sleep: async () => {
        checks++;
        if (checks === 2) github.setDeviceFlow(true);
      },
    });

    expect(new URL(seen.action!).pathname).toBe("/organizations/Acme/settings/apps/new");
    expect(seen.manifest).toEqual({
      name: "Acme Ferry relay",
      url: "https://github.com/dlhck/ferry",
      hook_attributes: { url: "https://example.invalid/ferry-relay", active: false },
      redirect_url: expect.stringMatching(/^http:\/\/127\.0\.0\.1:\d+\/created$/),
      public: false,
      default_permissions: { metadata: "read" },
      default_events: [],
    });
    expect(checks).toBe(2);
    expect(result).toEqual({
      appId: github.app.appId,
      slug: github.app.slug,
      clientId: github.app.clientId,
      installUrl: `${github.webUrl}/apps/${github.app.slug}/installations/new`,
      allowedOwners: ["acme"],
    });
    expect(readRelayConfig(home)).toEqual({
      schemaVersion: 1,
      github: { appId: github.app.appId, slug: github.app.slug, clientId: github.app.clientId },
      allowedOwners: ["acme"],
    });
    expect(readFileSync(join(relayDir(home), "github-app.pem"), "utf8")).toBe(github.app.privateKeyPem);
    expect(statSync(join(relayDir(home), "github-app.pem")).mode & 0o777).toBe(0o600);
    const stored = readFileSync(join(relayDir(home), "config.json"), "utf8");
    expect(stored).not.toContain("fake-client-secret");
    expect(stored).not.toContain("fake-webhook-secret");
    expect(lines.join("\n")).not.toContain("PRIVATE KEY");
    expect(lines).toContain('GitHub created the App example-ferry-relay. Turn on "Enable Device Flow" in its settings: ' + `${github.webUrl}/organizations/Acme/settings/apps/example-ferry-relay`);
  });

  test("without --org, posts to the personal account and allows the account that owns the App", async () => {
    const github = await fake();
    const home = makeHome();
    const seen: { action?: string; manifest?: Record<string, unknown> } = {};

    const result = await setupGitHubApp({
      public: true,
      relayHost: localRelayHost(home),
      print: () => {},
      openUrl: browser(github, "Alice", seen),
      endpoints: { api: github.apiUrl, web: github.webUrl },
      sleep: async () => {},
    });

    expect(new URL(seen.action!).pathname).toBe("/settings/apps/new");
    expect(seen.manifest).toMatchObject({ name: "Ferry relay", public: true });
    expect(result.allowedOwners).toEqual(["alice"]);
  });

  test("refuses a redirect with another state, and stops when the App is not created in time", async () => {
    const github = await fake();
    let refused = 0;
    const setup = setupGitHubApp({
      org: "acme",
      relayHost: localRelayHost(makeHome()),
      print: () => {},
      openUrl: (url) => {
        if (!url.endsWith("/start")) return;
        void fetch(url.replace("/start", "/created?code=x&state=other")).then((response) => {
          if (response.status === 400) refused++;
        });
      },
      endpoints: { api: github.apiUrl, web: github.webUrl },
      createTimeoutMs: 200,
    });

    await expect(setup).rejects.toThrow("The GitHub App was not created in time.");
    expect(refused).toBe(1);
  });
});

describe("ferry relay import-github-app", () => {
  test("checks the key with GET /app, keeps the allowed owners, and adds the App owner", async () => {
    const github = await fake();
    const home = makeHome();
    const keyFile = join(home, "downloaded.pem");
    writeFileSync(keyFile, github.app.privateKeyPem);
    writeRelayConfig(home, { schemaVersion: 1, github: { appId: 1, slug: "old", clientId: "old" }, allowedOwners: ["acme"] });
    const lines: string[] = [];

    const result = await importGitHubApp({
      appId: github.app.appId,
      clientId: github.app.clientId,
      slug: github.app.slug,
      keyFile,
      relayHost: localRelayHost(home),
      print: (line) => lines.push(line),
      endpoints: { api: github.apiUrl, web: github.webUrl },
    });

    expect(result.allowedOwners).toEqual(["acme", "example-org"]);
    expect(readRelayConfig(home)?.github).toEqual({ appId: github.app.appId, slug: github.app.slug, clientId: github.app.clientId });
    expect(lines.at(-1)).toBe(`Delete the downloaded key file ${keyFile}. The relay has its own copy.`);
  });

  test("refuses a key of another App, and wrong App details", async () => {
    const github = await fake();
    const home = makeHome();
    const other = join(home, "other.pem");
    writeFileSync(other, generateKeyPairSync("rsa", { modulusLength: 2048 }).privateKey.export({ type: "pkcs8", format: "pem" }).toString());
    const right = join(home, "right.pem");
    writeFileSync(right, github.app.privateKeyPem);
    const input = { appId: github.app.appId, clientId: github.app.clientId, slug: github.app.slug, relayHost: localRelayHost(home), print: () => {}, endpoints: { api: github.apiUrl, web: github.webUrl } };

    await expect(importGitHubApp({ ...input, keyFile: other })).rejects.toThrow(`GitHub refused the key for App ${github.app.appId}.`);
    await expect(importGitHubApp({ ...input, keyFile: right, slug: "another-app" })).rejects.toThrow("The key belongs to the App example-ferry-relay");
    expect(readRelayConfig(home)).toBeNull();
  });
});

describe("the relay files on a box", () => {
  /** A link that runs the command with sh in a home of the test, as SSH would on the box. */
  const shLink = (home: string) => ({
    run: async (command: string, options: { input?: Uint8Array } = {}) => {
      const result = Bun.spawnSync(["sh", "-c", command], { env: { HOME: home, PATH: process.env.PATH ?? "" }, stdin: options.input ? Buffer.from(options.input) : "ignore" });
      return result.exitCode === 0
        ? ({ ok: true, address: "box.example", stdout: result.stdout.toString(), stderr: "" } as const)
        : ({ ok: false, error: { code: "command-failed", origin: "box", message: "failed" } } as const);
    },
  });

  test("go over standard input with mode 0600, and read back", async () => {
    const github = await fake();
    const home = makeHome();
    const host = boxRelayHost(shLink(home), "fsn-example");
    const config = { schemaVersion: 1, github: { appId: 7, slug: "example-ferry-relay", clientId: "Iv23liExample" }, allowedOwners: ["acme"] } as const;

    expect(await host.readConfig()).toBeNull();
    await host.write(config, github.app.privateKeyPem);

    expect(await host.readConfig()).toEqual(config);
    expect(readFileSync(join(relayDir(home), "github-app.pem"), "utf8")).toBe(github.app.privateKeyPem);
    expect(statSync(join(relayDir(home), "github-app.pem")).mode & 0o777).toBe(0o600);
    expect(statSync(join(relayDir(home), "config.json")).mode & 0o777).toBe(0o600);
    expect(statSync(relayDir(home)).mode & 0o777).toBe(0o700);
  });

  test("a failed write reports no output", async () => {
    const github = await fake();
    const link = { run: async () => ({ ok: false, error: { code: "command-failed", origin: "box", message: "x", output: { stdout: "", stderr: "secret" } } }) as const };

    await expect(boxRelayHost(link, "fsn-example").write({ schemaVersion: 1, github: { appId: 7, slug: "a", clientId: "b" }, allowedOwners: [] }, github.app.privateKeyPem)).rejects.toThrow(
      "Ferry could not write the relay files on box fsn-example. No key was reported.",
    );
  });
});

describe("ferry relay owners", () => {
  test("adds and removes an owner in lower case", () => {
    const home = makeHome();
    writeRelayConfig(home, { schemaVersion: 1, github: { appId: 7, slug: "a", clientId: "b" }, allowedOwners: ["acme"] });

    expect(changeAllowedOwners(home, "add", "Example-Org").allowedOwners).toEqual(["acme", "example-org"]);
    expect(changeAllowedOwners(home, "add", "acme").allowedOwners).toEqual(["example-org", "acme"]);
    expect(changeAllowedOwners(home, "remove", "ACME").allowedOwners).toEqual(["example-org"]);
    expect(() => changeAllowedOwners(home, "add", "bad/name")).toThrow("is not a GitHub account name");
  });
});
