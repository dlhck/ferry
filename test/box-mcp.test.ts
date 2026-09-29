import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checkBoxMcp, mcpCommand, registerBoxMcp } from "../src/box-mcp.ts";
import type { StdioMcpServer } from "../src/manifest.ts";
import type { LinkResult, RunOptions } from "../src/link.ts";
import { BUILTIN_HARNESSES, BUILTIN_TOOLS } from "../src/registry/builtin.ts";
import { recordProgress } from "./fake-progress.ts";

const directories: string[] = [];

afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

class FakeLink {
  readonly runs: { command: string; options?: RunOptions }[] = [];
  constructor(private readonly answer: (command: string) => LinkResult | Promise<LinkResult>) {}
  async run(command: string, options?: RunOptions): Promise<LinkResult> {
    this.runs.push({ command, options });
    return this.answer(command);
  }
}

function ok(stdout = ""): LinkResult {
  return { ok: true, address: "box", stdout, stderr: "" };
}

const HOSTILE_URL = "https://a.example/mcp?x=$(touch pwned)&y='q'`touch pwned2`";

describe("registerBoxMcp", () => {
  test("declares Claude servers with the claude CLI and keeps a declared server as it is", async () => {
    const link = new FakeLink(() => ok());

    const warnings = await registerBoxMcp({
      remoteHome: "/home/agent",
      harnesses: BUILTIN_HARNESSES,
      tools: BUILTIN_TOOLS,
      mcp: [{ harness: "claude", servers: [{ name: "linear", type: "http", url: "https://mcp.linear.app/mcp" }] }],
      link,
    });

    expect(warnings).toEqual([]);
    expect(link.runs).toHaveLength(1);
    const command = link.runs[0]!.command;
    expect(command).toStartWith("sh -c ");
    expect(command).toContain("command -v claude");
    expect(command).toContain("claude mcp get '\"'\"'linear'\"'\"'");
    expect(command).toContain(
      "claude mcp add --transport '\"'\"'http'\"'\"' --scope user '\"'\"'linear'\"'\"' '\"'\"'https://mcp.linear.app/mcp'\"'\"'",
    );
  });

  test("declares Codex servers with codex mcp add under a timeout", async () => {
    const link = new FakeLink(() => ok());

    await registerBoxMcp({
      remoteHome: "/home/agent",
      harnesses: BUILTIN_HARNESSES,
      tools: BUILTIN_TOOLS,
      mcp: [{ harness: "codex", servers: [{ name: "linear", type: "http", url: "https://mcp.linear.app/mcp" }] }],
      link,
    });

    expect(link.runs[0]!.command).toContain("timeout 20 codex mcp add");
  });

  test("reports a missing CLI and a server the box did not take", async () => {
    const link = new FakeLink((command) =>
      command.includes("command -v claude") ? ok("S\tlinear\n") : ok("C\n"),
    );

    const warnings = await registerBoxMcp({
      remoteHome: "/home/agent",
      harnesses: BUILTIN_HARNESSES,
      tools: BUILTIN_TOOLS,
      mcp: [
        { harness: "claude", servers: [{ name: "linear", type: "http", url: "https://mcp.linear.app/mcp" }] },
        { harness: "codex", servers: [{ name: "linear", type: "http", url: "https://mcp.linear.app/mcp" }] },
      ],
      link,
    });

    expect(warnings).toEqual([
      "could not declare claude MCP server linear",
      "the codex CLI is not on the box PATH; no codex MCP server was declared",
    ]);
  });

  test("runs one box command for each CLI server and counts all carried servers", async () => {
    const link = new FakeLink((command) => (command.includes("mv ") ? ok() : ok("F{}")));
    const progress = recordProgress();
    const server = (name: string) => ({ name, type: "http" as const, url: `https://${name}.example/mcp` });

    await registerBoxMcp({
      remoteHome: "/home/agent",
      harnesses: BUILTIN_HARNESSES,
      tools: BUILTIN_TOOLS,
      mcp: [
        { harness: "claude", servers: [server("linear"), server("notion")] },
        { harness: "cursor", servers: [server("linear"), server("notion")] },
        { harness: "codex", servers: [server("linear")] },
      ],
      link,
      progress,
    });

    expect(link.runs.map((run) => run.command.includes("command -v claude"))).toEqual([true, true, false, false, false]);
    expect(link.runs[0]!.command).toContain("'\"'\"'linear'\"'\"'");
    expect(link.runs[0]!.command).not.toContain("notion");
    expect(link.runs[4]!.command).toContain("command -v codex");
    expect(progress.events).toEqual(["count:1/5", "count:2/5", "count:4/5", "count:5/5"]);
  });

  test("merges Cursor servers into the box mcp.json and keeps the other box servers", async () => {
    const box = { mcpServers: { local: { command: "tool" }, linear: { url: "https://old.example/mcp" } }, other: 1 };
    const link = new FakeLink((command) => (command.includes("mv ") ? ok() : ok(`F${JSON.stringify(box)}`)));

    await registerBoxMcp({
      remoteHome: "/home/agent",
      harnesses: BUILTIN_HARNESSES,
      tools: BUILTIN_TOOLS,
      mcp: [{ harness: "cursor", servers: [{ name: "linear", type: "http", url: "https://mcp.linear.app/mcp" }] }],
      link,
    });

    expect(link.runs[0]!.command).toContain("/home/agent/.cursor/mcp.json");
    const write = link.runs[1]!.command;
    expect(write).toContain("mv ");
    const written = JSON.parse(write.match(/printf '%s' '([\s\S]*)' > /)![1]!);
    expect(written).toEqual({
      mcpServers: { local: { command: "tool" }, linear: { url: "https://mcp.linear.app/mcp" } },
      other: 1,
    });
  });

  test("the box script passes a URL with shell metacharacters to the CLI as one argument", async () => {
    const directory = mkdtempSync(join(tmpdir(), "ferry-mcp-"));
    directories.push(directory);
    const log = join(directory, "log");
    const state = join(directory, "state");
    // A stub claude: `get` prints the declared URL, `add` records it.
    writeFileSync(
      join(directory, "claude"),
      [
        "#!/bin/sh",
        `printf '%s\\n' "$@" >> '${log}'`,
        `case "$2" in`,
        `  get) [ -f '${state}' ] && cat '${state}' ;;`,
        `  add) printf 'URL: %s\\n' "$8" > '${state}' ;;`,
        "esac",
      ].join("\n"),
    );
    chmodSync(join(directory, "claude"), 0o755);
    const link = new FakeLink(async (command) => {
      const child = Bun.spawn(["sh", "-c", command], {
        cwd: directory,
        env: { PATH: `${directory}:/usr/bin:/bin` },
        stdout: "pipe",
      });
      await child.exited;
      return ok(await new Response(child.stdout).text());
    });

    const warnings = await registerBoxMcp({
      remoteHome: directory,
      harnesses: BUILTIN_HARNESSES,
      tools: BUILTIN_TOOLS,
      mcp: [{ harness: "claude", servers: [{ name: "team", type: "http", url: HOSTILE_URL }] }],
      link,
    });

    expect(warnings).toEqual([]);
    expect(readFileSync(log, "utf8").split("\n")).toContain(HOSTILE_URL);
    expect(existsSync(join(directory, "pwned"))).toBe(false);
    expect(existsSync(join(directory, "pwned2"))).toBe(false);
  });
});

