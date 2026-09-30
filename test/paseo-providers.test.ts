import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";
import {
  carryPaseoProviders,
  readPaseoProviders,
  type PaseoProviders,
} from "../src/integrations/paseo-providers.ts";
import type { IntegrationLink } from "../src/integrations/types.ts";
import { runSync, type SyncDependencies } from "../src/sync.ts";
import { runWatch } from "../src/watch.ts";
import { jqTest, shellBox } from "./paseo-shell-box.ts";

const homes: string[] = [];
afterEach(() => { for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true }); });
// Build the values at run time so this file holds no string a secret scanner flags.
const token = "gh" + "p_" + "A".repeat(36);
const models = [
  { id: "glm-4.6", label: "GLM 4.6", isDefault: true, thinkingOptions: [{ id: "high", label: "High" }] },
  { id: "glm-4.5-air", label: "GLM 4.5 Air" },
];

function home(providers?: unknown): string {
  const path = mkdtempSync(join(tmpdir(), "ferry-providers-"));
  homes.push(path);
  if (providers !== undefined) write(path, providers);
  return path;
}
function write(path: string, providers: unknown): void {
  mkdirSync(join(path, ".paseo"), { recursive: true });
  writeFileSync(join(path, ".paseo/config.json"), JSON.stringify({ version: 1, agents: { providers } }));
}
function refusal(path: string): string {
  try { readPaseoProviders(path); } catch (error) { return String(error); }
  throw new Error("accepted the config");
}

