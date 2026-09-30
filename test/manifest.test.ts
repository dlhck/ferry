import { afterEach, describe, expect, test } from "bun:test";
import { cpSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  carriedContentHits,
  carriedNameHit,
  denyRules,
  hasUrlCredential,
  holdsToken,
  readMcpSources,
  readSeed,
  redactTokens,
  redactUrlCredentials,
  TOKEN_ERE,
} from "../src/manifest.ts";
import type { Refusal, Seed } from "../src/manifest.ts";
import { BUILTIN_HARNESSES } from "../src/registry/builtin.ts";

const homes: string[] = [];

afterEach(() => {
  for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true });
});

function makeHome(): string {
  const home = realpathSync(mkdtempSync(join(tmpdir(), "ferry-home-")));
  homes.push(home);
  return home;
}

/** Write one skill under a harness skill root. Keys are paths relative to the skill directory. */
function writeSkill(home: string, skillRoot: string, name: string, files: Record<string, string>) {
  const dir = join(home, skillRoot, name);
  for (const [path, body] of Object.entries(files)) {
    const file = join(dir, path);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, body);
  }
  return dir;
}

function write(home: string, path: string, body: string) {
  const file = join(home, path);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, body);
  return file;
}

function seedOf(home: string): Seed {
  const result = readSeed(home, BUILTIN_HARNESSES);
  if (!result.ok) throw new Error(`expected a seed, got a refusal: ${JSON.stringify(result)}`);
  return result;
}

function refusalOf(home: string): Refusal {
  const result = readSeed(home, BUILTIN_HARNESSES);
  if (result.ok) throw new Error("expected a refusal, got a seed");
  return result;
}

function carried(seed: Seed): unknown {
  const entry = seed.settings.find((candidate) => candidate.harness === "claude");
  if (!entry) throw new Error("no carried Claude settings in the seed");
  return JSON.parse(Buffer.from(entry.bytes).toString());
}

function names(seed: Seed): string[] {
  return seed.skills.map((skill) => skill.name);
}

function bodyOf(seed: Seed, name: string, path: string): string {
  const skill = seed.skills.find((candidate) => candidate.name === name);
  const file = skill?.files.find((candidate) => candidate.path === path);
  if (!file) throw new Error(`no ${name}/${path} in the seed`);
  return Buffer.from(file.bytes).toString();
}

describe("union of the managed harnesses", () => {
  test("a name that exists in only one harness is kept, for every harness", () => {
    const home = makeHome();
    // One name per managed root, so a wrong root drops its name from the seed.
    const roots = {
      agents: ".agents/skills",
      claude: ".claude/skills",
      codex: ".codex/skills",
      pi: ".pi/agent/skills",
      cursor: ".cursor/skills",
    };
    for (const [name, root] of Object.entries(roots)) {
      writeSkill(home, root, name, { "SKILL.md": `body of ${name}` });
    }

    const seed = seedOf(home);

    expect(names(seed)).toEqual(["agents", "claude", "codex", "cursor", "pi"]);
    for (const name of Object.keys(roots)) {
      expect(bodyOf(seed, name, "SKILL.md")).toBe(`body of ${name}`);
    }
  });

  test("a name in every harness with the same bytes collapses to one entry", () => {
    const home = makeHome();
    const roots = [".agents/skills", ".claude/skills", ".codex/skills", ".pi/agent/skills", ".cursor/skills"];
    for (const root of roots) {
      writeSkill(home, root, "unslop", { "SKILL.md": "same", "ref/notes.md": "notes" });
    }

    const seed = seedOf(home);

    expect(names(seed)).toEqual(["unslop"]);
    expect(seed.skills[0]?.files.map((file) => file.path)).toEqual(["SKILL.md", "ref/notes.md"]);
    expect(bodyOf(seed, "unslop", "SKILL.md")).toBe("same");
  });

  test("two harness roots that are the same directory collapse to one entry", () => {
    const home = makeHome();
    writeSkill(home, ".claude/skills", "unslop", { "SKILL.md": "same" });
    mkdirSync(join(home, ".codex"), { recursive: true });
    symlinkSync(join(home, ".claude", "skills"), join(home, ".codex", "skills"));

    const seed = seedOf(home);

    expect(names(seed)).toEqual(["unslop"]);
    expect(bodyOf(seed, "unslop", "SKILL.md")).toBe("same");
  });

  test("a skill directory symlinked into a second harness collapses to one entry", () => {
    const home = makeHome();
    const source = writeSkill(home, ".claude/skills", "unslop", { "SKILL.md": "same" });
    mkdirSync(join(home, ".pi", "agent", "skills"), { recursive: true });
    symlinkSync(source, join(home, ".pi", "agent", "skills", "unslop"));

    const seed = seedOf(home);

    expect(names(seed)).toEqual(["unslop"]);
    expect(bodyOf(seed, "unslop", "SKILL.md")).toBe("same");
  });

  test("the same name with different bytes refuses and names the clash", () => {
    const home = makeHome();
    writeSkill(home, ".claude/skills", "unslop", { "SKILL.md": "one" });
    writeSkill(home, ".codex/skills", "unslop", { "SKILL.md": "two" });
    writeSkill(home, ".pi/agent/skills", "tdd", { "SKILL.md": "kept" });

    const refusal = refusalOf(home);

    expect(refusal.clashes.map((clash) => clash.name)).toEqual(["unslop"]);
    expect(refusal.clashes[0]?.paths).toEqual([
      join(home, ".claude", "skills", "unslop"),
      join(home, ".codex", "skills", "unslop"),
    ]);
  });

  test("an extra file in one harness is a clash, not a silent merge", () => {
    const home = makeHome();
    writeSkill(home, ".claude/skills", "unslop", { "SKILL.md": "same" });
    writeSkill(home, ".codex/skills", "unslop", { "SKILL.md": "same", "extra.md": "only here" });

    expect(refusalOf(home).clashes.map((clash) => clash.name)).toEqual(["unslop"]);
  });

  describe("a store update from one harness root", () => {
    /** The store copy is v1. `.agents/skills` has a real v2; `.claude` links to the store, `.codex` chains through `.claude`. */
    function installerHome(): { home: string; real: string } {
      const home = makeHome();
      const stored = writeSkill(home, ".ferry/store/skills", "unslop", { "SKILL.md": "v1" });
      const real = writeSkill(home, ".agents/skills", "unslop", { "SKILL.md": "v2", ".installer-source": "stack" });
      mkdirSync(join(home, ".claude", "skills"), { recursive: true });
      symlinkSync(stored, join(home, ".claude", "skills", "unslop"));
      mkdirSync(join(home, ".codex", "skills"), { recursive: true });
      symlinkSync(join(home, ".claude", "skills", "unslop"), join(home, ".codex", "skills", "unslop"));
      return { home, real };
    }

    test("carries the real directory and names it as a store update", () => {
      const { home, real } = installerHome();

      const seed = readSeed(home, BUILTIN_HARNESSES, { storeUpdates: true });

      if (!seed.ok) throw new Error(`expected a seed, got a refusal: ${JSON.stringify(seed)}`);
      expect(seed.storeUpdates).toEqual([{ name: "unslop", path: real }]);
      expect(bodyOf(seed, "unslop", "SKILL.md")).toBe("v2");
      expect(bodyOf(seed, "unslop", ".installer-source")).toBe("stack");
    });

    test("is a clash when the caller does not ask for store updates", () => {
      const { home } = installerHome();

      expect(refusalOf(home).clashes.map((clash) => clash.name)).toEqual(["unslop"]);
    });

    test("is a clash when two harness roots have different real directories", () => {
      const { home } = installerHome();
      rmSync(join(home, ".codex", "skills", "unslop"));
      writeSkill(home, ".codex/skills", "unslop", { "SKILL.md": "v3" });

      const result = readSeed(home, BUILTIN_HARNESSES, { storeUpdates: true });

      if (result.ok) throw new Error("expected a refusal, got a seed");
      expect(result.clashes.map((clash) => clash.name)).toEqual(["unslop"]);
    });

    test("is a clash when a second root links to the real directory, not to the store", () => {
      const { home, real } = installerHome();
      rmSync(join(home, ".codex", "skills", "unslop"));
      symlinkSync(real, join(home, ".codex", "skills", "unslop"));

      const result = readSeed(home, BUILTIN_HARNESSES, { storeUpdates: true });

      if (result.ok) throw new Error("expected a refusal, got a seed");
      expect(result.clashes.map((clash) => clash.name)).toEqual(["unslop"]);
    });
  });

  test("project-local skill directories are ignored", () => {
    const home = makeHome();
    writeSkill(home, ".claude/skills", "unslop", { "SKILL.md": "home" });
    write(home, "work/repo/.claude/skills/local/SKILL.md", "project");

    expect(names(seedOf(home))).toEqual(["unslop"]);
  });

  test("a Ferry backup directory is reported and omitted from the seed", () => {
    const home = makeHome();
    writeSkill(home, ".agents/skills", "diagnosing-bugs", { "SKILL.md": "current" });
    const backup = writeSkill(
      home,
      ".agents/skills",
      "diagnosing-bugs.ferry-backup-20260830T160738Z",
      { "SKILL.md": "backup" },
    );

    const seed = seedOf(home);

    expect(names(seed)).toEqual(["diagnosing-bugs"]);
    expect(seed.leftovers).toContainEqual({
      path: backup,
      code: "ferry-backup",
      reason: "Ferry backup directory",
    });
  });

  test("the Codex system skills directory is ignored in every skill root", () => {
    const home = makeHome();
    writeSkill(home, ".codex/skills", ".system", { ".codex-system-skills.marker": "codex", "a/SKILL.md": "new" });
    writeSkill(home, ".ferry/store/skills", ".system", { "a/SKILL.md": "old" });
    for (const root of [".agents/skills", ".claude/skills", ".pi/agent/skills", ".cursor/skills"]) {
      mkdirSync(join(home, root), { recursive: true });
      symlinkSync(join(home, ".ferry", "store", "skills", ".system"), join(home, root, ".system"));
    }
    // A link whose store directory a publish removed.
    mkdirSync(join(home, ".claude", "skills"), { recursive: true });
    rmSync(join(home, ".claude", "skills", ".system"));
    symlinkSync(join(home, ".ferry", "store", "skills", "gone", ".system"), join(home, ".claude", "skills", ".system"));
    writeSkill(home, ".agents/skills", "tdd", { "SKILL.md": "kept" });

    const seed = seedOf(home);

    expect(names(seed)).toEqual(["tdd"]);
    expect(seed.leftovers.filter((leftover) => leftover.path.includes(".system"))).toEqual([]);
  });
});

describe("the instruction file", () => {
  test("the home AGENTS.md is the one instruction file", () => {
    const home = makeHome();
    write(home, "AGENTS.md", "house rules");
    write(home, ".claude/CLAUDE.md", "claude only");

    const seed = seedOf(home);

    expect(Buffer.from(seed.instructions?.bytes ?? []).toString()).toBe("house rules");
  });

  test("a home without AGENTS.md yields a seed with no instruction file", () => {
    const home = makeHome();
    writeSkill(home, ".claude/skills", "unslop", { "SKILL.md": "body" });

    expect(seedOf(home).instructions).toBeNull();
  });
});

// Build each token at run time so this file holds no string a secret scanner flags.
const tokens: [string, string][] = [
  ["github-token", "gh" + "p_" + "a1B2".repeat(9)],
  ["github-token", "gh" + "o_" + "a1B2".repeat(9)],
  ["github-token", "gh" + "u_" + "a1B2".repeat(9)],
  ["github-token", "gh" + "s_" + "a1B2".repeat(9)],
  ["github-token", "github" + "_pat_" + "a1B2c3_".repeat(12)],
  ["anthropic-key", "sk-" + "ant-" + "api03-" + "a1B2-c3D4_".repeat(9)],
  ["openai-key", "sk-" + "proj-" + "a1B2-c3D4_".repeat(9)],
  ["slack-token", "xo" + "xb-" + "1234567890-1234567890-" + "a1B2".repeat(6)],
  ["slack-token", "xo" + "xp-" + "1234567890-1234567890-" + "a1B2".repeat(6)],
  ["aws-access-key", "AK" + "IA" + "Q2W3E4R5T6Y7U8I9"],
];

