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

    const scan = runScan({ kind: "files", root: "Developer/app", paths, allowSecrets: false }, root);

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

    const scan = runScan({ kind: "files", root: "Developer/app", paths: [".env.local", "notes.md"], allowSecrets: true }, root);

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
      ".codex/sessions/a.jsonl": meta(project, "11111111-aaaa"),
      ".codex/sessions/b.jsonl": `${meta(project, "22222222-bbbb")}${JSON.stringify(call)}\n`,
      ".codex/sessions/other.jsonl": meta(join(root, "Developer/other"), "33333333-cccc"),
      ".codex/sessions/odd.jsonl": meta(project, `not an id ${PASSWORD}`),
    };
    for (const [path, body] of Object.entries(files)) write(join(root, path), body);
    const paths = [...Object.keys(files), ".codex/sessions/gone.jsonl"];

    const scan = runScan({ kind: "sessions", paths, project }, root);

    expect(scan.files.map((file) => [file.path, file.id, file.blocked, file.hits.map((hit) => hit.code)])).toEqual([
      [".claude/projects/app/clean.jsonl", null, false, []],
      [".claude/projects/app/leaky.jsonl", null, false, ["github-token"]],
      [".claude/projects/app/memory/id_rsa", null, true, ["private-key"]],
      [".codex/sessions/a.jsonl", "11111111-aaaa", false, []],
      [".codex/sessions/b.jsonl", "22222222-bbbb", false, ["secret-field"]],
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

describe("the scan request", () => {
  test("reads each kind of request, and refuses other text with a usage error", () => {
    expect(parseScanRequest('{"kind":"skill","root":".claude/skills/demo"}')).toEqual({ kind: "skill", root: ".claude/skills/demo" });
    expect(parseScanRequest('{"kind":"files","root":"app","paths":["a"]}')).toEqual({ kind: "files", root: "app", paths: ["a"], allowSecrets: false });
    expect(parseScanRequest('{"kind":"sessions","paths":[],"project":"/home/user/app"}')).toEqual({
      kind: "sessions",
      paths: [],
      project: "/home/user/app",
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
    expect(runScan({ kind: "files", root: "app", paths: ["AGENTS.md"], allowSecrets: false }, root).rules).toBe(DENY_RULES_VERSION);
    expect(runScan({ kind: "sessions", paths: [], project: join(root, "app") }, root).rules).toBe(DENY_RULES_VERSION);
    expect(DENY_RULES_VERSION).toBeGreaterThanOrEqual(1);
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