/** A box home in a temporary directory. The link runs each command there with `sh`. */
/** The programs a box script may use, without jq. */
const BOX_PROGRAMS = ["sh", "grep", "mkdir", "mv", "rm", "cat", "cmp", "timeout", "printf", "dirname"];

/**
 * A box home in a temporary directory. The link runs each command there with
 * `sh` and records its output in `outputs`. Without `jq`, the box PATH has
 * only `BOX_PROGRAMS` and the stubs in `bin`.
 */
function shellBox(options: { readonly jq?: boolean } = {}) {
  const home = mkdtempSync(join(tmpdir(), "ferry-mcp-box-"));
  directories.push(home);
  mkdirSync(join(home, "bin"));
  let path = `${join(home, "bin")}:/usr/bin:/bin`;
  if (options.jq === false) {
    mkdirSync(join(home, "sys"));
    for (const program of BOX_PROGRAMS) {
      const found = Bun.which(program);
      if (found) symlinkSync(found, join(home, "sys", program));
    }
    path = `${join(home, "bin")}:${join(home, "sys")}`;
  }
  const outputs: string[] = [];
  const link = new FakeLink(async (command) => {
    const child = Bun.spawn(["sh", "-c", command], { cwd: home, env: { HOME: home, PATH: path }, stdout: "pipe", stderr: "pipe" });
    await child.exited;
    const stdout = await new Response(child.stdout).text();
    const stderr = await new Response(child.stderr).text();
    outputs.push(stdout, stderr);
    return { ok: true, address: "box", stdout, stderr };
  });
  const put = (file: string, text: string) => {
    mkdirSync(join(home, file, ".."), { recursive: true });
    writeFileSync(join(home, file), text);
  };
  return { home, link, outputs, put, read: (file: string) => readFileSync(join(home, file), "utf8") };
}

