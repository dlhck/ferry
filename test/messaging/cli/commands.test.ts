import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RelayError } from "../../../src/messaging/client/relay-client.ts";
import { backupRelay, changeRelayUrl, enrollMachine, relayFailure, relayRefusal, messagingStatus, messagingStatusLines, relayOwners, relayStatus, restoreRelay, serveRelay } from "../../../src/messaging/commands.ts";
import { readRelayConfig } from "../../../src/messaging/github/app.ts";
import { newId } from "../../../src/messaging/ids.ts";
import { messagingHookCommand } from "../../../src/messaging/hooks.ts";
import { runMessagingSetup, runMessagingTeardown } from "../../../src/messaging/setup.ts";
import type { WorkerStatus } from "../../../src/messaging/worker/worker.ts";
import { openStore } from "../../../src/messaging/relay/store.ts";
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

const NOW = Date.parse("2026-11-13T12:00:00.000Z");
const DEVICE = newId("device", NOW);

/** A machine with an example credential and client.json. */
function enrolled(root = home()): string {
  mkdirSync(join(root, ".ferry", "messaging"), { recursive: true });
  writeFileSync(join(root, ".ferry", "messaging", "credential"), `fmr_${"a".repeat(43)}\n`);
  writeFileSync(join(root, ".ferry", "messaging", "client.json"), JSON.stringify({ schemaVersion: 1, relayUrl: "https://relay.example", deviceId: DEVICE, ownerLogin: "user" }));
  return root;
}

type Session = WorkerStatus["sessions"][number];
const session = (runtime: Session["runtime"], runtimeVersion: string, state: Session["state"], adapter: string): Session => ({
  runtime,
  runtimeSessionId: "s-1",
  runtimeVersion,
  address: null,
  project: null,
  state,
  activity: null,
  adapter,
  adapterReason: null,
  refusal: null,
});
const worker = (change: Partial<WorkerStatus> = {}): WorkerStatus => ({
  pid: 42,
  version: "1.0.0",
  startedAt: "2026-11-13T11:00:00.000Z",
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
    const result = worker({ sessions: [session("codex", "0.200.0", "live", "supported")] });
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
  const health = (status: WorkerStatus | null, enrolledBox = true) =>
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
        session("claude", "2.1.300", "live", "unsupported"),
        session("claude", "2.1.300", "live", "unsupported"),
        session("codex", "0.300.0", "live", "untested"),
        session("codex", "0.100.0", "offline", "unsupported"),
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
  test("changes the owners in config.json with mode 0600, keeps the App, and restarts the relay after each change", async () => {
    const root = home();
    const github = { appId: 1, slug: "ferry-relay", clientId: "Iv1.example" };
    mkdirSync(join(root, ".ferry", "relay"), { recursive: true });
    writeFileSync(join(root, ".ferry", "relay", "config.json"), JSON.stringify({ schemaVersion: 1, github, allowedOwners: [] }));
    let restarts = 0;
    const restart = () => (restarts++, true);

    expect(await relayOwners({ add: "acme" }, root, restart)).toEqual({ owners: ["acme"], changed: true, restarted: true });
    expect(await relayOwners({ add: "ACME" }, root, restart)).toEqual({ owners: ["acme"], changed: false, restarted: false });
    expect((await relayOwners({ add: "widgets" }, root, restart)).owners).toEqual(["acme", "widgets"]);
    expect((await relayOwners({ remove: "Acme" }, root, restart)).owners).toEqual(["widgets"]);
    expect((await relayOwners({}, root, restart)).owners).toEqual(["widgets"]);

    expect(statSync(join(root, ".ferry", "relay", "config.json")).mode & 0o777).toBe(0o600);
    expect(restarts).toBe(3);
    expect(readRelayConfig(root)).toEqual({ schemaVersion: 1, github, allowedOwners: ["widgets"] });
  });

  test("refuses a name that is not a GitHub owner", async () => {
    await expect(relayOwners({ add: "-bad name" }, home(), () => false)).rejects.toThrow(/GitHub account name/);
  });
});

