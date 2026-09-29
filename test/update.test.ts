import { describe, expect, test } from "bun:test";
import { createPaseo } from "../src/integrations/paseo.ts";
import type { BoxIntegration, Integration } from "../src/integrations/types.ts";
import type { PartialOperatorConfig } from "../src/config.ts";
import type { HostCommand, HostCommandResult, LinkOptions, LinkResult } from "../src/link.ts";
import { BOX_FERRY_VERSION_COMMAND, boxFerryInstallCommand } from "../src/box-ferry.ts";
import { noProgress } from "../src/progress.ts";
import { BUILTIN_TOOLS } from "../src/registry/builtin.ts";
import type { ToolDescriptor } from "../src/registry/types.ts";
import { planTools } from "../src/tools/resolve.ts";
import {
  planOperator,
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
    readonly installedPaths?: Readonly<Record<string, string>>;
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
          // The reach check of each box before its plan.
          if (command === "true") return { ok: true, address: "100.64.0.1", stdout: "", stderr: "" };
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
          const probe = /command -v '?([^')\s]+)'?/.exec(script);
          if (probe) {
            const found = installed.includes(probe[1] ?? "");
            const path = options.installedPaths?.[probe[1] ?? ""] ?? `/usr/local/bin/${probe[1]}`;
            return { exitCode: found ? 0 : 1, stdout: found ? `${path}\n` : "", stderr: "", timedOut: false };
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
  "Box ferry: skipped, this Ferry is a development build without a release version (policy operator)",
  "Operator gh: skipped, no own update command",
  "Operator claude: claude update",
  "Operator codex: codex update",
  "Operator pnpm: skipped, no own update command",
  "Operator node: skipped, no own update command",
];

describe("update plan", () => {
  test("plans the box by version in depends order and updates only the installed agent CLIs on the operator machine", async () => {
    const { recorder, deps } = dependencies({ installed: ["claude"] });

    const plan = {
      box: await planTools("update", tools, undefined, deps.local!, deps.createLink!(config.host as never)),
      operator: await planOperator(tools, deps.local!),
    };

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
      codex: {
        command: "codex update",
        binary: "codex",
        operatorSkip: { pathIncludes: ".app/Contents/Resources/", reason: "bundled with the Codex app" },
      },
      pi: { command: "pi update", binary: "pi" },
      cursor: { command: "cursor-agent update", binary: "cursor-agent" },
    });
  });

  test("skips the Codex CLI bundled with the macOS app", async () => {
    const codex = BUILTIN_TOOLS.find((tool) => tool.id === "codex")!;
    const { deps } = dependencies({
      installed: ["codex"],
      installedPaths: { codex: "/Applications/Codex.app/Contents/Resources/codex" },
    });

    await expect(planOperator([codex], deps.local!)).resolves.toEqual([
      { tool: "codex", reason: "bundled with the Codex app" },
    ]);
  });

  test("removes CODEX_HOME when the operator Codex is the default standalone install", async () => {
    const codex = BUILTIN_TOOLS.find((tool) => tool.id === "codex")!;
    const previousHome = process.env.HOME;
    process.env.HOME = "/home/user";
    try {
      const { deps } = dependencies({
        installed: ["codex"],
        installedPaths: { codex: "/home/user/.codex/packages/standalone/releases/0.156.1/bin/codex" },
      });

      await expect(planOperator([codex], deps.local!)).resolves.toEqual([
        { tool: "codex", command: "env -u CODEX_HOME codex update" },
      ]);
    } finally {
      process.env.HOME = previousHome;
    }
  });

  test.each(["/opt/homebrew/bin/codex", "/home/user/.local/lib/node_modules/@openai/codex/bin/codex.js"])(
    "keeps the plain Codex update for %s",
    async (path) => {
      const codex = BUILTIN_TOOLS.find((tool) => tool.id === "codex")!;
      const { deps } = dependencies({ installed: ["codex"], installedPaths: { codex: path } });

      await expect(planOperator([codex], deps.local!)).resolves.toEqual([
        { tool: "codex", command: "codex update" },
      ]);
    },
  );
});

