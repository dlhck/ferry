import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Seed } from "../src/manifest.ts";
import {
  disableGatewayCommand,
  gatewayServers,
  parseGatewayStatus,
  readGatewayStatus,
  MCP_GATEWAY_TOOL,
} from "../src/mcp-gateway/service.ts";
import { noProgress, type Progress } from "../src/progress.ts";
import { runSync, type SyncDependencies } from "../src/sync.ts";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const LINEAR = "https://mcp.linear.example/mcp";

const seed: Seed = {
  ok: true,
  skills: [],
  instructions: null,
  roots: [],
  settings: [],
  mcp: [
    {
      harness: "claude",
      servers: [
        { name: "linear", type: "http", url: LINEAR },
        { name: "events", type: "sse", url: "https://events.example/sse" },
        { name: "files", type: "stdio", command: "files-mcp", args: ["--root", "."], env: ["FILES_TOKEN"] },
      ],
    },
    { harness: "codex", servers: [{ name: "linear", type: "http", url: LINEAR }, { name: "docs", type: "http", url: "https://docs.example/mcp" }] },
  ],
  identity: "seed-identity",
  leftovers: [],
  storeUpdates: [],
};

function config(mcpGateway: boolean) {
  return {
    version: 1 as const,
    publisher: "operator-machine",
    snapshotUrl: "git@example.test:operator/ferry-store.git",
    boxes: [{ name: "a", host: { transport: "ssh" as const, destination: "dev@box-a.example" }, ...(mcpGateway ? { mcpGateway: true as const } : {}) }],
  };
}

/**
 * One box whose home is a temporary directory. The fake link runs each
 * gateway command with `sh`, with a fake `systemctl` that records its
 * arguments. Other box commands only get recorded.
 */
function box(options: { readonly ferry?: boolean; readonly active?: boolean } = {}) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "ferry-gw-service-")));
  roots.push(root);
  const home = join(root, "operator");
  const boxHome = join(root, "box");
  const bin = join(root, "bin");
  mkdirSync(home, { recursive: true });
  mkdirSync(join(boxHome, ".ferry", "store"), { recursive: true });
  mkdirSync(bin);
  const calls = join(root, "systemctl.log");
  writeFileSync(
    join(bin, "systemctl"),
    `#!/bin/sh\nprintf '%s\\n' "$*" >> '${calls}'\ncase "$*" in *is-active*) exit ${options.active === false ? 1 : 0};; esac\nexit 0\n`,
  );
  chmodSync(join(bin, "systemctl"), 0o755);
  if (options.ferry !== false) {
    mkdirSync(join(boxHome, ".local", "bin"), { recursive: true });
    writeFileSync(join(boxHome, ".local", "bin", "ferry"), "#!/bin/sh\nexit 0\n");
    chmodSync(join(boxHome, ".local", "bin", "ferry"), 0o755);
    writeFileSync(join(boxHome, ".ferry", "box.json"), '{"mode":"box"}\n');
  }
  const commands: string[] = [];
  const outputs: string[] = [];
  const lines: string[] = [];
  const steps: string[] = [];
  const progress: Progress = {
    ...noProgress,
    start: (name) => steps.push(`start:${name}`),
    done: (detail) => steps.push(`done:${detail ?? ""}`),
    skip: (name, detail) => steps.push(`skip:${name}:${detail}`),
  };
  const dependencies = (mcpGateway: boolean, ferryVersion = "1.2.3"): SyncDependencies => ({
    readConfig: () => config(mcpGateway),
    publisher: () => "operator-machine",
    readSeed: () => seed,
    ferryVersion,
    progress,
    createLink: () => ({
      run: async (command, runOptions) => {
        commands.push(command);
        if (command.startsWith("printf")) return { ok: true, address: "a", stdout: `${boxHome}\n`, stderr: "" };
        if (!command.includes(".ferry/mcp-gateway")) return { ok: true, address: "a", stdout: "", stderr: "" };
        const child = Bun.spawn(["sh", "-c", command], {
          stdin: runOptions?.input ?? "ignore",
          stdout: "pipe",
          stderr: "pipe",
          env: { HOME: boxHome, PATH: `${bin}:/usr/bin:/bin` },
        });
        const [status, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
        outputs.push(stdout, stderr);
        expect(stderr).toBe("");
        expect(status).toBe(0);
        return { ok: true, address: "a", stdout, stderr };
      },
    }),
    openStore: async () => ({ path: join(home, ".ferry", "store"), publish: async () => ({ published: false, tip: "abc123" }) }),
    apply: async (input) => ({
      checkout: input.checkout,
      targetHome: input.targetHome,
      actions: [],
      unmanaged: [],
      managed: { instructionFiles: [], skillRoots: [], roots: [] },
    }),
    adopt: () => {},
    writePlan: () => {},
    writeLine: (line) => lines.push(line),
  });
  const gateway = join(boxHome, ".ferry", "mcp-gateway");
  const unit = join(boxHome, ".config", "systemd", "user", "ferry-mcp-gateway.service");
  const systemctl = () => (existsSync(calls) ? readFileSync(calls, "utf8").trim().split("\n") : []);
  return { home, boxHome, gateway, unit, commands, outputs, lines, steps, systemctl, dependencies, reset: () => rmSync(calls, { force: true }) };
}

