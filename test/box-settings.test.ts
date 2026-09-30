import { afterEach, describe, expect, test } from "bun:test";
import { recordProgress } from "./fake-progress.ts";
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
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { parse as parseToml } from "smol-toml";
import {
  BoxSettingsError,
  installBoxPlugins,
  mergeBoxSettings,
  mergeSettings,
} from "../src/box-settings.ts";
import type { LinkResult, RunOptions } from "../src/link.ts";
import type { SeedSettings } from "../src/manifest.ts";
import { BUILTIN_HARNESSES } from "../src/registry/builtin.ts";

const roots: string[] = [];
const KEYS = ["enabledPlugins", "extraKnownMarketplaces"];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function makeRoot(): string {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "ferry-box-settings-")));
  roots.push(root);
  return root;
}

function write(path: string, body: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, body);
}

/** Runs each command in a local shell, as the box would, with an optional PATH prefix. */
class ShellLink {
  readonly calls: { command: string; options?: RunOptions }[] = [];
  /** The stdout and stderr of each command, as Ferry receives them. */
  readonly outputs: string[] = [];

  constructor(private readonly path?: string) {}

  async run(command: string, options?: RunOptions): Promise<LinkResult> {
    this.calls.push({ command, options });
    const process = Bun.spawn(["sh", "-c", command], {
      env: { ...Bun.env, PATH: this.path ?? Bun.env.PATH },
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    });
    const [exitCode, stdout, stderr] = await Promise.all([
      process.exited,
      new Response(process.stdout).text(),
      new Response(process.stderr).text(),
    ]);
    this.outputs.push(stdout, stderr);
    if (exitCode !== 0) {
      return {
        ok: false,
        error: { code: "command-failed", origin: "box", message: stderr.trim() || "failed" },
      };
    }
    return { ok: true, address: "test-box", stdout, stderr };
  }
}

function codex(value: Record<string, unknown>): SeedSettings[] {
  return [{ harness: "codex", bytes: Buffer.from(JSON.stringify(value)) }];
}

function carried(value: Record<string, unknown>): SeedSettings[] {
  return [{ harness: "claude", bytes: Buffer.from(`${JSON.stringify(value, null, 2)}\n`) }];
}

describe("mergeSettings", () => {
  test("replaces the carried keys and keeps every other box key", () => {
    const box = JSON.stringify({
      env: { TOKEN: "box-only" },
      permissions: { allow: ["Bash(ls)"] },
      enabledPlugins: { "stale@team": true },
    });

    const merged = mergeSettings(box, { enabledPlugins: { "review@team": true } }, KEYS, "json");

    expect(JSON.parse(merged)).toEqual({
      env: { TOKEN: "box-only" },
      permissions: { allow: ["Bash(ls)"] },
      enabledPlugins: { "review@team": true },
    });
  });

  test("removes a carried key the operator no longer has", () => {
    const box = JSON.stringify({ model: "opus", extraKnownMarketplaces: { old: {} } });

    expect(JSON.parse(mergeSettings(box, {}, KEYS, "json"))).toEqual({ model: "opus" });
  });

  test("a missing box settings file becomes the carried keys", () => {
    const merged = mergeSettings(null, { enabledPlugins: { "review@team": true } }, KEYS, "json");
    expect(JSON.parse(merged)).toEqual({
      enabledPlugins: { "review@team": true },
    });
  });

  test("refuses a box settings file that is not a JSON object", () => {
    expect(() => mergeSettings("[1, 2]", {}, KEYS, "json")).toThrow(BoxSettingsError);
    expect(() => mergeSettings("{ not json", {}, KEYS, "json")).toThrow(BoxSettingsError);
  });

  test("replaces the carried keys in TOML and keeps the other tables", () => {
    const box = [
      'model = "o3"',
      'approval_policy = "never"',
      "",
      "[features]",
      "old_flag = true",
      "",
      "[mcp_servers.docs]",
      'url = "https://docs.example/mcp"',
      "",
    ].join("\n");

    const carried = { model: "gpt-5", features: { new_flag: true } };
    const merged = mergeSettings(box, carried, ["model", "features", "model_verbosity"], "toml");

    expect(Bun.TOML.parse(merged)).toEqual({
      model: "gpt-5",
      approval_policy: "never",
      features: { new_flag: true },
      mcp_servers: { docs: { url: "https://docs.example/mcp" } },
    });
  });

  test("keeps the TOML text and its comments when the carried keys match", () => {
    const box = '# box notes\nmodel = "gpt-5" # pinned\n\n[features]\nnew_flag = true\n';

    const carried = { model: "gpt-5", features: { new_flag: true } };

    expect(mergeSettings(box, carried, ["model", "features"], "toml")).toBe(box);
  });

  test("refuses a box settings file that is not TOML", () => {
    expect(() => mergeSettings("[features\nx =", {}, ["model"], "toml")).toThrow(BoxSettingsError);
  });
});

