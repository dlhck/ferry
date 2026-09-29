import { afterEach, describe, expect, test } from "bun:test";
import { cpSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { carriedContentHits, carriedNameHit, denyRules, readSeed } from "../src/manifest.ts";
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
        description: "local or non-HTTPS MCP server; only remote HTTPS servers are carried",
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

  test("skips a local server and a plain HTTP server with a note, and carries the rest", () => {
    const home = makeHome();
    write(
      home,
      ".claude.json",
      JSON.stringify({
        mcpServers: {
          repl: { type: "stdio", command: "node", args: ["repl.js"], env: { API_KEY: "value" } },
          dev: { type: "http", url: "http://localhost:3000/mcp" },
          linear: { type: "http", url: "https://mcp.linear.app/mcp" },
        },
      }),
    );

    const seed = seedOf(home);

    expect(mcpOf(seed, "claude")).toEqual([{ name: "linear", type: "http", url: "https://mcp.linear.app/mcp" }]);
    const notes = seed.leftovers.filter((leftover) => leftover.code === "mcp-local");
    expect(notes).toEqual([
      { path: join(home, ".claude.json"), code: "mcp-local", reason: "MCP server dev is not a remote HTTPS server" },
      { path: join(home, ".claude.json"), code: "mcp-local", reason: "MCP server repl is not a remote HTTPS server" },
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
