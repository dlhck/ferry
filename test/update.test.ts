import { describe, expect, test } from "bun:test";
import { createPaseo } from "../src/integrations/paseo.ts";
import type { Integration } from "../src/integrations/types.ts";
import type { HostCommand, HostCommandResult, LinkResult } from "../src/link.ts";
import { noProgress } from "../src/progress.ts";
import { BUILTIN_TOOLS } from "../src/registry/builtin.ts";
import type { ToolDescriptor } from "../src/registry/types.ts";
import {
  planUpdate,
  runUpdateCommand,
  UpdateError,
  type UpdateCommandDependencies,
} from "../src/update.ts";

const config = {
  version: 1 as const,
  publisher: "operator",
  snapshotUrl: "git@example.com:snapshot.git",
  host: { tailscale: "builder.tailnet.ts.net", sshUser: "david" },
};

const PREFIX_END = 'cd "$HOME" || exit 1; ';

const fill = (command: string) => (version: string) => command.replaceAll("{version}", `'${version}'`);

function configTool(id: string, extra: Partial<ToolDescriptor> = {}): ToolDescriptor {
  return {
    id,
    kind: "tool",
    localVersion: `${id} --version`,
    boxVersion: `${id} --version`,
    recipe: { install: fill(`install ${id} {version}`), update: fill(`update ${id} {version}`) },
    ...extra,
  };
}

function agent(id: string): ToolDescriptor {
  return {
    id,
    kind: "agent",
    localVersion: `${id} --version`,
    boxVersion: `${id} --version`,
    install: { command: `install ${id}` },
    update: { command: `${id} update`, binary: id },
  };
}

const tools: readonly ToolDescriptor[] = [
  {
    id: "gh",
    kind: "tool",
    localVersion: "gh --version",
    boxVersion: "gh --version",
    install: { command: "install gh" },
    update: { command: "sudo apt install gh -y" },
  },
  agent("claude"),
  agent("codex"),
  configTool("pnpm", { dependsOn: ["node"] }),
  configTool("node"),
];

const LOCAL_VERSIONS: Readonly<Record<string, string>> = {
  "gh --version": "gh version 2.92.0",
  "claude --version": "2.1.0",
  "codex --version": "0.156.1",
  "node --version": "v24.16.0",
  "pnpm --version": "11.17.0",
};

const BOX_VERSIONS: Readonly<Record<string, string>> = {
  "gh --version": "gh version 2.91.0",
  "claude --version": "2.0.0",
  "codex --version": "0.150.0",
  "node --version": "v24.16.0",
};

type Recorder = {
  readonly box: string[];
  readonly local: string[];
  readonly output: string[];
};

/** The command after the nvm and home prefix of a version read, or null for another command. */
function versionRead(script: string): string | null {
  const at = script.indexOf(PREFIX_END);
  return at === -1 ? null : script.slice(at + PREFIX_END.length);
}

function dependencies(
  options: {
    readonly installed?: readonly string[];
    readonly localVersions?: Readonly<Record<string, string>>;
    readonly boxVersions?: Readonly<Record<string, string>>;
    readonly confirm?: () => Promise<boolean | symbol | undefined>;
    readonly boxFails?: readonly string[];
    readonly localFails?: readonly string[];
  } = {},
): { recorder: Recorder; deps: Partial<UpdateCommandDependencies> } {
  const recorder: Recorder = { box: [], local: [], output: [] };
  const installed = options.installed ?? ["claude", "codex"];
  const localVersions = options.localVersions ?? LOCAL_VERSIONS;
  const boxVersions = options.boxVersions ?? BOX_VERSIONS;
  return {
    recorder,
    deps: {
      tools,
      readConfig: () => config,
      createLink: () => ({
        run: async (command: string): Promise<LinkResult> => {
          const read = versionRead(command);
          if (read !== null) {
            const stdout = boxVersions[read];
            if (stdout === undefined) return { ok: false, error: { code: "command-failed", origin: "box", message: "missing" } };
            return { ok: true, address: "100.64.0.1", stdout, stderr: "" };
          }
          recorder.box.push(command);
          if (options.boxFails?.includes(command)) {
            return {
              ok: false,
              error: { code: "command-failed", origin: "box", message: "update refused" },
            };
          }
          return { ok: true, address: "100.64.0.1", stdout: "", stderr: "" };
        },
      }),
      local: {
        run: async (command: HostCommand): Promise<HostCommandResult> => {
          const script = command.argv.at(-1) ?? "";
          const read = versionRead(script);
          if (read !== null) {
            const stdout = localVersions[read];
            return { exitCode: stdout === undefined ? 127 : 0, stdout: stdout ?? "", stderr: "", timedOut: false };
          }
          const probe = /^command -v (\S+)$/.exec(script);
          if (probe) {
            const found = installed.includes(probe[1] ?? "");
            return { exitCode: found ? 0 : 1, stdout: "", stderr: "", timedOut: false };
          }
          recorder.local.push(script);
          const failed = options.localFails?.includes(script) === true;
          return { exitCode: failed ? 1 : 0, stdout: "", stderr: failed ? "no network" : "", timedOut: false };
        },
      },
      confirm: options.confirm ?? (async () => true),
      writeLine: (line) => recorder.output.push(line),
    },
  };
}

