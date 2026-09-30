import { afterEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { DENY_RULES_VERSION } from "../src/manifest.ts";
import { errorInfo } from "../src/output.ts";
import type { Link, LinkResult } from "../src/link.ts";
import { changedFiles, isInside, parseScanRequest, runScan, scanOnBox } from "../src/scan.ts";

// Fake secrets, built at runtime so that no secret scanner flags this file.
const TOKEN = "gh" + "p_" + "f".repeat(36);
const AWS_KEY_ID = "AK" + "IA" + "Q2W3E4R5T6Y7U8I9";
const PASSWORD = "hunt" + "er2-" + "example";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function home(): string {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "ferry-scan-test-")));
  roots.push(root);
  return root;
}

function write(path: string, body: string, mode?: number): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, body);
  if (mode !== undefined) chmodSync(path, mode);
}

function sha256(body: string): string {
  return createHash("sha256").update(body).digest("hex");
}

describe("ferry scan of a skill", () => {
  test("returns the hash of each file that passes, and the hits of the refuse rules and the skip rules", () => {
    const root = home();
    const skill = join(root, ".claude/skills/demo");
    write(join(skill, "SKILL.md"), "# Demo\n");
    write(join(skill, "scripts/run.sh"), "#!/bin/sh\n", 0o755);
    write(join(skill, ".env"), `PASSWORD=${PASSWORD}\n`);
    write(join(skill, "notes.md"), `token ${TOKEN}\n`);
    write(join(skill, "config.json"), JSON.stringify({ password: PASSWORD }));
    write(join(skill, "data.sqlite"), "data\n");

    const scan = runScan({ kind: "skill", root: ".claude/skills/demo" }, root);

    expect(scan.files).toEqual([
      { path: "SKILL.md", sha256: sha256("# Demo\n"), executable: false },
      { path: "scripts/run.sh", sha256: sha256("#!/bin/sh\n"), executable: true },
    ]);
    expect(scan.forbidden).toEqual([
      { path: ".env", code: "dotenv", reason: "environment file" },
      { path: "config.json", code: "secret-field", reason: "key password holds a password or secret" },
      { path: "notes.md", code: "github-token", reason: "GitHub token in file content" },
    ]);
    expect(scan.skipped).toEqual([{ path: "data.sqlite", code: "database", reason: "sqlite or other database file" }]);
    expect(JSON.stringify(scan)).not.toContain(PASSWORD);
    expect(JSON.stringify(scan)).not.toContain(TOKEN);
  });
});

describe("ferry scan of project files", () => {
  test("returns the hash of each file that passes, and refuses a token, a link, and a missing file", () => {
    const root = home();
    const app = join(root, "Developer/app");
    write(join(app, "AGENTS.md"), "# Agents\n");
    write(join(app, "notes.md"), `token ${TOKEN}\n`);
    write(join(app, ".env.local"), `AWS_ACCESS_KEY_ID=${AWS_KEY_ID}\nPASSWORD=${PASSWORD}\n`);
    symlinkSync("AGENTS.md", join(app, "link.md"));
    const paths = ["AGENTS.md", "notes.md", ".env.local", "link.md", "gone.md"];

    const scan = runScan({ kind: "files", root: "Developer/app", paths, allowSecrets: false, confirmed: false }, root);

    expect(scan.carry).toEqual([{ path: "AGENTS.md", sha256: sha256("# Agents\n"), secrets: [] }]);
    expect(scan.refused.map((hit) => [hit.path, hit.code])).toEqual([
      ["notes.md", "github-token"],
      [".env.local", "aws-access-key"],
      ["link.md", "symlink"],
      ["gone.md", "missing"],
    ]);
    expect(JSON.stringify(scan)).not.toContain(TOKEN);
    expect(JSON.stringify(scan)).not.toContain(AWS_KEY_ID);
  });

  test("with allowSecrets, carries an environment file and names its kinds of secret, never the values", () => {
    const root = home();
    const body = `AWS_ACCESS_KEY_ID=${AWS_KEY_ID}\nPASSWORD=${PASSWORD}\n`;
    write(join(root, "Developer/app/.env.local"), body);
    write(join(root, "Developer/app/notes.md"), `token ${TOKEN}\n`);

    const scan = runScan({ kind: "files", root: "Developer/app", paths: [".env.local", "notes.md"], allowSecrets: true, confirmed: true }, root);

    expect(scan.carry).toEqual([
      {
        path: ".env.local",
        sha256: sha256(body),
        secrets: ["AWS access key ID in file content", "key PASSWORD holds a password or secret"],
      },
    ]);
    expect(scan.refused.map((hit) => [hit.path, hit.code])).toEqual([["notes.md", "github-token"]]);
    expect(JSON.stringify(scan)).not.toContain(PASSWORD);
    expect(JSON.stringify(scan)).not.toContain(AWS_KEY_ID);
  });
});