const mode = (path: string) => statSync(path).mode & 0o777;

describe("gatewayServers", () => {
  test("takes the remote http servers of the given harnesses, with only names and URLs", () => {
    const { servers, warnings } = gatewayServers(seed.mcp, ["claude", "codex"]);

    expect(servers).toEqual({ docs: { url: "https://docs.example/mcp" }, linear: { url: LINEAR } });
    expect(warnings).toEqual([
      "The MCP gateway does not serve claude/events, because the gateway supports Streamable HTTP only, not SSE.",
    ]);
    expect(gatewayServers(seed.mcp, ["claude"]).servers).toEqual({ linear: { url: LINEAR } });
  });

  test("keeps the URL of the first harness when two harnesses give one name two URLs", () => {
    const mcp = [
      { harness: "claude", servers: [{ name: "linear", type: "http" as const, url: LINEAR }] },
      { harness: "codex", servers: [{ name: "linear", type: "http" as const, url: "https://other.example/mcp" }] },
    ];

    expect(gatewayServers(mcp, ["claude", "codex"])).toEqual({
      servers: { linear: { url: LINEAR } },
      warnings: ["The MCP gateway serves linear with the URL of the first harness. codex/linear has another URL."],
    });
  });

  test("skips a name that starts with a dot", () => {
    const mcp = [{ harness: "claude", servers: [{ name: ".hidden", type: "http" as const, url: LINEAR }] }];

    expect(gatewayServers(mcp, ["claude"]).servers).toEqual({});
  });
});