describe("update command", () => {
  test("keeps Ferry on the box at the version of this Ferry, and the latestOnly update leaves it", async () => {
    const run = async (latestOnly: boolean) => {
      const { recorder, deps } = dependencies();
      const inner = deps.createLink!({ destination: "box.example" });
      const withFerry = {
        ...deps,
        ferryVersion: "1.2.3",
        createLink: () => ({
          run: async (command: string): Promise<LinkResult> =>
            command === BOX_FERRY_VERSION_COMMAND
              ? { ok: true, address: "100.64.0.1", stdout: "1.2.0\n", stderr: "" }
              : inner.run(command),
        }),
      };
      await runUpdateCommand({ yes: true, dryRun: false, latestOnly }, withFerry);
      return recorder;
    };

    const full = await run(false);
    expect(full.output).toContain(`Box ferry: update 1.2.3 (policy operator): ${boxFerryInstallCommand("1.2.3")}`);
    expect(full.box).toContain(boxFerryInstallCommand("1.2.3"));
    expect(full.output).toContain("Updated box ferry.");

    const latest = await run(true);
    expect(latest.output.some((line) => line.includes("ferry:") || line.startsWith("Box ferry"))).toBe(false);
    expect(latest.box).not.toContain(boxFerryInstallCommand("1.2.3"));
  });

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

    const result = await runUpdateCommand({ yes: false, dryRun: true }, deps);

    expect(recorder.output).toEqual(PLAN);
    expect(prompts).toBe(0);
    expect(result?.dryRun).toBe(true);
    expect(result?.updated).toEqual([]);
    expect(result?.boxes.map((box) => [box.name, box.offline, box.plan.map((entry) => `${entry.tool} ${entry.action}`)])).toEqual([
      ["default", null, expect.arrayContaining(["gh update", "claude update"])],
    ]);
    expect(recorder.box).toEqual([]);
    expect(recorder.local).toEqual([]);
  });

  test("runs the box and operator updates after confirmation", async () => {
    const { recorder, deps } = dependencies();

    const result = await runUpdateCommand({ yes: false, dryRun: false }, deps);

    expect(recorder.box).toEqual(["sudo apt install gh -y", "claude update", "codex update", "install pnpm '11.17.0'"]);
    expect(result?.updated).toEqual(["box gh", "box claude", "box codex", "box pnpm", "operator claude", "operator codex"]);
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
    const error = (await run.catch((caught: unknown) => caught)) as UpdateError;
    expect(error.result?.failed).toEqual(["box claude", "operator claude"]);
    expect(error.result?.boxes.map(({ name, ok, error }) => ({ name, ok, error }))).toEqual([
      {
        name: "default",
        ok: false,
        error: { code: "update-failed", message: "1 update failed on box default: box claude", hint: null },
      },
    ]);
    expect(error.result?.updated).toContain("operator codex");
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

  test("an offline [host] box fails the command after the operator updates, with no prefix", async () => {
    const { recorder, deps } = dependencies();
    const createLink = () => ({
      run: async (): Promise<LinkResult> => ({
        ok: false,
        error: { code: "host-offline", origin: "network", message: "the box is offline" },
      }),
    });

    const run = runUpdateCommand({ yes: true, dryRun: false }, { ...deps, createLink });
    await expect(run).rejects.toThrow("1 of 3 updates failed: box offline");
    const error = (await run.catch((caught: unknown) => caught)) as UpdateError;
    expect(error.result?.boxes[0]).toMatchObject({
      name: "default",
      ok: false,
      offline: "the box is offline",
      error: { code: "box-offline", message: "network/host-offline: the box is offline" },
    });
    expect(recorder.local).toEqual(["claude update", "codex update"]);
    expect(recorder.output[0]).toBe("Box offline, Ferry skips it: the box is offline");
    expect(recorder.output.some((line) => line.startsWith("Box default:"))).toBe(false);
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
  function fakePaseo(calls: string[], fail = false): BoxIntegration {
    const paseo = createPaseo({ platform: "win32" });
    return {
      ...paseo,
      box: {
        ...paseo.box,
        plan: async (action) => [`${action} commands`],
        update: async () => {
          calls.push("paseo update");
          if (fail) throw new Error("restart failed");
          return ["Paseo 0.9.2 runs on the box."];
        },
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

  test("dry run gives the box link to the integration update plan", async () => {
    const { recorder, deps } = dependencies();
    const actions: string[] = [];
    const fake = fakePaseo([]);
    const paseo: Integration = {
      ...fake,
      box: {
        ...fake.box,
        plan: async (action, link) => {
          actions.push(`${action} ${link === undefined ? "offline" : "with link"}`);
          return [];
        },
      },
    };

    await runUpdateCommand(
      { yes: false, dryRun: true, includeIntegrations: true },
      { ...deps, readConfig: () => enabled, integrations: [paseo] },
    );

    expect(actions).toEqual(["update with link"]);
    expect(recorder.box).toEqual([]);
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

describe("update command across boxes", () => {
  const boxes: PartialOperatorConfig = {
    version: 1,
    publisher: "operator",
    snapshotUrl: "git@example.com:snapshot.git",
    integrations: { paseo: true },
    boxes: [
      { name: "a", host: { transport: "ssh", destination: "dev@box-a.example" } },
      { name: "b", host: { transport: "ssh", destination: "dev@box-b.example" }, integrations: { paseo: false } },
    ],
  };

  /** The dependencies with one fake link per box. Each box command is recorded as `<destination>: <command>`. */
  function boxDependencies(offline: readonly string[] = []) {
    const { recorder, deps } = dependencies();
    const onBoxes: string[] = [];
    const paseo: string[] = [];
    const createLink = (options: LinkOptions) => {
      const destination = "destination" in options ? options.destination : `${options.user}@${options.host}`;
      const inner = deps.createLink!(options);
      return {
        destination,
        run: async (command: string, runOptions?: { timeoutMs?: number }): Promise<LinkResult> => {
          if (offline.includes(destination)) {
            return { ok: false, error: { code: "host-offline", origin: "network", message: `${destination} is offline` } };
          }
          const before = recorder.box.length;
          const result = await inner.run(command, runOptions);
          if (recorder.box.length > before) onBoxes.push(`${destination}: ${recorder.box.pop()}`);
          return result;
        },
      };
    };
    const base = createPaseo({ platform: "win32" });
    const integration: Integration = {
      ...base,
      box: {
        ...base.box,
        plan: async (action) => [`${action} commands`],
        update: async (link) => {
          paseo.push((link as unknown as { destination: string }).destination);
          return ["Paseo 0.9.2 runs on the box."];
        },
      },
    };
    return {
      recorder,
      onBoxes,
      paseo,
      deps: { ...deps, readConfig: () => boxes, createLink, integrations: [integration] } as Partial<UpdateCommandDependencies>,
    };
  }

  const BOX_COMMANDS = ["sudo apt install gh -y", "claude update", "codex update", "install pnpm '11.17.0'"];

  test("updates each box and runs the operator part once", async () => {
    const { recorder, onBoxes, deps } = boxDependencies();

    await runUpdateCommand({ yes: true, dryRun: false }, deps);

    expect(onBoxes).toEqual([
      ...BOX_COMMANDS.map((command) => `dev@box-a.example: ${command}`),
      ...BOX_COMMANDS.map((command) => `dev@box-b.example: ${command}`),
    ]);
    expect(recorder.local).toEqual(["claude update", "codex update"]);
    expect(recorder.output).toContain("[a] Box gh: update 2.92.0 (policy operator): sudo apt install gh -y");
    expect(recorder.output).toContain("[b] Box gh: update 2.92.0 (policy operator): sudo apt install gh -y");
    expect(recorder.output).toContain("Updated [b] box gh.");
    expect(recorder.output.filter((line) => line.startsWith("Operator claude"))).toEqual(["Operator claude: claude update"]);
    expect(recorder.output.slice(-2)).toEqual(["Box a: done.", "Box b: done."]);
  });

  test("an offline box does not stop the other box or the operator part, and the command fails", async () => {
    const { recorder, onBoxes, deps } = boxDependencies(["dev@box-a.example"]);

    await expect(runUpdateCommand({ yes: true, dryRun: false }, deps)).rejects.toThrow(
      "1 of 7 updates failed: [a] box offline",
    );

    expect(onBoxes).toEqual(BOX_COMMANDS.map((command) => `dev@box-b.example: ${command}`));
    expect(recorder.local).toEqual(["claude update", "codex update"]);
    expect(recorder.output).toContain("[a] Box offline, Ferry skips it: dev@box-a.example is offline");
    expect(recorder.output.slice(-2)).toEqual(["Box a: failed, the box is offline.", "Box b: done."]);
  });

  test("a failed update on one box names the box in the report", async () => {
    const { recorder, deps } = boxDependencies();
    const failing = deps.createLink!;
    const createLink = (options: LinkOptions) => {
      const link = failing(options);
      return {
        run: async (command: string, runOptions?: { timeoutMs?: number }): Promise<LinkResult> =>
          "destination" in options && options.destination === "dev@box-b.example" && command === "claude update"
            ? { ok: false, error: { code: "command-failed", origin: "box", message: "update refused" } }
            : link.run(command, runOptions),
      };
    };

    await expect(runUpdateCommand({ yes: true, dryRun: false }, { ...deps, createLink })).rejects.toThrow(
      "1 of 10 updates failed: [b] box claude",
    );
    expect(recorder.output.slice(-2)).toEqual(["Box a: done.", "Box b: failed, 1 update failed."]);
  });

  test("updates Paseo only on the boxes where it is enabled", async () => {
    const { recorder, paseo, deps } = boxDependencies();

    await runUpdateCommand({ yes: true, dryRun: false, includeIntegrations: true }, deps);

    expect(paseo).toEqual(["dev@box-a.example"]);
    expect(recorder.output).toContain("[a] Box paseo:");
    expect(recorder.output).not.toContain("[b] Box paseo:");
    expect(recorder.output).toContain("[a] Paseo 0.9.2 runs on the box.");
  });

  test("a box override turns Paseo on for that box only", async () => {
    const { paseo, deps } = boxDependencies();
    const override: PartialOperatorConfig = {
      ...boxes,
      integrations: { paseo: false },
      boxes: [boxes.boxes![0]!, { ...boxes.boxes![1]!, integrations: { paseo: true } }],
    };

    await runUpdateCommand({ yes: true, dryRun: false, includeIntegrations: true }, { ...deps, readConfig: () => override });

    expect(paseo).toEqual(["dev@box-b.example"]);
  });

  test("uses the tool policy of each box", async () => {
    const { onBoxes, deps } = boxDependencies();
    const pinned: PartialOperatorConfig = {
      ...boxes,
      boxes: [boxes.boxes![0]!, { ...boxes.boxes![1]!, tools: { codex: "0.150.0" } }],
    };

    await runUpdateCommand({ yes: true, dryRun: false }, { ...deps, readConfig: () => pinned });

    expect(onBoxes).toContain("dev@box-a.example: codex update");
    expect(onBoxes).not.toContain("dev@box-b.example: codex update");
  });

  test("an off tool is skipped on the box where it is off, and a box can turn it on again", async () => {
    const { recorder, onBoxes, deps } = boxDependencies();
    const off: PartialOperatorConfig = {
      ...boxes,
      tools: { codex: "off", gh: "off" },
      boxes: [boxes.boxes![0]!, { ...boxes.boxes![1]!, tools: { codex: "latest" } }],
    };

    const result = await runUpdateCommand({ yes: true, dryRun: false }, { ...deps, readConfig: () => off });

    expect(onBoxes).toEqual([
      "dev@box-a.example: claude update",
      "dev@box-a.example: install pnpm '11.17.0'",
      "dev@box-b.example: claude update",
      "dev@box-b.example: codex update",
      "dev@box-b.example: install pnpm '11.17.0'",
    ]);
    expect(recorder.output).toContain("[a] Box codex: skipped, Ferry does not manage it (policy off)");
    expect(recorder.output).toContain("[a] Box gh: skipped, Ferry does not manage it (policy off)");
    expect(recorder.output).toContain("[b] Box codex: update latest (policy latest): codex update");
    // The operator machine follows [tools], where codex is off.
    expect(recorder.local).toEqual(["claude update"]);
    expect(recorder.output).toContain("Operator codex: skipped, off");
    expect(result?.boxes[0]?.plan.find((step) => step.tool === "codex")).toEqual({
      tool: "codex",
      policy: "off",
      version: null,
      action: "skip-off",
      dependsOn: [],
    });
    expect(result?.operator).toContainEqual({ tool: "codex", reason: "off" });
  });

  test("the watch update (latestOnly) skips an off tool", async () => {
    const { recorder, onBoxes, deps } = boxDependencies();
    const off: PartialOperatorConfig = { ...boxes, tools: { claude: "off" } };

    await runUpdateCommand({ yes: true, dryRun: false, latestOnly: true }, { ...deps, readConfig: () => off });

    expect(onBoxes).toEqual(["dev@box-a.example: codex update", "dev@box-b.example: codex update"]);
    expect(recorder.local).toEqual(["codex update"]);
    expect(recorder.output.some((line) => line.includes("claude"))).toBe(false);
  });

  test("--box selects the boxes, and one selected box gets no prefix", async () => {
    const { recorder, onBoxes, deps } = boxDependencies();

    await runUpdateCommand({ yes: true, dryRun: false, boxes: ["b"] }, deps);

    expect(onBoxes).toEqual(BOX_COMMANDS.map((command) => `dev@box-b.example: ${command}`));
    expect(recorder.output).toContain("Box gh: update 2.92.0 (policy operator): sudo apt install gh -y");
    expect(recorder.output.some((line) => line.startsWith("Box b:"))).toBe(false);
  });

  test("refuses an unknown box", async () => {
    const { deps } = boxDependencies();

    await expect(runUpdateCommand({ yes: true, dryRun: true, boxes: ["c"] }, deps)).rejects.toThrow(
      "unknown box c. Known boxes: a, b.",
    );
  });

  test("dry run lists the plan of each box and changes nothing", async () => {
    const { recorder, onBoxes, deps } = boxDependencies(["dev@box-b.example"]);

    await runUpdateCommand({ yes: false, dryRun: true }, deps);

    expect(onBoxes).toEqual([]);
    expect(recorder.local).toEqual([]);
    expect(recorder.output).toContain("[a] Box claude: update latest (policy latest): claude update");
    expect(recorder.output).toContain("[b] Box offline, Ferry skips it: dev@box-b.example is offline");
  });
});