describe("Paseo provider discovery", () => {
  test("reads only the allowlisted fields and keeps the model order", () => {
    const path = home({
      zai: {
        extends: "claude", label: "Z.AI", description: "GLM through Claude Code",
        env: { ANTHROPIC_AUTH_TOKEN: "local-only" }, params: { region: "eu" }, enabled: true, order: 2,
        models, additionalModels: [{ id: "extra", label: "Extra", unknown: "dropped" }],
        disallowedTools: ["WebFetch"], paseoTools: { enabled: true, disabledTools: ["browser"] },
      },
    });
    const [provider] = readPaseoProviders(path).providers;
    expect(provider?.id).toBe("zai");
    expect(provider?.fields).toEqual({
      extends: "claude", label: "Z.AI", description: "GLM through Claude Code",
      models, additionalModels: [{ id: "extra", label: "Extra" }],
      disallowedTools: ["WebFetch"], paseoTools: { enabled: true, disabledTools: ["browser"] },
    });
    expect(provider?.fields.models).toEqual(models);
    expect(JSON.stringify(provider)).not.toContain("local-only");
    expect(JSON.stringify(provider)).not.toContain("eu");
  });

  test("has no providers without a config, agents, or agents.providers", () => {
    expect(readPaseoProviders(home())).toEqual({ providers: [], warnings: [] });
    const path = home();
    mkdirSync(join(path, ".paseo"));
    writeFileSync(join(path, ".paseo/config.json"), JSON.stringify({ daemon: {} }));
    expect(readPaseoProviders(path)).toEqual({ providers: [], warnings: [] });
  });

  test("records why a box without the provider cannot get it, without values", () => {
    const { providers } = readPaseoProviders(home({
      env: { extends: "claude", label: "Env", env: { KEY: "local-only" } },
      params: { extends: "opencode", label: "Params", params: { baseUrl: "http://127.0.0.1:1" } },
      absolute: { extends: "acp", label: "Absolute", command: ["/opt/agent/bin/agent", "--acp"] },
      "path-arg": { extends: "acp", label: "Path arg", command: ["agent", "--config=/home/user/agent.json"] },
      credential: { extends: "acp", label: "Credential", command: ["agent", "--api-key", "abc"] },
      disabled: { extends: "claude", label: "Disabled", enabled: false },
      portable: { extends: "acp", label: "Portable", command: ["gemini", "--experimental-acp"] },
      plain: { extends: "codex", label: "Plain" },
    }));
    const blockers = Object.fromEntries(providers.map((provider) => [provider.id, provider.createBlocker]));
    expect(blockers.env).toContain("env block");
    expect(blockers.params).toContain("params");
    expect(blockers.absolute).toContain("bare executable");
    expect(blockers["path-arg"]).toContain("local path");
    expect(blockers.credential).toContain("credential");
    expect(blockers.disabled).toContain("disabled locally");
    expect(blockers.portable).toBeNull();
    expect(blockers.plain).toBeNull();
    expect(providers.find((provider) => provider.id === "portable")?.command).toEqual(["gemini", "--experimental-acp"]);
    expect(providers.find((provider) => provider.id === "absolute")?.command).toBeNull();
    for (const text of ["/opt/agent", "/home/user", "abc", "local-only", "127.0.0.1"]) {
      expect(JSON.stringify(providers.map((provider) => provider.createBlocker))).not.toContain(text);
    }
  });

  test("keeps path, script, and credential URL arguments out of a new provider's command", () => {
    const cases: [readonly string[], string, readonly string[]][] = [
      [["agent", "--config=./local.json"], "local path", ["local.json"]],
      [["agent", "--config=../local.json"], "local path", ["local.json"]],
      [["agent", "config/local.json"], "local path", ["config/local.json"]],
      [["agent", "--config", "local.json"], "local path", ["local.json"]],
      [["agent", "--profile=C:\\Users\\example\\agent"], "local path", ["Users"]],
      [["sh", "-c", "exec /Users/example/private-wrapper"], "shell or interpreter", ["private-wrapper", "/Users/example"]],
      [["node", "-e", "require('x')"], "shell or interpreter", ["require"]],
      [["agent", "--run", "exec wrapper now"], "script-like argument", ["exec wrapper"]],
      [["agent", "--endpoint", "https://user:pass@example.com"], "credential-like argument", ["user:pass", "example.com"]],
      [["agent", "--endpoint=https://example.com/v1?key=abc"], "credential-like argument", ["key=abc", "example.com"]],
      [["agent", "--config", "file:///home/user/config.json"], "local path", ["/home/user", "config.json"]],
      [["agent", "--config=file:///home/user/config.json"], "local path", ["/home/user", "config.json"]],
      [["agent", "--endpoint", "http://localhost:8080"], "loopback or non-HTTP URL", ["localhost", "8080"]],
      [["agent", "--endpoint=http://127.0.0.1:1234"], "loopback or non-HTTP URL", ["127.0.0.1", "1234"]],
      [["agent", "--endpoint=http://[::1]:1234"], "loopback or non-HTTP URL", ["::1", "1234"]],
      [["agent", "--endpoint=http://api.localhost"], "loopback or non-HTTP URL", ["api.localhost"]],
      [["agent", "--host", "localhost:8080"], "loopback or non-HTTP URL", ["localhost", "8080"]],
      [["agent", "--endpoint=ws://api.example.com"], "loopback or non-HTTP URL", ["ws:", "api.example.com"]],
    ];
    for (const [command, reason, hidden] of cases) {
      const [provider] = readPaseoProviders(home({ custom: { extends: "acp", label: "Custom", command } })).providers;
      expect(provider?.command).toBeNull();
      expect(provider?.createBlocker).toContain(reason);
      for (const text of hidden) expect(JSON.stringify(provider)).not.toContain(text);
    }
    for (const command of [
      ["gemini", "--experimental-acp"],
      ["npx", "@google/gemini-cli@0.9.0", "--experimental-acp"],
      ["agent", "--endpoint=https://api.example.com/v1", "--model", "glm-4.6"],
      ["agent", "--endpoint", "http://api.example.com:8080/v1"],
    ]) {
      const [provider] = readPaseoProviders(home({ custom: { extends: "acp", label: "Custom", command } })).providers;
      expect(provider?.createBlocker).toBeNull();
      expect(provider?.command).toEqual(command);
    }
  });

  test("refuses entries that Paseo's schema rejects, naming the provider and rule", () => {
    const cases: [unknown, string][] = [
      [{ Bad: { extends: "claude", label: "Bad" } }, "provider ID"],
      [{ custom: { label: "No extends" } }, "extends"],
      [{ custom: { extends: "claude" } }, "label"],
      [{ custom: { extends: "gemini", label: "Unknown" } }, "extends"],
      [{ custom: { extends: "acp", label: "No command" } }, "command"],
      [{ custom: { extends: "claude", label: "Models", models: [{ id: "" , label: "x" }] } }, "models"],
      [{ custom: { extends: "claude", label: "Models", models: {} } }, "models"],
      [{ custom: { extends: "claude", label: "Tools", disallowedTools: "Bash" } }, "disallowedTools"],
      [{ custom: { extends: "claude", label: "Tools", paseoTools: { enabled: "yes" } } }, "paseoTools"],
      [{ custom: { extends: "acp", label: "Command", command: [] } }, "command"],
      [{ custom: "claude" }, "not a JSON object"],
      [[], "agents.providers"],
    ];
    for (const [providers, rule] of cases) {
      const message = refusal(home(providers));
      expect(message).toContain(rule);
    }
  });

  test("refuses a secret in a carried field without printing it", () => {
    for (const providers of [
      { custom: { extends: "claude", label: `Uses ${token}` } },
      { custom: { extends: "claude", label: "Model", models: [{ id: token, label: "x" }] } },
    ]) {
      const message = refusal(home(providers));
      expect(message).toContain("Ferry refused to carry Paseo provider custom");
      expect(message).not.toContain(token);
    }
    // A secret in a local-only field stays local and does not block the sync.
    expect(readPaseoProviders(home({ custom: { extends: "claude", label: "Env", env: { KEY: token } } })).providers).toHaveLength(1);
  });

  test("skips a legacy runtime entry with a warning", () => {
    const result = readPaseoProviders(home({ claude: { command: { mode: "replace", argv: ["/opt/claude"] } } }));
    expect(result.providers).toEqual([]);
    expect(result.warnings).toEqual(["Paseo provider claude was skipped: it uses the legacy provider format. Open and save it in Paseo to migrate it."]);
    expect(result.warnings[0]).not.toContain("/opt/claude");
  });
});