describe("sync with mcp_gateway", () => {
  test("writes servers.json and the client key with mode 0600, installs the unit, and starts it", async () => {
    const box1 = box();

    await runSync({ home: box1.home }, box1.dependencies(true));

    expect(JSON.parse(readFileSync(join(box1.gateway, "servers.json"), "utf8"))).toEqual({
      servers: { docs: { url: "https://docs.example/mcp" }, linear: { url: LINEAR } },
    });
    const key = readFileSync(join(box1.gateway, "client-key"), "utf8");
    expect(key).toMatch(/^[0-9a-f]{64}\n$/);
    expect(mode(box1.gateway)).toBe(0o700);
    expect(mode(join(box1.gateway, "servers.json"))).toBe(0o600);
    expect(mode(join(box1.gateway, "client-key"))).toBe(0o600);
    expect(readFileSync(box1.unit, "utf8")).toContain(`ExecStart="${box1.boxHome}/.local/bin/ferry" mcp serve\nRestart=on-failure\n`);
    expect(box1.systemctl()).toEqual([
      "--user daemon-reload",
      "--user enable ferry-mcp-gateway.service",
      "--user restart ferry-mcp-gateway.service",
      "--user is-active --quiet ferry-mcp-gateway.service",
    ]);
    expect(box1.steps).toContain("start:Starting the MCP gateway");
    expect(box1.steps[box1.steps.indexOf("start:Starting the MCP gateway") + 1]).toBe("done:2 servers, running");
    expect(box1.lines).toContain(
      "Warning: The MCP gateway does not serve claude/events, because the gateway supports Streamable HTTP only, not SSE.",
    );
    // The key stays on the box: no command, output, or line has it.
    for (const text of [...box1.commands, ...box1.outputs, ...box1.lines]) expect(text).not.toContain(key.trim());
    // The URLs go on stdin, so the gateway command does not hold them, and the stdio server stays out.
    expect(box1.commands.find((command) => command.includes(".ferry/mcp-gateway"))).not.toContain(LINEAR);
    expect(readFileSync(join(box1.gateway, "servers.json"), "utf8")).not.toContain("files");
  });

  test("a second sync keeps the client key and does not restart an unchanged unit", async () => {
    const box1 = box();
    await runSync({ home: box1.home }, box1.dependencies(true));
    const key = readFileSync(join(box1.gateway, "client-key"), "utf8");
    box1.reset();

    await runSync({ home: box1.home }, box1.dependencies(true));

    expect(readFileSync(join(box1.gateway, "client-key"), "utf8")).toBe(key);
    expect(box1.systemctl()).toEqual(["--user enable --now ferry-mcp-gateway.service", "--user is-active --quiet ferry-mcp-gateway.service"]);
  });

  test("warns when the service does not run after the start", async () => {
    const box1 = box({ active: false });

    await runSync({ home: box1.home }, box1.dependencies(true));

    expect(box1.lines).toContain(
      "Warning: ferry-mcp-gateway.service does not run on the box. Run journalctl --user -u ferry-mcp-gateway.service on the box to see why.",
    );
  });

  test("writes nothing and warns when the box has no Ferry", async () => {
    const box1 = box({ ferry: false });

    await runSync({ home: box1.home }, box1.dependencies(true));

    expect(existsSync(box1.gateway)).toBe(false);
    expect(existsSync(box1.unit)).toBe(false);
    expect(box1.lines).toContain("Warning: The MCP gateway needs Ferry on the box. Run ferry install --box a.");
  });

  test("a development build sends no gateway command to the box", async () => {
    const box1 = box();

    await runSync({ home: box1.home }, box1.dependencies(true, "0.0.0-dev"));

    expect(box1.commands.filter((command) => command.includes("mcp-gateway"))).toEqual([]);
    expect(box1.steps).toContain("skip:Starting the MCP gateway:development build");
    expect(box1.lines).toContain(
      "Warning: The MCP gateway runs the Ferry of the box. This Ferry is a development build, so the box has no Ferry and Ferry did not start the gateway.",
    );
  });

  test("a dry run sends no gateway command and the plan has no gateway value", async () => {
    const box1 = box();

    const result = await runSync({ home: box1.home, dryRun: true }, box1.dependencies(true));

    expect(box1.commands).toEqual([]);
    expect(JSON.stringify(result)).not.toContain("mcp-gateway");
  });

  test("when the key goes off, sync stops and removes the unit and deletes the gateway directory with the tokens", async () => {
    const box1 = box();
    await runSync({ home: box1.home }, box1.dependencies(true));
    mkdirSync(join(box1.gateway, "tokens"));
    writeFileSync(join(box1.gateway, "tokens", "linear.json"), "{}");
    box1.reset();

    await runSync({ home: box1.home }, box1.dependencies(false));

    expect(existsSync(box1.gateway)).toBe(false);
    expect(existsSync(box1.unit)).toBe(false);
    expect(box1.systemctl()).toEqual(["--user disable --now ferry-mcp-gateway.service", "--user daemon-reload"]);
    expect(box1.lines).toContain("Removed the MCP gateway, its unit, and its logins from the box.");
    expect(existsSync(join(box1.boxHome, ".ferry", "box.json"))).toBe(true);
  });

  test("starts the gateway before the harness entries point at it, and the stdio and SSE servers stay direct", async () => {
    const box1 = box();

    await runSync({ home: box1.home }, box1.dependencies(true));

    const start = box1.commands.findIndex((command) => command.includes("servers.json"));
    const entries = box1.commands.flatMap((command, index) => (/127\.0\.0\.1:47820\/mcp\/(linear|docs)/.test(command) ? [index] : []));
    // claude/linear, and codex/linear, after which the fake box reports no codex CLI. The stdio server files and the SSE server events are not on the gateway.
    expect(entries).toHaveLength(2);
    expect(start).toBeGreaterThanOrEqual(0);
    expect(entries.every((index) => index > start)).toBe(true);
    for (const name of ["files", "events"]) {
      expect(box1.commands.some((command) => command.includes(`127.0.0.1:47820/mcp/${name}`))).toBe(false);
    }
  });

  test("when the key goes off, the harness entries are direct again before the gateway directory goes", async () => {
    const box1 = box();
    await runSync({ home: box1.home }, box1.dependencies(true));
    box1.commands.length = 0;

    await runSync({ home: box1.home }, box1.dependencies(false));

    const removal = box1.commands.findIndex((command) => command.startsWith(disableGatewayCommand(null).split("\n").slice(0, 3).join("\n")));
    const direct = box1.commands.findIndex((command) => command.includes("claude mcp add") && command.includes("mcp.linear.example"));
    expect(direct).toBeGreaterThanOrEqual(0);
    expect(removal).toBeGreaterThan(direct);
    // Only the removal command names the gateway URL, to find the entries that are still on the gateway.
    expect(box1.commands.filter((command) => command.includes("127.0.0.1:47820"))).toEqual([box1.commands[removal]!]);
  });

  test("a development build keeps the harness entries direct", async () => {
    const box1 = box();

    await runSync({ home: box1.home }, box1.dependencies(true, "0.0.0-dev"));

    expect(box1.commands.some((command) => command.includes("127.0.0.1:47820"))).toBe(false);
    expect(box1.commands.some((command) => command.includes("claude mcp add") && command.includes("mcp.linear.example"))).toBe(true);
  });

  test("a box without the key and without a gateway gets no change", async () => {
    const box1 = box();

    await runSync({ home: box1.home }, box1.dependencies(false));

    expect(box1.systemctl()).toEqual([]);
    expect(existsSync(box1.gateway)).toBe(false);
    expect(existsSync(box1.unit)).toBe(false);
    expect(box1.outputs.join("")).toBe("");
    expect(box1.steps.some((step) => step.includes("MCP gateway"))).toBe(false);
    expect(box1.lines.some((line) => line.includes("MCP gateway"))).toBe(false);
  });
});

