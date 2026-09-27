import { describe, expect, test } from "bun:test";
import type { ApplyPlan } from "../src/apply.ts";
import type { AuthStatusReport } from "../src/auth-start.ts";
import type { LinkResult } from "../src/link.ts";
import type { DenyRuleDescription } from "../src/manifest.ts";
import type { TipReport } from "../src/store.ts";
import { composeStatus, type StatusDependencies } from "../src/status.ts";

type Calls = {
  readonly reads: string[];
  readonly mutations: string[];
};

function online(address = "100.64.0.8", stdout = ""): LinkResult {
  return { ok: true, address, stdout, stderr: "" };
}

function plan(actions: ApplyPlan["actions"] = []): ApplyPlan {
  return {
    checkout: "/box/home/.ferry/store",
    targetHome: "/box/home",
    actions,
    unmanaged: [],
  };
}

function tips(box: string | null = "box-tip"): TipReport {
  return {
    local: "local-tip",
    remote: "remote-tip",
    box,
    localMatchesRemote: false,
    remoteMatchesBox: false,
    allMatch: false,
  };
}

const auth: AuthStatusReport = {
  providers: [
    { provider: "gh", status: "authenticated" },
    { provider: "claude", status: "authenticated" },
    { provider: "codex", status: "login-required" },
    { provider: "cursor", status: "authenticated" },
    {
      provider: "pi",
      status: "manual",
      instruction: "SSH to the box, run pi, then use /login in its interactive session.",
    },
  ],
};

const denyRules: readonly DenyRuleDescription[] = [
  { code: "dotenv", description: "environment file", behavior: "refuse" },
  { code: "history", description: "session history", behavior: "skip" },
];

function dependencies(
  calls: Calls,
  overrides: Partial<StatusDependencies> = {},
): StatusDependencies {
  return {
    link: {
      async probe() {
        calls.reads.push("link.probe");
        return online();
      },
      async readBoxTip() {
        calls.reads.push("link.readBoxTip");
        return online("100.64.0.8", "box-tip\n");
      },
      async readBoxChanges() {
        calls.reads.push("link.readBoxChanges");
        return online("100.64.0.8", " M skills/tdd/SKILL.md\0?? skills/scratch/SKILL.md\0");
      },
      async readBoxGitIdentity() {
        calls.reads.push("link.readBoxGitIdentity");
        return online("100.64.0.8", "user.name Box Agent\nuser.email box@example.com\n");
      },
      async readBoxSudo() {
        calls.reads.push("link.readBoxSudo");
        return online("100.64.0.8", "yes\n");
      },
    },
    updateWatch: false,
    operator: {
      async gitIdentity() {
        calls.reads.push("operator.gitIdentity");
        return { name: "Operator O'Neil", email: "operator@example.com" };
      },
    },
    store: {
      async inspectTips(boxTip) {
        calls.reads.push("store.inspectTips");
        return tips(boxTip ?? "");
      },
    },
    apply: {
      plan() {
        calls.reads.push("apply.plan");
        return plan([
          {
            kind: "repair-symlink",
            harness: "Codex",
            path: "/box/home/.codex/skills/tdd",
            target: "/box/home/.ferry/store/skills/tdd",
          },
        ]);
      },
    },
    auth: {
      async status() {
        calls.reads.push("auth.status");
        return auth;
      },
      async mcpStatus() {
        calls.reads.push("auth.mcpStatus");
        return [
          { tool: "claude", loginRequired: ["linear"] },
          { tool: "codex", loginRequired: [] },
        ];
      },
    },
    manifest: {
      denyRules() {
        calls.reads.push("manifest.denyRules");
        return denyRules;
      },
    },
    ...overrides,
  };
}