describe("ferry scan of session files", () => {
  test("returns the hash, the hits of the file rules and of the session scan, and the session id of a first line with the project", () => {
    const root = home();
    const project = join(root, "Developer/app");
    const meta = (cwd: string, id: string) => `${JSON.stringify({ type: "session_meta", payload: { id, cwd } })}\n`;
    const call = { type: "response_item", payload: { type: "function_call", arguments: JSON.stringify({ cmd: `psql --password ${PASSWORD}` }) } };
    const files: Record<string, string> = {
      ".claude/projects/app/clean.jsonl": `${JSON.stringify({ type: "user", message: "hello" })}\n`,
      ".claude/projects/app/leaky.jsonl": `${JSON.stringify({ type: "user", message: `use ${TOKEN}` })}\n`,
      ".claude/projects/app/memory/id_rsa": "key\n",
      ".codex/sessions/a.jsonl": meta(project, "11111111-aaaa-4aaa-8aaa-aaaaaaaaaaaa"),
      ".codex/sessions/b.jsonl": `${meta(project, "22222222-bbbb-4bbb-8bbb-bbbbbbbbbbbb")}${JSON.stringify(call)}\n`,
      ".codex/sessions/other.jsonl": meta(join(root, "Developer/other"), "33333333-cccc-4ccc-8ccc-cccccccccccc"),
      ".codex/sessions/odd.jsonl": meta(project, `not an id ${PASSWORD}`),
    };
    for (const [path, body] of Object.entries(files)) write(join(root, path), body);
    const paths = [...Object.keys(files), ".codex/sessions/gone.jsonl"];

    const scan = runScan({ kind: "sessions", paths, project, confirmed: false }, root);

    expect(scan.files.map((file) => [file.path, file.id, file.blocked, file.hits.map((hit) => hit.code)])).toEqual([
      [".claude/projects/app/clean.jsonl", null, false, []],
      [".claude/projects/app/leaky.jsonl", null, false, ["github-token"]],
      [".claude/projects/app/memory/id_rsa", null, true, ["private-key"]],
      [".codex/sessions/a.jsonl", "11111111-aaaa-4aaa-8aaa-aaaaaaaaaaaa", false, []],
      // A session with a hit gives no id.
      [".codex/sessions/b.jsonl", null, false, ["secret-field"]],
      [".codex/sessions/other.jsonl", null, false, []],
      [".codex/sessions/odd.jsonl", null, false, []],
      [".codex/sessions/gone.jsonl", null, true, ["missing"]],
    ]);
    expect(scan.files[0]!.sha256).toBe(sha256(files[".claude/projects/app/clean.jsonl"]!));
    expect(scan.files[1]!.hits[0]!.path).toBe(".claude/projects/app/leaky.jsonl");
    expect(JSON.stringify(scan)).not.toContain(TOKEN);
    expect(JSON.stringify(scan)).not.toContain(PASSWORD);
  });
});

