import type { ApplyAction, ApplyPlan } from "./apply.ts";
import type { AuthProviderStatus, AuthStatusReport, McpLoginStatus } from "./auth-start.ts";
import { parseGitIdentity, type GitIdentity } from "./git-identity.ts";
import type { LinkError, LinkResult } from "./link.ts";
import type { DenyRuleDescription } from "./manifest.ts";
import { noProgress, step, type Progress } from "./progress.ts";
import type { TipReport } from "./store.ts";
import { changedPaths } from "./sync.ts";

const PASEO_DAEMON_PORT = 6767;

export type StatusDependencyError = {
  readonly code: "inspection-failed";
  readonly origin: "operator" | "git-remote" | "box";
  readonly message: string;
};

export type StatusError = LinkError | StatusDependencyError;

export type StatusDependencies = {
  readonly link: {
    probe(): Promise<LinkResult>;
    readBoxTip(): Promise<LinkResult>;
    readBoxChanges(): Promise<LinkResult>;
    readBoxGitIdentity(): Promise<LinkResult>;
    /** Print `yes` when sudo on the box runs without a password, else `no`. */
    readBoxSudo(): Promise<LinkResult>;
  };
  /** The `[update]` config key `watch`. */
  readonly updateWatch: boolean;
  readonly operator: {
    gitIdentity(): Promise<GitIdentity>;
  };
  readonly store: {
    inspectTips(boxTip: string | null): Promise<TipReport>;
  };
  readonly apply: {
    plan(): ApplyPlan | Promise<ApplyPlan>;
  };
  readonly auth: {
    status(): Promise<AuthStatusReport>;
    mcpStatus(): Promise<readonly McpLoginStatus[]>;
  };
  readonly manifest: {
    denyRules(): readonly DenyRuleDescription[];
  };
  readonly progress?: Progress;
};

export type StatusReport = {
  readonly schemaVersion: 1;
  readonly link: {
    readonly online: boolean;
    readonly address: string | null;
    readonly error: LinkError | StatusDependencyError | null;
  };
  readonly store: TipReport & { readonly error: StatusDependencyError | null };
  readonly boxCheckout: {
    readonly dirty: boolean | null;
    readonly changes: readonly string[];
    readonly error: LinkError | StatusDependencyError | null;
  };
  readonly gitIdentity: {
    readonly box: GitIdentity | null;
    readonly operator: GitIdentity | null;
    readonly boxConfigured: boolean | null;
    readonly matchesOperator: boolean | null;
    readonly error: LinkError | StatusDependencyError | null;
  };
  readonly boxSudo: {
    readonly passwordless: boolean | null;
    /** True when the watch runs updates and sudo asks for a password, so the gh update fails. */
    readonly watchUpdateBlocked: boolean;
    readonly error: LinkError | StatusDependencyError | null;
  };
  readonly managedPaths: {
    readonly allHealthy: boolean | null;
    readonly unhealthy: readonly ApplyAction[];
    readonly error: StatusDependencyError | null;
  };
  readonly auth: {
    readonly providers: readonly AuthProviderStatus[];
    readonly loginRequired: readonly string[];
    readonly error: StatusDependencyError | null;
  };
  readonly mcpLogins: {
    /** Box MCP servers that need a login, as `tool/server`. */
    readonly loginRequired: readonly string[];
    readonly error: StatusDependencyError | null;
  };
  readonly paseo: {
    readonly address: string | null;
    readonly port: 6767;
    readonly listen: string | null;
  };
  readonly denyList: readonly DenyRuleDescription[];
  readonly errors: readonly StatusError[];
};

