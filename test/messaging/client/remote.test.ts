import { afterEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  findProject,
  normalizeRemote,
  readOnlyGit,
  readRemoteOverrides,
  selectRemote,
  setRemoteOverride,
  type GitRunner,
} from "../../../src/messaging/client/remote.ts";

describe("URL normalization", () => {
  test.each([
    ["git@github.com:Acme/App.git", "github.com/acme/app"],
    ["ssh://git@github.com/Acme/App", "github.com/acme/app"],
    ["ssh://git@ssh.github.com:443/Acme/App.git", "github.com/acme/app"],
    ["https://github.com/Acme/App.git/", "github.com/acme/app"],
    ["https://user:token@github.com/Acme/App", "github.com/acme/app"],
    ["git://github.com/Acme/App.git", "github.com/acme/app"],
    ["git+ssh://git@github.com/acme/app.js.git", "github.com/acme/app.js"],
    ["github.com:acme/app", "github.com/acme/app"],
  ])("%s is %s", (url, key) => {
    expect(normalizeRemote(url)).toEqual({ ok: true, key });
  });

  test.each([
    ["https://github.example.com/acme/app.git", null],
    ["https://gitlab.com/acme/app.git", null],
    ["https://ssh.github.com/acme/app.git", null],
    ["git@gitlab.com:acme/app.git", "gitlab.com"],
    ["ssh://git@work/acme/app.git", "work"],
  ])("%s is unsupported-host", (url, sshAlias) => {
    expect(normalizeRemote(url)).toEqual({ ok: false, code: "unsupported-host", sshAlias });
  });

  test.each([
    "https://github.com/acme",
    "https://github.com/acme/app/tree/main",
    "https://github.com/acme/app?tab=readme",
    "/srv/git/app.git",
    "../app",
    "file:///srv/git/app.git",
    "https://github.com/acme/..",
    "https://github.com/ac_me/app",
    "",
  ])("%s is invalid-remote", (url) => {
    expect(normalizeRemote(url)).toMatchObject({ ok: false, code: "invalid-remote" });
  });

  test("an SSH alias with GitHub as its host name normalizes to the GitHub key", () => {
    expect(normalizeRemote("work:Acme/App.git", "github.com")).toEqual({ ok: true, key: "github.com/acme/app" });
    expect(normalizeRemote("work:Acme/App.git", "gitlab.com")).toEqual({ ok: false, code: "unsupported-host", sshAlias: null });
  });

  test("the result never holds the URL credential", () => {
    expect(JSON.stringify(normalizeRemote("https://user:example-secret@github.com/acme/app"))).not.toContain("example-secret");
  });
});

/** A Git runner with fixed remotes. */
const fakeGit = (remotes: Record<string, string>): GitRunner => async (args) => {
  if (args[0] === "remote" && args.length === 1) return Object.keys(remotes).map((name) => `${name}\n`).join("");
  if (args[0] === "remote" && args[1] === "get-url") return remotes[args[2]!] === undefined ? null : `${remotes[args[2]!]}\n`;
  return null;
};