/** A stub claude on the box PATH that writes each call, one argument per line, to `claude.log`. */
function stubClaude(home: string): () => string[][] {
  const log = join(home, "claude.log");
  writeFileSync(join(home, "bin", "claude"), ["#!/bin/sh", `printf '%s\\n' "$@" '@@' >> '${log}'`].join("\n"));
  chmodSync(join(home, "bin", "claude"), 0o755);
  return () =>
    existsSync(log)
      ? readFileSync(log, "utf8").split("@@\n").filter(Boolean).map((call) => call.trimEnd().split("\n"))
      : [];
}

/**
 * A stub codex on the box PATH. `mcp get <name> [--json]` prints the entry of
 * `servers` as Codex does, or fails for a name that is neither there nor
 * added with `mcp add`. Each call goes to `codex.log`.
 */
function stubCodex(home: string, servers: Record<string, unknown>): () => string[][] {
  const log = join(home, "codex.log");
  writeFileSync(join(home, "codex-servers.json"), JSON.stringify(servers));
  writeFileSync(
    join(home, "bin", "codex"),
    [
      "#!/bin/sh",
      `printf '%s\\n' "$@" '@@' >> '${log}'`,
      `[ "$1 $2" = "mcp add" ] && printf '%s\\n' "$3" >> '${join(home, "codex-added")}'`,
      'if [ "$1 $2" = "mcp get" ]; then',
      `  grep -qF "\"$3\"" '${join(home, "codex-servers.json")}' || grep -qxF "$3" '${join(home, "codex-added")}' 2>/dev/null || exit 1`,
      `  [ "$4" = "--json" ] && jq --arg n "$3" '{name: $n, transport: .[$n]}' '${join(home, "codex-servers.json")}'`,
      "fi",
      "exit 0",
    ].join("\n"),
  );
  chmodSync(join(home, "bin", "codex"), 0o755);
  return () =>
    existsSync(log)
      ? readFileSync(log, "utf8").split("@@\n").filter(Boolean).map((call) => call.trimEnd().split("\n"))
      : [];
}

function stdio(name: string, fields: Partial<StdioMcpServer> = {}): StdioMcpServer {
  return { name, type: "stdio", command: `${name}-mcp`, args: [], env: [], ...fields };
}

