import type { ApplyAction, ApplyPlan } from "./apply.ts";
import type { AuthProviderStatus, AuthStatusReport, McpLoginStatus } from "./auth-start.ts";
import { parseGitIdentity, type GitIdentity } from "./git-identity.ts";
import type { LinkError, LinkResult } from "./link.ts";
import type { IntegrationHealth, IntegrationId } from "./integrations/types.ts";
import type { DenyRuleDescription } from "./manifest.ts";
import { noProgress, plural, step, type Progress } from "./progress.ts";
import type { TipReport } from "./store.ts";
import { changedPaths } from "./sync.ts";

export type StatusDependencyError = {
  readonly code: "inspection-failed";
  readonly origin: "operator" | "git-remote" | "box";
  readonly message: string;
};

export type StatusError = LinkError | StatusDependencyError;

/** The read-only inspections of one box. */
export type BoxStatusDependencies = {
  readonly name: string;
  /** The destination of the box, for example `dev@box-a.example`. */
  readonly host: string;
  readonly link: {
    probe(): Promise<LinkResult>;
    readBoxTip(): Promise<LinkResult>;
    readBoxChanges(): Promise<LinkResult>;
    readBoxGitIdentity(): Promise<LinkResult>;
    /** Print `yes` when sudo on the box runs without a password, else `no`. */
    readBoxSudo(): Promise<LinkResult>;
  };
  /** True when `[update] watch = true` and the policy of gh is `latest` for this box, so the daily watch update runs the gh update. */
  readonly watchUpdatesGh: boolean;
  readonly apply: {
    plan(): ApplyPlan | Promise<ApplyPlan>;
  };
  readonly auth: {
    status(): Promise<AuthStatusReport>;
    mcpStatus(): Promise<readonly McpLoginStatus[]>;
  };
  /** The integrations that are enabled for this box only. */
  readonly integrations?: readonly {
    readonly id: IntegrationId;
    readonly name: string;
    health(): Promise<IntegrationHealth>;
  }[];
};

export type StatusDependencies = {
  readonly operator: {
    gitIdentity(): Promise<GitIdentity>;
  };
  readonly store: {
    inspectTips(boxTip: string | null): Promise<TipReport>;
  };
  readonly manifest: {
    denyRules(): readonly DenyRuleDescription[];
  };
  /** The selected boxes, in config order. */
  readonly boxes: readonly BoxStatusDependencies[];
  readonly progress?: Progress;
};

/** The health of one enabled integration. `state` is the machine-readable part. */
export type IntegrationStatus = {
  readonly name: string;
  readonly lines: readonly string[];
  readonly warnings: readonly string[];
  readonly state: Readonly<Record<string, unknown>>;
};

