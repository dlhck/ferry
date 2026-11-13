import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { changeRelayUrl, messagingStatus, messagingStatusLines, part, readRelayConfig, relayOwners } from "../../../src/messaging/commands.ts";
import { messagingHookCommand } from "../../../src/messaging/hooks.ts";
import { runMessagingSetup, runMessagingTeardown, type WorkerStatusView } from "../../../src/messaging/setup.ts";
import { BUILTIN_HARNESSES } from "../../../src/registry/builtin.ts";
import { messagingIssues } from "../../../src/status.ts";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function home(): string {
  const root = mkdtempSync(join(tmpdir(), "ferry-msg-commands-"));
  roots.push(root);
  return root;
}

function enrolled(root = home()): string {
  mkdirSync(join(root, ".ferry", "messaging"), { recursive: true });
  writeFileSync(join(root, ".ferry", "messaging", "credential"), "fmr_example");
  writeFileSync(join(root, ".ferry", "messaging", "client.json"), JSON.stringify({ schemaVersion: 1, relayUrl: "https://relay.example", deviceId: "dev_1" }));
  return root;
}

const NOW = Date.parse("2026-11-13T12:00:00.000Z");
const worker = (change: Partial<WorkerStatusView> = {}): WorkerStatusView => ({
  revoked: false,
  relay: { reachable: true, lastContactAt: "2026-11-13T11:59:00.000Z", lastError: null },
  sessions: [],
  outbox: { pending: 0, failed: [] },
  deliveries: { held: 0, unconfirmed: 0, stranded: 0, failed: 0 },
  unregisteredCodex: [],
  ...change,
});

describe("ferry messaging status", () => {
  test("a worker that does not answer is stopped", async () => {
    const root = enrolled();
    const status = await messagingStatus(root, async () => ({ v: 1, id: "1", ok: false, error: { code: "worker-offline", message: "no" } }));
    expect(status).toEqual({ worker: "stopped", enrolled: true, relayUrl: "https://relay.example", status: null });
    expect(messagingStatusLines(status)[0]).toBe("Worker: stopped");
  });

  test("a running worker gives its status", async () => {
    const result = worker({ sessions: [{ runtime: "codex", runtimeVersion: "0.200.0", state: "live", adapter: "supported" }] });
    const status = await messagingStatus(enrolled(), async (_socket, op) => {
      expect(op).toBe("status");
      return { v: 1, id: "1", ok: true, result };
    });
    expect(status.worker).toBe("running");
    expect(status.status).toEqual(result);
    expect(messagingStatusLines(status)).toContain("Session codex 0.200.0: supported");
  });

  test("a machine without enrollment says how to enroll", async () => {
    const status = await messagingStatus(home(), async () => ({ v: 1, id: "1", ok: false, error: { code: "worker-offline", message: "no" } }));
    expect(messagingStatusLines(status)).toEqual(["This machine has no messaging enrollment. Run ferry messaging enroll --relay <url>."]);
  });
});

