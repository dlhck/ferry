import { BOX_FERRY_VERSION_COMMAND } from "../src/box-ferry.ts";
import { describe, expect, test } from "bun:test";
import type { ApplyPlan, RemoteApplyInput } from "../src/apply.ts";
import type { AuthStatusReport } from "../src/auth-start.ts";
import { buildProgram } from "../src/cli.ts";
import { createPaseo } from "../src/integrations/paseo.ts";
import type { Integration, IntegrationHealth } from "../src/integrations/types.ts";
import type { LinkResult } from "../src/link.ts";
import { BUILTIN_TOOLS } from "../src/registry/builtin.ts";
import type { Registry } from "../src/registry/load.ts";
import type { ToolDescriptor } from "../src/registry/types.ts";
import type { TipReport } from "../src/store.ts";
import {
  formatBriefStatus,
  formatStatus,
  runBriefStatusCommand,
  runStatusCommand,
  type StatusCommandDependencies,
} from "../src/status-command.ts";
import { EXAMPLE_ID, operatorIntegration } from "./fake-integration.ts";
import { fakeTerminal, recordProgress } from "./fake-progress.ts";

const registry: Registry = {
  harnesses: [
    { id: "codex", name: "Codex", skillRoot: ".codex/skills" },
  ],
  tools: [
    { id: "gh", kind: "tool" },
    {
      id: "codex",
      auth: {
        probe: "codex login status",
        login: "codex login --device-auth",
        completion: { kind: "device-url", url: "https://auth.openai.com/codex/device" },
      },
    },
    {
      id: "pi",
      auth: {
        completion: {
          kind: "manual",
          command: "pi",
          instruction: "SSH to the box, run pi, then use /login.",
        },
      },
    },
  ],
};

const tips: TipReport = {
  local: "same-tip",
  remote: "same-tip",
  box: "same-tip",
  localMatchesRemote: true,
  remoteMatchesBox: true,
  allMatch: true,
};

const auth: AuthStatusReport = {
  providers: [
    { provider: "codex", status: "login-required" },
    {
      provider: "pi",
      status: "manual",
      instruction: "SSH to the box, run pi, then use /login.",
    },
  ],
};

type FakeStack = {
  readonly output: string[];
  readonly reads: string[];
  readonly mutations: string[];
  readonly dependencies: Partial<StatusCommandDependencies>;
};

function fakeStack(
  online = true,
  boxChanges = "",
  boxIdentity = "user.name Operator\nuser.email operator@example.com\n",
  boxSudo = "yes\n",
  updateWatch?: boolean,
  ghPolicy?: string,
): FakeStack {
  const output: string[] = [];
  const reads: string[] = [];
  const mutations: string[] = [];
  const link = {
    async run(command: string): Promise<LinkResult> {
      if (/\bgit (?:pull|fetch|push)\b/.test(command)) mutations.push("remote git mutation");
      reads.push(`link.run:${command}`);
      if (!online) {
        return {
          ok: false,
          error: {
            code: "host-offline",
            origin: "network",
            message: "Tailscale host box is offline",
          },
        };
      }
      return {
        ok: true,
        address: "100.64.0.8",
        stdout: command.startsWith("printf")
          ? "/box/home\n"
          : command.startsWith("sudo -n /usr/bin/true")
            ? boxSudo
            : command.includes(" status ")
            ? boxChanges
            : command.includes("--get-regexp")
              ? boxIdentity
              : "same-tip\n",
        stderr: "",
      };
    },
    async forward() {
      mutations.push("link.forward");
      throw new Error("unexpected forward");
    },
  };
  const store = {
    async inspectTips(boxTip: string | null) {
      reads.push("store.inspectTips");
      return { ...tips, box: boxTip, remoteMatchesBox: boxTip === tips.remote, allMatch: boxTip === tips.remote };
    },
    async publish() {
      mutations.push("store.publish");
    },
    async fetchTip() {
      mutations.push("store.fetchTip");
    },
    async clone() {
      mutations.push("store.clone");
    },
    async updateRefs() {
      mutations.push("store.updateRefs");
    },
  };

  const dependencies = {
    readConfig: () => {
      reads.push("config.read");
      return {
        version: 1 as const,
        host: { tailscale: "box", sshUser: "ferry" },
        harness: [{ id: "custom" }],
        ...(updateWatch === undefined ? {} : { update: { watch: updateWatch } }),
        ...(ghPolicy === undefined ? {} : { tools: { gh: ghPolicy } }),
      };
    },
    loadRegistry: (config: Parameters<StatusCommandDependencies["loadRegistry"]>[0]) => {
      reads.push("registry.load");
      expect(config.harness).toEqual([{ id: "custom" }]);
      return { ok: true as const, ...registry };
    },
    home: () => "/operator/home",
    createLink: () => link,
    createStore: () => store,
    readOperatorGitIdentity: async (home: string) => {
      reads.push(`operator.gitIdentity:${home}`);
      return { name: "Operator", email: "operator@example.com" };
    },
    inspectApply: async (input: RemoteApplyInput): Promise<ApplyPlan> => {
      reads.push("apply.inspect");
      if (input.dryRun !== true) mutations.push("apply.commit");
      expect(input.dryRun).toBe(true);
      expect(input.harnesses).toEqual(registry.harnesses);
      return {
        checkout: input.checkout,
        targetHome: input.targetHome,
        actions: [
          {
            kind: "repair-symlink" as const,
            harness: "Codex",
            path: "/box/home/.codex/skills/tdd",
            target: "/box/home/.ferry/store/skills/tdd",
          },
        ],
        unmanaged: [],
      };
    },
    createAuthStart: (_link: unknown, tools: readonly ToolDescriptor[]) => {
      expect(tools).toEqual(registry.tools);
      return {
        async status() {
          reads.push("auth.status");
          return auth;
        },
        async mcpStatus() {
          reads.push("auth.mcpStatus");
          return [{ tool: "codex", loginRequired: ["linear"] }];
        },
        async start() {
          mutations.push("auth.start");
        },
      };
    },
    denyRules: () => {
      reads.push("manifest.denyRules");
      return [{ code: "dotenv", description: "environment file", behavior: "refuse" as const }];
    },
    writeConfig: () => mutations.push("config.write"),
    acquireSyncLock: () => mutations.push("sync.lock"),
  };

  return {
    output,
    reads,
    mutations,
    dependencies,
  };
}