describe("registerBoxMcp with stdio servers", () => {
  test("adds a stdio server with the claude and codex CLIs, writes it into the Cursor file, and keeps the box servers", async () => {
    const box = shellBox();
    const claudeCalls = stubClaude(box.home);
    const codexCalls = stubCodex(box.home, { boxonly: { command: "box-mcp" } });
    const claudeJson = JSON.stringify({ numStartups: 3, mcpServers: { boxonly: { command: "box-mcp" } } });
    box.put(".claude.json", claudeJson);
    box.put(".cursor/mcp.json", JSON.stringify({ mcpServers: { boxonly: { command: "box-mcp" } } }));
    const github = stdio("github", { command: "npx", args: ["-y", "@example/github-mcp"], env: ["GITHUB_TOKEN"] });

    const warnings = await registerBoxMcp({
      remoteHome: box.home,
      harnesses: BUILTIN_HARNESSES,
      tools: BUILTIN_TOOLS,
      mcp: [
        { harness: "claude", servers: [github] },
        { harness: "codex", servers: [github] },
        { harness: "cursor", servers: [github] },
      ],
      link: box.link,
    });

    expect(warnings).toEqual([]);
    expect(claudeCalls()).toEqual([
      ["mcp", "remove", "--scope", "user", "github"],
      [
        "mcp",
        "add-json",
        "--scope",
        "user",
        "github",
        JSON.stringify({ type: "stdio", command: "npx", args: ["-y", "@example/github-mcp"] }),
      ],
    ]);
    // Claude owns ~/.claude.json, so Ferry never writes it.
    expect(box.read(".claude.json")).toBe(claudeJson);
    expect(codexCalls()).toEqual([
      ["mcp", "get", "github"],
      ["mcp", "add", "github", "--", "npx", "-y", "@example/github-mcp"],
      ["mcp", "get", "github"],
    ]);
    const entry = { command: "npx", args: ["-y", "@example/github-mcp"] };
    expect(JSON.parse(box.read(".cursor/mcp.json"))).toEqual({ mcpServers: { boxonly: { command: "box-mcp" }, github: entry } });
  });

  test("keeps the env values of the box entry and replaces its command and arguments", async () => {
    const box = shellBox();
    box.put(
      ".cursor/mcp.json",
      JSON.stringify({ mcpServers: { github: { command: "old", args: ["x"], cwd: "/tmp", env: { GITHUB_TOKEN: "box-value" } } } }),
    );

    await registerBoxMcp({
      remoteHome: box.home,
      harnesses: BUILTIN_HARNESSES,
      tools: BUILTIN_TOOLS,
      mcp: [{ harness: "cursor", servers: [stdio("github", { command: "github-mcp", env: ["GITHUB_TOKEN"] })] }],
      link: box.link,
    });

    expect(JSON.parse(box.read(".cursor/mcp.json"))).toEqual({
      mcpServers: { github: { command: "github-mcp", args: [], env: { GITHUB_TOKEN: "box-value" } } },
    });
  });

  test("does not rewrite a box file that already holds the carried servers", async () => {
    const box = shellBox();
    const text = JSON.stringify({ mcpServers: { docs: { command: "docs-mcp", args: [], env: { DOCS_KEY: "box-value" } } } });
    box.put(".cursor/mcp.json", text);

    await registerBoxMcp({
      remoteHome: box.home,
      harnesses: BUILTIN_HARNESSES,
      tools: BUILTIN_TOOLS,
      mcp: [{ harness: "cursor", servers: [stdio("docs")] }],
      link: box.link,
    });

    expect(box.read(".cursor/mcp.json")).toBe(text);
  });

  test("leaves a Codex entry as it is, and warns when its command differs", async () => {
    const box = shellBox();
    const codexCalls = stubCodex(box.home, {
      same: { type: "stdio", command: "same-mcp", args: [] },
      changed: { type: "stdio", command: "old-mcp", args: [], env_vars: ["TEAM"] },
    });

    const warnings = await registerBoxMcp({
      remoteHome: box.home,
      harnesses: BUILTIN_HARNESSES,
      tools: BUILTIN_TOOLS,
      mcp: [{ harness: "codex", servers: [stdio("same"), stdio("changed")] }],
      link: box.link,
    });

    expect(warnings).toEqual([
      "codex MCP server changed on the box has another command or arguments. Ferry leaves it as it is, so the box keeps its env settings. Remove it on the box, then sync again.",
    ]);
    expect(codexCalls().some((call) => call[1] === "add" || call[1] === "remove")).toBe(false);
  });

  test("without jq, adds new servers and leaves existing entries as they are", async () => {
    const box = shellBox({ jq: false });
    const claudeCalls = stubClaude(box.home);
    const codexCalls = stubCodex(box.home, { docs: { type: "stdio", command: "old-mcp", args: [] } });
    box.put(".claude.json", JSON.stringify({ mcpServers: { github: { command: "old-mcp", env: { GITHUB_TOKEN: "box-value" } } } }));
    box.put(".cursor/mcp.json", JSON.stringify({ mcpServers: {} }));

    const warnings = await registerBoxMcp({
      remoteHome: box.home,
      harnesses: BUILTIN_HARNESSES,
      tools: BUILTIN_TOOLS,
      mcp: [
        { harness: "claude", servers: [stdio("github"), stdio("time")] },
        { harness: "codex", servers: [stdio("docs")] },
        { harness: "cursor", servers: [stdio("time")] },
      ],
      link: box.link,
    });

    expect(warnings).toEqual([
      "jq is not on the box, so Ferry did not update claude MCP server github. Run ferry update to install jq.",
      "jq is not on the box, so Ferry did not update codex MCP server docs. Run ferry update to install jq.",
      "jq is not on the box, so Ferry did not update cursor MCP servers time. Run ferry update to install jq.",
    ]);
    expect(claudeCalls().filter((call) => call[1] === "add-json").map((call) => call[4])).toEqual(["time"]);
    expect(codexCalls().some((call) => call[1] === "add")).toBe(false);
    expect(box.read(".cursor/mcp.json")).toBe(JSON.stringify({ mcpServers: {} }));
  });

  test("without jq, creates a missing Cursor MCP file with the carried servers", async () => {
    const box = shellBox({ jq: false });

    const warnings = await registerBoxMcp({
      remoteHome: box.home,
      harnesses: BUILTIN_HARNESSES,
      tools: BUILTIN_TOOLS,
      mcp: [{ harness: "cursor", servers: [stdio("time")] }],
      link: box.link,
    });

    expect(warnings).toEqual([]);
    expect(JSON.parse(box.read(".cursor/mcp.json"))).toEqual({ mcpServers: { time: { command: "time-mcp", args: [] } } });
  });

  test("keeps the env of a changed Claude entry and leaves an unchanged one alone", async () => {
    const box = shellBox();
    const claudeCalls = stubClaude(box.home);
    box.put(
      ".claude.json",
      JSON.stringify({
        mcpServers: {
          github: { type: "stdio", command: "old-mcp", args: [], env: { GITHUB_TOKEN: "box-value" } },
          time: { type: "stdio", command: "time-mcp", args: [], env: {} },
        },
      }),
    );
    const progress = recordProgress();

    await registerBoxMcp({
      remoteHome: box.home,
      harnesses: BUILTIN_HARNESSES,
      tools: BUILTIN_TOOLS,
      mcp: [
        {
          harness: "claude",
          servers: [
            { name: "linear", type: "http", url: "https://mcp.linear.app/mcp" },
            stdio("github", { env: ["GITHUB_TOKEN"] }),
            stdio("time"),
          ],
        },
      ],
      link: box.link,
      progress,
    });

    const calls = claudeCalls();
    expect(calls.filter((call) => call[1] === "add-json")).toEqual([
      [
        "mcp",
        "add-json",
        "--scope",
        "user",
        "github",
        JSON.stringify({ type: "stdio", command: "github-mcp", args: [], env: { GITHUB_TOKEN: "box-value" } }),
      ],
    ]);
    expect(calls.some((call) => call.includes("time"))).toBe(false);
    expect(progress.events).toEqual(["count:1/3", "count:2/3", "count:3/3"]);
  });

  test("warns once when the claude CLI is not on the box", async () => {
    const box = shellBox();

    const warnings = await registerBoxMcp({
      remoteHome: box.home,
      harnesses: BUILTIN_HARNESSES,
      tools: BUILTIN_TOOLS,
      mcp: [{ harness: "claude", servers: [stdio("github"), stdio("time")] }],
      link: box.link,
    });

    expect(warnings).toEqual(["the claude CLI is not on the box PATH; no claude MCP server was declared"]);
    expect(existsSync(join(box.home, ".claude.json"))).toBe(false);
  });
});