/**
 * A box that merges its config in a real shell with jq. `onPath` names the
 * commands that `command -v` finds. `written` gives the box config when the box
 * wrote the file, else undefined.
 */
function box(config: unknown = {}, onPath: readonly string[] = []) {
  const b = shellBox({ config, answer: (command) => {
    if (!command.includes("command -v -- ")) return undefined;
    const names = [...command.matchAll(/command -v -- '([^']+)'/g)].map((match) => match[1]!);
    return names.map((name) => `${onPath.includes(name) ? "ok" : "missing"} ${name}\n`).join("");
  } });
  boxes.push(b.remove);
  const before = config === null ? null : b.text();
  return { ...b, written: (): any => (before !== null && b.text() === before ? undefined : b.config()) };
}
function source(providers: unknown): PaseoProviders {
  return readPaseoProviders(home(providers));
}

const boxes: (() => void)[] = [];
afterEach(() => { for (const remove of boxes.splice(0)) remove(); });

describe("Paseo provider carry", () => {
  jqTest("merges matching providers field by field and keeps box-only fields and providers", async () => {
    const boxConfig = {
      version: 1,
      daemon: { listen: "127.0.0.1:6767" },
      agents: {
        providers: {
          zai: {
            extends: "claude", label: "Old", env: { ANTHROPIC_AUTH_TOKEN: "box-only" }, command: ["/usr/local/bin/claude"],
            params: { a: 1 }, enabled: false, order: 5, disallowedTools: ["Bash"], paseoTools: { enabled: false, disabledTools: ["x"] },
          },
          boxonly: { extends: "codex", label: "Box only" },
        },
        metadataGeneration: { providers: [{ provider: "claude" }] },
      },
    };
    const b = box(boxConfig);
    const result = await carryPaseoProviders(b.link, source({
      zai: { extends: "claude", label: "Z.AI", env: { ANTHROPIC_AUTH_TOKEN: "local" }, models, paseoTools: { disabledTools: ["y"] } },
    }));
    expect(result).toEqual({ carried: ["zai"], warnings: [], changed: true });
    expect(b.written()).toEqual({
      ...boxConfig,
      agents: {
        ...boxConfig.agents,
        providers: {
          zai: {
            extends: "claude", label: "Z.AI", env: { ANTHROPIC_AUTH_TOKEN: "box-only" }, command: ["/usr/local/bin/claude"],
            params: { a: 1 }, enabled: false, order: 5, disallowedTools: ["Bash"],
            paseoTools: { enabled: false, disabledTools: ["y"] }, models,
          },
          boxonly: { extends: "codex", label: "Box only" },
        },
      },
    });
    expect(b.commands.at(-1)).toBe("paseo daemon reload >/dev/null 2>&1");
  });

  jqTest("creates a portable provider that the box lacks, and a built-in override", async () => {
    const b = box(null);
    const result = await carryPaseoProviders(b.link, source({
      claude: { models, disallowedTools: ["WebFetch"] },
      qwen: { extends: "claude", label: "Qwen", additionalModels: models },
    }));
    expect(result.carried).toEqual(["claude", "qwen"]);
    expect(b.written()).toEqual({ agents: { providers: {
      claude: { models, disallowedTools: ["WebFetch"] },
      qwen: { extends: "claude", label: "Qwen", additionalModels: models },
    } } });
  });

  jqTest("creates a provider with a bare command only when the box resolves the executable", async () => {
    const providers = { gemini: { extends: "acp", label: "Gemini", command: ["gemini", "--experimental-acp"] } };
    const found = box({}, ["gemini"]);
    expect((await carryPaseoProviders(found.link, source(providers))).carried).toEqual(["gemini"]);
    expect(found.written().agents.providers.gemini).toEqual({ extends: "acp", label: "Gemini", command: ["gemini", "--experimental-acp"] });
    expect(found.commands.findIndex((command) => command.includes("command -v")))
      .toBeLessThan(found.commands.findIndex((command) => command.includes("ferry-tmp")));

    const missing = box({});
    const result = await carryPaseoProviders(missing.link, source(providers));
    expect(result).toEqual({
      carried: [],
      warnings: ["Paseo provider gemini was not created on the box: its command executable is not on the box PATH. Install it on the box, or define the provider on the box first."],
      changed: false,
    });
    expect(result.warnings[0]).not.toContain("--experimental-acp");
    expect(missing.written()).toBeUndefined();
    expect(missing.commands).not.toContain("paseo daemon reload >/dev/null 2>&1");
  });

  jqTest("skips a new provider that needs local runtime fields, and updates it once the box defines it", async () => {
    const local = source({ zai: { extends: "claude", label: "Z.AI", env: { KEY: "local-only" }, models } });
    const missing = box({ agents: { providers: {} } });
    const result = await carryPaseoProviders(missing.link, local);
    expect(result.warnings).toEqual([
      "Paseo provider zai was not created on the box: it has an env block. Define it on the box first, then Ferry syncs its portable fields.",
    ]);
    expect(missing.written()).toBeUndefined();

    const defined = box({ agents: { providers: { zai: { extends: "claude", label: "Z.AI", env: { KEY: "box" } } } } });
    expect((await carryPaseoProviders(defined.link, local)).carried).toEqual(["zai"]);
    expect(defined.written().agents.providers.zai).toEqual({ extends: "claude", label: "Z.AI", env: { KEY: "box" }, models });
  });

  jqTest("does not send a skipped command to a box that lacks the provider", async () => {
    const b = box({}, ["sh"]);
    const result = await carryPaseoProviders(b.link, source({
      wrapper: { extends: "acp", label: "Wrapper", command: ["sh", "-c", "exec /Users/example/private-wrapper"] },
    }));
    expect(result).toEqual({
      carried: [],
      warnings: ["Paseo provider wrapper was not created on the box: its command runs a shell or interpreter, its command has a script-like argument. Define it on the box first, then Ferry syncs its portable fields."],
      changed: false,
    });
    expect(b.commands.join("\n")).not.toContain("private-wrapper");
    expect(b.commands).toHaveLength(1);
    expect(b.written()).toBeUndefined();
  });

  jqTest("merges allowlisted fields into a box provider whose local command is not portable", async () => {
    const b = box({ agents: { providers: { wrapper: { extends: "acp", label: "Old", command: ["box-agent"] } } } });
    const result = await carryPaseoProviders(b.link, source({
      wrapper: { extends: "acp", label: "Wrapper", models, command: ["sh", "-c", "exec /Users/example/private-wrapper"] },
    }));
    expect(result).toEqual({ carried: ["wrapper"], warnings: [], changed: true });
    expect(b.written().agents.providers.wrapper).toEqual({ extends: "acp", label: "Wrapper", command: ["box-agent"], models });
    expect(b.commands.join("\n")).not.toContain("private-wrapper");
  });

  jqTest("treats a provider named constructor as new, not as an inherited box entry", async () => {
    const b = box({ agents: { providers: {} } });
    const result = await carryPaseoProviders(b.link, source({ constructor: { extends: "claude", label: "Constructor", models } }));
    expect(result).toEqual({ carried: ["constructor"], warnings: [], changed: true });
    expect(b.written().agents.providers).toEqual({ constructor: { extends: "claude", label: "Constructor", models } });

    const existing = box({ agents: { providers: { constructor: { extends: "claude", label: "Old" } } } });
    expect((await carryPaseoProviders(existing.link, source({ constructor: { extends: "claude", label: "New" } }))).carried)
      .toEqual(["constructor"]);
    expect(existing.written().agents.providers.constructor).toEqual({ extends: "claude", label: "New" });
  });

  jqTest("skips a provider that the box defines with a different extends value", async () => {
    const b = box({ agents: { providers: { zai: { extends: "codex", label: "Z.AI" } } } });
    const result = await carryPaseoProviders(b.link, source({ zai: { extends: "claude", label: "Z.AI", models } }));
    expect(result).toEqual({
      carried: [],
      warnings: ["Paseo provider zai was skipped: the box defines it with a different extends value."],
      changed: false,
    });
    expect(b.written()).toBeUndefined();
  });

  jqTest("skips a box entry in the legacy provider format", async () => {
    const b = box({ agents: { providers: { claude: { command: { mode: "replace", argv: ["/opt/claude"] } } } } });
    const result = await carryPaseoProviders(b.link, source({ claude: { models } }));
    expect(result.warnings).toEqual(["Paseo provider claude was skipped: the box entry uses the legacy provider format. Open and save it in Paseo on the box to migrate it."]);
    expect(b.written()).toBeUndefined();
  });

  jqTest("is idempotent: an unchanged box gets no write and no reload", async () => {
    const local = source({ zai: { extends: "claude", label: "Z.AI", models } });
    const first = box({ agents: { providers: { zai: { extends: "claude", label: "Old" } } } });
    await carryPaseoProviders(first.link, local);
    const second = box(first.written());
    expect(await carryPaseoProviders(second.link, local)).toEqual({ carried: ["zai"], warnings: [], changed: false });
    expect(second.written()).toBeUndefined();
    expect(second.log()).toEqual([]);
  });

  test("runs no box command without local providers", async () => {
    const b = box();
    expect(await carryPaseoProviders(b.link, { providers: [], warnings: ["w"] })).toEqual({ carried: [], warnings: ["w"], changed: false });
    expect(b.commands).toEqual([]);
  });

  jqTest("fails without box values or command output when the box config or a command is bad", async () => {
    const local = source({ zai: { extends: "claude", label: "Z.AI" } });
    for (const config of ["box-secret", { agents: [] }, { agents: { providers: [] } }]) {
      const error = String(await carryPaseoProviders(box(config).link, local).catch((caught: unknown) => caught));
      expect(error).toContain("is not a JSON object");
      expect(error).not.toContain("box-secret");
    }
    const b = box({});
    const failing: IntegrationLink = { run: async (command, options) => command.includes("ferry-tmp")
      ? { ok: false, error: { origin: "box", code: "command-failed", message: "box-secret" } }
      : b.link.run(command, options) };
    const error = String(await carryPaseoProviders(failing, local).catch((caught: unknown) => caught));
    expect(error).toContain("could not write");
    expect(error).not.toContain("box-secret");
  });
});