describe("gateway status", () => {
  test("reads the state and the servers from ferry mcp list --json", async () => {
    const stdout = JSON.stringify({
      schemaVersion: 1,
      command: "mcp list",
      ok: true,
      result: { gateway: { state: "running", port: 47820 }, servers: [{ name: "linear", state: "login-required" }, { name: "docs", state: "ready" }] },
      warnings: [],
      error: null,
    });
    const commands: string[] = [];

    const status = await readGatewayStatus({
      run: async (command) => {
        commands.push(command);
        return { ok: true, address: "a", stdout: `${stdout}\n`, stderr: "" };
      },
    });

    expect(status).toEqual({
      state: "running",
      reason: null,
      port: 47820,
      servers: [{ name: "linear", state: "login-required" }, { name: "docs", state: "ready" }],
    });
    expect(commands[0]).toContain('"$HOME/.local/bin/ferry" --json mcp list');
  });

  test("keeps only the state, the port, and the server names and states, so no other value of the box reaches the report", () => {
    const secret = "gateway-test-secret-value-0123456789";
    const stdout = JSON.stringify({
      ok: true,
      result: { gateway: { state: "running", port: 47820, key: secret }, servers: [{ name: "linear", state: "ready", token: secret, url: `https://x.example/?k=${secret}` }] },
    });

    const status = parseGatewayStatus(stdout);

    expect(status).toEqual({ state: "running", reason: null, port: 47820, servers: [{ name: "linear", state: "ready" }] });
    expect(JSON.stringify(status)).not.toContain(secret);
  });

  test("a box without Ferry gives unavailable", () => {
    expect(parseGatewayStatus("missing\n")).toEqual({ state: "unavailable", reason: "Ferry is not on the box", port: null, servers: [] });
  });

  test("refuses output that is not the envelope", () => {
    expect(() => parseGatewayStatus("Gateway: running\n")).toThrow("no valid JSON");
    expect(() => parseGatewayStatus('{"ok":false}')).toThrow("unexpected result");
  });

  test("the login recipe runs the Ferry of the box", () => {
    expect(MCP_GATEWAY_TOOL.mcp).toEqual({
      list: '"$HOME/.local/bin/ferry" mcp list',
      loginRequired: "^(\\S+)\\s+login-required$",
      login: '"$HOME/.local/bin/ferry" mcp login {name}',
    });
  });
});