test("ferry messaging relay-url writes the config and client.json", () => {
  const root = enrolled();
  mkdirSync(join(root, ".ferry"), { recursive: true });
  writeFileSync(join(root, ".ferry", "config.toml"), ['version = 1', 'publisher = "operator"', 'snapshot_url = "s.git"', "", "[host]", 'transport = "ssh"', 'destination = "user@box.example"', ""].join("\n"));

  expect(changeRelayUrl("https://new-relay.example", root)).toEqual({ relayUrl: "https://new-relay.example", client: true });

  expect(readFileSync(join(root, ".ferry", "config.toml"), "utf8")).toContain('relay = "https://new-relay.example"');
  expect(JSON.parse(readFileSync(join(root, ".ferry", "messaging", "client.json"), "utf8"))).toEqual({ schemaVersion: 1, relayUrl: "https://new-relay.example", deviceId: DEVICE, ownerLogin: "user" });
  expect(() => changeRelayUrl("http://relay.example", root)).toThrow(/relay URL/);
});

describe("relay refusals", () => {
  test("ferry messaging enroll gives the message and the hint of each relay refusal", async () => {
    const root = home();
    for (const [code, hint] of [["device-flow-disabled", "Enable Device Flow in the settings of the GitHub App."], ["enrollment-failed", null]] as const) {
      const refused = enrollMachine({ relayUrl: "https://relay.example", home: root, print: () => {} }, async () => ({
        currentPlatform: () => "linux",
        enroll: async () => {
          throw new RelayError(400, { code, message: `The relay refused: ${code}.`, hint });
        },
      }));
      const message = hint === null ? `The relay refused: ${code}.` : `The relay refused: ${code}. ${hint}`;
      await expect(refused).rejects.toMatchObject({ name: "FerryError", message, details: { status: 400, code } });
    }
    expect(existsSync(join(root, ".ferry", "config.toml"))).toBe(false);
  });

  test("other errors stay as they are", () => {
    const error = new Error("socket closed");
    expect(relayFailure(error)).toBe(error);
  });

  test("a view gives the message, the hint, and the status of the relay", () => {
    expect(relayRefusal(403, { error: { code: "not-session-device", message: "The session belongs to another device.", hint: "Use the device of the session." } })).toMatchObject({
      message: "The session belongs to another device. Use the device of the session.",
      details: { status: 403, code: "not-session-device" },
    });
    expect(relayRefusal(502, null)).toMatchObject({ message: "The relay answered HTTP 502.", details: { status: 502, code: null } });
  });
});

test("ferry relay serve needs the GitHub App config and key", async () => {
  await expect(serveRelay("127.0.0.1:0", "1.0.0", () => {}, home())).rejects.toThrow(/The relay has no GitHub App/);
});

test("ferry relay backup, restore, and status work on the relay store", async () => {
  const root = home();
  mkdirSync(join(root, ".ferry", "relay"), { recursive: true, mode: 0o700 });
  openStore(join(root, ".ferry", "relay", "relay.db"), { now: () => NOW }).close();

  const { path } = await backupRelay(null, root);
  const { bytes } = await backupRelay("-", root);
  const status = await relayStatus("1.0.0", root);
  const previous = await restoreRelay(path!, root);

  expect(path).toStartWith(join(root, ".ferry", "relay", "backups", "relay-"));
  expect(new TextDecoder().decode(bytes!.slice(0, 15))).toBe("SQLite format 3");
  expect(status).toMatchObject({
    version: "1.0.0",
    lastBackup: path,
    githubApp: false,
    owners: [],
    counts: { owners: 0, devices: 0, liveSessions: 0, conversations: 0, openRequests: 0 },
  });
  expect((await relayStatus("1.0.0", home())).counts).toBeNull();
  expect(status.database.bytes).toBeGreaterThan(0);
  expect(previous).toStartWith(join(root, ".ferry", "relay", "relay.db.before-restore-"));
  expect(readdirSync(join(root, ".ferry", "relay")).filter((name) => name.startsWith(".backup-stdout"))).toEqual([]);
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
    expect(readFileSync(join(root, ".ferry", "messaging", "credential"), "utf8")).toBe(`fmr_${"a".repeat(43)}\n`);
  });
});
