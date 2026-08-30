import { afterEach, describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { readConfig } from "../src/config.ts";
import { InitRefusal, runInit, type InitDependencies } from "../src/init.ts";
import type { Seed } from "../src/manifest.ts";
import { BUILTIN_HARNESSES } from "../src/registry/builtin.ts";

const homes: string[] = [];
const skillRoots = [
  ".agents/skills",
  ".claude/skills",
  ".codex/skills",
  ".pi/agent/skills",
  ".cursor/skills",
] as const;

afterEach(() => {
  for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true });
});

function makeHome(): string {
  const home = realpathSync(mkdtempSync(join(tmpdir(), "ferry-init-")));
  homes.push(home);
  return home;
}

function write(path: string, body: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, body);
}

function dependencies(home: string) {
  const calls = { opened: 0, published: 0, linked: 0 };
  const deps: InitDependencies = {
    publisher: () => "operator.test",
    createLink: () => ({
      async run(command) {
        calls.linked++;
        expect(command).toBe("true");
        return { ok: true, address: "100.64.0.9", stdout: "", stderr: "" };
      },
    }),
    async openStore(_remote, seed) {
      calls.opened++;
      const path = join(home, ".ferry", "store");
      writeStore(path, seed);
      return {
        path,
        async publish(value) {
          calls.published++;
          writeStore(path, value);
          return { published: true, tip: "seed-tip" };
        },
      };
    },
  };
  return { calls, deps };
}

function writeStore(path: string, seed: Seed): void {
  mkdirSync(join(path, "skills"), { recursive: true });
  for (const skill of seed.skills) {
    for (const file of skill.files) writeFile(join(path, "skills", skill.name, file.path), file.bytes);
  }
  writeFile(join(path, "AGENTS.md"), seed.instructions?.bytes ?? new Uint8Array());
}

function writeFile(path: string, body: string | Uint8Array): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, body);
}

