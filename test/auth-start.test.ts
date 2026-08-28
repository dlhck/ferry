import { describe, expect, test } from "bun:test";
import {
  AuthStart,
  STARTABLE_AUTH_PROVIDERS,
  type AuthLink,
  type AuthProvider,
} from "../src/auth-start.ts";
import type { ForwardOptions, LinkResult, RunOptions } from "../src/link.ts";

type RunCall = {
  readonly command: string;
  readonly options: RunOptions | undefined;
};

class FakeLink implements AuthLink {
  readonly runs: RunCall[] = [];
  readonly forwards: ForwardOptions[] = [];

  constructor(
    private readonly runResults: LinkResult[] = [],
    private readonly forwardResults: LinkResult[] = [],
  ) {}

  async run(command: string, options?: RunOptions): Promise<LinkResult> {
    this.runs.push({ command, options });
    const result = this.runResults.shift();
    if (!result) throw new Error(`unexpected run: ${command}`);
    return result;
  }

  async forward(options: ForwardOptions): Promise<LinkResult> {
    this.forwards.push(options);
    const result = this.forwardResults.shift();
    if (!result) throw new Error(`unexpected forward: ${JSON.stringify(options)}`);
    return result;
  }
}

function success(stdout = ""): LinkResult {
  return { ok: true, address: "build-box.example.ts.net", stdout, stderr: "" };
}

function loggedOut(): LinkResult {
  return {
    ok: false,
    error: { code: "command-failed", origin: "box", message: "not logged in" },
  };
}

const providerCases: readonly {
  readonly provider: AuthProvider;
  readonly probe: RegExp;
  readonly login: RegExp;
  readonly output: string;
  readonly action: "device-url" | "printed-url";
}[] = [
  {
    provider: "gh",
    probe: /^gh auth status --hostname github\.com$/,
    login: /^gh auth login .*--hostname github\.com.*--web/,
    output: "First copy your one-time code: A1B2-C3D4\nOpen https://github.com/login/device\n",
    action: "device-url",
  },
  {
    provider: "claude",
    probe: /^claude auth status$/,
    login: /^claude auth login$/,
    output: "Open https://claude.ai/oauth/authorize?state=opaque in your browser\n",
    action: "printed-url",
  },
  {
    provider: "codex",
    probe: /^codex login status$/,
    login: /^codex login --device-auth$/,
    output: "Open https://auth.openai.com/codex/device and enter ABCD-EFGH\n",
    action: "device-url",
  },
  {
    provider: "cursor",
    probe: /^cursor-agent status$/,
    login: /^cursor-agent login$/,
    output: "Open https://cursor.com/auth/cli?state=opaque in your browser\n",
    action: "printed-url",
  },
];

describe("AuthStart", () => {
  test("starts each documented provider with its remote command recipe", async () => {
    expect(STARTABLE_AUTH_PROVIDERS).toEqual(["gh", "claude", "codex", "cursor"]);

    for (const providerCase of providerCases) {
      const link = new FakeLink([loggedOut(), success(providerCase.output)]);

      const result = await new AuthStart(link).start(providerCase.provider);

      expect(link.runs).toHaveLength(2);
      expect(link.runs[0]?.command).toMatch(providerCase.probe);
      expect(link.runs[1]?.command).toMatch(providerCase.login);
      expect(result.kind).toBe(providerCase.action);
    }
  });

  test("returns already-done without starting another login", async () => {
    const link = new FakeLink([success()]);

    const result = await new AuthStart(link).start("gh");

    expect(result).toEqual({ kind: "already-done", provider: "gh" });
    expect(link.runs).toHaveLength(1);
    expect(link.forwards).toHaveLength(0);
  });

  test("refuses compatibility credential input before any Link call", async () => {
    const link = new FakeLink();
    const startWithLegacyInput = new AuthStart(link).start as unknown as (
      provider: AuthProvider,
      input: unknown,
    ) => Promise<unknown>;

    const result = await startWithLegacyInput("claude", {
      credentialPath: "/Users/operator/.claude/.credentials.json",
      bytes: new Uint8Array([1, 2, 3]),
    });

    expect(result).toEqual({
      kind: "refused",
      code: "credential-input",
      message: "AuthStart accepts only a provider. Logins are not copied.",
    });
    expect(link.runs).toHaveLength(0);
    expect(link.forwards).toHaveLength(0);
  });

  test("does not expose token-like command output", async () => {
    const token = "sk-test-secret-value";
    const link = new FakeLink([
      loggedOut(),
      success(`Open https://cursor.com/auth/cli?state=opaque\nAccess token: ${token}\n`),
    ]);

    const result = await new AuthStart(link).start("cursor");

    expect(result).toEqual({
      kind: "printed-url",
      provider: "cursor",
      url: "https://cursor.com/auth/cli?state=opaque",
    });
    expect(JSON.stringify(result)).not.toContain(token);
  });

  test("preserves a Link forward-timeout on the Codex callback fallback", async () => {
    const timeout: LinkResult = {
      ok: false,
      error: {
        code: "forward-timeout",
        origin: "network",
        message: "the port forward timed out after 120000 ms",
      },
    };
    const link = new FakeLink(
      [
        loggedOut(),
        loggedOut(),
        success(
          "Starting local login server on http://localhost:1455.\nOpen https://auth.openai.com/oauth/authorize?state=opaque\n",
        ),
      ],
      [timeout],
    );

    const result = await new AuthStart(link).start("codex");

    expect(link.runs.map((call) => call.command)).toEqual([
      "codex login status",
      "codex login --device-auth",
      "codex login",
    ]);
    expect(link.forwards).toEqual([
      { localPort: 1455, remotePort: 1455, remoteHost: "127.0.0.1", timeoutMs: 120_000 },
    ]);
    expect(result).toEqual({ kind: "link-failure", provider: "codex", result: timeout });
  });

  test("returns manual SSH guidance for Pi without starting an interactive TTY", async () => {
    const link = new FakeLink();

    const result = await new AuthStart(link).start("pi");

    expect(result).toEqual({
      kind: "manual-ssh",
      provider: "pi",
      command: "pi",
      instruction: "SSH to the box, run pi, then use /login in its interactive session.",
    });
    expect(link.runs).toHaveLength(0);
    expect(link.forwards).toHaveLength(0);
  });
});
