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
const skillRoots = [".agents/skills", ".claude/skills"] as const;

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
    checkAgent: async () => ({ ok: true }),
    createLink: () => ({
      async run(command) {
        calls.linked++;
        const stdout = command.includes("ssh-keygen -F") ? "trusted\n" : "";
        return { ok: true, address: "100.64.0.9", stdout, stderr: "" };
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
  test("dry-run returns the machine plan without remote calls or filesystem writes", async () => {
    const home = makeHome();
    write(join(home, ".agents/skills/tdd/SKILL.md"), "test first\n");
    write(join(home, "AGENTS.md"), "Keep changes small.\n");
    const before = realpathSync(join(home, ".agents/skills/tdd"));
    const { calls, deps } = dependencies(home);

    const result = await runInit(
      {
        home,
        harnesses: BUILTIN_HARNESSES,
        host: "builder.tailnet.ts.net",
        sshUser: "david",
        snapshotUrl: "git@example.test:ferry-store.git",
        dryRun: true,
      },
      deps,
    );

    expect(calls).toEqual({ opened: 0, published: 0, linked: 0 });
    expect(existsSync(join(home, ".ferry"))).toBe(false);
    expect(realpathSync(join(home, ".agents/skills/tdd"))).toBe(before);
    expect(result).toMatchObject({
      dryRun: true,
      plan: {
        operator: "operator.test",
        box: "david@builder.tailnet.ts.net",
        gitRemote: "git@example.test:ferry-store.git",
        localCheckout: join(home, ".ferry/store"),
        configPath: join(home, ".ferry/config.toml"),
        skills: ["tdd"],
        instructions: true,
      },
    });
    if (!result.dryRun) throw new Error("expected a dry-run result");
    expect(result.plan.links).toContainEqual({
      harness: "Shared agents",
      path: join(home, ".agents/skills/tdd"),
      target: join(home, ".ferry/store/skills/tdd"),
    });
    expect(result.plan.links.some((link) => link.path.includes(".codex/skills"))).toBe(false);
    expect(result.plan.links).toContainEqual({
      harness: "Claude",
      path: join(home, ".claude/CLAUDE.md"),
      target: join(home, ".ferry/store/AGENTS.md"),
    });
  });

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

    expect(calls).toEqual({ opened: 1, published: 1, linked: 3 });
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

  test("an SSH snapshot refuses when the operator agent has no identities", async () => {
    const home = makeHome();
    const { calls, deps } = dependencies(home);

    await expect(
      runInit(
        {
          home,
          harnesses: BUILTIN_HARNESSES,
          sshDestination: "ubuntu@orb",
          snapshotUrl: "git@github.com:operator/ferry-store.git",
        },
        {
          ...deps,
          checkAgent: async () => ({ ok: false, message: "The agent has no identities." }),
        },
      ),
    ).rejects.toEqual(
      new InitRefusal(
        "agent-refusal",
        "operator SSH agent is unavailable or has no identities: The agent has no identities. Run ssh-add before ferry init.",
      ),
    );

    expect(calls).toEqual({ opened: 0, published: 0, linked: 0 });
    expect(existsSync(join(home, ".ferry"))).toBe(false);
  });

  test("an SSH snapshot refuses when the box cannot use the forwarded agent", async () => {
    const home = makeHome();
    const { calls, deps } = dependencies(home);

    await expect(
      runInit(
        {
          home,
          harnesses: BUILTIN_HARNESSES,
          sshDestination: "ubuntu@orb",
          snapshotUrl: "git@github.com:operator/ferry-store.git",
        },
        {
          ...deps,
          checkAgent: async () => ({ ok: true }),
          createLink: () => ({
            async run(command, options) {
              calls.linked++;
              expect(command).toContain("SSH_AUTH_SOCK");
              expect(options).toEqual({ agentForwarding: "git" });
              return {
                ok: false,
                error: {
                  code: "command-failed",
                  origin: "box",
                  message: "SSH agent forwarding is unavailable",
                },
              };
            },
          }),
        },
      ),
    ).rejects.toEqual(
      new InitRefusal(
        "agent-refusal",
        "box: SSH agent forwarding is unavailable",
      ),
    );

    expect(calls).toEqual({ opened: 0, published: 0, linked: 1 });
    expect(existsSync(join(home, ".ferry"))).toBe(false);
  });

  test("an untrusted Git host key requires operator approval", async () => {
    const home = makeHome();
    const { calls, deps } = dependencies(home);
    let linkCall = 0;
    let approval: unknown;

    await expect(
      runInit(
        {
          home,
          harnesses: BUILTIN_HARNESSES,
          sshDestination: "ubuntu@orb",
          snapshotUrl: "git@github.com:operator/ferry-store.git",
        },
        {
          ...deps,
          checkAgent: async () => ({ ok: true }),
          approveHostKeys: async (request) => {
            approval = request;
            return false;
          },
          createLink: () => ({
            async run() {
              calls.linked++;
              linkCall++;
              if (linkCall === 1) {
                return { ok: true, address: "ubuntu@orb", stdout: "identity\n", stderr: "" };
              }
              if (linkCall === 2) {
                return { ok: true, address: "ubuntu@orb", stdout: "missing\n", stderr: "" };
              }
              return {
                ok: true,
                address: "ubuntu@orb",
                stdout:
                  "github.com ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIOMqqnkVzrm0SdG6UOoqKLsabgH5C9okWi0dh2l9GKJl\n",
                stderr: "",
              };
            },
          }),
        },
      ),
    ).rejects.toEqual(
      new InitRefusal("host-key-refusal", "operator did not trust the SSH host keys for github.com"),
    );

    expect(approval).toEqual({
      host: "github.com",
      keys: [
        {
          algorithm: "ssh-ed25519",
          fingerprint: "SHA256:+DiY3wvvV6TuJJhbpZisF/zLDA0zPMSvHdkr4UvCOqU",
        },
      ],
    });
    expect(calls).toEqual({ opened: 0, published: 0, linked: 3 });
    expect(existsSync(join(home, ".ferry"))).toBe(false);
  });

  test("an approved Git host key is installed before repository access is verified", async () => {
    const home = makeHome();
    const { calls, deps } = dependencies(home);
    let linkCall = 0;
    let installed = false;
    let repositoryChecked = false;

    const result = await runInit(
      {
        home,
        harnesses: BUILTIN_HARNESSES,
        sshDestination: "ubuntu@orb",
        snapshotUrl: "git@github.com:operator/ferry-store.git",
      },
      {
        ...deps,
        checkAgent: async () => ({ ok: true }),
        approveHostKeys: async () => true,
        createLink: () => ({
          async run(command, options) {
            calls.linked++;
            linkCall++;
            if (linkCall === 1) {
              return { ok: true, address: "ubuntu@orb", stdout: "identity\n", stderr: "" };
            }
            if (linkCall === 2) {
              return { ok: true, address: "ubuntu@orb", stdout: "missing\n", stderr: "" };
            }
            if (linkCall === 3) {
              return {
                ok: true,
                address: "ubuntu@orb",
                stdout:
                  "github.com ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIOMqqnkVzrm0SdG6UOoqKLsabgH5C9okWi0dh2l9GKJl\n",
                stderr: "",
              };
            }
            if (linkCall === 4) {
              expect(command).toContain("$HOME/.ssh/known_hosts");
              expect(command).toContain(
                "github.com ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIOMqqnkVzrm0SdG6UOoqKLsabgH5C9okWi0dh2l9GKJl",
              );
              installed = true;
              return { ok: true, address: "ubuntu@orb", stdout: "", stderr: "" };
            }
            expect(installed).toBe(true);
            expect(command).toBe(
              "git ls-remote 'git@github.com:operator/ferry-store.git' HEAD",
            );
            expect(options).toEqual({ agentForwarding: "git" });
            repositoryChecked = true;
            return { ok: true, address: "ubuntu@orb", stdout: "tip\tHEAD\n", stderr: "" };
          },
        }),
      },
    );

    expect(repositoryChecked).toBe(true);
    expect(calls).toEqual({ opened: 1, published: 1, linked: 5 });
    expect(result).toMatchObject({ dryRun: false, address: "ubuntu@orb", published: true });
  });

  test("an SSH snapshot refuses when the forwarded identity cannot read the repository", async () => {
    const home = makeHome();
    const { calls, deps } = dependencies(home);
    let linkCall = 0;

    await expect(
      runInit(
        {
          home,
          harnesses: BUILTIN_HARNESSES,
          sshDestination: "ubuntu@orb",
          snapshotUrl: "git@github.com:operator/ferry-store.git",
        },
        {
          ...deps,
          checkAgent: async () => ({ ok: true }),
          createLink: () => ({
            async run() {
              calls.linked++;
              linkCall++;
              if (linkCall === 1) {
                return { ok: true, address: "ubuntu@orb", stdout: "identity\n", stderr: "" };
              }
              if (linkCall === 2) {
                return { ok: true, address: "ubuntu@orb", stdout: "trusted\n", stderr: "" };
              }
              return {
                ok: false,
                error: {
                  code: "command-failed",
                  origin: "box",
                  message: "git@github.com: Permission denied (publickey).",
                },
              };
            },
          }),
        },
      ),
    ).rejects.toEqual(
      new InitRefusal(
        "snapshot-access-refusal",
        "box: could not read git@github.com:operator/ferry-store.git through the forwarded agent: git@github.com: Permission denied (publickey).",
      ),
    );

    expect(calls).toEqual({ opened: 0, published: 0, linked: 3 });
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

  test("a prompt can choose an SSH destination instead of Tailscale values", async () => {
    const home = makeHome();
    let target: unknown;
    const { deps } = dependencies(home);

    await runInit(
      { home, harnesses: BUILTIN_HARNESSES },
      {
        ...deps,
        prompt: async (missing) => {
          expect(missing).toEqual(["host", "sshUser", "snapshotUrl"]);
          return { sshDestination: "ubuntu@orb", snapshotUrl: "snapshot.git" };
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