describe("the messaging issues of ferry status --brief", () => {
  const health = (status: WorkerStatusView | null, enrolledBox = true) =>
    ({ state: "read", worker: status === null ? "stopped" : "running", enrolled: enrolledBox, relayUrl: "https://relay.example", status }) as const;

  test("a stopped worker gives the sync, and a box without a credential gives the enroll command", () => {
    expect(messagingIssues(health(null), "dev", NOW)).toMatchObject([{ kind: "messaging", state: "worker-stopped", command: "ferry sync --box dev" }]);
    expect(messagingIssues(health(null, false), "dev", NOW)).toMatchObject([{ state: "worker-stopped", command: "ferry messaging enroll --box dev" }]);
  });

  test("the relay is an issue only after 5 minutes without contact", () => {
    const away = (at: string | null) => worker({ relay: { reachable: false, lastContactAt: at, lastError: "timeout" } });
    expect(messagingIssues(health(away("2026-11-13T11:57:00.000Z")), "dev", NOW)).toEqual([]);
    expect(messagingIssues(health(away("2026-11-13T11:50:00.000Z")), "dev", NOW)).toMatchObject([{ state: "relay-unreachable", command: null }]);
    expect(messagingIssues(health(away(null)), "dev", NOW)).toMatchObject([{ state: "relay-unreachable" }]);
  });

  test("a revoked device, a runtime version, and untrusted Codex hooks are issues", () => {
    const status = worker({
      revoked: true,
      sessions: [
        { runtime: "claude", runtimeVersion: "2.1.300", state: "live", adapter: "unsupported" },
        { runtime: "claude", runtimeVersion: "2.1.300", state: "live", adapter: "unsupported" },
        { runtime: "codex", runtimeVersion: "0.300.0", state: "live", adapter: "untested" },
        { runtime: "codex", runtimeVersion: "0.100.0", state: "offline", adapter: "unsupported" },
      ],
      unregisteredCodex: [{ pid: 9, worktree: "/home/user/app" }],
    });
    expect(messagingIssues(health(status), "dev", NOW).map((issue) => [issue.name, issue.state, issue.command])).toEqual([
      ["messaging", "device-revoked", "ferry messaging enroll --box dev"],
      ["messaging/claude", "runtime-unsupported", null],
      ["messaging/codex", "runtime-untested", null],
      ["messaging/codex", "codex-untrusted", null],
    ]);
  });

  test("a box without Ferry gives no issue", () => {
    expect(messagingIssues({ state: "unavailable", reason: "Ferry is not on the box" }, "dev", NOW)).toEqual([]);
  });
});

describe("ferry relay owners", () => {
  test("adds and removes owners in config.json with mode 0600, and keeps the other keys", () => {
    const root = home();
    mkdirSync(join(root, ".ferry", "relay"), { recursive: true });
    writeFileSync(join(root, ".ferry", "relay", "config.json"), JSON.stringify({ github: { appId: 1 } }));
    let restarts = 0;
    const restart = () => (restarts++, true);

    expect(relayOwners({ add: "acme" }, root, restart)).toEqual({ owners: ["acme"], changed: true, restarted: true });
    expect(relayOwners({ add: "ACME" }, root, restart)).toEqual({ owners: ["acme"], changed: false, restarted: false });
    expect(relayOwners({ add: "widgets" }, root, restart).owners).toEqual(["acme", "widgets"]);
    expect(relayOwners({ remove: "Acme" }, root, restart).owners).toEqual(["widgets"]);
    expect(relayOwners({}, root, restart).owners).toEqual(["widgets"]);

    const path = join(root, ".ferry", "relay", "config.json");
    expect(JSON.parse(readFileSync(path, "utf8"))).toEqual({ github: { appId: 1 }, allowedOwners: ["widgets"] });
    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(restarts).toBe(3);
    expect(readRelayConfig(root)).toMatchObject({ github: { appId: 1 }, allowedOwners: ["widgets"] });
  });

  test("refuses a name that is not a GitHub owner", () => {
    expect(() => relayOwners({ add: "-bad name" }, home(), () => false)).toThrow(/GitHub/);
  });
});

test("ferry messaging relay-url writes the config and client.json", () => {
  const root = enrolled();
  mkdirSync(join(root, ".ferry"), { recursive: true });
  writeFileSync(join(root, ".ferry", "config.toml"), ['version = 1', 'publisher = "operator"', 'snapshot_url = "s.git"', "", "[host]", 'transport = "ssh"', 'destination = "user@box.example"', ""].join("\n"));

  expect(changeRelayUrl("https://new-relay.example", root)).toEqual({ relayUrl: "https://new-relay.example", client: true });

  expect(readFileSync(join(root, ".ferry", "config.toml"), "utf8")).toContain('relay = "https://new-relay.example"');
  expect(JSON.parse(readFileSync(join(root, ".ferry", "messaging", "client.json"), "utf8"))).toMatchObject({ relayUrl: "https://new-relay.example", deviceId: "dev_1" });
  expect(() => changeRelayUrl("http://relay.example", root)).toThrow(/relay URL/);
});