describe("remote selection", () => {
  test("uses origin when it is a GitHub remote", async () => {
    expect(await selectRemote("/work/app", fakeGit({ upstream: "git@github.com:acme/app.git", origin: "git@github.com:alice/app.git" }))).toEqual({
      ok: true,
      remote: "origin",
      key: "github.com/alice/app",
    });
  });

  test("uses the only GitHub remote when origin is not one", async () => {
    expect(await selectRemote("/work/app", fakeGit({ origin: "https://gitlab.com/acme/app.git", github: "https://github.com/acme/app" }))).toEqual({
      ok: true,
      remote: "github",
      key: "github.com/acme/app",
    });
  });

  test("refuses two GitHub remotes without origin, and lists the remote names", async () => {
    expect(await selectRemote("/work/app", fakeGit({ fork: "git@github.com:alice/app.git", upstream: "git@github.com:acme/app.git" }))).toEqual({
      ok: false,
      code: "ambiguous-remote",
      remotes: ["fork", "upstream"],
    });
  });

  test("the override comes first, and must name a GitHub remote that exists", async () => {
    const git = fakeGit({ origin: "git@github.com:alice/app.git", upstream: "git@github.com:acme/app.git", mirror: "https://gitlab.com/acme/app" });
    expect(await selectRemote("/work/app", git, { override: "upstream" })).toEqual({ ok: true, remote: "upstream", key: "github.com/acme/app" });
    expect(await selectRemote("/work/app", git, { override: "mirror" })).toMatchObject({ ok: false, code: "unsupported-host" });
    expect(await selectRemote("/work/app", git, { override: "gone" })).toMatchObject({ ok: false, code: "unknown-remote" });
  });

  test("a checkout without remotes, or without a GitHub remote, does not participate", async () => {
    expect(await selectRemote("/work/app", fakeGit({}))).toEqual({ ok: false, code: "no-remote", remotes: [] });
    expect(await selectRemote("/work/app", fakeGit({ origin: "https://gitlab.com/acme/app" }))).toEqual({ ok: false, code: "unsupported-host", remotes: ["origin"] });
  });

  test("resolves an SSH alias with ssh -G, and only for a host that is not GitHub", async () => {
    const asked: string[] = [];
    const sshHostName = async (alias: string) => {
      asked.push(alias);
      return alias === "work" ? "github.com" : "git.example.com";
    };
    expect(await selectRemote("/work/app", fakeGit({ origin: "work:Acme/App.git" }), { sshHostName })).toEqual({ ok: true, remote: "origin", key: "github.com/acme/app" });
    expect(await selectRemote("/work/app", fakeGit({ origin: "git@github.com:acme/app.git" }), { sshHostName })).toMatchObject({ ok: true });
    expect(await selectRemote("/work/app", fakeGit({ origin: "lab:acme/app.git" }), { sshHostName })).toMatchObject({ ok: false, code: "unsupported-host" });
    expect(asked).toEqual(["work", "lab"]);
  });
});

describe("a real checkout", () => {
  const roots: string[] = [];
  afterEach(() => {
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  });

  const git = (cwd: string, ...args: string[]) => {
    const result = Bun.spawnSync(["git", ...args], { cwd, env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" } });
    if (result.exitCode !== 0) throw new Error(`git ${args.join(" ")} failed: ${result.stderr.toString()}`);
  };

  /** The hash of every path, mode, and content under `dir`, ignored files and `.git` included. */
  const treeHash = (dir: string): string => {
    const hash = createHash("sha256");
    const walk = (path: string) => {
      for (const name of readdirSync(path).sort()) {
        const child = join(path, name);
        const stat = statSync(child);
        hash.update(`${child}\0${stat.mode}\0${stat.mtimeMs}\0`);
        if (stat.isDirectory()) walk(child);
        else hash.update(readFileSync(child));
      }
    };
    walk(dir);
    return hash.digest("hex");
  };

  test("finds the project of a linked worktree and an insteadOf remote, and changes nothing in the checkout", async () => {
    const base = realpathSync(mkdtempSync(join(tmpdir(), "ferry-remote-")));
    roots.push(base);
    const home = join(base, "home");
    const repo = join(base, "app");
    mkdirSync(home);
    mkdirSync(repo);
    git(repo, "init", "-q", "-b", "main");
    git(repo, "config", "url.git@github.com:acme/.insteadOf", "acme:");
    git(repo, "remote", "add", "origin", "acme:App.git");
    git(repo, "remote", "add", "upstream", "https://github.com/example/app");
    writeFileSync(join(repo, ".gitignore"), "ignored.txt\n");
    writeFileSync(join(repo, "ignored.txt"), "local\n");
    writeFileSync(join(repo, "README.md"), "# App\n");
    git(repo, "add", ".");
    git(repo, "-c", "user.name=Example", "-c", "user.email=operator@example.com", "commit", "-q", "-m", "init");
    git(repo, "worktree", "add", "-q", join(base, "app-feature"), "-b", "feature");
    mkdirSync(join(repo, "src"));
    const before = treeHash(base);

    expect(await findProject(join(repo, "src"), { home, git: readOnlyGit })).toEqual({ root: repo, ok: true, remote: "origin", key: "github.com/acme/app" });
    expect(await findProject(join(base, "app-feature"), { home })).toMatchObject({ root: join(base, "app-feature"), ok: true, key: "github.com/acme/app" });
    expect(await findProject(home, { home })).toBeNull();
    expect(treeHash(base)).toBe(before);

    setRemoteOverride(home, repo, "upstream");
    expect(await findProject(repo, { home })).toMatchObject({ ok: true, remote: "upstream", key: "github.com/example/app" });
    expect(statSync(join(home, ".ferry", "messaging", "remotes.json")).mode & 0o777).toBe(0o600);
    setRemoteOverride(home, repo, null);
    expect(readRemoteOverrides(home)).toEqual({});
  });
});