export type BoxStatus = {
  readonly name: string;
  readonly host: string;
  readonly link: {
    readonly online: boolean;
    readonly address: string | null;
    readonly error: LinkError | StatusDependencyError | null;
  };
  /** The store tip of the box checkout. */
  readonly tip: string | null;
  readonly remoteMatchesBox: boolean;
  /** True when the local tip, the remote tip, and the box tip are the same. */
  readonly allMatch: boolean;
  readonly boxCheckout: {
    readonly dirty: boolean | null;
    readonly changes: readonly string[];
    readonly error: LinkError | StatusDependencyError | null;
  };
  readonly gitIdentity: {
    readonly box: GitIdentity | null;
    readonly boxConfigured: boolean | null;
    readonly matchesOperator: boolean | null;
    readonly error: LinkError | StatusDependencyError | null;
  };
  readonly boxSudo: {
    readonly passwordless: boolean | null;
    /** True when the watch updates gh and sudo asks for a password, so the gh update fails. */
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
  /** Present only when at least one integration is enabled for this box. */
  readonly integrations?: Readonly<Partial<Record<IntegrationId, IntegrationStatus>>>;
  /** The errors of this box. */
  readonly errors: readonly StatusError[];
};

export type StatusReport = {
  readonly schemaVersion: 2;
  /** The local and remote store tips. Each box has its own tip. */
  readonly store: {
    readonly local: string | null;
    readonly remote: string | null;
    readonly localMatchesRemote: boolean;
    readonly error: StatusDependencyError | null;
  };
  readonly operator: {
    readonly gitIdentity: GitIdentity | null;
    readonly error: StatusDependencyError | null;
  };
  readonly denyList: readonly DenyRuleDescription[];
  /** One entry for each selected box, in config order. */
  readonly boxes: readonly BoxStatus[];
  /** The operator and git remote errors only. Each box has its own errors. */
  readonly errors: readonly StatusError[];
};

/** Boxes that status inspects at the same time. */
const BOX_LIMIT = 4;

/** Compose one read-only report from module-owned inspection methods. */
export async function composeStatus(dependencies: StatusDependencies): Promise<StatusReport> {
  const progress = dependencies.progress ?? noProgress;
  progress.plan(
    1 + dependencies.boxes.reduce((total, box) => total + BOX_STEPS + (box.integrations?.length ?? 0), 0),
  );
  const errors: StatusError[] = [];
  let denyList: readonly DenyRuleDescription[] = [];
  try {
    denyList = dependencies.manifest.denyRules();
  } catch (cause) {
    errors.push(dependencyError("operator", cause));
  }

  let operatorIdentity: GitIdentity | null = null;
  let operatorError: StatusDependencyError | null = null;
  try {
    operatorIdentity = await dependencies.operator.gitIdentity();
  } catch (cause) {
    operatorError = dependencyError("operator", cause);
    errors.push(operatorError);
  }

  let storeError: StatusDependencyError | null = null;
  let local: string | null = null;
  let remote: string | null = null;
  try {
    ({ local, remote } = await inspect(progress, "Comparing the store tips", () =>
      dependencies.store.inspectTips(null),
    ));
  } catch (cause) {
    storeError = dependencyError("git-remote", cause);
    errors.push(storeError);
  }

  const shared: SharedStatus = { local, remote, operatorIdentity };
  const boxProgress = orderedProgress(progress, dependencies.boxes.map((box) => box.name));
  const boxes = await mapLimit(dependencies.boxes, BOX_LIMIT, async (box, index) => {
    try {
      return await composeBoxStatus(box, shared, boxProgress.views[index]!);
    } finally {
      boxProgress.end(index);
    }
  });

  return {
    schemaVersion: 2,
    store: { local, remote, localMatchesRemote: local !== null && local === remote, error: storeError },
    operator: { gitIdentity: operatorIdentity, error: operatorError },
    denyList,
    boxes,
    errors,
  };
}

type SharedStatus = {
  readonly local: string | null;
  readonly remote: string | null;
  readonly operatorIdentity: GitIdentity | null;
};

/** The steps of one box without its integrations. */
const BOX_STEPS = 8;

async function composeBoxStatus(
  dependencies: BoxStatusDependencies,
  shared: SharedStatus,
  progress: Progress,
): Promise<BoxStatus> {
  const enabledIntegrations = dependencies.integrations ?? [];
  const errors: StatusError[] = [];

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
  } else {
    progress.skip("Reading the box store tip", OFFLINE);
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
  } else {
    progress.skip("Reading the box checkout changes", OFFLINE);
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
  } else {
    progress.skip("Reading the box git identity", OFFLINE);
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
  } else {
    progress.skip("Checking sudo on the box", OFFLINE);
  }

  const operatorIdentity = shared.operatorIdentity;
  const boxConfigured = boxIdentity && boxIdentity.name !== null && boxIdentity.email !== null;
  const matchesOperator =
    boxIdentity && operatorIdentity
      ? Boolean(boxConfigured) &&
        boxIdentity.name === operatorIdentity.name &&
        boxIdentity.email === operatorIdentity.email
      : null;

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
  } else {
    progress.skip("Checking managed links on the box", OFFLINE);
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
  } else {
    progress.skip("Checking logins on the box", OFFLINE);
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
  } else {
    progress.skip("Checking MCP logins on the box", OFFLINE);
  }

  const integrations: Partial<Record<IntegrationId, IntegrationStatus>> = {};
  for (const integration of enabledIntegrations) {
    const name = `Checking ${integration.name} on the box`;
    if (!online) {
      progress.skip(name, OFFLINE);
      integrations[integration.id] = {
        name: integration.name,
        lines: ["unavailable while host is offline"],
        warnings: [],
        state: { error: OFFLINE },
      };
      continue;
    }
    try {
      const health = await step(progress, name, () => integration.health(), undefined, (health) =>
        health.warnings.length > 0 ? plural(health.warnings.length, "warning") : undefined,
      );
      integrations[integration.id] = {
        name: integration.name,
        lines: health.lines,
        warnings: health.warnings,
        state: health.json,
      };
    } catch (cause) {
      const error = dependencyError("box", cause);
      errors.push(error);
      integrations[integration.id] = {
        name: integration.name,
        lines: ["unavailable"],
        warnings: [],
        state: { error: error.message },
      };
    }
  }

  const localMatchesRemote = shared.local !== null && shared.local === shared.remote;
  const remoteMatchesBox = shared.remote !== null && shared.remote === boxTip;
  return {
    name: dependencies.name,
    host: dependencies.host,
    link: { online, address, error: linkError },
    tip: boxTip,
    remoteMatchesBox,
    allMatch: localMatchesRemote && remoteMatchesBox,
    boxCheckout: { dirty, changes, error: boxCheckoutError },
    gitIdentity: { box: boxIdentity, boxConfigured, matchesOperator, error: gitIdentityError },
    boxSudo: {
      passwordless,
      watchUpdateBlocked: dependencies.watchUpdatesGh && passwordless === false,
      error: boxSudoError,
    },
    managedPaths: { allHealthy, unhealthy, error: managedPathsError },
    auth: { providers, loginRequired, error: authError },
    mcpLogins: { loginRequired: mcpLoginRequired, error: mcpError },
    ...(enabledIntegrations.length > 0 ? { integrations } : {}),
    errors,
  };
}

