import { describe, expect, test } from "bun:test";
import type { HostAdapter, HostCommand, HostCommandResult, LinkResult } from "../src/link.ts";
import type { ToolDescriptor } from "../src/registry/types.ts";
import { describeStep, effectivePolicy, planTools, resolveToolVersion, ToolPlanError } from "../src/tools/resolve.ts";

const PREFIX_END = 'cd "$HOME" || exit 1; ';

/** A fake operator machine. Each key is a version command, each value its output. Other commands fail. */
function fakeLocal(outputs: Readonly<Record<string, string>>): HostAdapter & { readonly scripts: string[] } {
  const scripts: string[] = [];
  return {
    scripts,
    run: async (command: HostCommand): Promise<HostCommandResult> => {
      const script = command.argv.at(-1) ?? "";
      const versionCommand = script.slice(script.indexOf(PREFIX_END) + PREFIX_END.length);
      scripts.push(versionCommand);
      const stdout = outputs[versionCommand];
      if (stdout === undefined) return { exitCode: 127, stdout: "", stderr: "not found", timedOut: false };
      return { exitCode: 0, stdout, stderr: "", timedOut: false };
    },
  };
}

/** A fake box with the same rules. */
function fakeBox(outputs: Readonly<Record<string, string>>): { run: (command: string) => Promise<LinkResult>; commands: string[] } {
  const commands: string[] = [];
  return {
    commands,
    run: async (command: string): Promise<LinkResult> => {
      const versionCommand = command.slice(command.indexOf(PREFIX_END) + PREFIX_END.length);
      commands.push(versionCommand);
      const stdout = outputs[versionCommand];
      if (stdout === undefined) {
        return { ok: false, error: { code: "command-failed", origin: "box", message: "not found" } };
      }
      return { ok: true, address: "box", stdout, stderr: "" };
    },
  };
}

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

const agent: ToolDescriptor = {
  id: "claude",
  kind: "agent",
  localVersion: "claude --version",
  boxVersion: "claude --version",
  install: { command: "install claude latest" },
  update: { command: "claude update", binary: "claude" },
};

const gh: ToolDescriptor = {
  id: "gh",
  kind: "tool",
  localVersion: "gh --version",
  boxVersion: "gh --version",
  install: { command: "install gh latest" },
  update: { command: "update gh latest" },
};

describe("effectivePolicy", () => {
  test("uses the config policy, else the default of the kind", () => {
    expect(effectivePolicy(agent, undefined)).toBe("latest");
    expect(effectivePolicy(gh, undefined)).toBe("operator");
    expect(effectivePolicy(gh, { gh: "latest" })).toBe("latest");
    expect(effectivePolicy(configTool("bun"), { bun: { local: "x", install: "y", version: "1.4.2" } })).toBe("1.4.2");
  });
});

