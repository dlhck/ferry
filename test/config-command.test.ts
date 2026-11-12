import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { runCli } from "../src/cli.ts";
import { configPath, readConfig } from "../src/config.ts";

const homes: string[] = [];

afterEach(() => {
  for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true });
});

const TOP = ["version = 1", 'publisher = "operator"', 'snapshot_url = "snapshot.git"'];
const BOXES = [
  ...TOP,
  'default_box = "dev"',
  "",
  "[box.dev]",
  'tailscale = "dev"',
  'ssh_user = "ferry"',
  "",
  "[box.b2]",
  'transport = "ssh"',
  'destination = "ferry@b2"',
];

function home(lines: readonly string[]): string {
  const dir = mkdtempSync(join(tmpdir(), "ferry-config-command-"));
  homes.push(dir);
  mkdirSync(dirname(configPath(dir)), { recursive: true });
  writeFileSync(configPath(dir), [...lines, ""].join("\n"));
  return dir;
}

/** Run ferry with --json in `dir`, and return the envelope and the exit code. */
async function ferry(dir: string, args: readonly string[]) {
  const out: string[] = [];
  const err: string[] = [];
  let exitCode = 0;
  await runCli(
    ["--json", ...args],
    {
      home: () => dir,
      readConfig: () => readConfig(dir),
      writeLine: (line) => out.push(line),
      writeError: (line) => err.push(line),
      isInteractive: () => false,
    },
    { renderError: (message) => err.push(message), setExitCode: (code) => (exitCode = code) },
  );
  return { envelope: JSON.parse(out.join("\n")), exitCode, text: [...out, ...err].join("\n") };
}

/** Run ferry without --json, and return the text lines. */
async function ferryText(dir: string, args: readonly string[]): Promise<string[]> {
  const out: string[] = [];
  await runCli(args, { home: () => dir, readConfig: () => readConfig(dir), writeLine: (line) => out.push(line), isInteractive: () => false });
  return out;
}

const file = (dir: string) => readFileSync(configPath(dir), "utf8");