function syncConfig() {
  return {
    version: 1 as const, publisher: "operator", snapshotUrl: "snapshot.git", integrations: { paseo: true },
    boxes: [
      { name: "on", host: { tailscale: "on", sshUser: "user" } },
      { name: "off", host: { tailscale: "off", sshUser: "user" }, integrations: { paseo: false } },
    ],
  };
}

test("dry runs show providers only for Paseo boxes, without values, and make no connections", async () => {
  const path = home({ zai: { extends: "claude", label: "Z.AI", env: { KEY: token }, models } });
  const lines: string[] = [];
  const deps: SyncDependencies = {
    publisher: () => "operator", readConfig: syncConfig,
    createLink: () => { throw new Error("must stay offline"); }, writeLine: (line) => lines.push(line),
  };
  const result = await runSync({ home: path, dryRun: true }, deps);
  expect(result.boxes[0]?.plan.paseoProviders).toEqual({
    providers: [{
      id: "zai", fields: ["extends", "label", "models"], models: ["glm-4.6", "glm-4.5-air"],
      command: false, createBlocker: "it has an env block",
    }],
    warnings: [],
  });
  expect(result.boxes[1]?.plan.paseoProviders).toBeNull();
  const text = lines.join("\n");
  expect(text).toContain("Paseo providers: zai (extends, label, models: glm-4.6, glm-4.5-air)");
  expect(text).not.toContain(token);
});