describe("ferry scan gives no data about the content of a denied file", () => {
  const meta = (cwd: string, id: string) => `${JSON.stringify({ type: "session_meta", payload: { id, cwd } })}\n`;

  test("a denied session has no hash, so a short secret in it cannot be found from the result", () => {
    const root = home();
    const pin = "73" + "19";
    const body = `${JSON.stringify({ type: "user", message: { content: [{ type: "tool_result", content: `PASSWORD=${pin}x\n` }] } })}\n`;
    write(join(root, ".claude/projects/app/leaky.jsonl"), body);

    const scan = runScan({ kind: "sessions", paths: [".claude/projects/app/leaky.jsonl"], project: join(root, "app"), confirmed: false }, root);

    expect(scan.files).toEqual([
      {
        path: ".claude/projects/app/leaky.jsonl",
        session: false,
        sha256: null,
        id: null,
        hits: [{ path: ".claude/projects/app/leaky.jsonl", code: "secret-field", reason: "key PASSWORD holds a password or secret" }],
        blocked: false,
      },
    ]);
    expect(JSON.stringify(scan)).not.toContain(sha256(body));
  });

  test("a session with secrets gets its hash and its id only in a confirmed scan, and a blocked file never", () => {
    const root = home();
    const project = join(root, "app");
    const leaky = `${meta(project, "11111111-aaaa-4aaa-8aaa-aaaaaaaaaaaa")}${JSON.stringify({ text: TOKEN })}\n`;
    write(join(root, ".codex/sessions/clean.jsonl"), meta(project, "22222222-bbbb-4bbb-8bbb-bbbbbbbbbbbb"));
    write(join(root, ".codex/sessions/leaky.jsonl"), leaky);
    write(join(root, ".claude/projects/app/memory/id_rsa"), "key\n");
    const paths = [".codex/sessions/clean.jsonl", ".codex/sessions/leaky.jsonl", ".claude/projects/app/memory/id_rsa"];
    const fields = (confirmed: boolean) =>
      runScan({ kind: "sessions", paths, project, confirmed }, root).files.map((file) => [file.session, file.sha256, file.id]);

    expect(fields(false)).toEqual([
      [true, sha256(meta(project, "22222222-bbbb-4bbb-8bbb-bbbbbbbbbbbb")), "22222222-bbbb-4bbb-8bbb-bbbbbbbbbbbb"],
      [true, null, null],
      [false, null, null],
    ]);
    expect(fields(true)).toEqual([
      [true, sha256(meta(project, "22222222-bbbb-4bbb-8bbb-bbbbbbbbbbbb")), "22222222-bbbb-4bbb-8bbb-bbbbbbbbbbbb"],
      [true, sha256(leaky), "11111111-aaaa-4aaa-8aaa-aaaaaaaaaaaa"],
      [false, null, null],
    ]);
  });

  test("an environment file with secrets gets its hash only in a confirmed scan, and a refused file never", () => {
    const root = home();
    const env = `PASSWORD=${PASSWORD}\n`;
    write(join(root, "app/.env"), env);
    write(join(root, "app/notes.md"), `token ${TOKEN}\n`);
    const scan = (confirmed: boolean) => runScan({ kind: "files", root: "app", paths: [".env", "notes.md"], allowSecrets: true, confirmed }, root);

    expect(scan(false).carry).toEqual([{ path: ".env", sha256: null, secrets: ["key PASSWORD holds a password or secret"] }]);
    expect(scan(true).carry).toEqual([{ path: ".env", sha256: sha256(env), secrets: ["key PASSWORD holds a password or secret"] }]);
    for (const confirmed of [false, true]) {
      expect(JSON.stringify(scan(confirmed))).not.toContain(sha256(`token ${TOKEN}\n`));
      expect(JSON.stringify(runScan({ kind: "files", root: "app", paths: [".env"], allowSecrets: false, confirmed }, root))).not.toContain(sha256(env));
    }
  });

  test("a session id that is not a UUID is not an id, so a token in its place stays on the machine", () => {
    const root = home();
    const project = join(root, "app");
    write(join(root, ".codex/sessions/odd.jsonl"), meta(project, TOKEN));

    const scan = runScan({ kind: "sessions", paths: [".codex/sessions/odd.jsonl"], project, confirmed: false }, root);

    expect(scan.files.map((file) => [file.session, file.id, file.sha256, file.blocked, file.hits.map((hit) => hit.code)])).toEqual([
      [false, null, null, false, ["github-token"]],
    ]);
    expect(JSON.stringify(scan)).not.toContain(TOKEN);
  });

  test("a key with the form of a token is not printed", () => {
    const root = home();
    write(join(root, "app/config.json"), JSON.stringify({ [`password_${TOKEN}`]: "value", password: "value" }));

    const scan = runScan({ kind: "skill", root: "app" }, root);

    // The key has no word boundary before the token, so only the printed form finds it.
    expect(scan.forbidden.map((hit) => hit.reason)).toEqual([
      "a key holds a password or secret",
      "key password holds a password or secret",
    ]);
    expect(JSON.stringify(scan)).not.toContain(TOKEN);
  });

  test("a file or directory name with the form of a token refuses the file, and the result names only its parent", () => {
    const root = home();
    write(join(root, ".claude/skills/demo/SKILL.md"), "# Demo\n");
    write(join(root, `.claude/skills/demo/notes/${TOKEN}.md`), "notes\n");
    write(join(root, `.claude/skills/demo/${TOKEN}/inner/a.md`), "a\n");
    write(join(root, `app/${TOKEN}.md`), "notes\n");
    write(join(root, `.claude/projects/app/${TOKEN}.jsonl`), `${JSON.stringify({ type: "user" })}\n`);

    const skill = runScan({ kind: "skill", root: ".claude/skills/demo" }, root);
    const files = runScan({ kind: "files", root: "app", paths: [`${TOKEN}.md`], allowSecrets: true, confirmed: true }, root);
    const sessions = runScan({ kind: "sessions", paths: [`.claude/projects/app/${TOKEN}.jsonl`], project: join(root, "app"), confirmed: true }, root);

    expect(skill.files.map((file) => file.path)).toEqual(["SKILL.md"]);
    expect(skill.forbidden).toEqual([
      { path: ".", code: "token-name", reason: "a file or directory in . has a token in its name" },
      { path: "notes", code: "token-name", reason: "a file or directory in notes has a token in its name" },
    ]);
    expect(files).toMatchObject({
      carry: [],
      refused: [{ path: ".", code: "token-name", reason: "a file or directory in . has a token in its name" }],
    });
    expect(sessions.files[0]).toMatchObject({
      sha256: null,
      blocked: true,
      hits: [{ path: ".claude/projects/app", code: "token-name", reason: "a file or directory in .claude/projects/app has a token in its name" }],
    });
    expect(JSON.stringify(skill)).not.toContain(TOKEN);
    expect(JSON.stringify(files)).not.toContain(TOKEN);
    expect(JSON.stringify(sessions.files[0]!.hits)).not.toContain(TOKEN);
  });
});