const PLAN = [
  "Box gh: update 2.92.0 (policy operator): sudo apt install gh -y",
  "Box claude: update latest (policy latest): claude update",
  "Box codex: update latest (policy latest): codex update",
  "Box node: skipped, the box has 24.16.0 (policy operator)",
  "Box pnpm: install 11.17.0 (policy operator): install pnpm '11.17.0'",
  "Operator gh: skipped, no own update command",
  "Operator claude: claude update",
  "Operator codex: codex update",
  "Operator pnpm: skipped, no own update command",
  "Operator node: skipped, no own update command",
];

describe("update plan", () => {
  test("plans the box by version in depends order and updates only the installed agent CLIs on the operator machine", async () => {
    const { recorder, deps } = dependencies({ installed: ["claude"] });

    const plan = await planUpdate(tools, undefined, deps.local!, deps.createLink!(config.host as never));

    expect(plan.box.map(({ tool, action, command }) => [tool, action, command])).toEqual([
      ["gh", "update", "sudo apt install gh -y"],
      ["claude", "update", "claude update"],
      ["codex", "update", "codex update"],
      ["node", "skip-same", undefined],
      ["pnpm", "install", "install pnpm '11.17.0'"],
    ]);
    expect(plan.operator).toEqual([
      { tool: "gh", reason: "no own update command" },
      { tool: "claude", command: "claude update" },
      { tool: "codex", reason: "not installed" },
      { tool: "pnpm", reason: "no own update command" },
      { tool: "node", reason: "no own update command" },
    ]);
    expect(recorder.local).toEqual([]);
    expect(recorder.box).toEqual([]);
  });

  test("the builtin tools carry the verified vendor update commands", () => {
    expect(Object.fromEntries(BUILTIN_TOOLS.map((tool) => [tool.id, tool.update]))).toEqual({
      gh: { command: "sudo apt update && sudo apt install gh -y" },
      claude: { command: "claude update", binary: "claude" },
      codex: { command: "codex update", binary: "codex" },
      pi: { command: "pi update", binary: "pi" },
      cursor: { command: "cursor-agent update", binary: "cursor-agent" },
    });
  });
});

