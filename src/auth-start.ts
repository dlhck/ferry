import type {
  ForwardOptions,
  LinkErrorCode,
  LinkFailure,
  LinkOrigin,
  LinkResult,
  RunOptions,
} from "./link.ts";

export const STARTABLE_AUTH_PROVIDERS = ["gh", "claude", "codex", "cursor"] as const;

export type StartableAuthProvider = (typeof STARTABLE_AUTH_PROVIDERS)[number];
export type AuthProvider = StartableAuthProvider | "pi";

export interface AuthLink {
  run(command: string, options?: RunOptions): Promise<LinkResult>;
  forward(options: ForwardOptions): Promise<LinkResult>;
}

export type AuthStartResult =
  | { readonly kind: "already-done"; readonly provider: StartableAuthProvider }
  | {
      readonly kind: "device-url";
      readonly provider: "gh" | "codex";
      readonly url: string;
      readonly userCode?: string;
    }
  | {
      readonly kind: "printed-url";
      readonly provider: "claude" | "cursor";
      readonly url: string;
    }
  | {
      readonly kind: "local-port-forward";
      readonly provider: "codex";
      readonly url: string;
      readonly localPort: number;
      readonly remotePort: number;
      readonly timeoutMs: number;
    }
  | {
      readonly kind: "manual-ssh";
      readonly provider: "pi";
      readonly command: "pi";
      readonly instruction: string;
    }
  | {
      readonly kind: "link-failure";
      readonly provider: StartableAuthProvider;
      readonly result: LinkFailure;
    }
  | {
      readonly kind: "failed";
      readonly provider: StartableAuthProvider;
      readonly code: "login-output";
      readonly message: string;
    }
  | {
      readonly kind: "refused";
      readonly code: "credential-input" | "invalid-provider";
      readonly message: string;
    };

type Recipe = {
  readonly probe: string;
  readonly login: string;
};

const RECIPES: Readonly<Record<StartableAuthProvider, Recipe>> = {
  gh: {
    probe: "gh auth status --hostname github.com",
    login: "gh auth login --hostname github.com --git-protocol https --web",
  },
  claude: { probe: "claude auth status", login: "claude auth login" },
  codex: { probe: "codex login status", login: "codex login --device-auth" },
  cursor: { probe: "cursor-agent status", login: "cursor-agent login" },
};

const CODEX_FORWARD = {
  localPort: 1455,
  remotePort: 1455,
  remoteHost: "127.0.0.1",
  timeoutMs: 120_000,
} as const;

export class AuthStart {
  constructor(private readonly link: AuthLink) {}

  async start(provider: AuthProvider): Promise<AuthStartResult> {
    if (arguments.length !== 1) {
      return {
        kind: "refused",
        code: "credential-input",
        message: "AuthStart accepts only a provider. Logins are not copied.",
      };
    }
    if (!isAuthProvider(provider)) {
      return {
        kind: "refused",
        code: "invalid-provider",
        message: "AuthStart received an unknown provider.",
      };
    }
    if (provider === "pi") {
      return {
        kind: "manual-ssh",
        provider,
        command: "pi",
        instruction: "SSH to the box, run pi, then use /login in its interactive session.",
      };
    }

    const recipe = RECIPES[provider];
    const probe = await this.link.run(recipe.probe);
    if (probe.ok) return { kind: "already-done", provider };
    if (probe.error.code !== "command-failed") return linkFailure(provider, probe);

    const login = await this.link.run(recipe.login);
    if (!login.ok) {
      if (provider === "codex" && login.error.code === "command-failed") {
        return this.startCodexCallback();
      }
      return linkFailure(provider, login);
    }

    switch (provider) {
      case "gh":
        return deviceAction(provider, "https://github.com/login/device", login.stdout);
      case "codex":
        return deviceAction(provider, "https://auth.openai.com/codex/device", login.stdout);
      case "claude":
        return printedUrlAction(provider, login.stdout, ["claude.ai", "anthropic.com"]);
      case "cursor":
        return printedUrlAction(provider, login.stdout, ["cursor.com", "cursor.sh"]);
    }
  }

  private async startCodexCallback(): Promise<AuthStartResult> {
    const login = await this.link.run("codex login");
    if (!login.ok) return linkFailure("codex", login);

    const url = safeUrl(login.stdout, ["openai.com"]);
    if (!url) return missingUrl("codex");

    const forward = await this.link.forward(CODEX_FORWARD);
    if (!forward.ok) return linkFailure("codex", forward, true);

    return {
      kind: "local-port-forward",
      provider: "codex",
      url,
      localPort: CODEX_FORWARD.localPort,
      remotePort: CODEX_FORWARD.remotePort,
      timeoutMs: CODEX_FORWARD.timeoutMs,
    };
  }
}

function isAuthProvider(provider: unknown): provider is AuthProvider {
  return provider === "pi" || STARTABLE_AUTH_PROVIDERS.some((candidate) => candidate === provider);
}

function deviceAction(
  provider: "gh" | "codex",
  url: string,
  output: string,
): AuthStartResult {
  const userCode = output.match(/\b[A-Z0-9]{4}-[A-Z0-9]{4}\b/)?.[0];
  return userCode
    ? { kind: "device-url", provider, url, userCode }
    : { kind: "device-url", provider, url };
}

function printedUrlAction(
  provider: "claude" | "cursor",
  output: string,
  allowedHosts: readonly string[],
): AuthStartResult {
  const url = safeUrl(output, allowedHosts);
  return url ? { kind: "printed-url", provider, url } : missingUrl(provider);
}

function safeUrl(output: string, allowedHosts: readonly string[]): string | null {
  for (const match of output.matchAll(/https:\/\/[^\s<>"']+/g)) {
    const candidate = match[0].replace(/[),.;]+$/, "");
    try {
      const url = new URL(candidate);
      if (!allowedHosts.some((host) => url.hostname === host || url.hostname.endsWith(`.${host}`))) {
        continue;
      }
      if (url.hash || [...url.searchParams.keys()].some((key) => /token|secret|credential|api.?key/i.test(key))) {
        continue;
      }
      return url.toString();
    } catch {
      continue;
    }
  }
  return null;
}

function missingUrl(provider: StartableAuthProvider): AuthStartResult {
  return {
    kind: "failed",
    provider,
    code: "login-output",
    message: `The ${provider} login did not return a safe operator URL.`,
  };
}

function linkFailure(
  provider: StartableAuthProvider,
  result: LinkFailure,
  preserveForwardTimeout = false,
): AuthStartResult {
  if (preserveForwardTimeout && result.error.code === "forward-timeout") {
    return { kind: "link-failure", provider, result };
  }
  return {
    kind: "link-failure",
    provider,
    result: {
      ok: false,
      error: {
        code: result.error.code,
        origin: result.error.origin,
        message: safeLinkMessage(result.error.code, result.error.origin),
      },
    },
  };
}

function safeLinkMessage(code: LinkErrorCode, origin: LinkOrigin): string {
  return `AuthStart stopped because Link reported ${code} from ${origin}.`;
}
