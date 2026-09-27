import { describe, expect, test } from "bun:test";
import type { AuthLink, AuthStartResult } from "../src/auth-start.ts";
import {
  runAuthCommand,
  runInstallCommand,
  type AuthCommandDependencies,
  type InstallCommandDependencies,
} from "../src/install-auth.ts";
import type { GitIdentity } from "../src/git-identity.ts";
import type { InstallProgress, InstallRecipe, InstallResult } from "../src/install.ts";
import type { LinkResult } from "../src/link.ts";
import { BUILTIN_TOOLS } from "../src/registry/builtin.ts";

const config = {
  version: 1 as const,
  publisher: "operator",
  snapshotUrl: "git@example.com:snapshot.git",
  host: { tailscale: "builder.tailnet.ts.net", sshUser: "david" },
};

describe("install command", () => {
  const plan: readonly InstallRecipe[] = [
    { tool: "gh", command: "install gh\nwith the full command" },
    { tool: "codex", command: "install codex" },
  ];

  test("prints the exact plan before confirmation", async () => {
    const output: string[] = [];
    let outputAtPrompt: readonly string[] = [];

    await runInstallCommand(
      { yes: false },
      installDependencies({
        plan,
        output,
        confirm: async () => {
          outputAtPrompt = [...output];
          return false;
        },
      }),
    );

    expect(outputAtPrompt).toEqual([
      ...plan.map((recipe) => `${recipe.tool}: ${recipe.command}`),
      `git identity: ${identityCommand}`,
    ]);
  });

  test("does not run when confirmation is false", async () => {
    let runs = 0;
    const linkRuns: string[] = [];

    await runInstallCommand(
      { yes: false },
      installDependencies({
        plan,
        confirm: async () => false,
        linkRuns,
        run: async () => {
          runs += 1;
          return { ok: true };
        },
      }),
    );

    expect(runs).toBe(0);
    expect(linkRuns).toEqual([]);
  });

  test("sets a missing box git identity after the tools install", async () => {
    const events: string[] = [];

    await runInstallCommand(
      { yes: true },
      installDependencies({
        plan,
        linkRuns: events,
        run: async () => {
          events.push("install.run");
          return { ok: true };
        },
      }),
    );

    expect(events).toEqual(["install.run", identityCommand]);
  });

  test("skips the box git identity when the operator has none", async () => {
    const output: string[] = [];
    const linkRuns: string[] = [];

    await runInstallCommand(
      { yes: true },
      installDependencies({
        plan,
        output,
        linkRuns,
        operatorIdentity: { name: "Operator", email: null },
      }),
    );

    expect(output).toContain(
      "git identity: skipped, the operator machine has no git user.name and user.email",
    );
    expect(linkRuns).toEqual([]);
  });

  test("fails safely when the box git identity cannot be set", async () => {
    const output: string[] = [];

    await expect(
      runInstallCommand(
        { yes: true },
        installDependencies({
          plan,
          output,
          linkResult: {
            ok: false,
            error: { code: "command-failed", origin: "box", message: "raw stderr" },
          },
        }),
      ),
    ).rejects.toThrow("Install stopped because Link reported command-failed from box.");
    expect(output.join("\n")).not.toContain("raw stderr");
  });

  test("--yes skips confirmation and runs once", async () => {
    let prompts = 0;
    let runs = 0;
    let confirmed: boolean | undefined;

    await runInstallCommand(
      { yes: true },
      installDependencies({
        plan,
        confirm: async () => {
          prompts += 1;
          return false;
        },
        run: async (value) => {
          runs += 1;
          confirmed = value;
          return { ok: true };
        },
      }),
    );

    expect(prompts).toBe(0);
    expect(runs).toBe(1);
    expect(confirmed).toBe(true);
  });

  test("shows a spinner and per-tool progress while installing", async () => {
    const progress: string[] = [];

    await runInstallCommand(
      { yes: true },
      installDependencies({
        plan,
        progress,
        run: async (_confirmed, reportProgress) => {
          reportProgress?.({ phase: "started", tool: "gh", current: 1, total: 2 });
          reportProgress?.({ phase: "completed", tool: "gh", current: 1, total: 2 });
          reportProgress?.({ phase: "started", tool: "codex", current: 2, total: 2 });
          reportProgress?.({ phase: "completed", tool: "codex", current: 2, total: 2 });
          return { ok: true };
        },
      }),
    );

    expect(progress).toEqual([
      "start:Installing gh (1/2)",
      "advance:1:Installed gh (1/2)",
      "message:Installing codex (2/2)",
      "advance:1:Installed codex (2/2)",
      "stop:Installed 2 tools",
    ]);
  });

  test("fails safely when an installer fails", async () => {
    const output: string[] = [];
    const progress: string[] = [];

    await expect(
      runInstallCommand(
        { yes: true },
        installDependencies({
          plan,
          output,
          progress,
          run: async (_confirmed, reportProgress) => {
            reportProgress?.({ phase: "started", tool: "gh", current: 1, total: 2 });
            return {
              ok: false,
              error: {
                code: "command-failed",
                origin: "box",
                message: "raw remote stderr with token-secret",
              },
            };
          },
        }),
      ),
    ).rejects.toThrow("Install stopped because Link reported command-failed from box.");
    expect(progress).toEqual([
      "start:Installing gh (1/2)",
      "error:Failed to install gh (1/2)",
    ]);
    expect(output.join("\n")).toContain("box/command-failed");
    expect(output.join("\n")).not.toContain("token-secret");
  });
});

