import { afterEach, describe, expect, test } from "bun:test";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  BoxSettingsError,
  installBoxPlugins,
  mergeBoxSettings,
  mergeSettings,
} from "../src/box-settings.ts";
import type { LinkResult, RunOptions } from "../src/link.ts";
import type { SeedSettings } from "../src/manifest.ts";
import { BUILTIN_HARNESSES } from "../src/registry/builtin.ts";

const roots: string[] = [];
const KEYS = ["enabledPlugins", "extraKnownMarketplaces"];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function makeRoot(): string {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "ferry-box-settings-")));
  roots.push(root);
  return root;
}

function write(path: string, body: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, body);
}

/** Runs each command in a local shell, as the box would, with an optional PATH prefix. */
class ShellLink {
  readonly calls: { command: string; options?: RunOptions }[] = [];

  constructor(private readonly path?: string) {}

  async run(command: string, options?: RunOptions): Promise<LinkResult> {
    this.calls.push({ command, options });
    const process = Bun.spawn(["sh", "-c", command], {
      env: { ...Bun.env, PATH: this.path ?? Bun.env.PATH },
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    });
    const [exitCode, stdout, stderr] = await Promise.all([
      process.exited,
      new Response(process.stdout).text(),
      new Response(process.stderr).text(),
    ]);
    if (exitCode !== 0) {
      return {
        ok: false,
        error: { code: "command-failed", origin: "box", message: stderr.trim() || "failed" },
      };
    }
    return { ok: true, address: "test-box", stdout, stderr };
  }
}

function carried(value: Record<string, unknown>): SeedSettings[] {
  return [{ harness: "claude", bytes: Buffer.from(`${JSON.stringify(value, null, 2)}\n`) }];
}

describe("mergeSettings", () => {
  test("replaces the carried keys and keeps every other box key", () => {
    const box = JSON.stringify({
      env: { TOKEN: "box-only" },
      permissions: { allow: ["Bash(ls)"] },
      enabledPlugins: { "stale@team": true },
    });

    const merged = mergeSettings(box, { enabledPlugins: { "review@team": true } }, KEYS);

    expect(JSON.parse(merged)).toEqual({
      env: { TOKEN: "box-only" },
      permissions: { allow: ["Bash(ls)"] },
      enabledPlugins: { "review@team": true },
    });
  });

  test("removes a carried key the operator no longer has", () => {
    const box = JSON.stringify({ model: "opus", extraKnownMarketplaces: { old: {} } });

    expect(JSON.parse(mergeSettings(box, {}, KEYS))).toEqual({ model: "opus" });
  });

  test("a missing box settings file becomes the carried keys", () => {
    expect(JSON.parse(mergeSettings(null, { enabledPlugins: { "review@team": true } }, KEYS))).toEqual({
      enabledPlugins: { "review@team": true },
    });
  });

  test("refuses a box settings file that is not a JSON object", () => {
    expect(() => mergeSettings("[1, 2]", {}, KEYS)).toThrow(BoxSettingsError);
    expect(() => mergeSettings("{ not json", {}, KEYS)).toThrow(BoxSettingsError);
  });
});