/** Compose one read-only report from module-owned inspection methods. */
export async function composeStatus(dependencies: StatusDependencies): Promise<StatusReport> {
  const progress = dependencies.progress ?? noProgress;
  const errors: StatusError[] = [];
  let denyList: readonly DenyRuleDescription[] = [];
  try {
    denyList = dependencies.manifest.denyRules();
  } catch (cause) {
    errors.push(dependencyError("operator", cause));
  }

  let online = false;
  let address: string | null = null;
  let linkError: LinkError | StatusDependencyError | null = null;
  try {
    const result = await inspect(progress, "Connecting to the box", () => dependencies.link.probe());
    if (result.ok) {
      online = true;
      address = result.address;
    } else {
      linkError = result.error;
    }
  } catch (cause) {
    linkError = dependencyError("operator", cause);
  }
  if (linkError) errors.push(linkError);

  let boxTip: string | null = null;
  if (online) {
    try {
      const result = await inspect(progress, "Reading the box store tip", () => dependencies.link.readBoxTip());
      if (result.ok) boxTip = result.stdout.trim() || null;
      else errors.push(result.error);
    } catch (cause) {
      errors.push(dependencyError("box", cause));
    }
  }

  let boxCheckoutError: LinkError | StatusDependencyError | null = null;
  let changes: readonly string[] = [];
  let dirty: boolean | null = null;
  if (online) {
    try {
      const result = await inspect(progress, "Reading the box checkout changes", () =>
        dependencies.link.readBoxChanges(),
      );
      if (result.ok) {
        changes = changedPaths(result.stdout);
        dirty = changes.length > 0;
      } else {
        boxCheckoutError = result.error;
      }
    } catch (cause) {
      boxCheckoutError = dependencyError("box", cause);
    }
    if (boxCheckoutError) errors.push(boxCheckoutError);
  }

  let gitIdentityError: LinkError | StatusDependencyError | null = null;
  let boxIdentity: GitIdentity | null = null;
  if (online) {
    try {
      const result = await inspect(progress, "Reading the box git identity", () =>
        dependencies.link.readBoxGitIdentity(),
      );
      if (result.ok) boxIdentity = parseGitIdentity(result.stdout);
      else gitIdentityError = result.error;
    } catch (cause) {
      gitIdentityError = dependencyError("box", cause);
    }
    if (gitIdentityError) errors.push(gitIdentityError);
  }

  let boxSudoError: LinkError | StatusDependencyError | null = null;
  let passwordless: boolean | null = null;
  if (online) {
    try {
      const result = await inspect(progress, "Checking sudo on the box", () => dependencies.link.readBoxSudo());
      if (result.ok) passwordless = parseSudoCheck(result.stdout);
      else boxSudoError = result.error;
    } catch (cause) {
      boxSudoError = dependencyError("box", cause);
    }
    if (boxSudoError) errors.push(boxSudoError);
  }

  let operatorIdentity: GitIdentity | null = null;
  try {
    operatorIdentity = await dependencies.operator.gitIdentity();
  } catch (cause) {
    const operatorError = dependencyError("operator", cause);
    gitIdentityError ??= operatorError;
    errors.push(operatorError);
  }
  const boxConfigured = boxIdentity && boxIdentity.name !== null && boxIdentity.email !== null;
  const matchesOperator =
    boxIdentity && operatorIdentity
      ? Boolean(boxConfigured) &&
        boxIdentity.name === operatorIdentity.name &&
        boxIdentity.email === operatorIdentity.email
      : null;

  let storeError: StatusDependencyError | null = null;
  let store = emptyTips(boxTip);
  try {
    store = await inspect(progress, "Comparing the store tips", () => dependencies.store.inspectTips(boxTip));
  } catch (cause) {
    storeError = dependencyError("git-remote", cause);
    errors.push(storeError);
  }

  let managedPathsError: StatusDependencyError | null = null;
  let unhealthy: readonly ApplyAction[] = [];
  let allHealthy: boolean | null = null;
  if (online) {
    try {
      const applyPlan = await inspect(progress, "Checking managed links on the box", () => dependencies.apply.plan());
      unhealthy = applyPlan.actions;
      allHealthy = unhealthy.length === 0;
    } catch (cause) {
      managedPathsError = dependencyError("box", cause);
      errors.push(managedPathsError);
    }
  }

  let authError: StatusDependencyError | null = null;
  let providers: readonly AuthProviderStatus[] = [];
  if (online) {
    try {
      providers = (await inspect(progress, "Checking logins on the box", () => dependencies.auth.status())).providers;
      for (const provider of providers) {
        if (provider.status === "unavailable") errors.push(provider.error);
      }
    } catch (cause) {
      authError = dependencyError("box", cause);
      errors.push(authError);
    }
  }
  const loginRequired = providers
    .filter((provider) => provider.status === "login-required" || provider.status === "manual")
    .map((provider) => provider.provider);

  let mcpError: StatusDependencyError | null = null;
  const mcpLoginRequired: string[] = [];
  if (online) {
    try {
      for (const status of await inspect(progress, "Checking MCP logins on the box", () =>
        dependencies.auth.mcpStatus(),
      )) {
        if ("error" in status) errors.push(status.error);
        else mcpLoginRequired.push(...status.loginRequired.map((server) => `${status.tool}/${server}`));
      }
    } catch (cause) {
      mcpError = dependencyError("box", cause);
      errors.push(mcpError);
    }
  }

  return {
    schemaVersion: 1,
    link: { online, address, error: linkError },
    store: { ...store, error: storeError },
    boxCheckout: { dirty, changes, error: boxCheckoutError },
    gitIdentity: {
      box: boxIdentity,
      operator: operatorIdentity,
      boxConfigured,
      matchesOperator,
      error: gitIdentityError,
    },
    boxSudo: {
      passwordless,
      watchUpdateBlocked: dependencies.updateWatch && passwordless === false,
      error: boxSudoError,
    },
    managedPaths: { allHealthy, unhealthy, error: managedPathsError },
    auth: { providers, loginRequired, error: authError },
    mcpLogins: { loginRequired: mcpLoginRequired, error: mcpError },
    paseo: {
      address,
      port: PASEO_DAEMON_PORT,
      listen: address ? `${address}:${PASEO_DAEMON_PORT}` : null,
    },
    denyList,
    errors,
  };
}

/** Run one inspection as a progress step. A failed Link result is a failed step. */
function inspect<T>(progress: Progress, name: string, work: () => T | Promise<T>): Promise<T> {
  return step(progress, name, work, (result) =>
    typeof result === "object" && result !== null && "ok" in result && result.ok === false,
  );
}

function parseSudoCheck(stdout: string): boolean {
  const answer = stdout.trim();
  if (answer === "yes") return true;
  if (answer === "no") return false;
  throw new Error("unexpected sudo check output");
}

function emptyTips(box: string | null): TipReport {
  return {
    local: null,
    remote: null,
    box,
    localMatchesRemote: false,
    remoteMatchesBox: false,
    allMatch: false,
  };
}

function dependencyError(
  origin: StatusDependencyError["origin"],
  cause: unknown,
): StatusDependencyError {
  const source = origin === "git-remote" ? "git remote" : origin;
  const detail = cause instanceof Error ? cause.message : String(cause);
  return { code: "inspection-failed", origin, message: `${source}: ${detail}` };
}