describe("box env values", () => {
  const SECRET = `ghp_${"s".repeat(36)}`;

  test("never reach Ferry: the box merges each entry and prints only a status or key names", async () => {
    const box = shellBox();
    const claudeCalls = stubClaude(box.home);
    stubCodex(box.home, { docs: { type: "stdio", command: "old-docs-mcp", args: [], env: { DOCS_KEY: SECRET } } });
    box.put(".claude.json", JSON.stringify({ mcpServers: { github: { type: "stdio", command: "old-mcp", args: [], env: { GITHUB_TOKEN: SECRET } } } }));
    box.put(".cursor/mcp.json", JSON.stringify({ mcpServers: { github: { command: "old-mcp", env: { GITHUB_TOKEN: SECRET } } } }));
    const github = stdio("github", { env: ["GITHUB_TOKEN", "GITHUB_ORG"] });
    const docs = stdio("docs", { env: ["DOCS_KEY", "DOCS_TEAM"] });
    const common = { remoteHome: box.home, harnesses: BUILTIN_HARNESSES, tools: BUILTIN_TOOLS, link: box.link };

    const warnings = await registerBoxMcp({
      ...common,
      mcp: [
        { harness: "claude", servers: [github] },
        { harness: "codex", servers: [docs] },
        { harness: "cursor", servers: [github] },
      ],
    });
    const issues = await checkBoxMcp({
      ...common,
      sources: [
        { harness: "claude", servers: [github], nonPortable: [] },
        { harness: "codex", servers: [docs], nonPortable: [] },
        { harness: "cursor", servers: [github], nonPortable: [] },
      ],
    });

    const captured = JSON.stringify({ runs: box.link.runs, outputs: box.outputs, warnings, issues });
    expect(captured).not.toContain(SECRET);
    // The box kept each value.
    expect(claudeCalls().find((call) => call[1] === "add-json")?.at(-1)).toBe(
      JSON.stringify({ type: "stdio", command: "github-mcp", args: [], env: { GITHUB_TOKEN: SECRET } }),
    );
    expect(JSON.parse(box.read(".cursor/mcp.json")).mcpServers.github).toEqual({
      command: "github-mcp",
      args: [],
      env: { GITHUB_TOKEN: SECRET },
    });
    expect(issues.filter((issue) => issue.kind === "env-missing")).toEqual([
      { kind: "env-missing", harness: "claude", server: "github", keys: ["GITHUB_ORG"], file: ".claude.json" },
      { kind: "env-missing", harness: "codex", server: "docs", keys: ["DOCS_TEAM"], file: ".codex/config.toml" },
      { kind: "env-missing", harness: "cursor", server: "github", keys: ["GITHUB_ORG"], file: ".cursor/mcp.json" },
    ]);
  });
});

