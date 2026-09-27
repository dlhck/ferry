import { describe, expect, test } from "bun:test";
import type { ApplyPlan, RemoteApplyInput } from "../src/apply.ts";
import type { AuthStatusReport } from "../src/auth-start.ts";
import { buildProgram } from "../src/cli.ts";
import { createPaseo } from "../src/integrations/paseo.ts";
import type { Integration, IntegrationHealth } from "../src/integrations/types.ts";
import type { LinkResult } from "../src/link.ts";
import type { Registry } from "../src/registry/load.ts";
import type { ToolDescriptor } from "../src/registry/types.ts";
import type { TipReport } from "../src/store.ts";
import {
  runStatusCommand,
  type StatusCommandDependencies,
} from "../src/status-command.ts";
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
      expect(input.harnesses).toBe(registry.harnesses);
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
      expect(tools).toBe(registry.tools);
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
    writeLine: (line: string) => output.push(line),
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

describe("ferry status command", () => {
  test("prints the human report from a read-only fake stack", async () => {
    const stack = fakeStack();

    await runStatusCommand({ json: false }, stack.dependencies);

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

    const report = await runStatusCommand({ json: true }, stack.dependencies);

    expect(stack.output).toEqual([JSON.stringify(report)]);
    expect(JSON.parse(stack.output[0]!)).toEqual(report);
    expect(stack.output[0]).not.toContain("Host:");
    expect(stack.mutations).toEqual([]);
  });

  test("names each changed file in a dirty box checkout in text and JSON", async () => {
    const changes = " M skills/tdd/SKILL.md\0?? skills/scratch/SKILL.md\0";
    const text = fakeStack(true, changes);
    const json = fakeStack(true, changes);

    await runStatusCommand({ json: false }, text.dependencies);
    await runStatusCommand({ json: true }, json.dependencies);

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

    await runStatusCommand({ json: false }, missing.dependencies);
    await runStatusCommand({ json: false }, different.dependencies);
    await runStatusCommand({ json: true }, json.dependencies);

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

    await runStatusCommand({ json: false }, passwordless.dependencies);
    await runStatusCommand({ json: false }, password.dependencies);
    await runStatusCommand({ json: true }, passwordlessJson.dependencies);
    await runStatusCommand({ json: true }, passwordJson.dependencies);

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

    await runStatusCommand({ json: false }, watchOn.dependencies);
    await runStatusCommand({ json: false }, watchOff.dependencies);
    await runStatusCommand({ json: false }, passwordless.dependencies);
    await runStatusCommand({ json: true }, json.dependencies);

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

      await runStatusCommand({ json: false }, text.dependencies);
      await runStatusCommand({ json: true }, json.dependencies);

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

    await runStatusCommand({ json: false }, dependencies);

    expect(linkOptions).toEqual({ destination: "user@box.example" });
  });

  test("makes an offline host obvious and skips every box inspection", async () => {
    const stack = fakeStack(false, "", undefined, "no\n", true);
    const json = fakeStack(false, "", undefined, "no\n", true);

    await runStatusCommand({ json: false }, stack.dependencies);
    await runStatusCommand({ json: true }, json.dependencies);

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

    await runStatusCommand({ json: false }, { ...stack.dependencies, progress });

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
    ]);
  });

  test("marks a failed probe and skips the box steps when the host is offline", async () => {
    const stack = fakeStack(false);
    const progress = recordProgress();

    await runStatusCommand({ json: false }, { ...stack.dependencies, progress });

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
    ]);
  });

  test("prints a summary table with the failed probe and the skipped box steps, then the report", async () => {
    const stack = fakeStack(false);
    const terminal = fakeTerminal();
    const lines: string[] = [];

    await runStatusCommand(
      { json: false },
      { ...stack.dependencies, progress: terminal.progress, writeLine: terminal.progress.hold((line) => lines.push(line)) },
    );
    expect(lines).toEqual([]);
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
    ]);
    expect(lines[0]).toStartWith("Store tips:");
    expect(lines[0]).toContain("Box default (ferry@box)\nHost: OFFLINE");
  });

  test("progress does not change the JSON output", async () => {
    const plain = fakeStack();
    const tracked = fakeStack();

    await runStatusCommand({ json: true }, plain.dependencies);
    await runStatusCommand({ json: true }, { ...tracked.dependencies, progress: recordProgress() });

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
      const paseo: Integration = {
        ...createPaseo({ platform: "win32" }),
        async health(link) {
          calls.push(link);
          return health;
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

      await runStatusCommand({ json: false }, dependencies);

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

      const report = await runStatusCommand({ json: true }, dependencies);

      expect(JSON.parse(stack.output[0]!).boxes[0].integrations).toEqual({
        paseo: { name: "Paseo", lines: health.lines, warnings: health.warnings, state: health.json },
      });
      expect(report.boxes[0]!.integrations?.paseo?.state).toEqual(health.json);
    });

    test("checks the integration as a progress step", async () => {
      const { dependencies } = enabled();
      const terminal = fakeTerminal();

      await runStatusCommand({ json: false }, { ...dependencies, progress: terminal.progress });
      terminal.progress.finish();

      expect(terminal.table().at(-1)).toMatch(/^Checking Paseo on the box\s+✔ done\s+1 warning\s+0\.1s$/);
    });

    test("skips the check when the host is offline", async () => {
      const { stack, calls, dependencies } = enabled(false);
      const progress = recordProgress();

      const report = await runStatusCommand({ json: false }, { ...dependencies, progress });

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

    const report = await runStatusCommand({ json: true }, stack.dependencies);

    expect("integrations" in report.boxes[0]!).toBe(false);
    expect(stack.output[0]).not.toContain("integrations");
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
    const paseo: Integration = {
      ...createPaseo({ platform: "win32" }),
      async health(link) {
        healthLinks.push(link);
        return health;
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

    await runStatusCommand({ json: false }, stack.dependencies);

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
        "",
        "Store tips:",
        "  Box: same-tip",
        "  Remote = box: yes",
        "  All agree: yes",
      ].join("\n"),
    );
    expect(text.indexOf("Box a (dev@box-a.example)")).toBeLessThan(text.indexOf("Box b (dev@box-b)"));
    expect(text).toContain("Box b (dev@box-b)\nHost: OFFLINE\nAddress: unavailable");
    expect(text).toEndWith("Errors:\n  network/host-offline: Tailscale host box is offline");
    expect(stack.linkOptions).toEqual([{ destination: "dev@box-a.example" }, { host: "box-b", user: "dev" }]);
    expect(stack.mutations).toEqual([]);
  });

  test("shows Paseo only for the box that has the integration on", async () => {
    const stack = twoBoxes();

    await runStatusCommand({ json: false }, stack.dependencies);

    const [a, b] = stack.output[0]!.split(/\n\nBox b /);
    expect(a).toContain("Integrations:\n  Paseo:\n    Daemon: running, reachable");
    expect(b).not.toMatch(/paseo/i);
    expect(stack.healthLinks).toEqual([stack.onlineLink]);
  });

  test("prints JSON v2 with one entry per box, in config order, and the offline box has its own errors", async () => {
    const stack = twoBoxes();

    const report = await runStatusCommand({ json: true }, stack.dependencies);

    const json = JSON.parse(stack.output[0]!);
    expect(json).toEqual(report);
    expect(json.schemaVersion).toBe(2);
    expect(json.store).toEqual({ local: "same-tip", remote: "same-tip", localMatchesRemote: true, error: null });
    expect(json.errors).toEqual([]);
    expect(json.boxes.map((box: { name: string; host: string }) => [box.name, box.host])).toEqual([
      ["a", "dev@box-a.example"],
      ["b", "dev@box-b"],
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

    const report = await runStatusCommand({ json: true, selection: ["b"] }, stack.dependencies);

    expect(report.boxes.map((box) => box.name)).toEqual(["b"]);
    expect(stack.linkOptions).toEqual([{ host: "box-b", user: "dev" }]);
  });

  test("refuses an unknown box in the selection", async () => {
    const stack = twoBoxes();

    expect(runStatusCommand({ json: true, selection: ["c"] }, stack.dependencies)).rejects.toThrow(
      "unknown box c. Known boxes: a, b.",
    );
  });

  test("names each box step in the summary table", async () => {
    const stack = twoBoxes();
    const terminal = fakeTerminal(100);

    await runStatusCommand({ json: false }, { ...stack.dependencies, progress: terminal.progress });
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
      "[a] Checking Paseo on the box",
      "[b] Connecting to the box",
      "[b] Reading the box store tip",
      "[b] Reading the box checkout changes",
      "[b] Reading the box git identity",
      "[b] Checking sudo on the box",
      "[b] Checking managed links on the box",
      "[b] Checking logins on the box",
      "[b] Checking MCP logins on the box",
    ]);
  });
});

describe("ferry status with one box", () => {
  test("adds only the box header to the text of one box", async () => {
    const stack = fakeStack();

    await runStatusCommand({ json: false }, stack.dependencies);

    expect(stack.output[0]).toContain("\n\nBox default (ferry@box)\nHost: ONLINE\nAddress: 100.64.0.8\n");
    expect(stack.output[0]!.match(/^Box \S+ \(/gm)).toHaveLength(1);
  });
});