describe("the scan request", () => {
  test("reads each kind of request, and refuses other text with a usage error", () => {
    expect(parseScanRequest('{"kind":"skill","root":".claude/skills/demo"}')).toEqual({ kind: "skill", root: ".claude/skills/demo" });
    expect(parseScanRequest('{"kind":"files","root":"app","paths":["a"]}')).toEqual({
      kind: "files",
      root: "app",
      paths: ["a"],
      allowSecrets: false,
      confirmed: false,
    });
    expect(parseScanRequest('{"kind":"files","root":"app","paths":["a"],"allowSecrets":true,"confirmed":true}')).toMatchObject({
      allowSecrets: true,
      confirmed: true,
    });
    expect(parseScanRequest('{"kind":"sessions","paths":[],"project":"/home/user/app"}')).toEqual({
      kind: "sessions",
      paths: [],
      project: "/home/user/app",
      confirmed: false,
    });
    for (const text of ["", "null", "[]", '{"kind":"skill"}', '{"kind":"files","root":"app","paths":[1]}', '{"kind":"other","root":"app"}']) {
      let error: unknown = null;
      try {
        parseScanRequest(text);
      } catch (caught) {
        error = caught;
      }
      expect([text, errorInfo(error).code]).toEqual([text, "usage"]);
    }
  });
});