describe("update command", () => {
  test("prints the plan before confirmation and runs nothing without it", async () => {
    let outputAtPrompt: readonly string[] = [];
    const { recorder, deps } = dependencies({
      confirm: async () => {
        outputAtPrompt = [...recorder.output];
        return false;
      },
    });

    await runUpdateCommand({ yes: false, dryRun: false }, deps);

    expect(outputAtPrompt).toEqual(PLAN);
    expect(recorder.box).toEqual([]);
    expect(recorder.local).toEqual([]);
    expect(recorder.output.at(-1)).toBe("Update cancelled.");
  });

  test("dry run prints the plan, asks nothing, and changes nothing", async () => {
    let prompts = 0;
    const { recorder, deps } = dependencies({
      confirm: async () => {
        prompts += 1;
        return true;
      },
    });

    await runUpdateCommand({ yes: false, dryRun: true }, deps);

    expect(recorder.output).toEqual(PLAN);
    expect(prompts).toBe(0);
    expect(recorder.box).toEqual([]);
    expect(recorder.local).toEqual([]);
  });

  test("runs the box and operator updates after confirmation", async () => {
    const { recorder, deps } = dependencies();

    await runUpdateCommand({ yes: false, dryRun: false }, deps);

    expect(recorder.box).toEqual(["sudo apt install gh -y", "claude update", "codex update", "install pnpm '11.17.0'"]);
    expect(recorder.local).toEqual(["claude update", "codex update"]);
  });

  test("--yes skips the prompt", async () => {
    let prompts = 0;
    const { recorder, deps } = dependencies({
      confirm: async () => {
        prompts += 1;
        return false;
      },
    });

    await runUpdateCommand({ yes: true, dryRun: false }, deps);

    expect(prompts).toBe(0);
    expect(recorder.box).toHaveLength(4);
  });

  test("never installs a tool that is missing on the operator machine, there or on the box", async () => {
    const { recorder, deps } = dependencies({ installed: [], localVersions: { "claude --version": "2.1.0" } });

    await runUpdateCommand({ yes: true, dryRun: false }, deps);

    expect(recorder.local).toEqual([]);
    expect(recorder.box).toEqual(["claude update", "codex update"]);
    expect(recorder.output).toContain("Operator claude: skipped, not installed");
    expect(recorder.output).toContain("Box gh: skipped, not on the operator machine (policy operator)");
    expect(recorder.output).toContain("Box pnpm: skipped, not on the operator machine (policy operator)");
  });

  test("uses the update recipe of a config tool when its box version differs", async () => {
    const { recorder, deps } = dependencies({ boxVersions: { ...BOX_VERSIONS, "node --version": "v24.15.0", "pnpm --version": "11.17.0" } });

    await runUpdateCommand({ yes: true, dryRun: false }, deps);

    expect(recorder.box).toContain("update node '24.16.0'");
    expect(recorder.output).toContain("Box pnpm: skipped, the box has 11.17.0 (policy operator)");
  });

  test("prints the output of an update after its step, such as the gh fallback warning", async () => {
    const { recorder, deps } = dependencies();
    const warning = "Warning: the GitHub apt repository has no gh 2.92.0. Ferry installs the latest gh.";

    await runUpdateCommand({ yes: true, dryRun: false }, {
      ...deps,
      createLink: (options) => {
        const link = deps.createLink!(options);
        return {
          run: async (command, runOptions) => {
            const result = await link.run(command, runOptions);
            return command === "sudo apt install gh -y" && result.ok ? { ...result, stdout: `${warning}\n` } : result;
          },
        };
      },
    });

    const at = recorder.output.indexOf(`  ${warning}`);
    expect(at).toBeGreaterThan(-1);
    expect(recorder.output[at + 1]).toBe("Updated box gh.");
  });

  test("a failed update does not stop the others and the command fails", async () => {
    const { recorder, deps } = dependencies({
      boxFails: ["claude update"],
      localFails: ["claude update"],
    });

    const run = runUpdateCommand({ yes: true, dryRun: false }, deps);

    await expect(run).rejects.toBeInstanceOf(UpdateError);
    await expect(run).rejects.toThrow("2 of 6 updates failed: box claude, operator claude");
    expect(recorder.box).toEqual(["sudo apt install gh -y", "claude update", "codex update", "install pnpm '11.17.0'"]);
    expect(recorder.local).toEqual(["claude update", "codex update"]);
    expect(recorder.output).toContain("Failed to update box claude: update refused");
    expect(recorder.output).toContain("Failed to update operator claude: no network");
    expect(recorder.output).toContain("Updated operator codex.");
  });

  test("a failed dependency skips the tools that depend on it", async () => {
    const { recorder, deps } = dependencies({
      boxVersions: { ...BOX_VERSIONS, "node --version": "v24.15.0" },
      boxFails: ["update node '24.16.0'"],
    });

    await expect(runUpdateCommand({ yes: true, dryRun: false }, deps)).rejects.toThrow(
      "2 of 7 updates failed: box node, box pnpm",
    );
    expect(recorder.box).not.toContain("install pnpm '11.17.0'");
    expect(recorder.output).toContain("Skipped box pnpm: it depends on node, which failed.");
  });

  test("refuses the whole update when a tool to change depends on a tool that the operator machine lacks", async () => {
    const { recorder, deps } = dependencies({ localVersions: { ...LOCAL_VERSIONS, "node --version": "" } });

    await expect(runUpdateCommand({ yes: true, dryRun: false }, deps)).rejects.toThrow(
      "Update stopped before it changed anything. pnpm depends on node, which is not on the operator machine.",
    );
    expect(recorder.box).toEqual([]);
    expect(recorder.local).toEqual([]);
  });

  test("latestOnly updates only the tools whose policy is latest, on both sides", async () => {
    const { recorder, deps } = dependencies({ boxVersions: {} });

    await runUpdateCommand({ yes: true, dryRun: false, latestOnly: true }, {
      ...deps,
      readConfig: () => ({ ...config, tools: { codex: "0.156.1" } }),
    });

    expect(recorder.box).toEqual(["install claude"]);
    expect(recorder.local).toEqual(["claude update"]);
    expect(recorder.output.some((line) => /gh|codex|node|pnpm/.test(line))).toBe(false);
  });

  test("shows a counted step for each update and prints each result after its step", async () => {
    const { recorder, deps } = dependencies({ boxFails: ["claude update"] });
    const events = recorder.output;
    const progress = {
      ...noProgress,
      start: (step: string) => events.push(`start:${step}`),
      count: () => {},
      done: () => events.push("done"),
      fail: () => events.push("fail"),
    };

    await expect(runUpdateCommand({ yes: true, dryRun: false }, { ...deps, progress })).rejects.toThrow(
      "1 of 6 updates failed",
    );

    expect(events.slice(0, 2)).toEqual(["start:Checking the tool versions", "done"]);
    expect(events.slice(-18)).toEqual([
      "start:Updating box gh (1/6)",
      "done",
      "Updated box gh.",
      "start:Updating box claude (2/6)",
      "fail",
      "Failed to update box claude: update refused",
      "start:Updating box codex (3/6)",
      "done",
      "Updated box codex.",
      "start:Updating box pnpm (4/6)",
      "done",
      "Updated box pnpm.",
      "start:Updating operator claude (5/6)",
      "done",
      "Updated operator claude.",
      "start:Updating operator codex (6/6)",
      "done",
      "Updated operator codex.",
    ]);
  });

  test("refuses to run without a complete host", async () => {
    const { deps } = dependencies();

    await expect(
      runUpdateCommand({ yes: true, dryRun: false }, { ...deps, readConfig: () => null }),
    ).rejects.toThrow("Ferry config has no complete host. Run ferry init.");
  });
});