test("sync refuses a secret in a carried provider field before it connects", async () => {
  const path = home({ zai: { extends: "claude", label: `Uses ${token}` } });
  let connected = false;
  const error = await runSync({ home: path, publish: false }, {
    publisher: () => "operator", readConfig: syncConfig,
    createLink: () => { connected = true; throw new Error("connected"); }, writeLine: () => {},
  }).catch((caught: unknown) => caught);
  expect(String(error)).toContain("Ferry refused to carry Paseo provider zai");
  expect(String(error)).not.toContain(token);
  expect(connected).toBe(false);
});

test("sync applies provider definitions before it checks provider availability for profiles and metadata preferences", async () => {
  const path = home({ zai: { extends: "claude", label: "Z.AI", models } });
  const config = JSON.parse(readFileSync(join(path, ".paseo/config.json"), "utf8"));
  config.daemon = { agentProfiles: [{ id: "glm", name: "GLM", provider: "zai" }] };
  config.agents.metadataGeneration = { providers: [{ provider: "zai", model: "glm-4.6" }] };
  writeFileSync(join(path, ".paseo/config.json"), JSON.stringify(config));
  const commands: string[] = [];
  const warnings: string[] = [];
  let boxConfig = "";
  const result = await runSync({ home: path, publish: false }, {
    publisher: () => "operator",
    readConfig: () => ({ version: 1, publisher: "operator", snapshotUrl: "snapshot.git",
      host: { tailscale: "box", sshUser: "user" }, integrations: { paseo: true } }),
    createLink: () => ({ run: async (command) => {
      commands.push(command);
      const merge = command.includes(".paseo/config.json") && command.includes("ferry-tmp");
      if (merge) boxConfig = "written";
      const status = JSON.stringify({ localDaemon: "running", providers: [{ provider: "zai", available: boxConfig === "written" }] });
      return { ok: true, address: "box", stdout: command.startsWith("printf") ? "/home/user\n"
        : command.includes("paseo daemon status --json") ? status
        : merge ? "W\n" : command.includes("$w | to_entries") ? "zai\tabsent\n" : "", stderr: "" };
    } }),
    apply: async (input) => ({ checkout: input.checkout, targetHome: input.targetHome, actions: [], unmanaged: [] }),
    acquireLock: () => () => {}, adopt: () => {}, writePlan: () => {}, writeLine: () => {},
    warn: (line) => warnings.push(line),
  });
  expect(result.boxes[0]?.failure).toBeUndefined();
  const reload = commands.indexOf("paseo daemon reload >/dev/null 2>&1");
  const status = commands.findIndex((command) => command.includes("paseo daemon status --json"));
  expect(reload).toBeGreaterThan(-1);
  expect(reload).toBeLessThan(status);
  expect(warnings.some((line) => line.includes("provider zai is not available"))).toBe(false);
  expect(warnings.some((line) => line.includes("metadata provider zai was not carried"))).toBe(false);
  const preferences = commands.findLastIndex((command) => command.includes("metadataGeneration") && command.includes("ferry-tmp"));
  expect(preferences).toBeGreaterThan(reload);
});