describe("mergeBoxSettings", () => {
  test("merges into the box settings file and keeps the other keys", async () => {
    const home = makeRoot();
    const path = join(home, ".claude", "settings.json");
    write(
      path,
      JSON.stringify({
        env: { TOKEN: "box-only" },
        apiKeyHelper: "/usr/local/bin/box-key",
        outputStyle: "Explanatory",
        permissions: { allow: ["Bash(rm -rf /tmp/box)"] },
        hooks: { Stop: [] },
      }),
    );
    const hooks = { Stop: [{ hooks: [{ type: "command", command: "notify" }] }] };

    const { written } = await mergeBoxSettings({
      remoteHome: home,
      harnesses: BUILTIN_HARNESSES,
      settings: carried({
        enabledPlugins: { "review@team": true },
        permissions: { allow: ["Bash(git status)"] },
        hooks,
      }),
      link: new ShellLink(),
    });

    expect(written).toEqual([path]);
    expect(JSON.parse(readFileSync(path, "utf8"))).toEqual({
      env: { TOKEN: "box-only" },
      apiKeyHelper: "/usr/local/bin/box-key",
      outputStyle: "Explanatory",
      permissions: { allow: ["Bash(git status)"] },
      hooks,
      enabledPlugins: { "review@team": true },
    });
  });

  test("removes a box-only permission or hook when the operator has none", async () => {
    const home = makeRoot();
    const path = join(home, ".claude", "settings.json");
    write(
      path,
      JSON.stringify({ outputStyle: "Explanatory", permissions: { allow: ["Bash(ls)"] }, hooks: { Stop: [] } }),
    );

    await mergeBoxSettings({
      remoteHome: home,
      harnesses: BUILTIN_HARNESSES,
      settings: carried({ enabledPlugins: { "review@team": true } }),
      link: new ShellLink(),
    });

    expect(JSON.parse(readFileSync(path, "utf8"))).toEqual({
      outputStyle: "Explanatory",
      enabledPlugins: { "review@team": true },
    });
  });

  test("creates a missing box settings file that only the owner can read", async () => {
    const home = makeRoot();
    const path = join(home, ".claude", "settings.json");

    await mergeBoxSettings({
      remoteHome: home,
      harnesses: BUILTIN_HARNESSES,
      settings: carried({ enabledPlugins: { "review@team": true } }),
      link: new ShellLink(),
    });

    expect(JSON.parse(readFileSync(path, "utf8"))).toEqual({ enabledPlugins: { "review@team": true } });
    expect(statSync(path).mode & 0o077).toBe(0);
  });

  test("writes nothing when the box already holds the carried keys", async () => {
    const home = makeRoot();
    const path = join(home, ".claude", "settings.json");
    write(path, `${JSON.stringify({ enabledPlugins: { "review@team": true } }, null, 2)}\n`);
    const link = new ShellLink();

    const { written } = await mergeBoxSettings({
      remoteHome: home,
      harnesses: BUILTIN_HARNESSES,
      settings: carried({ enabledPlugins: { "review@team": true } }),
      link,
    });

    expect(written).toEqual([]);
    expect(link.calls).toHaveLength(1);
  });

  test("merges the carried Codex keys into config.toml", async () => {
    const home = makeRoot();
    const path = join(home, ".codex", "config.toml");
    write(path, 'model = "o3"\n\n[mcp_servers.docs]\nurl = "https://docs.example/mcp"\n');

    const { written } = await mergeBoxSettings({
      remoteHome: home,
      harnesses: BUILTIN_HARNESSES,
      settings: [{ harness: "codex", bytes: Buffer.from(JSON.stringify({ model: "gpt-5" })) }],
      link: new ShellLink(),
    });

    expect(written).toEqual([path]);
    expect(Bun.TOML.parse(readFileSync(path, "utf8"))).toEqual({
      model: "gpt-5",
      mcp_servers: { docs: { url: "https://docs.example/mcp" } },
    });
  });

  test("keeps config.toml and its comments when the carried Codex keys match", async () => {
    const home = makeRoot();
    const path = join(home, ".codex", "config.toml");
    const text = '# box notes\nmodel = "gpt-5" # pinned\n\n[features] # flags\n# one flag\nnew_flag = true\n';
    write(path, text);

    const { written } = await mergeBoxSettings({
      remoteHome: home,
      harnesses: BUILTIN_HARNESSES,
      settings: codex({ model: "gpt-5", features: { new_flag: true } }),
      link: new ShellLink(),
    });

    expect(written).toEqual([]);
    expect(readFileSync(path, "utf8")).toBe(text);
  });

  test("edits only the carried Codex keys and keeps every other line of config.toml", async () => {
    const home = makeRoot();
    const path = join(home, ".codex", "config.toml");
    write(
      path,
      [
        "# box notes",
        'model = "o3" # old',
        'model_verbosity = "high"',
        "features = { old_flag = true }",
        'approval_policy = "never"',
        'notes = """',
        'model = "inside a string"',
        "[features]",
        '"""',
        "",
        "# docs server",
        "[mcp_servers.docs]",
        'command = "docs-mcp"',
        "args = [",
        '  "--model",',
        '  "[features]",',
        "]",
        "",
      ].join("\n"),
    );

    const { written } = await mergeBoxSettings({
      remoteHome: home,
      harnesses: BUILTIN_HARNESSES,
      settings: codex({ model: "gpt-5", features: { new_flag: true, sub: { deep: 1 } } }),
      link: new ShellLink(),
    });

    expect(written).toEqual([path]);
    const merged = readFileSync(path, "utf8");
    expect(Bun.TOML.parse(merged)).toEqual({
      model: "gpt-5",
      approval_policy: "never",
      notes: 'model = "inside a string"\n[features]\n',
      features: { new_flag: true, sub: { deep: 1 } },
      mcp_servers: { docs: { command: "docs-mcp", args: ["--model", "[features]"] } },
    });
    expect(merged).toStartWith('# box notes\nmodel = "gpt-5"\n');
    expect(merged).toContain("# docs server\n[mcp_servers.docs]\n");
  });

  test("replaces a [features] table and its sub-tables in place", async () => {
    const home = makeRoot();
    const path = join(home, ".codex", "config.toml");
    write(path, '[features]\nold = true\n\n[features.sub]\nx = 1\n\n[profiles.fast]\nmodel = "o3"\n');

    await mergeBoxSettings({
      remoteHome: home,
      harnesses: BUILTIN_HARNESSES,
      settings: codex({ features: { new_flag: false } }),
      link: new ShellLink(),
    });

    expect(Bun.TOML.parse(readFileSync(path, "utf8"))).toEqual({
      features: { new_flag: false },
      profiles: { fast: { model: "o3" } },
    });
  });

  test("creates a missing config.toml with the carried Codex keys", async () => {
    const home = makeRoot();
    const path = join(home, ".codex", "config.toml");

    const { written } = await mergeBoxSettings({
      remoteHome: home,
      harnesses: BUILTIN_HARNESSES,
      settings: codex({ model: "gpt-5", features: { new_flag: true } }),
      link: new ShellLink(),
    });

    expect(written).toEqual([path]);
    expect(Bun.TOML.parse(readFileSync(path, "utf8"))).toEqual({ model: "gpt-5", features: { new_flag: true } });
    expect(statSync(path).mode & 0o077).toBe(0);
  });

  test("refuses and keeps a config.toml that awk cannot follow", async () => {
    const home = makeRoot();
    const path = join(home, ".codex", "config.toml");
    write(path, 'model = "o3"\nargs = [\n');

    await expect(
      mergeBoxSettings({
        remoteHome: home,
        harnesses: BUILTIN_HARNESSES,
        settings: codex({ model: "gpt-5" }),
        link: new ShellLink(),
      }),
    ).rejects.toBeInstanceOf(BoxSettingsError);
    expect(readFileSync(path, "utf8")).toBe('model = "o3"\nargs = [\n');
  });

  test("without jq, leaves a JSON settings file as it is and warns, and still merges config.toml", async () => {
    const home = makeRoot();
    const sys = join(home, "sys");
    mkdirSync(sys);
    for (const program of ["sh", "awk", "grep", "mkdir", "mv", "rm", "dirname", "printf"]) {
      const found = Bun.which(program);
      if (found) symlinkSync(found, join(sys, program));
    }
    const claude = join(home, ".claude", "settings.json");
    const codexPath = join(home, ".codex", "config.toml");
    write(claude, JSON.stringify({ enabledPlugins: {} }));
    write(codexPath, 'model = "o3"\n');

    const result = await mergeBoxSettings({
      remoteHome: home,
      harnesses: BUILTIN_HARNESSES,
      settings: [...carried({ enabledPlugins: { "review@team": true } }), ...codex({ model: "gpt-5" })],
      link: new ShellLink(sys),
    });

    expect(result).toEqual({
      written: [codexPath],
      warnings: ["jq is not on the box, so Ferry did not update .claude/settings.json. Run ferry update to install jq."],
    });
    expect(readFileSync(claude, "utf8")).toBe(JSON.stringify({ enabledPlugins: {} }));
    expect(readFileSync(codexPath, "utf8")).toBe('model = "gpt-5"\n');
  });

  test.each([
    ["pi", ".pi/agent/settings.json", { defaultModel: "claude-sonnet" }, { packages: ["npm:pi-tools"] }],
    ["cursor", ".cursor/cli-config.json", { maxMode: true }, { version: 1, authInfo: { userId: 1234 } }],
  ])("merges the carried %s keys and keeps the other box keys", async (harness, file, keys, boxOnly) => {
    const home = makeRoot();
    const path = join(home, file);
    write(path, JSON.stringify(boxOnly));

    const { written } = await mergeBoxSettings({
      remoteHome: home,
      harnesses: BUILTIN_HARNESSES,
      settings: [{ harness, bytes: Buffer.from(JSON.stringify(keys)) }],
      link: new ShellLink(),
    });

    expect(written).toEqual([path]);
    expect(JSON.parse(readFileSync(path, "utf8"))).toEqual({ ...boxOnly, ...keys });
  });

  test("refuses and keeps a box settings file that is not JSON", async () => {
    const home = makeRoot();
    const path = join(home, ".claude", "settings.json");
    write(path, "{ not json");

    await expect(
      mergeBoxSettings({
        remoteHome: home,
        harnesses: BUILTIN_HARNESSES,
        settings: carried({}),
        link: new ShellLink(),
      }),
    ).rejects.toBeInstanceOf(BoxSettingsError);
    expect(readFileSync(path, "utf8")).toBe("{ not json");
  });
});