describe("ferry config set and unset", () => {
  test("mcp_gateway: true writes the key, false and unset remove it", async () => {
    const dir = home(BOXES);
    expect((await ferry(dir, ["config", "set", "mcp_gateway", "true", "--box", "b2"])).envelope).toEqual({
      schemaVersion: 1,
      command: "config set",
      ok: true,
      result: { changed: true, box: "b2", key: "mcp_gateway", syncNeeded: true },
      warnings: [],
      error: null,
    });
    expect(readConfig(dir)?.boxes?.[1]?.mcpGateway).toBe(true);
    await ferry(dir, ["config", "set", "mcp_gateway", "false", "--box", "b2"]);
    expect(file(dir)).not.toContain("mcp_gateway");
    await ferry(dir, ["config", "set", "mcp_gateway", "true", "--box", "b2"]);
    expect((await ferry(dir, ["config", "unset", "mcp_gateway", "--box", "b2"])).envelope.result).toEqual({
      changed: true,
      box: "b2",
      key: "mcp_gateway",
      syncNeeded: true,
    });
    expect(file(dir)).not.toContain("mcp_gateway");
  });

  test("mcp_gateway_shared and projects take the items as arguments, and an empty list removes the key", async () => {
    const dir = home(BOXES);
    await ferry(dir, ["config", "set", "mcp_gateway_shared", "context7", "github", "--box", "dev"]);
    await ferry(dir, ["config", "set", "projects", "code/app", "code/api", "--box", "dev"]);
    expect(readConfig(dir)?.boxes?.[0]).toMatchObject({ mcpGatewayShared: ["context7", "github"], projects: ["code/app", "code/api"] });

    expect((await ferry(dir, ["config", "set", "mcp_gateway_shared", "--box", "dev"])).envelope.result.changed).toBe(true);
    await ferry(dir, ["config", "unset", "projects", "--box", "dev"]);
    expect(file(dir)).not.toContain("mcp_gateway_shared");
    expect(file(dir)).not.toContain("projects");
  });

  test("agent_memory_max takes one size of the config rule", async () => {
    const dir = home(BOXES);
    await ferry(dir, ["config", "set", "agent_memory_max", "6G", "--box", "dev"]);
    expect(readConfig(dir)?.boxes?.[0]?.agentMemoryMax).toBe("6G");
    await ferry(dir, ["config", "set", "agent_memory_max", "50%", "--box", "dev"]);
    expect(readConfig(dir)?.boxes?.[0]?.agentMemoryMax).toBe("50%");
    await ferry(dir, ["config", "unset", "agent_memory_max", "--box", "dev"]);
    expect(file(dir)).not.toContain("agent_memory_max");
  });

  test("notifications.agents is global, and its change needs a sync of each box", async () => {
    const dir = home(BOXES);
    expect((await ferry(dir, ["config", "set", "notifications.agents", "true"])).envelope.result).toEqual({
      changed: true,
      box: null,
      key: "notifications.agents",
      syncNeeded: true,
    });
    expect(readConfig(dir)?.notifications).toEqual({ agents: true });
    await ferry(dir, ["config", "unset", "notifications.agents"]);
    expect(readConfig(dir)?.notifications).toBeUndefined();

    const refused = await ferry(dir, ["config", "set", "notifications.agents", "true", "--box", "dev"]);
    expect(refused.exitCode).toBe(1);
    expect(refused.envelope.error.code).toBe("usage");
  });

  test("notifications.agents works on a [host] config, but a box key needs box tables", async () => {
    const dir = home([...TOP, "", "[host]", 'tailscale = "box"', 'ssh_user = "ferry"']);
    await ferry(dir, ["config", "set", "notifications.agents", "true"]);
    expect(readConfig(dir)).toMatchObject({ notifications: { agents: true }, host: { tailscale: "box", sshUser: "ferry" } });

    const before = file(dir);
    const refused = await ferry(dir, ["config", "set", "mcp_gateway", "true"]);
    expect(refused.envelope.error.code).toBe("config-invalid");
    expect(refused.envelope.error.message).toContain("ferry box add");
    expect(file(dir)).toBe(before);
  });

  test.each([
    ["notifications.agents", ["yes"]],
    ["mcp_gateway", ["1"]],
    ["mcp_gateway", ["true", "false"]],
    ["mcp_gateway_shared", [""]],
    ["agent_memory_max", ["100M"]],
    ["agent_memory_max", ["6"]],
    ["agent_memory_max", ["6G", "8G"]],
    ["projects", ["/abs"]],
    ["projects", ["../up"]],
    ["projects", ["~/code"]],
    ["unknown_key", ["x"]],
  ])("an invalid value for %s %j fails and changes nothing", async (key, values) => {
    const dir = home(["# a comment", ...BOXES]);
    const before = file(dir);
    const result = await ferry(dir, ["config", "set", key, ...values, ...(key === "notifications.agents" ? [] : ["--box", "dev"])]);
    expect(result.exitCode).toBe(1);
    expect(result.envelope).toMatchObject({ ok: false, error: { code: "usage" } });
    expect(file(dir)).toBe(before);
  });

  test("unset takes no value", async () => {
    const dir = home(BOXES);
    const result = await ferry(dir, ["config", "unset", "projects", "code/app", "--box", "dev"]);
    expect(result.exitCode).toBe(1);
  });

  test("without --box, a box key uses default_box, then the only box, else it fails", async () => {
    const dir = home(BOXES);
    expect((await ferry(dir, ["config", "set", "mcp_gateway", "true"])).envelope.result.box).toBe("dev");

    const only = home([...TOP, "", "[box.solo]", 'tailscale = "solo"', 'ssh_user = "ferry"']);
    expect((await ferry(only, ["config", "set", "mcp_gateway", "true"])).envelope.result.box).toBe("solo");

    const two = home(BOXES.filter((line) => !line.startsWith("default_box")));
    const before = file(two);
    const result = await ferry(two, ["config", "set", "mcp_gateway", "true"]);
    expect(result.envelope.error.code).toBe("box-required");
    expect(file(two)).toBe(before);

    expect((await ferry(dir, ["config", "set", "mcp_gateway", "true", "--box", "nope"])).envelope.error.code).toBe("unknown-box");
  });

  test("a value that does not change gives changed and syncNeeded false, and writes nothing", async () => {
    const dir = home(["# a comment", ...BOXES]);
    for (const args of [
      ["config", "set", "mcp_gateway", "false", "--box", "dev"],
      ["config", "unset", "projects", "--box", "dev"],
      ["config", "set", "notifications.agents", "false"],
    ]) {
      expect((await ferry(dir, args)).envelope.result).toMatchObject({ changed: false, syncNeeded: false });
    }
    expect(file(dir)).toContain("# a comment");
  });

  test("the text output names the sync to run", async () => {
    const dir = home(BOXES);
    expect(await ferryText(dir, ["config", "set", "mcp_gateway", "true", "--box", "b2"])).toEqual([
      "Set mcp_gateway of box b2.",
      "Run ferry sync --box b2 to apply it.",
    ]);
    expect(await ferryText(dir, ["config", "set", "notifications.agents", "true"])).toEqual(["Set notifications.agents.", "Run ferry sync to apply it."]);
  });
});