test("watch detects provider-only changes with its real observer", async () => {
  const path = home({ zai: { extends: "claude", label: "Z.AI", models } });
  mkdirSync(join(path, ".ferry"));
  writeFileSync(join(path, ".ferry/config.toml"), `version = 1\npublisher = ${JSON.stringify(hostname())}\nsnapshot_url = "snapshot.git"\n[host]\ntailscale = "box"\nssh_user = "user"\n[integrations]\npaseo = true\n`);
  const controller = new AbortController();
  let polls = 0, syncs = 0;
  await runWatch({ home: path, signal: controller.signal, pollMs: 1, debounceMs: 1 }, {
    sleep: async () => {
      if (++polls === 1) write(path, { zai: { extends: "claude", label: "Z.AI", models: [...models].reverse() } });
      if (polls > 5) controller.abort();
    },
    sync: async () => { syncs++; controller.abort(); }, writeLine: () => {},
    readState: () => null, writeState: () => {},
  });
  expect(syncs).toBe(1);
});

test("watch ignores provider changes when no box has Paseo", async () => {
  const path = home({ zai: { extends: "claude", label: "Z.AI", models } });
  mkdirSync(join(path, ".ferry"));
  writeFileSync(join(path, ".ferry/config.toml"), `version = 1\npublisher = ${JSON.stringify(hostname())}\nsnapshot_url = "snapshot.git"\n[host]\ntailscale = "box"\nssh_user = "user"\n`);
  const controller = new AbortController();
  let polls = 0, syncs = 0;
  await runWatch({ home: path, signal: controller.signal, pollMs: 1, debounceMs: 1 }, {
    sleep: async () => {
      if (++polls === 1) write(path, { zai: { extends: "claude", label: "Changed" } });
      if (polls > 5) controller.abort();
    },
    sync: async () => { syncs++; controller.abort(); }, writeLine: () => {},
    readState: () => null, writeState: () => {},
  });
  expect(syncs).toBe(0);
});