describe("mergeBoxSettings with quoted keys and hostile TOML", () => {
  const SECRET = `sk-${"t".repeat(40)}`;
  const CODEX_KEYS = BUILTIN_HARNESSES.find((harness) => harness.id === "codex")?.settings?.keys ?? [];
  const MODEL = { model: "new" };
  const FEATURES = { features: { new_flag: true } };

  function box(text: string, value: Record<string, unknown>) {
    const home = makeRoot();
    const path = join(home, ".codex", "config.toml");
    write(path, text);
    const link = new ShellLink();
    const merge = () =>
      mergeBoxSettings({ remoteHome: home, harnesses: BUILTIN_HARNESSES, settings: codex(value), link });
    return { path, link, merge };
  }

  test.each<[string, string, Record<string, unknown>]>([
    ["a unicode escape in a key", '"\\u006dodel" = "old"\n', MODEL],
    ["a long unicode escape in a key", 'other = "keep"\n"\\U0000006Dodel" = "old"\n', MODEL],
    ["a quoted key", '"model" = "old"\n', MODEL],
    ["a literal key", "'model' = 'old'\n", MODEL],
    ["a table with a space in its quoted name", '["model "]\nkeep = "important"\n', MODEL],
    ["an escape in a literal key, which TOML does not decode", "'\\u006dodel' = \"keep\"\n", MODEL],
    ["an escaped quote and an escaped backslash in a key", '"mo\\"del" = "keep"\n"model\\\\" = "keep"\n', MODEL],
    ["an escape outside ASCII in a key", '"mod\\u00e9l" = "keep"\n"model\\n" = "keep"\n', MODEL],
    ["a dotted key after a quoted part", '"a.b".model = "keep"\na."model" = "keep"\n', MODEL],
    [
      "a dotted key under a quoted carried key",
      '"model".name = "old"\n \'model\' . "size" = 1\nother = "keep"\n',
      MODEL,
    ],
    ["a quoted key with a #", '"mo#del" = "keep" # "model" = 1\n\n["a#b"] # [model]\nmodel = "keep"\n', MODEL],
    ["a quoted key with a =", '"model=" = "keep"\n"a = b".model = "keep"\n', MODEL],
    [
      "a key inside a multi-line basic string",
      'notes = """\nmodel = "inside"\n["model"]\n\\""" still inside\n""""\nmodel = "old"\n',
      MODEL,
    ],
    [
      "a key inside a multi-line literal string",
      "notes = '''\nmodel = 'inside'\n[model]\n''\\\n'''\nmodel = \"old\"\n",
      MODEL,
    ],
    [
      "an array of tables",
      '[[model]]\nname = "old"\n\n[["model"]]\nname = "older"\n\n[[other]]\nmodel = "keep"\n',
      MODEL,
    ],
    ["an inline table value", 'model = { name = "old", tags = ["[x]", "}"] }\nother = { model = "keep" }\n', MODEL],
    ["a multi-line array value", 'model = [\n  "a", # "\n  "]",\n]\nother = [\n  "model = 1",\n]\n', MODEL],
    ["CRLF line ends", 'model = "old"\r\nother = "keep"\r\n\r\n[table]\r\nmodel = "keep"\r\n', MODEL],
    ["a byte order mark before a carried key", '﻿model = "old"\nother = "keep"\n', MODEL],
    ["a byte order mark before another key", '﻿other = "keep"\n', MODEL],
    ["no newline at the end", 'other = "keep"\nmodel = "old"', MODEL],
    ["a key that differs only in case", 'Model = "keep"\nMODEL = "keep"\n\n[mODEL]\nmodel = "keep"\n', MODEL],
    [
      "a header with spaces around its parts",
      '[ "model" . sub ]\nx = 1\n\n[ other . "model" ]\nx = "keep"\n',
      MODEL,
    ],
    ["an empty quoted key", '"" = "keep"\n', MODEL],
    [
      "a quoted table name",
      '["features"]\nold = true\n\n[ features . "sub" ]\nx = 1\n\n["features "]\nkeep = true\n\n["a.features"]\nkeep = true\n',
      FEATURES,
    ],
    [
      "an escaped table name",
      'other = "keep"\n\n["f\\u0065atures".sub]\nx = 1\n\n[[\'features\'.list]]\nx = 1\n\n[Features]\nkeep = true\n',
      FEATURES,
    ],
  ])("changes only the carried keys in a file with %s", async (_title, input, value) => {
    const { path, merge } = box(input, value);
    const expected = parseToml(input);
    for (const key of CODEX_KEYS) delete expected[key];

    expect((await merge()).written).toEqual([path]);

    const merged = readFileSync(path, "utf8");
    expect<Record<string, unknown>>(parseToml(merged)).toEqual({ ...expected, ...value });
    // The second merge finds the carried values and writes nothing.
    expect((await merge()).written).toEqual([]);
    expect(readFileSync(path, "utf8")).toBe(merged);
  });

  test("keeps the CRLF line ends and the byte order mark", async () => {
    const { path, merge } = box('﻿model = "old"\r\nother = "keep"\r\n', MODEL);

    await merge();

    expect(readFileSync(path, "utf8")).toBe('﻿model = "new"\r\nother = "keep"\r\n');
  });

  test("repairs a file that holds a carried key in two spellings", async () => {
    const { path, merge } = box('"\\u006dodel" = "old"\nother = "keep"\nmodel = "stale"\n', MODEL);

    await merge();

    expect(readFileSync(path, "utf8")).toBe('model = "new"\nother = "keep"\n');
  });

  test.each<[string, string, number]>([
    ["an escape that TOML does not have in a key", `a = 1\n"mod\\qel" = "${SECRET}"\n`, 2],
    ["a short unicode escape in a key", `"\\u006" = "${SECRET}"\n`, 1],
    ["a quoted key that does not end", `a = 1\n\n"model = ${SECRET}\n`, 3],
    ["a key without a value", `a = 1\n${SECRET}\n`, 2],
    ["a table header that does not end", `[model\nkey = "${SECRET}"\n`, 1],
    ["text after a table header", `[model] key = "${SECRET}"\n`, 1],
    ["a string that does not end", `a = 1\nb = "${SECRET}\n`, 2],
    ["an array that does not end", `model = "o3"\nargs = [\n  "${SECRET}",\n`, 2],
    ["a multi-line string that does not end", `a = """\n${SECRET}\n`, 1],
    ["a bracket that closes nothing", `a = 1\nb = "${SECRET}" ]\n`, 2],
  ])("refuses and keeps a file with %s, and names only the line", async (_title, input, line) => {
    const { path, link, merge } = box(input, MODEL);

    const error = await merge().then(
      () => null,
      (cause: unknown) => cause,
    );

    expect(error).toBeInstanceOf(BoxSettingsError);
    expect((error as Error).message).toBe(
      `${path}: Ferry cannot read line ${line} as TOML, so it left the file unchanged`,
    );
    expect(readFileSync(path, "utf8")).toBe(input);
    expect(existsSync(`${path}.ferry-tmp`)).toBe(false);
    expect(JSON.stringify({ calls: link.calls, outputs: link.outputs })).not.toContain(SECRET);
  });
});