describe("checkBoxMcp", () => {
  test("names env keys the box entry does not set, missing commands, and servers that are not portable", async () => {
    const box = shellBox();
    box.put(
      ".cursor/mcp.json",
      JSON.stringify({ mcpServers: { github: { command: "npx", env: { GITHUB_TOKEN: "box-value", GITHUB_ORG: "" } } } }),
    );

    const issues = await checkBoxMcp({
      remoteHome: box.home,
      harnesses: BUILTIN_HARNESSES,
      tools: BUILTIN_TOOLS,
      sources: [
        {
          harness: "cursor",
          servers: [
            stdio("github", { command: "sh", env: ["GITHUB_ORG", "GITHUB_TOKEN", "GITHUB_URL"] }),
            stdio("missing", { command: "not-on-this-box-mcp" }),
            // A registry tool supplies claude, so the tool check reports it.
            stdio("agent", { command: "claude" }),
            { name: "linear", type: "http", url: "https://mcp.linear.app/mcp" },
          ],
          nonPortable: ["local"],
        },
        { harness: "codex", servers: [stdio("docs", { command: "sh", env: ["DOCS_KEY"] })], nonPortable: [] },
      ],
      link: box.link,
    });

    expect(issues).toEqual([
      { kind: "not-portable", harness: "cursor", server: "local" },
      { kind: "command-missing", harness: "cursor", server: "missing", command: "not-on-this-box-mcp" },
      { kind: "env-missing", harness: "codex", server: "docs", keys: ["DOCS_KEY"], file: ".codex/config.toml" },
      { kind: "env-missing", harness: "cursor", server: "github", keys: ["GITHUB_ORG", "GITHUB_URL"], file: ".cursor/mcp.json" },
    ]);
  });

  test("without jq, reports the env keys it cannot check", async () => {
    const box = shellBox({ jq: false });

    const issues = await checkBoxMcp({
      remoteHome: box.home,
      harnesses: BUILTIN_HARNESSES,
      tools: BUILTIN_TOOLS,
      sources: [{ harness: "cursor", servers: [stdio("github", { command: "sh", env: ["GITHUB_TOKEN"] })], nonPortable: [] }],
      link: box.link,
    });

    expect(issues).toEqual([{ kind: "env-unchecked", harness: "cursor", server: "github", keys: ["GITHUB_TOKEN"] }]);
  });

  test("runs no box command when no stdio server is carried", async () => {
    const link = new FakeLink(() => ok());

    const issues = await checkBoxMcp({
      remoteHome: "/home/agent",
      harnesses: BUILTIN_HARNESSES,
      tools: BUILTIN_TOOLS,
      sources: [{ harness: "claude", servers: [{ name: "linear", type: "http", url: "https://mcp.linear.app/mcp" }], nonPortable: [] }],
      link,
    });

    expect(issues).toEqual([]);
    expect(link.runs).toEqual([]);
  });

  test("passes a command with shell metacharacters to command -v as data", async () => {
    const box = shellBox();

    const issues = await checkBoxMcp({
      remoteHome: box.home,
      harnesses: BUILTIN_HARNESSES,
      tools: BUILTIN_TOOLS,
      sources: [{ harness: "cursor", servers: [stdio("x", { command: "x$(touch pwned)'`touch pwned2`" })], nonPortable: [] }],
      link: box.link,
    });

    expect(issues).toEqual([
      { kind: "command-missing", harness: "cursor", server: "x", command: "x$(touch pwned)'`touch pwned2`" },
    ]);
    expect(existsSync(join(box.home, "pwned"))).toBe(false);
    expect(existsSync(join(box.home, "pwned2"))).toBe(false);
  });
});

describe("mcpCommand", () => {
  test("quotes each value", () => {
    expect(mcpCommand("x {name} {url}", { name: "a", url: "b c" })).toBe("x 'a' 'b c'");
  });
});