describe("the deny set", () => {
  test("exports its human-readable rules for read-only reporting", () => {
    expect(denyRules()).toEqual([
      { code: "dotenv", description: "environment file", behavior: "refuse" },
      {
        code: "credentials",
        description: "vendor auth or credential file",
        behavior: "refuse",
      },
      { code: "private-key", description: "private key", behavior: "refuse" },
      {
        code: "token",
        description: "host token, daemon key, or MCP token",
        behavior: "refuse",
      },
      {
        code: "symlink-escape",
        description: "symlink that leaves the skill directory",
        behavior: "refuse",
      },
      { code: "github-token", description: "GitHub token in file content", behavior: "refuse" },
      {
        code: "anthropic-key",
        description: "Anthropic API key in file content",
        behavior: "refuse",
      },
      { code: "openai-key", description: "OpenAI API key in file content", behavior: "refuse" },
      { code: "slack-token", description: "Slack token in file content", behavior: "refuse" },
      {
        code: "aws-access-key",
        description: "AWS access key ID in file content",
        behavior: "refuse",
      },
      {
        code: "settings-credential",
        description: "request headers in a carried settings key",
        behavior: "refuse",
      },
      {
        code: "mcp-credential",
        description: "remote MCP server declaration with headers, environment values, arguments, or a credential",
        behavior: "refuse",
      },
      {
        code: "mcp-argument",
        description: "stdio MCP server command or argument with a token, a secret, or a URL credential",
        behavior: "refuse",
      },
      {
        code: "mcp-name",
        description: "MCP server name with characters other than letters, digits, dot, underscore, and hyphen",
        behavior: "refuse",
      },
      {
        code: "secret-field",
        description: "password or secret key with a value in a JSON, YAML, or TOML file",
        behavior: "refuse",
      },
      {
        code: "executable",
        description: "executable binary (ELF, Mach-O, or PE)",
        behavior: "refuse",
      },
      {
        code: "hook-path",
        description: "hook entry that refers to a home path outside the managed set",
        behavior: "skip",
      },
      { code: "history", description: "session history", behavior: "skip" },
      { code: "database", description: "sqlite or other database file", behavior: "skip" },
      { code: "cache", description: "cache or build output", behavior: "skip" },
      {
        code: "settings",
        description: "whole harness settings file; only listed keys are carried",
        behavior: "skip",
      },
      {
        code: "mcp-local",
        description: "MCP server that is neither a remote HTTPS server nor a stdio command",
        behavior: "skip",
      },
      {
        code: "mcp-path",
        description: "stdio MCP server whose command or arguments refer to a path in the operator home",
        behavior: "skip",
      },
      {
        code: "mcp-script",
        description: "stdio MCP server that runs an inline shell or interpreter script, which Ferry cannot check",
        behavior: "skip",
      },
      {
        code: "mcp-app-bundle",
        description: "stdio MCP server whose command or arguments refer to a path in a macOS app bundle",
        behavior: "skip",
      },
    ]);
  });

  test("forbidden names never appear in a seed", () => {
    const home = makeHome();
    writeSkill(home, ".claude/skills", "unslop", {
      "SKILL.md": "body",
      ".DS_Store": "junk",
      "history.jsonl": "session",
      "index.sqlite": "db",
      "settings.json": "harness settings",
      ".mcp.json": "mcp",
      "node_modules/left-pad/index.js": "cache",
    });

    const seed = seedOf(home);

    expect(seed.skills[0]?.files.map((file) => file.path)).toEqual(["SKILL.md"]);
    expect(seed.leftovers).toContainEqual({
      path: join(home, ".claude", "skills", "unslop", "settings.json"),
      code: "settings",
      reason: expect.any(String),
    });
  });

  test("harness auth and state outside the skill roots never reach the seed", () => {
    const home = makeHome();
    writeSkill(home, ".claude/skills", "unslop", { "SKILL.md": "body" });
    write(home, ".claude/.credentials.json", "token");
    write(home, ".claude/__store.db", "sqlite");
    write(home, ".codex/auth.json", "token");

    const seed = seedOf(home);

    const bodies = seed.skills.flatMap((skill) =>
      skill.files.map((file) => Buffer.from(file.bytes).toString()),
    );
    expect(bodies).toEqual(["body"]);
  });

  test.each([
    [".env", "SECRET=1", "dotenv"],
    [".env.production", "SECRET=1", "dotenv"],
    ["credentials.json", "{}", "credentials"],
    ["auth.json", "{}", "credentials"],
    ["id_ed25519", "key", "private-key"],
    ["deploy.pem", "key", "private-key"],
    ["token.json", "{}", "token"],
    ["daemon-keypair.json", "{}", "token"],
    ["hub-credentials.json", "{}", "credentials"],
    ["Credentials.json", "{}", "credentials"],
    ["AUTH.JSON", "{}", "credentials"],
    [".ENV", "SECRET=1", "dotenv"],
  ])("a skill holding %s refuses the whole seed", (name, body, code) => {
    const home = makeHome();
    writeSkill(home, ".claude/skills", "unslop", { "SKILL.md": "body", [name]: body });
    writeSkill(home, ".codex/skills", "clean", { "SKILL.md": "clean" });

    const refusal = refusalOf(home);

    expect(refusal.forbidden).toEqual([
      {
        path: join(home, ".claude", "skills", "unslop", name),
        code,
        reason: expect.any(String),
      },
    ]);
  });

  test("a private key renamed to look harmless still refuses", () => {
    const home = makeHome();
    writeSkill(home, ".claude/skills", "unslop", {
      "notes.md": "-----BEGIN OPENSSH PRIVATE KEY-----\nb3BlbnNzaA==\n",
    });

    expect(refusalOf(home).forbidden[0]?.code).toBe("private-key");
  });

  test.each(tokens)("a skill file that holds a %s refuses the whole seed", (code, token) => {
    const home = makeHome();
    writeSkill(home, ".claude/skills", "unslop", {
      "SKILL.md": "body",
      "notes.md": `Use this key:\n${token}\n`,
    });
    writeSkill(home, ".codex/skills", "clean", { "SKILL.md": "clean" });

    const refusal = refusalOf(home);

    expect(refusal.forbidden).toEqual([
      {
        path: join(home, ".claude", "skills", "unslop", "notes.md"),
        code,
        reason: expect.stringContaining("in file content"),
      },
    ]);
    expect(JSON.stringify(refusal)).not.toContain(token);
  });

  test.each(tokens)("an AGENTS.md that holds a %s refuses the whole seed", (code, token) => {
    const home = makeHome();
    write(home, "AGENTS.md", `export TOKEN="${token}"\n`);
    writeSkill(home, ".claude/skills", "unslop", { "SKILL.md": "body" });

    const refusal = refusalOf(home);

    expect(refusal.forbidden).toEqual([
      { path: join(home, "AGENTS.md"), code, reason: expect.stringContaining("in file content") },
    ]);
    expect(JSON.stringify(refusal)).not.toContain(token);
  });

  test.each(tokens)("a %s after an underscore, a hyphen, or another sign is a token", (code, token) => {
    const hits = (text: string) => carriedContentHits("notes.md", Buffer.from(text)).map((hit) => hit.code);

    for (const text of [`MY_${token}`, `password_${token}`, `x-${token}`, `key=${token}`, `"${token}"`, `${token}_suffix`]) {
      expect([text.replace(token, "<token>"), hits(text)]).toEqual([text.replace(token, "<token>"), [code]]);
    }
    // A letter or a digit before the prefix makes it a part of a longer word.
    for (const text of [`x${token}`, `9${token}`]) expect([text.replace(token, "<token>"), hits(text)]).toEqual([text.replace(token, "<token>"), []]);
  });

  test("token prefixes in plain prose do not refuse", () => {
    const home = makeHome();
    write(
      home,
      "AGENTS.md",
      "GitHub tokens start with gh" + "p_ or github" + "_pat_. Anthropic keys start with sk-" +
        "ant-, Slack bot tokens with xo" + "xb-, and AWS key IDs with AK" + "IA.\n",
    );
    writeSkill(home, ".claude/skills", "unslop", {
      "SKILL.md": "Set sk-" + "proj-... in your shell, never here. Example: gh" + "p_xxxx.\n",
    });

    expect(names(seedOf(home))).toEqual(["unslop"]);
  });

  test.each([
    ["github-token", "gh" + "s_" + "x".repeat(36)],
    ["github-token", "gh" + "u_" + "X".repeat(36)],
    ["github-token", "github" + "_pat_" + "0".repeat(40)],
    ["anthropic-key", "sk-" + "ant-" + "xxxx-xxxx_xxxx-xxxx_xxxx"],
    ["openai-key", "sk-" + "proj-" + "X".repeat(24)],
    ["slack-token", "xo" + "xb-" + "xxxx-xxxx-xxxx-xxxx-xxxx"],
    ["aws-access-key", "AK" + "IA" + "X".repeat(16)],
  ])("a %s placeholder in documentation does not refuse", (_code, placeholder) => {
    const home = makeHome();
    writeSkill(home, ".claude/skills", "unslop", {
      "SKILL.md": "body",
      "example.md": `{ "token": "${placeholder}" }\n`,
    });

    expect(names(seedOf(home))).toEqual(["unslop"]);
  });

  test("a real-looking token next to placeholders still refuses", () => {
    const home = makeHome();
    const token = tokens[3]![1];
    writeSkill(home, ".claude/skills", "unslop", {
      "SKILL.md": "body",
      "example.md":
        `{ "installationToken": "gh${"s_" + "x".repeat(36)}" }\n` +
        `{ "token": "gh${"u_" + "0".repeat(36)}" }\n` +
        `{ "token": "${token}" }\n`,
    });

    const refusal = refusalOf(home);

    expect(refusal.forbidden.map((hit) => hit.code)).toEqual(["github-token"]);
    expect(JSON.stringify(refusal)).not.toContain(token);
  });

  test("a symlink out of the skill directory refuses", () => {
    const home = makeHome();
    write(home, ".ssh/id_rsa", "key");
    const skill = writeSkill(home, ".claude/skills", "unslop", { "SKILL.md": "body" });
    symlinkSync(join(home, ".ssh", "id_rsa"), join(skill, "helper.md"));

    const refusal = refusalOf(home);

    expect(refusal.forbidden[0]?.code).toBe("symlink-escape");
    expect(refusal.forbidden[0]?.path).toBe(join(skill, "helper.md"));
  });

  test("a symlink inside the skill directory is followed", () => {
    const home = makeHome();
    const skill = writeSkill(home, ".claude/skills", "unslop", { "SKILL.md": "body" });
    symlinkSync(join(skill, "SKILL.md"), join(skill, "README.md"));

    expect(bodyOf(seedOf(home), "unslop", "README.md")).toBe("body");
  });

  test("refusals report every clash and every forbidden hit at once", () => {
    const home = makeHome();
    writeSkill(home, ".claude/skills", "unslop", { "SKILL.md": "one" });
    writeSkill(home, ".codex/skills", "unslop", { "SKILL.md": "two" });
    writeSkill(home, ".pi/agent/skills", "leaky", { "SKILL.md": "body", ".env": "SECRET=1" });

    const refusal = refusalOf(home);

    expect(refusal.clashes.map((clash) => clash.name)).toEqual(["unslop"]);
    expect(refusal.forbidden.map((forbidden) => forbidden.code)).toEqual(["dotenv"]);
  });

  test("skipped junk in one harness does not fake a clash with another", () => {
    const home = makeHome();
    writeSkill(home, ".claude/skills", "unslop", { "SKILL.md": "same", ".DS_Store": "junk" });
    writeSkill(home, ".codex/skills", "unslop", { "SKILL.md": "same" });

    expect(names(seedOf(home))).toEqual(["unslop"]);
  });

});

describe("password and secret fields in config files", () => {
  // Build the value at run time so this file holds no string a secret scanner flags.
  const value = "hunter" + "2-" + "q7Z";

  const formats = {
    json: (key: string, v: string) => JSON.stringify({ database: { host: "db", [key]: v } }),
    yaml: (key: string, v: string) => `database:\n  host: db\n  ${key}: "${v}"\n`,
    toml: (key: string, v: string) => `[database]\nhost = "db"\n${key} = "${v}"\n`,
  };
  const keys = ["password", "passwd", "secret", "client_secret", "private_key", "api_key"];
  const cases = Object.keys(formats).flatMap((ext) => keys.map((key) => [ext, key] as const));

  test.each(cases)("a .%s file with a %s value refuses and names the path and key", (ext, key) => {
    const home = makeHome();
    const file = `config.${ext}`;
    writeSkill(home, ".claude/skills", "sherlock", {
      "SKILL.md": "body",
      [file]: formats[ext as keyof typeof formats](key, value),
    });

    const refusal = refusalOf(home);

    expect(refusal.forbidden).toEqual([
      {
        path: join(home, ".claude", "skills", "sherlock", file),
        code: "secret-field",
        reason: expect.stringContaining(key),
      },
    ]);
    expect(JSON.stringify(refusal)).not.toContain(value);
  });

  test.each(["Password", "PASSWD", "clientSecret", "api-key", "privateKey"])(
    "the key %s matches without regard to case or separators",
    (key) => {
      const home = makeHome();
      write(home, ".claude/agents/config.yaml", formats.yaml(key, value));

      expect(refusalOf(home).forbidden.map((hit) => hit.code)).toEqual(["secret-field"]);
    },
  );

  test.each(["secretKeyB64", "db_password_hash", "OPENAI_API_KEY", "accessToken", "signingPrivateKeyPem"])(
    "the key %s holds a secret word, so it matches too",
    (key) => {
      const home = makeHome();
      write(home, ".claude/agents/config.json", formats.json(key, value));

      const refusal = refusalOf(home);

      expect(refusal.forbidden).toEqual([
        { path: join(home, ".claude/agents/config.json"), code: "secret-field", reason: `key ${key} holds a password or secret` },
      ]);
      expect(JSON.stringify(refusal)).not.toContain(value);
    },
  );

  test("a key with a secret word and a placeholder or number value does not refuse", () => {
    const home = makeHome();
    write(home, ".claude/agents/config.json", JSON.stringify({ secretKeyB64: "xxxx", maxTokens: 4096 }));

    expect(seedOf(home).roots.find((root) => root.path === ".claude/agents")?.files).toHaveLength(1);
  });

  const allowed = ["", "x", "XXXX", "0000", "xxxx-xxxx", "xx_xx"];
  const allowedCases = Object.keys(formats).flatMap((ext) => allowed.map((v) => [ext, v] as const));

  test.each(allowedCases)("a .%s file with the empty or placeholder value %p does not refuse", (ext, v) => {
    const home = makeHome();
    writeSkill(home, ".claude/skills", "sherlock", {
      "SKILL.md": "body",
      [`config.${ext}`]: formats[ext as keyof typeof formats]("password", v),
    });

    expect(names(seedOf(home))).toEqual(["sherlock"]);
  });

  test("a file that does not parse is matched line by line", () => {
    const home = makeHome();
    writeSkill(home, ".claude/skills", "sherlock", {
      "SKILL.md": "body",
      "config.json": `{\n  "password": "${value}",\n  broken\n`,
    });

    const refusal = refusalOf(home);

    expect(refusal.forbidden.map((hit) => hit.code)).toEqual(["secret-field"]);
    expect(JSON.stringify(refusal)).not.toContain(value);
  });

  test("a password key in a Markdown file does not refuse", () => {
    const home = makeHome();
    writeSkill(home, ".claude/skills", "sherlock", { "SKILL.md": `password: ${value}\n` });

    expect(names(seedOf(home))).toEqual(["sherlock"]);
  });
});