describe("auth command", () => {
  test("lists the exported startable providers and Pi as manual", async () => {
    const output: string[] = [];
    let links = 0;

    await runAuthCommand(
      {},
      authDependencies({
        output,
        createLink: () => {
          links += 1;
          return fakeLink();
        },
      }),
    );

    expect(output).toEqual([
      "gh: startable",
      "claude: startable",
      "codex: startable",
      "cursor: startable",
      "pi: manual SSH flow",
    ]);
    expect(links).toBe(0);
  });

  test("constructs Link from config and calls start once", async () => {
    const link = fakeLink();
    let linkOptions: unknown;
    let authLink: unknown;
    const providers: string[] = [];

    await runAuthCommand(
      { provider: "gh" },
      authDependencies({
        createLink: (options) => {
          linkOptions = options;
          return link;
        },
        createAuthStart: (receivedLink) => {
          authLink = receivedLink;
          return {
            start: async (provider: string) => {
              providers.push(provider);
              return { kind: "already-done", provider: "gh" };
            },
          };
        },
      }),
    );

    expect(linkOptions).toEqual({ host: config.host.tailscale, user: config.host.sshUser });
    expect(authLink).toBe(link);
    expect(providers).toEqual(["gh"]);
  });

  test("constructs Link from a direct SSH destination", async () => {
    let linkOptions: unknown;

    await runAuthCommand(
      { provider: "gh" },
      authDependencies({
        readConfig: () => ({
          ...config,
          host: { transport: "ssh", destination: "ubuntu@orb" },
        }),
        createLink: (options) => {
          linkOptions = options;
          return fakeLink();
        },
      }),
    );

    expect(linkOptions).toEqual({ destination: "ubuntu@orb" });
  });

  const renderCases: readonly {
    readonly name: string;
    readonly provider: string;
    readonly result: AuthStartResult;
    readonly expected: readonly string[];
  }[] = [
    {
      name: "already authenticated",
      provider: "gh",
      result: { kind: "already-done", provider: "gh" },
      expected: ["gh: already authenticated"],
    },
    {
      name: "device URL and code",
      provider: "gh",
      result: {
        kind: "device-url",
        provider: "gh",
        url: "https://github.com/login/device",
        userCode: "ABCD-EFGH",
      },
      expected: ["URL: https://github.com/login/device", "Code: ABCD-EFGH"],
    },
    {
      name: "printed URL",
      provider: "claude",
      result: { kind: "printed-url", provider: "claude", url: "https://claude.ai/login" },
      expected: ["URL: https://claude.ai/login"],
    },
    {
      name: "local port forward",
      provider: "codex",
      result: {
        kind: "local-port-forward",
        provider: "codex",
        url: "https://auth.openai.com/codex",
        localPort: 1455,
        remotePort: 1455,
        timeoutMs: 120_000,
      },
      expected: ["URL: https://auth.openai.com/codex", "Local port: 1455", "Timeout: 120000 ms"],
    },
    {
      name: "Pi manual SSH instruction",
      provider: "pi",
      result: {
        kind: "manual-ssh",
        provider: "pi",
        command: "pi",
        instruction: "SSH to the box and run pi.",
      },
      expected: ["pi: manual SSH flow", "SSH to the box and run pi."],
    },
    {
      name: "structured Link failure",
      provider: "cursor",
      result: {
        kind: "link-failure",
        provider: "cursor",
        result: {
          ok: false,
          error: { code: "command-failed", origin: "box", message: "raw token-secret" },
        },
      },
      expected: ["box/command-failed", "AuthStart stopped because Link reported command-failed from box."],
    },
    {
      name: "safe login output failure",
      provider: "cursor",
      result: {
        kind: "failed",
        provider: "cursor",
        code: "login-output",
        message: "The cursor login did not return a safe operator URL.",
      },
      expected: ["box/login-output", "The cursor login did not return a safe operator URL."],
    },
  ];

  for (const renderCase of renderCases) {
    test(`renders ${renderCase.name} without raw output`, async () => {
      const output: string[] = [];
      const promise = runAuthCommand(
        { provider: renderCase.provider },
        authDependencies({ output, result: renderCase.result }),
      );

      if (renderCase.result.kind === "link-failure" || renderCase.result.kind === "failed") {
        await expect(promise).rejects.toThrow();
      } else {
        await promise;
      }

      for (const expected of renderCase.expected) expect(output.join("\n")).toContain(expected);
      expect(output.join("\n")).not.toContain("token-secret");
    });
  }

  test("refuses an unknown provider before config, Link, or AuthStart", async () => {
    let configReads = 0;
    let links = 0;
    let authStarts = 0;
    const output: string[] = [];

    await expect(
      runAuthCommand(
        { provider: "unknown" },
        authDependencies({
          output,
          readConfig: () => {
            configReads += 1;
            return config;
          },
          createLink: () => {
            links += 1;
            return fakeLink();
          },
          createAuthStart: () => {
            authStarts += 1;
            return { start: async () => ({ kind: "already-done", provider: "gh" }) };
          },
        }),
      ),
    ).rejects.toThrow("Unknown auth provider");

    expect(configReads).toBe(0);
    expect(links).toBe(0);
    expect(authStarts).toBe(0);
    expect(output.join("\n")).toContain("operator/invalid-provider");
  });
});

