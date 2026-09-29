import { describe, expect, test } from "bun:test";
import type { ApplyPlan } from "../src/apply.ts";
import type { AuthStatusReport } from "../src/auth-start.ts";
import type { LinkResult } from "../src/link.ts";
import type { DenyRuleDescription } from "../src/manifest.ts";
import type { TipReport } from "../src/store.ts";
import { composeBriefStatus, composeStatus, type BoxStatusDependencies, type StatusDependencies } from "../src/status.ts";
import type { ToolStatus } from "../src/tools/check.ts";
import { recordProgress } from "./fake-progress.ts";

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

function box(
  calls: Calls,
  overrides: Partial<BoxStatusDependencies> = {},
): BoxStatusDependencies {
  return {
    name: "default",
    host: "ferry@build-box",
    gitAuth: "agent",
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
    watchUpdatesGh: false,
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
    ...overrides,
  };
}

function dependencies(
  calls: Calls,
  boxOverrides: Partial<BoxStatusDependencies> = {},
  overrides: Partial<StatusDependencies> = {},
): StatusDependencies & { readonly boxes: [BoxStatusDependencies] } {
  return {
    operator: {
      async gitIdentity() {
        calls.reads.push("operator.gitIdentity");
        return { name: "Operator O'Neil", email: "operator@example.com" };
      },
    },
    store: {
      async inspectTips(boxTip) {
        calls.reads.push("store.inspectTips");
        return tips(boxTip);
      },
    },
    manifest: {
      denyRules() {
        calls.reads.push("manifest.denyRules");
        return denyRules;
      },
    },
    ...overrides,
    boxes: [box(calls, boxOverrides)],
  };
}

const offline: LinkResult = {
  ok: false,
  error: {
    code: "host-offline",
    origin: "network",
    message: "Tailscale host build-box is offline",
  },
};

