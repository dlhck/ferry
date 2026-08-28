/**
 * AuthStart starts a vendor login on the box and returns the step the operator
 * finishes here. It reads its recipes from the tool registry and never accepts
 * or reads a credential file from the operator machine.
 */

import type {
  ForwardOptions,
  LinkError,
  LinkErrorCode,
  LinkFailure,
  LinkOrigin,
  LinkResult,
  RunOptions,
} from "./link.ts";
import type { AuthFallback, ToolAuth, ToolDescriptor } from "./registry/types.ts";

/** A tool ferry has a login recipe for. */
export type AuthTool = ToolDescriptor & { readonly auth: ToolAuth };

/**
 * The tools with a login recipe, in report order: the ones ferry can probe
 * first, then the manual ones, which carry guidance rather than a state.
 */
export function authTools(tools: readonly ToolDescriptor[]): readonly AuthTool[] {
  const withAuth = tools.filter((tool): tool is AuthTool => tool.auth !== undefined);
  return [
    ...withAuth.filter((tool) => tool.auth.completion.kind !== "manual"),
    ...withAuth.filter((tool) => tool.auth.completion.kind === "manual"),
  ];
}

export type AuthProviderStatus =
  | { readonly provider: string; readonly status: "authenticated" }
  | { readonly provider: string; readonly status: "login-required" }
  | {
      readonly provider: string;
      readonly status: "manual";
      readonly instruction: string;
    }
  | {
      readonly provider: string;
      readonly status: "unavailable";
      readonly error: LinkError;
    };

export type AuthStatusReport = { readonly providers: readonly AuthProviderStatus[] };

export interface AuthLink {
  run(command: string, options?: RunOptions): Promise<LinkResult>;
  forward(options: ForwardOptions): Promise<LinkResult>;
}

export type AuthStartResult =
  | { readonly kind: "already-done"; readonly provider: string }
  | {
      readonly kind: "device-url";
      readonly provider: string;
      readonly url: string;
      readonly userCode?: string;
    }
  | {
      readonly kind: "printed-url";
      readonly provider: string;
      readonly url: string;
    }
  | {
      readonly kind: "local-port-forward";
      readonly provider: string;
      readonly url: string;
      readonly localPort: number;
      readonly remotePort: number;
      readonly timeoutMs: number;
    }
  | {
      readonly kind: "manual-ssh";
      readonly provider: string;
      readonly command: string;
      readonly instruction: string;
    }
  | {
      readonly kind: "link-failure";
      readonly provider: string;
      readonly result: LinkFailure;
    }
  | {
      readonly kind: "failed";
      readonly provider: string;
      readonly code: "login-output";
      readonly message: string;
    }
  | {
      readonly kind: "refused";
      readonly code: "credential-input" | "invalid-provider";
      readonly message: string;
    };

export class AuthStart {
  constructor(
    private readonly link: AuthLink,
    private readonly tools: readonly ToolDescriptor[],
  ) {}

  /** The providers a login can be started for. Manual providers are not listed. */
  startableProviders(): readonly string[] {
    return authTools(this.tools)
      .filter((tool) => tool.auth.completion.kind !== "manual")
      .map((tool) => tool.id);
  }

  /** Run authentication probes only. This method never starts a login or forward. */
  async status(): Promise<AuthStatusReport> {
    const providers: AuthProviderStatus[] = [];

    for (const tool of authTools(this.tools)) {
      const completion = tool.auth.completion;
      if (completion.kind === "manual") {
        providers.push({
          provider: tool.id,
          status: "manual",
          instruction: completion.instruction,
        });
        continue;
      }
      if (!tool.auth.probe) continue;

      const probe = await this.link.run(tool.auth.probe);
      if (probe.ok) {
        providers.push({ provider: tool.id, status: "authenticated" });
      } else if (probe.error.code === "command-failed") {
        providers.push({ provider: tool.id, status: "login-required" });
      } else {
        providers.push({
          provider: tool.id,
          status: "unavailable",
          error: {
            code: probe.error.code,
            origin: probe.error.origin,
            message: safeLinkMessage(probe.error.code, probe.error.origin),
          },
        });
      }
    }
    return { providers };
  }

  async start(provider: string): Promise<AuthStartResult> {
    if (arguments.length !== 1) {
      return {
        kind: "refused",
        code: "credential-input",
        message: "AuthStart accepts only a provider. Logins are not copied.",
      };
    }

    const auth = this.tools.find((tool) => tool.id === provider)?.auth;
    if (!auth) {
      return {
        kind: "refused",
        code: "invalid-provider",
        message: "AuthStart received an unknown provider.",
      };
    }

    const completion = auth.completion;
    if (completion.kind === "manual") {
      return {
        kind: "manual-ssh",
        provider,
        command: completion.command,
        instruction: completion.instruction,
      };
    }
    if (!auth.probe || !auth.login) {
      return {
        kind: "refused",
        code: "invalid-provider",
        message: `The ${provider} provider has no login recipe.`,
      };
    }

    const probe = await this.link.run(auth.probe);
    if (probe.ok) return { kind: "already-done", provider };
    if (probe.error.code !== "command-failed") return linkFailure(provider, probe);

    const login = await this.link.run(auth.login);
    if (!login.ok) {
      if (auth.fallback && login.error.code === "command-failed") {
        return this.startFallback(provider, auth.fallback);
      }
      return linkFailure(provider, login);
    }

    if (completion.kind === "device-url") {
      const userCode = completion.codePattern
        ? login.stdout.match(new RegExp(completion.codePattern))?.[0]
        : undefined;
      return userCode
        ? { kind: "device-url", provider, url: completion.url, userCode }
        : { kind: "device-url", provider, url: completion.url };
    }
    const url = safeUrl(login.stdout, completion.allowedHosts);
    return url ? { kind: "printed-url", provider, url } : missingUrl(provider);
  }

  /** The declared callback path: a second login command plus a local forward. */
  private async startFallback(
    provider: string,
    fallback: AuthFallback,
  ): Promise<AuthStartResult> {
    const login = await this.link.run(fallback.login);
    if (!login.ok) return linkFailure(provider, login);

    const url = safeUrl(login.stdout, fallback.allowedHosts);
    if (!url) return missingUrl(provider);

    const forward = await this.link.forward(fallback.forward);
    if (!forward.ok) return linkFailure(provider, forward, true);

    return {
      kind: "local-port-forward",
      provider,
      url,
      localPort: fallback.forward.localPort,
      remotePort: fallback.forward.remotePort,
      timeoutMs: fallback.forward.timeoutMs,
    };
  }
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

function missingUrl(provider: string): AuthStartResult {
  return {
    kind: "failed",
    provider,
    code: "login-output",
    message: `The ${provider} login did not return a safe operator URL.`,
  };
}

function linkFailure(
  provider: string,
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
