import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";
import { readPaseoPreferences } from "../src/integrations/paseo.ts";
import { runSync, type SyncDependencies } from "../src/sync.ts";
import { runWatch } from "../src/watch.ts";

const homes: string[] = [];
afterEach(() => { for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true }); });
// Build the values at run time so this file holds no string a secret scanner flags.
const token = "gh" + "p_" + "A".repeat(36);
const prompt = "Answer in short sentences.";
const providers = [{ provider: "claude", model: "haiku" }, { provider: "codex", thinkingOptionId: "low" }];

function home(config?: unknown): string {
  const path = mkdtempSync(join(tmpdir(), "ferry-preferences-"));
  homes.push(path);
  if (config !== undefined) write(path, config);
  return path;
}
function write(path: string, config: unknown): void {
  mkdirSync(join(path, ".paseo"), { recursive: true });
  writeFileSync(join(path, ".paseo/config.json"), JSON.stringify(config));
}
function refusal(path: string): string {
  try { readPaseoPreferences(path); } catch (error) { return String(error); }
  throw new Error("accepted the config");
}

describe("Paseo preference discovery", () => {
  test("reads only the metadata providers and the shared instructions", () => {
    const path = home({
      daemon: { listen: "127.0.0.1:6767", appendSystemPrompt: prompt, agentProfiles: [] },
      agents: { providers: { claude: { env: { KEY: "value" } } }, metadataGeneration: { providers } },
    });
    expect(readPaseoPreferences(path)).toEqual({ metadataProviders: providers, appendSystemPrompt: prompt });
  });

  test("omits missing fields and keeps explicit empty values", () => {
    expect(readPaseoPreferences(home())).toEqual({});
    expect(readPaseoPreferences(home({ daemon: {}, agents: { metadataGeneration: {} } }))).toEqual({});
    expect(readPaseoPreferences(home({ daemon: { appendSystemPrompt: "" }, agents: { metadataGeneration: { providers: [] } } })))
      .toEqual({ metadataProviders: [], appendSystemPrompt: "" });
  });

  test("refuses entries that Paseo's schema rejects", () => {
    for (const entry of [{ model: "haiku" }, { provider: "" }, { provider: "claude", model: "" }, { provider: "claude", env: {} }, "claude"]) {
      expect(refusal(home({ agents: { metadataGeneration: { providers: [entry] } } })))
        .toContain("agents.metadataGeneration.providers");
    }
    expect(refusal(home({ agents: { metadataGeneration: { providers: {} } } }))).toContain("agents.metadataGeneration.providers");
    expect(refusal(home({ daemon: { appendSystemPrompt: null } }))).toContain("daemon.appendSystemPrompt");
    expect(refusal(home({ agents: [] }))).toContain("agents");
  });

  test("refuses secrets in the shared instructions without the text or the value", () => {
    for (const text of [`Use ${token} for the release repo.`, "Log in with\npassword: q7Z-hunter-2x\n"]) {
      const message = refusal(home({ daemon: { appendSystemPrompt: text } }));
      expect(message).toContain("Ferry refused to carry daemon.appendSystemPrompt");
      expect(message).not.toContain(token);
      expect(message).not.toContain("q7Z-hunter-2x");
      expect(message).not.toContain("release repo");
    }
    expect(refusal(home({ agents: { metadataGeneration: { providers: [{ provider: "claude", model: token }] } } })))
      .not.toContain(token);
  });
});

function config(paseo: boolean) {
  return {
    version: 1, publisher: "operator", snapshotUrl: "snapshot.git", integrations: { paseo: true },
    boxes: [
      { name: "on", host: { tailscale: "on", sshUser: "user" } },
      { name: "off", host: { tailscale: "off", sshUser: "user" }, integrations: { paseo } },
    ],
  } as const;
}

test("dry runs show the preferences only for enabled boxes, without the instruction text or a connection", async () => {
  const path = home({ daemon: { appendSystemPrompt: prompt }, agents: { metadataGeneration: { providers } } });
  const lines: string[] = [];
  const deps: SyncDependencies = {
    publisher: () => "operator", readConfig: () => config(false),
    createLink: () => { throw new Error("must stay offline"); }, writeLine: (line) => lines.push(line),
  };
  const result = await runSync({ home: path, dryRun: true }, deps);
  expect(result.boxes[0]?.plan.paseoPreferences).toEqual({ metadataProviders: providers, appendSystemPromptLength: prompt.length });
  expect(result.boxes[1]?.plan.paseoPreferences).toBeNull();
  expect(JSON.stringify(result)).not.toContain(prompt);
  expect(lines.join("\n")).not.toContain(prompt);
  expect(lines.join("\n")).toContain("claude/haiku, codex (thinking low)");
});

