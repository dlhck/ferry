import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Seed } from "../../../src/manifest.ts";
import { messagingHookCommand } from "../../../src/messaging/hooks.ts";
import { noProgress, type Progress } from "../../../src/progress.ts";
import { runSync, type SyncDependencies } from "../../../src/sync.ts";

const HAS_JQ = Bun.which("jq") !== null;
const jqTest = (title: string, run: () => Promise<void>) =>
  test.skipIf(!HAS_JQ)(HAS_JQ ? title : `${title} (skipped: jq is not on the PATH)`, run);

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const RELAY = "https://relay.example";

const seed: Seed = {
  ok: true,
  skills: [],
  instructions: null,
  roots: [],
  settings: [{ harness: "claude", bytes: new TextEncoder().encode('{"model":"opus"}') }],
  mcp: [],
  identity: "seed-identity",
  leftovers: [],
  storeUpdates: [],
};

type Keys = { readonly messaging?: boolean; readonly relay?: boolean; readonly relayUrl?: string | null };

function config(keys: Keys) {
  const relayUrl = keys.relayUrl === undefined ? RELAY : keys.relayUrl;
  return {
    version: 1 as const,
    publisher: "operator-machine",
    snapshotUrl: "git@example.test:operator/ferry-store.git",
    ...(relayUrl !== null ? { messaging: { relay: relayUrl } } : {}),
    boxes: [
      {
        name: "a",
        host: { transport: "ssh" as const, destination: "user@box-a.example" },
        ...(keys.messaging ? { messaging: true as const } : {}),
        ...(keys.relay ? { relay: true as const } : {}),
      },
    ],
  };
}

/** True for a box command of agent messaging or of the settings merge. The fake box runs these in `sh`. */
const runsOnBox = (command: string) => /messaging|ferry-relay|\.ferry\/relay|settings\.json/.test(command) && !/\bgit (clone|fetch|-C)\b/.test(command);

/**
 * One box whose home is a temporary directory, with fake `systemctl`,
 * `claude`, and `codex` commands that record their arguments. `ferry` is a
 * box install of Ferry, an old one, or none.
 */