describe("executable binaries", () => {
  const binary = (...head: number[]) => Buffer.from([...head, 0, 0, 0, 0, 0, 0, 0, 0]);
  /** An MS-DOS stub whose offset at 0x3c leads to the PE signature. */
  function pe(): Buffer {
    const bytes = Buffer.alloc(0x48);
    bytes.write("MZ", 0, "latin1");
    bytes.writeUInt32LE(0x40, 0x3c);
    bytes.write("PE\0\0", 0x40, "latin1");
    return bytes;
  }

  test.each([
    ["ELF", binary(0x7f, 0x45, 0x4c, 0x46, 2, 1, 1)],
    ["Mach-O 32-bit big-endian", binary(0xfe, 0xed, 0xfa, 0xce)],
    ["Mach-O 64-bit big-endian", binary(0xfe, 0xed, 0xfa, 0xcf)],
    ["Mach-O 32-bit little-endian", binary(0xce, 0xfa, 0xed, 0xfe)],
    ["Mach-O 64-bit little-endian", binary(0xcf, 0xfa, 0xed, 0xfe)],
    ["Mach-O universal", binary(0xca, 0xfe, 0xba, 0xbe, 0, 0, 0, 2)],
    ["PE", pe()],
  ])("a %s file refuses the whole seed", (_kind, bytes) => {
    const home = makeHome();
    const dir = writeSkill(home, ".claude/skills", "sherlock", { "SKILL.md": "body" });
    writeFileSync(join(dir, "sherlock"), bytes);

    expect(refusalOf(home).forbidden).toEqual([
      { path: join(dir, "sherlock"), code: "executable", reason: expect.any(String) },
    ]);
  });

  test("an executable in an extra root refuses", () => {
    const home = makeHome();
    write(home, ".claude/commands/ship.md", "ship");
    writeFileSync(join(home, ".claude", "commands", "tool"), binary(0x7f, 0x45, 0x4c, 0x46));

    expect(refusalOf(home).forbidden.map((hit) => hit.code)).toEqual(["executable"]);
  });

  test.each([
    ["a shell script", Buffer.from("#!/bin/sh\necho hi\n")],
    ["a Java class file", binary(0xca, 0xfe, 0xba, 0xbe, 0, 0, 0, 0x34)],
    ["a text file that starts with MZ", Buffer.from("MZ is the header of a DOS program.\n")],
  ])("%s does not refuse", (_kind, bytes) => {
    const home = makeHome();
    const dir = writeSkill(home, ".claude/skills", "sherlock", { "SKILL.md": "body" });
    writeFileSync(join(dir, "run"), bytes);

    expect(names(seedOf(home))).toEqual(["sherlock"]);
  });
});

describe("seed identity", () => {
  test("two reads of the same home give the same identity", () => {
    const home = makeHome();
    writeSkill(home, ".claude/skills", "unslop", { "SKILL.md": "body" });
    write(home, "AGENTS.md", "rules");

    expect(seedOf(home).identity).toBe(seedOf(home).identity);
  });

  test("adding a skill changes the identity", () => {
    const home = makeHome();
    writeSkill(home, ".claude/skills", "unslop", { "SKILL.md": "body" });
    const before = seedOf(home).identity;

    writeSkill(home, ".claude/skills", "tdd", { "SKILL.md": "red green" });

    expect(seedOf(home).identity).not.toBe(before);
  });

  test("removing a skill changes the identity", () => {
    const home = makeHome();
    writeSkill(home, ".claude/skills", "unslop", { "SKILL.md": "body" });
    writeSkill(home, ".claude/skills", "tdd", { "SKILL.md": "red green" });
    const before = seedOf(home).identity;

    rmSync(join(home, ".claude", "skills", "tdd"), { recursive: true });

    expect(seedOf(home).identity).not.toBe(before);
  });

  test("editing a skill body changes the identity", () => {
    const home = makeHome();
    writeSkill(home, ".claude/skills", "unslop", { "SKILL.md": "body" });
    const before = seedOf(home).identity;

    writeSkill(home, ".claude/skills", "unslop", { "SKILL.md": "new body" });

    expect(seedOf(home).identity).not.toBe(before);
  });

  test("renaming a skill changes the identity", () => {
    const home = makeHome();
    writeSkill(home, ".claude/skills", "unslop", { "SKILL.md": "body" });
    const before = seedOf(home).identity;

    rmSync(join(home, ".claude", "skills", "unslop"), { recursive: true });
    writeSkill(home, ".claude/skills", "de-slop", { "SKILL.md": "body" });

    expect(seedOf(home).identity).not.toBe(before);
  });

  test("editing the instruction file changes the identity", () => {
    const home = makeHome();
    write(home, "AGENTS.md", "rules");
    const before = seedOf(home).identity;

    write(home, "AGENTS.md", "new rules");

    expect(seedOf(home).identity).not.toBe(before);
  });

  test("the same skill reached through a second harness leaves the identity alone", () => {
    const home = makeHome();
    writeSkill(home, ".claude/skills", "unslop", { "SKILL.md": "body" });
    const before = seedOf(home).identity;

    writeSkill(home, ".codex/skills", "unslop", { "SKILL.md": "body" });

    expect(seedOf(home).identity).toBe(before);
  });

  test("changing a configured target changes the identity", () => {
    const home = makeHome();
    const original = readSeed(home, BUILTIN_HARNESSES);
    const configured = readSeed(home, [
      ...BUILTIN_HARNESSES,
      {
        id: "custom",
        name: "Custom",
        skillRoot: ".custom/skills",
        instructionFile: ".custom/AGENTS.md",
      },
    ]);

    expect(original.ok).toBe(true);
    expect(configured.ok).toBe(true);
    if (original.ok && configured.ok) expect(configured.identity).not.toBe(original.identity);
  });
});

describe("an empty home", () => {
  test("no harness directories yield an empty seed", () => {
    const seed = seedOf(makeHome());

    expect(seed.skills).toEqual([]);
    expect(seed.instructions).toBeNull();
    expect(seed.identity).toMatch(/^[0-9a-f]{64}$/);
  });

  test("a loose file in a skill root is reported and not imported", () => {
    const home = makeHome();
    write(home, ".claude/skills/README.md", "loose");

    const seed = seedOf(home);

    expect(seed.skills).toEqual([]);
    expect(seed.leftovers).toEqual([
      {
        path: join(home, ".claude", "skills", "README.md"),
        code: "not-a-directory",
        reason: expect.any(String),
      },
    ]);
  });
});

describe("Claude subagents and commands", () => {
  function rootOf(seed: Seed, path: string) {
    return seed.roots.find((root) => root.path === path);
  }

  function filesOf(seed: Seed, path: string): Record<string, string> {
    const root = rootOf(seed, path);
    if (!root) throw new Error(`no ${path} root in the seed`);
    return Object.fromEntries(
      root.files.map((file) => [file.path, Buffer.from(file.bytes).toString()]),
    );
  }

  test("agents and commands reach the seed with their nested files", () => {
    const home = makeHome();
    write(home, ".claude/agents/reviewer.md", "review agent");
    write(home, ".claude/commands/ship.md", "ship command");
    write(home, ".claude/commands/git/pr.md", "namespaced command");

    const seed = seedOf(home);

    expect(seed.roots.map((root) => root.path)).toEqual([".claude/agents", ".claude/commands"]);
    expect(filesOf(seed, ".claude/agents")).toEqual({ "reviewer.md": "review agent" });
    expect(filesOf(seed, ".claude/commands")).toEqual({
      "git/pr.md": "namespaced command",
      "ship.md": "ship command",
    });
  });

  test("a missing root yields no root entry", () => {
    const home = makeHome();
    write(home, ".claude/agents/reviewer.md", "review agent");

    expect(seedOf(home).roots.map((root) => root.path)).toEqual([".claude/agents"]);
  });

  test("an empty root is kept, so a linked root keeps its store directory", () => {
    const home = makeHome();
    mkdirSync(join(home, ".claude", "commands"), { recursive: true });

    expect(seedOf(home).roots).toEqual([{ path: ".claude/commands", files: [] }]);
  });

  test("the name deny rules apply inside a root", () => {
    const home = makeHome();
    write(home, ".claude/agents/reviewer.md", "review agent");
    write(home, ".claude/agents/settings.json", "{}");
    write(home, ".claude/commands/.env", "SECRET=1");

    const refusal = refusalOf(home);

    expect(refusal.forbidden).toEqual([
      { path: join(home, ".claude", "commands", ".env"), code: "dotenv", reason: expect.any(String) },
    ]);
  });

  test("a denied settings file inside a root is skipped, not carried", () => {
    const home = makeHome();
    write(home, ".claude/agents/reviewer.md", "review agent");
    write(home, ".claude/agents/settings.json", "{}");

    const seed = seedOf(home);

    expect(filesOf(seed, ".claude/agents")).toEqual({ "reviewer.md": "review agent" });
    expect(seed.leftovers).toContainEqual({
      path: join(home, ".claude", "agents", "settings.json"),
      code: "settings",
      reason: expect.any(String),
    });
  });

  test.each(tokens)("an agent file that holds a %s refuses the whole seed", (code, token) => {
    const home = makeHome();
    write(home, ".claude/agents/reviewer.md", `Use ${token} to call the API.`);

    expect(refusalOf(home).forbidden).toEqual([
      { path: join(home, ".claude", "agents", "reviewer.md"), code, reason: expect.any(String) },
    ]);
  });

  test("a symlink out of a root refuses", () => {
    const home = makeHome();
    write(home, "outside.md", "outside");
    mkdirSync(join(home, ".claude", "commands"), { recursive: true });
    symlinkSync(join(home, "outside.md"), join(home, ".claude", "commands", "outside.md"));

    expect(refusalOf(home).forbidden.map((hit) => hit.code)).toEqual(["symlink-escape"]);
  });

  test("editing an agent changes the identity", () => {
    const home = makeHome();
    write(home, ".claude/agents/reviewer.md", "review agent");
    const before = seedOf(home).identity;
    write(home, ".claude/agents/reviewer.md", "stricter review agent");

    expect(seedOf(home).identity).not.toBe(before);
  });
});

describe("carried Claude settings keys", () => {
  const settings = {
    env: { API_TOKEN: "env-secret-value" },
    apiKeyHelper: "/usr/local/bin/print-key",
    permissions: { allow: ["Bash(git status)"] },
    hooks: { Stop: [{ hooks: [{ type: "command", command: "notify" }] }] },
    statusLine: { type: "command", command: "/usr/local/bin/status-line" },
    attribution: { commit: "", pr: "" },
    model: "opus",
    alwaysThinkingEnabled: true,
    enabledPlugins: { "review@team": true, "old@team": false },
    extraKnownMarketplaces: {
      team: { source: { source: "github", repo: "example/claude-plugins" } },
    },
  };

  test("only the allowlisted keys leave the settings file", () => {
    const home = makeHome();
    write(home, ".claude/settings.json", JSON.stringify(settings));

    const seed = seedOf(home);

    expect(carried(seed)).toEqual({
      enabledPlugins: settings.enabledPlugins,
      extraKnownMarketplaces: settings.extraKnownMarketplaces,
      permissions: settings.permissions,
      hooks: settings.hooks,
      attribution: settings.attribution,
      model: settings.model,
      alwaysThinkingEnabled: settings.alwaysThinkingEnabled,
    });
    const text = Buffer.from(seed.settings[0]?.bytes ?? []).toString();
    for (const secret of ["env", "env-secret-value", "apiKeyHelper", "print-key", "status-line"]) {
      expect(text).not.toContain(secret);
    }
  });

  test("a home without a settings file carries no settings", () => {
    expect(seedOf(makeHome()).settings).toEqual([]);
  });

  test("a settings file without carried keys carries an empty object", () => {
    const home = makeHome();
    write(home, ".claude/settings.json", JSON.stringify({ outputStyle: "Explanatory" }));

    expect(carried(seedOf(home))).toEqual({});
  });

  test("a settings file that is not a JSON object refuses the seed", () => {
    const home = makeHome();
    write(home, ".claude/settings.json", "{ not json");

    expect(refusalOf(home).forbidden).toEqual([
      {
        path: join(home, ".claude", "settings.json"),
        code: "invalid-settings",
        reason: expect.any(String),
      },
    ]);
  });

  test.each(tokens)("a carried key that holds a %s refuses the seed", (code, token) => {
    const home = makeHome();
    write(
      home,
      ".claude/settings.json",
      JSON.stringify({
        extraKnownMarketplaces: {
          team: { source: { source: "git", url: `https://${token}@git.example.com/plugins.git` } },
        },
      }),
    );

    expect(refusalOf(home).forbidden).toEqual([
      { path: join(home, ".claude", "settings.json"), code, reason: expect.any(String) },
    ]);
  });

  test.each([
    ["permissions", { permissions: { allow: [`Bash(curl -u ${tokens[0]![1]} https://api.github.com)`] } }],
    ["hooks", { hooks: { Stop: [{ hooks: [{ type: "command", command: `notify ${tokens[5]![1]}` }] }] } }],
  ])("a token inside the carried %s key refuses the seed", (_key, value) => {
    const home = makeHome();
    write(home, ".claude/settings.json", JSON.stringify(value));

    expect(refusalOf(home).forbidden).toEqual([
      { path: join(home, ".claude", "settings.json"), code: expect.any(String), reason: expect.any(String) },
    ]);
  });

  test("a token in a key that is not carried does not refuse the seed", () => {
    const home = makeHome();
    const token = tokens[0]![1];
    write(home, ".claude/settings.json", JSON.stringify({ env: { GH_TOKEN: token } }));

    expect(carried(seedOf(home))).toEqual({});
  });

  test("request headers in a carried key refuse the seed", () => {
    const home = makeHome();
    write(
      home,
      ".claude/settings.json",
      JSON.stringify({
        extraKnownMarketplaces: {
          team: {
            source: {
              source: "url",
              url: "https://plugins.example.com/marketplace.json",
              headers: { Authorization: "Bearer internal" },
            },
          },
        },
      }),
    );

    expect(refusalOf(home).forbidden).toEqual([
      {
        path: join(home, ".claude", "settings.json"),
        code: "settings-credential",
        reason: expect.any(String),
      },
    ]);
  });

  test("a change to a carried key changes the identity, a change to another key does not", () => {
    const home = makeHome();
    write(home, ".claude/settings.json", JSON.stringify(settings));
    const before = seedOf(home).identity;

    write(home, ".claude/settings.json", JSON.stringify({ ...settings, outputStyle: "Explanatory" }));
    expect(seedOf(home).identity).toBe(before);

    write(
      home,
      ".claude/settings.json",
      JSON.stringify({ ...settings, enabledPlugins: { "review@team": false } }),
    );
    expect(seedOf(home).identity).not.toBe(before);
  });
});

