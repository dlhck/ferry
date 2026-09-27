import { describe, expect, test } from "bun:test";
import type { HostCommand, HostCommandResult, LinkResult } from "../src/link.ts";
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

const tools: readonly ToolDescriptor[] = [
  { id: "gh", update: { command: "sudo apt install gh -y" } },
  { id: "claude", update: { command: "claude update", binary: "claude" } },
  { id: "codex", update: { command: "codex update", binary: "codex" } },
  { id: "aider", install: { command: "install aider" } },
];

type Recorder = {
  readonly box: string[];
  readonly local: string[];
  readonly output: string[];
};

function dependencies(
  options: {
    readonly installed?: readonly string[];
    readonly confirm?: () => Promise<boolean | symbol | undefined>;
    readonly boxFails?: readonly string[];
    readonly localFails?: readonly string[];
  } = {},
): { recorder: Recorder; deps: Partial<UpdateCommandDependencies> } {
  const recorder: Recorder = { box: [], local: [], output: [] };
  const installed = options.installed ?? ["claude", "codex"];
  return {
    recorder,
    deps: {
      tools,
      readConfig: () => config,
      createLink: () => ({
        run: async (command: string): Promise<LinkResult> => {
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
  "Box gh: sudo apt install gh -y",
  "Box claude: claude update",
  "Box codex: codex update",
  "Box aider: skipped, no update command",
  "Operator gh: skipped, no own update command",
  "Operator claude: claude update",
  "Operator codex: codex update",
  "Operator aider: skipped, no update command",
];

describe("update plan", () => {
  test("lists every box update and only the installed operator tools", async () => {
    const { recorder, deps } = dependencies({ installed: ["claude"] });

    const plan = await planUpdate(tools, deps.local!);

    expect(plan.steps).toEqual([
      { target: "box", tool: "gh", command: "sudo apt install gh -y" },
      { target: "box", tool: "claude", command: "claude update" },
      { target: "box", tool: "codex", command: "codex update" },
      { target: "operator", tool: "claude", command: "claude update" },
    ]);
    expect(plan.skipped).toEqual([
      { target: "box", tool: "aider", reason: "no update command" },
      { target: "operator", tool: "gh", reason: "no own update command" },
      { target: "operator", tool: "codex", reason: "not installed" },
      { target: "operator", tool: "aider", reason: "no update command" },
    ]);
    expect(recorder.local).toEqual([]);
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

    expect(recorder.box).toEqual(["sudo apt install gh -y", "claude update", "codex update"]);
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
    expect(recorder.box).toHaveLength(3);
  });

  test("never installs a tool that is missing on the operator machine", async () => {
    const { recorder, deps } = dependencies({ installed: [] });

    await runUpdateCommand({ yes: true, dryRun: false }, deps);

    expect(recorder.local).toEqual([]);
    expect(recorder.output).toContain("Operator claude: skipped, not installed");
  });

  test("a failed update does not stop the others and the command fails", async () => {
    const { recorder, deps } = dependencies({
      boxFails: ["claude update"],
      localFails: ["claude update"],
    });

    const run = runUpdateCommand({ yes: true, dryRun: false }, deps);

    await expect(run).rejects.toBeInstanceOf(UpdateError);
    await expect(run).rejects.toThrow("2 of 5 updates failed: box claude, operator claude");
    expect(recorder.box).toEqual(["sudo apt install gh -y", "claude update", "codex update"]);
    expect(recorder.local).toEqual(["claude update", "codex update"]);
    expect(recorder.output).toContain("Failed to update box claude: update refused");
    expect(recorder.output).toContain("Failed to update operator claude: no network");
    expect(recorder.output).toContain("Updated operator codex.");
  });

  test("refuses to run without a complete host", async () => {
    const { deps } = dependencies();

    await expect(
      runUpdateCommand({ yes: true, dryRun: false }, { ...deps, readConfig: () => null }),
    ).rejects.toThrow("Ferry config has no complete host. Run ferry init.");
  });
});