describe("mergeBoxSettings", () => {
  test("merges into the box settings file and keeps the other keys", async () => {
    const home = makeRoot();
    const path = join(home, ".claude", "settings.json");
    write(path, JSON.stringify({ env: { TOKEN: "box-only" }, hooks: { Stop: [] } }));

    const written = await mergeBoxSettings({
      remoteHome: home,
      harnesses: BUILTIN_HARNESSES,
      settings: carried({ enabledPlugins: { "review@team": true } }),
      link: new ShellLink(),
    });

    expect(written).toEqual([path]);
    expect(JSON.parse(readFileSync(path, "utf8"))).toEqual({
      env: { TOKEN: "box-only" },
      hooks: { Stop: [] },
      enabledPlugins: { "review@team": true },
    });
  });

  test("creates a missing box settings file that only the owner can read", async () => {
    const home = makeRoot();
    const path = join(home, ".claude", "settings.json");

    await mergeBoxSettings({
      remoteHome: home,
      harnesses: BUILTIN_HARNESSES,
      settings: carried({ enabledPlugins: { "review@team": true } }),
      link: new ShellLink(),
    });

    expect(JSON.parse(readFileSync(path, "utf8"))).toEqual({ enabledPlugins: { "review@team": true } });
    expect(statSync(path).mode & 0o077).toBe(0);
  });

  test("writes nothing when the box already holds the carried keys", async () => {
    const home = makeRoot();
    const path = join(home, ".claude", "settings.json");
    write(path, `${JSON.stringify({ enabledPlugins: { "review@team": true } }, null, 2)}\n`);
    const link = new ShellLink();

    const written = await mergeBoxSettings({
      remoteHome: home,
      harnesses: BUILTIN_HARNESSES,
      settings: carried({ enabledPlugins: { "review@team": true } }),
      link,
    });

    expect(written).toEqual([]);
    expect(link.calls).toHaveLength(1);
  });

  test("refuses and keeps a box settings file that is not JSON", async () => {
    const home = makeRoot();
    const path = join(home, ".claude", "settings.json");
    write(path, "{ not json");

    await expect(
      mergeBoxSettings({
        remoteHome: home,
        harnesses: BUILTIN_HARNESSES,
        settings: carried({}),
        link: new ShellLink(),
      }),
    ).rejects.toBeInstanceOf(BoxSettingsError);
    expect(readFileSync(path, "utf8")).toBe("{ not json");
  });
});

describe("installBoxPlugins", () => {
  /** A fake claude CLI that logs its arguments and fails for one plugin. */
  function fakeClaude(root: string): { path: string; log: string } {
    const bin = join(root, "bin");
    const log = join(root, "claude.log");
    write(
      join(bin, "claude"),
      [
        "#!/bin/sh",
        `printf '%s\\n' "$*" >> '${log}'`,
        'if [ "$3" = "broken@team" ]; then echo "Installing..."; echo "Plugin not found in marketplace team"; exit 1; fi',
        "exit 0",
      ].join("\n"),
    );
    chmodSync(join(bin, "claude"), 0o755);
    return { path: `${bin}:/usr/bin:/bin`, log };
  }

  test("adds each carried marketplace, then installs each enabled plugin", async () => {
    const root = makeRoot();
    const claude = fakeClaude(root);
    const link = new ShellLink(claude.path);

    const warnings = await installBoxPlugins({
      settings: carried({
        enabledPlugins: { "review@team": true, "old@team": false, "broken@team": true },
        extraKnownMarketplaces: {
          team: { source: { source: "github", repo: "example/claude-plugins" } },
          internal: { source: { source: "git", url: "https://git.example.com/plugins.git" } },
          local: { source: { source: "directory", path: "/Users/operator/plugins" } },
        },
      }),
      link,
    });

    expect(readFileSync(claude.log, "utf8").trim().split("\n")).toEqual([
      "plugin marketplace add example/claude-plugins",
      "plugin marketplace add https://git.example.com/plugins.git",
      "plugin install review@team",
      "plugin install broken@team",
    ]);
    expect(warnings).toEqual([
      "marketplace local has a directory source; add it on the box by hand",
      "could not install plugin broken@team: Plugin not found in marketplace team",
    ]);
    expect(link.calls).toHaveLength(1);
    expect(link.calls[0]?.options?.agentForwarding).toBe("git");
  });

  test("reports a box without the claude CLI and changes nothing", async () => {
    const root = makeRoot();
    const link = new ShellLink(`${join(root, "empty-bin")}:/usr/bin:/bin`);

    const warnings = await installBoxPlugins({
      settings: carried({ enabledPlugins: { "review@team": true } }),
      link,
    });

    expect(warnings).toEqual(["the claude CLI is not on the box PATH; no plugin was installed"]);
  });

  test("runs nothing when no Claude plugin declarations are carried", async () => {
    const link = new ShellLink();

    expect(await installBoxPlugins({ settings: [], link })).toEqual([]);
    expect(await installBoxPlugins({ settings: carried({}), link })).toEqual([]);
    expect(link.calls).toHaveLength(0);
  });
});
