import { afterEach, describe, expect, test } from "bun:test";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
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
import { listBoxSkills, runAdoptFromBox, type AdoptFromBoxDependencies, type AdoptFromBoxInput } from "../src/adopt-box.ts";
import type { Link, LinkResult, RunOptions } from "../src/link.ts";
import { readSeed } from "../src/manifest.ts";
import { errorInfo } from "../src/output.ts";
import type { HarnessDescriptor } from "../src/registry/types.ts";
import { installBoxFerry } from "./box-ferry-shim.ts";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const HARNESSES: readonly HarnessDescriptor[] = [
  { id: "agents", name: "Agents", skillRoot: ".agents/skills" },
  { id: "claude", name: "Claude", skillRoot: ".claude/skills" },
  { id: "codex", name: "Codex", skillRoot: ".codex/skills", ownSkills: false },
];

const GIT_ENV = {
  GIT_AUTHOR_NAME: "Test",
  GIT_AUTHOR_EMAIL: "test@example.com",
  GIT_COMMITTER_NAME: "Test",
  GIT_COMMITTER_EMAIL: "test@example.com",
};

function git(cwd: string, ...args: string[]): void {
  const result = Bun.spawnSync(["git", "-c", "commit.gpgsign=false", "-c", "init.defaultBranch=main", ...args], {
    cwd,
    env: { ...process.env, ...GIT_ENV },
  });
  if (result.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${result.stderr.toString()}`);
}

function write(path: string, body: string, mode?: number): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, body);
  if (mode !== undefined) chmodSync(path, mode);
}

/**
 * An operator home and a box home. The box checkout tracks the skill `tracked`,
 * and the box Claude root links it.
 */
function world() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "ferry-adopt-box-test-")));
  roots.push(root);
  const operator = join(root, "operator");
  const box = join(root, "box");
  mkdirSync(operator);
  const checkout = join(box, ".ferry", "store");
  write(join(checkout, "skills", "tracked", "SKILL.md"), "# Tracked\n");
  git(checkout, "init", "-q");
  git(checkout, "add", ".");
  git(checkout, "commit", "-q", "-m", "snapshot");
  mkdirSync(join(box, ".claude", "skills"), { recursive: true });
  symlinkSync(join(checkout, "skills", "tracked"), join(box, ".claude", "skills", "tracked"));
  installBoxFerry(box);
  const commands: { command: string; options: RunOptions }[] = [];
  const received: string[] = [];
  const before = readdirSync(tmpdir()).filter((name) => name.startsWith("ferry-adopt-"));
  return { root, operator, box, checkout, commands, received, before, link: boxLink(box, commands, received) };
}

/**
 * Runs each box command in `sh` with the box home, as OpenSSH would on the box.
 * `received` gets the stdout and the stderr of each command: all that this machine gets from the box.
 */
function boxLink(home: string, commands: { command: string; options: RunOptions }[], received: string[] = []): Pick<Link, "run"> {
  return {
    async run(command, options = {}) {
      commands.push({ command, options });
      const child = Bun.spawnSync(["sh", "-c", command], {
        stdin: options.input ?? "ignore",
        env: { ...process.env, HOME: home },
      });
      const stdout = child.stdout.toString();
      const stderr = child.stderr.toString();
      received.push(stdout, stderr);
      const result: LinkResult =
        child.exitCode === 0
          ? { ok: true, address: "user@box.example", stdout, stderr }
          : { ok: false, error: { code: "command-failed", origin: "box", message: stderr.trim() || "failed" } };
      return result;
    },
  };
}

type World = ReturnType<typeof world>;

/** True when `text` reached this machine, as plain text or as base64, in a line of a pack too. */
function crossed(w: World, text: string): boolean {
  return w.received.some((output) => output.includes(text) || output.split(/[\n"]/).some((part) => Buffer.from(part, "base64").includes(text)));
}

/** True for a command that tells the box to pack files: the only command that gives file content. */
function isPack(options: RunOptions): boolean {
  return Buffer.from(options.input ?? []).includes('"pack":true');
}

async function adopt(w: World, input: Partial<AdoptFromBoxInput> & { name: string }, overrides: Partial<AdoptFromBoxDependencies> = {}) {
  const lines: string[] = [];
  const questions: string[] = [];
  let error: unknown = null;
  let value = null;
  try {
    value = await runAdoptFromBox(
      { box: "a", yes: true, ...input },
      {
        readConfig: () => ({ boxes: [{ name: "a", host: { transport: "ssh", destination: "user@box.example" } }] }),
        createLink: () => w.link,
        home: w.operator,
        harnesses: HARNESSES,
        now: () => new Date("2026-09-29T10:11:12.345Z"),
        writeLine: (line) => lines.push(line),
        interactive: false,
        confirm: async (question) => {
          questions.push(question);
          return true;
        },
        ...overrides,
      },
    );
  } catch (caught) {
    error = caught;
  }
  return { value, error, lines, questions };
}

describe("box-only skills", () => {
  test("lists real directories, outside links, and untracked checkout skills, and skips Ferry's links", async () => {
    const w = world();
    write(join(w.box, ".claude", "skills", "draft", "SKILL.md"), "# Draft\n");
    mkdirSync(join(w.box, ".agents", "skills"), { recursive: true });
    symlinkSync("../../.claude/skills/draft", join(w.box, ".agents", "skills", "draft"));
    write(join(w.box, "notes", "outside", "SKILL.md"), "# Outside\n");
    symlinkSync(join(w.box, "notes", "outside"), join(w.box, ".claude", "skills", "outside"));
    write(join(w.checkout, "skills", "untracked", "SKILL.md"), "# Untracked\n");
    symlinkSync(join(w.checkout, "skills", "untracked"), join(w.box, ".claude", "skills", "untracked"));
    write(join(w.box, ".claude", "skills", "README.md"), "not a skill\n");
    write(join(w.box, ".codex", "skills", ".system", "SKILL.md"), "# Codex\n");

    expect(await listBoxSkills(w.link, HARNESSES)).toEqual([
      { name: "draft", paths: ["~/.agents/skills/draft", "~/.claude/skills/draft"] },
      { name: "outside", paths: ["~/.claude/skills/outside"] },
      { name: "untracked", paths: ["~/.ferry/store/skills/untracked"] },
    ]);
  });

  test("a box without a checkout lists each skill directory", async () => {
    const w = world();
    rmSync(w.checkout, { recursive: true });
    rmSync(join(w.box, ".claude", "skills", "tracked"));
    write(join(w.box, ".claude", "skills", "draft", "SKILL.md"), "# Draft\n");

    expect(await listBoxSkills(w.link, HARNESSES)).toEqual([{ name: "draft", paths: ["~/.claude/skills/draft"] }]);
  });
});

describe("ferry adopt --from-box", () => {
  test("copies a new skill to the same root, keeps the executable bit, and moves the box copy aside", async () => {
    const w = world();
    write(join(w.box, ".claude", "skills", "draft", "SKILL.md"), "# Draft\n");
    write(join(w.box, ".claude", "skills", "draft", "scripts", "run.sh"), "#!/bin/sh\necho run\n", 0o755);
    write(join(w.box, ".claude", "skills", "draft", "node_modules", "dep.js"), "dep\n");

    const { value, error, lines } = await adopt(w, { name: "draft" });

    expect(error).toBeNull();
    const local = join(w.operator, ".claude", "skills", "draft");
    expect(readFileSync(join(local, "SKILL.md"), "utf8")).toBe("# Draft\n");
    expect(statSync(join(local, "scripts", "run.sh")).mode & 0o111).not.toBe(0);
    expect(statSync(join(local, "SKILL.md")).mode & 0o111).toBe(0);
    expect(existsSync(join(local, "node_modules"))).toBe(false);
    expect(existsSync(join(w.box, ".claude", "skills", "draft"))).toBe(false);
    expect(existsSync(join(w.box, ".ferry", "backups", "20260929T101112Z", "adopt", ".claude", "skills", "draft", "SKILL.md"))).toBe(true);
    expect(value).toEqual({
      box: "a",
      name: "draft",
      source: "~/.claude/skills/draft",
      destination: "~/.claude/skills/draft",
      replaces: false,
      files: [
        { path: "SKILL.md", executable: false },
        { path: "scripts/run.sh", executable: true },
      ],
      skipped: [{ path: "node_modules", code: "cache", reason: "cache or build output" }],
      diff: null,
      adopted: true,
      boxBackup: "~/.ferry/backups/20260929T101112Z/adopt",
    });
    expect(lines).toEqual([
      "New skill draft from ~/.claude/skills/draft on box a:",
      "  + SKILL.md",
      "  + scripts/run.sh (executable)",
      "Skip: node_modules (cache or build output)",
      "Adopted draft at ~/.claude/skills/draft. Run ferry sync to publish it to all boxes.",
    ]);
    // The next sync publishes it: the seed of this machine has the skill with its executable bit.
    const seed = readSeed(w.operator, HARNESSES, { storeUpdates: true });
    expect(seed.ok && seed.skills.find((skill) => skill.name === "draft")?.files.map((file) => [file.path, file.executable])).toEqual([
      ["SKILL.md", false],
      ["scripts/run.sh", true],
    ]);
  });

  test("a skill that fails a deny rule does not reach this machine, and the box keeps it", async () => {
    const w = world();
    write(join(w.box, ".claude", "skills", "leaky", "SKILL.md"), "# Leaky\n");
    write(join(w.box, ".claude", "skills", "leaky", "notes.md"), `token ghp_${"a".repeat(36)}\n`);

    const { error } = await adopt(w, { name: "leaky" });

    expect(errorInfo(error).code).toBe("deny-rule-match");
    expect((error as Error).message).toContain("github-token GitHub token in file content: notes.md");
    expect((error as Error).message).not.toContain("ghp_");
    expect(existsSync(join(w.operator, ".claude", "skills", "leaky"))).toBe(false);
    expect(existsSync(join(w.box, ".claude", "skills", "leaky", "notes.md"))).toBe(true);
    expect(crossed(w, `ghp_${"a".repeat(36)}`)).toBe(false);
  });

  test("a skill with a .env file stays on the box: Ferry copies no file, and no byte of it reaches this machine", async () => {
    const w = world();
    write(join(w.box, ".agents", "skills", "demo", "SKILL.md"), "# Demo\nbox-only-body\n");
    write(join(w.box, ".agents", "skills", "demo", ".env"), "PASSWORD=box-only-password\n");

    const { error } = await adopt(w, { name: "demo" });

    expect(errorInfo(error).code).toBe("deny-rule-match");
    expect((error as Error).message).toBe(
      "Ferry refused demo from box a, and copied nothing to this machine: dotenv environment file: .env",
    );
    expect(w.commands.some(({ command }) => command.includes("tar "))).toBe(false);
    expect(w.received.some((output) => output.includes('"data"'))).toBe(false);
    expect(crossed(w, "box-only-password")).toBe(false);
    expect(crossed(w, "box-only-body")).toBe(false);
    expect(existsSync(join(w.operator, ".agents"))).toBe(false);
    expect(existsSync(join(w.box, ".agents", "skills", "demo", ".env"))).toBe(true);
  });

  test("copies only the files that pass: a file that a skip rule leaves out stays on the box", async () => {
    const w = world();
    write(join(w.box, ".claude", "skills", "draft", "SKILL.md"), "# Draft\n");
    write(join(w.box, ".claude", "skills", "draft", "data.sqlite"), "box-only-database\n");
    write(join(w.box, ".claude", "skills", "draft", "node_modules", "pkg", "index.js"), "box-only-module\n");
    symlinkSync("SKILL.md", join(w.box, ".claude", "skills", "draft", "link.md"));

    const { value, error, lines } = await adopt(w, { name: "draft" });

    expect(error).toBeNull();
    expect(value?.files.map((file) => file.path)).toEqual(["SKILL.md", "link.md"]);
    expect(value?.skipped.map((entry) => [entry.path, entry.code])).toEqual([
      ["data.sqlite", "database"],
      ["node_modules", "cache"],
    ]);
    expect(lines).toContain("Skip: data.sqlite (sqlite or other database file)");
    expect(crossed(w, "box-only-database")).toBe(false);
    expect(crossed(w, "box-only-module")).toBe(false);
    const local = join(w.operator, ".claude", "skills", "draft");
    expect(lstatSync(join(local, "link.md")).isFile()).toBe(true);
    expect(readFileSync(join(local, "link.md"), "utf8")).toBe("# Draft\n");
    expect(existsSync(join(local, "data.sqlite"))).toBe(false);
  });

  test("a skill directory or a file with a token in its name stays on the box, and the name does not reach this machine", async () => {
    const token = "gh" + "p_" + "b".repeat(36);
    const w = world();
    write(join(w.box, ".claude", "skills", `notes-${token}`, "SKILL.md"), "# Named\n");
    write(join(w.box, ".claude", "skills", "draft", "SKILL.md"), "# Draft\n");
    write(join(w.box, ".claude", "skills", "draft", "keys", `${token}.md`), "notes\n");

    expect(await listBoxSkills(w.link, HARNESSES)).toEqual([{ name: "draft", paths: ["~/.claude/skills/draft"] }]);
    const { error } = await adopt(w, { name: "draft" });

    expect(errorInfo(error).code).toBe("deny-rule-match");
    expect((error as Error).message).toBe(
      "Ferry refused draft from box a, and copied nothing to this machine: token-name a file or directory in keys has a token in its name: keys",
    );
    expect(crossed(w, token)).toBe(false);
    expect(w.received.some((output) => output.includes(Buffer.from(token).toString("hex")))).toBe(false);
  });

  test.skipIf(process.getuid?.() === 0)("a file of mode 000 with a token in its name does not reach this machine in an error text", async () => {
    const token = "gh" + "p_" + "b".repeat(36);
    const w = world();
    write(join(w.box, ".claude", "skills", "draft", "SKILL.md"), "# Draft\n");
    write(join(w.box, ".claude", "skills", "draft", `${token}.txt`), "notes\n", 0o000);
    write(join(w.box, ".claude", "skills", "locked", "SKILL.md"), "# Locked\n");
    write(join(w.box, ".claude", "skills", "locked", "notes.md"), "notes\n", 0o000);

    const named = await adopt(w, { name: "draft" });
    const locked = await adopt(w, { name: "locked" });

    expect(errorInfo(named.error).code).toBe("deny-rule-match");
    expect((named.error as Error).message).toBe(
      "Ferry refused draft from box a, and copied nothing to this machine: token-name a file or directory in . has a token in its name: .",
    );
    expect((locked.error as Error).message).toBe(
      "Ferry refused locked from box a, and copied nothing to this machine: unreadable Ferry cannot read the file: notes.md",
    );
    expect(crossed(w, token)).toBe(false);
    expect(w.received.join("\n")).not.toContain("EACCES");
    expect(existsSync(join(w.operator, ".claude"))).toBe(false);
  });

  test.skipIf(process.getuid?.() === 0)("the list of the box-only skills sends no error text of the box", async () => {
    const w = world();
    write(join(w.box, ".agents", "skills", "draft", "SKILL.md"), "# Draft\n");
    chmodSync(join(w.box, ".agents", "skills"), 0o000);
    try {
      let error: unknown = null;
      try {
        await listBoxSkills(w.link, HARNESSES);
      } catch (caught) {
        error = caught;
      }

      expect((error as Error).message).toBe("box/command-failed: the box could not list its skill roots");
      expect(w.received.join("")).not.toContain("Permission denied");
    } finally {
      chmodSync(join(w.box, ".agents", "skills"), 0o755);
    }
  });

  test("leaves out a file of more than 128 MiB and tells the operator to copy it by hand", async () => {
    const w = world();
    write(join(w.box, ".claude", "skills", "draft", "SKILL.md"), "# Draft\n");
    write(join(w.box, ".claude", "skills", "draft", "model.bin"), "");
    truncateSync(join(w.box, ".claude", "skills", "draft", "model.bin"), 128 * 1024 * 1024 + 1);

    const { value, error, lines } = await adopt(w, { name: "draft" });

    expect(error).toBeNull();
    expect(value?.files.map((file) => file.path)).toEqual(["SKILL.md"]);
    expect(value?.skipped).toEqual([{ path: "model.bin", code: "too-large", reason: "too large for Ferry to check" }]);
    expect(lines).toContain("Skip: model.bin (too large for Ferry to check)");
    expect(lines).toContain("Ferry does not read a file of more than 128 MiB. Copy model.bin from box a by hand.");
    expect(existsSync(join(w.operator, ".claude", "skills", "draft", "model.bin"))).toBe(false);
  });

  test("the box reads each file one time: a file that gets a secret before the box reads it stays on the box", async () => {
    const w = world();
    const skill = join(w.box, ".claude", "skills", "draft");
    write(join(skill, "SKILL.md"), "# Draft\nbox-only-body\n");
    write(join(skill, "notes.md"), "notes\n");
    const racing: Pick<Link, "run"> = {
      run: (command, options = {}) => {
        // The skill list shows a clean skill. The file changes before the one command that reads and checks the files.
        if (isPack(options)) writeFileSync(join(skill, "notes.md"), `token ghp_${"a".repeat(36)}\n`);
        return w.link.run(command, options);
      },
    };

    const { error } = await adopt(w, { name: "draft" }, { createLink: () => racing });

    expect(errorInfo(error).code).toBe("deny-rule-match");
    expect((error as Error).message).toBe(
      "Ferry refused draft from box a, and copied nothing to this machine: github-token GitHub token in file content: notes.md",
    );
    expect(w.commands.filter(({ options }) => isPack(options))).toHaveLength(1);
    expect(w.commands.some(({ command }) => command.includes("tar "))).toBe(false);
    expect(crossed(w, `ghp_${"a".repeat(36)}`)).toBe(false);
    expect(crossed(w, "box-only-body")).toBe(false);
    expect(existsSync(join(w.operator, ".claude"))).toBe(false);
    expect(existsSync(skill)).toBe(true);
  });

  test("applies the rules of this machine to the files of a box that gives a file with a secret, and writes nothing", async () => {
    const w = world();
    const token = `ghp_${"a".repeat(36)}`;
    write(join(w.box, ".claude", "skills", "draft", "SKILL.md"), "# Draft\n");
    const body = Buffer.from(`token ${token}\n`);
    const file = { path: "notes.md", sha256: new Bun.CryptoHasher("sha256").update(body).digest("hex"), size: body.length, mode: 0o644, secrets: [], id: null };
    // A Ferry that an attacker controls: it says that the file passes.
    const lines = [{ pack: 1, rules: 1_000_000 }, { file }, { data: body.toString("base64") }, { end: 1 }];
    installBoxFerry(w.box, `cat >/dev/null; printf '%s\\n' ${lines.map((line) => `'${JSON.stringify(line)}'`).join(" ")}`);

    const { error } = await adopt(w, { name: "draft" });

    expect(errorInfo(error).code).toBe("deny-rule-match");
    expect((error as Error).message).toBe(
      "Ferry refused draft from box a after the copy, and removed the copy from this machine: github-token GitHub token in file content: notes.md",
    );
    expect(existsSync(join(w.operator, ".claude"))).toBe(false);
    expect(readdirSync(tmpdir()).filter((name) => name.startsWith("ferry-adopt-"))).toEqual(w.before);
  });

  test("refuses when the box has no Ferry, a Ferry without the scan command, or a Ferry with older rules, before it copies a file", async () => {
    const usage = { schemaVersion: 1, command: "", ok: false, result: null, warnings: [], error: { code: "usage", message: "too many arguments", hint: null } };
    const cases: [string | null, string, string][] = [
      [null, "Ferry is not installed on box a.", "Run ferry install."],
      [`echo "error: unknown command 'scan'" >&2; exit 1`, "The Ferry on box a is too old to check the files there.", "Run ferry update."],
      [`echo '${JSON.stringify(usage)}'; exit 1`, "The Ferry on box a is too old to check the files there.", "Run ferry update."],
      ["echo 'Usage: ferry [options] [command]'", "The Ferry on box a is too old to check the files there.", "Run ferry update."],
      // A Ferry from before the rules version: it passes the skill, but its rules are older.
      [`echo '${JSON.stringify({ ...usage, ok: true, error: null, result: { files: [{ path: "SKILL.md", sha256: "0", executable: false }], forbidden: [], skipped: [] } })}'`, "The Ferry on box a has older deny rules than this machine", "Run ferry update"],
    ];
    for (const [script, message, hint] of cases) {
      const w = world();
      write(join(w.box, ".claude", "skills", "draft", "SKILL.md"), "# Draft\nbox-only-body\n");
      if (script === null) rmSync(join(w.box, ".local"), { recursive: true });
      else installBoxFerry(w.box, script);

      const { error } = await adopt(w, { name: "draft" });

      expect(errorInfo(error).code).toBe("refused");
      expect((error as Error).message).toStartWith(message);
      expect(errorInfo(error).hint).toStartWith(hint);
      expect(w.commands.some(({ command }) => command.includes("tar "))).toBe(false);
      expect(crossed(w, "box-only-body")).toBe(false);
      expect(existsSync(join(w.operator, ".claude"))).toBe(false);
    }
  });

  test("without a terminal and --yes, it shows the files, asks nothing, and changes nothing", async () => {
    const w = world();
    write(join(w.box, ".claude", "skills", "draft", "SKILL.md"), "# Draft\n");

    const { error, lines, questions } = await adopt(w, { name: "draft", yes: false });

    expect(errorInfo(error).code).toBe("confirmation-required");
    expect(lines).toEqual(["New skill draft from ~/.claude/skills/draft on box a:", "  + SKILL.md"]);
    expect(questions).toEqual([]);
    expect(existsSync(join(w.operator, ".claude", "skills", "draft"))).toBe(false);
    expect(existsSync(join(w.box, ".claude", "skills", "draft"))).toBe(true);
  });

  test("on a terminal, a declined question changes nothing", async () => {
    const w = world();
    write(join(w.box, ".claude", "skills", "draft", "SKILL.md"), "# Draft\n");
    const questions: string[] = [];

    const { value, lines } = await adopt(w, { name: "draft", yes: false }, {
      interactive: true,
      confirm: async (question) => {
        questions.push(question);
        return false;
      },
    });

    expect(value).toBeNull();
    expect(questions).toEqual([
      "Adopt draft to ~/.claude/skills/draft? Ferry moves the box copy to ~/.ferry/backups on box a.",
    ]);
    expect(lines.at(-1)).toBe("Adopt cancelled.");
    expect(existsSync(join(w.operator, ".claude", "skills", "draft"))).toBe(false);
    expect(existsSync(join(w.box, ".claude", "skills", "draft"))).toBe(true);
  });

  test("shows the diff against the store copy, so the sync publishes the adopted copy as a store update", async () => {
    const w = world();
    const store = join(w.operator, ".ferry", "store", "skills", "draft");
    write(join(store, "SKILL.md"), "# Draft\nold\n");
    mkdirSync(join(w.operator, ".claude", "skills"), { recursive: true });
    symlinkSync(store, join(w.operator, ".claude", "skills", "draft"));
    write(join(w.checkout, "skills", "draft", "SKILL.md"), "# Draft\nnew\n");

    const { value, error, lines } = await adopt(w, { name: "draft" });

    expect(error).toBeNull();
    expect(value?.replaces).toBe(true);
    expect(value?.source).toBe("~/.ferry/store/skills/draft");
    expect(value?.diff).toContain("-old\n+new\n");
    expect(lines).toContain("--- a/old/SKILL.md");
    // A checkout skill has no harness root on the box, so it goes to the first root that owns skills.
    expect(value?.destination).toBe("~/.agents/skills/draft");
    expect(lstatSync(join(w.operator, ".claude", "skills", "draft")).isSymbolicLink()).toBe(true);
    const local = join(w.operator, ".agents", "skills", "draft");
    expect(lstatSync(local).isDirectory()).toBe(true);
    expect(readFileSync(join(local, "SKILL.md"), "utf8")).toBe("# Draft\nnew\n");
    expect(readFileSync(join(store, "SKILL.md"), "utf8")).toBe("# Draft\nold\n");
    const seed = readSeed(w.operator, HARNESSES, { storeUpdates: true });
    expect(seed.ok && seed.storeUpdates).toEqual([{ name: "draft", path: local }]);
  });

  test("replaces a local link to the store copy in the same root", async () => {
    const w = world();
    const store = join(w.operator, ".ferry", "store", "skills", "draft");
    write(join(store, "SKILL.md"), "old\n");
    mkdirSync(join(w.operator, ".claude", "skills"), { recursive: true });
    symlinkSync(store, join(w.operator, ".claude", "skills", "draft"));
    write(join(w.box, ".claude", "skills", "draft", "SKILL.md"), "new\n");

    const { value, error } = await adopt(w, { name: "draft" });

    expect(error).toBeNull();
    expect(value?.destination).toBe("~/.claude/skills/draft");
    const local = join(w.operator, ".claude", "skills", "draft");
    expect(lstatSync(local).isDirectory()).toBe(true);
    expect(readFileSync(join(local, "SKILL.md"), "utf8")).toBe("new\n");
    expect(readFileSync(join(store, "SKILL.md"), "utf8")).toBe("old\n");
  });

  test("the same skill on both machines changes nothing", async () => {
    const w = world();
    const store = join(w.operator, ".ferry", "store", "skills", "draft");
    write(join(store, "SKILL.md"), "# Draft\n");
    write(join(w.box, ".claude", "skills", "draft", "SKILL.md"), "# Draft\n");

    const { value, lines } = await adopt(w, { name: "draft" });

    expect(value?.adopted).toBe(false);
    expect(lines).toEqual(["draft on box a is the same as the copy on this machine."]);
    expect(existsSync(join(w.operator, ".claude", "skills", "draft"))).toBe(false);
    expect(existsSync(join(w.box, ".claude", "skills", "draft"))).toBe(true);
  });

  test("refuses a local directory with the same name that is not a Ferry link", async () => {
    const w = world();
    write(join(w.operator, ".agents", "skills", "draft", "SKILL.md"), "# Mine\n");
    write(join(w.box, ".claude", "skills", "draft", "SKILL.md"), "# Draft\n");

    const { error } = await adopt(w, { name: "draft" });

    expect(errorInfo(error).code).toBe("refused");
    expect((error as Error).message).toBe("~/.agents/skills/draft exists on this machine and is not a Ferry link. Move it away first.");
    expect(readFileSync(join(w.operator, ".agents", "skills", "draft", "SKILL.md"), "utf8")).toBe("# Mine\n");
  });

  test("refuses a skill that is not box-only, and a name with a slash", async () => {
    const w = world();

    const tracked = await adopt(w, { name: "tracked" });
    expect(errorInfo(tracked.error).code).toBe("usage");
    expect((tracked.error as Error).message).toBe("Box a has no box-only skill tracked.");

    const path = await adopt(w, { name: "../tracked" });
    expect(errorInfo(path.error).code).toBe("usage");
    expect(w.commands).toHaveLength(1);
  });
});