describe("carried Codex settings keys", () => {
  test("only the allowlisted keys leave config.toml", () => {
    const home = makeHome();
    write(
      home,
      ".codex/config.toml",
      [
        'model = "gpt-5"',
        'model_reasoning_effort = "high"',
        'notify = ["/usr/local/bin/notify-send"]',
        'approval_policy = "never"',
        "",
        "[features]",
        "web_search_request = true",
        "",
        "[model_providers.proxy]",
        'base_url = "https://proxy.example/v1"',
        'env_key = "PROXY_API_KEY"',
        "",
        '[projects."/home/me/work"]',
        'trust_level = "trusted"',
        "",
        "[mcp_servers.docs]",
        'url = "https://docs.example/mcp"',
        "",
      ].join("\n"),
    );

    const entry = seedOf(home).settings.find((candidate) => candidate.harness === "codex");

    expect(JSON.parse(Buffer.from(entry?.bytes ?? []).toString())).toEqual({
      model: "gpt-5",
      model_reasoning_effort: "high",
      features: { web_search_request: true },
    });
  });
});

describe("carried Pi settings keys", () => {
  test("only the allowlisted keys leave settings.json", () => {
    const home = makeHome();
    write(
      home,
      ".pi/agent/settings.json",
      JSON.stringify({
        defaultProvider: "anthropic",
        defaultModel: "claude-sonnet",
        defaultThinkingLevel: "high",
        enabledModels: ["claude-*"],
        enableSkillCommands: true,
        theme: "dark",
        shellPath: "/usr/local/bin/bash",
        npmCommand: ["mise", "exec", "--", "npm"],
        packages: [`https://${tokens[0]![1]}@git.example.com/pi-tools.git`],
        extensions: ["/home/user/pi-extensions"],
      }),
    );

    const entry = seedOf(home).settings.find((candidate) => candidate.harness === "pi");
    const text = Buffer.from(entry?.bytes ?? []).toString();

    expect(JSON.parse(text)).toEqual({
      defaultProvider: "anthropic",
      defaultModel: "claude-sonnet",
      defaultThinkingLevel: "high",
      enabledModels: ["claude-*"],
      enableSkillCommands: true,
    });
    for (const secret of [tokens[0]![1], "packages", "shellPath", "npmCommand", "/home/user"]) {
      expect(text).not.toContain(secret);
    }
  });
});

describe("carried Cursor Agent settings keys", () => {
  test("only the allowlisted keys leave cli-config.json", () => {
    const home = makeHome();
    const model = { modelId: "gpt-5", displayName: "GPT-5" };
    write(
      home,
      ".cursor/cli-config.json",
      JSON.stringify({
        version: 1,
        model,
        maxMode: true,
        hasChangedDefaultModel: true,
        attribution: { attributeCommitsToAgent: false, attributePRsToAgent: false },
        authInfo: { email: "operator@example.com", userId: 1234 },
        permissions: { allow: ["Shell(ls)", "Read(/home/user/**)"], deny: [] },
        statusLine: { type: "command", command: "/usr/local/bin/status-line" },
        approvalMode: "unrestricted",
      }),
    );

    const entry = seedOf(home).settings.find((candidate) => candidate.harness === "cursor");
    const text = Buffer.from(entry?.bytes ?? []).toString();

    expect(JSON.parse(text)).toEqual({
      model,
      maxMode: true,
      hasChangedDefaultModel: true,
      attribution: { attributeCommitsToAgent: false, attributePRsToAgent: false },
    });
    for (const secret of ["authInfo", "operator@example.com", "permissions", "status-line", "approvalMode"]) {
      expect(text).not.toContain(secret);
    }
  });
});

describe("carried Claude hook commands", () => {
  function hooksWith(...commands: string[]) {
    return JSON.stringify({
      hooks: {
        PreToolUse: [
          { matcher: "Bash", hooks: commands.map((command) => ({ type: "command", command })) },
        ],
      },
    });
  }

  test.each([
    "jq -r .tool_input.command",
    "npx --yes prettier --check .",
    '"$CLAUDE_PROJECT_DIR"/.claude/hooks/check.sh',
    "~/.claude/skills/lint/run.sh",
    "bash $HOME/.agents/skills/lint/run.sh",
    "sh ${HOME}/.claude/agents/review.sh",
    "~/.claude/hooks/guard.sh",
    "cat ~/AGENTS.md",
    "/usr/local/bin/notify --title done",
  ])("passes a hook that calls a PATH program, a project path, or a managed path: %s", (command) => {
    const home = makeHome();
    write(home, ".claude/settings.json", hooksWith(command));

    expect(carried(seedOf(home))).toEqual({ hooks: JSON.parse(hooksWith(command)).hooks });
  });

  test.each([
    ["~/bin/guard.sh", "~/bin/guard.sh"],
    ['bash "$HOME/bin/guard"', "$HOME/bin/guard"],
    ["node ${HOME}/scripts/guard.js --strict", "${HOME}/scripts/guard.js"],
    ["~/.claude/skills/../../.ssh/run.sh", "~/.claude/skills/../../.ssh/run.sh"],
    ["~/.codex/skills/lint/run.sh", "~/.codex/skills/lint/run.sh"],
    ["FILE=~/notes.md notify", "~/notes.md"],
  ])("skips a hook that refers to an unmanaged home path and keeps the others: %s", (command, reference) => {
    const home = makeHome();
    write(home, ".claude/settings.json", hooksWith("jq .", command));

    const seed = seedOf(home);

    expect(carried(seed)).toEqual({ hooks: JSON.parse(hooksWith("jq .")).hooks });
    expect(seed.leftovers).toEqual([
      {
        path: join(home, ".claude", "settings.json"),
        code: "hook-path",
        reason: `hook hooks.PreToolUse[0].hooks[1].command refers to ${reference}, outside the managed set`,
      },
    ]);
  });

  test("skips a hook that refers to the operator home by its absolute path, even a managed one", () => {
    const home = makeHome();
    const script = join(home, ".claude", "skills", "lint", "run.sh");
    write(home, ".claude/settings.json", hooksWith("jq .", `bash ${script}`));

    const seed = seedOf(home);

    expect(carried(seed)).toEqual({ hooks: JSON.parse(hooksWith("jq .")).hooks });
    expect(seed.leftovers.map((leftover) => leftover.reason)).toEqual([
      `hook hooks.PreToolUse[0].hooks[1].command refers to ${script}, outside the managed set`,
    ]);
  });

  test("drops a matcher group with no hooks left and an event with no groups left", () => {
    const home = makeHome();
    write(
      home,
      ".claude/settings.json",
      JSON.stringify({
        hooks: {
          PreToolUse: [
            { matcher: "Bash", hooks: [{ type: "command", command: "~/a.sh" }] },
            { matcher: "Edit", hooks: [{ type: "command", command: "jq ." }] },
          ],
          Stop: [{ hooks: [{ type: "command", command: "~/b.sh" }] }],
        },
      }),
    );

    const seed = seedOf(home);

    expect(carried(seed)).toEqual({
      hooks: { PreToolUse: [{ matcher: "Edit", hooks: [{ type: "command", command: "jq ." }] }] },
    });
    expect(seed.leftovers.map((leftover) => leftover.reason)).toEqual([
      "hook hooks.PreToolUse[0].hooks[0].command refers to ~/a.sh, outside the managed set",
      "hook hooks.Stop[0].hooks[0].command refers to ~/b.sh, outside the managed set",
    ]);
  });

  test("the identity follows the carried hooks, not the skipped ones", () => {
    const home = makeHome();
    write(home, ".claude/settings.json", hooksWith("jq ."));
    const before = seedOf(home).identity;

    write(home, ".claude/settings.json", hooksWith("jq .", "~/a.sh"));
    expect(seedOf(home).identity).toBe(before);
  });

  test("refuses a hook path outside the matcher group shape, because it cannot skip one entry", () => {
    const home = makeHome();
    write(home, ".claude/settings.json", JSON.stringify({ hooks: { Stop: { command: "~/a.sh" } } }));

    expect(refusalOf(home).forbidden).toEqual([
      {
        path: join(home, ".claude", "settings.json"),
        code: "hook-path",
        reason: "hook command hooks.Stop.command refers to ~/a.sh, outside the managed set",
      },
    ]);
  });

  test("a token in a carried hook still refuses the seed", () => {
    const home = makeHome();
    write(home, ".claude/settings.json", hooksWith(`notify --token ghp_${"a".repeat(36)}`));

    expect(refusalOf(home).forbidden.map((hit) => hit.code)).toEqual(["github-token"]);
  });
});