/** Run the status command and record the report as the CLI prints it: text, or with `json`, the report JSON. */
async function status(
  stack: { readonly output: string[]; readonly dependencies: Partial<StatusCommandDependencies> },
  json = false,
  dependencies: Partial<StatusCommandDependencies> = stack.dependencies,
) {
  const report = await runStatusCommand({}, dependencies);
  stack.output.push(json ? JSON.stringify(report) : formatStatus(report));
  return report;
}

describe("ferry status command", () => {
  test("an off agent has the state off, no login check, and only the clean-up of its harness, in text and JSON", async () => {
    const stack = fakeStack();
    let applyInput: RemoteApplyInput | undefined;
    let authTools: readonly ToolDescriptor[] = [];
    const dependencies: Partial<StatusCommandDependencies> = {
      ...stack.dependencies,
      readConfig: () => ({ version: 1, host: { tailscale: "box", sshUser: "ferry" }, harness: [{ id: "custom" }], tools: { codex: "off" } }),
      inspectApply: async (input) => {
        applyInput = input;
        return { checkout: input.checkout, targetHome: input.targetHome, actions: [], unmanaged: [] };
      },
      createAuthStart: (_link, tools) => {
        authTools = tools;
        return { status: async () => ({ providers: [] }), mcpStatus: async () => [] };
      },
    };

    const report = await status(stack, false, dependencies);

    expect(applyInput?.harnesses).toEqual([]);
    expect(applyInput?.offHarnesses).toEqual(registry.harnesses);
    expect(authTools.map((tool) => tool.id)).toEqual(["gh", "pi"]);
    const codex = report.boxes[0]?.tools?.find((tool) => tool.id === "codex");
    expect(codex).toMatchObject({ policy: "off", target: null, state: "off", reason: "Ferry does not manage it" });
    expect(JSON.parse(JSON.stringify(report)).boxes[0].tools[1].state).toBe("off");
    expect(stack.output[0]).toContain("  codex  off       operator -          target -  box -  off (Ferry does not manage it)\n");
    expect(stack.output[0]).not.toContain("WARNING: codex");
  });

  test("prints the human report from a read-only fake stack", async () => {
    const stack = fakeStack();

    await status(stack);

    expect(stack.output).toHaveLength(1);
    expect(stack.output[0]).toContain("Host: ONLINE");
    expect(stack.output[0]).toContain("All agree: yes");
    expect(stack.output[0]).toContain("Box checkout: CLEAN");
    expect(stack.output[0]).toContain(
      "Box git identity: MATCHES operator (Operator <operator@example.com>)",
    );
    expect(stack.output[0]).toContain("Managed links: UNHEALTHY (1)");
    expect(stack.output[0]).toContain("codex: LOGIN REQUIRED");
    expect(stack.output[0]).toContain("pi: MANUAL LOGIN REQUIRED. SSH to the box");
    expect(stack.output[0]).toEndWith(
      "MCP logins:\n  codex/linear: LOGIN REQUIRED, run ferry auth codex --mcp linear",
    );
    expect(stack.output[0]).toContain("dotenv: refuse environment file");
    expect(stack.mutations).toEqual([]);
    expect(stack.reads.filter((call) => call === "config.read")).toHaveLength(1);
    expect(stack.reads.filter((call) => call === "registry.load")).toHaveLength(1);
    expect(stack.reads.some((call) => /\bgit pull\b/.test(call))).toBe(false);
  });

  for (const [label, integrations] of [
    ["no [integrations] section", {}],
    ["paseo = false", { integrations: { paseo: false } }],
  ] as const) {
    test(`status and status --json print nothing about Paseo with ${label}`, async () => {
      const lines: string[] = [];
      const terminal = fakeTerminal();
      for (const args of [["status"], ["status", "--json"]]) {
        const stack = fakeStack();
        const readConfig = stack.dependencies.readConfig!;
        await buildProgram({
          runStatus: (input, dependencies) =>
            runStatusCommand(input, {
              ...stack.dependencies,
              readConfig: () => ({ ...readConfig(), ...integrations }),
              ...dependencies,
              createLink: stack.dependencies.createLink!,
            }),
          writeLine: (line) => lines.push(line),
          createProgress: () => terminal.progress,
        }).parseAsync(args, { from: "user" });
      }

      const output = lines.join("\n");
      expect(output).toContain("Host: ONLINE");
      expect(output).toContain('"schemaVersion":2');
      expect(terminal.table().join("\n")).toContain("Connecting to the box");
      expect(output).not.toMatch(/paseo/i);
      expect(terminal.writes.join("")).not.toMatch(/paseo/i);
    });
  }

  test("prints the exact report as JSON without human text", async () => {
    const stack = fakeStack();

    const report = await status(stack, true);

    expect(stack.output).toEqual([JSON.stringify(report)]);
    expect(JSON.parse(stack.output[0]!)).toEqual(report);
    expect(stack.output[0]).not.toContain("Host:");
    expect(stack.mutations).toEqual([]);
  });

  test("names each changed file in a dirty box checkout in text and JSON", async () => {
    const changes = " M skills/tdd/SKILL.md\0?? skills/scratch/SKILL.md\0";
    const text = fakeStack(true, changes);
    const json = fakeStack(true, changes);

    await status(text);
    await status(json, true);

    expect(text.output[0]).toContain(
      "Box checkout: DIRTY (2), the next sync discards these changes\n  - skills/scratch/SKILL.md\n  - skills/tdd/SKILL.md",
    );
    expect(text.reads).toContain(
      "link.run:git -C '/box/home/.ferry/store' status --porcelain=v1 -z --untracked-files=all 2>/dev/null || true",
    );
    expect(JSON.parse(json.output[0]!).boxes[0].boxCheckout).toEqual({
      dirty: true,
      changes: ["skills/scratch/SKILL.md", "skills/tdd/SKILL.md"],
      error: null,
    });
    expect(text.mutations).toEqual([]);
    expect(json.mutations).toEqual([]);
  });

  test("shows a missing or different box git identity in text and JSON", async () => {
    const missing = fakeStack(true, "", "");
    const different = fakeStack(true, "", "user.name Box Agent\nuser.email box@example.com\n");
    const json = fakeStack(true, "", "");

    await status(missing);
    await status(different);
    await status(json, true);

    expect(missing.output[0]).toContain(
      "Box git identity: MISSING user.name and user.email, run ferry install",
    );
    expect(missing.reads).toContain(
      "link.run:git config --global --get-regexp '^user\\.(name|email)$' 2>/dev/null || true",
    );
    expect(missing.reads).toContain("operator.gitIdentity:/operator/home");
    expect(different.output[0]).toContain(
      "Box git identity: DIFFERENT from operator (Box Agent <box@example.com>, operator: Operator <operator@example.com>)",
    );
    expect(JSON.parse(json.output[0]!).operator.gitIdentity).toEqual({ name: "Operator", email: "operator@example.com" });
    expect(JSON.parse(json.output[0]!).boxes[0].gitIdentity).toEqual({
      box: { name: null, email: null },
      boxConfigured: false,
      matchesOperator: false,
      error: null,
    });
    expect(missing.mutations).toEqual([]);
  });

  test("shows whether sudo on the box asks for a password in text and JSON", async () => {
    const passwordless = fakeStack();
    const password = fakeStack(true, "", undefined, "no\n");
    const passwordlessJson = fakeStack();
    const passwordJson = fakeStack(true, "", undefined, "no\n");

    await status(passwordless);
    await status(password);
    await status(passwordlessJson, true);
    await status(passwordJson, true);

    expect(passwordless.output[0]).toContain("Box sudo: PASSWORDLESS");
    expect(passwordless.reads).toContain(
      "link.run:sudo -n /usr/bin/true >/dev/null 2>&1 && echo yes || echo no",
    );
    expect(password.output[0]).toContain("Box sudo: PASSWORD REQUIRED");
    expect(password.output[0]).not.toContain("WARNING");
    expect(JSON.parse(passwordlessJson.output[0]!).boxes[0].boxSudo).toEqual({
      passwordless: true,
      watchUpdateBlocked: false,
      error: null,
    });
    expect(JSON.parse(passwordJson.output[0]!).boxes[0].boxSudo).toEqual({
      passwordless: false,
      watchUpdateBlocked: false,
      error: null,
    });
    expect(password.mutations).toEqual([]);
  });

  test("warns that the watch cannot update gh when the watch update is on, the gh policy is latest, and sudo asks for a password", async () => {
    const watchOn = fakeStack(true, "", undefined, "no\n", true, "latest");
    const watchOff = fakeStack(true, "", undefined, "no\n", false, "latest");
    const passwordless = fakeStack(true, "", undefined, "yes\n", true, "latest");
    const json = fakeStack(true, "", undefined, "no\n", true, "latest");

    await status(watchOn);
    await status(watchOff);
    await status(passwordless);
    await status(json, true);

    const warning =
      'Box sudo: PASSWORD REQUIRED\n  WARNING: [update] watch = true and the gh policy is "latest", but the watch cannot update gh because sudo on the box asks for a password. See the sudoers rule in the README.';
    expect(watchOn.output[0]).toContain(warning);
    expect(watchOff.output[0]).toContain("Box sudo: PASSWORD REQUIRED");
    expect(watchOff.output[0]).not.toContain("WARNING");
    expect(passwordless.output[0]).not.toContain("WARNING");
    expect(JSON.parse(json.output[0]!).boxes[0].boxSudo).toEqual({
      passwordless: false,
      watchUpdateBlocked: true,
      error: null,
    });
  });

  for (const ghPolicy of [undefined, "operator", "2.92.0"]) {
    test(`does not warn when the watch update is on and the gh policy is ${ghPolicy ?? "the default"}, because the watch does not update gh`, async () => {
      const text = fakeStack(true, "", undefined, "no\n", true, ghPolicy);
      const json = fakeStack(true, "", undefined, "no\n", true, ghPolicy);

      await status(text);
      await status(json, true);

      expect(text.output[0]).toContain("Box sudo: PASSWORD REQUIRED");
      expect(text.output[0]).not.toContain("WARNING");
      expect(JSON.parse(json.output[0]!).boxes[0].boxSudo.watchUpdateBlocked).toBe(false);
    });
  }

  test("constructs Link from a direct SSH destination", async () => {
    const stack = fakeStack();
    let linkOptions: unknown;
    const dependencies = {
      ...stack.dependencies,
      readConfig: () => ({
        version: 1 as const,
        host: { transport: "ssh" as const, destination: "user@box.example" },
        harness: [{ id: "custom" }],
      }),
      createLink: (options: unknown) => {
        linkOptions = options;
        return stack.dependencies.createLink!({ host: "unused", user: "unused" });
      },
    };

    await runStatusCommand({}, dependencies);

    expect(linkOptions).toEqual({ destination: "user@box.example" });
  });

  test("makes an offline host obvious and skips every box inspection", async () => {
    const stack = fakeStack(false, "", undefined, "no\n", true);
    const json = fakeStack(false, "", undefined, "no\n", true);

    await status(stack);
    await status(json, true);

    expect(stack.output[0]).toContain("Host: OFFLINE");
    expect(stack.output[0]).toContain("Managed links: unavailable while host is offline");
    expect(stack.output[0]).toContain("Box git identity: unavailable");
    expect(stack.output[0]).toContain("Box sudo: unavailable");
    expect(stack.output[0]).not.toContain("WARNING");
    expect(JSON.parse(json.output[0]!).boxes[0].boxSudo).toEqual({
      passwordless: null,
      watchUpdateBlocked: false,
      error: null,
    });
    expect(stack.output[0]).toContain("network/host-offline");
    expect(stack.reads).not.toContain("apply.inspect");
    expect(stack.reads).not.toContain("auth.status");
    expect(stack.reads.filter((call) => call.startsWith("link.run:"))).toHaveLength(1);
    expect(stack.mutations).toEqual([]);
  });
});