describe("resolveToolVersion", () => {
  test("operator: the version on the operator machine", async () => {
    const resolved = await resolveToolVersion(configTool("bun"), undefined, fakeLocal({ "bun --version": "1.4.2\n" }));
    expect(resolved).toEqual({ kind: "version", policy: "operator", version: "1.4.2" });
  });

  test("operator under mirror mode: a tool that the operator machine lacks is skipped", async () => {
    const resolved = await resolveToolVersion(configTool("bun"), undefined, fakeLocal({}));
    expect(resolved).toEqual({ kind: "skip", policy: "operator", reason: "not on the operator machine" });
  });

  test("operator under always mode: a missing tool falls back to the latest recipe", async () => {
    const resolved = await resolveToolVersion(agent, { claude: "operator" }, fakeLocal({}));
    expect(resolved).toEqual({ kind: "version", policy: "operator", version: null });
  });

  test("latest: a builtin tool uses its latest recipe and reads nothing", async () => {
    const local = fakeLocal({ "claude --version": "2.1.0" });
    const resolved = await resolveToolVersion(agent, undefined, local);
    expect(resolved).toEqual({ kind: "version", policy: "latest", version: null });
    expect(local.scripts).toEqual([]);
  });

  test("latest: a config tool runs its latest command on the operator machine", async () => {
    const tool = configTool("pnpm", { latestVersion: "npm view pnpm version" });
    const resolved = await resolveToolVersion(tool, { pnpm: { local: "x", install: "y", version: "latest" } }, fakeLocal({
      "npm view pnpm version": "11.18.0\n",
    }));
    expect(resolved).toEqual({ kind: "version", policy: "latest", version: "11.18.0" });
  });

  test("latest: a config tool without a latest command is refused", async () => {
    const resolved = await resolveToolVersion(configTool("pnpm"), { pnpm: { local: "x", install: "y", version: "latest" } }, fakeLocal({}));
    expect(resolved).toEqual({
      kind: "refused",
      policy: "latest",
      reason: 'pnpm has the policy "latest" but no latest command. Add latest = "<command that prints the newest version>" to [tools.pnpm], or use another policy.',
    });
  });

  test("latest: a latest command that prints no version is refused", async () => {
    const tool = configTool("pnpm", { latestVersion: "npm view pnpm version" });
    const resolved = await resolveToolVersion(tool, { pnpm: { local: "x", install: "y", version: "latest" } }, fakeLocal({}));
    expect(resolved).toEqual({
      kind: "refused",
      policy: "latest",
      reason: "the latest command of pnpm printed no version on this machine: npm view pnpm version",
    });
  });

  test("exact version: that version, without a read on the operator machine", async () => {
    const local = fakeLocal({});
    const resolved = await resolveToolVersion(configTool("bun"), { bun: { local: "x", install: "y", version: "1.3.0" } }, local);
    expect(resolved).toEqual({ kind: "version", policy: "1.3.0", version: "1.3.0" });
    expect(local.scripts).toEqual([]);
  });
});

