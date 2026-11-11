import { afterEach, describe, expect } from "bun:test";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { applyAgentMemoryLimit } from "../src/integrations/paseo-memory-limit.ts";
import { jqTest, shellBox } from "./paseo-shell-box.ts";

const boxes: (() => void)[] = [];
afterEach(() => { for (const remove of boxes.splice(0)) remove(); });

const PATH_DIRS = [".local/bin"];
const prefix = (max: string) => ["systemd-run", "--user", "--scope", "-p", `MemoryMax=${max}`, "--"];
const available = (...ids: string[]) => ids.map((provider) => ({ provider, status: "available", enabled: "Enabled" }));

/**
 * A fake box with the real jq. `onPath` is the commands that `command -v`
 * finds on the unit PATH. `registry` is the output of `paseo provider ls --json`.
 */
function box(config: unknown, registry: unknown = [], onPath: readonly string[] = ["systemd-run", "claude", "codex"]) {
  const b = shellBox({ config, answer: (command) => {
    if (!command.includes("command -v -- ")) return undefined;
    const names = [...command.matchAll(/command -v -- '([^']+)'/g)].map((match) => match[1]!);
    return names.filter((name) => onPath.includes(name)).map((name) => `ok ${name}\n`).join("");
  } });
  const registryPath = join(b.home, "../registry.json");
  writeFileSync(registryPath, JSON.stringify(registry));
  const paseoPath = join(b.home, "../bin/paseo");
  writeFileSync(paseoPath, readFileSync(paseoPath, "utf8").replace('case "$1 $2" in',
    `case "$1 $2" in\n  "provider ls") cat '${registryPath}' ;;`));
  boxes.push(b.remove);
  return b;
}