describe("ferry status progress", () => {
  test("shows each inspection as a step, in order", async () => {
    const stack = fakeStack();
    const progress = recordProgress();

    await status(stack, false, { ...stack.dependencies, progress });

    expect(progress.events).toEqual([
      "start:Comparing the store tips",
      "done",
      "start:Connecting to the box",
      "done",
      "start:Reading the box store tip",
      "done",
      "start:Reading the box checkout changes",
      "done",
      "start:Reading the box git identity",
      "done",
      "start:Checking sudo on the box",
      "done",
      "start:Checking managed links on the box",
      "done",
      "start:Checking logins on the box",
      "done",
      "start:Checking MCP logins on the box",
      "done",
      "start:Checking tools on the box",
      "done",
    ]);
  });

  test("marks a failed probe and skips the box steps when the host is offline", async () => {
    const stack = fakeStack(false);
    const progress = recordProgress();

    await status(stack, false, { ...stack.dependencies, progress });

    expect(progress.events).toEqual([
      "start:Comparing the store tips",
      "done",
      "start:Connecting to the box",
      "fail",
      "skip:Reading the box store tip",
      "skip:Reading the box checkout changes",
      "skip:Reading the box git identity",
      "skip:Checking sudo on the box",
      "skip:Checking managed links on the box",
      "skip:Checking logins on the box",
      "skip:Checking MCP logins on the box",
      "skip:Checking tools on the box",
    ]);
  });

  test("prints a summary table with the failed probe and the skipped box steps, then the report", async () => {
    const stack = fakeStack(false);
    const terminal = fakeTerminal();

    const report = await runStatusCommand({}, { ...stack.dependencies, progress: terminal.progress });
    terminal.progress.finish();

    expect(terminal.table()).toEqual([
      "Step                               Result     Detail                  Time",
      "Comparing the store tips           ✔ done                             0.1s",
      "Connecting to the box              ✖ failed   network/host-offline    0.1s",
      "Reading the box store tip          – skipped  host offline",
      "Reading the box checkout changes   – skipped  host offline",
      "Reading the box git identity       – skipped  host offline",
      "Checking sudo on the box           – skipped  host offline",
      "Checking managed links on the box  – skipped  host offline",
      "Checking logins on the box         – skipped  host offline",
      "Checking MCP logins on the box     – skipped  host offline",
      "Checking tools on the box          – skipped  host offline",
    ]);
    expect(formatStatus(report)).toStartWith("Store tips:");
    expect(formatStatus(report)).toContain("Box default (ferry@box)\nHost: OFFLINE");
  });

  test("progress does not change the JSON output", async () => {
    const plain = fakeStack();
    const tracked = fakeStack();

    await status(plain, true);
    await status(tracked, true, { ...tracked.dependencies, progress: recordProgress() });

    expect(tracked.output).toEqual(plain.output);
  });

  describe("with [integrations] paseo = true", () => {
    const health: IntegrationHealth = {
      lines: ["Service: ferry-paseo.service active, enabled", "Daemon: running, reachable"],
      warnings: ["The Paseo relay is on. Ferry keeps it off on the box."],
      json: { localDaemon: "running", relay: true },
    };

    function enabled(online = true) {
      const stack = fakeStack(online);
      const readConfig = stack.dependencies.readConfig!;
      const calls: unknown[] = [];
      const base = createPaseo({ platform: "win32" });
      const paseo: Integration = {
        ...base,
        box: {
          ...base.box,
          async health(link) {
            calls.push(link);
            return health;
          },
        },
      };
      const dependencies: Partial<StatusCommandDependencies> = {
        ...stack.dependencies,
        readConfig: () => ({ ...readConfig(), integrations: { paseo: true } }),
        integrations: [paseo],
      };
      return { stack, calls, dependencies };
    }

    test("prints an Integrations section with the health lines and warnings", async () => {
      const { stack, calls, dependencies } = enabled();

      await status(stack, false, dependencies);

      expect(calls).toHaveLength(1);
      expect(stack.output.join("\n")).toContain(
        [
          "MCP logins:",
          "  codex/linear: LOGIN REQUIRED, run ferry auth codex --mcp linear",
          "",
          "Integrations:",
          "  Paseo:",
          "    Service: ferry-paseo.service active, enabled",
          "    Daemon: running, reachable",
          "    WARNING: The Paseo relay is on. Ferry keeps it off on the box.",
        ].join("\n"),
      );
    });

    test("adds integrations.paseo to the JSON report", async () => {
      const { stack, dependencies } = enabled();

      const report = await status(stack, true, dependencies);

      expect(JSON.parse(stack.output[0]!).boxes[0].integrations).toEqual({
        paseo: { name: "Paseo", lines: health.lines, warnings: health.warnings, state: health.json },
      });
      expect(report.boxes[0]!.integrations?.paseo?.state).toEqual(health.json);
    });

    test("checks the integration as a progress step", async () => {
      const { dependencies } = enabled();
      const terminal = fakeTerminal();

      await runStatusCommand({}, { ...dependencies, progress: terminal.progress });
      terminal.progress.finish();

      expect(terminal.table().at(-1)).toMatch(/^Checking Paseo on the box\s+✔ done\s+1 warning\s+0\.1s$/);
    });

    test("skips the check when the host is offline", async () => {
      const { stack, calls, dependencies } = enabled(false);
      const progress = recordProgress();

      const report = await status(stack, false, { ...dependencies, progress });

      expect(calls).toEqual([]);
      expect(progress.events).toContain("skip:Checking Paseo on the box");
      expect(report.boxes[0]!.integrations?.paseo).toEqual({
        name: "Paseo",
        lines: ["unavailable while host is offline"],
        warnings: [],
        state: { error: "host offline" },
      });
      expect(stack.output.join("\n")).toContain("Integrations:\n  Paseo:\n    unavailable while host is offline");
    });
  });

  test("adds no integrations key when no integration is enabled", async () => {
    const stack = fakeStack();

    const report = await status(stack, true);

    expect("integrations" in report).toBe(false);
    expect("integrations" in report.boxes[0]!).toBe(false);
    expect(stack.output[0]).not.toContain("integrations");
  });

  describe("with an enabled operator part", () => {
    function operator(available: boolean) {
      const stack = fakeStack();
      const readConfig = stack.dependencies.readConfig!;
      const dependencies: Partial<StatusCommandDependencies> = {
        ...stack.dependencies,
        readConfig: () => ({ ...readConfig(), integrations: { [EXAMPLE_ID]: true } }),
        integrations: [operatorIntegration({ available })],
      };
      return { stack, dependencies };
    }

    test("checks it on this machine, not on the box", async () => {
      const { stack, dependencies } = operator(true);
      const progress = recordProgress();

      const report = await status(stack, false, { ...dependencies, progress });

      expect(report.integrations).toEqual({
        [EXAMPLE_ID]: { name: "Example", lines: ["Example: ready"], warnings: [], state: { ready: true } },
      });
      expect("integrations" in report.boxes[0]!).toBe(false);
      expect(progress.events).toContain("start:Checking Example on this machine");
      expect(stack.output[0]).toContain("Integrations on this machine:\n  Example:\n    Example: ready");
    });

    test("warns when it cannot run on this machine", async () => {
      const { stack, dependencies } = operator(false);

      const report = await status(stack, false, dependencies);

      expect(report.integrations?.[EXAMPLE_ID]).toEqual({
        name: "Example",
        lines: ["not available on this machine"],
        warnings: ["Example is enabled, but it is not available on this machine."],
        state: { available: false },
      });
      expect(stack.output[0]).toContain("    WARNING: Example is enabled, but it is not available on this machine.");
    });
  });
});

