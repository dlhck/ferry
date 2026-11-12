import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BOX_PROJECTS_RECORD, boxWorkLines, parseBoxWork, readBoxWork } from "../src/box-work.ts";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const GIT_ENV = {
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_AUTHOR_NAME: "Operator",
  GIT_AUTHOR_EMAIL: "operator@example.com",
  GIT_COMMITTER_NAME: "Operator",
  GIT_COMMITTER_EMAIL: "operator@example.com",
};

/** A fake box: each Link command runs in `sh` with a temporary home. A local bare repository is the remote. */
function fakeBox() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "ferry-box-work-")));
  roots.push(root);
  const home = join(root, "home");
  mkdirSync(home);
  const env = { ...Bun.env, ...GIT_ENV, HOME: home };
  const sh = (command: string, cwd = home) => {
    const result = Bun.spawnSync(["/bin/sh", "-c", command], { cwd, env, stdout: "pipe", stderr: "pipe" });
    if (result.exitCode !== 0) throw new Error(`${command}: ${result.stderr.toString()}`);
    return result.stdout.toString();
  };
  const link = {
    async run(command: string) {
      const process = Bun.spawn(["/bin/sh", "-c", command], { cwd: home, env, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
      const [exitCode, stdout, stderr] = await Promise.all([
        process.exited,
        new Response(process.stdout).text(),
        new Response(process.stderr).text(),
      ]);
      return exitCode === 0
        ? ({ ok: true, address: "box", stdout, stderr } as const)
        : ({ ok: false, error: { code: "command-failed", origin: "box", message: stderr.trim() } } as const);
    },
  };
  /** A project at `path`, cloned from a new bare remote, with one pushed commit on main. */
  const project = (path: string) => {
    const remote = join(root, `${path.replaceAll("/", "-")}.git`);
    sh(`git init -q --bare -b main ${remote}`);
    sh(`git clone -q ${remote} ${path} 2>/dev/null; cd ${path} && echo a > a && git add a && git commit -qm one && git push -q origin main`);
    return (command: string) => sh(command, join(home, path));
  };
  return { home, link, sh, project };
}

describe("box work", () => {
  test("a clean project that is fully pushed does not appear", async () => {
    const box = fakeBox();
    box.project("code/app");
    expect(await readBoxWork(box.link, ["code/app"])).toEqual({ checked: 1, projects: [], unchecked: [] });
  });

  test("a changed tracked file and an untracked file count as changes", async () => {
    const box = fakeBox();
    const git = box.project("code/app");
    git("echo b > a && echo new > untracked");
    expect(await readBoxWork(box.link, ["code/app"])).toEqual({
      checked: 1,
      projects: [{ path: "code/app", branch: "main", changes: 2, unpushed: [] }],
      unchecked: [],
    });
  });

  test("a branch with commits that are not on its remote appears with the count", async () => {
    const box = fakeBox();
    const git = box.project("code/app");
    git("git commit -q --allow-empty -m two && git commit -q --allow-empty -m three");
    git("git checkout -q -b local-only && git commit -q --allow-empty -m four && git checkout -q main");
    expect(await readBoxWork(box.link, ["code/app"])).toEqual({
      checked: 1,
      projects: [
        {
          path: "code/app",
          branch: "main",
          changes: 0,
          unpushed: [
            { branch: "local-only", commits: 3 },
            { branch: "main", commits: 2 },
          ],
        },
      ],
      unchecked: [],
    });
  });

  test("a stash does not count", async () => {
    const box = fakeBox();
    const git = box.project("code/app");
    git("echo b > a && git stash -q");
    expect(await readBoxWork(box.link, ["code/app"])).toEqual({ checked: 1, projects: [], unchecked: [] });
  });

  test("reads the move record, skips missing and non-git paths, and checks a path one time", async () => {
    const box = fakeBox();
    box.project("code/app").call(null, "echo new > untracked");
    box.project("moved/api").call(null, "echo new > untracked");
    mkdirSync(join(box.home, "plain"));
    mkdirSync(join(box.home, ".ferry"));
    writeFileSync(join(box.home, BOX_PROJECTS_RECORD), "moved/api\ncode/app\n");
    const work = await readBoxWork(box.link, ["code/app", "missing", "plain"]);
    expect(work.checked).toBe(2);
    expect(work.projects.map((project) => project.path)).toEqual(["code/app", "moved/api"]);
  });

  test("a detached HEAD has no branch", async () => {
    const box = fakeBox();
    const git = box.project("code/app");
    git("git checkout -q --detach && echo b > a");
    expect((await readBoxWork(box.link, ["code/app"])).projects[0]?.branch).toBeNull();
  });

  test("a detached HEAD with a commit that no remote has appears with the count", async () => {
    const box = fakeBox();
    const git = box.project("code/app");
    git("git checkout -q --detach && git commit -q --allow-empty -m two");
    expect(await readBoxWork(box.link, ["code/app"])).toEqual({
      checked: 1,
      projects: [{ path: "code/app", branch: null, changes: 0, unpushed: [{ branch: "HEAD", commits: 1 }] }],
      unchecked: [],
    });
  });

  test("a worktree detached at the tip of an unpushed local branch shows the commits once", async () => {
    const box = fakeBox();
    const git = box.project("code/app");
    git(`git checkout -q -b feature && git commit -q --allow-empty -m two && git checkout -q main`);
    git(`git worktree add -q --detach ${box.home}/wt feature`);
    expect(await readBoxWork(box.link, ["code/app"])).toEqual({
      checked: 2,
      projects: [{ path: "code/app", branch: "main", changes: 0, unpushed: [{ branch: "feature", commits: 1 }] }],
      unchecked: [],
    });
  });

  test("each linked worktree of a project is checked with its own path", async () => {
    const box = fakeBox();
    const git = box.project("code/app");
    const outside = join(box.home, "..", "outside");
    git(`git worktree add -q -b agent ${box.home}/.paseo/worktrees/x/app && echo new > ${box.home}/.paseo/worktrees/x/app/untracked`);
    git(`git worktree add -q --detach ${outside} && git -C ${outside} commit -q --allow-empty -m two`);
    git(`git worktree add -q -b gone ${box.home}/gone && rm -rf ${box.home}/gone`);
    // A second configured path in the same repository adds nothing.
    expect(await readBoxWork(box.link, ["code/app", ".paseo/worktrees/x/app"])).toEqual({
      checked: 3,
      projects: [
        { path: ".paseo/worktrees/x/app", branch: "agent", changes: 1, unpushed: [] },
        { path: outside, branch: null, changes: 0, unpushed: [{ branch: "HEAD", commits: 1 }] },
      ],
      unchecked: [],
    });
  });

  test("a project where git fails is unchecked, and never counts as clean", async () => {
    const box = fakeBox();
    box.project("code/app").call(null, "echo junk > .git/HEAD");
    box.project("code/api").call(null, "echo junk > .git/index");
    box.project("code/web");
    const work = await readBoxWork(box.link, ["code/app", "code/api", "code/web"]);
    expect(work).toEqual({ checked: 3, projects: [], unchecked: ["code/app", "code/api"] });
    expect(boxWorkLines(work, "a")).toEqual([
      "Unsaved work: could not check 2 of 3 projects",
      "  ~/code/app: could not check",
      "  ~/code/api: could not check",
    ]);
  });

  test("the output goes through ferry redact on a box with a box install", async () => {
    const box = fakeBox();
    box.project("code/app").call(null, "echo b > a");
    mkdirSync(join(box.home, ".local/bin"), { recursive: true });
    mkdirSync(join(box.home, ".ferry"));
    writeFileSync(join(box.home, ".ferry/box.json"), "{}");
    writeFileSync(join(box.home, ".local/bin/ferry"), "#!/bin/sh\nsed 's/code\\/app/[token]/g'\n");
    chmodSync(join(box.home, ".local/bin/ferry"), 0o755);
    expect((await readBoxWork(box.link, ["code/app"])).projects[0]?.path).toBe("[token]");
  });

  test("the operator puts the token mark in the place of a token in a path or a branch", () => {
    const token = `ghp_${"a1B2".repeat(9)}`;
    const work = parseBoxWork(`project\tcode/${token}\t${token}\t1\nbranch\tcode/${token}\t${token}\t2\nsame-tip\n`);
    expect(JSON.stringify(work)).not.toContain(token);
    expect(work.projects[0]).toEqual({ path: "code/[token]", branch: "[token]", changes: 1, unpushed: [{ branch: "[token]", commits: 2 }] });
  });

  test("the operator replaces the control characters in a path from the box", () => {
    const work = parseBoxWork("project\tcode/\u001b[2Japp\tmain\t1\nerror\tcode/\u0007api\n");
    expect(work.projects[0]?.path).toBe("code/?[2Japp");
    expect(work.unchecked).toEqual(["code/?api"]);
  });

  test("lines name each project with unsaved work", () => {
    expect(
      boxWorkLines(
        {
          checked: 4,
          projects: [
            { path: "code/app", branch: "main", changes: 1, unpushed: [{ branch: "main", commits: 2 }] },
            { path: "code/api", branch: null, changes: 0, unpushed: [{ branch: "feature", commits: 1 }] },
            { path: "/srv/app", branch: null, changes: 0, unpushed: [{ branch: "HEAD", commits: 1 }] },
          ],
          unchecked: ["code/web"],
        },
        "a",
      ),
    ).toEqual([
      "Unsaved work: 3 of 4 projects, only on the box",
      "  ~/code/app (main): 1 changed file, main has 2 commits that no remote has",
      "  ~/code/api (detached HEAD): feature has 1 commit that no remote has",
      "  /srv/app (detached HEAD): HEAD has 1 commit that no remote has",
      "  ~/code/web: could not check",
    ]);
    expect(boxWorkLines({ checked: 2, projects: [], unchecked: [] }, "a")).toEqual(["Unsaved work: none in 2 projects"]);
    expect(boxWorkLines({ checked: 0, projects: [], unchecked: [] }, "a")[0]).toContain("[box.a]");
  });
});