describe("ferry config get", () => {
  const MCP = {
    mcpServers: {
      github: { command: "github-mcp", args: ["stdio"], env: { GITHUB_TOKEN: "env-value-never-printed" } },
      context7: { command: "context7-mcp", args: [], env: {} },
      linear: { type: "http", url: "https://mcp.linear.example/mcp" },
    },
  };

  test("gives the keys of each box and the sorted stdio server names, with no env value, command, or URL", async () => {
    const dir = home([...BOXES.slice(0, 8), "mcp_gateway = true", 'mcp_gateway_shared = ["context7"]', 'agent_memory_max = "6G"', 'projects = ["code/app"]', ...BOXES.slice(8)]);
    writeFileSync(join(dir, ".claude.json"), JSON.stringify(MCP));

    const { envelope, text } = await ferry(dir, ["config", "get"]);
    expect(envelope).toEqual({
      schemaVersion: 1,
      command: "config get",
      ok: true,
      result: {
        schemaVersion: 1,
        notifications: { agents: false },
        boxes: [
          { name: "dev", mcpGateway: true, mcpGatewayShared: ["context7"], agentMemoryMax: "6G", projects: ["code/app"], stdioServers: ["context7", "github"] },
          { name: "b2", mcpGateway: false, mcpGatewayShared: [], agentMemoryMax: null, projects: [], stdioServers: ["context7", "github"] },
        ],
      },
      warnings: [],
      error: null,
    });
    for (const secret of ["env-value-never-printed", "GITHUB_TOKEN", "github-mcp", "mcp.linear.example"]) expect(text).not.toContain(secret);

    const lines = (await ferryText(dir, ["config", "get"])).join("\n");
    expect(lines).toContain("stdio MCP servers: context7, github");
    expect(lines).not.toContain("env-value-never-printed");
  });

  test("a failed MCP read gives empty stdioServers and a warning without the value", async () => {
    const dir = home(BOXES);
    writeFileSync(
      join(dir, ".claude.json"),
      JSON.stringify({ mcpServers: { leaky: { command: "tool", args: ["--token", "ghp_abcdefghijklmnopqrstuvwxyz0123456789"] } } }),
    );

    const { envelope, text } = await ferry(dir, ["config", "get"]);
    expect(envelope.ok).toBe(true);
    expect(envelope.result.boxes.map((box: { stdioServers: unknown }) => box.stdioServers)).toEqual([[], []]);
    expect(envelope.warnings).toHaveLength(1);
    expect(envelope.warnings[0]).toStartWith("Ferry could not read the MCP servers of this machine: ");
    expect(text).not.toContain("ghp_abcdefghijklmnopqrstuvwxyz0123456789");
  });
});