describe("ferry init", () => {
  test("seeds a fake store, probes the host, writes config outside it, and applies links", async () => {
    const home = makeHome();
    write(join(home, ".agents/skills/tdd/SKILL.md"), "test first\n");
    write(join(home, "AGENTS.md"), "Keep changes small.\n");
    write(join(home, ".agents/skills/not-a-skill.txt"), "left behind\n");
    const { calls, deps } = dependencies(home);

    const result = await runInit(
      {
        home,
        harnesses: BUILTIN_HARNESSES,
        host: "builder.tailnet.ts.net",
        sshUser: "david",
        snapshotUrl: "git@example.test:ferry-store.git",
      },
      deps,
    );

    expect(calls).toEqual({ opened: 1, published: 1, linked: 1 });
    expect(result.address).toBe("100.64.0.9");
    expect(result.paseoPort).toBe(6767);
    expect(result.leftovers).toHaveLength(1);
    expect(readConfig(home)).toEqual({
      version: 1,
      publisher: "operator.test",
      snapshotUrl: "git@example.test:ferry-store.git",
      host: { tailscale: "builder.tailnet.ts.net", sshUser: "david" },
    });
    expect(existsSync(join(home, ".ferry/config.toml"))).toBe(true);
    expect(existsSync(join(home, ".ferry/store/config.toml"))).toBe(false);
    for (const root of skillRoots) {
      expect(realpathSync(join(home, root, "tdd"))).toBe(join(home, ".ferry/store/skills/tdd"));
    }
    expect(realpathSync(join(home, "AGENTS.md"))).toBe(join(home, ".ferry/store/AGENTS.md"));
    expect(realpathSync(join(home, ".claude/CLAUDE.md"))).toBe(
      join(home, ".ferry/store/AGENTS.md"),
    );
  });

  test("a Manifest clash refuses before Link, Store, Apply, or config writes", async () => {
    const home = makeHome();
    write(join(home, ".claude/skills/tdd/SKILL.md"), "claude\n");
    write(join(home, ".codex/skills/tdd/SKILL.md"), "codex\n");
    const { calls, deps } = dependencies(home);

    await expect(
      runInit(
        { home, harnesses: BUILTIN_HARNESSES, host: "box", sshUser: "david", snapshotUrl: "snapshot.git" },
        deps,
      ),
    ).rejects.toMatchObject({ code: "manifest-refusal" });

    expect(calls).toEqual({ opened: 0, published: 0, linked: 0 });
    expect(existsSync(join(home, ".ferry"))).toBe(false);
  });

  test("a second run keeps existing values and fills a missing value", async () => {
    const home = makeHome();
    write(join(home, ".ferry/config.toml"), [
      "version = 1",
      'publisher = "first-operator"',
      'snapshot_url = "snapshot.git"',
      "",
      "[host]",
      'tailscale = "box"',
      "",
    ].join("\n"));
    const { deps } = dependencies(home);

    await runInit({ home, harnesses: BUILTIN_HARNESSES, sshUser: "david" }, deps);

    expect(readConfig(home)).toEqual({
      version: 1,
      publisher: "first-operator",
      snapshotUrl: "snapshot.git",
      host: { tailscale: "box", sshUser: "david" },
    });
  });

  test("records and probes an explicit SSH destination", async () => {
    const home = makeHome();
    let target: unknown;
    const { deps } = dependencies(home);

    await runInit(
      {
        home,
        harnesses: BUILTIN_HARNESSES,
        sshDestination: "ubuntu@orb",
        snapshotUrl: "snapshot.git",
      },
      {
        ...deps,
        createLink(value) {
          target = value;
          return {
            async run() {
              return { ok: true, address: "ubuntu@orb", stdout: "", stderr: "" };
            },
          };
        },
      },
    );

    expect(target).toEqual({ destination: "ubuntu@orb" });
    expect(readConfig(home)).toEqual({
      version: 1,
      publisher: "operator.test",
      snapshotUrl: "snapshot.git",
      host: { transport: "ssh", destination: "ubuntu@orb" },
    });
  });

  test("keeps an explicit SSH destination when the prompt fills the snapshot URL", async () => {
    const home = makeHome();
    let target: unknown;
    const { deps } = dependencies(home);

    await runInit(
      { home, harnesses: BUILTIN_HARNESSES, sshDestination: "ubuntu@orb" },
      {
        ...deps,
        prompt: async (missing) => {
          expect(missing).toEqual(["snapshotUrl"]);
          return { snapshotUrl: "snapshot.git" };
        },
        createLink(options) {
          target = options;
          return {
            async run() {
              return { ok: true, address: "ubuntu@orb", stdout: "", stderr: "" };
            },
          };
        },
      },
    );

    expect(target).toEqual({ destination: "ubuntu@orb" });
    expect(readConfig(home)?.host).toEqual({
      transport: "ssh",
      destination: "ubuntu@orb",
    });
  });

  test("keeps a saved SSH destination when the prompt fills missing config", async () => {
    const home = makeHome();
    write(join(home, ".ferry/config.toml"), [
      "version = 1",
      'publisher = "first-operator"',
      "",
      "[host]",
      'transport = "ssh"',
      'destination = "ubuntu@orb"',
      "",
    ].join("\n"));
    const { deps } = dependencies(home);

    await runInit(
      { home, harnesses: BUILTIN_HARNESSES },
      {
        ...deps,
        prompt: async (missing) => {
          expect(missing).toEqual(["snapshotUrl"]);
          return { snapshotUrl: "snapshot.git" };
        },
      },
    );

    expect(readConfig(home)).toEqual({
      version: 1,
      publisher: "first-operator",
      snapshotUrl: "snapshot.git",
      host: { transport: "ssh", destination: "ubuntu@orb" },
    });
  });

  test("an explicit SSH destination replaces an existing Tailscale target", async () => {
    const home = makeHome();
    write(join(home, ".ferry/config.toml"), [
      "version = 1",
      'publisher = "first-operator"',
      'snapshot_url = "snapshot.git"',
      "",
      "[host]",
      'tailscale = "old-box"',
      'ssh_user = "david"',
      "",
    ].join("\n"));
    const { deps } = dependencies(home);

    await runInit(
      { home, harnesses: BUILTIN_HARNESSES, sshDestination: "ubuntu@orb" },
      deps,
    );

    expect(readConfig(home)?.host).toEqual({
      transport: "ssh",
      destination: "ubuntu@orb",
    });
  });

  test("refuses mixed Tailscale and direct SSH input", async () => {
    const home = makeHome();
    const { deps } = dependencies(home);

    await expect(
      runInit(
        {
          home,
          harnesses: BUILTIN_HARNESSES,
          host: "box",
          sshUser: "david",
          sshDestination: "ubuntu@orb",
          snapshotUrl: "snapshot.git",
        },
        deps,
      ),
    ).rejects.toMatchObject({ code: "invalid-values" });
  });

  test("refuses when Link cannot run Tailscale", async () => {
    const home = makeHome();
    const { deps } = dependencies(home);
    const linkDeps: InitDependencies = {
      ...deps,
      createLink: () => ({
        async run() {
          return {
            ok: false,
            error: {
              code: "tailscale-status-failed",
              origin: "operator",
              message: "could not run Tailscale",
            },
          };
        },
      }),
    };

    await expect(
      runInit(
        { home, harnesses: BUILTIN_HARNESSES, host: "box", sshUser: "david", snapshotUrl: "snapshot.git" },
        linkDeps,
      ),
    ).rejects.toEqual(
      new InitRefusal("link-refusal", "operator: could not run Tailscale"),
    );
  });
});