const HAS_JQ = Bun.which("jq") !== null;

/** A test that runs box scripts with a real jq. It skips, and says why, when jq is not on the PATH. */
function jqTest(title: string, run: () => Promise<void>): void {
  test.skipIf(!HAS_JQ)(HAS_JQ ? title : `${title} (skipped: jq is not on the PATH)`, run);
}

describe("box settings secrets", () => {
  const SECRET = `sk-${"s".repeat(40)}`;

  jqTest("never reach Ferry: the box merges each settings file and prints only a status", async () => {
    const home = makeRoot();
    const files = {
      claude: join(home, ".claude", "settings.json"),
      codex: join(home, ".codex", "config.toml"),
      pi: join(home, ".pi", "agent", "settings.json"),
      cursor: join(home, ".cursor", "cli-config.json"),
    };
    write(files.claude, JSON.stringify({ env: { ANTHROPIC_API_KEY: SECRET }, enabledPlugins: { "old@team": true } }));
    write(
      files.codex,
      [
        "# box notes",
        'model = "o3"',
        `experimental_bearer_token = "${SECRET}"`,
        "",
        "[mcp_servers.docs]",
        'command = "docs-mcp"',
        "",
        "[mcp_servers.docs.env]",
        `DOCS_KEY = "${SECRET}"`,
        "",
      ].join("\n"),
    );
    write(files.pi, JSON.stringify({ apiKey: SECRET, defaultModel: "old" }));
    write(files.cursor, JSON.stringify({ authInfo: { token: SECRET }, maxMode: false }));
    const link = new ShellLink();

    const result = await mergeBoxSettings({
      remoteHome: home,
      harnesses: BUILTIN_HARNESSES,
      settings: [
        ...carried({ enabledPlugins: { "review@team": true } }),
        { harness: "codex", bytes: Buffer.from(JSON.stringify({ model: "gpt-5", features: { web_search_request: true } })) },
        { harness: "pi", bytes: Buffer.from(JSON.stringify({ defaultModel: "claude-sonnet" })) },
        { harness: "cursor", bytes: Buffer.from(JSON.stringify({ maxMode: true })) },
      ],
      link,
    });

    expect(JSON.stringify({ calls: link.calls, outputs: link.outputs, result })).not.toContain(SECRET);
    // The box merged the carried keys and kept each value.
    expect(JSON.parse(readFileSync(files.claude, "utf8"))).toEqual({
      env: { ANTHROPIC_API_KEY: SECRET },
      enabledPlugins: { "review@team": true },
    });
    expect(Bun.TOML.parse(readFileSync(files.codex, "utf8"))).toEqual({
      model: "gpt-5",
      experimental_bearer_token: SECRET,
      features: { web_search_request: true },
      mcp_servers: { docs: { command: "docs-mcp", env: { DOCS_KEY: SECRET } } },
    });
    expect(readFileSync(files.codex, "utf8")).toStartWith("# box notes\n");
    expect(JSON.parse(readFileSync(files.pi, "utf8"))).toEqual({ apiKey: SECRET, defaultModel: "claude-sonnet" });
    expect(JSON.parse(readFileSync(files.cursor, "utf8"))).toEqual({ authInfo: { token: SECRET }, maxMode: true });
  });
});

