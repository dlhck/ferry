import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { carryAgentProfiles, carryPaseoPreferences, unitFile } from "../src/integrations/paseo.ts";
import { carryPaseoPlugins, type PaseoPlugin } from "../src/integrations/paseo-plugins.ts";
import { carryPaseoProviders, type PaseoProviders } from "../src/integrations/paseo-providers.ts";
import { carryPaseoTerminalProfiles } from "../src/integrations/paseo-terminal-profiles.ts";
import { runSync, type SyncPlan } from "../src/sync.ts";
import { BUILTIN_BOX_PATH_DIRS } from "../src/tools/path.ts";
import { jqTest, shellBox, type ShellBox } from "./paseo-shell-box.ts";

const roots: (() => void)[] = [];
afterEach(() => { for (const remove of roots.splice(0)) remove(); });

// Build the values at run time so this file holds no string a secret scanner flags.
const PROVIDER_SECRET = "sk-" + "provider-" + "q7Zx9".repeat(6);
const TERMINAL_SECRET = "gh" + "p_" + "T".repeat(36);
const SECRETS = [PROVIDER_SECRET, TERMINAL_SECRET];
const PLUGIN_SECRET = "gl" + "pat-" + "R4v".repeat(7);
const UNIT_SECRET = "box-only-" + "password-" + "K2m".repeat(5);
const UNIT_PATH = ".config/systemd/user/ferry-paseo.service";
/** A Git remote with an embedded credential, as a box can hold it. */
const credentialRemote = (repository: string) => `https://user:${PLUGIN_SECRET}@git.example.com/${repository}.git`;

const revision = "a".repeat(40);
const plugin: PaseoPlugin = {
  kind: "git", id: "review", remote: "https://github.com/example/plugins.git", path: "plugins/review", commit: revision, enabled: true,
};
const installed = [{
  id: "review", enabled: true,
  installation: { identity: { kind: "git", remote: plugin.remote, pluginPath: plugin.path }, currentRevision: revision },
}, {
  // A box-only plugin. Its remote holds a box credential.
  id: "box-only", enabled: true,
  installation: { identity: { kind: "git", remote: credentialRemote("box-only"), pluginPath: "." }, currentRevision: revision },
}];
const models = [{ id: "glm-4.6", label: "GLM 4.6" }];
const providers: PaseoProviders = {
  providers: [{ id: "zai", fields: { extends: "claude", label: "Z.AI", models }, command: null, createBlocker: null }],
  warnings: [],
};
const lazygit = { id: "lazygit", name: "Lazygit", command: "lazygit", icon: "git" };
const reviewer = { id: "p1", name: "Reviewer", provider: "claude", model: "opus" };
const status = { localDaemon: "running", providers: [{ provider: "claude", available: true }] };

/** A box config with a secret in a provider env block and in a terminal profile env block. */
function boxConfig() {
  return {
    version: 1,
    daemon: {
      listen: "127.0.0.1:6767",
      terminalProfiles: [{ id: "lazygit", name: "Old", command: "lazygit", env: { GH_TOKEN: TERMINAL_SECRET } }],
    },
    agents: { providers: { zai: { extends: "claude", label: "Old", env: { ANTHROPIC_AUTH_TOKEN: PROVIDER_SECRET } } } },
  };
}

/** The box config after the carry. Each env block stays. */
const merged = {
  version: 1,
  pluginsEnabled: true,
  daemon: {
    listen: "127.0.0.1:6767",
    terminalProfiles: [{ id: "lazygit", name: "Lazygit", command: "lazygit", env: { GH_TOKEN: TERMINAL_SECRET }, icon: "git" }],
    agentProfiles: [reviewer],
    appendSystemPrompt: "Be brief.",
  },
  agents: {
    providers: { zai: { extends: "claude", label: "Z.AI", env: { ANTHROPIC_AUTH_TOKEN: PROVIDER_SECRET }, models } },
    metadataGeneration: { providers: [{ provider: "claude", model: "haiku" }] },
  },
};

function box(config: unknown, answer?: (command: string) => string | undefined): ShellBox {
  const created = shellBox({
    config, status, plugins: installed,
    answer: (command) => answer?.(command) ?? (command.includes("command -v -- 'lazygit'") ? "ok lazygit\n" : undefined),
  });
  roots.push(created.remove);
  return created;
}