test("a part that is not in the build gives a clear error", async () => {
  await expect(part("relay")).rejects.toThrow(/This Ferry build has no relay server/);
});

describe("ferry messaging setup and teardown", () => {
  const fakes = () => {
    const runs: string[][] = [];
    const services: string[] = [];
    return {
      runs,
      services,
      dependencies: {
        harnesses: BUILTIN_HARNESSES,
        ferry: ["/home/user/.local/bin/ferry"],
        run: (command: readonly string[]) => (runs.push([...command]), { exitCode: 0 }),
        onPath: () => true,
        installService: async (service: { unit: string }) => (services.push(`install ${service.unit}`), { manager: "systemd" as const, path: `/units/${service.unit}` }),
        uninstallService: async (service: { unit: string }) => (services.push(`uninstall ${service.unit}`), { manager: "systemd" as const, path: `/units/${service.unit}`, removed: true }),
      },
    };
  };

  test("needs an enrollment", async () => {
    await expect(runMessagingSetup({ ...fakes().dependencies, home: home() })).rejects.toThrow(/no messaging enrollment/);
  });

  test("writes the hooks, the MCP entries, the skill, and the worker service, and teardown removes them", async () => {
    const root = enrolled();
    mkdirSync(join(root, ".claude"));
    mkdirSync(join(root, ".codex"));
    writeFileSync(join(root, ".claude", "settings.json"), JSON.stringify({ model: "opus" }), { mode: 0o644 });
    const { runs, services, dependencies } = fakes();

    const result = await runMessagingSetup({ ...dependencies, home: root });

    expect(result.claude).toBe("updated");
    expect(result.codex).toBe("updated");
    const claude = JSON.parse(readFileSync(join(root, ".claude", "settings.json"), "utf8"));
    expect(claude.model).toBe("opus");
    expect(claude.permissions.allow).toEqual(["mcp__ferry-messaging"]);
    expect(claude.hooks.UserPromptSubmit[0].hooks[0].command).toBe(messagingHookCommand("claude", "UserPromptSubmit"));
    expect(statSync(join(root, ".claude", "settings.json")).mode & 0o777).toBe(0o644);
    expect(statSync(join(root, ".codex", "hooks.json")).mode & 0o777).toBe(0o600);
    expect(runs).toContainEqual(["claude", "mcp", "add-json", "--scope", "user", "ferry-messaging", '{"type":"stdio","command":"/home/user/.local/bin/ferry","args":["messaging","mcp"]}']);
    expect(runs).toContainEqual(["codex", "mcp", "add", "ferry-messaging", "--", "/home/user/.local/bin/ferry", "messaging", "mcp"]);
    expect(readFileSync(join(root, ".agents", "skills", "ferry-messaging", "SKILL.md"), "utf8")).toContain("name: ferry-messaging");
    expect(services).toEqual(["install ferry-messaging.service"]);
    expect((await runMessagingSetup({ ...dependencies, home: root })).claude).toBe("unchanged");

    const teardown = await runMessagingTeardown({ ...dependencies, home: root });

    expect(teardown.claude).toBe("updated");
    expect(JSON.parse(readFileSync(join(root, ".claude", "settings.json"), "utf8"))).toEqual({ model: "opus" });
    expect(JSON.parse(readFileSync(join(root, ".codex", "hooks.json"), "utf8"))).toEqual({});
    expect(runs.at(-1)).toEqual(["codex", "mcp", "remove", "ferry-messaging"]);
    expect(services.at(-1)).toBe("uninstall ferry-messaging.service");
    expect(readFileSync(join(root, ".ferry", "messaging", "credential"), "utf8")).toBe("fmr_example");
  });
});