describe("the scan on a box", () => {
  function link(result: Partial<LinkResult> & { stdout?: string }): { link: Pick<Link, "run">; calls: { command: string; input: string }[] } {
    const calls: { command: string; input: string }[] = [];
    return {
      calls,
      link: {
        async run(command, options = {}) {
          calls.push({ command, input: Buffer.from(options.input ?? []).toString() });
          return { ok: true, address: "user@box.example", stdout: "", stderr: "", ...result } as LinkResult;
        },
      },
    };
  }
  const envelope = (fields: object) => JSON.stringify({ schemaVersion: 1, command: "scan", ok: true, result: null, warnings: [], error: null, ...fields });
  async function failure(stdout: string) {
    try {
      await scanOnBox(link({ stdout }).link, "box a", { kind: "skill", root: ".claude/skills/demo" });
    } catch (error) {
      return { ...errorInfo(error) };
    }
    return null;
  }

  test("runs ferry scan of the box install with the request on stdin, and returns its result", async () => {
    const result = { rules: DENY_RULES_VERSION, files: [{ path: "SKILL.md", sha256: sha256("# Demo\n"), executable: false }], forbidden: [], skipped: [] };
    const box = link({ stdout: `${envelope({ result })}\n` });

    const scan = await scanOnBox(box.link, "box a", { kind: "skill", root: ".claude/skills/demo" });

    expect(scan).toEqual(result);
    expect(box.calls).toEqual([
      {
        command:
          'if [ -f "$HOME/.ferry/box.json" ] && [ -x "$HOME/.local/bin/ferry" ]; then "$HOME/.local/bin/ferry" --json scan; else echo MISSING; fi; true',
        input: '{"kind":"skill","root":".claude/skills/demo"}',
      },
    ]);
  });

  test("names ferry install for a box without Ferry, and ferry update for a Ferry without the command", async () => {
    expect(await failure("MISSING\n")).toEqual({
      code: "refused",
      message:
        "Ferry is not installed on box a. Ferry checks the files with the Ferry on the box before it copies them, so that a file with a secret stays on the box.",
      hint: "Run ferry install. A development build of Ferry puts no Ferry on a box. Use a release of Ferry.",
    });
    const old = {
      code: "refused" as const,
      message:
        "The Ferry on box a is too old to check the files there. Ferry checks the files with the Ferry on the box before it copies them, so that a file with a secret stays on the box.",
      hint: "Run ferry update. A development build of Ferry puts no Ferry on a box. Use a release of Ferry.",
    };
    expect(await failure("")).toEqual(old);
    expect(await failure("Usage: ferry [options] [command]\n")).toEqual(old);
    expect(await failure(envelope({ ok: false, error: { code: "usage", message: "too many arguments", hint: null } }))).toEqual(old);
  });

  test("refuses a box whose deny rules are older than the rules of this machine, and a result without the rules version", async () => {
    const result = (rules?: number) => envelope({ result: { ...(rules === undefined ? {} : { rules }), files: [], forbidden: [], skipped: [] } });
    const older = {
      code: "refused" as const,
      message:
        "The Ferry on box a has older deny rules than this machine, so its check can pass a file that this machine refuses. Ferry copied no file.",
      hint: "Run ferry update to put the Ferry of this machine on box a.",
    };

    expect(await failure(result(DENY_RULES_VERSION - 1))).toEqual(older);
    expect(await failure(result())).toEqual(older);
    expect(await failure(envelope({ result: { rules: "1", files: [], forbidden: [], skipped: [] } }))).toEqual(older);
    expect(await failure(result(DENY_RULES_VERSION))).toBeNull();
    expect(await failure(result(DENY_RULES_VERSION + 1))).toBeNull();
  });

  test("each scan result has the rules version of the machine that ran it", () => {
    const root = home();
    write(join(root, "app/AGENTS.md"), "# Agents\n");

    expect(runScan({ kind: "skill", root: "app" }, root).rules).toBe(DENY_RULES_VERSION);
    expect(runScan({ kind: "files", root: "app", paths: ["AGENTS.md"], allowSecrets: false, confirmed: false }, root).rules).toBe(DENY_RULES_VERSION);
    expect(runScan({ kind: "sessions", paths: [], project: join(root, "app"), confirmed: false }, root).rules).toBe(DENY_RULES_VERSION);
    expect(DENY_RULES_VERSION).toBeGreaterThanOrEqual(1);
  });

  test("does not print an error text of the box that has the form of a token", async () => {
    const failed = await failure(envelope({ ok: false, error: { code: "failed", message: `ENOENT: no such file, open '${TOKEN}'`, hint: null } }));

    expect(failed?.message).toBe("Ferry could not check the files on box a. Ferry does not show the error text of the box, because it has the form of a token.");
  });

  test("reports another error of the scan, and a failed box command", async () => {
    const failed = await failure(envelope({ ok: false, error: { code: "failed", message: "ENOENT: no such file or directory", hint: null } }));
    expect(failed?.code).toBe("box-command-failed");
    expect(failed?.message).toBe("Ferry could not check the files on box a: ENOENT: no such file or directory");

    let error: unknown = null;
    try {
      const offline = link({ ok: false, error: { code: "host-offline", origin: "network", message: "box a is offline" } } as Partial<LinkResult>);
      await scanOnBox(offline.link, "box a", { kind: "skill", root: "x" });
    } catch (caught) {
      error = caught;
    }
    expect((error as Error).message).toBe("Ferry could not check the files on box a: box a is offline");
  });
});

describe("the check of copied files", () => {
  test("names each file that is not a regular file with the hash of the scan", () => {
    const root = home();
    write(join(root, "same.md"), "same\n");
    write(join(root, "other.md"), "other\n");
    symlinkSync("same.md", join(root, "link.md"));
    const file = (path: string) => ({ path, sha256: sha256("same\n") });

    expect(changedFiles(root, [file("same.md"), file("other.md"), file("link.md"), file("gone.md")])).toEqual([
      "other.md",
      "link.md",
      "gone.md",
    ]);
  });

  test("a path of a scan result must stay inside its root", () => {
    expect(["SKILL.md", "scripts/run.sh", "a..b"].map(isInside)).toEqual([true, true, true]);
    expect(["", "/etc/passwd", "../x", "a/../../x"].map(isInside)).toEqual([false, false, false, false]);
  });
});