const identityCommand =
  "{ git config --global --get user.name >/dev/null || git config --global user.name 'Operator O'\"'\"'Neil'; } && " +
  "{ git config --global --get user.email >/dev/null || git config --global user.email 'operator@example.com'; }";

function installDependencies(overrides: {
  readonly plan: readonly InstallRecipe[];
  readonly output?: string[];
  readonly linkRuns?: string[];
  readonly linkResult?: LinkResult;
  readonly operatorIdentity?: GitIdentity;
  readonly progress?: string[];
  readonly confirm?: () => Promise<boolean | symbol | undefined>;
  readonly run?: (
    confirmed: boolean,
    reportProgress?: (progress: InstallProgress) => void,
  ) => Promise<InstallResult>;
}): InstallCommandDependencies {
  return {
    tools: BUILTIN_TOOLS,
    readConfig: () => config,
    createLink: () => ({
      ...fakeLink(),
      run: async (command) => {
        overrides.linkRuns?.push(command);
        return overrides.linkResult ?? { ok: true, address: "builder", stdout: "", stderr: "" };
      },
    }),
    readOperatorGitIdentity: async () =>
      overrides.operatorIdentity ?? { name: "Operator O'Neil", email: "operator@example.com" },
    createInstall: () => ({
      plan: () => overrides.plan,
      run: overrides.run ?? (async () => ({ ok: true })),
    }),
    createProgress: () => ({
      start: (message) => overrides.progress?.push(`start:${message}`),
      message: (message) => overrides.progress?.push(`message:${message}`),
      advance: (step, message) => overrides.progress?.push(`advance:${step}:${message}`),
      stop: (message) => overrides.progress?.push(`stop:${message}`),
      error: (message) => overrides.progress?.push(`error:${message}`),
    }),
    confirm: overrides.confirm ?? (async () => true),
    writeLine: (line) => overrides.output?.push(line),
  };
}

function authDependencies(overrides: {
  readonly output?: string[];
  readonly result?: AuthStartResult;
  readonly readConfig?: AuthCommandDependencies["readConfig"];
  readonly createLink?: AuthCommandDependencies["createLink"];
  readonly createAuthStart?: AuthCommandDependencies["createAuthStart"];
} = {}): AuthCommandDependencies {
  return {
    tools: BUILTIN_TOOLS,
    readConfig: overrides.readConfig ?? (() => config),
    createLink: overrides.createLink ?? fakeLink,
    createAuthStart: overrides.createAuthStart ?? (() => ({
      start: async () => overrides.result ?? ({ kind: "already-done", provider: "gh" }),
    })),
    writeLine: (line) => overrides.output?.push(line),
  };
}

function fakeLink(): AuthLink {
  const success = { ok: true as const, address: "builder.tailnet.ts.net", stdout: "", stderr: "" };
  return {
    run: async () => success,
    forward: async () => success,
  };
}