describe("carried MCP server declarations", () => {
  function mcpOf(seed: Seed, harness: string): unknown {
    return seed.mcp.find((entry) => entry.harness === harness)?.servers;
  }

  test("carries the remote servers of Claude, Codex, and Cursor Agent as name, type, and URL", () => {
    const home = makeHome();
    write(
      home,
      ".claude.json",
      JSON.stringify({
        oauthAccount: { emailAddress: "operator@example.com" },
        projects: { "/work": { mcpServers: { project: { type: "http", url: "https://p.example/mcp" } } } },
        mcpServers: {
          linear: { type: "http", url: "https://mcp.linear.app/mcp" },
          events: { type: "sse", url: "https://events.example/sse" },
        },
      }),
    );
    write(
      home,
      ".codex/config.toml",
      [
        'model = "o3"',
        "[mcp_servers.linear]",
        'url = "https://mcp.linear.app/mcp"',
        "[mcp_servers.linear.tools.save_issue]",
        'approval_mode = "approve"',
      ].join("\n"),
    );
    write(home, ".cursor/mcp.json", JSON.stringify({ mcpServers: { workos: { url: "https://mcp.workos.com/mcp" } } }));

    const seed = seedOf(home);

    expect(mcpOf(seed, "claude")).toEqual([
      { name: "events", type: "sse", url: "https://events.example/sse" },
      { name: "linear", type: "http", url: "https://mcp.linear.app/mcp" },
    ]);
    expect(mcpOf(seed, "codex")).toEqual([{ name: "linear", type: "http", url: "https://mcp.linear.app/mcp" }]);
    expect(mcpOf(seed, "cursor")).toEqual([{ name: "workos", type: "http", url: "https://mcp.workos.com/mcp" }]);
    expect(JSON.stringify(seed.mcp)).not.toContain("operator@example.com");
    expect(JSON.stringify(seed.mcp)).not.toContain("p.example");
  });

  test("a home without MCP files carries no MCP servers", () => {
    expect(seedOf(makeHome()).mcp).toEqual([]);
  });

  test("skips a server without a command and a plain HTTP server with a note, and carries the rest", () => {
    const home = makeHome();
    write(
      home,
      ".claude.json",
      JSON.stringify({
        mcpServers: {
          repl: { type: "stdio", args: ["repl.js"], env: { API_KEY: "value" } },
          dev: { type: "http", url: "http://localhost:3000/mcp" },
          linear: { type: "http", url: "https://mcp.linear.app/mcp" },
        },
      }),
    );

    const seed = seedOf(home);

    expect(mcpOf(seed, "claude")).toEqual([{ name: "linear", type: "http", url: "https://mcp.linear.app/mcp" }]);
    const notes = seed.leftovers.filter((leftover) => leftover.code === "mcp-local");
    expect(notes).toEqual([
      {
        path: join(home, ".claude.json"),
        code: "mcp-local",
        reason: "MCP server dev is neither a remote HTTPS server nor a stdio command",
      },
      {
        path: join(home, ".claude.json"),
        code: "mcp-local",
        reason: "MCP server repl is neither a remote HTTPS server nor a stdio command",
      },
    ]);
    expect(JSON.stringify(seed)).not.toContain("API_KEY");
  });

  const refused: readonly (readonly [string, Record<string, unknown>])[] = [
    ["headers", { type: "http", url: "https://a.example/mcp", headers: { Authorization: "Bearer x" } }],
    ["an env value", { type: "http", url: "https://a.example/mcp", env: { API_KEY: "x" } }],
    ["arguments", { type: "http", url: "https://a.example/mcp", args: ["--key", "x"] }],
    ["a token query parameter", { type: "http", url: "https://a.example/mcp?api_key=abc" }],
    ["user info in the URL", { type: "http", url: "https://user:pass@a.example/mcp" }],
    ["a token in the URL", { type: "http", url: `https://a.example/ghp_${"a".repeat(36)}/mcp` }],
  ];
  for (const [what, declaration] of refused) {
    test(`refuses a remote Claude server with ${what}, and names only the server`, () => {
      const home = makeHome();
      write(home, ".claude.json", JSON.stringify({ mcpServers: { remote: declaration } }));

      const hits = refusalOf(home).forbidden;

      expect(hits).toEqual([
        {
          path: join(home, ".claude.json"),
          code: "mcp-credential",
          reason: "MCP server remote has headers, environment values, arguments, or a credential",
        },
      ]);
      expect(JSON.stringify(hits)).not.toContain("a.example");
    });
  }

  test("refuses a remote Codex server with HTTP headers or a bearer token variable", () => {
    const home = makeHome();
    write(
      home,
      ".codex/config.toml",
      [
        "[mcp_servers.one]",
        'url = "https://a.example/mcp"',
        'bearer_token_env_var = "ONE_TOKEN"',
        "[mcp_servers.two]",
        'url = "https://b.example/mcp"',
        "[mcp_servers.two.http_headers]",
        'X-Key = "value"',
      ].join("\n"),
    );

    expect(refusalOf(home).forbidden.map((hit) => hit.reason)).toEqual([
      "MCP server one has headers, environment values, arguments, or a credential",
      "MCP server two has headers, environment values, arguments, or a credential",
    ]);
  });

  test("refuses a server name with shell metacharacters without printing it", () => {
    const home = makeHome();
    write(
      home,
      ".cursor/mcp.json",
      JSON.stringify({ mcpServers: { "x'; rm -rf ~; '": { url: "https://a.example/mcp" } } }),
    );

    const hits = refusalOf(home).forbidden;

    expect(hits).toEqual([
      {
        path: join(home, ".cursor", "mcp.json"),
        code: "mcp-name",
        reason: "an MCP server name has characters other than letters, digits, dot, underscore, and hyphen",
      },
    ]);
  });

  test("carries a URL with shell metacharacters as data", () => {
    const home = makeHome();
    const url = "https://a.example/mcp?team=a&b=$(id)'`";
    write(home, ".cursor/mcp.json", JSON.stringify({ mcpServers: { team: { url } } }));

    expect(mcpOf(seedOf(home), "cursor")).toEqual([{ name: "team", type: "http", url }]);
  });

  test("refuses an MCP file that does not parse", () => {
    const home = makeHome();
    write(home, ".codex/config.toml", "[mcp_servers\nurl =");

    // The settings read and the MCP read each refuse the file.
    const hit = {
      path: join(home, ".codex", "config.toml"),
      code: "invalid-settings",
      reason: expect.any(String),
    };
    expect(refusalOf(home).forbidden).toEqual([hit, hit]);
  });

  test("carries the stdio servers of Claude, Codex, and Cursor Agent as command, arguments, and env key names", () => {
    const home = makeHome();
    const token = `ghp_${"a".repeat(36)}`;
    write(
      home,
      ".claude.json",
      JSON.stringify({
        mcpServers: {
          github: { type: "stdio", command: "npx", args: ["-y", "@example/github-mcp"], env: { GITHUB_TOKEN: token } },
        },
      }),
    );
    write(
      home,
      ".codex/config.toml",
      [
        "[mcp_servers.docs]",
        'command = "uvx"',
        'args = ["docs-mcp", "--root", "/srv/docs"]',
        'env_vars = ["DOCS_TEAM"]',
        "[mcp_servers.docs.env]",
        'DOCS_KEY = "value-that-stays-here"',
      ].join("\n"),
    );
    write(home, ".cursor/mcp.json", JSON.stringify({ mcpServers: { time: { command: "time-mcp" } } }));

    const seed = seedOf(home);

    expect(mcpOf(seed, "claude")).toEqual([
      { name: "github", type: "stdio", command: "npx", args: ["-y", "@example/github-mcp"], env: ["GITHUB_TOKEN"] },
    ]);
    expect(mcpOf(seed, "codex")).toEqual([
      { name: "docs", type: "stdio", command: "uvx", args: ["docs-mcp", "--root", "/srv/docs"], env: ["DOCS_KEY", "DOCS_TEAM"] },
    ]);
    expect(mcpOf(seed, "cursor")).toEqual([{ name: "time", type: "stdio", command: "time-mcp", args: [], env: [] }]);
  });

  test("env values never reach the seed or its identity", () => {
    const home = makeHome();
    const token = `ghp_${"b".repeat(36)}`;
    const declare = (value: string) =>
      write(
        home,
        ".claude.json",
        JSON.stringify({ mcpServers: { github: { command: "github-mcp", env: { GITHUB_TOKEN: value } } } }),
      );
    declare(token);
    write(home, ".codex/config.toml", ['[mcp_servers.docs]', 'command = "docs-mcp"', '[mcp_servers.docs.env]', 'DOCS_KEY = "hunter2-docs"'].join("\n"));
    write(home, ".cursor/mcp.json", JSON.stringify({ mcpServers: { db: { command: "db-mcp", env: { DB_PASSWORD: "hunter2-db" } } } }));

    const seed = seedOf(home);
    const text = JSON.stringify(seed, (_, value) => (value instanceof Uint8Array ? Buffer.from(value).toString() : value));

    expect(text).not.toContain(token);
    expect(text).not.toContain("hunter2");
    expect(text).toContain("GITHUB_TOKEN");
    const before = seed.identity;
    declare(`ghp_${"c".repeat(36)}`);
    expect(seedOf(home).identity).toBe(before);
  });

  const secretArguments: readonly (readonly [string, readonly string[], string])[] = [
    ["a token", ["serve", `ghp_${"a".repeat(36)}`], "github-token"],
    ["a --key=value secret", ["--api-key=abc123"], "secret-field"],
    ["a --key value secret", ["--password", "abc123"], "secret-field"],
  ];
  for (const [what, args, rule] of secretArguments) {
    test(`refuses a stdio server with ${what} in its arguments, and names the server and the rule`, () => {
      const home = makeHome();
      write(home, ".cursor/mcp.json", JSON.stringify({ mcpServers: { tool: { command: "tool-mcp", args } } }));

      const hits = refusalOf(home).forbidden;

      expect(hits).toEqual([
        {
          path: join(home, ".cursor", "mcp.json"),
          code: "mcp-argument",
          reason: `MCP server tool has a command or argument that matches the ${rule} rule`,
        },
      ]);
      expect(JSON.stringify(hits)).not.toContain("abc123");
    });
  }

  const credentialCommands: readonly (readonly [string, string, readonly string[], string])[] = [
    ["a URL with a user and a password", "npx", ["server-postgres", "postgresql://alice:example-pass@db.example/app"], "url-credential"],
    ["a URL with a password in a --key=value flag", "tool-mcp", ["--url=postgresql://alice:example-pass@db.example/app"], "url-credential"],
    ["a URL with a password after a flag", "tool-mcp", ["--dsn", "postgresql://alice:example-pass@db.example/app"], "url-credential"],
    ["an HTTPS URL with only a user", "tool-mcp", ["https://example-pass@db.example/app"], "url-credential"],
    ["an HTTP URL with only a user", "tool-mcp", ["http://example-pass@db.example/app"], "url-credential"],
    ["an HTTPS URL with a user and an empty password", "tool-mcp", ["https://example-pass:@db.example/app"], "url-credential"],
    ["a git+https URL with only a user", "uvx", ["--from", "git+https://example-pass@git.example/team/server", "server"], "url-credential"],
    ["a MySQL URL with a password", "tool-mcp", ["mysql://alice:example-pass@db.example/app"], "url-credential"],
    ["a Redis URL with a password", "tool-mcp", ["redis://alice:example-pass@db.example/0"], "url-credential"],
    ["a MongoDB URL with a password", "tool-mcp", ["mongodb://alice:example-pass@db.example/app"], "url-credential"],
    ["an SSH URL with a password", "tool-mcp", ["ssh://git:example-pass@git.example/team/server"], "url-credential"],
    ["a git+ssh URL with a password", "uvx", ["--from", "git+ssh://git:example-pass@git.example/team/server", "server"], "url-credential"],
    ["a git URL with a password", "tool-mcp", ["git://git:example-pass@git.example/team/server"], "url-credential"],
    ["a URL with a password query parameter", "tool-mcp", ["https://db.example/app?sslmode=require&password=example-pass"], "url-credential"],
    ["a URL with a token query parameter", "tool-mcp", ["--url=https://db.example/app?token=example-pass"], "url-credential"],
    ["a URL with an API key query parameter", "tool-mcp", ["https://db.example/app?team=a&api_key=example-pass"], "url-credential"],
    ["a URL with a password inside a longer argument", "tool-mcp", ["connect to 'postgresql://alice:example-pass@db.example/app' now"], "url-credential"],
    ["a secret flag in a shell script", "sh", ["-c", "exec tool --password example-pass"], "secret-field"],
    ["a quoted secret flag in a shell script", "bash", ["-c", 'exec tool --api-key="example-pass"'], "secret-field"],
    ["a URL with a percent-encoded secret query key", "npx", ["server", "https://db.example/app?pa%73sword=example-pass"], "url-credential"],
    ["a URL with a percent-encoded secret query key in upper case", "tool-mcp", ["https://db.example/app?%50%41%53%53%57%4F%52%44=example-pass"], "url-credential"],
    ["a URL with a percent-encoded secret fragment key", "tool-mcp", ["https://db.example/app#tok%65n=example-pass"], "url-credential"],
    ["a URL with a secret query key that is encoded two times", "tool-mcp", ["https://db.example/app?pa%2573sword=example-pass"], "url-credential"],
    ["a URL with a malformed escape in a secret query key", "tool-mcp", ["https://db.example/app?pa%73sword%zz=example-pass"], "url-credential"],
    ["a URL with a malformed escape before a secret query key", "tool-mcp", ["https://db.example/app?name=50%&pa%73sword=example-pass"], "url-credential"],
    ["a URL with a secret query key in an encoded URL", "tool-mcp", ["https://db.example/app?next=https%3A%2F%2Fapi.example%2Fv1%3Ftoken%3Dexample-pass"], "url-credential"],
    ["a URL with a plus sign for a space in a secret query key", "tool-mcp", ["https://db.example/app?api+key=example-pass"], "url-credential"],
    ["a URL with a secret query key after a plus sign", "tool-mcp", ["https://db.example/app?q=a+b&pa%73sword=example-pass"], "url-credential"],
    ["a URL with an encoded secret query key in a --key=value flag", "tool-mcp", ["--url=https://db.example/app?pa%73sword=example-pass"], "url-credential"],
    ["a URL with a percent-encoded user and password", "tool-mcp", ["https://us%65r:p%61ss@db.example/app"], "url-credential"],
    ["a URL with a percent-encoded colon and at sign", "tool-mcp", ["postgresql://alice%3Aexample-pass%40db.example/app"], "url-credential"],
    ["a URL with a scheme in upper case and only a user", "tool-mcp", ["HTTPS://example-pass@db.example/app"], "url-credential"],
    ["a URL with a scheme in mixed case and a secret query key", "tool-mcp", ["hTTps://db.example/app?PASSWORD=example-pass"], "url-credential"],
    ["a git+https URL in mixed case with only a user", "uvx", ["--from", "Git+HTTPS://example-pass@git.example/team/server", "server"], "url-credential"],
    ["an encoded secret query key in a shell script", "bash", ["-cl", 'exec tool "https://db.example/app?pa%73sword=example-pass"'], "url-credential"],
    ["a URL with a password in a query value of another URL", "tool-mcp", ["https://proxy.example/path?next=https://alice:example-pass@backend.example/path"], "url-credential"],
    ["an encoded URL with a password in a query value of another URL", "tool-mcp", ["https://proxy.example/path?next=https%3A%2F%2Falice%3Aexample-pass%40backend.example%2Fpath"], "url-credential"],
    ["a URL with a password after a comma and another URL", "tool-mcp", ["https://db.example/a,https://alice:example-pass@db.example/b"], "url-credential"],
    ["a URL with only a user in a query value of another URL", "tool-mcp", ["https://proxy.example/?next=https://example-pass@backend.example/"], "url-credential"],
    ["a URL with a password in the fragment of another URL", "tool-mcp", ["https://proxy.example/page#https://alice:example-pass@backend.example/"], "url-credential"],
    ["a URL with a password in the path of another URL", "tool-mcp", ["https://archive.example/web/2026/https://alice:example-pass@backend.example/path"], "url-credential"],
    ["a URL with a password that is encoded two times in a URL in a URL", "tool-mcp", ["https://a.example/?u=https%3A%2F%2Fb.example%2F%3Fv%3Dhttps%253A%252F%252Falice%253Aexample-pass%2540c.example"], "url-credential"],
    ["an encoded URL with a password in a flag value", "tool-mcp", ["--next=https%3A%2F%2Falice%3Aexample-pass%40backend.example"], "url-credential"],
    ["a URL with a shell operator in its password", "tool-mcp", ["postgresql://alice:example-pass;more@db.example/app"], "url-credential"],
    ["a secret flag in a shell script with an option group", "bash", ["-cl", "exec tool --password example-pass"], "secret-field"],
    ["a secret flag in a script that is joined to its option", "python3", ["-crun('tool --password example-pass')"], "secret-field"],
    ["a secret flag in a string that env splits", "env", ["-S", "tool --password example-pass"], "secret-field"],
  ];
  for (const [what, command, args, rule] of credentialCommands) {
    test(`refuses a stdio server with ${what}, and names the server and the rule`, () => {
      const home = makeHome();
      write(home, ".cursor/mcp.json", JSON.stringify({ mcpServers: { tool: { command, args } } }));

      const hits = refusalOf(home).forbidden;

      expect(hits).toEqual([
        {
          path: join(home, ".cursor", "mcp.json"),
          code: "mcp-argument",
          reason: `MCP server tool has a command or argument that matches the ${rule} rule`,
        },
      ]);
      expect(JSON.stringify(hits)).not.toContain("example-pass");
    });
  }

  const inlineScripts: readonly (readonly [string, string, readonly string[]])[] = [
    ["an inline sh script", "sh", ["-c", "exec tool serve"]],
    ["an inline script for a shell path", "/bin/sh", ["-c", "exec tool serve"]],
    ["an inline bash login script", "bash", ["-lc", "exec tool serve"]],
    ["an inline bash script after a shell option", "bash", ["-o", "pipefail", "-c", "exec tool serve"]],
    ["an inline zsh script", "zsh", ["-c", "exec tool serve"]],
    ["an inline node script", "node", ["-e", "require('tool').serve()"]],
    ["an inline node script with --eval", "node", ["--input-type=module", "--eval", "serve()"]],
    ["an inline python script", "python3", ["-c", "import tool; tool.serve()"]],
    ["an inline script for a python version", "python3.12", ["-c", "import tool; tool.serve()"]],
    ["an inline deno script", "deno", ["eval", "serve()"]],
    ["an inline node script after a preload option", "node", ["--require", "dotenv/config", "-e", "serve()"]],
    ["an inline node script after a short preload option", "node", ["-r", "dotenv/config", "--import", "tsx", "-e", "serve()"]],
    ["an inline python script after a warning option", "python3", ["-W", "ignore", "-X", "utf8", "-c", "import tool"]],
    ["an inline perl script", "perl", ["-e", "serve()"]],
    ["an inline perl script with -E", "perl", ["-Mstrict", "-E", "serve()"]],
    ["an inline perl script after an include option", "perl", ["-I", "/srv/lib", "-E", "serve()"]],
    ["an inline php script", "php", ["-r", "serve();"]],
    ["an inline ruby script", "ruby", ["-e", "serve"]],
    ["an inline ruby script after a require option", "ruby", ["-r", "json", "-e", "serve"]],
    ["an inline script behind env", "env", ["bash", "-c", "exec tool serve"]],
    ["an inline script in a container", "docker", ["run", "-i", "example/tool", "sh", "-c", "exec tool serve"]],
    ["an inline node script joined to --eval", "node", ["--eval=serve()"]],
    ["an inline node script joined to --print", "node", ["--print=serve()"]],
    ["an inline node script with -pe", "node", ["-pe", "serve()"]],
    ["an inline node script after an option with a value", "node", ["--input-type", "module", "--eval", "serve()"]],
    ["an inline node script after a value that has a space", "node", ["-r", "my module", "-e", "serve()"]],
    ["an inline node script in a data URL", "node", ["--import", "data:text/javascript,serve()", "/srv/server.js"]],
    ["an inline script for nodejs", "nodejs", ["-e", "serve()"]],
    ["an inline tsx script", "npx", ["-y", "tsx", "-e", "serve()"]],
    ["an inline python script joined to its option", "python3", ["-cimport tool"]],
    ["an inline python script in an option group", "python3", ["-uc", "import tool"]],
    ["an inline bash script with c first in the option group", "bash", ["-cl", "exec tool serve"]],
    ["an inline bash script with c in the middle of the option group", "bash", ["-lce", "exec tool serve"]],
    ["an inline bash script after a + option", "bash", ["+x", "-c", "exec tool serve"]],
    ["an inline bash script after a long option", "bash", ["--norc", "-c", "exec tool serve"]],
    ["an inline fish script joined to its option", "fish", ["--command=exec tool serve"]],
    ["an inline fish init script", "fish", ["-C", "exec tool serve"]],
    ["an inline script in a string that env splits", "env", ["-S", "node --eval=serve()"]],
    ["an inline script in a string that env splits after another option", "env", ["-iS", "tool serve"]],
    ["an inline script in a string that env splits with an escape", "env", ["-S", "node\\_--eval=serve()"]],
    ["an inline script in a string for env --split-string", "env", ["--split-string=node /srv/server.js"]],
    ["an inline script in a separate string for env --split-string", "env", ["--split-string", "node /srv/server.js"]],
    ["an inline npx command", "npx", ["-c", "exec tool serve"]],
    ["an inline npx command with --call", "npx", ["--package", "tool", "--call=exec tool serve"]],
    ["an inline npm exec command", "npm", ["exec", "-c", "exec tool serve"]],
    ["an inline deno script in the REPL", "deno", ["repl", "--eval", "serve()"]],
    ["an inline deno script in a data URL", "deno", ["run", "data:text/typescript,serve()"]],
    ["an inline bun script", "bun", ["-e", "serve()"]],
    ["an inline bun script with --eval", "bun", ["--eval", "serve()"]],
    ["an inline bun script joined to --eval", "bun", ["--eval=serve()"]],
    ["an inline bun shell script", "bun", ["exec", "exec tool serve"]],
    ["an inline perl script in a module option", "perl", ['-Mstrict;print "serve"', "/dev/null"]],
    ["an inline perl script joined to its option", "perl", ["-eserve()"]],
    ["an inline ruby script joined to its option", "ruby", ["-eserve"]],
    ["an inline php script with --run", "php", ["--run", "serve();"]],
    ["an inline php script for each input line", "php", ["-R", "serve();"]],
    ["an inline lua script", "lua", ["-e", "serve()"]],
    ["an inline pwsh command", "pwsh", ["-Command", "Start-Tool"]],
    ["an inline pwsh command after an option", "pwsh", ["-NoProfile", "-c", "Start-Tool"]],
    ["an inline encoded pwsh command", "pwsh", ["-EncodedCommand", "UwB0AGEAcgB0AC0AVABvAG8AbAA="]],
    ["an inline powershell command without an option", "powershell", ["Start-Tool"]],
    ["an inline cmd command", "cmd", ["/c", "tool serve"]],
    ["an inline cmd command in upper case", "cmd.exe", ["/D", "/S", "/C", "tool serve"]],
    ["an inline script for a busybox shell", "busybox", ["sh", "-c", "exec tool serve"]],
    ["an inline script for the busybox ash shell", "busybox", ["ash", "-c", "exec tool serve"]],
    ["an inline script behind env with an option", "env", ["-i", "bash", "-c", "exec tool serve"]],
    ["an inline script behind env with a variable", "env", ["NODE_ENV=production", "node", "-e", "serve()"]],
    ["an inline script behind nice", "nice", ["-n", "5", "bash", "-c", "exec tool serve"]],
    ["an inline script behind timeout", "timeout", ["60", "sh", "-c", "exec tool serve"]],
    ["an inline script behind nohup", "nohup", ["python3", "-c", "import tool"]],
    ["an inline script behind sudo", "sudo", ["-u", "tool", "bash", "-c", "exec tool serve"]],
    ["an inline script behind uv", "uv", ["run", "python", "-c", "import tool"]],
    ["an inline script in a container after options", "docker", ["run", "--rm", "-i", "example/tool", "sh", "-c", "exec tool serve"]],
  ];
  const unknownOptions: readonly (readonly [string, string, readonly string[]])[] = [
    ["a node script option after an unknown option with a value", "node", ["--experimental-default-type", "module", "--eval", "serve()"]],
    ["a python script option after an unknown option", "python3", ["-Z", "value", "-c", "import tool"]],
    ["a python script option in a group with an unknown option", "python3", ["-Zc", "import tool"]],
    ["a script option after a script file and an unknown option", "node", ["--some-new-option", "/srv/server.js", "-p", "3000"]],
    ["a script option for a container entry point", "docker", ["run", "-i", "--entrypoint", "sh", "example/tool", "-c", "exec tool serve"]],
    ["a script option for a joined container entry point", "docker", ["run", "-i", "--entrypoint=python3", "example/tool", "-c", "import tool"]],
    ["a script option for an interpreter image after a long option", "docker", ["run", "-i", "--rm", "node:22", "-e", "serve()"]],
    ["a pwsh option that Ferry does not know", "pwsh", ["-NoExit", "/srv/server.ps1"]],
  ];
  for (const [what, command, args] of unknownOptions) {
    test(`skips a stdio server with ${what}, and says that Ferry cannot classify the options`, () => {
      const home = makeHome();
      write(home, ".cursor/mcp.json", JSON.stringify({ mcpServers: { tool: { command, args }, other: { command: "other-mcp" } } }));

      const seed = seedOf(home);

      expect(mcpOf(seed, "cursor")).toEqual([{ name: "other", type: "stdio", command: "other-mcp", args: [], env: [] }]);
      expect(seed.leftovers.filter((leftover) => leftover.code === "mcp-script")).toEqual([
        {
          path: join(home, ".cursor", "mcp.json"),
          code: "mcp-script",
          reason:
            "MCP server tool runs a shell or interpreter with options that Ferry cannot classify. Remove the options that come before the script file, or run the server through a tool on the PATH",
        },
      ]);
      expect(readMcpSources(home, BUILTIN_HARNESSES)).toEqual([
        { harness: "cursor", servers: mcpOf(seed, "cursor") as never, nonPortable: [{ name: "tool", reason: "unknown-options" }] },
      ]);
    });
  }

  for (const [what, command, args] of inlineScripts) {
    test(`skips a stdio server with ${what}, and says what to do`, () => {
      const home = makeHome();
      write(home, ".cursor/mcp.json", JSON.stringify({ mcpServers: { tool: { command, args }, other: { command: "other-mcp" } } }));

      const seed = seedOf(home);

      expect(mcpOf(seed, "cursor")).toEqual([{ name: "other", type: "stdio", command: "other-mcp", args: [], env: [] }]);
      expect(seed.leftovers.filter((leftover) => leftover.code === "mcp-script")).toEqual([
        {
          path: join(home, ".cursor", "mcp.json"),
          code: "mcp-script",
          reason:
            "MCP server tool runs an inline shell or interpreter script, which Ferry cannot check. Put the script in a file that Ferry carries, or run the server through a tool on the PATH",
        },
      ]);
      expect(readMcpSources(home, BUILTIN_HARNESSES)).toEqual([
        { harness: "cursor", servers: mcpOf(seed, "cursor") as never, nonPortable: [{ name: "tool", reason: "inline-script" }] },
      ]);
    });
  }

  const portableCommands: readonly (readonly [string, string, readonly string[]])[] = [
    ["a URL without a user", "npx", ["server-postgres", "postgresql://db.example:5432/app?sslmode=require"]],
    ["a package", "npx", ["-y", "some-server"]],
    ["a port", "tool-mcp", ["--port", "5432"]],
    ["a placeholder password in a URL", "tool-mcp", ["postgresql://alice:xxxx@db.example/app"]],
    ["a placeholder token query parameter", "tool-mcp", ["https://db.example/app?token=xxxx"]],
    ["a package at a git ref", "uvx", ["--from", "git+https://git.example/team/server@v1", "server"]],
    ["an SSH URL with a login name", "tool-mcp", ["ssh://git@git.example/team/server"]],
    ["a PostgreSQL URL with only a user", "tool-mcp", ["postgresql://alice@db.example/app"]],
    ["a MySQL URL with only a user", "tool-mcp", ["mysql://alice@db.example/app"]],
    ["a Redis URL with only a user", "tool-mcp", ["redis://alice@db.example/0"]],
    ["a MongoDB URL with only a user", "tool-mcp", ["mongodb://alice@db.example/app"]],
    ["a git+ssh URL with a login name", "uvx", ["--from", "git+ssh://git@git.example/team/server@v1", "server"]],
    ["a git URL with a login name", "tool-mcp", ["git://git@git.example/team/server"]],
    ["an SSH URL with a login name and an empty password", "tool-mcp", ["SSH://git:@git.example/team/server"]],
    ["a script file with its own options", "node", ["/srv/server.js", "-c", "/etc/server.json", "-e", "prod"]],
    ["a python module", "python3", ["-E", "-m", "some_server"]],
    ["a command with a working directory", "env", ["-C", "/srv/tool", "tool-mcp"]],
    ["a shell script file", "bash", ["/srv/run.sh"]],
    ["a script file after a preload option", "node", ["-r", "dotenv/config", "/srv/server.js", "-e", "prod"]],
    ["a ruby script file after a require option", "ruby", ["-r", "json", "/srv/server.rb", "-e", "prod"]],
    ["a php script file", "php", ["/srv/server.php", "-r", "prod"]],
    ["a URL with percent-encoded query text", "tool-mcp", ["https://db.example/app?q=50%25&mode=a+b&name=caf%C3%A9"]],
    ["a URL with a malformed escape in a query key", "tool-mcp", ["https://db.example/app?na%zzme=value&rate=50%"]],
    ["a URL with a percent-encoded secret query key and a placeholder", "tool-mcp", ["https://db.example/app?pa%73sword=xxxx"]],
    ["a URL with a percent-encoded login name", "tool-mcp", ["postgresql://al%69ce@db.example/app"]],
    ["an SSH URL with a login name in a query value of another URL", "tool-mcp", ["https://proxy.example/?next=ssh://git@git.example/team/server"]],
    ["an encoded SSH URL with a login name in a query value of another URL", "tool-mcp", ["https://proxy.example/?next=ssh%3A%2F%2Fgit%40git.example%2Fteam%2Fserver"]],
    ["a login name and a host in a query value of a URL", "tool-mcp", ["https://proxy.example/?next=git@git.example:team/server.git"]],
    ["a URL with a mail address in a query value of another URL", "tool-mcp", ["https://proxy.example/?next=https://backend.example/?to=alice@mail.example"]],
    ["a node script file with an option for the script", "node", ["/srv/server.js", "-c", "conf.json"]],
    ["a node script file after a known option", "node", ["--enable-source-maps", "/srv/dist/index.js", "-p", "3000"]],
    ["a node script file after an unknown option", "node", ["--some-new-option", "/srv/server.js", "--port", "3000"]],
    ["a node script file after an option with a joined value", "node", ["--max-old-space-size=4096", "/srv/server.js", "-e", "prod"]],
    ["a python script file", "python3", ["server.py"]],
    ["a python module without options", "python3", ["-m", "some_server"]],
    ["a python module with an option for the module", "python3", ["-m", "some_server", "-c", "conf.yaml"]],
    ["a python script file after a known option", "python3", ["-u", "/srv/server.py", "-c", "conf.yaml"]],
    ["a shell script file with an option for the script", "bash", ["-l", "/srv/run.sh", "-c", "conf"]],
    ["a perl script file after a module option", "perl", ["-Mstrict", "-I/srv/lib", "/srv/server.pl", "-e", "prod"]],
    ["a package with an option for the package", "npx", ["-y", "some-server", "-c", "conf.json"]],
    ["an npm script", "npm", ["run", "start"]],
    ["a deno script file", "deno", ["run", "--allow-net", "/srv/server.ts", "-p", "3000"]],
    ["a bun script file", "bun", ["run", "/srv/server.ts", "-e", "prod"]],
    ["a pwsh script file", "pwsh", ["-NoProfile", "-File", "/srv/server.ps1", "-Command", "prod"]],
    ["a script file behind env", "env", ["-i", "NODE_ENV=production", "node", "/srv/server.js"]],
    ["a script file behind nice", "nice", ["-n", "5", "node", "/srv/server.js", "-e", "prod"]],
    ["a script file behind sudo", "sudo", ["-u", "tool", "node", "/srv/server.js"]],
    ["a python module behind timeout", "timeout", ["60", "python3", "-m", "some_server"]],
    ["a python module behind uv", "uv", ["run", "--with", "mcp", "python", "-m", "some_server"]],
    ["a script file in an interpreter image", "docker", ["run", "-i", "--rm", "python:3.12", "/app/server.py"]],
    ["a script file for a container entry point", "docker", ["run", "-i", "--entrypoint", "node", "example/tool", "/app/server.js"]],
    ["a word that is also an object property", "tool-mcp", ["constructor", "-c", "toString"]],
  ];
  for (const [what, command, args] of portableCommands) {
    test(`carries a stdio server with ${what}`, () => {
      const home = makeHome();
      write(home, ".cursor/mcp.json", JSON.stringify({ mcpServers: { tool: { command, args } } }));

      expect(mcpOf(seedOf(home), "cursor")).toEqual([{ name: "tool", type: "stdio", command, args, env: [] }]);
    });
  }

  test("passes a placeholder or a flag without a value in the arguments", () => {
    const home = makeHome();
    const args = ["--token", "--api-key=", "--verbose", `ghp_${"x".repeat(36)}`];
    write(home, ".cursor/mcp.json", JSON.stringify({ mcpServers: { tool: { command: "tool-mcp", args } } }));

    expect(mcpOf(seedOf(home), "cursor")).toEqual([{ name: "tool", type: "stdio", command: "tool-mcp", args, env: [] }]);
  });

  test("skips a stdio server that refers to a path in the home, and reports it", () => {
    const home = makeHome();
    write(
      home,
      ".claude.json",
      JSON.stringify({
        mcpServers: {
          local: { command: join(home, "bin", "local-mcp") },
          data: { command: "data-mcp", args: [`--dir=${join(home, "data")}`] },
          system: { command: "/usr/local/bin/system-mcp", args: ["/srv/data"] },
        },
      }),
    );

    const seed = seedOf(home);

    expect(mcpOf(seed, "claude")).toEqual([
      { name: "system", type: "stdio", command: "/usr/local/bin/system-mcp", args: ["/srv/data"], env: [] },
    ]);
    expect(seed.leftovers.filter((leftover) => leftover.code === "mcp-path").map((leftover) => leftover.reason)).toEqual([
      "MCP server data refers to a path in your home. Use a command on the PATH or a path outside the home",
      "MCP server local refers to a path in your home. Use a command on the PATH or a path outside the home",
    ]);
    expect(readMcpSources(home, BUILTIN_HARNESSES)).toEqual([
      { harness: "claude", servers: mcpOf(seed, "claude") as never, nonPortable: ["data", "local"].map((name) => ({ name, reason: "home-path" })) },
    ]);
  });

  test("skips a stdio server that refers to the home as ~, $HOME, or ${HOME}", () => {
    const home = makeHome();
    write(
      home,
      ".claude.json",
      JSON.stringify({
        mcpServers: {
          brace: { command: "data-mcp", args: ["--dir=${HOME}/data"] },
          command: { command: "~/bin/local-mcp" },
          inside: { command: "data-mcp", args: ["--mount", "type=bind,src=$HOME/data,dst=/data"] },
          other: { command: "data-mcp", args: ["$HOMEBREW_PREFIX/share/data"] },
          shell: { command: "sh", args: ["-c", 'exec node "$HOME/private/server.js"'] },
          tilde: { command: "node", args: ["~/private/server.js"] },
          variable: { command: "node", args: ["$HOME/private/server.js"] },
        },
      }),
    );

    const seed = seedOf(home);

    expect(mcpOf(seed, "claude")).toEqual([
      { name: "other", type: "stdio", command: "data-mcp", args: ["$HOMEBREW_PREFIX/share/data"], env: [] },
    ]);
    const skipped = ["brace", "command", "inside", "shell", "tilde", "variable"];
    expect(seed.leftovers.filter((leftover) => leftover.code === "mcp-path").map((leftover) => leftover.reason)).toEqual(
      skipped.map((name) => `MCP server ${name} refers to a path in your home. Use a command on the PATH or a path outside the home`),
    );
    expect(readMcpSources(home, BUILTIN_HARNESSES)).toEqual([
      { harness: "claude", servers: mcpOf(seed, "claude") as never, nonPortable: skipped.map((name) => ({ name, reason: "home-path" })) },
    ]);
  });

  const NODE_REPL = "/Applications/ChatGPT.app/Contents/Resources/cua_node/bin/node_repl";
  const APP_BUNDLE_REASON = (name: string) => `MCP server ${name} runs from a macOS app bundle, which the box does not have`;

  test("skips the node_repl server of the ChatGPT app in the Claude, Codex, and Cursor Agent files", () => {
    const home = makeHome();
    const json = JSON.stringify({
      mcpServers: {
        node_repl: { command: NODE_REPL, env: { BROWSER_USE_AVAILABLE_BACKENDS: "chrome", NODE_REPL_NODE_PATH: "/usr/bin/node" } },
        time: { command: "time-mcp" },
      },
    });
    write(home, ".claude.json", json);
    write(home, ".cursor/mcp.json", json);
    write(
      home,
      ".codex/config.toml",
      [
        "[mcp_servers.node_repl]",
        `command = "${NODE_REPL}"`,
        "",
        "[mcp_servers.node_repl.env]",
        'BROWSER_USE_AVAILABLE_BACKENDS = "chrome"',
        'NODE_REPL_NODE_PATH = "/usr/bin/node"',
        "",
      ].join("\n"),
    );

    const seed = seedOf(home);

    const time = { name: "time", type: "stdio", command: "time-mcp", args: [], env: [] };
    expect(seed.mcp).toEqual([
      { harness: "claude", servers: [time], appBundle: ["node_repl"] },
      { harness: "codex", servers: [], appBundle: ["node_repl"] },
      { harness: "cursor", servers: [time], appBundle: ["node_repl"] },
    ] as never);
    expect(seed.leftovers.filter((leftover) => leftover.code === "mcp-app-bundle")).toEqual(
      [".claude.json", ".codex/config.toml", ".cursor/mcp.json"].map((file) => ({
        path: join(home, file),
        code: "mcp-app-bundle",
        reason: APP_BUNDLE_REASON("node_repl"),
      })),
    );
    const skipped = [{ name: "node_repl", reason: "app-bundle" }];
    expect(readMcpSources(home, BUILTIN_HARNESSES)).toEqual([
      { harness: "claude", servers: [time], nonPortable: skipped },
      { harness: "codex", servers: [], nonPortable: skipped },
      { harness: "cursor", servers: [time], nonPortable: skipped },
    ] as never);
  });

  test("skips a stdio server with an app bundle path at any place, also in the home and in an argument", () => {
    const home = makeHome();
    write(
      home,
      ".claude.json",
      JSON.stringify({
        mcpServers: {
          argument: { command: "node", args: ["/Applications/Tool.app/Contents/Resources/server.js"] },
          flag: { command: "tool-mcp", args: ["--helper=/System/Applications/Utilities/Terminal.app/Contents/MacOS/Terminal"] },
          home: { command: join(home, "Applications", "X.app", "Contents", "MacOS", "x") },
          lower: { command: "/applications/x.app/contents/macos/x" },
          nested: { command: "/Applications/Outer.app/Contents/Frameworks/Inner.app/Contents/MacOS/inner" },
          shell: { command: "sh", args: ["-c", "exec '/Applications/My Tool.app/Contents/MacOS/tool' serve"] },
          tilde: { command: "~/Applications/X.app/Contents/MacOS/x" },
        },
      }),
    );

    const seed = seedOf(home);

    const skipped = ["argument", "flag", "home", "lower", "nested", "shell", "tilde"];
    expect(seed.mcp).toEqual([{ harness: "claude", servers: [], appBundle: skipped }]);
    expect(seed.leftovers.map((leftover) => [leftover.code, leftover.reason])).toEqual(
      skipped.map((name) => ["mcp-app-bundle", APP_BUNDLE_REASON(name)]),
    );
    expect(readMcpSources(home, BUILTIN_HARNESSES)).toEqual([
      { harness: "claude", servers: [], nonPortable: skipped.map((name) => ({ name, reason: "app-bundle" })) },
    ]);
  });

  test("carries a stdio server whose path only looks like an app bundle path", () => {
    const home = makeHome();
    const servers = {
      contents: { command: "/srv/Contents/bin/x" },
      data: { command: "/srv/myapp.app-data/bin/x" },
      directory: { command: "/opt/foo.app" },
      file: { command: "node", args: ["/srv/web.app/server.js"] },
      other: { command: "/opt/foo.app/ContentsOld/x" },
      suffix: { command: "/opt/foo.application/Contents/x" },
    };
    write(home, ".cursor/mcp.json", JSON.stringify({ mcpServers: servers }));

    const seed = seedOf(home);

    expect(seed.mcp).toEqual([
      {
        harness: "cursor",
        servers: Object.entries(servers).map(([name, server]) => ({ name, type: "stdio", args: [], env: [], ...server })),
      },
    ] as never);
    expect(seed.leftovers).toEqual([]);
  });

  test("a credential in the arguments of an app bundle server still refuses the seed", () => {
    const home = makeHome();
    write(home, ".cursor/mcp.json", JSON.stringify({ mcpServers: { node_repl: { command: NODE_REPL, args: ["--api-key=abc123"] } } }));

    expect(refusalOf(home).forbidden.map((hit) => [hit.code, hit.reason])).toEqual([
      ["mcp-argument", "MCP server node_repl has a command or argument that matches the secret-field rule"],
    ]);
  });

  test("the identity does not change when only a skipped app bundle server is there", () => {
    const home = makeHome();
    const before = seedOf(home).identity;

    write(home, ".cursor/mcp.json", JSON.stringify({ mcpServers: { node_repl: { command: NODE_REPL } } }));
    expect(seedOf(home).identity).toBe(before);
  });

  test("the identity follows the carried MCP servers", () => {
    const home = makeHome();
    write(home, ".cursor/mcp.json", JSON.stringify({ mcpServers: { a: { url: "https://a.example/mcp" } } }));
    const before = seedOf(home).identity;

    write(home, ".cursor/mcp.json", JSON.stringify({ mcpServers: { a: { url: "https://b.example/mcp" } } }));
    expect(seedOf(home).identity).not.toBe(before);
  });
});

