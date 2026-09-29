import { afterEach, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
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
const plugin: PaseoPlugin = { kind: "git", id: "review", remote, path: "plugins/review", commit: revision, enabled: true };
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
const readConfig = "if [ -e '.paseo/config.json' ]; then printf 'F' && cat '.paseo/config.json'; else printf 'M'; fi";
function box(installed: unknown = [], config: unknown = { pluginsEnabled: true }) {
  const commands: string[] = [];
  const link: IntegrationLink = { run: async (command, options) => {
    commands.push(command);
    expect(options?.agentForwarding).toBeUndefined();
    const stdout = command === "paseo plugin ls --json" ? JSON.stringify(installed)
      : command === readConfig ? (config === null ? "M" : `F${typeof config === "string" ? config : JSON.stringify(config)}`) : "{}";
    return { ok: true, address: "box", stdout, stderr: "" };
  } };
  return { commands, link };
}
/** The config text in the write command, parsed. */
function written(commands: readonly string[]): unknown {
  const write = commands.find((command) => command.includes("config.json.ferry-tmp"));
  const text = write?.match(/^umask 077 && mkdir -p '\.paseo' && printf '%s' '(.*)' > /s)?.[1];
  return text === undefined ? undefined : JSON.parse(text.replaceAll("'\\''", "'"));
}
function installed(overrides: Record<string, unknown> = {}) {
  return { id: plugin.id, enabled: true, installation: {
    identity: { kind: "git", remote, pluginPath: plugin.path }, currentRevision: revision,
  }, ...overrides };
}
const carry = (link: IntegrationLink, value: PaseoPlugin = plugin) => carryPaseoPlugins(link, { plugins: [value], warnings: [] });

describe("Paseo Git plugin discovery", () => {
  test("reads the installed commit and subdirectory, including legacy Git records", () => {
    const f = fixture();
    f.record({ remote, revision: "stale" });
    expect(readPaseoPlugins(f.home)).toEqual({ plugins: [{ ...plugin, commit: f.commit }], warnings: [] });
    f.configure(false);
    expect(readPaseoPlugins(f.home).plugins[0]?.enabled).toBe(false);
  });
  test("skips unknown source kinds, local directories, and dirty checkouts", () => {
    const f = fixture();
    f.record({ kind: "tarball", url: "https://user:secret@example.com/plugin.tgz" });
    expect(readPaseoPlugins(f.home).warnings).toEqual(["Paseo plugin review was skipped: only managed Git and npm plugins can sync."]);
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
  test("installs the exact commit and subdirectory, then enables the missing global switch", async () => {
    const config = { daemon: { listen: "127.0.0.1:6767" }, plugins: { "box-only": { source: "directory", path: "/p" } } };
    const b = box([], config); await carry(b.link);
    expect(b.commands.slice(0, 3)).toEqual(["paseo plugin ls --json", `paseo plugin install 'git:${remote}:plugins/review' --id 'review' --ref '${revision}' --json`, readConfig]);
    expect(written(b.commands)).toEqual({ ...config, pluginsEnabled: true });
    expect(b.commands.at(-1)).toBe("paseo daemon reload");
  });
  test("enables a false global switch for a current plugin", async () => {
    const b = box([installed()], { pluginsEnabled: false });
    expect(await carry(b.link)).toEqual([]);
    expect(written(b.commands)).toEqual({ pluginsEnabled: true });
    expect(b.commands.at(-1)).toBe("paseo daemon reload");
  });
  test("does nothing to current or box-only plugins or an enabled global switch", async () => {
    const b = box([installed(), { id: "box-only", enabled: true }]);
    expect(await carry(b.link)).toEqual([]);
    expect(b.commands).toEqual(["paseo plugin ls --json", readConfig]);
  });
  test("disables mapped plugins before it enables the global switch", async () => {
    const other = { ...plugin, id: "other" };
    const c = box([installed(), installed({ id: "other" })], { pluginsEnabled: false });
    await carryPaseoPlugins(c.link, { plugins: [other, { ...plugin, enabled: false }], warnings: [] });
    expect(c.commands.indexOf("paseo plugin disable 'review' --json")).toBeLessThan(c.commands.indexOf(readConfig));
    expect(written(c.commands)).toEqual({ pluginsEnabled: true });
  });
  test("does not enable the global switch without an enabled reconciled plugin", async () => {
    for (const [installedPlugins, value] of [
      [[], { ...plugin, enabled: false }],
      [[installed()], { ...plugin, enabled: false }],
      [[installed({ installation: { identity: { kind: "directory" } } })], plugin],
    ] as const) {
      const b = box(installedPlugins, { pluginsEnabled: false });
      await carry(b.link, value);
      expect(b.commands).not.toContain(readConfig);
    }
    const none = box([], { pluginsEnabled: false });
    expect(await carryPaseoPlugins(none.link, { plugins: [], warnings: ["skipped"] })).toEqual(["skipped"]);
    expect(none.commands).toEqual([]);
  });
  test("creates a missing box config and refuses an invalid one without exposing it", async () => {
    const b = box([installed()], null); await carry(b.link);
    expect(written(b.commands)).toEqual({ pluginsEnabled: true });
    await expect(carry(box([installed()], "secret-token").link)).rejects.toThrow("is not a JSON object");
    await expect(carry(box([installed()], "secret-token").link)).rejects.not.toThrow("secret");
  });
  test("disables before updating and enables only after updating", async () => {
    const older = installed(); older.installation.currentRevision = "b".repeat(40);
    const b = box([older]); await carry(b.link, { ...plugin, enabled: false });
    expect(b.commands.slice(1)).toEqual(["paseo plugin disable 'review' --json", `paseo plugin update 'review' --ref '${revision}' --json`]);
    const disabled = box([{ ...older, enabled: false }]); await carry(disabled.link);
    expect(disabled.commands.slice(1)).toEqual([`paseo plugin update 'review' --ref '${revision}' --json`, "paseo plugin enable 'review' --json", readConfig]);
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
    expect(b.commands).toEqual(["paseo plugin ls --json", readConfig]);
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
  expect(result.boxes[0]?.plan.paseoPlugins?.plugins[0]).toMatchObject({ commit: f.commit });
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

const uuid = "12345678-1234-1234-1234-123456789abc";
const tools: Extract<PaseoPlugin, { kind: "npm" }> = { kind: "npm", id: "tools", packageName: "@acme/tools", path: ".", version: "1.2.3", enabled: true };
/** An npm installation in Paseo 0.10.1's layout: <id>/<uuid>/node_modules/<package>, with the version in package-lock.json. */
function npmFixture(packageName = tools.packageName, path = ".") {
  const home = mkdtempSync(join(tmpdir(), "ferry-npm-plugins-"));
  homes.push(home);
  const versionRoot = join(home, ".paseo/plugins/tools", uuid);
  const packageRoot = join(versionRoot, "node_modules", packageName);
  mkdirSync(join(packageRoot, path), { recursive: true });
  const install = (version: string, installedVersion = version) => {
    writeFileSync(join(versionRoot, "package.json"), JSON.stringify({ name: "paseo-plugin-installation", dependencies: { [packageName]: version } }));
    writeFileSync(join(versionRoot, "package-lock.json"), JSON.stringify({ lockfileVersion: 3, packages: {
      "": { dependencies: { [packageName]: version } },
      [`node_modules/${packageName}`]: { version, resolved: `https://registry.example.com/${packageName}/-/tools-${version}.tgz?token=secret`, integrity: "sha512-example" },
    } }));
    writeFileSync(join(packageRoot, "package.json"), JSON.stringify({ name: packageName, version: installedVersion }));
  };
  const configure = (enabled = true, configured = join(packageRoot, path)) => writeFileSync(join(home, ".paseo/config.json"), JSON.stringify({
    plugins: { tools: { source: "directory", path: configured, enabled } },
  }));
  install("1.2.3"); configure();
  writeFileSync(join(home, ".paseo/plugins/sources.json"), JSON.stringify({ tools: { kind: "npm" } }));
  return { home, versionRoot, packageRoot, install, configure };
}
function installedNpm(overrides: Record<string, unknown> = {}) {
  return { id: tools.id, enabled: true, installation: {
    identity: { kind: "npm", packageName: tools.packageName, pluginPath: "." }, currentRevision: tools.version,
  }, ...overrides };
}
function expectRefused(home: string, message: string, secret: string) {
  try { readPaseoPlugins(home); throw new Error("accepted an unsafe npm installation"); }
  catch (error) {
    expect(String(error)).toContain(message);
    expect(String(error)).not.toContain(secret);
  }
}

describe("Paseo npm plugin discovery", () => {
  test("reads the exact installed version of scoped and unscoped packages, with subdirectories", () => {
    const f = npmFixture();
    expect(readPaseoPlugins(f.home)).toEqual({ plugins: [tools], warnings: [] });
    f.configure(false);
    expect(readPaseoPlugins(f.home).plugins[0]?.enabled).toBe(false);
    const nested = npmFixture("review-kit", "plugins/review");
    expect(readPaseoPlugins(nested.home).plugins).toEqual([{ ...tools, packageName: "review-kit", path: "plugins/review" }]);
  });
  test("carries the lockfile version, never the requested range or the resolved URL", () => {
    const f = npmFixture();
    writeFileSync(join(f.versionRoot, "package.json"), JSON.stringify({ dependencies: { "@acme/tools": "^1.0.0" } }));
    const plan = JSON.stringify(readPaseoPlugins(f.home));
    expect(plan).toContain('"version":"1.2.3"');
    expect(plan).not.toContain("^1.0.0");
    expect(plan).not.toContain("registry.example.com");
    expect(plan).not.toContain("secret");
  });
  test("refuses missing or mismatched acquisition artifacts without exposing values", () => {
    const f = npmFixture();
    f.install("1.2.3", "9.9.9-secret");
    expectRefused(f.home, "could not read the managed npm installation", "9.9.9-secret");
    rmSync(join(f.versionRoot, "package-lock.json"));
    expectRefused(f.home, "could not read the managed npm installation", "secret");
  });
  test("refuses moving versions and credential-bearing package identities without exposing values", () => {
    const f = npmFixture();
    f.install("latest-secret");
    expectRefused(f.home, "nonportable or credential-bearing npm package", "latest-secret");
    for (const invalid of ["1.2.3-01", "1.2.3-alpha.01"]) {
      f.install(invalid);
      expectRefused(f.home, "nonportable or credential-bearing npm package", invalid);
    }
    f.install("1.2.3-0.alpha-01+001");
    expect(readPaseoPlugins(f.home).plugins[0]).toMatchObject({ version: "1.2.3-0.alpha-01+001" });
    const token = `sk-ant-${"a1".repeat(12)}`;
    const leaked = npmFixture(`@acme/${token}`);
    expectRefused(leaked.home, "nonportable or credential-bearing npm package", token);
  });
  test("refuses paths outside the managed npm installation and invalid package names", () => {
    const f = npmFixture();
    f.configure(true, join(f.versionRoot, "other"));
    expectRefused(f.home, "outside its managed npm installation", f.versionRoot);
    f.configure(true, "/tmp/other");
    expectRefused(f.home, "outside its managed npm installation", "/tmp/other");
    for (const escaped of ["@acme/tools", "@acme"]) {
      const linked = npmFixture();
      const external = mkdtempSync(join(tmpdir(), "ferry-external-"));
      homes.push(external);
      const target = join(linked.versionRoot, "node_modules", escaped);
      renameSync(target, join(external, "moved"));
      symlinkSync(join(external, "moved"), target);
      expectRefused(linked.home, "could not read the managed npm installation", external);
    }
    const upper = npmFixture("@Acme/Tools");
    expectRefused(upper.home, "outside its managed npm installation", "Acme");
  });
});

describe("Paseo npm plugin reconciliation", () => {
  test("installs the exact version of a scoped package without --ref, then enables the global switch", async () => {
    const b = box([], { pluginsEnabled: false }); await carry(b.link, tools);
    expect(b.commands.slice(0, 3)).toEqual(["paseo plugin ls --json", "paseo plugin install 'npm:@acme/tools@1.2.3' --id 'tools' --json", readConfig]);
    expect(written(b.commands)).toEqual({ pluginsEnabled: true });
    const nested = box([]); await carry(nested.link, { ...tools, packageName: "review-kit", path: "plugins/review" });
    expect(nested.commands[1]).toBe("paseo plugin install 'npm:review-kit@1.2.3:plugins/review' --id 'tools' --json");
  });
  test("updates to the exact version in either direction and is idempotent", async () => {
    for (const boxVersion of ["1.0.0", "2.0.0"]) {
      const b = box([installedNpm({ installation: { ...installedNpm().installation, currentRevision: boxVersion } })]);
      await carry(b.link, tools);
      expect(b.commands.slice(1)).toEqual(["paseo plugin update 'tools' --version '1.2.3' --json", readConfig]);
    }
    const current = box([installedNpm()]);
    expect(await carry(current.link, tools)).toEqual([]);
    expect(current.commands).toEqual(["paseo plugin ls --json", readConfig]);
  });
  test("reconciles enabled state in a safe order", async () => {
    const older = installedNpm({ installation: { ...installedNpm().installation, currentRevision: "1.0.0" } });
    const b = box([older]); await carry(b.link, { ...tools, enabled: false });
    expect(b.commands.slice(1)).toEqual(["paseo plugin disable 'tools' --json", "paseo plugin update 'tools' --version '1.2.3' --json"]);
    const disabled = box([{ ...older, enabled: false }]); await carry(disabled.link, tools);
    expect(disabled.commands.slice(1)).toEqual(["paseo plugin update 'tools' --version '1.2.3' --json", "paseo plugin enable 'tools' --json", readConfig]);
    const absent = box([]);
    expect((await carry(absent.link, { ...tools, enabled: false }))[0]).toContain("disabled locally");
    expect(absent.commands).toHaveLength(1);
  });
  test("skips an ID whose box source is another package, subdirectory, or Git", async () => {
    for (const identity of [
      { kind: "npm", packageName: "@other/tools", pluginPath: "." },
      { kind: "npm", packageName: tools.packageName, pluginPath: "nested" },
      { kind: "git", remote, pluginPath: "." },
    ]) {
      const b = box([installedNpm({ installation: { identity, currentRevision: "1.0.0" } })], { pluginsEnabled: false });
      expect((await carry(b.link, tools))[0]).toContain("different source");
      expect(b.commands).toEqual(["paseo plugin ls --json"]);
    }
    const git = box([installedNpm()]);
    expect((await carry(git.link, { ...plugin, id: "tools" }))[0]).toContain("different source");
  });
});

test("dry runs show npm plugins without registry URLs", async () => {
  const f = npmFixture();
  const lines: string[] = [];
  const deps: SyncDependencies = {
    publisher: () => "operator", readConfig: () => ({ version: 1, publisher: "operator", snapshotUrl: "snapshot.git",
      integrations: { paseo: true }, host: { tailscale: "on", sshUser: "user" } }),
    createLink: () => { throw new Error("must stay offline"); }, writeLine: (line) => lines.push(line),
  };
  const result = await runSync({ home: f.home, dryRun: true }, deps);
  expect(result.boxes[0]?.plan.paseoPlugins?.plugins).toEqual([tools]);
  expect(lines.join("\n")).toContain("Paseo plugins: tools@npm:@acme/tools@1.2.3 (enabled)");
  expect(JSON.stringify(result) + lines.join("\n")).not.toContain("registry.example.com");
});

test("watch detects npm version changes with its real observer", async () => {
  const f = npmFixture();
  mkdirSync(join(f.home, ".ferry"));
  writeFileSync(join(f.home, ".ferry/config.toml"), `version = 1\npublisher = ${JSON.stringify(hostname())}\nsnapshot_url = "snapshot.git"\n[host]\ntailscale = "box"\nssh_user = "user"\n[integrations]\npaseo = true\n`);
  const controller = new AbortController();
  let polls = 0, syncs = 0;
  await runWatch({ home: f.home, signal: controller.signal, pollMs: 1, debounceMs: 1 }, {
    sleep: async () => { if (++polls === 1) f.install("1.2.4"); if (polls > 5) controller.abort(); },
    sync: async () => { syncs++; controller.abort(); }, writeLine: () => {},
    readState: () => null, writeState: () => {},
  });
  expect(syncs).toBe(1);
});
