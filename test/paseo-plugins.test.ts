import { afterEach, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";
import { carryPaseoPlugins, readPaseoPlugins, type PaseoPlugin } from "../src/integrations/paseo-plugins.ts";
import type { IntegrationLink } from "../src/integrations/types.ts";
import { runWatch } from "../src/watch.ts";
import { runSync, type SyncDependencies } from "../src/sync.ts";

const homes: string[] = [];
afterEach(() => { for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true }); });
const remote = "https://github.com/example/plugins.git";
const revision = "a".repeat(40);
const plugin: PaseoPlugin = { id: "review", remote, path: "plugins/review", commit: revision, enabled: true };
function fixture() {
  const home = mkdtempSync(join(tmpdir(), "ferry-plugins-"));
  homes.push(home);
  const checkout = join(home, ".paseo/plugins/review/12345678-1234-1234-1234-123456789abc/checkout");
  mkdirSync(join(checkout, "plugins/review"), { recursive: true });
  const git = (...args: string[]) => execFileSync("git", ["-C", checkout, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  git("init");
  writeFileSync(join(checkout, "plugins/review/paseo-plugin.json"), '{"id":"review"}');
  git("add", ".");
  git("-c", "user.name=Test", "-c", "user.email=operator@example.com", "commit", "-m", "test: add plugin");
  const configure = (enabled = true) => writeFileSync(join(home, ".paseo/config.json"), JSON.stringify({
    plugins: { review: { source: "directory", path: join(checkout, "plugins/review"), enabled } },
  }));
  const record = (value: unknown) => writeFileSync(join(home, ".paseo/plugins/sources.json"), JSON.stringify({ review: value }));
  configure(); record({ kind: "git", remote });
  return { home, checkout, configure, record, commit: git("rev-parse", "HEAD") };
}
function box(installed: unknown = []) {
  const commands: string[] = [];
  const link: IntegrationLink = { run: async (command, options) => {
    commands.push(command);
    expect(options?.agentForwarding).toBeUndefined();
    return { ok: true, address: "box", stdout: command === "paseo plugin ls --json" ? JSON.stringify(installed) : "{}", stderr: "" };
  } };
  return { commands, link };
}
function installed(overrides: Record<string, unknown> = {}) {
  return { id: plugin.id, enabled: true, installation: {
    identity: { kind: "git", remote, pluginPath: plugin.path }, currentRevision: revision,
  }, ...overrides };
}
const carry = (link: IntegrationLink, value = plugin) => carryPaseoPlugins(link, { plugins: [value], warnings: [] });

describe("Paseo Git plugin discovery", () => {
  test("reads the installed commit and subdirectory, including legacy Git records", () => {
    const f = fixture();
    f.record({ remote, revision: "stale" });
    expect(readPaseoPlugins(f.home)).toEqual({ plugins: [{ ...plugin, commit: f.commit }], warnings: [] });
    f.configure(false);
    expect(readPaseoPlugins(f.home).plugins[0]?.enabled).toBe(false);
  });
  test("skips npm, local directories, and dirty checkouts", () => {
    const f = fixture();
    f.record({ kind: "npm" });
    expect(readPaseoPlugins(f.home).warnings[0]).toContain("only managed Git");
    writeFileSync(join(f.home, ".paseo/plugins/sources.json"), "{}");
    expect(readPaseoPlugins(f.home).plugins).toEqual([]);
    f.record({ kind: "git", remote });
    writeFileSync(join(f.checkout, "local.txt"), "local change");
    expect(readPaseoPlugins(f.home).warnings[0]).toContain("local changes");
  });
  test("refuses credential-bearing and local remotes without exposing values", () => {
    const f = fixture();
    for (const unsafe of ["https://user:secret@example.com/repo", "https://example.com/repo?token=secret", "file:///private/plugin", "/private/plugin"]) {
      f.record({ kind: "git", remote: unsafe });
      try { readPaseoPlugins(f.home); throw new Error("accepted unsafe remote"); }
      catch (error) {
        expect(String(error)).toContain("nonportable or credential-bearing");
        expect(String(error)).not.toContain(unsafe);
      }
    }
  });
  test("fails closed on malformed metadata and paths outside the managed checkout", () => {
    const f = fixture();
    writeFileSync(join(f.home, ".paseo/plugins/sources.json"), "invalid");
    expect(() => readPaseoPlugins(f.home)).toThrow("not a JSON object");
    f.record({ kind: "git", remote });
    writeFileSync(join(f.home, ".paseo/config.json"), JSON.stringify({ plugins: { review: { source: "directory", path: "/tmp/other" } } }));
    expect(() => readPaseoPlugins(f.home)).toThrow("outside its managed Git checkout");
  });
});

describe("Paseo Git plugin reconciliation", () => {
  test("installs the exact commit and subdirectory without changing global settings", async () => {
    const b = box(); await carry(b.link);
    expect(b.commands).toEqual(["paseo plugin ls --json", `paseo plugin install 'git:${remote}:plugins/review' --id 'review' --ref '${revision}' --json`]);
  });
  test("does nothing to current or box-only plugins", async () => {
    const b = box([installed(), { id: "box-only", enabled: true }]);
    expect(await carry(b.link)).toEqual([]);
    expect(b.commands).toEqual(["paseo plugin ls --json"]);
  });
  test("disables before updating and enables only after updating", async () => {
    const older = installed(); older.installation.currentRevision = "b".repeat(40);
    const b = box([older]); await carry(b.link, { ...plugin, enabled: false });
    expect(b.commands.slice(1)).toEqual(["paseo plugin disable 'review' --json", `paseo plugin update 'review' --ref '${revision}' --json`]);
    const disabled = box([{ ...older, enabled: false }]); await carry(disabled.link);
    expect(disabled.commands.slice(1)).toEqual([`paseo plugin update 'review' --ref '${revision}' --json`, "paseo plugin enable 'review' --json"]);
  });
  test("does not execute absent disabled plugins or replace conflicting sources", async () => {
    const b = box(); expect((await carry(b.link, { ...plugin, enabled: false }))[0]).toContain("disabled locally");
    expect(b.commands).toHaveLength(1);
    const conflict = box([installed({ installation: { identity: { kind: "directory" } } })]);
    expect((await carry(conflict.link))[0]).toContain("different source");
    expect(conflict.commands).toHaveLength(1);
  });
  test("matches the SSH remote identity that Paseo redacts", async () => {
    const b = box([installed({ installation: { identity: { kind: "git", remote: "ssh://example.com/repo.git", pluginPath: plugin.path }, currentRevision: revision } })]);
    expect(await carry(b.link, { ...plugin, remote: "ssh://git@example.com/repo.git" })).toEqual([]);
    expect(b.commands).toHaveLength(1);
  });
  test("rejects invalid list output and suppresses command errors that can contain credentials", async () => {
    await expect(carry(box({}).link)).rejects.toThrow("did not return a plugin list");
    const b = box();
    const link: IntegrationLink = { run: async (command, options) => command.includes(" install ")
      ? { ok: false, error: { origin: "box", code: "command-failed", message: "secret" } }
      : b.link.run(command, options) };
    await expect(carry(link)).rejects.toThrow("Check paseo plugin ls");
  });
});

test("dry runs include plugins only for enabled boxes and make no connections", async () => {
  const f = fixture();
  const deps: SyncDependencies = {
    publisher: () => "operator", readConfig: () => ({ version: 1, publisher: "operator", snapshotUrl: "snapshot.git",
      integrations: { paseo: true }, boxes: [
        { name: "on", host: { tailscale: "on", sshUser: "user" } },
        { name: "off", host: { tailscale: "off", sshUser: "user" }, integrations: { paseo: false } },
      ] }),
    createLink: () => { throw new Error("must stay offline"); }, writeLine: () => {},
  };
  const result = await runSync({ home: f.home, dryRun: true }, deps);
  expect(result.boxes[0]?.plan.paseoPlugins?.plugins[0]?.commit).toBe(f.commit);
  expect(result.boxes[1]?.plan.paseoPlugins).toBeNull();
});

test("watch detects plugin-only changes with its real observer", async () => {
  const f = fixture();
  mkdirSync(join(f.home, ".ferry"));
  writeFileSync(join(f.home, ".ferry/config.toml"), `version = 1\npublisher = ${JSON.stringify(hostname())}\nsnapshot_url = "snapshot.git"\n[host]\ntailscale = "box"\nssh_user = "user"\n[integrations]\npaseo = true\n`);
  const controller = new AbortController();
  let polls = 0, syncs = 0;
  await runWatch({ home: f.home, signal: controller.signal, pollMs: 1, debounceMs: 1 }, {
    sleep: async () => { if (++polls === 1) f.configure(false); if (polls > 5) controller.abort(); },
    sync: async () => { syncs++; controller.abort(); }, writeLine: () => {},
    readState: () => null, writeState: () => {},
  });
  expect(syncs).toBe(1);
});

test("sync carries plugins before the unit check and reports failures without blocking core sync", async () => {
  const f = fixture();
  for (const fail of [false, true]) {
    const commands: string[] = [];
    const warnings: string[] = [];
    const result = await runSync({ home: f.home, publish: false }, {
      publisher: () => "operator",
      readConfig: () => ({ version: 1, publisher: "operator", snapshotUrl: "snapshot.git",
        host: { tailscale: "box", sshUser: "user" }, integrations: { paseo: true } }),
      createLink: () => ({ run: async (command) => {
        commands.push(command);
        if (fail && command.includes("paseo plugin install")) throw new Error("install failed");
        return { ok: true, address: "box", stdout: command.startsWith("printf") ? "/home/user\n"
          : command === "paseo plugin ls --json" ? "[]" : "", stderr: "" };
      } }),
      apply: async (input) => ({ checkout: input.checkout, targetHome: input.targetHome, actions: [], unmanaged: [] }),
      acquireLock: () => () => {}, adopt: () => {}, writePlan: () => {}, writeLine: () => {},
      warn: (line) => warnings.push(line),
    });
    expect(result.boxes[0]?.failure).toBeUndefined();
    expect(commands.some((command) => command.includes(`--ref '${f.commit}'`))).toBe(true);
    const install = commands.findIndex((command) => command.includes("paseo plugin install"));
    const unit = commands.findIndex((command) => command.includes("if [ -e '.config/systemd"));
    expect(install).toBeLessThan(unit);
    expect(warnings.some((line) => line.includes("could not carry the Paseo plugins"))).toBe(fail);
  }
});