describe("carried project files", () => {
  const bytes = (text: string) => new TextEncoder().encode(text);

  test("a name rule that refuses applies, and a skip rule does not", () => {
    expect(carriedNameHit("app/id_ed25519")?.code).toBe("private-key");
    expect(carriedNameHit("auth.json")?.code).toBe("credentials");
    expect(carriedNameHit(".env.local")?.code).toBe("dotenv");
    expect(carriedNameHit(".claude/settings.local.json")).toBeNull();
    expect(carriedNameHit("data/dev.db")).toBeNull();
  });

  test("an environment file passes the name check only with allowEnv", () => {
    expect(carriedNameHit(".env", { allowEnv: true })).toBeNull();
    expect(carriedNameHit("auth.json", { allowEnv: true })?.code).toBe("credentials");
  });

  test("content rules refuse tokens, private keys, secret fields, and binaries", () => {
    const codes = (path: string, body: Uint8Array) => carriedContentHits(path, body).map((hit) => hit.code);
    expect(codes("notes.md", bytes(`token ghp_${"a".repeat(36)}`))).toEqual(["github-token"]);
    expect(codes("notes.md", bytes("-----BEGIN OPENSSH PRIVATE KEY-----\n"))).toEqual(["private-key"]);
    expect(codes("config.json", bytes('{"password":"hunter2"}'))).toEqual(["secret-field"]);
    expect(codes("tool", new Uint8Array([0x7f, 0x45, 0x4c, 0x46, 2, 1, 1, 0]))).toEqual(["executable"]);
    expect(codes("draft.mdx", bytes("# Draft\n"))).toEqual([]);
  });

  test("a secret-field reason names a key of only letters, digits, dot, underscore, and hyphen, up to 64 characters", () => {
    const reasons = (keys: readonly string[]) =>
      carriedContentHits("config.json", bytes(JSON.stringify(Object.fromEntries(keys.map((key) => [key, "hunter2"]))))).map((hit) => hit.reason);
    const long = `secret_${"a".repeat(57)}`;

    expect(reasons(["db.api-key_2", long])).toEqual([
      "key db.api-key_2 holds a password or secret",
      `key ${long} holds a password or secret`,
    ]);
    // A JSON key is free text, so it can hold a value. Such a key is not printed, and two of them give one hit.
    expect(reasons(["secret of alice: swordfish", `${long}a`, "token\nline", "password"])).toEqual([
      "a key holds a password or secret",
      "key password holds a password or secret",
    ]);
  });

  test("the printed form of a URL has a mark in the place of each credential, and a login name stays", () => {
    const secret = "box-only" + "-password";
    const cases: [string, string][] = [
      [`https://alice:${secret}@example.invalid/app.git`, "https://[credential]@example.invalid/app.git"],
      [`https://${secret}@example.invalid/app.git`, "https://[credential]@example.invalid/app.git"],
      [`ssh://git:${secret}@example.invalid/app.git`, "ssh://[credential]@example.invalid/app.git"],
      [`https://example.invalid/app.git?access_token=${secret}`, "https://example.invalid/app.git?access_token=[credential]"],
      [`https://example.invalid/app.git?a=1&pa%73sword=${secret}&b=2`, "https://example.invalid/app.git?a=1&pa%73sword=[credential]&b=2"],
      [`https://alice:pa%40ss${secret}@example.invalid/app.git`, "https://[credential]@example.invalid/app.git"],
      [`fatal: unable to access 'https://alice:${secret}@example.invalid/app.git/': Could not resolve host`, "fatal: unable to access 'https://[credential]@example.invalid/app.git/': Could not resolve host"],
      // A login name is not a credential.
      ["ssh://git@example.invalid/app.git", "ssh://git@example.invalid/app.git"],
      ["git@example.invalid:you/app.git", "git@example.invalid:you/app.git"],
      ["https://example.invalid/app.git?ref=main", "https://example.invalid/app.git?ref=main"],
      ["/home/user/origin.git", "/home/user/origin.git"],
    ];

    for (const [text, printed] of cases) expect([text.replaceAll(secret, "<secret>"), redactUrlCredentials(text)]).toEqual([text.replaceAll(secret, "<secret>"), printed]);
    expect(cases.map(([text]) => redactUrlCredentials(text)).join("\n")).not.toContain(secret);
  });

  test("the MCP argument rule and the printed form agree on each URL, also for a URL inside a URL", () => {
    const secret = "box-only" + "-password";
    // The text, and its printed form. A text that stays has no credential.
    const cases: [string, string][] = [
      // The inputs of the review.
      [`https://proxy/path?next=https://alice:${secret}@backend/path`, "https://proxy/path?next=https://[credential]@backend/path"],
      [`https://proxy/path?next=https%3A%2F%2Falice%3A${secret}%40backend%2Fpath`, "https://proxy/path?next=https%3A%2F%2F[credential]%40backend%2Fpath"],
      [`https://host/a,https://alice:${secret}@host/b`, "https://host/a,https://[credential]@host/b"],
      // A URL in a URL in a URL, plain and encoded.
      [`https://a.example/?u=https://b.example/?v=https://alice:${secret}@c.example/`, "https://a.example/?u=https://b.example/?v=https://[credential]@c.example/"],
      [`https://a.example/?u=https://b.example/?v=https%3A%2F%2Falice%3A${secret}%40c.example`, "https://a.example/?u=https://b.example/?v=https%3A%2F%2F[credential]%40c.example"],
      [
        `https://a.example/?u=https%3A%2F%2Fb.example%2F%3Fv%3Dhttps%253A%252F%252Falice%253A${secret}%2540c.example`,
        "https://a.example/?u=https%3A%2F%2Fb.example%2F%3Fv%3Dhttps%253A%252F%252F[credential]%2540c.example",
      ],
      [`https://a.example/?u=https%3A%2F%2Fb.example%2F%3Ftoken%3D${secret}`, "https://a.example/?u=https%3A%2F%2Fb.example%2F%3Ftoken%3D[credential]"],
      // The fragment, the path, and a text without an outer URL.
      [`https://host/page#https://alice:${secret}@backend/`, "https://host/page#https://[credential]@backend/"],
      [`https://archive.example/web/2026/https://alice:${secret}@backend/path`, "https://archive.example/web/2026/https://[credential]@backend/path"],
      [`--next=https%3A%2F%2Falice%3A${secret}%40backend`, "--next=https%3A%2F%2F[credential]%40backend"],
      // A token in the place of the user, in an HTTP URL.
      [`https://proxy/?next=https://${secret}@backend/`, "https://proxy/?next=https://[credential]@backend/"],
      [`https://proxy/?next=git%2Bhttps%3A%2F%2F${secret}%40backend`, "https://proxy/?next=git%2Bhttps%3A%2F%2F[credential]%40backend"],
      // After a separator.
      [`https://host/a;https://alice:${secret}@host/b`, "https://host/a;https://[credential]@host/b"],
      [`https://host/a|https://alice:${secret}@host/b`, "https://host/a|https://[credential]@host/b"],
      [`url=https://alice:${secret}@host/b`, "url=https://[credential]@host/b"],
      [`(https://alice:${secret}@host/b)`, "(https://[credential]@host/b)"],
      [`"https://host/a","https://alice:${secret}@host/b"`, '"https://host/a","https://[credential]@host/b"'],
      [`'https://alice:${secret}@host/b'`, "'https://[credential]@host/b'"],
      [`https://host/a https://alice:${secret}@host/b\thttps://host/c\n`, "https://host/a https://[credential]@host/b\thttps://host/c\n"],
      [`https://alice:${secret}@host/a,https://bob:${secret}@host/b`, "https://[credential]@host/a,https://[credential]@host/b"],
      // The forms of #241 and #243.
      [`postgresql://alice:${secret}@db.example/app`, "postgresql://[credential]@db.example/app"],
      [`postgresql://alice%3A${secret}%40db.example/app`, "postgresql://[credential]%40db.example/app"],
      [`https://alice:pa;ss${secret}@db.example/app`, "https://[credential]@db.example/app"],
      [`https://db.example/app?pa%2573sword=${secret}#tok%65n=${secret}`, "https://db.example/app?pa%2573sword=[credential]#tok%65n=[credential]"],
      [`https://db.example/app?q=a+b&api+key=${secret}`, "https://db.example/app?q=a+b&api+key=[credential]"],
      // A login name, a host, and a placeholder stay.
      ...[
        "ssh://git@example.invalid/app.git",
        "git+ssh://git@example.invalid/team/server@v1",
        "git@example.invalid:you/app.git",
        "postgresql://alice@db.example/app",
        "SSH://git:@example.invalid/app.git",
        "https://proxy/?next=ssh://git@example.invalid/app.git",
        "https://proxy/?next=ssh%3A%2F%2Fgit%40example.invalid%2Fapp.git",
        "https://proxy/?next=git@example.invalid:you/app.git",
        "https://proxy/?next=https://backend/?to=alice@mail.example",
        "https://registry.example/@scope/package",
        "https://host/a,https://host/b",
        "https://alice:xxxx@host/a,https://host/b?token=xxxx",
        "https://db.example/app?q=50%25&mode=a+b&name=caf%C3%A9",
        "https://db.example/app?na%zzme=value&rate=50%",
        "rate=50% next?token=value",
        "",
      ].map((text): [string, string] => [text, text]),
    ];

    for (const [text, printed] of cases) {
      const shown = text.replaceAll(secret, "<secret>");
      expect([shown, redactUrlCredentials(text), hasUrlCredential(text)]).toEqual([shown, printed, printed !== text]);
    }
  });

  test("a URL that is encoded more times than Ferry decodes counts as a credential", () => {
    const secret = "box-only" + "-password";
    const encoded = (rounds: number) => Array.from({ length: rounds }).reduce<string>((text) => encodeURIComponent(text), `https://alice:${secret}@backend`);

    for (const rounds of [1, 4, 8]) {
      const printed = redactUrlCredentials(`https://proxy/?next=${encoded(rounds)}`);
      expect([rounds, printed.startsWith("https://proxy/?next=https%"), printed.includes("[credential]"), printed.includes(secret)]).toEqual([rounds, true, true, false]);
    }
    expect(redactUrlCredentials(`see https://proxy/?next=${encoded(9)} now`)).toBe("see [credential] now");
    expect(hasUrlCredential(`https://proxy/?next=${encoded(9)}`)).toBe(true);
    // A short text is enough: Ferry stops after a fixed number of rounds and does not keep a copy for each round.
    expect(redactUrlCredentials(`https://proxy/?q=%${"25".repeat(200)}41`)).toBe("[credential]");
    expect(redactUrlCredentials(`see https://proxy/?q=${encoded(9).replace(secret, "xxxx")} now`)).toBe("see [credential] now");
  });

  test("the URL check and the token check of a long line take a time in proportion to its length", () => {
    const size = 128 * 1024;
    const line = (unit: string, start = "", length = size) => start + unit.repeat(Math.ceil(length / unit.length));
    const lines = [
      line("https://"),
      line("%"),
      line("a"),
      line("a:a@", "https://"),
      line("https://a:a@a/"),
      line("a", "https://host/path?"),
      line("a", "https://host/path?q="),
      line("%41", "https://host/path?q="),
      // Each round of decoding takes one `25` away. The line is short, because a copy of the line for each round needs much memory.
      line("25", "https://host/path?q=%", 8 * 1024),
      line("a+", "https://host/path?q="),
      line("?a=a"),
      line("x-", "ghp_"),
      line("github_pat_"),
      line("AKIA"),
      JSON.stringify(Array.from({ length: size / 128 }, (_, id) => ({ id, url: `https://api.example/v1/items/${id}?page=2`, text: "a short text with 50% of spaces", data: "QUJD+/==".repeat(4) }))),
    ];

    // A scan that takes a time in proportion to the square of the length needs more than this time for one line.
    const started = performance.now();
    for (const text of lines) {
      redactUrlCredentials(text);
      hasUrlCredential(text);
      redactTokens(text);
      holdsToken(text);
    }
    expect(performance.now() - started).toBeLessThan(5_000);
  }, 120_000);

  test("the printed form of a text has a mark in the place of each token, also without a word boundary before it", () => {
    const token = "gh" + "p_" + "a".repeat(36);
    const aws = "AK" + "IA" + "Q2W3E4R5T6Y7U8I9";

    expect(redactTokens(`notes/${token}.md\0password_${token}\0x${aws}y`)).toBe("notes/[token].md\0password_[token]\0x[token]y");
    expect(redactTokens("ghp_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx and README.md")).toBe("ghp_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx and README.md");
    expect([token, `password_${token}`, "README.md", "ghp_short"].map(holdsToken)).toEqual([true, true, false, false]);
    const grep = (text: string) => Bun.spawnSync(["grep", "-Eq", "--", TOKEN_ERE], { stdin: Buffer.from(`${text}\n`) }).exitCode === 0;
    expect([token, `password_${token}`, aws, "README.md"].map(grep)).toEqual([true, true, true, false]);
  });

  test("an environment file gets the secret-field rule line by line", () => {
    expect(carriedContentHits(".env.local", bytes("PASSWORD=hunter2\n")).map((hit) => hit.code)).toEqual([
      "secret-field",
    ]);
    expect(carriedContentHits(".env.local", bytes("PORT=3000\nPASSWORD=\n"))).toEqual([]);
  });
});

describe("the repository skill", () => {
  test("Manifest carries skills/ferry without a refusal", () => {
    const home = makeHome();
    cpSync(join(import.meta.dir, "..", "skills", "ferry"), join(home, ".agents/skills/ferry"), { recursive: true });

    const seed = seedOf(home);

    expect(names(seed)).toEqual(["ferry"]);
    expect(seed.leftovers).toEqual([]);
  });
});