test("a secret in the shared instructions refuses the sync before a publish or a box connection", async () => {
  const path = home({ daemon: { appendSystemPrompt: `Use ${token}.` } });
  let connected = false;
  const run = runSync({ home: path }, {
    publisher: () => "operator", readConfig: () => config(true),
    createLink: () => { connected = true; throw new Error("connected"); },
    acquireLock: () => () => {}, writeLine: () => {},
  });
  await expect(run).rejects.toThrow("daemon.appendSystemPrompt");
  await run.catch((error: unknown) => expect(String(error)).not.toContain(token));
  expect(connected).toBe(false);
});

test("sync carries the preferences and reports a failure without blocking the core sync", async () => {
  const path = home({ daemon: { appendSystemPrompt: prompt } });
  for (const fail of [false, true]) {
    const commands: string[] = [];
    const warnings: string[] = [];
    const result = await runSync({ home: path, publish: false }, {
      publisher: () => "operator",
      readConfig: () => ({ version: 1, publisher: "operator", snapshotUrl: "snapshot.git",
        host: { tailscale: "box", sshUser: "user" }, integrations: { paseo: true } }),
      createLink: () => ({ run: async (command) => {
        commands.push(command);
        if (fail && command === "paseo daemon reload") return { ok: false, error: { origin: "box", code: "command-failed", message: "down" } };
        return { ok: true, address: "box", stdout: command.startsWith("printf") ? "/home/user\n" : command.includes("cat '.paseo/config.json'") ? "M" : "", stderr: "" };
      } }),
      apply: async (input) => ({ checkout: input.checkout, targetHome: input.targetHome, actions: [], unmanaged: [] }),
      acquireLock: () => () => {}, adopt: () => {}, writePlan: () => {}, writeLine: () => {},
      warn: (line) => warnings.push(line),
    });
    expect(result.boxes[0]?.failure).toBeUndefined();
    expect(commands.some((command) => command.includes("appendSystemPrompt"))).toBe(true);
    expect(commands).toContain("paseo daemon reload");
    const failure = warnings.find((line) => line.includes("could not carry the Paseo preferences"));
    expect(failure !== undefined).toBe(fail);
    expect(failure ?? "").not.toContain(prompt);
  }
});

test("a failed box command never puts its message, the instruction text, or another value into the output", async () => {
  const path = home({ daemon: { appendSystemPrompt: prompt } });
  const session = "session-" + "q7Z-hunter-2x";
  const failing: readonly ((command: string) => boolean)[] = [
    (command) => command.includes("cat '.paseo/config.json'"),
    (command) => command.includes("appendSystemPrompt"),
    (command) => command === "paseo daemon reload",
  ];
  for (const fails of failing) {
    const lines: string[] = [];
    const warnings: string[] = [];
    const result = await runSync({ home: path, publish: false }, {
      publisher: () => "operator",
      readConfig: () => ({ version: 1, publisher: "operator", snapshotUrl: "snapshot.git",
        host: { tailscale: "box", sshUser: "user" }, integrations: { paseo: true } }),
      createLink: () => ({ run: async (command) => {
        // A remote shell can echo the failed command, which holds the instruction text.
        if (fails(command)) return { ok: false, error: { origin: "box", code: "command-failed", message: `${command} ${session}` } };
        return { ok: true, address: "box", stdout: command.startsWith("printf") ? "/home/user\n" : command.includes("cat '.paseo/config.json'") ? "M" : "", stderr: "" };
      } }),
      apply: async (input) => ({ checkout: input.checkout, targetHome: input.targetHome, actions: [], unmanaged: [] }),
      acquireLock: () => () => {}, adopt: () => {}, writePlan: () => {}, writeLine: (line) => lines.push(line),
      warn: (line) => warnings.push(line),
    });
    expect(result.boxes[0]?.failure).toBeUndefined();
    expect(warnings.some((line) => line.includes("could not carry the Paseo preferences"))).toBe(true);
    for (const output of [warnings.join("\n"), lines.join("\n"), JSON.stringify(result)]) {
      expect(output).not.toContain(prompt);
      expect(output).not.toContain(session);
    }
  }
});

test("watch detects preference-only changes with its real observer", async () => {
  const path = home({ daemon: { appendSystemPrompt: prompt } });
  mkdirSync(join(path, ".ferry"));
  writeFileSync(join(path, ".ferry/config.toml"), `version = 1\npublisher = ${JSON.stringify(hostname())}\nsnapshot_url = "snapshot.git"\n[host]\ntailscale = "box"\nssh_user = "user"\n[integrations]\npaseo = true\n`);
  const controller = new AbortController();
  let polls = 0, syncs = 0;
  await runWatch({ home: path, signal: controller.signal, pollMs: 1, debounceMs: 1 }, {
    sleep: async () => { if (++polls === 1) write(path, { agents: { metadataGeneration: { providers } }, daemon: { appendSystemPrompt: prompt } }); if (polls > 5) controller.abort(); },
    sync: async () => { syncs++; controller.abort(); }, writeLine: () => {},
    readState: () => null, writeState: () => {},
  });
  expect(syncs).toBe(1);
});