function expectNoSecret(value: unknown): void {
  const text = typeof value === "string" ? value : JSON.stringify(value);
  for (const secret of [...SECRETS, PLUGIN_SECRET, UNIT_SECRET]) expect(text).not.toContain(secret);
}

describe("box Paseo config secrets", () => {
  jqTest("never reach Ferry: the box merges its config and prints only a status or a fixed word", async () => {
    const b = box(boxConfig());

    const results = [
      await carryPaseoPlugins(b.link, { plugins: [plugin], warnings: [] }),
      await carryPaseoProviders(b.link, providers),
      await carryAgentProfiles(b.link, [reviewer]),
      await carryPaseoPreferences(b.link, { metadataProviders: [{ provider: "claude", model: "haiku" }], appendSystemPrompt: "Be brief." }),
      await carryPaseoTerminalProfiles(b.link, { profiles: [lazygit], warnings: [] }, []),
    ];

    expectNoSecret({ outputs: b.outputs, commands: b.commands, results });
    // The box merged each carried value and kept each env block.
    expect(b.config()).toEqual(merged);
    expect(b.log()).toEqual(Array(5).fill("paseo daemon reload"));
  });

  jqTest("never reach Ferry in an error for a box config that the box cannot merge", async () => {
    for (const config of [`not json ${SECRETS.join(" ")}`, [SECRETS], { agents: SECRETS, daemon: SECRETS, note: SECRETS }]) {
      const b = box(config);
      const before = b.text();
      const errors = [
        await carryPaseoPlugins(b.link, { plugins: [plugin], warnings: [] }).catch(String),
        await carryPaseoProviders(b.link, providers).catch(String),
        await carryAgentProfiles(b.link, [reviewer]).catch(String),
        await carryPaseoPreferences(b.link, { appendSystemPrompt: "Be brief." }).catch(String),
        await carryPaseoTerminalProfiles(b.link, { profiles: [lazygit], warnings: [] }, []).catch(String),
      ];

      // A valid top-level object lets the plugin switch through. Each other step refuses the file.
      for (const error of errors.slice(1)) expect(error).toContain("~/.paseo/config.json on the box is not a JSON object");
      expectNoSecret({ outputs: b.outputs, commands: b.commands, errors });
      if (typeof config === "string" || Array.isArray(config)) expect(b.text()).toBe(before);
      for (const secret of SECRETS) expect(b.text()).toContain(secret);
    }
  });

  jqTest("never reach the plan, the output lines, or the warnings of a sync", async () => {
    const home = mkdtempSync(join(tmpdir(), "ferry-paseo-secrets-"));
    roots.push(() => rmSync(home, { recursive: true, force: true }));
    mkdirSync(join(home, ".paseo"));
    writeFileSync(join(home, ".paseo/config.json"), JSON.stringify({
      daemon: { agentProfiles: [reviewer], appendSystemPrompt: "Be brief.", terminalProfiles: [lazygit] },
      agents: {
        providers: { zai: { extends: "claude", label: "Z.AI", models } },
        metadataGeneration: { providers: [{ provider: "claude", model: "haiku" }] },
      },
    }));
    // Only the Paseo commands run in the shell. The other box commands of a sync get a fixed reply.
    const b = box(boxConfig(), (command) =>
      command.includes(".paseo/config.json") || command.startsWith("paseo ") || command.includes("paseo daemon status") || command.includes("paseo plugin ls")
        || command.includes("ferry-paseo.service")
        ? undefined
        : command.startsWith("printf") ? "/home/user\n" : command.includes("command -v -- 'lazygit'") ? "ok lazygit\n" : "");
    // A unit with a line that the operator added on the box by hand.
    const unit = `${unitFile(BUILTIN_BOX_PATH_DIRS)}Environment=DATABASE_PASSWORD=${UNIT_SECRET}\n`;
    mkdirSync(join(b.home, UNIT_PATH, ".."), { recursive: true });
    writeFileSync(join(b.home, UNIT_PATH), unit);
    const lines: string[] = [];
    const warnings: string[] = [];
    const plans: SyncPlan[] = [];

    const result = await runSync({ home, publish: false }, {
      publisher: () => "operator",
      readConfig: () => ({ version: 1, publisher: "operator", snapshotUrl: "snapshot.git",
        host: { tailscale: "box", sshUser: "user" }, integrations: { paseo: true } }),
      createLink: () => b.link,
      apply: async (input) => ({ checkout: input.checkout, targetHome: input.targetHome, actions: [], unmanaged: [] }),
      acquireLock: () => () => {}, adopt: () => {}, writePlan: (plan) => plans.push(plan),
      writeLine: (line) => lines.push(line), warn: (line) => warnings.push(line),
    });

    expect(result.boxes[0]?.failure).toBeUndefined();
    expectNoSecret({ outputs: b.outputs, commands: b.commands, lines, warnings, plans, result });
    expect(warnings.filter((line) => /paseo/i.test(line))).toEqual([]);
    expect(b.outputs).toContain("unchanged\n");
    expect(readFileSync(join(b.home, UNIT_PATH), "utf8")).toBe(unit);
    const { pluginsEnabled: _switch, ...carried } = merged;
    expect(b.config()).toEqual(carried);
  });

  jqTest("a credential in a box plugin remote never reaches Ferry", async () => {
    const tools: PaseoPlugin = { kind: "npm", id: "tools", packageName: "@acme/tools", path: ".", version: "1.2.3", enabled: true };
    const created = shellBox({ config: { pluginsEnabled: true }, plugins: [
      // The same ID and path as the local plugin. The box remote holds a credential.
      { id: "review", enabled: true, installation: {
        identity: { kind: "git", remote: credentialRemote("plugins"), pluginPath: plugin.path }, currentRevision: revision } },
      { id: "tools", enabled: false, installation: {
        identity: { kind: "npm", packageName: "@acme/tools", pluginPath: "." }, currentRevision: "1.0.0" } },
      installed[1],
    ] });
    roots.push(created.remove);
    // Each other `paseo` command echoes the remote to stdout and to stderr.
    const paseo = join(created.home, "../bin/paseo");
    const echo = `echo '${credentialRemote("tools")}'`;
    writeFileSync(paseo, readFileSync(paseo, "utf8").replace("*) echo '{}' ;;", `*) ${echo}; ${echo} >&2 ;;`));
    expect(readFileSync(paseo, "utf8")).toContain(PLUGIN_SECRET);

    const warnings = await carryPaseoPlugins(created.link, { plugins: [plugin, tools], warnings: [] });

    expectNoSecret({ outputs: created.outputs, commands: created.commands, warnings });
    expect(warnings).toEqual(["Paseo plugin review was skipped: the box has the same ID with a different source."]);
    expect(created.log()).toEqual(["paseo plugin update tools --version 1.2.3 --json", "paseo plugin enable tools --json"]);
  });

  test("without jq, the box config and plugins stay as they are and each step warns", async () => {
    const created = shellBox({ config: boxConfig(), status, plugins: installed, jq: false,
      answer: (command) => (command.includes("command -v -- 'lazygit'") ? "ok lazygit\n" : undefined) });
    roots.push(created.remove);
    const before = created.text();
    const warning = (what: string) => `jq is not on the box, so Ferry did not update ${what}. Run ferry update to install jq.`;

    expect(await carryPaseoPlugins(created.link, { plugins: [plugin], warnings: [] })).toEqual([warning("the Paseo plugins")]);
    expect(await carryPaseoProviders(created.link, providers)).toEqual({
      carried: [], warnings: [warning("the Paseo providers")], changed: false,
    });
    expect(await carryAgentProfiles(created.link, [reviewer])).toEqual({
      carried: [], warnings: [warning("the Paseo agent profiles")], changed: false,
    });
    expect(await carryPaseoPreferences(created.link, { appendSystemPrompt: "Be brief." })).toEqual({
      warnings: [warning("the Paseo preferences")], changed: false,
    });
    expect(await carryPaseoTerminalProfiles(created.link, { profiles: [lazygit], warnings: [] }, [])).toEqual({
      carried: [], warnings: [warning("the Paseo terminal profiles")], changed: false,
    });

    expect(created.text()).toBe(before);
    expect(created.log()).toEqual([]);
    expectNoSecret({ outputs: created.outputs, commands: created.commands });
  });
});
