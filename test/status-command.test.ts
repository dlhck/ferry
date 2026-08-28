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

function fakeStack(online = true): FakeStack {
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
        stdout: command.startsWith("printf") ? "/box/home\n" : "same-tip\n",
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
    expect(stack.output[0]).toContain("Managed links: UNHEALTHY (1)");
    expect(stack.output[0]).toContain("codex: LOGIN REQUIRED");
    expect(stack.output[0]).toContain("pi: MANUAL LOGIN REQUIRED. SSH to the box");
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

  test("makes an offline host obvious and skips every box inspection", async () => {
    const stack = fakeStack(false);

    await runStatusCommand({ json: false }, stack.dependencies);

    expect(stack.output[0]).toContain("Host: OFFLINE");
    expect(stack.output[0]).toContain("Managed links: unavailable while host is offline");
    expect(stack.output[0]).toContain("Paseo listen hint: unavailable while host is offline");
    expect(stack.output[0]).toContain("network/host-offline");
    expect(stack.reads).not.toContain("apply.inspect");
    expect(stack.reads).not.toContain("auth.status");
    expect(stack.reads.filter((call) => call.startsWith("link.run:"))).toHaveLength(1);
    expect(stack.mutations).toEqual([]);
  });
});
