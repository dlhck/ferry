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
      paseo: { address: "100.64.0.8", port: 6767, listen: "100.64.0.8:6767" },
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
      "store.inspectTips",
      "apply.plan",
      "auth.status",
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
      },
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
      },
    });

    const report = await composeStatus(deps);

    expect(report.link).toEqual({ online: false, address: null, error: offline.error });
    expect(report.store.box).toBeNull();
    expect(report.managedPaths.allHealthy).toBeNull();
    expect(report.auth.providers).toEqual([]);
    expect(report.paseo).toEqual({ address: null, port: 6767, listen: null });
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
      },
    });

    const report = await composeStatus(deps);

    expect(report.errors).toEqual([
      { code: "inspection-failed", origin: "box", message: "box: box tip failed" },
      {
        code: "inspection-failed",
        origin: "git-remote",
        message: "git remote: remote lookup failed",
      },
      { code: "inspection-failed", origin: "box", message: "box: link inspection failed" },
      { code: "inspection-failed", origin: "box", message: "box: auth probe failed" },
    ]);
  });
});