describe("Status composer", () => {
  test("returns one stable JSON-safe v2 report with the shared part and one box", async () => {
    const calls: Calls = { reads: [], mutations: [] };

    const report = await composeStatus(dependencies(calls));

    expect(report).toEqual({
      schemaVersion: 2,
      store: { local: "local-tip", remote: "remote-tip", localMatchesRemote: false, error: null },
      operator: { gitIdentity: { name: "Operator O'Neil", email: "operator@example.com" }, error: null },
      denyList: denyRules,
      boxes: [
        {
          name: "default",
          host: "ferry@build-box",
          gitAuth: "agent",
          link: { online: true, address: "100.64.0.8", error: null },
          tip: "box-tip",
          remoteMatchesBox: false,
          allMatch: false,
          boxCheckout: {
            dirty: true,
            changes: ["skills/scratch/SKILL.md", "skills/tdd/SKILL.md"],
            error: null,
          },
          gitIdentity: {
            box: { name: "Box Agent", email: "box@example.com" },
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
          errors: [],
        },
      ],
      errors: [],
    });
    expect(JSON.parse(JSON.stringify(report))).toEqual(report);
  });

  test("compares each box tip with the remote tip", async () => {
    const calls: Calls = { reads: [], mutations: [] };
    const deps = dependencies(calls, {}, {
      store: {
        async inspectTips(boxTip) {
          calls.reads.push("store.inspectTips");
          return { ...tips(boxTip), local: "same-tip", remote: "same-tip", localMatchesRemote: true };
        },
      },
    });
    const behind = box(calls, { name: "b" });
    const current = box(calls, { name: "a" });
    current.link.readBoxTip = async () => online("100.64.0.8", "same-tip\n");

    const report = await composeStatus({ ...deps, boxes: [current, behind] });

    expect(report.store).toEqual({ local: "same-tip", remote: "same-tip", localMatchesRemote: true, error: null });
    expect(report.boxes.map(({ name, tip, remoteMatchesBox, allMatch }) => ({ name, tip, remoteMatchesBox, allMatch }))).toEqual([
      { name: "a", tip: "same-tip", remoteMatchesBox: true, allMatch: true },
      { name: "b", tip: "box-tip", remoteMatchesBox: false, allMatch: false },
    ]);
    expect(calls.reads.filter((call) => call === "store.inspectTips")).toHaveLength(1);
  });

  test("uses read-only dependency methods and never invokes mutation methods", async () => {
    const calls: Calls = { reads: [], mutations: [] };
    const deps = dependencies(calls);
    const extended = deps as typeof deps & {
      store: StatusDependencies["store"] & { publish(): void; fetchTip(): void };
    };
    const boxDeps = deps.boxes[0] as BoxStatusDependencies & {
      apply: BoxStatusDependencies["apply"] & { commit(): void };
      auth: BoxStatusDependencies["auth"] & { start(): void };
    };
    extended.store.publish = () => calls.mutations.push("store.publish");
    extended.store.fetchTip = () => calls.mutations.push("store.fetchTip");
    boxDeps.apply.commit = () => calls.mutations.push("apply.commit");
    boxDeps.auth.start = () => calls.mutations.push("auth.start");

    await composeStatus(deps);

    expect(calls.reads).toEqual([
      "manifest.denyRules",
      "operator.gitIdentity",
      "store.inspectTips",
      "link.probe",
      "link.readBoxTip",
      "link.readBoxChanges",
      "link.readBoxGitIdentity",
      "link.readBoxSudo",
      "apply.plan",
      "auth.status",
      "auth.mcpStatus",
    ]);
    expect(calls.mutations).toEqual([]);
  });

  test("reports an offline host and skips box reads", async () => {
    const calls: Calls = { reads: [], mutations: [] };
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
      watchUpdatesGh: true,
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
    const [status] = report.boxes;

    expect(status!.link).toEqual({ online: false, address: null, error: offline.error });
    expect(status!.tip).toBeNull();
    expect(status!.boxCheckout).toEqual({ dirty: null, changes: [], error: null });
    expect(status!.gitIdentity).toEqual({
      box: null,
      boxConfigured: null,
      matchesOperator: null,
      error: null,
    });
    expect(report.operator.gitIdentity).toEqual({ name: "Operator O'Neil", email: "operator@example.com" });
    expect(status!.boxSudo).toEqual({ passwordless: null, watchUpdateBlocked: false, error: null });
    expect(status!.managedPaths.allHealthy).toBeNull();
    expect(status!.auth.providers).toEqual([]);
    expect(status!.errors).toContainEqual(offline.error);
    expect(report.errors).toEqual([]);
    expect(calls.mutations).toEqual([]);
  });

  test("turns inspection failures into errors that name their source, on the box or at the top", async () => {
    const calls: Calls = { reads: [], mutations: [] };
    const deps = dependencies(
      calls,
      {
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
      },
      {
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
      },
    );

    const report = await composeStatus(deps);

    expect(report.errors).toEqual([
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
    ]);
    expect(report.errors).toEqual([report.operator.error!, report.store.error!]);
    expect(report.boxes[0]!.errors).toEqual([
      { code: "inspection-failed", origin: "box", message: "box: box tip failed" },
      { code: "inspection-failed", origin: "box", message: "box: box changes failed" },
      { code: "inspection-failed", origin: "box", message: "box: box identity failed" },
      { code: "inspection-failed", origin: "box", message: "box: box sudo failed" },
      { code: "inspection-failed", origin: "box", message: "box: link inspection failed" },
      { code: "inspection-failed", origin: "box", message: "box: auth probe failed" },
      { code: "inspection-failed", origin: "box", message: "box: MCP list failed" },
    ]);
  });

  test("an MCP list the box could not run is an error, and the other tools still count", async () => {
    const calls: Calls = { reads: [], mutations: [] };
    const deps = dependencies(calls);
    const failure = { code: "command-timeout", origin: "box", message: "timed out" } as const;
    deps.boxes[0].auth.mcpStatus = async () => [
      { tool: "claude", error: failure },
      { tool: "cursor", loginRequired: ["linear", "workos"] },
    ];

    const [status] = (await composeStatus(deps)).boxes;

    expect(status!.mcpLogins).toEqual({ loginRequired: ["cursor/linear", "cursor/workos"], error: null });
    expect(status!.errors).toContainEqual(failure);
  });

  test("reports a missing box git identity", async () => {
    const calls: Calls = { reads: [], mutations: [] };
    const deps = dependencies(calls);
    deps.boxes[0].link.readBoxGitIdentity = async () => online("100.64.0.8", "user.name Box Agent\n");

    const [status] = (await composeStatus(deps)).boxes;

    expect(status!.gitIdentity).toMatchObject({
      box: { name: "Box Agent", email: null },
      boxConfigured: false,
      matchesOperator: false,
    });
  });

  test("reports a box git identity that matches the operator", async () => {
    const calls: Calls = { reads: [], mutations: [] };
    const deps = dependencies(calls);
    deps.boxes[0].link.readBoxGitIdentity = async () =>
      online("100.64.0.8", "user.name Operator O'Neil\nuser.email operator@example.com\n");

    const [status] = (await composeStatus(deps)).boxes;

    expect(status!.gitIdentity).toMatchObject({ boxConfigured: true, matchesOperator: true });
  });

  test("reports sudo on the box that asks for a password", async () => {
    const calls: Calls = { reads: [], mutations: [] };
    const deps = dependencies(calls);
    deps.boxes[0].link.readBoxSudo = async () => online("100.64.0.8", "no\n");

    const [status] = (await composeStatus(deps)).boxes;

    expect(status!.boxSudo).toEqual({
      passwordless: false,
      watchUpdateBlocked: false,
      error: null,
    });
  });

  test("blocks the watch update only when the watch update is on and sudo asks for a password", async () => {
    const calls: Calls = { reads: [], mutations: [] };
    const password = dependencies(calls, { watchUpdatesGh: true });
    password.boxes[0].link.readBoxSudo = async () => online("100.64.0.8", "no\n");
    const passwordless = dependencies(calls, { watchUpdatesGh: true });

    expect((await composeStatus(password)).boxes[0]!.boxSudo.watchUpdateBlocked).toBe(true);
    expect((await composeStatus(passwordless)).boxes[0]!.boxSudo.watchUpdateBlocked).toBe(false);
  });

  test("refuses unexpected sudo check output", async () => {
    const calls: Calls = { reads: [], mutations: [] };
    const deps = dependencies(calls);
    deps.boxes[0].link.readBoxSudo = async () => online("100.64.0.8", "maybe\n");

    const [status] = (await composeStatus(deps)).boxes;

    expect(status!.boxSudo.passwordless).toBeNull();
    expect(status!.errors).toContainEqual({
      code: "inspection-failed",
      origin: "box",
      message: "box: unexpected sudo check output",
    });
  });
});

describe("Status composer with more than one box", () => {
  function offlineBox(calls: Calls, name: string): BoxStatusDependencies {
    const status = box(calls, { name });
    status.link.probe = async () => offline;
    return status;
  }

  test("an offline box does not block the other boxes, and the boxes keep config order", async () => {
    const calls: Calls = { reads: [], mutations: [] };
    const deps = dependencies(calls);

    const report = await composeStatus({
      ...deps,
      boxes: [offlineBox(calls, "a"), box(calls, { name: "b", host: "dev@box-b.example" })],
    });

    expect(report.boxes.map((status) => [status.name, status.link.online])).toEqual([
      ["a", false],
      ["b", true],
    ]);
    expect(report.boxes[0]!.errors).toEqual([offline.error]);
    expect(report.boxes[1]!.host).toBe("dev@box-b.example");
    expect(report.boxes[1]!.errors).toEqual([]);
    expect(report.errors).toEqual([]);
  });

  test("inspects at most 4 boxes at the same time and keeps config order when later boxes end first", async () => {
    const calls: Calls = { reads: [], mutations: [] };
    let running = 0;
    let most = 0;
    const names = ["a", "b", "c", "d", "e", "f"];
    const boxes = names.map((name, index) => {
      const status = box(calls, { name });
      status.link.probe = async () => {
        running += 1;
        most = Math.max(most, running);
        await Bun.sleep((names.length - index) * 2);
        running -= 1;
        return online();
      };
      return status;
    });

    const report = await composeStatus({ ...dependencies(calls), boxes });

    expect(most).toBe(4);
    expect(report.boxes.map((status) => status.name)).toEqual(names);
  });

  test("checks the integrations of each box only", async () => {
    const calls: Calls = { reads: [], mutations: [] };
    const paseo = {
      id: "paseo" as const,
      name: "Paseo",
      async health() {
        return { lines: ["Daemon: running"], warnings: [], json: { localDaemon: "running" } };
      },
    };

    const report = await composeStatus({
      ...dependencies(calls),
      boxes: [box(calls, { name: "a", integrations: [paseo] }), box(calls, { name: "b", integrations: [] })],
    });

    expect(report.boxes[0]!.integrations).toEqual({
      paseo: { name: "Paseo", lines: ["Daemon: running"], warnings: [], state: { localDaemon: "running" } },
    });
    expect("integrations" in report.boxes[1]!).toBe(false);
  });

  test("shows the steps of each box as one group with the box name, in box order", async () => {
    const calls: Calls = { reads: [], mutations: [] };
    const slow = box(calls, { name: "a" });
    slow.link.probe = async () => {
      await Bun.sleep(5);
      return online();
    };
    const progress = recordProgress();

    await composeStatus({ ...dependencies(calls), boxes: [slow, offlineBox(calls, "b")], progress });

    expect(progress.events).toEqual([
      "start:Comparing the store tips",
      "done",
      "start:[a] Connecting to the box",
      "done",
      "start:[a] Reading the box store tip",
      "done",
      "start:[a] Reading the box checkout changes",
      "done",
      "start:[a] Reading the box git identity",
      "done",
      "start:[a] Checking sudo on the box",
      "done",
      "start:[a] Checking managed links on the box",
      "done",
      "start:[a] Checking logins on the box",
      "done",
      "start:[a] Checking MCP logins on the box",
      "done",
      "start:[b] Connecting to the box",
      "fail",
      "skip:[b] Reading the box store tip",
      "skip:[b] Reading the box checkout changes",
      "skip:[b] Reading the box git identity",
      "skip:[b] Checking sudo on the box",
      "skip:[b] Checking managed links on the box",
      "skip:[b] Checking logins on the box",
      "skip:[b] Checking MCP logins on the box",
    ]);
  });
});

describe("Status composer tools", () => {
  const row = { id: "bun", mode: "mirror", policy: "operator", operator: "1.4.2", target: "1.4.2" } as const;

  test("checks the tools as one box step, and counts the warnings", async () => {
    const calls: Calls = { reads: [], mutations: [] };
    const checks: boolean[] = [];
    const progress = recordProgress();
    const deps = dependencies(calls, {
      tools: {
        async check(isOnline) {
          checks.push(isOnline);
          return [{ ...row, box: null, state: "missing" }];
        },
      },
    });

    const report = await composeStatus({ ...deps, progress });

    expect(checks).toEqual([true]);
    expect(report.boxes[0]!.tools).toEqual([{ ...row, box: null, state: "missing" }]);
    expect(progress.events.slice(-2)).toEqual(["start:Checking tools on the box", "done"]);
  });

  test("an offline box skips the step and still gets its rows", async () => {
    const calls: Calls = { reads: [], mutations: [] };
    const checks: boolean[] = [];
    const progress = recordProgress();
    const deps = dependencies(calls, {
      link: { ...box(calls).link, probe: async () => offline },
      tools: {
        async check(isOnline) {
          checks.push(isOnline);
          return [{ ...row, box: null, state: "unknown", reason: "host offline" }];
        },
      },
    });

    const report = await composeStatus({ ...deps, progress });

    expect(checks).toEqual([false]);
    expect(report.boxes[0]!.tools?.[0]?.state).toBe("unknown");
    expect(progress.events.at(-1)).toBe("skip:Checking tools on the box");
  });

  test("a failed tools check is a box error with no rows", async () => {
    const calls: Calls = { reads: [], mutations: [] };
    const deps = dependencies(calls, {
      tools: {
        async check() {
          throw new Error("box command timed out");
        },
      },
    });

    const report = await composeStatus(deps);

    expect(report.boxes[0]!.tools).toEqual([]);
    expect(report.boxes[0]!.errors).toContainEqual({
      code: "inspection-failed",
      origin: "box",
      message: "box: box command timed out",
    });
  });
});

describe("brief status", () => {
  const checkedAt = new Date("2026-09-29T10:00:00.000Z");
  const tool = (id: string, state: ToolStatus["state"], extra: Partial<ToolStatus> = {}): ToolStatus => ({
    id,
    mode: "always",
    policy: "operator",
    operator: "2.0.0",
    target: "2.0.0",
    box: "2.0.0",
    state,
    ...extra,
  });

  test("lists each login, MCP login, and tool that needs action, with its fix command", async () => {
    const calls: Calls = { reads: [], mutations: [] };
    const report = await composeBriefStatus(
      [
        box(calls, {
          name: "a",
          tools: {
            check: async () => [
              tool("gh", "ok"),
              tool("node", "drift", { box: "1.0.0" }),
              tool("bun", "missing", { box: null }),
              tool("my tool", "hidden", { reason: "the login shell PATH does not find it" }),
              tool("pi", "skipped", { reason: "no target" }),
            ],
          },
        }),
      ],
      checkedAt,
    );

    expect(report).toEqual({
      schemaVersion: 1,
      checkedAt: "2026-09-29T10:00:00.000Z",
      boxes: [
        {
          name: "a",
          host: "ferry@build-box",
          online: true,
          error: null,
          issues: [
            { kind: "login", name: "codex", state: "login-required", message: "codex needs a login.", command: "ferry auth codex --box a" },
            {
              kind: "login",
              name: "pi",
              state: "manual",
              message: "SSH to the box, run pi, then use /login in its interactive session.",
              command: null,
            },
            {
              kind: "mcp-login",
              name: "claude/linear",
              state: "login-required",
              message: "claude/linear needs a login.",
              command: "ferry auth claude --mcp linear --box a",
            },
            {
              kind: "tool",
              name: "node",
              state: "drift",
              message: "node is 1.0.0 on the box, and the target is 2.0.0.",
              command: "ferry update --box a",
            },
            { kind: "tool", name: "bun", state: "missing", message: "bun is not on the box.", command: "ferry install --box a" },
            {
              kind: "tool",
              name: "my tool",
              state: "hidden",
              message: "my tool: the login shell PATH does not find it.",
              command: "ferry sync --box a",
            },
          ],
        },
      ],
    });
  });

  test("names the missing env keys, missing commands, and non-portable servers of the carried stdio MCP servers", async () => {
    const calls: Calls = { reads: [], mutations: [] };
    const report = await composeBriefStatus(
      [
        box(calls, {
          auth: { status: async () => ({ providers: [] }), mcpStatus: async () => [] },
          mcpServers: {
            check: async () => [
              { kind: "not-portable", harness: "claude", server: "local" },
              { kind: "command-missing", harness: "cursor", server: "docs", command: "uvx" },
              { kind: "env-missing", harness: "codex", server: "github", keys: ["GITHUB_TOKEN"], file: ".codex/config.toml" },
              { kind: "env-missing", harness: "cursor", server: "db", keys: ["DB_URL", "DB_PASSWORD"], file: ".cursor/mcp.json" },
              { kind: "env-unchecked", harness: "claude", server: "github", keys: ["GITHUB_TOKEN"] },
            ],
          },
        }),
      ],
      checkedAt,
    );

    expect(report.boxes[0]!.issues).toEqual([
      {
        kind: "mcp-server",
        name: "claude/local",
        state: "not-portable",
        message: "claude/local refers to a path in your home, so Ferry does not carry it. Use a command on the PATH or a path outside the home.",
        command: null,
      },
      {
        kind: "mcp-server",
        name: "cursor/docs",
        state: "command-missing",
        message: "cursor/docs runs uvx, which is not on the box. Install uvx on the box, or add a tool for it to the registry.",
        command: null,
      },
      {
        kind: "mcp-server",
        name: "codex/github",
        state: "env-missing",
        message: "codex/github needs GITHUB_TOKEN on the box. Set it in the env of github in ~/.codex/config.toml on the box.",
        command: null,
      },
      {
        kind: "mcp-server",
        name: "cursor/db",
        state: "env-missing",
        message: "cursor/db needs DB_URL, DB_PASSWORD on the box. Set them in the env of db in ~/.cursor/mcp.json on the box.",
        command: null,
      },
      {
        kind: "mcp-server",
        name: "claude/github",
        state: "env-unchecked",
        message: "Ferry cannot check GITHUB_TOKEN of claude/github, because jq is not on the box.",
        command: "ferry update --box default",
      },
    ]);
  });

  test("a failed MCP server check is an issue", async () => {
    const calls: Calls = { reads: [], mutations: [] };
    const report = await composeBriefStatus(
      [
        box(calls, {
          auth: { status: async () => ({ providers: [] }), mcpStatus: async () => [] },
          mcpServers: {
            check: async () => {
              throw new Error("the box MCP file is not a JSON object");
            },
          },
        }),
      ],
      checkedAt,
    );

    expect(report.boxes[0]!.issues).toEqual([
      { kind: "check-failed", name: "MCP servers", state: "failed", message: "box: the box MCP file is not a JSON object", command: null },
    ]);
  });

  test("quotes a name with other characters in the fix command", async () => {
    const calls: Calls = { reads: [], mutations: [] };
    const report = await composeBriefStatus(
      [
        box(calls, {
          auth: {
            status: async () => ({ providers: [{ provider: "my tool", status: "login-required" }] }),
            mcpStatus: async () => [],
          },
        }),
      ],
      checkedAt,
    );

    expect(report.boxes[0]!.issues[0]!.command).toBe("ferry auth 'my tool' --box default");
  });

  test("reads only the link, the logins, the MCP logins, and the tools", async () => {
    const calls: Calls = { reads: [], mutations: [] };
    await composeBriefStatus([box(calls)], checkedAt);

    expect(calls.reads).toEqual(["link.probe", "auth.status", "auth.mcpStatus"]);
    expect(calls.mutations).toEqual([]);
  });

  test("an offline box has its error and no issues, and Ferry checks nothing more on it", async () => {
    const calls: Calls = { reads: [], mutations: [] };
    const report = await composeBriefStatus(
      [
        box(calls, {
          link: {
            ...box(calls).link,
            async probe() {
              calls.reads.push("link.probe");
              return { ok: false, error: { code: "host-offline", origin: "network", message: "Tailscale host box is offline" } };
            },
          },
          tools: {
            check: async () => {
              calls.reads.push("tools.check");
              return [];
            },
          },
        }),
      ],
      checkedAt,
    );

    expect(report.boxes).toEqual([
      { name: "default", host: "ferry@build-box", online: false, error: "Tailscale host box is offline", issues: [] },
    ]);
    expect(calls.reads).toEqual(["link.probe"]);
  });

  test("a check that fails is an issue, so the box never looks clean", async () => {
    const calls: Calls = { reads: [], mutations: [] };
    const report = await composeBriefStatus(
      [
        box(calls, {
          auth: {
            async status() {
              throw new Error("login probe timed out");
            },
            async mcpStatus() {
              return [{ tool: "codex", error: { code: "command-failed", origin: "box", message: "mcp list failed" } }];
            },
          },
          tools: {
            check: async () => {
              throw new Error("tool command failed");
            },
          },
        }),
      ],
      checkedAt,
    );

    expect(report.boxes[0]!.issues).toEqual([
      { kind: "check-failed", name: "logins", state: "failed", message: "box: login probe timed out", command: null },
      { kind: "check-failed", name: "codex MCP", state: "failed", message: "box: mcp list failed", command: null },
      { kind: "check-failed", name: "tools", state: "failed", message: "box: tool command failed", command: null },
    ]);
  });
});