function box(options: { readonly ferry?: boolean | "old"; readonly enrolled?: boolean; readonly active?: boolean } = {}) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "ferry-msg-sync-")));
  roots.push(root);
  const home = join(root, "operator");
  const boxHome = join(root, "box");
  const bin = join(root, "bin");
  mkdirSync(home, { recursive: true });
  mkdirSync(join(boxHome, ".ferry", "store"), { recursive: true });
  mkdirSync(join(boxHome, ".codex"), { recursive: true });
  mkdirSync(join(boxHome, ".claude"), { recursive: true });
  mkdirSync(bin);
  const log = join(root, "commands.log");
  const fake = (name: string, body = "") => {
    writeFileSync(join(bin, name), `#!/bin/sh\nprintf '%s\\n' "${name} $*" >> '${log}'\n${body}exit 0\n`);
    chmodSync(join(bin, name), 0o755);
  };
  fake("systemctl", `case "$*" in *is-active*) exit ${options.active === false ? 1 : 0};; esac\n`);
  fake("claude");
  // The fake codex keeps the entry ferry-messaging in a marker file, as the real CLI keeps it in its config.
  const entry = join(root, "codex-entry");
  fake(
    "codex",
    [
      'case "$*" in',
      `  "mcp add ferry-messaging -- "*) touch '${entry}';;`,
      `  "mcp remove ferry-messaging") rm -f '${entry}';;`,
      `  "mcp get ferry-messaging --json") [ -f '${entry}' ] || exit 1; printf '{"transport":{"type":"stdio","command":"%s","args":["messaging","mcp"]}}' "$HOME/.local/bin/ferry";;`,
      `  "mcp get ferry-messaging") [ -f '${entry}' ] || exit 1;;`,
      "esac",
      "",
    ].join("\n"),
  );
  if (options.ferry !== false) {
    mkdirSync(join(boxHome, ".local", "bin"), { recursive: true });
    const old = options.ferry === "old";
    writeFileSync(
      join(boxHome, ".local", "bin", "ferry"),
      `#!/bin/sh\ncase "$*" in "messaging worker --help") ${old ? "echo 'Usage: ferry [options] [command]'" : "echo 'Usage: ferry messaging worker [options]'"};; "relay serve --help") ${old ? "echo 'Usage: ferry [options] [command]'" : "echo 'Usage: ferry relay serve [options]'"};; esac\n`,
    );
    chmodSync(join(boxHome, ".local", "bin", "ferry"), 0o755);
    writeFileSync(join(boxHome, ".ferry", "box.json"), '{"mode":"box"}\n');
  }
  if (options.enrolled !== false) {
    mkdirSync(join(boxHome, ".ferry", "messaging"), { recursive: true, mode: 0o700 });
    writeFileSync(join(boxHome, ".ferry", "messaging", "credential"), "fmr_example\n", { mode: 0o600 });
    writeFileSync(join(boxHome, ".ferry", "messaging", "client.json"), '{"schemaVersion":1,"relayUrl":"https://old.example","deviceId":"dev_example"}\n', { mode: 0o600 });
  }
  const commands: string[] = [];
  const lines: string[] = [];
  const steps: string[] = [];
  const progress: Progress = {
    ...noProgress,
    start: (name) => steps.push(`start:${name}`),
    done: (detail) => steps.push(`done:${detail ?? ""}`),
    skip: (name, detail) => steps.push(`skip:${name}:${detail}`),
  };
  const dependencies = (keys: Keys, ferryVersion = "1.2.3"): SyncDependencies => ({
    readConfig: () => config(keys),
    publisher: () => "operator-machine",
    readSeed: () => seed,
    ferryVersion,
    progress,
    createLink: () => ({
      run: async (command, runOptions) => {
        commands.push(command);
        if (command.startsWith("printf")) return { ok: true, address: "a", stdout: `${boxHome}\n`, stderr: "" };
        if (!runsOnBox(command)) return { ok: true, address: "a", stdout: "", stderr: "" };
        const child = Bun.spawn(["sh", "-c", command], {
          cwd: boxHome,
          stdin: runOptions?.input ?? "ignore",
          stdout: "pipe",
          stderr: "pipe",
          env: { HOME: boxHome, PATH: `${bin}:/usr/bin:/bin` },
        });
        const [status, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
        return status === 0
          ? { ok: true, address: "a", stdout, stderr }
          : { ok: false, error: { origin: "box", code: "command-failed", message: stderr.trim() || `exit ${status}` } };
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
  const unit = join(boxHome, ".config", "systemd", "user", "ferry-messaging.service");
  const relayUnit = join(boxHome, ".config", "systemd", "user", "ferry-relay.service");
  const logged = () => (existsSync(log) ? readFileSync(log, "utf8").trim().split("\n") : []);
  const read = (path: string) => readFileSync(join(boxHome, path), "utf8");
  return { home, boxHome, unit, relayUnit, commands, lines, steps, logged, read, dependencies, reset: () => rmSync(log, { force: true }) };
}

const mode = (path: string) => statSync(path).mode & 0o777;

describe("sync on a box with messaging = true", () => {
  jqTest("writes the relay URL, the Codex hooks, the Claude hooks, and the MCP entries, then starts the worker", async () => {
    const box1 = box();

    await runSync({ home: box1.home }, box1.dependencies({ messaging: true }));

    expect(JSON.parse(box1.read(".ferry/messaging/client.json")).relayUrl).toBe(RELAY);
    expect(JSON.parse(box1.read(".ferry/messaging/client.json")).deviceId).toBe("dev_example");
    expect(mode(join(box1.boxHome, ".ferry/messaging"))).toBe(0o700);
    const codex = JSON.parse(box1.read(".codex/hooks.json"));
    expect(codex.hooks.SessionStart).toEqual([{ hooks: [{ type: "command", command: messagingHookCommand("codex", "SessionStart"), timeout: 10 }] }]);
    expect(Object.keys(codex.hooks)).toEqual(["SessionStart", "UserPromptSubmit", "PermissionRequest", "Stop", "PostToolUse", "SessionEnd"]);
    const claude = JSON.parse(box1.read(".claude/settings.json"));
    expect(claude.hooks.SessionStart[0].hooks[0].command).toBe(messagingHookCommand("claude", "SessionStart"));
    expect(claude.hooks.Notification[0].matcher).toBe("permission_prompt");
    expect(claude.permissions.allow).toEqual(["mcp__ferry-messaging"]);
    expect(claude.model).toBe("opus");
    const unit = readFileSync(box1.unit, "utf8");
    expect(unit).toContain(`ExecStart="${box1.boxHome}/.local/bin/ferry" messaging worker`);
    expect(unit).toContain("Restart=always");
    const logged = box1.logged();
    expect(logged).toContain("systemctl --user restart ferry-messaging.service");
    expect(logged.some((line) => line.startsWith("claude mcp add-json --scope user ferry-messaging"))).toBe(true);
    expect(logged.find((line) => line.startsWith("codex mcp add ferry-messaging"))).toBe(
      `codex mcp add ferry-messaging -- ${box1.boxHome}/.local/bin/ferry messaging mcp`,
    );
    expect(box1.steps).toContain("done:worker running");
    expect(box1.lines.filter((line) => line.includes("messaging"))).toEqual([]);
  });

  jqTest("a second sync keeps each hook once and does not restart an unchanged unit", async () => {
    const box1 = box();
    await runSync({ home: box1.home }, box1.dependencies({ messaging: true }));
    box1.reset();

    await runSync({ home: box1.home }, box1.dependencies({ messaging: true }));

    expect(JSON.parse(box1.read(".codex/hooks.json")).hooks.SessionStart).toHaveLength(1);
    expect(box1.logged().filter((line) => line.startsWith("systemctl"))).toEqual([
      "systemctl --user enable --now ferry-messaging.service",
      "systemctl --user is-active --quiet ferry-messaging.service",
    ]);
  });

  jqTest("keeps the other Codex hooks", async () => {
    const box1 = box();
    const own = { hooks: { Stop: [{ hooks: [{ type: "command", command: "own-stop" }] }] } };
    writeFileSync(join(box1.boxHome, ".codex/hooks.json"), JSON.stringify(own));

    await runSync({ home: box1.home }, box1.dependencies({ messaging: true }));

    const stop = JSON.parse(box1.read(".codex/hooks.json")).hooks.Stop;
    expect(stop[0]).toEqual(own.hooks.Stop[0]);
    expect(stop[1].hooks[0].command).toBe(messagingHookCommand("codex", "Stop"));
  });

  jqTest("does not start the worker on a box without a credential, and names the enroll command", async () => {
    const box1 = box({ enrolled: false });

    await runSync({ home: box1.home }, box1.dependencies({ messaging: true }));

    expect(existsSync(box1.unit)).toBe(false);
    expect(box1.steps).toContain("done:not enrolled");
    expect(box1.lines).toContain(
      "Warning: The box has no messaging credential, so the worker does not run. Run ferry messaging enroll --box a.",
    );
  });

  jqTest("warns when the worker does not run after the start", async () => {
    const box1 = box({ active: false });

    await runSync({ home: box1.home }, box1.dependencies({ messaging: true }));

    expect(box1.lines).toContain(
      "Warning: ferry-messaging.service does not run on the box. Run journalctl --user -u ferry-messaging.service on the box to see why.",
    );
  });

  test("warns and declares no MCP entry when the box has no Ferry, or an old one", async () => {
    for (const ferry of [false, "old"] as const) {
      const box1 = box({ ferry });

      await runSync({ home: box1.home }, box1.dependencies({ messaging: true }));

      expect(existsSync(box1.unit)).toBe(false);
      expect(box1.logged().some((line) => line.startsWith("claude") || line.startsWith("codex"))).toBe(false);
      expect(box1.lines).toContain(
        ferry === false
          ? "Warning: Agent messaging needs Ferry on the box. Run ferry install --box a."
          : "Warning: The Ferry of the box has no agent messaging. Run ferry update --box a, then ferry sync --box a.",
      );
    }
  });

  test("a development build and a config without a relay URL skip the step with a warning", async () => {
    const dev = box();
    await runSync({ home: dev.home }, dev.dependencies({ messaging: true }, "0.0.0-dev"));
    expect(dev.steps).toContain("skip:Setting up agent messaging:development build");
    expect(existsSync(dev.unit)).toBe(false);

    const noUrl = box();
    await runSync({ home: noUrl.home }, noUrl.dependencies({ messaging: true, relayUrl: null }));
    expect(noUrl.steps).toContain("skip:Setting up agent messaging:no relay URL");
    expect(noUrl.lines).toContain(
      "Warning: Agent messaging needs the relay URL. Run ferry messaging enroll --relay <url> on this machine, then ferry sync.",
    );
  });
});

describe("sync on a box without messaging = true", () => {
  test("sends no messaging command when this machine never used messaging", async () => {
    const box1 = box();

    await runSync({ home: box1.home }, box1.dependencies({ relayUrl: null }));

    expect(box1.commands.some((command) => /messaging|ferry-relay/.test(command))).toBe(false);
  });

  jqTest("removes the hooks, the MCP entries, and the worker after the key goes off, and keeps the credential", async () => {
    const box1 = box();
    await runSync({ home: box1.home }, box1.dependencies({ messaging: true }));
    box1.reset();

    await runSync({ home: box1.home }, box1.dependencies({}));

    expect(existsSync(box1.unit)).toBe(false);
    expect(JSON.parse(box1.read(".codex/hooks.json"))).toEqual({});
    const claude = JSON.parse(box1.read(".claude/settings.json"));
    expect(claude.hooks).toBeUndefined();
    expect(claude.permissions).toBeUndefined();
    expect(box1.read(".ferry/messaging/credential")).toBe("fmr_example\n");
    expect(box1.logged()).toContain("claude mcp remove --scope user ferry-messaging");
    expect(box1.logged()).toContain("codex mcp remove ferry-messaging");
    expect(box1.lines).toContain(
      "Removed the agent messaging hooks, MCP entry, and worker from the box. ~/.ferry/messaging stays, with the device credential.",
    );

    box1.reset();
    await runSync({ home: box1.home }, box1.dependencies({}));
    expect(box1.logged()).toEqual([]);
  });

  test("the box never gets the messaging hooks that ferry messaging setup wrote on this machine", async () => {
    const box1 = box();
    const operator = {
      model: "opus",
      hooks: { SessionStart: [{ hooks: [{ type: "command", command: messagingHookCommand("claude", "SessionStart"), timeout: 10 }] }] },
      permissions: { allow: ["mcp__ferry-messaging", "Bash(ls)"] },
    };
    const dependencies = box1.dependencies({});
    const merged: string[] = [];

    await runSync(
      { home: box1.home },
      {
        ...dependencies,
        readSeed: () => ({ ...seed, settings: [{ harness: "claude", bytes: new TextEncoder().encode(JSON.stringify(operator)) }] }),
        createLink: (target) => {
          const inner = dependencies.createLink!(target);
          return { run: (command, options) => (command.includes("settings.json") && !command.includes("ferry-messaging.service") && merged.push(command), inner.run(command, options)) };
        },
      },
    );

    expect(merged).toHaveLength(1);
    expect(merged.some((command) => command.includes("messaging hook"))).toBe(false);
    expect(merged.some((command) => command.includes("mcp__ferry-messaging"))).toBe(false);
  });
});

describe("sync on a box with relay = true", () => {
  test("starts the relay, and after the key goes off removes the unit and keeps ~/.ferry/relay", async () => {
    const box1 = box();

    await runSync({ home: box1.home }, box1.dependencies({ relay: true }));

    expect(readFileSync(box1.relayUnit, "utf8")).toContain(`ExecStart="${box1.boxHome}/.local/bin/ferry" relay serve`);
    expect(mode(join(box1.boxHome, ".ferry/relay"))).toBe(0o700);
    expect(box1.steps).toContain("done:running");

    await runSync({ home: box1.home }, box1.dependencies({}));

    expect(existsSync(box1.relayUnit)).toBe(false);
    expect(existsSync(join(box1.boxHome, ".ferry/relay"))).toBe(true);
    expect(box1.lines).toContain("Removed the team relay service from the box. ~/.ferry/relay stays, with the data of the team.");
  });
});
