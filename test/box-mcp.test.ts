import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mcpCommand, registerBoxMcp } from "../src/box-mcp.ts";
import type { LinkResult, RunOptions } from "../src/link.ts";
import { BUILTIN_HARNESSES, BUILTIN_TOOLS } from "../src/registry/builtin.ts";

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

describe("mcpCommand", () => {
  test("quotes each value", () => {
    expect(mcpCommand("x {name} {url}", { name: "a", url: "b c" })).toBe("x 'a' 'b c'");
  });
});