describe("ferry status with more than one box", () => {
  const health: IntegrationHealth = {
    lines: ["Daemon: running, reachable"],
    warnings: [],
    json: { localDaemon: "running" },
  };

  /** Box `a` is online with Paseo on. Box `b` is offline with Paseo off. */
  function twoBoxes() {
    const online = fakeStack(true);
    const offline = fakeStack(false);
    const readConfig = online.dependencies.readConfig!;
    const healthLinks: unknown[] = [];
    const linkOptions: unknown[] = [];
    const base = createPaseo({ platform: "win32" });
    const paseo: Integration = {
      ...base,
      box: {
        ...base.box,
        async health(link) {
          healthLinks.push(link);
          return health;
        },
      },
    };
    const onlineLink = online.dependencies.createLink!({ host: "unused", user: "unused" });
    const offlineLink = offline.dependencies.createLink!({ host: "unused", user: "unused" });
    const dependencies: Partial<StatusCommandDependencies> = {
      ...online.dependencies,
      readConfig: () => ({
        ...readConfig(),
        host: undefined,
        integrations: { paseo: true },
        boxes: [
          { name: "a", host: { transport: "ssh" as const, destination: "dev@box-a.example" } },
          {
            name: "b",
            host: { tailscale: "box-b", sshUser: "dev" },
            gitAuth: "box" as const,
            integrations: { paseo: false },
          },
        ],
      }),
      createLink: (options) => {
        linkOptions.push(options);
        return "destination" in options ? onlineLink : offlineLink;
      },
      integrations: [paseo],
    };
    return { output: online.output, mutations: [...online.mutations, ...offline.mutations], healthLinks, linkOptions, onlineLink, dependencies };
  }

  test("prints the shared block, then one block per box with its header", async () => {
    const stack = twoBoxes();

    await status(stack);

    const text = stack.output[0]!;
    expect(text).toStartWith(
      [
        "Store tips:",
        "  Local: same-tip",
        "  Git remote: same-tip",
        "  Local = remote: yes",
        "",
        "Deny list:",
        "  dotenv: refuse environment file",
        "",
        "Box a (dev@box-a.example)",
        "Host: ONLINE",
        "Address: 100.64.0.8",
        "Git auth: AGENT, box git commands use your forwarded SSH agent",
        "",
        "Store tips:",
        "  Box: same-tip",
        "  Remote = box: yes",
        "  All agree: yes",
      ].join("\n"),
    );
    expect(text.indexOf("Box a (dev@box-a.example)")).toBeLessThan(text.indexOf("Box b (dev@box-b)"));
    expect(text).toContain(
      "Box b (dev@box-b)\nHost: OFFLINE\nAddress: unavailable\nGit auth: BOX, deploy key ~/.ssh/ferry_snapshot on the box",
    );
    expect(text).toEndWith("Errors:\n  network/host-offline: Tailscale host box is offline");
    expect(stack.linkOptions).toEqual([{ destination: "dev@box-a.example" }, { host: "box-b", user: "dev" }]);
    expect(stack.mutations).toEqual([]);
  });

  test("shows Paseo only for the box that has the integration on", async () => {
    const stack = twoBoxes();

    await status(stack);

    const [a, b] = stack.output[0]!.split(/\n\nBox b /);
    expect(a).toContain("Integrations:\n  Paseo:\n    Daemon: running, reachable");
    expect(b).not.toMatch(/paseo/i);
    expect(stack.healthLinks).toEqual([stack.onlineLink]);
  });

  test("prints JSON v2 with one entry per box, in config order, and the offline box has its own errors", async () => {
    const stack = twoBoxes();

    const report = await status(stack, true);

    const json = JSON.parse(stack.output[0]!);
    expect(json).toEqual(report);
    expect(json.schemaVersion).toBe(2);
    expect(json.store).toEqual({ local: "same-tip", remote: "same-tip", localMatchesRemote: true, error: null });
    expect(json.errors).toEqual([]);
    expect(json.boxes.map((box: { name: string; host: string; gitAuth: string }) => [box.name, box.host, box.gitAuth])).toEqual([
      ["a", "dev@box-a.example", "agent"],
      ["b", "dev@box-b", "box"],
    ]);
    expect(json.boxes[0].link.online).toBe(true);
    expect(json.boxes[0].integrations.paseo.state).toEqual(health.json);
    expect(json.boxes[1].link.online).toBe(false);
    expect(json.boxes[1].errors).toEqual([
      { code: "host-offline", origin: "network", message: "Tailscale host box is offline" },
    ]);
    expect("integrations" in json.boxes[1]).toBe(false);
  });

  test("a selection inspects only the named boxes", async () => {
    const stack = twoBoxes();

    const report = await runStatusCommand({ selection: ["b"] }, stack.dependencies);

    expect(report.boxes.map((box) => box.name)).toEqual(["b"]);
    expect(stack.linkOptions).toEqual([{ host: "box-b", user: "dev" }]);
  });

  test("refuses an unknown box in the selection", async () => {
    const stack = twoBoxes();

    expect(runStatusCommand({ selection: ["c"] }, stack.dependencies)).rejects.toThrow(
      "unknown box c. Known boxes: a, b.",
    );
  });

  test("names each box step in the summary table", async () => {
    const stack = twoBoxes();
    const terminal = fakeTerminal(100);

    await status(stack, false, { ...stack.dependencies, progress: terminal.progress });
    terminal.progress.finish();

    const steps = terminal.table().slice(1).map((row) => row.split(/\s{2,}/)[0]);
    expect(steps).toEqual([
      "Comparing the store tips",
      "[a] Connecting to the box",
      "[a] Reading the box store tip",
      "[a] Reading the box checkout changes",
      "[a] Reading the box git identity",
      "[a] Checking sudo on the box",
      "[a] Checking managed links on the box",
      "[a] Checking logins on the box",
      "[a] Checking MCP logins on the box",
      "[a] Checking tools on the box",
      "[a] Checking Paseo on the box",
      "[b] Connecting to the box",
      "[b] Reading the box store tip",
      "[b] Reading the box checkout changes",
      "[b] Reading the box git identity",
      "[b] Checking sudo on the box",
      "[b] Checking managed links on the box",
      "[b] Checking logins on the box",
      "[b] Checking MCP logins on the box",
      "[b] Checking tools on the box",
    ]);
  });
});