/**
 * Run `work` for each item, with at most `limit` items at the same time.
 * The results keep the order of the items.
 */
async function mapLimit<T, R>(
  items: readonly T[],
  limit: number,
  work: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const index = next++;
      results[index] = await work(items[index]!, index);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

/**
 * One Progress for each box. A reporter shows one step at a time, so only the
 * first box that has not ended writes to it. The other boxes keep their
 * events, and write them in box order when the boxes before them end. With
 * more than one box, each step name starts with `[<name>] `.
 */
function orderedProgress(
  progress: Progress,
  names: readonly string[],
): { readonly views: readonly Progress[]; end(index: number): void } {
  if (names.length === 1) return { views: [progress], end() {} };
  let head = 0;
  const queues = names.map((): Array<() => void> => []);
  const ended = names.map(() => false);
  const views = names.map((box, index): Progress => {
    const send = (event: () => void) => {
      if (index === head) event();
      else queues[index]!.push(event);
    };
    return {
      ...noProgress,
      start: (name) => send(() => progress.start(`[${box}] ${name}`)),
      count: (current, total) => send(() => progress.count(current, total)),
      done: (detail) => send(() => progress.done(detail)),
      fail: (detail) => send(() => progress.fail(detail)),
      skip: (name, detail) => send(() => progress.skip(`[${box}] ${name}`, detail)),
    };
  });
  return {
    views,
    end(index) {
      ended[index] = true;
      while (head < names.length && ended[head]) {
        head += 1;
        for (const event of queues[head]?.splice(0) ?? []) event();
      }
    },
  };
}

const OFFLINE = "host offline";

/** Run one inspection as a progress step. A failed Link result is a failed step, with its error code as detail. */
function inspect<T>(progress: Progress, name: string, work: () => T | Promise<T>): Promise<T> {
  return step(
    progress,
    name,
    work,
    (result) => linkError(result) !== null,
    (result) => {
      const error = linkError(result);
      return error ? `${error.origin}/${error.code}` : undefined;
    },
  );
}

function linkError(result: unknown): LinkError | null {
  return typeof result === "object" && result !== null && "ok" in result && result.ok === false && "error" in result
    ? (result.error as LinkError)
    : null;
}

function parseSudoCheck(stdout: string): boolean {
  const answer = stdout.trim();
  if (answer === "yes") return true;
  if (answer === "no") return false;
  throw new Error("unexpected sudo check output");
}

function dependencyError(
  origin: StatusDependencyError["origin"],
  cause: unknown,
): StatusDependencyError {
  const source = origin === "git-remote" ? "git remote" : origin;
  const detail = cause instanceof Error ? cause.message : String(cause);
  return { code: "inspection-failed", origin, message: `${source}: ${detail}` };
}
