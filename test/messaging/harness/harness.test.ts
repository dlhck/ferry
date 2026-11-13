import { afterEach, describe, expect, test } from "bun:test";
import { appendFileSync, mkdtempSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { changedPaths, createCheckout, git, treeState } from "./checkout.ts";
import { FakeClock, MINUTE } from "./clock.ts";
import { createHomes } from "./homes.ts";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function checkout() {
  const parent = mkdtempSync(join(tmpdir(), "ferry-messaging-checkout-"));
  roots.push(parent);
  return createCheckout(parent);
}

describe("checkout state", () => {
  test("the read-only Git commands of remote selection change nothing", () => {
    const repo = checkout();
    const before = treeState(repo.root);
    // The commands of design 4.1, with the options that keep Git from writing.
    for (const cwd of [repo.main, repo.linked]) {
      const readOnly = (...args: string[]) =>
        Bun.spawnSync(["git", "-c", "core.fsmonitor=false", ...args], {
          cwd,
          env: { ...process.env, GIT_OPTIONAL_LOCKS: "0", GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null" },
        });
      expect(readOnly("rev-parse", "--show-toplevel").exitCode).toBe(0);
      expect(readOnly("remote").stdout.toString().trim()).toBe("origin");
      expect(readOnly("remote", "get-url", "origin").stdout.toString().trim()).toBe(repo.remoteUrl);
      expect(readOnly("rev-parse", "--abbrev-ref", "HEAD").exitCode).toBe(0);
    }
    const after = treeState(repo.root);
    expect(changedPaths(before, after)).toEqual([]);
    expect(after.hash).toBe(before.hash);
  });

  test("a change in Git metadata, an ignored file, or the linked worktree shows", () => {
    const repo = checkout();
    const before = treeState(repo.root);
    git(repo.main, "config", "ferry.example", "1");
    appendFileSync(repo.ignoredFile, "more\n");
    writeFileSync(join(repo.linked, "new.txt"), "new\n");
    const changed = changedPaths(before, treeState(repo.root));
    expect(changed).toContain("app/.git/config");
    expect(changed).toContain("app/notes.local");
    expect(changed).toContain("app-linked/new.txt");
  });

  test("a rewrite with the same content shows", () => {
    const repo = checkout();
    const before = treeState(repo.root);
    const later = new Date(statSync(repo.ignoredFile).mtimeMs + 5_000);
    utimesSync(repo.ignoredFile, later, later);
    expect(changedPaths(before, treeState(repo.root))).toEqual(["app/notes.local"]);
  });
});

describe("fake clock", () => {
  test("moves forward only", () => {
    const clock = new FakeClock("2026-01-05T09:00:00.000Z");
    clock.advance(15 * MINUTE);
    expect(clock.iso()).toBe("2026-01-05T09:15:00.000Z");
    expect(() => clock.set("2026-01-05T09:00:00.000Z")).toThrow("cannot go back");
    expect(() => clock.advance(-1)).toThrow();
  });
});

describe("test homes", () => {
  test("each identity gets its own home and environment", () => {
    const homes = createHomes();
    roots.push(homes.root);
    const alice = homes.get("alice");
    const bob = homes.get("bob");
    expect(alice.home).not.toBe(bob.home);
    expect(alice.githubUserId).not.toBe(bob.githubUserId);
    expect(alice.env.HOME).toBe(alice.home);
    expect(bob.env.CODEX_HOME).toBe(bob.codexHome);
    expect(statSync(alice.messagingDir).mode & 0o777).toBe(0o700);
    expect(() => homes.get("carol")).toThrow();
  });
});