describe("agent memory limit", () => {
  jqTest("with no limit, a box without the Ferry prefix stays as it is", async () => {
    const config = { version: 1, agents: { providers: { codex: { command: ["codex"], env: { KEY: "box-only" } } } } };
    for (const start of [config, {}, null]) {
      const b = box(start);
      const before = start === null ? null : b.text();
      const result = await applyAgentMemoryLimit(b.link, null, PATH_DIRS);
      expect(result).toEqual({ wrapped: [], warnings: [], changed: false });
      expect(start === null ? b.config() : b.text()).toEqual(start === null ? undefined : before!);
      expect(b.log()).toEqual([]);
    }
  });

  jqTest("wraps the available providers and keeps their box fields", async () => {
    const b = box({ version: 1, agents: { providers: {
      codex: { command: ["codex", "--profile", "box"], env: { KEY: "box-only" } },
      copilot: { enabled: false },
    } } }, [...available("claude", "codex"), { provider: "copilot", status: "available", enabled: "Disabled" }]);
    const result = await applyAgentMemoryLimit(b.link, "6G", PATH_DIRS);

    expect(result).toEqual({ wrapped: ["claude", "codex"], warnings: [], changed: true });
    expect(b.config().agents.providers).toEqual({
      codex: { command: [...prefix("6G"), "codex", "--profile", "box"], env: { KEY: "box-only" } },
      copilot: { enabled: false },
      claude: { command: [...prefix("6G"), "claude"] },
    });
    expect(b.log()).toEqual(["paseo provider ls --json", "paseo daemon reload"]);
    expect(b.outputs.join("\n")).not.toContain("box-only");
    expect(b.commands.join("\n")).not.toContain("box-only");
  });

  jqTest("a new value replaces the old prefix, and the same value changes nothing", async () => {
    const b = box({ agents: { providers: { claude: { command: [...prefix("6G"), "claude"] } } } }, available("claude"));
    expect((await applyAgentMemoryLimit(b.link, "8G", PATH_DIRS)).changed).toBe(true);
    expect(b.config().agents.providers.claude.command).toEqual([...prefix("8G"), "claude"]);
    const again = await applyAgentMemoryLimit(b.link, "8G", PATH_DIRS);
    expect(again).toEqual({ wrapped: ["claude"], warnings: [], changed: false });
    expect(b.log().filter((line) => line === "paseo daemon reload")).toHaveLength(1);
  });

  jqTest("with no limit, removes the Ferry prefix and the entries that Ferry added", async () => {
    const b = box({ version: 1, agents: { providers: {
      claude: { command: [...prefix("6G"), "claude"] },
      codex: { command: [...prefix("6G"), "codex", "--profile", "box"], env: { KEY: "box-only" } },
      pi: { command: [...prefix("6G"), "pi"], label: "Pi" },
      opencode: { command: ["opencode"] },
      copilot: {},
      mine: { extends: "claude", label: "Mine", command: [...prefix("6G"), "claude"] },
      acp1: { extends: "acp", label: "ACP", command: [...prefix("6G"), "acp1"] },
    } } });
    const result = await applyAgentMemoryLimit(b.link, null, PATH_DIRS);

    expect(result.changed).toBe(true);
    expect(b.config()).toEqual({ version: 1, agents: { providers: {
      codex: { command: ["codex", "--profile", "box"], env: { KEY: "box-only" } },
      pi: { label: "Pi" },
      opencode: { command: ["opencode"] },
      copilot: {},
      mine: { extends: "claude", label: "Mine" },
      acp1: { extends: "acp", label: "ACP", command: ["acp1"] },
    } } });
    expect(b.log()).toEqual(["paseo daemon reload"]);
    // The removal names no agent CLI, so a box with an agent CLI off gets no command about it.
    expect(b.commands.join("\n")).not.toMatch(/claude"|codex"/);
  });

  jqTest("skips a provider whose command is not on the unit PATH, and wraps the others", async () => {
    const b = box({ agents: { providers: {
      codex: { command: [...prefix("6G"), "codex"] },
      custom: { extends: "acp", label: "Custom", command: ["custom-agent", "--acp"] },
    } } }, available("claude", "codex", "custom"), ["systemd-run", "claude"]);
    const result = await applyAgentMemoryLimit(b.link, "6G", PATH_DIRS);

    expect(result.wrapped).toEqual(["claude"]);
    expect(result.warnings).toEqual(["codex", "custom-agent"].map((command) =>
      `Paseo provider ${command === "codex" ? "codex" : "custom"} has no memory limit: its command ${command} is not on the PATH of ferry-paseo.service. Ferry did not wrap it, so its agents still start.`));
    // Ferry removes its prefix from codex, and then the entry that it added.
    expect(b.config().agents.providers).toEqual({
      custom: { extends: "acp", label: "Custom", command: ["custom-agent", "--acp"] },
      claude: { command: [...prefix("6G"), "claude"] },
    });
    // The PATH check uses the PATH of ferry-paseo.service.
    expect(b.commands.find((command) => command.includes("command -v -- ")))
      .toStartWith(`PATH="$HOME"/'.local/bin':/usr/local/sbin:`);
  });

  jqTest("without systemd-run on the unit PATH, wraps nothing", async () => {
    const b = box({}, available("claude"), ["claude"]);
    const result = await applyAgentMemoryLimit(b.link, "6G", PATH_DIRS);
    expect(result).toEqual({
      wrapped: [],
      warnings: ["The agents on the box have no memory limit: systemd-run is not on the PATH of ferry-paseo.service."],
      changed: false,
    });
    expect(b.config()).toEqual({});
  });

  jqTest("warns for an available provider without a known command or with a legacy entry", async () => {
    const b = box({ agents: { providers: { muse: {}, old: { command: { mode: "replace", argv: ["old"] } } } } },
      available("muse", "old"));
    const result = await applyAgentMemoryLimit(b.link, "6G", PATH_DIRS);
    expect(result.wrapped).toEqual([]);
    expect(result.warnings).toEqual([
      "Paseo provider muse has no memory limit: Ferry does not know its command. Set command for it in ~/.paseo/config.json on the box.",
      "Paseo provider old has no memory limit: its box entry uses the legacy provider format. Open and save it in Paseo on the box to migrate it.",
    ]);
    expect(result.changed).toBe(false);
  });

  jqTest("a failed registry command throws without box output and writes nothing", async () => {
    const b = box({});
    const paseoPath = join(b.home, "../bin/paseo");
    writeFileSync(paseoPath, readFileSync(paseoPath, "utf8").replace(
      /"provider ls"\).*?;;/, '"provider ls") echo box-private; exit 1 ;;',
    ));
    const error = await applyAgentMemoryLimit(b.link, "6G", PATH_DIRS).catch((cause) => String(cause));
    expect(error).toBe("PaseoError: Ferry could not read the available Paseo providers on the box");
    expect(b.config()).toEqual({});
  });
});