describe("update command registry", () => {
  test("without a tool list, it reads the builtin tools and the [tools.<id>] tables of the config", async () => {
    const { recorder, deps } = dependencies();
    const { tools: _injected, ...rest } = deps;

    await runUpdateCommand(
      { yes: true, dryRun: true },
      {
        ...rest,
        readConfig: () => ({ ...config, tools: { aider: { local: "aider --version", install: "install aider" } } }),
      },
    );

    expect(recorder.output).toContain("Box claude: update latest (policy latest): claude update");
    expect(recorder.output).toContain("Box aider: skipped, not on the operator machine (policy operator)");
    expect(recorder.output).toContain("Operator aider: skipped, no own update command");
  });

  test("refuses a config whose [tools.<id>] tables the registry refuses", async () => {
    const { deps } = dependencies();
    const { tools: _injected, ...rest } = deps;

    await expect(
      runUpdateCommand(
        { yes: true, dryRun: true },
        { ...rest, readConfig: () => ({ ...config, tools: { claude: { local: "claude --version", install: "x" } } }) },
      ),
    ).rejects.toThrow("ferry refused the registry: tool claude is built in.");
  });
});

describe("update command with integrations", () => {
  /** A Paseo stand-in that records its update calls. */
  function fakePaseo(calls: string[], fail = false): Integration {
    return {
      ...createPaseo({ platform: "win32" }),
      plan: async (action) => [`${action} commands`],
      update: async () => {
        calls.push("paseo update");
        if (fail) throw new Error("restart failed");
        return ["Paseo 0.9.2 runs on the box."];
      },
    };
  }

  const enabled = { ...config, integrations: { paseo: true } };

  test("updates an enabled integration after the tools when the caller includes the integrations", async () => {
    const { recorder, deps } = dependencies();
    const calls: string[] = [];

    await runUpdateCommand(
      { yes: true, dryRun: false, includeIntegrations: true },
      { ...deps, readConfig: () => enabled, integrations: [fakePaseo(calls)] },
    );

    expect(calls).toEqual(["paseo update"]);
    expect(recorder.output).toContain("Box paseo:");
    expect(recorder.output).toContain("  update commands");
    expect(recorder.output.at(-1)).toBe("Paseo 0.9.2 runs on the box.");
  });

  test("skips the integrations by default, also when they are enabled", async () => {
    const { recorder, deps } = dependencies();
    const calls: string[] = [];

    await runUpdateCommand({ yes: true, dryRun: false }, { ...deps, readConfig: () => enabled, integrations: [fakePaseo(calls)] });

    expect(calls).toEqual([]);
    expect(recorder.output.some((line) => line.includes("paseo"))).toBe(false);
  });

  test("skips a disabled integration", async () => {
    const { deps } = dependencies();
    const calls: string[] = [];

    await runUpdateCommand(
      { yes: true, dryRun: false, includeIntegrations: true },
      { ...deps, integrations: [fakePaseo(calls)] },
    );

    expect(calls).toEqual([]);
  });

  test("a failed integration update fails the command", async () => {
    const { recorder, deps } = dependencies();

    await expect(
      runUpdateCommand(
        { yes: true, dryRun: false, includeIntegrations: true },
        { ...deps, readConfig: () => enabled, integrations: [fakePaseo([], true)] },
      ),
    ).rejects.toThrow("1 of 7 updates failed: box paseo");
    expect(recorder.output).toContain("Failed to update box paseo: restart failed");
  });

  test("dry run prints the integration plan and updates nothing", async () => {
    const { recorder, deps } = dependencies();
    const calls: string[] = [];

    await runUpdateCommand(
      { yes: false, dryRun: true, includeIntegrations: true },
      { ...deps, readConfig: () => enabled, integrations: [fakePaseo(calls)] },
    );

    expect(calls).toEqual([]);
    expect(recorder.box).toEqual([]);
    expect(recorder.output.slice(-2)).toEqual(["Box paseo:", "  update commands"]);
  });
});
