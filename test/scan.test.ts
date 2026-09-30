import { afterEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  truncateSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { DENY_RULES_VERSION, readLimited } from "../src/manifest.ts";
import { errorInfo } from "../src/output.ts";
import type { Link, LinkResult } from "../src/link.ts";
import {
  isInside,
  MAX_FILE_BYTES,
  packLines,
  packOnBox,
  parseScanRequest,
  recheckPack,
  runPack,
  runScan,
  scanOnBox,
  writePack,
  type PackRequest,
} from "../src/scan.ts";

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
        // Only a pack gives the hash of a file with secrets.
        sha256: null,
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

    const scan = runScan({ kind: "sessions", paths, project }, root);

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

    const scan = runScan({ kind: "sessions", paths: [".claude/projects/app/leaky.jsonl"], project: join(root, "app") }, root);

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

  test("a scan gives no hash and no id for a session with secrets, and no hash for an environment file with secrets", () => {
    const root = home();
    const project = join(root, "app");
    const env = `PASSWORD=${PASSWORD}\n`;
    const leaky = `${meta(project, "11111111-aaaa-4aaa-8aaa-aaaaaaaaaaaa")}${JSON.stringify({ text: TOKEN })}\n`;
    write(join(root, ".codex/sessions/clean.jsonl"), meta(project, "22222222-bbbb-4bbb-8bbb-bbbbbbbbbbbb"));
    write(join(root, ".codex/sessions/leaky.jsonl"), leaky);
    write(join(root, ".claude/projects/app/memory/id_rsa"), "key\n");
    write(join(root, "app/.env"), env);
    write(join(root, "app/notes.md"), `token ${TOKEN}\n`);
    const paths = [".codex/sessions/clean.jsonl", ".codex/sessions/leaky.jsonl", ".claude/projects/app/memory/id_rsa"];

    const sessions = runScan({ kind: "sessions", paths, project }, root);
    const files = runScan({ kind: "files", root: "app", paths: [".env", "notes.md"], allowSecrets: true }, root);

    expect(sessions.files.map((file) => [file.session, file.sha256, file.id])).toEqual([
      [true, sha256(meta(project, "22222222-bbbb-4bbb-8bbb-bbbbbbbbbbbb")), "22222222-bbbb-4bbb-8bbb-bbbbbbbbbbbb"],
      [true, null, null],
      [false, null, null],
    ]);
    expect(files.carry).toEqual([{ path: ".env", sha256: null, secrets: ["key PASSWORD holds a password or secret"] }]);
    for (const body of [leaky, env, `token ${TOKEN}\n`]) expect(JSON.stringify([sessions, files])).not.toContain(sha256(body));
  });

  test("a session id that is not a UUID is not an id, so a token in its place stays on the machine", () => {
    const root = home();
    const project = join(root, "app");
    write(join(root, ".codex/sessions/odd.jsonl"), meta(project, TOKEN));

    const scan = runScan({ kind: "sessions", paths: [".codex/sessions/odd.jsonl"], project }, root);

    expect(scan.files.map((file) => [file.session, file.id, file.sha256, file.blocked, file.hits.map((hit) => hit.code)])).toEqual([
      [false, null, null, false, ["github-token"]],
    ]);
    expect(JSON.stringify(scan)).not.toContain(TOKEN);
  });

  test("a key with the form of a token is not printed", () => {
    const root = home();
    write(join(root, "app/config.json"), JSON.stringify({ [`password_${TOKEN}`]: "value", password: "value" }));

    const scan = runScan({ kind: "skill", root: "app" }, root);

    expect(scan.forbidden.map((hit) => hit.reason)).toEqual([
      "GitHub token in file content",
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
    const files = runScan({ kind: "files", root: "app", paths: [`${TOKEN}.md`], allowSecrets: true }, root);
    const sessions = runScan({ kind: "sessions", paths: [`.claude/projects/app/${TOKEN}.jsonl`], project: join(root, "app") }, root);

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
    expect(parseScanRequest('{"kind":"files","root":"app","paths":["a"]}')).toEqual({ kind: "files", root: "app", paths: ["a"], allowSecrets: false });
    expect(parseScanRequest('{"kind":"sessions","paths":[],"project":"/home/user/app"}')).toEqual({
      kind: "sessions",
      paths: [],
      project: "/home/user/app",
    });
    expect(parseScanRequest('{"pack":true,"kind":"skill","root":".claude/skills/demo"}')).toEqual({ pack: true, kind: "skill", root: ".claude/skills/demo" });
    expect(parseScanRequest('{"pack":true,"kind":"files","root":"app","paths":["a",".env"],"secrets":[".env"]}')).toEqual({
      pack: true,
      kind: "files",
      root: "app",
      paths: ["a", ".env"],
      secrets: [".env"],
    });
    expect(parseScanRequest('{"pack":true,"kind":"sessions","paths":["a"],"secrets":[],"project":"/home/user/app"}')).toEqual({
      pack: true,
      kind: "sessions",
      paths: ["a"],
      secrets: [],
      project: "/home/user/app",
    });
    const invalid = [
      "",
      "null",
      "[]",
      '{"kind":"skill"}',
      '{"kind":"files","root":"app","paths":[1]}',
      '{"kind":"other","root":"app"}',
      // A pack of files needs the list of the paths with secrets that the operator agreed to.
      '{"pack":true,"kind":"files","root":"app","paths":["a"]}',
      '{"pack":true,"kind":"sessions","paths":["a"],"secrets":[1],"project":"/home/user/app"}',
    ];
    for (const text of invalid) {
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

  test("refuses a scan result that does not have the full form of the result for its request", async () => {
    const request = { kind: "files", root: "app", paths: ["AGENTS.md", "notes.md"], allowSecrets: false } as const;
    const carry = { path: "AGENTS.md", sha256: sha256("# Agents\n"), secrets: [] };
    const hit = { path: "notes.md", code: "github-token", reason: "GitHub token in file content" };
    const answer = async (result: object) => {
      try {
        await scanOnBox(link({ stdout: envelope({ result: { rules: DENY_RULES_VERSION, ...result } }) }).link, "box a", request);
      } catch (error) {
        return errorInfo(error).message;
      }
      return null;
    };
    const unreadable = "The Ferry on box a gave an answer that this Ferry cannot read. Ferry took no file from it.";

    expect(await answer({ carry: [carry], refused: [hit] })).toBeNull();
    const results: [string, object][] = [
      ["no list of the refused files", { carry: [carry] }],
      ["a path that the request does not name", { carry: [{ ...carry, path: "other.md" }], refused: [] }],
      ["a path two times", { carry: [carry, carry], refused: [] }],
      ["a hash that is not a SHA-256", { carry: [{ ...carry, sha256: "abc" }], refused: [] }],
      ["secrets that are not a list of texts", { carry: [{ ...carry, secrets: "none" }], refused: [] }],
      ["a hit without a code", { carry: [], refused: [{ path: "notes.md", reason: "x" }] }],
      ["a reason with a token", { carry: [], refused: [{ ...hit, reason: `key ${TOKEN} holds a password or secret` }] }],
      ["a reason with a line end", { carry: [], refused: [{ ...hit, reason: "first\nsecond" }] }],
      ["a path with a token", { carry: [], refused: [{ ...hit, path: `${TOKEN}.md` }] }],
      ["the result of another request", { files: [], forbidden: [], skipped: [] }],
    ];
    for (const [name, result] of results) expect([name, await answer(result)]).toEqual([name, unreadable]);
  });

  test("each scan result has the rules version of the machine that ran it", () => {
    const root = home();
    write(join(root, "app/AGENTS.md"), "# Agents\n");

    expect(runScan({ kind: "skill", root: "app" }, root).rules).toBe(DENY_RULES_VERSION);
    expect(runScan({ kind: "files", root: "app", paths: ["AGENTS.md"], allowSecrets: false }, root).rules).toBe(DENY_RULES_VERSION);
    expect(runScan({ kind: "sessions", paths: [], project: join(root, "app") }, root).rules).toBe(DENY_RULES_VERSION);
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

describe("the pack", () => {
  const meta = (cwd: string, id: string) => `${JSON.stringify({ type: "session_meta", payload: { id, cwd } })}\n`;
  /** A link whose box runs the pack in `root` with this Ferry, as `ferry scan` does. `change` changes its lines. */
  function boxLink(root: string, change: (lines: string[]) => string[] = (lines) => lines): { link: Pick<Link, "run">; received: string[] } {
    const received: string[] = [];
    return {
      received,
      link: {
        async run(_command, options = {}) {
          const request = parseScanRequest(Buffer.from(options.input ?? []).toString());
          const stdout = `${change([...packLines(request as PackRequest, root)]).join("\n")}\n`;
          received.push(stdout);
          return { ok: true, address: "user@box.example", stdout, stderr: "" };
        },
      },
    };
  }
  async function refusal(link: Pick<Link, "run">, request: PackRequest) {
    try {
      await packOnBox(link, "box a", request);
    } catch (error) {
      return errorInfo(error).message;
    }
    return null;
  }
  const UNREADABLE = "The Ferry on box a gave an answer that this Ferry cannot read. Ferry took no file from it.";

  test("reads each file one time and gives the bytes that pass, and a file with secrets only for a path that the operator agreed to", () => {
    const root = home();
    const env = `PASSWORD=${PASSWORD}\n`;
    write(join(root, "app/AGENTS.md"), "# Agents\n", 0o640);
    write(join(root, "app/.env"), env, 0o644);
    write(join(root, "app/.env.local"), env);
    write(join(root, "app/notes.md"), `token ${TOKEN}\n`);
    symlinkSync("AGENTS.md", join(root, "app/link.md"));
    const paths = ["AGENTS.md", ".env", ".env.local", "notes.md", "link.md", "gone.md"];

    const pack = runPack({ kind: "files", root: "app", paths, secrets: [".env", "notes.md"] }, root);

    expect(pack.files.map((file) => ({ ...file, bytes: Buffer.from(file.bytes).toString() }))).toEqual([
      { path: "AGENTS.md", sha256: sha256("# Agents\n"), mode: 0o640, bytes: "# Agents\n", secrets: [], id: null },
      { path: ".env", sha256: sha256(env), mode: 0o644, bytes: env, secrets: ["key PASSWORD holds a password or secret"], id: null },
    ]);
    expect(pack.refused.map((hit) => [hit.path, hit.code])).toEqual([
      [".env.local", "secret-field"],
      ["notes.md", "github-token"],
      ["link.md", "symlink"],
      ["gone.md", "missing"],
    ]);
  });

  test("gives a session with secrets and its id only for a path that the operator agreed to, and a blocked file never", () => {
    const root = home();
    const project = join(root, "app");
    const leaky = (id: string) => `${meta(project, id)}${JSON.stringify({ text: TOKEN })}\n`;
    write(join(root, ".codex/sessions/clean.jsonl"), meta(project, "22222222-bbbb-4bbb-8bbb-bbbbbbbbbbbb"));
    write(join(root, ".codex/sessions/agreed.jsonl"), leaky("11111111-aaaa-4aaa-8aaa-aaaaaaaaaaaa"));
    write(join(root, ".codex/sessions/other.jsonl"), leaky("33333333-cccc-4ccc-8ccc-cccccccccccc"));
    write(join(root, ".claude/projects/app/memory/id_rsa"), "key\n");
    const paths = [".codex/sessions/clean.jsonl", ".codex/sessions/agreed.jsonl", ".codex/sessions/other.jsonl", ".claude/projects/app/memory/id_rsa"];

    const pack = runPack({ kind: "sessions", paths, secrets: [".codex/sessions/agreed.jsonl", ".claude/projects/app/memory/id_rsa"], project }, root);

    expect(pack.files.map((file) => [file.path, file.id, file.secrets])).toEqual([
      [".codex/sessions/clean.jsonl", "22222222-bbbb-4bbb-8bbb-bbbbbbbbbbbb", []],
      [".codex/sessions/agreed.jsonl", "11111111-aaaa-4aaa-8aaa-aaaaaaaaaaaa", ["GitHub token in file content"]],
    ]);
    expect(pack.refused.map((hit) => [hit.path, hit.code])).toEqual([
      [".codex/sessions/other.jsonl", "github-token"],
      [".claude/projects/app/memory/id_rsa", "private-key"],
    ]);
    expect(JSON.stringify(pack.refused)).not.toContain("33333333");
  });

  test("gives no file of a skill when a rule refuses one of its files", () => {
    const root = home();
    write(join(root, ".claude/skills/demo/SKILL.md"), "# Demo\n");
    write(join(root, ".claude/skills/demo/scripts/run.sh"), "#!/bin/sh\n", 0o755);
    write(join(root, ".claude/skills/demo/data.sqlite"), "data\n");

    const clean = runPack({ kind: "skill", root: ".claude/skills/demo" }, root);
    write(join(root, ".claude/skills/demo/.env"), `PASSWORD=${PASSWORD}\n`);
    const refused = runPack({ kind: "skill", root: ".claude/skills/demo" }, root);

    expect(clean.files.map((file) => [file.path, file.mode, Buffer.from(file.bytes).toString()])).toEqual([
      ["SKILL.md", 0o644, "# Demo\n"],
      ["scripts/run.sh", 0o755, "#!/bin/sh\n"],
    ]);
    expect(clean.skipped.map((hit) => [hit.path, hit.code])).toEqual([["data.sqlite", "database"]]);
    expect(refused.files).toEqual([]);
    expect(refused.refused).toEqual([{ path: ".env", code: "dotenv", reason: "environment file" }]);
  });

  test("the lines of a pack have no byte of a refused file, and the operator side reads the files back", async () => {
    const root = home();
    const large = Buffer.alloc(7 * 1024 * 1024 + 5, 0);
    for (let index = 0; index < large.length; index += 4093) large[index] = index % 251;
    write(join(root, "app/AGENTS.md"), "# Agents\n");
    writeFileSync(join(root, "app/large.bin"), large);
    write(join(root, "app/empty.md"), "");
    write(join(root, "app/notes.md"), `token ${TOKEN}\n`);
    write(join(root, "app/.env"), `PASSWORD=${PASSWORD}\n`);
    const request: PackRequest = { kind: "files", root: "app", paths: ["AGENTS.md", "large.bin", "empty.md", "notes.md", ".env"], secrets: [] };
    const box = boxLink(root);

    const pack = await packOnBox(box.link, "box a", request);

    expect(pack.files.map((file) => [file.path, file.bytes.length])).toEqual([
      ["AGENTS.md", 9],
      ["large.bin", large.length],
      ["empty.md", 0],
    ]);
    expect(Buffer.from(pack.files[1]!.bytes).equals(large)).toBe(true);
    expect(pack.refused.map((hit) => [hit.path, hit.code])).toEqual([
      ["notes.md", "github-token"],
      [".env", "secret-field"],
    ]);
    const lines = box.received.join("").split("\n").filter(Boolean);
    expect(JSON.parse(lines[0]!)).toEqual({ pack: 1, rules: DENY_RULES_VERSION });
    expect(JSON.parse(lines.at(-1)!)).toEqual({ end: 3 });
    // The large file is in three data lines, so one line has 3 MiB of the file at most.
    expect(lines.filter((line) => line.startsWith('{"data"'))).toHaveLength(4);
    const decoded = lines.map((line) => Buffer.from(String(JSON.parse(line).data ?? ""), "base64").toString("latin1")).join("\n");
    for (const secret of [TOKEN, PASSWORD, sha256(`token ${TOKEN}\n`), sha256(`PASSWORD=${PASSWORD}\n`)]) {
      expect(box.received.join("").includes(secret) || decoded.includes(secret)).toBe(false);
    }
  });

  test("refuses a pack that is not in the form of the request: an unasked file, a path outside the root, other bytes, or a broken line", async () => {
    const root = home();
    write(join(root, "app/AGENTS.md"), "# Agents\n");
    write(join(root, "app/notes.md"), "notes\n");
    write(join(root, "app/.env"), `PASSWORD=${PASSWORD}\n`);
    const request: PackRequest = { kind: "files", root: "app", paths: ["AGENTS.md", "notes.md"], secrets: [] };
    const file = (line: string, fields: object) => JSON.stringify({ file: { ...JSON.parse(line).file, ...fields } });
    const changes: [string, (lines: string[]) => string[]][] = [
      ["a file that the request does not name", (lines) => lines.map((line, index) => (index === 1 ? file(line, { path: "other.md" }) : line))],
      ["a path that leaves the root", (lines) => lines.map((line, index) => (index === 1 ? file(line, { path: "../AGENTS.md" }) : line))],
      ["an absolute path", (lines) => lines.map((line, index) => (index === 1 ? file(line, { path: "/tmp/AGENTS.md" }) : line))],
      ["a file two times", (lines) => [lines[0]!, lines[1]!, lines[2]!, lines[1]!, lines[2]!, JSON.stringify({ end: 2 })]],
      ["bytes with another hash", (lines) => lines.map((line, index) => (index === 2 ? JSON.stringify({ data: Buffer.from("# Other!\n").toString("base64") }) : line))],
      ["a size that the bytes do not have", (lines) => lines.map((line, index) => (index === 1 ? file(line, { size: 3 }) : line))],
      ["no bytes", (lines) => lines.filter((_line, index) => index !== 2)],
      ["a mode with other bits", (lines) => lines.map((line, index) => (index === 1 ? file(line, { mode: 0o4755 }) : line))],
      ["secrets for a path that the operator did not agree to", (lines) => lines.map((line, index) => (index === 1 ? file(line, { secrets: ["key PASSWORD holds a password or secret"] }) : line))],
      ["an id that is not a UUID", (lines) => lines.map((line, index) => (index === 1 ? file(line, { id: TOKEN }) : line))],
      ["a hit with a token in its reason", (lines) => [...lines.slice(0, -1), JSON.stringify({ refused: { path: "x", code: "secret-field", reason: `key ${TOKEN} holds` } }), lines.at(-1)!]],
      ["a line that is not JSON", (lines) => [...lines.slice(0, -1), "tar: removing leading /", lines.at(-1)!]],
      ["a line of another kind", (lines) => [...lines.slice(0, -1), JSON.stringify({ link: { path: "a", target: "/etc/passwd" } }), lines.at(-1)!]],
      ["no last line", (lines) => lines.slice(0, -1)],
      ["a wrong number of files", (lines) => [...lines.slice(0, -1), JSON.stringify({ end: 1 })]],
      ["a line after the last line", (lines) => [...lines, JSON.stringify({ refused: { path: "x", code: "missing", reason: "gone" } })]],
    ];

    expect(await refusal(boxLink(root).link, request)).toBeNull();
    for (const [name, change] of changes) expect([name, await refusal(boxLink(root, change).link, request)]).toEqual([name, UNREADABLE]);
  });

  test("refuses the pack of a box without Ferry, with a Ferry before the pack, and with older rules", async () => {
    const request: PackRequest = { kind: "skill", root: ".claude/skills/demo" };
    const answer = (stdout: string): Pick<Link, "run"> => ({ run: async () => ({ ok: true, address: "user@box.example", stdout, stderr: "" }) });
    const scan = (rules: number) => JSON.stringify({ schemaVersion: 1, command: "scan", ok: true, result: { rules, files: [], forbidden: [], skipped: [] }, warnings: [], error: null });

    expect(await refusal(answer("MISSING\n"), request)).toStartWith("Ferry is not installed on box a.");
    expect(await refusal(answer("Usage: ferry [options] [command]\n"), request)).toStartWith("The Ferry on box a is too old to check the files there.");
    // A Ferry with the scan and without the pack answers with the result of a scan.
    expect(await refusal(answer(`${scan(DENY_RULES_VERSION - 1)}\n`), request)).toStartWith("The Ferry on box a has older deny rules than this machine");
    expect(await refusal(answer(`${scan(DENY_RULES_VERSION)}\n`), request)).toStartWith("The Ferry on box a is too old to check the files there.");
    expect(await refusal(answer(`${JSON.stringify({ pack: 1, rules: DENY_RULES_VERSION - 1 })}\n${JSON.stringify({ end: 0 })}\n`), request)).toStartWith(
      "The Ferry on box a has older deny rules than this machine",
    );
    expect(await refusal(answer(`${JSON.stringify({ pack: 1 })}\n${JSON.stringify({ end: 0 })}\n`), request)).toStartWith(
      "The Ferry on box a has older deny rules than this machine",
    );
  });

  test("writes the files of a pack with their modes, and the rules of this machine find a file that the box must not give", () => {
    const root = home();
    const stage = join(root, "stage");
    const project = join(root, "app");
    const env = `PASSWORD=${PASSWORD}\n`;
    const file = (path: string, body: string, secrets: string[] = [], mode = 0o644) => ({ path, sha256: sha256(body), mode, bytes: Buffer.from(body), secrets, id: null });
    const files = [
      file("AGENTS.md", "# Agents\n", [], 0o600),
      file("docs/notes.md", `token ${TOKEN}\n`),
      file(".env", env, ["key PASSWORD holds a password or secret"]),
      file(".env.local", env),
      file("id_rsa.md", "-----BEGIN OPENSSH PRIVATE KEY-----\n", ["private key"]),
    ];
    const sessions = [
      file("clean.jsonl", `${JSON.stringify({ type: "user", message: "hello" })}\n`),
      file("leaky.jsonl", `${JSON.stringify({ text: TOKEN })}\n`),
      file("agreed.jsonl", `${JSON.stringify({ text: TOKEN })}\n`, ["GitHub token in file content"]),
    ];

    writePack(stage, files);
    writePack(join(root, "sessions"), sessions);

    expect(readFileSync(join(stage, "docs/notes.md"), "utf8")).toBe(`token ${TOKEN}\n`);
    expect(statSync(join(stage, "AGENTS.md")).mode & 0o777).toBe(0o600);
    expect(recheckPack(stage, files).map((hit) => [hit.path, hit.code])).toEqual([
      ["docs/notes.md", "github-token"],
      [".env.local", "secret-field"],
      ["id_rsa.md", "private-key"],
    ]);
    expect(recheckPack(join(root, "sessions"), sessions, project).map((hit) => [hit.path, hit.code])).toEqual([["leaky.jsonl", "github-token"]]);
  });
});

describe("the size limit of a checked file", () => {
  const LIMIT = 128 * 1024 * 1024;
  /** A file of `size` bytes that uses no disk space. */
  function sparse(path: string, size: number): void {
    write(path, "");
    truncateSync(path, size);
  }

  test("the limit is 128 MiB", () => {
    expect(MAX_FILE_BYTES).toBe(LIMIT);
  });

  test("a scan and a pack do not read a larger file: it stays on the machine with the reason too large for Ferry to check", () => {
    const root = home();
    const project = join(root, "app");
    write(join(root, "app/AGENTS.md"), "# Agents\n");
    sparse(join(root, "app/model.bin"), LIMIT + 1);
    sparse(join(root, "app/limit.bin"), LIMIT);
    sparse(join(root, ".claude/projects/app/large.jsonl"), LIMIT + 1);
    write(join(root, ".claude/skills/demo/SKILL.md"), "# Demo\n");
    sparse(join(root, ".claude/skills/demo/data.bin"), LIMIT + 1);
    const hit = (path: string) => ({ path, code: "too-large", reason: "too large for Ferry to check" });

    const files = runScan({ kind: "files", root: "app", paths: ["AGENTS.md", "model.bin"], allowSecrets: true }, root);
    const sessions = runScan({ kind: "sessions", paths: [".claude/projects/app/large.jsonl"], project }, root);
    const skill = runScan({ kind: "skill", root: ".claude/skills/demo" }, root);
    const packedFiles = runPack({ kind: "files", root: "app", paths: ["AGENTS.md", "model.bin"], secrets: ["model.bin"] }, root);
    const packedSessions = runPack({ kind: "sessions", paths: [".claude/projects/app/large.jsonl"], secrets: [".claude/projects/app/large.jsonl"], project }, root);
    const packedSkill = runPack({ kind: "skill", root: ".claude/skills/demo" }, root);

    expect(files.carry.map((file) => file.path)).toEqual(["AGENTS.md"]);
    expect(files.refused).toEqual([hit("model.bin")]);
    expect(sessions.files).toEqual([{ path: ".claude/projects/app/large.jsonl", session: false, sha256: null, id: null, hits: [hit(".claude/projects/app/large.jsonl")], blocked: true }]);
    // A large file of a skill is left out, as a file that a skip rule covers. The other files of the skill pass.
    expect(skill.files.map((file) => file.path)).toEqual(["SKILL.md"]);
    expect(skill.forbidden).toEqual([]);
    expect(skill.skipped).toEqual([hit("data.bin")]);
    expect(packedFiles.files.map((file) => file.path)).toEqual(["AGENTS.md"]);
    expect(packedFiles.refused).toEqual([hit("model.bin")]);
    expect(packedSessions.files).toEqual([]);
    expect(packedSessions.refused).toEqual([hit(".claude/projects/app/large.jsonl")]);
    expect(packedSkill.files.map((file) => file.path)).toEqual(["SKILL.md"]);
    expect(packedSkill.skipped).toEqual([hit("data.bin")]);
    // A file of exactly the limit is read.
    expect(runScan({ kind: "files", root: "app", paths: ["limit.bin"], allowSecrets: false }, root).carry.map((file) => file.path)).toEqual(["limit.bin"]);
  });

  test("a read stops at the limit: a file that grows past it after the size check has no bytes", () => {
    const root = home();
    write(join(root, "small.md"), "12345");
    write(join(root, "grown.md"), "123456");

    expect(readLimited(join(root, "small.md"), 5)?.toString()).toBe("12345");
    expect(readLimited(join(root, "grown.md"), 5)).toBeNull();
    expect(readLimited(join(root, "small.md"), 0)).toBeNull();
  });

  // The files under /proc have the size 0 and give bytes when a process reads them, as a file that grows after the size check.
  test.skipIf(!existsSync("/proc/self/status"))("a file that grows past the limit after the size check counts as changed and is not sent", () => {
    const changed = (path: string) => ({ path, code: "changed", reason: "file changed during the check" });

    const files = runPack({ kind: "files", root: "self", paths: ["status"], secrets: [] }, "/proc", 16);
    const scanned = runScan({ kind: "files", root: "self", paths: ["status"], allowSecrets: false }, "/proc", 16);
    const sessions = runPack({ kind: "sessions", paths: ["self/status"], secrets: [], project: "/home/user/app" }, "/proc", 16);
    const whole = runPack({ kind: "files", root: "self", paths: ["status"], secrets: [] }, "/proc");

    expect(files).toEqual({ files: [], refused: [changed("status")], skipped: [] });
    expect(scanned.carry).toEqual([]);
    expect(scanned.refused).toEqual([changed("status")]);
    expect(sessions).toEqual({ files: [], refused: [changed("self/status")], skipped: [] });
    expect(whole.files.map((file) => file.path)).toEqual(["status"]);
  });
});

describe("a path of a result", () => {
  test("a path of a scan result must stay inside its root", () => {
    expect(["SKILL.md", "scripts/run.sh", "a..b"].map(isInside)).toEqual([true, true, true]);
    expect(["", "/etc/passwd", "../x", "a/../../x"].map(isInside)).toEqual([false, false, false, false]);
  });
});