describe("Status composer", () => {
  test("returns one stable JSON-safe report with mismatches and unhealthy paths", async () => {
    const calls: Calls = { reads: [], mutations: [] };

    const report = await composeStatus(dependencies(calls));

    expect(report).toEqual({
      schemaVersion: 1,
      link: { online: true, address: "100.64.0.8", error: null },
      store: { ...tips(), error: null },
      boxCheckout: {
        dirty: true,
        changes: ["skills/scratch/SKILL.md", "skills/tdd/SKILL.md"],
        error: null,
      },
      gitIdentity: {
        box: { name: "Box Agent", email: "box@example.com" },
        operator: { name: "Operator O'Neil", email: "operator@example.com" },
        boxConfigured: true,
        matchesOperator: false,
        error: null,
      },
      boxSudo: { passwordless: true, watchUpdateBlocked: false, error: null },
      managedPaths: {
        allHealthy: false,
        unhealthy: [
          {
            kind: "repair-symlink",
            harness: "Codex",
            path: "/box/home/.codex/skills/tdd",
            target: "/box/home/.ferry/store/skills/tdd",
          },
        ],
        error: null,
      },
      auth: {
        providers: auth.providers,
        loginRequired: ["codex", "pi"],
        error: null,
      },
      mcpLogins: { loginRequired: ["claude/linear"], error: null },
      denyList: denyRules,
      errors: [],
    });
    expect(JSON.parse(JSON.stringify(report))).toEqual(report);
  });

  test("uses read-only dependency methods and never invokes mutation methods", async () => {
    const calls: Calls = { reads: [], mutations: [] };
    const deps = dependencies(calls) as StatusDependencies & {
      store: StatusDependencies["store"] & { publish(): void; fetchTip(): void };
      apply: StatusDependencies["apply"] & { commit(): void };
      auth: StatusDependencies["auth"] & { start(): void };
    };
    deps.store.publish = () => calls.mutations.push("store.publish");
    deps.store.fetchTip = () => calls.mutations.push("store.fetchTip");
    deps.apply.commit = () => calls.mutations.push("apply.commit");
    deps.auth.start = () => calls.mutations.push("auth.start");

    await composeStatus(deps);

    expect(calls.reads).toEqual([
      "manifest.denyRules",
      "link.probe",
      "link.readBoxTip",
      "link.readBoxChanges",
      "link.readBoxGitIdentity",
      "link.readBoxSudo",
      "operator.gitIdentity",
      "store.inspectTips",
      "apply.plan",
      "auth.status",
      "auth.mcpStatus",
    ]);
    expect(calls.mutations).toEqual([]);
  });

  test("reports an offline host and skips box reads", async () => {
    const calls: Calls = { reads: [], mutations: [] };
    const offline: LinkResult = {
      ok: false,
      error: {
        code: "host-offline",
        origin: "network",
        message: "Tailscale host build-box is offline",
      },
    };
    const deps = dependencies(calls, {
      link: {
        async probe() {
          calls.reads.push("link.probe");
          return offline;
        },
        async readBoxTip() {
          calls.mutations.push("offline box read");
          return online();
        },
        async readBoxChanges() {
          calls.mutations.push("offline box read");
          return online();
        },
        async readBoxGitIdentity() {
          calls.mutations.push("offline box read");
          return online();
        },
        async readBoxSudo() {
          calls.mutations.push("offline box read");
          return online();
        },
      },
      updateWatch: true,
      store: {
        async inspectTips(boxTip) {
          calls.reads.push("store.inspectTips");
          return tips(boxTip);
        },
      },
      apply: {
        plan() {
          calls.mutations.push("offline apply read");
          return plan();
        },
      },
      auth: {
        async status() {
          calls.mutations.push("offline auth read");
          return auth;
        },
        async mcpStatus() {
          calls.mutations.push("offline MCP read");
          return [];
        },
      },
    });

    const report = await composeStatus(deps);

    expect(report.link).toEqual({ online: false, address: null, error: offline.error });
    expect(report.store.box).toBeNull();
    expect(report.boxCheckout).toEqual({ dirty: null, changes: [], error: null });
    expect(report.gitIdentity).toEqual({
      box: null,
      operator: { name: "Operator O'Neil", email: "operator@example.com" },
      boxConfigured: null,
      matchesOperator: null,
      error: null,
    });
    expect(report.boxSudo).toEqual({ passwordless: null, watchUpdateBlocked: false, error: null });
    expect(report.managedPaths.allHealthy).toBeNull();
    expect(report.auth.providers).toEqual([]);
    expect(report.errors).toContainEqual(offline.error);
    expect(calls.mutations).toEqual([]);
  });

  test("turns inspection failures into errors that name their source", async () => {
    const calls: Calls = { reads: [], mutations: [] };
    const deps = dependencies(calls, {
      link: {
        async probe() {
          return online();
        },
        async readBoxTip() {
          throw new Error("box tip failed");
        },
        async readBoxChanges() {
          throw new Error("box changes failed");
        },
        async readBoxGitIdentity() {
          throw new Error("box identity failed");
        },
        async readBoxSudo() {
          throw new Error("box sudo failed");
        },
      },
      operator: {
        async gitIdentity() {
          throw new Error("operator identity failed");
        },
      },
      store: {
        async inspectTips() {
          throw new Error("remote lookup failed");
        },
      },
      apply: {
        plan() {
          throw new Error("link inspection failed");
        },
      },
      auth: {
        async status() {
          throw new Error("auth probe failed");
        },
        async mcpStatus() {
          throw new Error("MCP list failed");
        },
      },
    });

    const report = await composeStatus(deps);

    expect(report.errors).toEqual([
      { code: "inspection-failed", origin: "box", message: "box: box tip failed" },
      { code: "inspection-failed", origin: "box", message: "box: box changes failed" },
      { code: "inspection-failed", origin: "box", message: "box: box identity failed" },
      { code: "inspection-failed", origin: "box", message: "box: box sudo failed" },
      {
        code: "inspection-failed",
        origin: "operator",
        message: "operator: operator identity failed",
      },
      {
        code: "inspection-failed",
        origin: "git-remote",
        message: "git remote: remote lookup failed",
      },
      { code: "inspection-failed", origin: "box", message: "box: link inspection failed" },
      { code: "inspection-failed", origin: "box", message: "box: auth probe failed" },
      { code: "inspection-failed", origin: "box", message: "box: MCP list failed" },
    ]);
  });

  test("an MCP list the box could not run is an error, and the other tools still count", async () => {
    const calls: Calls = { reads: [], mutations: [] };
    const deps = dependencies(calls);
    const failure = { code: "command-timeout", origin: "box", message: "timed out" } as const;
    deps.auth.mcpStatus = async () => [
      { tool: "claude", error: failure },
      { tool: "cursor", loginRequired: ["linear", "workos"] },
    ];

    const report = await composeStatus(deps);

    expect(report.mcpLogins).toEqual({ loginRequired: ["cursor/linear", "cursor/workos"], error: null });
    expect(report.errors).toContainEqual(failure);
  });

  test("reports a missing box git identity", async () => {
    const calls: Calls = { reads: [], mutations: [] };
    const deps = dependencies(calls);
    deps.link.readBoxGitIdentity = async () => online("100.64.0.8", "user.name Box Agent\n");

    const report = await composeStatus(deps);

    expect(report.gitIdentity).toMatchObject({
      box: { name: "Box Agent", email: null },
      boxConfigured: false,
      matchesOperator: false,
    });
  });

  test("reports a box git identity that matches the operator", async () => {
    const calls: Calls = { reads: [], mutations: [] };
    const deps = dependencies(calls);
    deps.link.readBoxGitIdentity = async () =>
      online("100.64.0.8", "user.name Operator O'Neil\nuser.email operator@example.com\n");

    const report = await composeStatus(deps);

    expect(report.gitIdentity).toMatchObject({ boxConfigured: true, matchesOperator: true });
  });

  test("reports sudo on the box that asks for a password", async () => {
    const calls: Calls = { reads: [], mutations: [] };
    const deps = dependencies(calls);
    deps.link.readBoxSudo = async () => online("100.64.0.8", "no\n");

    const report = await composeStatus(deps);

    expect(report.boxSudo).toEqual({
      passwordless: false,
      watchUpdateBlocked: false,
      error: null,
    });
  });

  test("blocks the watch update only when the watch update is on and sudo asks for a password", async () => {
    const calls: Calls = { reads: [], mutations: [] };
    const password = dependencies(calls, { updateWatch: true });
    password.link.readBoxSudo = async () => online("100.64.0.8", "no\n");
    const passwordless = dependencies(calls, { updateWatch: true });

    expect((await composeStatus(password)).boxSudo.watchUpdateBlocked).toBe(true);
    expect((await composeStatus(passwordless)).boxSudo.watchUpdateBlocked).toBe(false);
  });

  test("refuses unexpected sudo check output", async () => {
    const calls: Calls = { reads: [], mutations: [] };
    const deps = dependencies(calls);
    deps.link.readBoxSudo = async () => online("100.64.0.8", "maybe\n");

    const report = await composeStatus(deps);

    expect(report.boxSudo.passwordless).toBeNull();
    expect(report.errors).toContainEqual({
      code: "inspection-failed",
      origin: "box",
      message: "box: unexpected sudo check output",
    });
  });
});