describe("installBoxPlugins", () => {
  const TOKEN = `ghp_${"p".repeat(36)}`;

  /** A fake claude CLI that logs its arguments. It fails for a broken name, and its last line holds a token. */
  function fakeClaude(root: string): { path: string; log: string } {
    const bin = join(root, "bin");
    const log = join(root, "claude.log");
    write(
      join(bin, "claude"),
      [
        "#!/bin/sh",
        `printf '%s\\n' "$*" >> '${log}'`,
        `case "$*" in *broken*) echo "Installing..."; echo "fatal: no access to https://user:${TOKEN}@git.example.com/plugins.git" >&2; exit 1 ;; esac`,
        "exit 0",
      ].join("\n"),
    );
    chmodSync(join(bin, "claude"), 0o755);
    return { path: `${bin}:/usr/bin:/bin`, log };
  }

  test("adds each carried marketplace, then installs each enabled plugin", async () => {
    const root = makeRoot();
    const claude = fakeClaude(root);
    const link = new ShellLink(claude.path);

    const progress = recordProgress();

    const warnings = await installBoxPlugins({
      progress,
      settings: carried({
        enabledPlugins: { "review@team": true, "old@team": false, "broken@team": true },
        extraKnownMarketplaces: {
          team: { source: { source: "github", repo: "example/claude-plugins" } },
          internal: { source: { source: "git", url: "https://git.example.com/plugins.git" } },
          local: { source: { source: "directory", path: "/Users/operator/plugins" } },
        },
      }),
      link,
    });

    expect(readFileSync(claude.log, "utf8").trim().split("\n")).toEqual([
      "plugin marketplace add example/claude-plugins",
      "plugin marketplace add https://git.example.com/plugins.git",
      "plugin install review@team",
      "plugin install broken@team",
    ]);
    expect(warnings).toEqual([
      "marketplace local has a directory source; add it on the box by hand",
      "could not install plugin broken@team: claude plugin install failed on the box. Run it on the box to see the error.",
    ]);
    expect(link.calls).toHaveLength(4);
    expect(link.calls.every((call) => call.options?.agentForwarding === "git")).toBe(true);
    expect(progress.events).toEqual(["count:1/4", "count:2/4", "count:3/4", "count:4/4"]);
  });

  test("reports a failed step with a fixed message, and the claude output stays on the box", async () => {
    const root = makeRoot();
    const link = new ShellLink(fakeClaude(root).path);

    const warnings = await installBoxPlugins({
      settings: carried({
        enabledPlugins: { "broken@team": true },
        extraKnownMarketplaces: { team: { source: { source: "github", repo: "example/broken-plugins" } } },
      }),
      link,
    });

    expect(warnings).toEqual([
      "could not add marketplace team: claude plugin marketplace add failed on the box. Run it on the box to see the error.",
      "could not install plugin broken@team: claude plugin install failed on the box. Run it on the box to see the error.",
    ]);
    expect(JSON.stringify({ outputs: link.outputs, warnings })).not.toContain(TOKEN);
  });

  test("reports a box without the claude CLI and changes nothing", async () => {
    const root = makeRoot();
    const link = new ShellLink(`${join(root, "empty-bin")}:/usr/bin:/bin`);

    const warnings = await installBoxPlugins({
      settings: carried({ enabledPlugins: { "review@team": true, "other@team": true } }),
      link,
    });

    expect(warnings).toEqual(["the claude CLI is not on the box PATH; no plugin was installed"]);
    expect(link.calls).toHaveLength(1);
  });

  test("forwards no agent to a git_auth = box box", async () => {
    const root = makeRoot();
    const link = new ShellLink(fakeClaude(root).path);

    await installBoxPlugins({
      settings: carried({ enabledPlugins: { "review@team": true } }),
      link,
      gitAuth: "box",
    });

    expect(link.calls).toHaveLength(1);
    expect(link.calls[0]?.options?.agentForwarding).toBeUndefined();
  });

  test("runs nothing when no Claude plugin declarations are carried", async () => {
    const link = new ShellLink();

    expect(await installBoxPlugins({ settings: [], link })).toEqual([]);
    expect(await installBoxPlugins({ settings: carried({}), link })).toEqual([]);
    expect(link.calls).toHaveLength(0);
  });
});
