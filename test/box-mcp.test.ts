import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checkBoxMcp, gatewayCleanupCommand, gatewayCleanupFailed, gatewayCleanupLines, mcpCommand, registerBoxMcp, sharedEnvScript, sharedRestoreCommand, uninstallCleanupCommand } from "../src/box-mcp.ts";
import { disableGateway, enableGateway, gatewayServers } from "../src/mcp-gateway/service.ts";
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
  constructor(private readonly answer: (command: string, options?: RunOptions) => LinkResult | Promise<LinkResult>) {}
  async run(command: string, options?: RunOptions): Promise<LinkResult> {
    this.runs.push({ command, options });
    return this.answer(command, options);
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
    const link = new FakeLink(() => ok());
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

    expect(link.runs.map((run) => run.command.includes("command -v claude"))).toEqual([true, true, false, false]);
    expect(link.runs[0]!.command).toContain("'\"'\"'linear'\"'\"'");
    expect(link.runs[0]!.command).not.toContain("notion");
    expect(link.runs[3]!.command).toContain("command -v codex");
    expect(progress.events).toEqual(["count:1/5", "count:2/5", "count:4/5", "count:5/5"]);
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
const HAS_JQ = Bun.which("jq") !== null;

/** A test that runs box scripts with a real jq. It skips, and says why, when jq is not on the PATH. */
function jqTest(title: string, run: () => Promise<void>): void {
  test.skipIf(!HAS_JQ)(HAS_JQ ? title : `${title} (skipped: jq is not on the PATH)`, run);
}

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
  const link = new FakeLink(async (command, options) => {
    const child = Bun.spawn(["sh", "-c", command], { cwd: home, env: { HOME: home, PATH: path }, stdin: options?.input ?? "ignore", stdout: "pipe", stderr: "pipe" });
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
  jqTest("adds a stdio server with the claude and codex CLIs, writes it into the Cursor file, and keeps the box servers", async () => {
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

  jqTest("keeps the env values of the box entry and replaces its command and arguments", async () => {
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

  jqTest("does not rewrite a box file that already holds the carried servers", async () => {
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

  jqTest("leaves a Codex entry as it is, and warns when its command differs", async () => {
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

  jqTest("keeps the env of a changed Claude entry and leaves an unchanged one alone", async () => {
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

describe("registerBoxMcp with a skipped app bundle server", () => {
  const NODE_REPL = "/Applications/ChatGPT.app/Contents/Resources/cua_node/bin/node_repl";
  const SECRET = `ghp_${"s".repeat(36)}`;
  /** The entry that Ferry v0.10.0 put on the box, with a value that the box owner set. */
  const stale = { command: NODE_REPL, args: [], env: { NODE_REPL_KEY: SECRET } };
  const removed = (harness: string, name = "node_repl") =>
    `Ferry removed ${harness} MCP server ${name} from the box, because it runs from a macOS app bundle, which the box does not have.`;

  jqTest("removes the entry of an earlier sync from the Claude, Codex, and Cursor Agent box config, and keeps the other servers", async () => {
    const box = shellBox();
    const claudeCalls = stubClaude(box.home);
    const codexCalls = stubCodex(box.home, { node_repl: { type: "stdio", ...stale }, boxonly: { type: "stdio", command: "box-mcp", args: [] } });
    box.put(".claude.json", JSON.stringify({ mcpServers: { node_repl: { type: "stdio", ...stale }, boxonly: { command: "box-mcp" } } }));
    box.put(".cursor/mcp.json", JSON.stringify({ mcpServers: { node_repl: stale, boxonly: { command: "box-mcp" } }, other: 1 }));
    const progress = recordProgress();

    const warnings = await registerBoxMcp({
      remoteHome: box.home,
      harnesses: BUILTIN_HARNESSES,
      tools: BUILTIN_TOOLS,
      mcp: [
        { harness: "claude", servers: [], appBundle: ["node_repl"] },
        { harness: "codex", servers: [], appBundle: ["node_repl"] },
        { harness: "cursor", servers: [stdio("time")], appBundle: ["node_repl"] },
      ],
      link: box.link,
      progress,
    });

    expect(warnings).toEqual([removed("claude"), removed("codex"), removed("cursor")]);
    expect(claudeCalls()).toEqual([["mcp", "remove", "--scope", "user", "node_repl"]]);
    expect(codexCalls().filter((call) => call[1] !== "get")).toEqual([["mcp", "remove", "node_repl"]]);
    expect(JSON.parse(box.read(".cursor/mcp.json"))).toEqual({
      mcpServers: { boxonly: { command: "box-mcp" }, time: { command: "time-mcp", args: [] } },
      other: 1,
    });
    // The box compares and removes the entry itself, so its env value never reaches Ferry.
    expect(JSON.stringify({ runs: box.link.runs, outputs: box.outputs, warnings })).not.toContain(SECRET);
    expect(progress.events).toEqual(["count:1/1"]);
  });

  jqTest("keeps a box entry with the same name that does not run from an app bundle", async () => {
    const box = shellBox();
    const claudeCalls = stubClaude(box.home);
    const codexCalls = stubCodex(box.home, { node_repl: { type: "stdio", command: "node-repl-mcp", args: [] } });
    const claudeJson = JSON.stringify({ mcpServers: { node_repl: { type: "stdio", command: "node-repl-mcp", args: ["/opt/foo.app"] } } });
    const cursorJson = JSON.stringify({ mcpServers: { node_repl: { command: "/srv/myapp.app-data/bin/node_repl" } } });
    box.put(".claude.json", claudeJson);
    box.put(".cursor/mcp.json", cursorJson);

    const warnings = await registerBoxMcp({
      remoteHome: box.home,
      harnesses: BUILTIN_HARNESSES,
      tools: BUILTIN_TOOLS,
      mcp: ["claude", "codex", "cursor"].map((harness) => ({ harness, servers: [], appBundle: ["node_repl"] })),
      link: box.link,
    });

    expect(warnings).toEqual([]);
    expect(claudeCalls()).toEqual([]);
    expect(codexCalls().some((call) => call[1] === "remove")).toBe(false);
    expect(box.read(".claude.json")).toBe(claudeJson);
    expect(box.read(".cursor/mcp.json")).toBe(cursorJson);
  });

  jqTest("keeps a box app bundle entry whose name is not a skipped server, and removes one with an app bundle argument", async () => {
    const box = shellBox();
    box.put(
      ".cursor/mcp.json",
      JSON.stringify({
        mcpServers: {
          boxonly: { command: NODE_REPL },
          helper: { command: "node", args: ["/Applications/Tool.app/Contents/Resources/server.js"] },
        },
      }),
    );

    const warnings = await registerBoxMcp({
      remoteHome: box.home,
      harnesses: BUILTIN_HARNESSES,
      tools: BUILTIN_TOOLS,
      mcp: [{ harness: "cursor", servers: [], appBundle: ["helper", "absent"] }],
      link: box.link,
    });

    expect(warnings).toEqual([removed("cursor", "helper")]);
    expect(JSON.parse(box.read(".cursor/mcp.json"))).toEqual({ mcpServers: { boxonly: { command: NODE_REPL } } });
  });

  test("changes nothing and prints nothing when the box has no MCP file and no harness CLI", async () => {
    const box = shellBox();

    const warnings = await registerBoxMcp({
      remoteHome: box.home,
      harnesses: BUILTIN_HARNESSES,
      tools: BUILTIN_TOOLS,
      mcp: ["claude", "codex", "cursor"].map((harness) => ({ harness, servers: [], appBundle: ["node_repl"] })),
      link: box.link,
    });

    expect(warnings).toEqual([]);
    expect(box.outputs.join("")).toBe("");
    expect(existsSync(join(box.home, ".cursor/mcp.json"))).toBe(false);
  });

  test("without jq, leaves the box entry as it is and warns", async () => {
    const box = shellBox({ jq: false });
    const text = JSON.stringify({ mcpServers: { node_repl: stale } });
    box.put(".cursor/mcp.json", text);

    const warnings = await registerBoxMcp({
      remoteHome: box.home,
      harnesses: BUILTIN_HARNESSES,
      tools: BUILTIN_TOOLS,
      mcp: [{ harness: "cursor", servers: [], appBundle: ["node_repl", "absent"] }],
      link: box.link,
    });

    expect(warnings).toEqual([
      "jq is not on the box, so Ferry cannot tell if cursor MCP server node_repl on the box runs from a macOS app bundle, and leaves it. Run ferry update to install jq.",
    ]);
    expect(box.read(".cursor/mcp.json")).toBe(text);
  });
});

describe("box env values", () => {
  const SECRET = `ghp_${"s".repeat(36)}`;

  jqTest("never reach Ferry: the box merges each entry and prints only a status or key names", async () => {
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

describe("box Cursor MCP file", () => {
  const SECRET = `ghp_${"s".repeat(36)}`;
  const linear = { name: "linear", type: "http" as const, url: "https://mcp.linear.app/mcp" };

  jqTest("merges remote servers into the box mcp.json and keeps the other box servers", async () => {
    const box = shellBox();
    box.put(
      ".cursor/mcp.json",
      JSON.stringify({ mcpServers: { local: { command: "tool" }, linear: { url: "https://old.example/mcp", headers: { A: "b" } } }, other: 1 }),
    );

    await registerBoxMcp({
      remoteHome: box.home,
      harnesses: BUILTIN_HARNESSES,
      tools: BUILTIN_TOOLS,
      mcp: [{ harness: "cursor", servers: [linear, { name: "events", type: "sse", url: "https://events.example/sse" }] }],
      link: box.link,
    });

    expect(JSON.parse(box.read(".cursor/mcp.json"))).toEqual({
      mcpServers: {
        local: { command: "tool" },
        linear: { url: "https://mcp.linear.app/mcp" },
        events: { type: "sse", url: "https://events.example/sse" },
      },
      other: 1,
    });
  });

  jqTest("does not rewrite a box file that already holds the remote servers", async () => {
    const box = shellBox();
    const text = JSON.stringify({ mcpServers: { linear: { url: "https://mcp.linear.app/mcp" } } });
    box.put(".cursor/mcp.json", text);

    const warnings = await registerBoxMcp({
      remoteHome: box.home,
      harnesses: BUILTIN_HARNESSES,
      tools: BUILTIN_TOOLS,
      mcp: [{ harness: "cursor", servers: [linear] }],
      link: box.link,
    });

    expect(warnings).toEqual([]);
    expect(box.read(".cursor/mcp.json")).toBe(text);
  });

  test("without jq, leaves the box file as it is and warns", async () => {
    const box = shellBox({ jq: false });
    const text = JSON.stringify({ mcpServers: {} });
    box.put(".cursor/mcp.json", text);

    const warnings = await registerBoxMcp({
      remoteHome: box.home,
      harnesses: BUILTIN_HARNESSES,
      tools: BUILTIN_TOOLS,
      mcp: [{ harness: "cursor", servers: [linear] }],
      link: box.link,
    });

    expect(warnings).toEqual([
      "jq is not on the box, so Ferry did not update cursor MCP servers linear. Run ferry update to install jq.",
    ]);
    expect(box.read(".cursor/mcp.json")).toBe(text);
  });

  jqTest("never reaches Ferry when the box merges a remote server", async () => {
    const box = shellBox();
    box.put(
      ".cursor/mcp.json",
      JSON.stringify({
        mcpServers: {
          github: { command: "github-mcp", env: { GITHUB_TOKEN: SECRET } },
          linear: { url: "https://old.example/mcp" },
        },
      }),
    );

    const warnings = await registerBoxMcp({
      remoteHome: box.home,
      harnesses: BUILTIN_HARNESSES,
      tools: BUILTIN_TOOLS,
      mcp: [{ harness: "cursor", servers: [{ name: "linear", type: "http", url: "https://mcp.linear.app/mcp" }] }],
      link: box.link,
    });

    expect(JSON.stringify({ runs: box.link.runs, outputs: box.outputs, warnings })).not.toContain(SECRET);
    expect(warnings).toEqual([]);
    expect(JSON.parse(box.read(".cursor/mcp.json"))).toEqual({
      mcpServers: {
        github: { command: "github-mcp", env: { GITHUB_TOKEN: SECRET } },
        linear: { url: "https://mcp.linear.app/mcp" },
      },
    });
  });
});

describe("checkBoxMcp", () => {
  jqTest("names env keys the box entry does not set, missing commands, and servers that are not portable", async () => {
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
          // A server from a macOS app bundle gives no issue: the operator has nothing to do.
          nonPortable: [{ name: "local", reason: "home-path" }, { name: "node_repl", reason: "app-bundle" }, { name: "wrapped", reason: "inline-script" }],
        },
        { harness: "codex", servers: [stdio("docs", { command: "sh", env: ["DOCS_KEY"] })], nonPortable: [] },
      ],
      link: box.link,
    });

    expect(issues).toEqual([
      { kind: "not-portable", harness: "cursor", server: "local", reason: "home-path" },
      { kind: "not-portable", harness: "cursor", server: "wrapped", reason: "inline-script" },
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

/**
 * Stateful stubs of the claude and codex CLIs, as Bun scripts on the box
 * PATH. They keep their entries where the real CLIs do: claude in
 * `~/.claude.json`, codex in `~/.codex/config.toml`, which they read and
 * write as TOML, so a table that the box appends goes through a real parse.
 */
function stubStatefulClis(home: string): void {
  const toml = join(import.meta.dir, "..", "node_modules", "smol-toml", "dist", "index.js");
  const common = [
    `#!${process.execPath}`,
    'import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";',
    `const toml = await import(${JSON.stringify(toml)});`,
    "const [, , , command, ...rest] = process.argv;",
    "const words = rest.slice(0, rest.includes('--') ? rest.indexOf('--') : rest.length).filter((word, index, all) => !word.startsWith('-') && !['--transport', '--scope', '--url'].includes(all[index - 1]));",
    "const name = words[0];",
  ];
  writeFileSync(
    join(home, "bin", "claude"),
    [
      ...common,
      `const file = ${JSON.stringify(join(home, ".claude.json"))};`,
      "const data = existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : {};",
      "const servers = (data.mcpServers ??= {});",
      "const save = () => writeFileSync(file, JSON.stringify(data));",
      "if (command === 'get') {",
      "  const entry = servers[name];",
      "  if (!entry) process.exit(1);",
      "  const headers = Object.entries(entry.headers ?? {}).map(([key, value]) => `    ${key}: ${value}`);",
      "  console.log([`${name}:`, `  Type: ${entry.type ?? 'stdio'}`, `  URL: ${entry.url ?? ''}`, ...(headers.length ? ['  Headers:', ...headers] : [])].join('\\n'));",
      "} else if (command === 'remove') { delete servers[name]; save(); }",
      "else if (command === 'add-json') { servers[name] = JSON.parse(rest.at(-1)); save(); }",
      "else if (command === 'add') { servers[name] = { type: rest[rest.indexOf('--transport') + 1], url: words[1] }; save(); }",
    ].join("\n"),
  );
  writeFileSync(
    join(home, "bin", "codex"),
    [
      ...common,
      `const file = ${JSON.stringify(join(home, ".codex", "config.toml"))};`,
      "const data = existsSync(file) ? toml.parse(readFileSync(file, 'utf8')) : {};",
      "const servers = (data.mcp_servers ??= {});",
      "const save = () => { mkdirSync(file.slice(0, file.lastIndexOf('/')), { recursive: true }); writeFileSync(file, toml.stringify(data)); };",
      "if (command === 'get') {",
      "  const entry = servers[name];",
      "  if (!entry) process.exit(1);",
      "  console.log(JSON.stringify({ name, transport: entry.url ? { type: 'streamable_http', url: entry.url, http_headers: entry.http_headers ?? null } : { type: 'stdio', ...entry } }));",
      "} else if (command === 'list') {",
      "  console.log(JSON.stringify(Object.entries(servers).map(([name, entry]) => ({ name, transport: entry.url ? { type: 'streamable_http', url: entry.url, http_headers: entry.http_headers ?? null } : { type: 'stdio', ...entry } }))));",
      "} else if (command === 'remove') { delete servers[name]; save(); }",
      "else if (command === 'add') {",
      "  const separator = rest.indexOf('--');",
      "  servers[name] = separator >= 0 ? { command: rest[separator + 1], args: rest.slice(separator + 2) } : { url: rest[rest.indexOf('--url') + 1] };",
      "  save();",
      "}",
    ].join("\n"),
  );
  chmodSync(join(home, "bin", "claude"), 0o755);
  chmodSync(join(home, "bin", "codex"), 0o755);
}

describe("registerBoxMcp with the MCP gateway", () => {
  const KEY = "a".repeat(32) + "b".repeat(32);
  const GATEWAY = "http://127.0.0.1:47820/mcp/linear";
  const linear = { name: "linear", type: "http" as const, url: "https://mcp.linear.app/mcp" };
  const github = stdio("github", { args: ["--org", "example"] });
  const mcp = [
    { harness: "claude", servers: [linear, github] },
    { harness: "codex", servers: [linear, github] },
    { harness: "cursor", servers: [linear, github] },
  ];

  function gatewayBox() {
    const box = shellBox();
    stubStatefulClis(box.home);
    box.put(".ferry/mcp-gateway/client-key", `${KEY}\n`);
    const register = (gateway?: readonly string[]) =>
      registerBoxMcp({ remoteHome: box.home, harnesses: BUILTIN_HARNESSES, tools: BUILTIN_TOOLS, mcp, link: box.link, ...(gateway ? { gateway } : {}) });
    const entries = () => ({
      claude: JSON.parse(box.read(".claude.json")).mcpServers,
      codex: (Bun.TOML.parse(box.read(".codex/config.toml")) as { mcp_servers: Record<string, unknown> }).mcp_servers,
      cursor: JSON.parse(box.read(".cursor/mcp.json")).mcpServers,
    });
    return { ...box, register, entries };
  }

  jqTest("points the remote servers of all three harnesses at the gateway and keeps the stdio servers direct", async () => {
    const box = gatewayBox();

    const warnings = await box.register(["linear"]);

    expect(warnings).toEqual([]);
    const header = { Authorization: `Bearer ${KEY}` };
    const direct = { command: "github-mcp", args: ["--org", "example"] };
    expect(box.entries()).toEqual({
      claude: { linear: { type: "http", url: GATEWAY, headers: header }, github: { type: "stdio", ...direct } },
      codex: { linear: { url: GATEWAY, http_headers: header }, github: direct },
      cursor: { linear: { url: GATEWAY, headers: header }, github: direct },
    });
    // The Codex file holds the key now, so only the box user can read it.
    expect(statSync(join(box.home, ".codex", "config.toml")).mode & 0o777).toBe(0o600);
    expect(statSync(join(box.home, ".cursor", "mcp.json")).mode & 0o777).toBe(0o600);
    // The key stays on the box: no command, output, or warning has it.
    expect(JSON.stringify({ runs: box.link.runs, outputs: box.outputs, warnings })).not.toContain(KEY);
  });

  jqTest("a second sync leaves the gateway entries as they are", async () => {
    const box = gatewayBox();
    await box.register(["linear"]);
    const files = [".claude.json", ".codex/config.toml", ".cursor/mcp.json"].map((file) => box.read(file));

    const warnings = await box.register(["linear"]);

    expect(warnings).toEqual([]);
    expect([".claude.json", ".codex/config.toml", ".cursor/mcp.json"].map((file) => box.read(file))).toEqual(files);
  });

  jqTest("a new client key replaces the key in each gateway entry", async () => {
    const box = gatewayBox();
    await box.register(["linear"]);
    const next = "c".repeat(64);
    box.put(".ferry/mcp-gateway/client-key", `${next}\n`);

    await box.register(["linear"]);

    const header = { Authorization: `Bearer ${next}` };
    const entries = box.entries();
    expect([entries.claude.linear.headers, (entries.codex.linear as { http_headers: unknown }).http_headers, entries.cursor.linear.headers]).toEqual([
      header,
      header,
      header,
    ]);
  });

  jqTest("without the gateway, changes the gateway entries back to the carried entries and leaves the other box entries", async () => {
    const box = gatewayBox();
    await box.register(["linear"]);
    // Box entries that Ferry does not carry: one remote and one stdio server, in each harness.
    const mine = { type: "http", url: "https://mine.example/mcp" };
    const tool = { command: "box-tool", args: [] };
    const claude = JSON.parse(box.read(".claude.json"));
    claude.mcpServers = { ...claude.mcpServers, mine, tool };
    box.put(".claude.json", JSON.stringify(claude));
    box.put(".codex/config.toml", `${box.read(".codex/config.toml")}\n[mcp_servers.mine]\nurl = "https://mine.example/mcp"\n\n[mcp_servers.tool]\ncommand = "box-tool"\nargs = []\n`);
    const cursor = JSON.parse(box.read(".cursor/mcp.json"));
    cursor.mcpServers = { ...cursor.mcpServers, mine: { url: mine.url }, tool };
    box.put(".cursor/mcp.json", JSON.stringify(cursor));

    const warnings = await box.register();

    expect(warnings).toEqual([]);
    const direct = { command: "github-mcp", args: ["--org", "example"] };
    expect(box.entries()).toEqual({
      claude: { linear: { type: "http", url: linear.url }, github: { type: "stdio", ...direct }, mine, tool },
      codex: { linear: { url: linear.url }, github: direct, mine: { url: mine.url }, tool },
      cursor: { linear: { url: linear.url }, github: direct, mine: { url: mine.url }, tool },
    });
    expect(JSON.stringify(box.entries())).not.toContain(KEY);
  });

  jqTest("without the client key, leaves the entries as they are and warns", async () => {
    const box = gatewayBox();
    rmSync(join(box.home, ".ferry", "mcp-gateway", "client-key"));

    const warnings = await box.register(["linear"]);

    const missing = (harness: string) =>
      `the box has no MCP gateway client key, so Ferry did not point ${harness} MCP linear at the gateway. Sync again to make the key.`;
    expect(warnings).toEqual([missing("claude"), missing("codex"), missing("cursor")]);
    expect(JSON.stringify(box.entries())).not.toContain("127.0.0.1");
  });

  jqTest("adds no Codex header table when codex mcp add fails", async () => {
    const box = gatewayBox();
    // A codex that adds nothing: get never finds the server.
    writeFileSync(join(box.home, "bin", "codex"), '#!/bin/sh\n[ "$2" = get ] && exit 1\nexit 0\n');
    box.put(".codex/config.toml", 'model = "o3"\n');

    const warnings = await registerBoxMcp({
      remoteHome: box.home,
      harnesses: BUILTIN_HARNESSES,
      tools: BUILTIN_TOOLS,
      mcp: [{ harness: "codex", servers: [linear] }],
      link: box.link,
      gateway: ["linear"],
    });

    expect(warnings).toEqual(["could not point codex MCP server linear at the gateway"]);
    expect(box.read(".codex/config.toml")).toBe('model = "o3"\n');
  });

  jqTest("serves only the servers that the gateway has: an SSE server stays direct", async () => {
    const box = gatewayBox();
    const events = { name: "events", type: "sse" as const, url: "https://events.example/sse" };

    await registerBoxMcp({
      remoteHome: box.home,
      harnesses: BUILTIN_HARNESSES,
      tools: BUILTIN_TOOLS,
      mcp: [{ harness: "cursor", servers: [linear, events] }],
      link: box.link,
      gateway: ["linear"],
    });

    expect(JSON.parse(box.read(".cursor/mcp.json")).mcpServers.events).toEqual({ type: "sse", url: events.url });
  });

  /** Add the entries of the gateway server `old`, which Ferry no longer carries, and of the box server `mine`, to each harness. */
  async function withStaleEntries(box: ReturnType<typeof gatewayBox>) {
    const header = { Authorization: `Bearer ${KEY}` };
    const old = "http://127.0.0.1:47820/mcp/old";
    const claude = JSON.parse(box.read(".claude.json"));
    claude.mcpServers = { ...claude.mcpServers, old: { type: "http", url: old, headers: header }, mine: { type: "http", url: "https://mine.example/mcp" } };
    box.put(".claude.json", JSON.stringify(claude));
    box.put(
      ".codex/config.toml",
      `${box.read(".codex/config.toml")}\n[mcp_servers.old]\nurl = "${old}"\n\n[mcp_servers.old.http_headers]\nAuthorization = "${header.Authorization}"\n\n[mcp_servers.mine]\nurl = "https://mine.example/mcp"\n`,
    );
    const cursor = JSON.parse(box.read(".cursor/mcp.json"));
    cursor.mcpServers = { ...cursor.mcpServers, old: { url: old, headers: header }, mine: { url: "https://mine.example/mcp" } };
    box.put(".cursor/mcp.json", JSON.stringify(cursor));
  }

  jqTest("removes a gateway entry of a server that Ferry no longer carries, and leaves an entry without the gateway prefix", async () => {
    const box = gatewayBox();
    await box.register(["linear"]);
    await withStaleEntries(box);

    const warnings = await box.register(["linear"]);

    const removed = (harness: string) => `Ferry removed ${harness} MCP server old from the box. It pointed at the MCP gateway, and Ferry does not carry it.`;
    expect(warnings).toEqual([removed("claude"), removed("codex"), removed("cursor")]);
    const entries = box.entries();
    for (const harness of ["claude", "codex", "cursor"] as const) {
      expect(Object.keys(entries[harness]).sort()).toEqual(["github", "linear", "mine"]);
      expect((entries[harness] as Record<string, { url: string }>).mine?.url).toBe("https://mine.example/mcp");
    }
    // The Codex file is valid TOML without the header table of old.
    expect(box.read(".codex/config.toml")).not.toContain("old");
    expect(JSON.stringify({ runs: box.link.runs, outputs: box.outputs, warnings })).not.toContain(KEY);
  });

  jqTest("the cleanup of a sync without the gateway removes the gateway entries that the direct path left", async () => {
    const box = gatewayBox();
    await box.register(["linear"]);
    await withStaleEntries(box);

    // The sync without the gateway: the direct path first, then the cleanup in the command that removes the gateway.
    const warnings = await box.register();
    const result = await box.link.run(gatewayCleanupCommand(BUILTIN_HARNESSES, BUILTIN_TOOLS, box.home, mcp, false)!);
    const stdout = result.ok ? result.stdout : "";

    expect(warnings).toEqual([]);
    expect(gatewayCleanupLines(stdout)).toHaveLength(3);
    const entries = box.entries();
    for (const harness of ["claude", "codex", "cursor"] as const) {
      expect(Object.keys(entries[harness]).sort()).toEqual(["github", "linear", "mine"]);
    }
    expect(JSON.stringify(entries)).not.toContain("127.0.0.1");
    expect(JSON.stringify({ runs: box.link.runs, outputs: box.outputs })).not.toContain(KEY);
  });

  jqTest("the cleanup of the uninstall gives a direct entry back from servers.json and removes the other gateway entries", async () => {
    const box = gatewayBox();
    await box.register(["linear"]);
    await withStaleEntries(box);
    box.put(".ferry/mcp-gateway/servers.json", JSON.stringify({ servers: { linear: { url: linear.url } } }));

    const command = gatewayCleanupCommand(BUILTIN_HARNESSES, BUILTIN_TOOLS, box.home, [], true)!;
    const result = await box.link.run(command);
    const stdout = result.ok ? result.stdout : "";

    const lines = gatewayCleanupLines(stdout);
    expect(lines.filter((line) => line.includes("linear"))).toEqual(
      ["claude", "codex", "cursor"].map((harness) => `Ferry changed ${harness} MCP server linear on the box back to its direct entry.`),
    );
    expect(lines.filter((line) => line.includes(" old "))).toHaveLength(3);
    const direct = { command: "github-mcp", args: ["--org", "example"] };
    const mine = "https://mine.example/mcp";
    expect(box.entries()).toEqual({
      claude: { linear: { type: "http", url: linear.url }, github: { type: "stdio", ...direct }, mine: { type: "http", url: mine } },
      codex: { linear: { url: linear.url }, github: direct, mine: { url: mine } },
      cursor: { linear: { url: linear.url }, github: direct, mine: { url: mine } },
    });
    expect(JSON.stringify({ runs: box.link.runs, outputs: box.outputs, lines })).not.toContain(KEY);
  });

  describe("with a shared stdio server", () => {
    const SECRET = `ghp_${"s".repeat(36)}`;
    const OTHER = `xoxb-${"o".repeat(30)}`;
    const shared = stdio("github", { args: ["--org", "example"], env: ["GITHUB_TOKEN", "GITHUB_ORG"] });
    const local = stdio("local", { env: ["LOCAL_KEY"] });
    const sharedMcp = [
      { harness: "claude", servers: [linear, shared, local] },
      { harness: "codex", servers: [linear, shared] },
      { harness: "cursor", servers: [linear, shared] },
    ];
    const full = { GITHUB_TOKEN: SECRET, GITHUB_ORG: "example" };
    const direct = (env: Record<string, string>) => ({ command: "github-mcp", args: ["--org", "example"], env });

    /** A gateway box whose harness entries of github are direct, with env values. Only the Codex entry has all keys. */
    function sharedBox() {
      const box = gatewayBox();
      box.put(".ferry/box.json", '{"mode":"box"}\n');
      box.put(".local/bin/ferry", `#!/bin/sh\n[ "$*" != "mcp serve --help" ] || echo 'Usage: ferry mcp serve [options]'\n`);
      chmodSync(join(box.home, ".local", "bin", "ferry"), 0o755);
      writeFileSync(join(box.home, "bin", "systemctl"), "#!/bin/sh\nexit 0\n");
      chmodSync(join(box.home, "bin", "systemctl"), 0o755);
      box.put(
        ".claude.json",
        JSON.stringify({ mcpServers: { github: { type: "stdio", ...direct({ GITHUB_TOKEN: SECRET }) }, local: { type: "stdio", command: "local-mcp", args: [], env: { LOCAL_KEY: OTHER } } } }),
      );
      box.put(
        ".codex/config.toml",
        `[mcp_servers.github]\ncommand = "github-mcp"\nargs = ["--org", "example"]\n\n[mcp_servers.github.env]\nGITHUB_TOKEN = "${SECRET}"\nGITHUB_ORG = "example"\n`,
      );
      box.put(".cursor/mcp.json", JSON.stringify({ mcpServers: { github: direct({ GITHUB_TOKEN: SECRET }) } }));
      const common = { harnesses: BUILTIN_HARNESSES, tools: BUILTIN_TOOLS, link: box.link };
      /** One sync with the gateway, as `runSync` does it: the gateway files first, then the harness entries. */
      const enable = async (names: readonly string[]) => {
        const { servers, envKeys } = gatewayServers(sharedMcp, ["claude", "codex", "cursor"], names);
        const list = Object.keys(envKeys);
        const started = await enableGateway(box.link, box.home, servers, {
          envKeys,
          cleanup: gatewayCleanupCommand(BUILTIN_HARNESSES, BUILTIN_TOOLS, box.home, sharedMcp, false, list),
          envScript: sharedEnvScript(BUILTIN_HARNESSES, BUILTIN_TOOLS, box.home, sharedMcp, list),
          restore: sharedRestoreCommand(BUILTIN_HARNESSES, BUILTIN_TOOLS, box.home, sharedMcp, list),
        });
        const warnings = await registerBoxMcp({ ...common, remoteHome: box.home, mcp: sharedMcp, gateway: Object.keys(servers), shared: list });
        return { started, warnings };
      };
      /** One sync without the gateway: the direct path first, then the removal of the gateway. */
      const disable = async () => {
        const warnings = await registerBoxMcp({ ...common, remoteHome: box.home, mcp: sharedMcp });
        const { output } = await disableGateway(
          box.link,
          gatewayCleanupCommand(BUILTIN_HARNESSES, BUILTIN_TOOLS, box.home, sharedMcp, false, []),
          sharedRestoreCommand(BUILTIN_HARNESSES, BUILTIN_TOOLS, box.home, sharedMcp),
        );
        return [...warnings, ...gatewayCleanupLines(output)];
      };
      const github = () => {
        const entries = box.entries();
        return { claude: entries.claude.github, codex: entries.codex.github, cursor: entries.cursor.github };
      };
      const captured = (extra: unknown = null) => JSON.stringify({ runs: box.link.runs, outputs: box.outputs, extra });
      return { ...box, enable, disable, github, captured };
    }

    jqTest("moves the env values into servers.json, points the harness entries at the gateway, and keeps the other stdio servers direct", async () => {
      const box = sharedBox();

      const { started, warnings } = await box.enable(["github"]);

      expect(started).toMatchObject({ state: "running", sharing: true });
      expect(warnings).toEqual([]);
      const file = join(box.home, ".ferry", "mcp-gateway", "servers.json");
      // The first harness entry with all keys gives the env: the Claude entry lacks GITHUB_ORG, the Codex entry has it.
      expect(JSON.parse(readFileSync(file, "utf8")).servers.github).toEqual(direct(full));
      expect(statSync(file).mode & 0o777).toBe(0o600);
      const header = { Authorization: `Bearer ${KEY}` };
      const url = "http://127.0.0.1:47820/mcp/github";
      expect(box.github()).toEqual({
        claude: { type: "http", url, headers: header },
        codex: { url, http_headers: header },
        cursor: { url, headers: header },
      });
      expect(box.entries().claude.local).toEqual({ type: "stdio", command: "local-mcp", args: [], env: { LOCAL_KEY: OTHER } });
      for (const secret of [SECRET, OTHER, KEY]) expect(box.captured(warnings)).not.toContain(secret);

      // A second sync keeps the env values of servers.json, though no harness entry has them now.
      await box.enable(["github"]);
      expect(JSON.parse(readFileSync(file, "utf8")).servers.github).toEqual(direct(full));

      const issues = await checkBoxMcp({
        remoteHome: box.home,
        harnesses: BUILTIN_HARNESSES,
        tools: BUILTIN_TOOLS,
        sources: sharedMcp.map((entry) => ({ ...entry, nonPortable: [] })),
        link: box.link,
        shared: ["github"],
      });
      expect(issues.filter((issue) => issue.kind.startsWith("env"))).toEqual([]);
    });

    jqTest("without the gateway, copies the env values back into each harness entry before the gateway directory goes", async () => {
      const box = sharedBox();
      await box.enable(["github"]);

      const lines = await box.disable();

      expect(lines.filter((line) => line.includes("github"))).toEqual(
        ["claude", "codex", "cursor"].map((harness) => `Ferry changed ${harness} MCP server github on the box back to its direct entry.`),
      );
      expect(box.github()).toEqual({ claude: { type: "stdio", ...direct(full) }, codex: direct(full), cursor: direct(full) });
      expect(existsSync(join(box.home, ".ferry", "mcp-gateway"))).toBe(false);
      expect(statSync(join(box.home, ".codex", "config.toml")).mode & 0o777).toBe(0o600);
      for (const secret of [SECRET, OTHER, KEY]) expect(box.captured(lines)).not.toContain(secret);

      // The next sync without the gateway keeps the entries and their env values.
      await box.disable();
      expect(box.github()).toEqual({ claude: { type: "stdio", ...direct(full) }, codex: direct(full), cursor: direct(full) });
    });

    jqTest("without the gateway, keeps the gateway directory and the unit when an entry cannot get its env values back", async () => {
      const box = sharedBox();
      await box.enable(["github"]);
      box.put(".config/systemd/user/ferry-mcp-gateway.service", "[Unit]\n");
      // A codex that cannot add the direct entry again, as with a timeout.
      const codex = join(box.home, "bin", "codex");
      writeFileSync(codex, readFileSync(codex, "utf8").replace("const name = words[0];", "const name = words[0];\nif (command === 'add') process.exit(1);"));

      const result = await disableGateway(box.link, gatewayCleanupCommand(BUILTIN_HARNESSES, BUILTIN_TOOLS, box.home, sharedMcp, false, []));

      expect(result).toMatchObject({ removed: false, kept: true });
      expect(gatewayCleanupLines(result.output)).toContain("could not change codex MCP server github on the box, which points at the MCP gateway");
      expect(JSON.parse(box.read(".ferry/mcp-gateway/servers.json")).servers.github).toEqual(direct(full));
      expect(existsSync(join(box.home, ".config", "systemd", "user", "ferry-mcp-gateway.service"))).toBe(true);
      for (const secret of [SECRET, OTHER, KEY]) expect(box.captured(result)).not.toContain(secret);
    });

    jqTest("a failed claude mcp add-json, then a sync that writes a direct entry without env, keeps the env values and restores them", async () => {
      const box = sharedBox();
      await box.enable(["github"]);
      const claude = join(box.home, "bin", "claude");
      const working = readFileSync(claude, "utf8");
      // Sync 1: claude removes the gateway entry, but cannot add the direct entry, as with a timeout.
      writeFileSync(claude, working.replace("const name = words[0];", "const name = words[0];\nif (command === 'add-json') process.exit(1);"));

      const first = await box.disable();

      expect(first).toContain("could not change claude MCP server github on the box, which points at the MCP gateway");
      expect(first).toContain("could not give claude MCP server github on the box its env values back from ~/.ferry/mcp-gateway/servers.json");
      expect(box.entries().claude.github).toBeUndefined();
      expect(JSON.parse(box.read(".ferry/mcp-gateway/servers.json")).servers.github).toEqual(direct(full));

      // Sync 2: claude works again. The direct path writes the entry without env, then the gateway goes.
      // The Codex and Cursor entries lost their env values too, so each restore path runs.
      writeFileSync(claude, working);
      box.put(".codex/config.toml", '[mcp_servers.github]\ncommand = "github-mcp"\nargs = ["--org", "example"]\n');
      box.put(".cursor/mcp.json", JSON.stringify({ mcpServers: { github: { command: "github-mcp", args: ["--org", "example"], env: { GITHUB_ORG: "example" } } } }));
      const second = await box.disable();

      expect(second.filter((line) => line.includes("github"))).toEqual(
        ["claude", "codex", "cursor"].map((harness) => `Ferry changed ${harness} MCP server github on the box back to its direct entry.`),
      );
      expect(box.github()).toEqual({ claude: { type: "stdio", ...direct(full) }, codex: direct(full), cursor: direct(full) });
      expect(existsSync(join(box.home, ".ferry", "mcp-gateway"))).toBe(false);
      for (const secret of [SECRET, OTHER, KEY]) expect(box.captured([first, second])).not.toContain(secret);
    });

    /** Make the add command of the claude and codex stubs fail, as with a timeout, or work again. */
    function breakAdd(box: { readonly home: string }) {
      const files = ["claude", "codex"].map((name) => join(box.home, "bin", name));
      const working = files.map((file) => readFileSync(file, "utf8"));
      files.forEach((file, index) =>
        writeFileSync(file, working[index]!.replace("const name = words[0];", "const name = words[0];\nif (command === 'add' || command === 'add-json') process.exit(1);")),
      );
      return () => files.forEach((file, index) => writeFileSync(file, working[index]!));
    }

    jqTest("a second uninstall after a failed add in the first one still has the env values and restores them", async () => {
      const box = sharedBox();
      await box.enable(["github"]);
      rmSync(join(box.home, ".cursor", "mcp.json"));
      const command = uninstallCleanupCommand(BUILTIN_HARNESSES, BUILTIN_TOOLS, box.home)!;
      const repair = breakAdd(box);

      const first = await box.link.run(command);
      const firstOut = first.ok ? first.stdout : "";

      // Cursor is not on this box, so only claude and codex count.
      const github = () => ({
        claude: JSON.parse(box.read(".claude.json")).mcpServers.github,
        codex: (Bun.TOML.parse(box.read(".codex/config.toml")) as { mcp_servers: Record<string, unknown> }).mcp_servers.github,
      });
      expect(gatewayCleanupFailed(firstOut)).toBe(true);
      expect(github()).toEqual({ claude: undefined, codex: undefined });
      expect(JSON.parse(box.read(".ferry/mcp-gateway/servers.json")).servers.github).toEqual(direct(full));

      // The second uninstall: no harness has an entry of github now, so the check writes it from servers.json.
      repair();
      const second = await box.link.run(command);
      const secondOut = second.ok ? second.stdout : "";

      expect(gatewayCleanupFailed(secondOut)).toBe(false);
      expect(gatewayCleanupLines(secondOut).filter((line) => line.includes("github"))).toEqual(
        ["claude", "codex"].map((harness) => `Ferry changed ${harness} MCP server github on the box back to its direct entry.`),
      );
      expect(github()).toEqual({ claude: { type: "stdio", ...direct(full) }, codex: direct(full) });
      for (const secret of [SECRET, OTHER, KEY]) expect(box.captured([firstOut, secondOut])).not.toContain(secret);
      for (const key of Object.keys(full)) expect(JSON.stringify([firstOut, secondOut])).not.toContain(key);
    });

    jqTest("a server that leaves mcp_gateway_shared after a failed restore keeps its env in servers.json until the next sync restores it", async () => {
      const box = sharedBox();
      await box.enable(["github"]);
      const repair = breakAdd(box);

      const first = await box.enable([]);

      const file = () => JSON.parse(box.read(".ferry/mcp-gateway/servers.json")).servers;
      expect(file().github).toEqual({ ...direct(full), leaving: true });
      expect(gatewayCleanupLines(first.started.state === "running" ? first.started.output : "")).toContain(
        "could not give claude MCP server github on the box its env values back from ~/.ferry/mcp-gateway/servers.json",
      );

      repair();
      const second = await box.enable([]);

      expect(file().github).toBeUndefined();
      expect(box.github()).toEqual({ claude: { type: "stdio", ...direct(full) }, codex: direct(full), cursor: direct(full) });
      const outputs = [first, second].map(({ started }) => (started.state === "running" ? started.output : ""));
      for (const secret of [SECRET, OTHER, KEY]) expect(box.captured({ outputs, warnings: [first.warnings, second.warnings] })).not.toContain(secret);
      for (const key of Object.keys(full)) expect(JSON.stringify(outputs)).not.toContain(key);
    });

    jqTest("a server that leaves mcp_gateway_shared gets its direct entry and its env values back", async () => {
      const box = sharedBox();
      await box.enable(["github"]);

      const { warnings } = await box.enable([]);

      expect(box.github()).toEqual({ claude: { type: "stdio", ...direct(full) }, codex: direct(full), cursor: direct(full) });
      expect(JSON.parse(box.read(".ferry/mcp-gateway/servers.json")).servers.github).toBeUndefined();
      expect(warnings).toEqual([]);
      for (const secret of [SECRET, OTHER, KEY]) expect(box.captured(warnings)).not.toContain(secret);
    });

    jqTest("the cleanup of the uninstall copies the env values back from servers.json", async () => {
      const box = sharedBox();
      await box.enable(["github"]);

      const result = await box.link.run(gatewayCleanupCommand(BUILTIN_HARNESSES, BUILTIN_TOOLS, box.home, [], true)!);

      expect(gatewayCleanupLines(result.ok ? result.stdout : "").filter((line) => line.includes("github"))).toHaveLength(3);
      expect(box.github()).toEqual({ claude: { type: "stdio", ...direct(full) }, codex: direct(full), cursor: direct(full) });
      for (const secret of [SECRET, OTHER, KEY]) expect(box.captured()).not.toContain(secret);
    });

    jqTest("checks the env keys of a shared server in servers.json", async () => {
      const box = sharedBox();
      await box.enable(["github"]);
      const file = JSON.parse(box.read(".ferry/mcp-gateway/servers.json"));
      file.servers.github.env = { GITHUB_TOKEN: SECRET };
      box.put(".ferry/mcp-gateway/servers.json", JSON.stringify(file));

      const issues = await checkBoxMcp({
        remoteHome: box.home,
        harnesses: BUILTIN_HARNESSES,
        tools: BUILTIN_TOOLS,
        sources: sharedMcp.map((entry) => ({ ...entry, nonPortable: [] })),
        link: box.link,
        shared: ["github"],
      });

      expect(issues.filter((issue) => issue.kind === "env-missing")).toEqual([
        { kind: "env-missing", harness: "gateway", server: "github", keys: ["GITHUB_ORG"], file: ".ferry/mcp-gateway/servers.json" },
      ]);
      expect(box.captured(issues)).not.toContain(SECRET);
    });
  });

  test("a box without the gateway gets no command that reads the client key", async () => {
    const link = new FakeLink(() => ok());

    await registerBoxMcp({ remoteHome: "/home/agent", harnesses: BUILTIN_HARNESSES, tools: BUILTIN_TOOLS, mcp, link });

    expect(link.runs.length).toBeGreaterThan(0);
    // The direct path names the gateway URL only to leave a gateway entry of a stdio server as it is.
    expect(link.runs.some((run) => run.command.includes(".ferry/mcp-gateway"))).toBe(false);
  });
});