describe("ferry status with one box", () => {
  test("adds only the box header to the text of one box", async () => {
    const stack = fakeStack();

    await status(stack);

    expect(stack.output[0]).toContain("\n\nBox default (ferry@box)\nHost: ONLINE\nAddress: 100.64.0.8\n");
    expect(stack.output[0]!.match(/^Box \S+ \(/gm)).toHaveLength(1);
  });
});

describe("ferry status tools", () => {
  const configTool = (id: string, extra: Partial<ToolDescriptor> = {}): ToolDescriptor => ({
    id,
    kind: "tool",
    localVersion: `${id} --version`,
    boxVersion: `${id} --version`,
    recipe: { install: (v) => `install ${id} ${v}`, update: (v) => `update ${id} ${v}` },
    ...extra,
  });

  /** One line of the box tools script: the same version with the ferry PATH and in the login shell, unless `login` differs. */
  const boxLines = (versions: Record<string, string | null>, login: Record<string, string | null> = {}) =>
    Object.entries(versions)
      .flatMap(([id, version]) => {
        const loginVersion = id in login ? login[id]! : version;
        return [
          version === null ? `${id}\tferry\t127\t\t` : `${id}\tferry\t0\t${version}\t`,
          loginVersion === null ? `${id}\tlogin\t127\t\t` : `${id}\tlogin\t0\t${loginVersion}\t`,
        ];
      })
      .join("\n");

  /**
   * A fake stack with `tools` in the registry. `boxOutput` is the tools script
   * output of each box, by box name. `boxes` replaces the one `[host]` box.
   */
  function toolStack(options: {
    readonly tools: readonly ToolDescriptor[];
    readonly operator: Record<string, string>;
    readonly boxOutput: Record<string, string>;
    readonly config?: Record<string, unknown>;
    readonly online?: boolean;
  }) {
    const base = fakeStack(options.online ?? true);
    const readConfig = base.dependencies.readConfig!;
    const baseLink = base.dependencies.createLink!({ host: "unused", user: "unused" });
    const toolCalls: string[] = [];
    const localCalls: string[] = [];
    const dependencies: Partial<StatusCommandDependencies> = {
      ...base.dependencies,
      ferryVersion: "1.2.3",
      readConfig: () => ({ ...readConfig(), ...options.config }),
      loadRegistry: () => ({ ok: true as const, harnesses: registry.harnesses, tools: options.tools }),
      createAuthStart: () => ({
        async status() {
          return { providers: [] };
        },
        async mcpStatus() {
          return [];
        },
        async start() {},
      }),
      createLink: (linkOptions) => {
        const name = "destination" in linkOptions ? linkOptions.destination : linkOptions.host;
        return {
          ...baseLink,
          async run(command: string) {
            if (command === BOX_FERRY_VERSION_COMMAND && options.online !== false) {
              return { ok: true, address: "100.64.0.8", stdout: "1.2.3\n", stderr: "" };
            }
            if (!command.includes("ferry_tool()")) return baseLink.run(command);
            toolCalls.push(name);
            if (options.online === false) return baseLink.run(command);
            return { ok: true, address: "100.64.0.8", stdout: `${options.boxOutput[name] ?? ""}\n`, stderr: "" };
          },
        };
      },
      local: {
        async run(command) {
          const script = command.argv.at(-1) ?? "";
          localCalls.push(script);
          const entry = Object.entries(options.operator).find(([id]) => script.endsWith(`${id} --version`));
          return entry
            ? { exitCode: 0, stdout: `${entry[1]}\n`, stderr: "", timedOut: false }
            : { exitCode: 127, stdout: "", stderr: "", timedOut: false };
        },
      },
    };
    return { output: base.output, mutations: base.mutations, toolCalls, localCalls, dependencies };
  }

  const sixStates = () =>
    toolStack({
      tools: [
        configTool("bun"),
        configTool("node"),
        configTool("pnpm"),
        configTool("uv"),
        configTool("go"),
        configTool("docker", { boxVersion: undefined }),
      ],
      operator: { bun: "1.4.2", node: "v24.16.0", pnpm: "11.17.0", uv: "0.9.2", docker: "29.4.0" },
      boxOutput: {
        box: boxLines({ bun: "1.4.2", node: "v22.22.1", pnpm: null, uv: "0.9.2", go: "1.22.7" }, { uv: null }),
      },
    });

  test("prints one row for each tool with ok, drift, missing, hidden, skipped, and unknown, and a warning for each tool to fix", async () => {
    const stack = sixStates();

    await status(stack);

    expect(stack.output[0]).toContain(
      [
        "Tools:",
        "  bun     operator  operator 1.4.2    target 1.4.2    box 1.4.2    ok",
        "  node    operator  operator 24.16.0  target 24.16.0  box 22.22.1  DRIFT",
        "  pnpm    operator  operator 11.17.0  target 11.17.0  box -        MISSING",
        "  uv      operator  operator 0.9.2    target 0.9.2    box 0.9.2    HIDDEN",
        "  go      operator  operator -        target -        box 1.22.7   skipped (not on the operator machine)",
        "  docker  operator  operator 29.4.0   target 29.4.0   box -        unknown (no box version command)",
        "  ferry   operator  operator 1.2.3    target 1.2.3    box 1.2.3    ok",
        "  WARNING: node is 22.22.1 on the box, and the target is 24.16.0. Run ferry update.",
        "  WARNING: pnpm is not on the box. Run ferry install.",
        "  WARNING: uv: the login shell PATH does not find it. Run ferry sync to write the PATH block of ~/.profile.",
        "",
        "Authentication:",
      ].join("\n"),
    );
    expect(stack.mutations).toEqual([]);
  });

  test("puts the rows in the box entry of the JSON report", async () => {
    const stack = sixStates();

    await status(stack, true);

    expect(JSON.parse(stack.output[0]!).boxes[0].tools).toEqual([
      { id: "bun", mode: "mirror", policy: "operator", operator: "1.4.2", target: "1.4.2", box: "1.4.2", state: "ok" },
      { id: "node", mode: "mirror", policy: "operator", operator: "24.16.0", target: "24.16.0", box: "22.22.1", state: "drift" },
      { id: "pnpm", mode: "mirror", policy: "operator", operator: "11.17.0", target: "11.17.0", box: null, state: "missing" },
      {
        id: "uv",
        mode: "mirror",
        policy: "operator",
        operator: "0.9.2",
        target: "0.9.2",
        box: "0.9.2",
        state: "hidden",
        reason: "the login shell PATH does not find it",
      },
      {
        id: "go",
        mode: "mirror",
        policy: "operator",
        operator: null,
        target: null,
        box: "1.22.7",
        state: "skipped",
        reason: "not on the operator machine",
      },
      {
        id: "docker",
        mode: "mirror",
        policy: "operator",
        operator: "29.4.0",
        target: "29.4.0",
        box: null,
        state: "unknown",
        reason: "no box version command",
      },
      { id: "ferry", mode: "always", policy: "operator", operator: "1.2.3", target: "1.2.3", box: "1.2.3", state: "ok" },
    ]);
  });

  test("reads all box versions with one box command", async () => {
    const stack = sixStates();

    await status(stack);

    expect(stack.toolCalls).toEqual(["box"]);
  });

  test("an offline box has unknown rows and no tools command", async () => {
    const stack = toolStack({
      tools: [configTool("bun")],
      operator: { bun: "1.4.2" },
      boxOutput: {},
      online: false,
    });

    const report = await status(stack);

    expect(stack.toolCalls).toEqual([]);
    expect(report.boxes[0]!.tools).toEqual([
      { id: "bun", mode: "mirror", policy: "operator", operator: "1.4.2", target: "1.4.2", box: null, state: "unknown", reason: "host offline" },
      { id: "ferry", mode: "always", policy: "operator", operator: "1.2.3", target: "1.2.3", box: null, state: "unknown", reason: "host offline" },
    ]);
    expect(stack.output[0]).toContain("  bun    operator  operator 1.4.2  target 1.4.2  box -  unknown (host offline)");
  });

  test("two boxes use their own policies, share the operator version read, and each get one tools command", async () => {
    const stack = toolStack({
      tools: [configTool("bun")],
      operator: { bun: "1.4.2" },
      boxOutput: {
        "dev@box-a.example": boxLines({ bun: "1.4.2" }),
        "dev@box-b.example": boxLines({ bun: "1.4.2" }),
      },
      config: {
        host: undefined,
        boxes: [
          { name: "a", host: { transport: "ssh" as const, destination: "dev@box-a.example" } },
          { name: "b", host: { transport: "ssh" as const, destination: "dev@box-b.example" }, tools: { bun: "1.3.9" } },
        ],
      },
    });

    const report = await status(stack);

    expect(report.boxes.map((box) => box.tools?.map((tool) => [tool.policy, tool.target, tool.state]))).toEqual([
      [["operator", "1.4.2", "ok"], ["operator", "1.2.3", "ok"]],
      [["1.3.9", "1.3.9", "drift"], ["operator", "1.2.3", "ok"]],
    ]);
    expect(stack.toolCalls.sort()).toEqual(["dev@box-a.example", "dev@box-b.example"]);
    expect(stack.localCalls.filter((call) => call.endsWith("bun --version"))).toHaveLength(1);
    expect(stack.output[0]).toContain("WARNING: bun is 1.4.2 on the box, and the target is 1.3.9. Run ferry update.");
  });

  test("with only the built-in tools, prints one line for each built-in and nothing about Paseo or projects", async () => {
    const stack = toolStack({
      tools: BUILTIN_TOOLS,
      operator: { gh: "gh version 2.92.0 (2026-04-01)", claude: "2.1.0 (Claude Code)" },
      boxOutput: {
        box: boxLines({ gh: "gh version 2.92.0", claude: "2.1.0", codex: "codex-cli 0.50.0", pi: "0.60.0", cursor: null }),
      },
    });

    await status(stack);

    const text = stack.output[0]!;
    const tools = text.slice(text.indexOf("Tools:"), text.indexOf("\n\nAuthentication:")).split("\n");
    expect(tools).toEqual([
      "Tools:",
      "  gh      operator  operator 2.92.0  target 2.92.0  box 2.92.0  ok",
      "  claude  latest    operator 2.1.0   target latest  box 2.1.0   ok",
      "  codex   latest    operator -       target latest  box 0.50.0  ok",
      "  pi      latest    operator -       target latest  box 0.60.0  ok",
      "  cursor  latest    operator -       target latest  box -       MISSING",
      "  ferry   operator  operator 1.2.3   target 1.2.3   box 1.2.3   ok",
      "  WARNING: cursor is not on the box. Run ferry install.",
    ]);
    expect(text).not.toMatch(/paseo|project/i);
  });
});

describe("ferry status --brief", () => {
  const now = () => new Date("2026-09-29T10:00:00.000Z");

  test("checks the link, the logins, the MCP logins, and the tools, and reads nothing more", async () => {
    const stack = fakeStack();

    const report = await runBriefStatusCommand({}, { ...stack.dependencies, now });

    expect(report.checkedAt).toBe("2026-09-29T10:00:00.000Z");
    expect(report.boxes.map((box) => box.issues.map((issue) => issue.name))).toEqual([["codex", "pi", "codex/linear"]]);
    expect(stack.reads).not.toContain("store.inspectTips");
    expect(stack.reads).not.toContain("apply.inspect");
    expect(stack.reads.some((read) => read.includes("sudo -n") || read.includes("--get-regexp") || read.includes(" status "))).toBe(false);
    expect(stack.mutations).toEqual([]);
  });

  test("prints one line for each box and each issue, with the fix command", async () => {
    const online = await runBriefStatusCommand({}, { ...fakeStack().dependencies, now });
    const offline = await runBriefStatusCommand({}, { ...fakeStack(false).dependencies, now });

    expect(formatBriefStatus(online)).toBe(
      [
        "Box default (ferry@box): ONLINE",
        "  codex: codex needs a login. Run ferry auth codex --box default",
        "  pi: SSH to the box, run pi, then use /login.",
        "  codex/linear: codex/linear needs a login. Run ferry auth codex --mcp linear --box default",
      ].join("\n"),
    );
    expect(formatBriefStatus(offline)).toBe("Box default (ferry@box): OFFLINE, Tailscale host box is offline");
  });

  test("status --brief --json prints the brief report in the envelope", async () => {
    const lines: string[] = [];
    const stack = fakeStack();
    await buildProgram({
      runBriefStatus: (input, dependencies) =>
        runBriefStatusCommand(input, { ...stack.dependencies, ...dependencies, createLink: stack.dependencies.createLink!, now }),
      writeLine: (line) => lines.push(line),
      writeError: () => {},
    }).parseAsync(["status", "--brief", "--json"], { from: "user" });

    const envelope = JSON.parse(lines.join(""));
    expect(envelope).toMatchObject({ command: "status", ok: true, result: { schemaVersion: 1, checkedAt: "2026-09-29T10:00:00.000Z" } });
    expect(envelope.result.boxes[0].issues[0].command).toBe("ferry auth codex --box default");
  });
});
