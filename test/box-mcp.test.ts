import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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
function shellBox(path = "/usr/bin:/bin") {
  const home = mkdtempSync(join(tmpdir(), "ferry-mcp-box-"));
  directories.push(home);
  const link = new FakeLink(async (command) => {
    const child = Bun.spawn(["sh", "-c", command], { cwd: home, env: { HOME: home, PATH: path }, stdout: "pipe" });
    await child.exited;
    return ok(await new Response(child.stdout).text());
  });
  const put = (file: string, text: string) => {
    mkdirSync(join(home, file, ".."), { recursive: true });
    writeFileSync(join(home, file), text);
  };
  return { home, link, put, read: (file: string) => readFileSync(join(home, file), "utf8") };
}

function stdio(name: string, fields: Partial<StdioMcpServer> = {}): StdioMcpServer {
  return { name, type: "stdio", command: `${name}-mcp`, args: [], env: [], ...fields };
}

describe("registerBoxMcp with stdio servers", () => {
  test("writes a stdio server into the MCP file of each harness that declares it, and keeps the box servers", async () => {
    const box = shellBox();
    box.put(".claude.json", JSON.stringify({ numStartups: 3, mcpServers: { boxonly: { command: "box-mcp" } } }));
    box.put(".codex/config.toml", ['model = "o3"', "[mcp_servers.boxonly]", 'command = "box-mcp"'].join("\n"));
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
    // No harness CLI runs for a stdio server.
    expect(box.link.runs.some((run) => run.command.includes("mcp add"))).toBe(false);
    const entry = { command: "npx", args: ["-y", "@example/github-mcp"] };
    expect(JSON.parse(box.read(".claude.json"))).toEqual({
      numStartups: 3,
      mcpServers: { boxonly: { command: "box-mcp" }, github: entry },
    });
    expect(Bun.TOML.parse(box.read(".codex/config.toml"))).toEqual({
      model: "o3",
      mcp_servers: { boxonly: { command: "box-mcp" }, github: entry },
    });
    expect(JSON.parse(box.read(".cursor/mcp.json"))).toEqual({ mcpServers: { github: entry } });
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
    const text = ["# box comment", "[mcp_servers.docs]", 'command = "docs-mcp"', "args = []"].join("\n");
    box.put(".codex/config.toml", text);

    await registerBoxMcp({
      remoteHome: box.home,
      harnesses: BUILTIN_HARNESSES,
      tools: BUILTIN_TOOLS,
      mcp: [{ harness: "codex", servers: [stdio("docs")] }],
      link: box.link,
    });

    expect(box.read(".codex/config.toml")).toBe(text);
  });

  test("declares the remote Claude servers with the CLI and writes the stdio ones into the file", async () => {
    const link = new FakeLink((command) => (command.includes("mv ") || command.startsWith("sh -c") ? ok() : ok("F{}")));
    const progress = recordProgress();

    await registerBoxMcp({
      remoteHome: "/home/agent",
      harnesses: BUILTIN_HARNESSES,
      tools: BUILTIN_TOOLS,
      mcp: [{ harness: "claude", servers: [{ name: "linear", type: "http", url: "https://mcp.linear.app/mcp" }, stdio("time")] }],
      link,
      progress,
    });

    expect(link.runs).toHaveLength(3);
    expect(link.runs[0]!.command).toContain("claude mcp add");
    expect(link.runs[0]!.command).not.toContain("time");
    expect(link.runs[1]!.command).toContain("/home/agent/.claude.json");
    const written = JSON.parse(link.runs[2]!.command.match(/printf '%s' '([\s\S]*)' > /)![1]!);
    expect(written).toEqual({ mcpServers: { time: { command: "time-mcp", args: [] } } });
    expect(progress.events).toEqual(["count:1/2", "count:2/2"]);
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
