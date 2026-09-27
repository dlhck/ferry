import { describe, expect, test } from "bun:test";
import type { ApplyPlan, RemoteApplyInput } from "../src/apply.ts";
import type { AuthStatusReport } from "../src/auth-start.ts";
import type { LinkResult } from "../src/link.ts";
import type { Registry } from "../src/registry/load.ts";
import type { ToolDescriptor } from "../src/registry/types.ts";
import type { TipReport } from "../src/store.ts";
import {
  runStatusCommand,
  type StatusCommandDependencies,
} from "../src/status-command.ts";
import { recordProgress } from "./fake-progress.ts";

const registry: Registry = {
  harnesses: [
    { id: "codex", name: "Codex", skillRoot: ".codex/skills" },
  ],
  tools: [
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
    applyPaseoConfig: () => mutations.push("paseo.write"),
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
    expect(stack.output[0]).toContain(
      "MCP logins:\n  codex/linear: LOGIN REQUIRED, run ferry auth codex --mcp linear",
    );
    expect(stack.output[0]).toContain("Paseo listen hint: 100.64.0.8:6767");
    expect(stack.output[0]).toContain("dotenv: refuse environment file");
    expect(stack.mutations).toEqual([]);
    expect(stack.reads.filter((call) => call === "config.read")).toHaveLength(1);
    expect(stack.reads.filter((call) => call === "registry.load")).toHaveLength(1);
    expect(stack.reads.some((call) => /\bgit pull\b/.test(call))).toBe(false);
  });

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
    expect(JSON.parse(json.output[0]!).boxCheckout).toEqual({
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
    expect(JSON.parse(json.output[0]!).gitIdentity).toEqual({
      box: { name: null, email: null },
      operator: { name: "Operator", email: "operator@example.com" },
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
    expect(JSON.parse(passwordlessJson.output[0]!).boxSudo).toEqual({
      passwordless: true,
      watchUpdateBlocked: false,
      error: null,
    });
    expect(JSON.parse(passwordJson.output[0]!).boxSudo).toEqual({
      passwordless: false,
      watchUpdateBlocked: false,
      error: null,
    });
    expect(password.mutations).toEqual([]);
  });

  test("warns that the watch cannot update gh when the watch update is on and sudo asks for a password", async () => {
    const watchOn = fakeStack(true, "", undefined, "no\n", true);
    const watchOff = fakeStack(true, "", undefined, "no\n", false);
    const passwordless = fakeStack(true, "", undefined, "yes\n", true);
    const json = fakeStack(true, "", undefined, "no\n", true);

    await runStatusCommand({ json: false }, watchOn.dependencies);
    await runStatusCommand({ json: false }, watchOff.dependencies);
    await runStatusCommand({ json: false }, passwordless.dependencies);
    await runStatusCommand({ json: true }, json.dependencies);

    const warning =
      "Box sudo: PASSWORD REQUIRED\n  WARNING: [update] watch = true, but the watch cannot update gh because sudo on the box asks for a password. See the sudoers rule in the README.";
    expect(watchOn.output[0]).toContain(warning);
    expect(watchOff.output[0]).toContain("Box sudo: PASSWORD REQUIRED");
    expect(watchOff.output[0]).not.toContain("WARNING");
    expect(passwordless.output[0]).not.toContain("WARNING");
    expect(JSON.parse(json.output[0]!).boxSudo).toEqual({
      passwordless: false,
      watchUpdateBlocked: true,
      error: null,
    });
  });

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
    expect(JSON.parse(json.output[0]!).boxSudo).toEqual({
      passwordless: null,
      watchUpdateBlocked: false,
      error: null,
    });
    expect(stack.output[0]).toContain("Paseo listen hint: unavailable while host is offline");
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
      "start:Comparing the store tips",
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
      "start:Connecting to the box",
      "fail",
      "start:Comparing the store tips",
      "done",
    ]);
  });

  test("progress does not change the JSON output", async () => {
    const plain = fakeStack();
    const tracked = fakeStack();

    await runStatusCommand({ json: true }, plain.dependencies);
    await runStatusCommand({ json: true }, { ...tracked.dependencies, progress: recordProgress() });

    expect(tracked.output).toEqual(plain.output);
  });
});