describe("planTools", () => {
  test("orders the tools so that each dependency comes first", async () => {
    const tools = [
      configTool("pnpm", { dependsOn: ["node"] }),
      configTool("typescript", { dependsOn: ["pnpm", "node"] }),
      configTool("node"),
    ];
    const local = fakeLocal({ "node --version": "v24.16.0", "pnpm --version": "11.17.0", "typescript --version": "Version 6.0.2" });

    const plan = await planTools("install", tools, undefined, local, fakeBox({}));

    expect(plan.map((step) => [step.tool, step.action, step.command])).toEqual([
      ["node", "install", "install node '24.16.0'"],
      ["pnpm", "install", "install pnpm '11.17.0'"],
      ["typescript", "install", "install typescript '6.0.2'"],
    ]);
  });

  test("skips a tool whose box version equals the resolved version", async () => {
    const box = fakeBox({ "bun --version": "1.4.2\n" });

    const plan = await planTools("install", [configTool("bun")], undefined, fakeLocal({ "bun --version": "1.4.2" }), box);

    expect(plan).toEqual([
      { tool: "bun", policy: "operator", version: "1.4.2", action: "skip-same", dependsOn: [] },
    ]);
  });

  test("marks a mirror tool that the operator machine lacks and reads nothing on the box", async () => {
    const box = fakeBox({});

    const plan = await planTools("install", [configTool("bun")], undefined, fakeLocal({}), box);

    expect(plan).toEqual([
      { tool: "bun", policy: "operator", version: null, action: "skip-not-on-operator", dependsOn: [] },
    ]);
    expect(box.commands).toEqual([]);
  });

  test("an agent CLI keeps its latest recipe, also for an operator version", async () => {
    const plan = await planTools(
      "install",
      [agent],
      { claude: "operator" },
      fakeLocal({ "claude --version": "2.1.0" }),
      fakeBox({ "claude --version": "2.0.9" }),
    );

    expect(plan).toEqual([
      { tool: "claude", policy: "operator", version: "2.1.0", action: "install", command: "install claude latest", dependsOn: [] },
    ]);
  });

  test("uses the version recipe of a builtin tool when it has one", async () => {
    const pinned = { ...gh, recipe: { install: fill("install gh {version}"), update: fill("update gh {version}") } };

    const plan = await planTools("install", [pinned], undefined, fakeLocal({ "gh --version": "gh version 2.92.0" }), fakeBox({}));

    expect(plan[0]?.command).toBe("install gh '2.92.0'");
  });

  test("refuses when a tool to install depends on a tool that the operator machine lacks", async () => {
    const tools = [configTool("node"), configTool("pnpm", { dependsOn: ["node"] })];

    await expect(
      planTools("install", tools, undefined, fakeLocal({ "pnpm --version": "11.17.0" }), fakeBox({})),
    ).rejects.toThrow(
      new ToolPlanError(
        "pnpm depends on node, which is not on the operator machine. Install node on this machine, or remove node from depends of pnpm.",
      ),
    );
  });

  test("accepts a skipped dependency when the dependent is skipped too", async () => {
    const tools = [configTool("node"), configTool("pnpm", { dependsOn: ["node"] })];

    const plan = await planTools("install", tools, undefined, fakeLocal({}), fakeBox({}));

    expect(plan.map((step) => step.action)).toEqual(["skip-not-on-operator", "skip-not-on-operator"]);
  });

  test("refuses the plan and names every refused tool", async () => {
    const tools = [configTool("pnpm"), configTool("bun")];
    const latest = { local: "x", install: "y", version: "latest" };

    await expect(
      planTools("install", tools, { pnpm: latest, bun: latest }, fakeLocal({}), fakeBox({})),
    ).rejects.toThrow('pnpm has the policy "latest" but no latest command.');
  });

  test("update: runs the update recipe when the box version differs", async () => {
    const plan = await planTools(
      "update",
      [configTool("bun")],
      undefined,
      fakeLocal({ "bun --version": "1.4.2" }),
      fakeBox({ "bun --version": "1.4.1" }),
    );

    expect(plan).toEqual([
      { tool: "bun", policy: "operator", version: "1.4.2", action: "update", command: "update bun '1.4.2'", dependsOn: [] },
    ]);
  });

  test("update: installs a tool that the box lacks", async () => {
    const plan = await planTools("update", [configTool("bun")], undefined, fakeLocal({ "bun --version": "1.4.2" }), fakeBox({}));

    expect(plan[0]).toMatchObject({ action: "install", command: "install bun '1.4.2'" });
  });

  test("update: a builtin tool without a version recipe uses its update command", async () => {
    const plan = await planTools("update", [agent], undefined, fakeLocal({}), fakeBox({ "claude --version": "2.0.9" }));

    expect(plan[0]).toMatchObject({ version: null, action: "update", command: "claude update" });
  });

  test("a tool without a box version command is never skipped as the same", async () => {
    const tool = configTool("bun", { boxVersion: undefined });

    const plan = await planTools("install", [tool], undefined, fakeLocal({ "bun --version": "1.4.2" }), fakeBox({}));

    expect(plan[0]?.action).toBe("install");
  });
});

describe('the "off" policy', () => {
  test("install and update skip an off tool and read neither machine", async () => {
    for (const purpose of ["install", "update"] as const) {
      const local = fakeLocal({ "claude --version": "2.1.0" });
      const box = fakeBox({ "claude --version": "2.0.9" });

      const plan = await planTools(purpose, [agent, gh], { claude: "off", gh: "off" }, local, box);

      expect(plan).toEqual([
        { tool: "claude", policy: "off", version: null, action: "skip-off", dependsOn: [] },
        { tool: "gh", policy: "off", version: null, action: "skip-off", dependsOn: [] },
      ]);
      expect(local.scripts).toEqual([]);
      expect(box.commands).toEqual([]);
    }
  });

  test("refuses a tool to install that depends on an off tool", async () => {
    const tools = [gh, configTool("gh-dash", { dependsOn: ["gh"] })];

    await expect(
      planTools("install", tools, { gh: "off" }, fakeLocal({ "gh-dash --version": "4.0.0" }), fakeBox({})),
    ).rejects.toThrow(
      new ToolPlanError("gh-dash depends on gh, which is off. Set another policy for gh, or remove gh from depends of gh-dash."),
    );
  });

  test("describes the skip", () => {
    expect(describeStep({ tool: "pi", policy: "off", version: null, action: "skip-off", dependsOn: [] })).toBe(
      "skipped, Ferry does not manage it (policy off)",
    );
  });
});
