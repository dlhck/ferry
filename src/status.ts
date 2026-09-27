import type { ApplyAction, ApplyPlan } from "./apply.ts";
import type { AuthProviderStatus, AuthStatusReport } from "./auth-start.ts";
import type { LinkError, LinkResult } from "./link.ts";
import type { DenyRuleDescription } from "./manifest.ts";
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
  };
  readonly store: {
    inspectTips(boxTip: string | null): Promise<TipReport>;
  };
  readonly apply: {
    plan(): ApplyPlan | Promise<ApplyPlan>;
  };
  readonly auth: {
    status(): Promise<AuthStatusReport>;
  };
  readonly manifest: {
    denyRules(): readonly DenyRuleDescription[];
  };
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
    const result = await dependencies.link.probe();
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
      const result = await dependencies.link.readBoxTip();
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
      const result = await dependencies.link.readBoxChanges();
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

  let storeError: StatusDependencyError | null = null;
  let store = emptyTips(boxTip);
  try {
    store = await dependencies.store.inspectTips(boxTip);
  } catch (cause) {
    storeError = dependencyError("git-remote", cause);
    errors.push(storeError);
  }

  let managedPathsError: StatusDependencyError | null = null;
  let unhealthy: readonly ApplyAction[] = [];
  let allHealthy: boolean | null = null;
  if (online) {
    try {
      const applyPlan = await dependencies.apply.plan();
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
      providers = (await dependencies.auth.status()).providers;
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

  return {
    schemaVersion: 1,
    link: { online, address, error: linkError },
    store: { ...store, error: storeError },
    boxCheckout: { dirty, changes, error: boxCheckoutError },
    managedPaths: { allHealthy, unhealthy, error: managedPathsError },
    auth: { providers, loginRequired, error: authError },
    paseo: {
      address,
      port: PASEO_DAEMON_PORT,
      listen: address ? `${address}:${PASEO_DAEMON_PORT}` : null,
    },
    denyList,
    errors,
  };
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
