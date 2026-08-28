import { describe, expect, test } from "bun:test";
import {
  STARTABLE_AUTH_PROVIDERS,
  type AuthLink,
  type AuthStartResult,
} from "../src/auth-start.ts";
import {
  runAuthCommand,
  runInstallCommand,
  type AuthCommandDependencies,
  type InstallCommandDependencies,
} from "../src/install-auth.ts";
import type { InstallRecipe, InstallResult } from "../src/install.ts";

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

    expect(outputAtPrompt).toEqual(plan.map((recipe) => `${recipe.tool}: ${recipe.command}`));
  });

  test("does not run when confirmation is false", async () => {
    let runs = 0;

    await runInstallCommand(
      { yes: false },
      installDependencies({
        plan,
        confirm: async () => false,
        run: async () => {
          runs += 1;
          return { ok: true };
        },
      }),
    );

    expect(runs).toBe(0);
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

  test("fails safely when an installer fails", async () => {
    const output: string[] = [];

    await expect(
      runInstallCommand(
        { yes: true },
        installDependencies({
          plan,
          output,
          run: async () => ({
            ok: false,
            error: {
              code: "command-failed",
              origin: "box",
              message: "raw remote stderr with token-secret",
            },
          }),
        }),
      ),
    ).rejects.toThrow("Install stopped because Link reported command-failed from box.");
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
      ...STARTABLE_AUTH_PROVIDERS.map((provider) => `${provider}: startable`),
      "pi: manual SSH flow",
    ]);
    expect(links).toBe(0);
  });

  test("constructs Link from config and calls start once", async () => {
    const link = fakeLink();
    let linkOptions: { host: string; user: string } | undefined;
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
            start: async (provider) => {
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

function installDependencies(overrides: {
  readonly plan: readonly InstallRecipe[];
  readonly output?: string[];
  readonly confirm?: () => Promise<boolean | symbol | undefined>;
  readonly run?: (confirmed: boolean) => Promise<InstallResult>;
}): InstallCommandDependencies {
  return {
    readConfig: () => config,
    createLink: fakeLink,
    createInstall: () => ({
      plan: () => overrides.plan,
      run: overrides.run ?? (async () => ({ ok: true })),
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
