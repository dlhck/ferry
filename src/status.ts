import type { BoxSkill } from "./adopt-box.ts";
import type { ApplyAction, ApplyPlan } from "./apply.ts";
import type { AuthProviderStatus, AuthStatusReport, McpLoginStatus } from "./auth-start.ts";
import type { BoxMcpIssue } from "./box-mcp.ts";
import type { BoxResources, ResourceLimits } from "./box-resources.ts";
import type { GitAuth } from "./config.ts";
import { parseGitIdentity, type GitIdentity } from "./git-identity.ts";
import type { UncarriedHookPath } from "./hook-paths.ts";
import type { LinkError, LinkResult } from "./link.ts";
import type { IntegrationHealth, IntegrationId } from "./integrations/types.ts";
import type { DenyRuleDescription } from "./manifest.ts";
import { groupProgress, noProgress, plural, step, type Progress } from "./progress.ts";
import type { TipReport } from "./store.ts";
import { changedPaths } from "./sync.ts";
import type { ToolStatus } from "./tools/check.ts";

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
  /** `git_auth` of the box. */
  readonly gitAuth: GitAuth;
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
  /** The carried stdio MCP servers of this box. Only the brief check reads them. */
  readonly mcpServers?: {
    check(): Promise<readonly BoxMcpIssue[]>;
  };
  /** The registry tools with the policies of this box. `online` is false when the box is offline. */
  readonly tools?: {
    check(online: boolean): Promise<readonly ToolStatus[]>;
  };
  /** The hook commands of the operator settings that refer to a home file the box will not have. */
  readonly hookPaths?: () => readonly UncarriedHookPath[];
  /** The integrations that are enabled for this box only. */
  readonly integrations?: readonly IntegrationCheck[];
  /** The skills on the box that its snapshot does not track. Only the full status reads them. */
  readonly boxSkills?: {
    list(): Promise<readonly BoxSkill[]>;
  };
  /** The disk, memory, and load that the probe read, and the limits. Only the brief check reads them. */
  readonly resources?: {
    read(): BoxResources | null;
    readonly limits: ResourceLimits;
  };
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
  /** The checks of the enabled integrations on this machine. */
  readonly integrations?: readonly IntegrationCheck[];
  readonly progress?: Progress;
};

/** The health check of one enabled integration. */
export type IntegrationCheck = {
  readonly id: IntegrationId;
  readonly name: string;
  health(): Promise<IntegrationHealth>;
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
  /** `"agent"` forwards the operator SSH agent to the box git commands. `"box"` uses the box deploy key. */
  readonly gitAuth: GitAuth;
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
  /** One entry for each registry tool. Empty when the box check failed; the error is in `errors`. */
  readonly tools?: readonly ToolStatus[];
  /** The skills on the box that its snapshot does not track. `ferry adopt --from-box` brings one to this machine. */
  readonly boxOnlySkills?: {
    /** `null` when Ferry could not read them, or the box is offline. */
    readonly skills: readonly BoxSkill[] | null;
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
  /** The integration checks on this machine. Present only when an enabled integration has one. */
  readonly integrations?: Readonly<Partial<Record<IntegrationId, IntegrationStatus>>>;
  /** The operator and git remote errors only. Each box has its own errors. */
  readonly errors: readonly StatusError[];
};

/**
 * One item of a box that needs action. `login`: a provider login. `mcp-login`:
 * an MCP server login, with the name `tool/server`. `mcp-server`: a carried
 * stdio MCP server, with the name `harness/server`, in the state `env-missing`,
 * `env-unchecked`, `command-missing`, or `not-portable`. `tool`: a tool with the state `drift`,
 * `missing`, or `hidden`. `hook`: a hook command that refers to a home file
 * Ferry does not carry, with the name of that path. `resource`: the free disk
 * of the home file system (`disk`) or the available memory (`memory`) of the
 * box is below its limit, in the state `low`. `check-failed`: Ferry cannot
 * read a part of the box.
 */
export type BriefIssue = {
  readonly kind: "login" | "mcp-login" | "mcp-server" | "tool" | "hook" | "resource" | "check-failed";
  readonly name: string;
  readonly state: string;
  readonly message: string;
  /** The Ferry command that fixes the issue, or null when a person must act on the box. */
  readonly command: string | null;
};

export type BriefBoxStatus = {
  readonly name: string;
  readonly host: string;
  readonly online: boolean;
  /** Why the box is offline. */
  readonly error: string | null;
  /** Empty when the box is offline. */
  readonly issues: readonly BriefIssue[];
  /** The disk, memory, and load of the box. Null when the box is offline or the check has no resource read. */
  readonly resources: BoxResources | null;
};

/** The report of `ferry status --brief`, and the content of `~/.ferry/status.json`. */
export type BriefStatusReport = {
  readonly schemaVersion: 1;
  /** When the check started, as an ISO 8601 time. */
  readonly checkedAt: string;
  readonly boxes: readonly BriefBoxStatus[];
};

/**
 * Check only the link, the disk, memory, and load, the logins, the MCP logins,
 * the carried stdio MCP servers, and the tools of each box.
 * It reads no store, no apply plan, no git identity, and no sudo, so it is
 * fast enough for the watch to run on a timer.
 */
export async function composeBriefStatus(
  boxes: readonly BoxStatusDependencies[],
  checkedAt: Date,
  progress: Progress = noProgress,
): Promise<BriefStatusReport> {
  progress.plan(boxes.reduce((total, box) => total + 3 + (box.mcpServers ? 1 : 0) + (box.tools ? 1 : 0), 0));
  const boxProgress = orderedProgress(progress, boxes.map((box) => box.name));
  const results = await mapLimit(boxes, BOX_LIMIT, async (box, index) => {
    try {
      return await composeBriefBox(box, boxProgress.views[index]!);
    } finally {
      boxProgress.end(index);
    }
  });
  return { schemaVersion: 1, checkedAt: checkedAt.toISOString(), boxes: results };
}

async function composeBriefBox(box: BoxStatusDependencies, progress: Progress): Promise<BriefBoxStatus> {
  const base = { name: box.name, host: box.host };
  let error: string | null = null;
  try {
    const result = await inspect(progress, "Connecting to the box", () => box.link.probe());
    if (!result.ok) error = result.error.message;
  } catch (cause) {
    error = dependencyError("operator", cause).message;
  }
  if (error !== null) {
    progress.skip("Checking logins on the box", OFFLINE);
    progress.skip("Checking MCP logins on the box", OFFLINE);
    if (box.mcpServers) progress.skip("Checking MCP servers on the box", OFFLINE);
    if (box.tools) progress.skip("Checking tools on the box", OFFLINE);
    return { ...base, online: false, error, issues: [], resources: null };
  }

  const resources = box.resources?.read() ?? null;
  const issues: BriefIssue[] = resources && box.resources ? resourceIssues(resources, box.resources.limits) : [];
  const failed = (name: string, cause: unknown) =>
    issues.push({ kind: "check-failed", name, state: "failed", message: dependencyError("box", cause).message, command: null });
  const flag = `--box ${box.name}`;

  try {
    const { providers } = await inspect(progress, "Checking logins on the box", () => box.auth.status());
    for (const provider of providers) {
      const name = provider.provider;
      switch (provider.status) {
        case "authenticated":
          break;
        case "login-required":
          issues.push({ kind: "login", name, state: provider.status, message: `${name} needs a login.`, command: `ferry auth ${shellArg(name)} ${flag}` });
          break;
        case "manual":
          issues.push({ kind: "login", name, state: provider.status, message: provider.instruction, command: null });
          break;
        case "unavailable":
          issues.push({ kind: "login", name, state: provider.status, message: `Ferry cannot check the ${name} login: ${provider.error.message}`, command: null });
          break;
      }
    }
  } catch (cause) {
    failed("logins", cause);
  }

  try {
    for (const status of await inspect(progress, "Checking MCP logins on the box", () => box.auth.mcpStatus())) {
      if ("error" in status) {
        failed(`${status.tool} MCP`, new Error(status.error.message));
        continue;
      }
      for (const server of status.loginRequired) {
        issues.push({
          kind: "mcp-login",
          name: `${status.tool}/${server}`,
          state: "login-required",
          message: `${status.tool}/${server} needs a login.`,
          command: `ferry auth ${shellArg(status.tool)} --mcp ${shellArg(server)} ${flag}`,
        });
      }
    }
  } catch (cause) {
    failed("MCP logins", cause);
  }

  if (box.mcpServers) {
    const servers = box.mcpServers;
    try {
      for (const issue of await step(progress, "Checking MCP servers on the box", () => servers.check())) {
        issues.push(mcpServerIssue(issue, flag));
      }
    } catch (cause) {
      failed("MCP servers", cause);
    }
  }

  if (box.tools) {
    const check = box.tools;
    try {
      for (const tool of await step(progress, "Checking tools on the box", () => check.check(true))) {
        const issue = toolIssue(tool, flag);
        if (issue) issues.push(issue);
      }
    } catch (cause) {
      failed("tools", cause);
    }
  }

  if (box.hookPaths) issues.push(...box.hookPaths().map(hookIssue));

  return { ...base, online: true, error: null, issues, resources };
}

/**
 * One item for the disk when its free space is below both limits, and one for
 * the memory when it is below its limit. A limit of 0 turns its part off.
 */
function resourceIssues(resources: BoxResources, limits: ResourceLimits): BriefIssue[] {
  const issues: BriefIssue[] = [];
  const base = { kind: "resource", state: "low", command: null } as const;
  const { disk, memory } = resources;
  if (disk) {
    const percent = (disk.freeKiB / disk.totalKiB) * 100;
    const gib = disk.freeKiB / KIB_PER_GIB;
    const crossed = [
      ...(limits.diskFreeGiB > 0 ? [{ low: gib < limits.diskFreeGiB, text: formatGiB(limits.diskFreeGiB) }] : []),
      ...(limits.diskFreePercent > 0 ? [{ low: percent < limits.diskFreePercent, text: formatPercent(limits.diskFreePercent) }] : []),
    ];
    if (crossed.length > 0 && crossed.every((limit) => limit.low)) {
      issues.push({
        ...base,
        name: "disk",
        message: `The home file system has ${formatGiB(gib)} free (${formatPercent(percent)}). The limit is ${crossed.map((limit) => limit.text).join(" and ")}. Free disk space on the box.`,
      });
    }
  }
  if (memory) {
    const percent = (memory.availableKiB / memory.totalKiB) * 100;
    if (percent < limits.memoryAvailablePercent) {
      issues.push({
        ...base,
        name: "memory",
        message: `The box has ${formatGiB(memory.availableKiB / KIB_PER_GIB)} memory available (${formatPercent(percent)}). The limit is ${formatPercent(limits.memoryAvailablePercent)}. Stop processes on the box.`,
      });
    }
  }
  return issues;
}

const KIB_PER_GIB = 1024 * 1024;

function formatGiB(gib: number): string {
  return `${Number(gib.toFixed(1))} GiB`;
}

function formatPercent(percent: number): string {
  return `${Number(percent.toFixed(1))}%`;
}

function hookIssue(hook: UncarriedHookPath): BriefIssue {
  return {
    kind: "hook",
    name: hook.path,
    state: "uncarried",
    message: `Hook ${hook.at} in ${hook.file} runs ${hook.path}, and Ferry does not carry that file. Move it into ~/.claude/hooks.`,
    command: null,
  };
}

function mcpServerIssue(issue: BoxMcpIssue, flag: string): BriefIssue {
  const name = `${issue.harness}/${issue.server}`;
  const base = { kind: "mcp-server", name, state: issue.kind, command: null } as const;
  switch (issue.kind) {
    case "env-missing":
      return {
        ...base,
        message: `${name} needs ${issue.keys.join(", ")} on the box. Set ${issue.keys.length === 1 ? "it" : "them"} in the env of ${issue.server} in ~/${issue.file} on the box.`,
      };
    case "env-unchecked":
      return {
        ...base,
        message: `Ferry cannot check ${issue.keys.join(", ")} of ${name}, because jq is not on the box.`,
        command: `ferry update ${flag}`,
      };
    case "command-missing":
      return {
        ...base,
        message: `${name} runs ${issue.command}, which is not on the box. Install ${issue.command} on the box, or add a tool for it to the registry.`,
      };
    case "not-portable":
      return {
        ...base,
        message: `${name} refers to a path in your home, so Ferry does not carry it. Use a command on the PATH or a path outside the home.`,
      };
  }
}

function toolIssue(tool: ToolStatus, flag: string): BriefIssue | null {
  const base = { kind: "tool", name: tool.id, state: tool.state } as const;
  switch (tool.state) {
    case "drift":
      return { ...base, message: `${tool.id} is ${tool.box} on the box, and the target is ${tool.target}.`, command: `ferry update ${flag}` };
    case "missing":
      return { ...base, message: `${tool.id} is not on the box.`, command: `ferry install ${flag}` };
    case "hidden":
      return { ...base, message: `${tool.id}: ${tool.reason}.`, command: `ferry sync ${flag}` };
    default:
      return null;
  }
}

/** A name in a fix command. The operator runs the command in a shell, so a name with other characters gets quotes. */
function shellArg(value: string): string {
  return /^[A-Za-z0-9._:\/-]+$/.test(value) ? value : `'${value.replaceAll("'", `'"'"'`)}'`;
}

/** Boxes that status inspects at the same time. */
const BOX_LIMIT = 4;

/** Compose one read-only report from module-owned inspection methods. */
export async function composeStatus(dependencies: StatusDependencies): Promise<StatusReport> {
  const progress = dependencies.progress ?? noProgress;
  const operatorIntegrations = dependencies.integrations ?? [];
  progress.plan(
    1 +
      operatorIntegrations.length +
      dependencies.boxes.reduce(
        (total, box) =>
          total + BOX_STEPS + (box.tools ? 1 : 0) + (box.boxSkills ? 1 : 0) + (box.integrations?.length ?? 0),
        0,
      ),
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

  const integrations: Partial<Record<IntegrationId, IntegrationStatus>> = {};
  for (const integration of operatorIntegrations) {
    integrations[integration.id] = await integrationStatus(
      progress,
      `Checking ${integration.name} on this machine`,
      integration,
      "operator",
      errors,
    );
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
    ...(operatorIntegrations.length > 0 ? { integrations } : {}),
    errors,
  };
}

type SharedStatus = {
  readonly local: string | null;
  readonly remote: string | null;
  readonly operatorIdentity: GitIdentity | null;
};

/** The steps of one box without its tools and integrations. */
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

  let boxOnlySkills: BoxStatus["boxOnlySkills"];
  if (dependencies.boxSkills) {
    const name = "Listing box-only skills";
    if (online) {
      const list = dependencies.boxSkills;
      try {
        boxOnlySkills = { skills: await step(progress, name, () => list.list()), error: null };
      } catch (cause) {
        const error = dependencyError("box", cause);
        errors.push(error);
        boxOnlySkills = { skills: null, error };
      }
    } else {
      progress.skip(name, OFFLINE);
      boxOnlySkills = { skills: null, error: null };
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

  let tools: readonly ToolStatus[] | undefined;
  if (dependencies.tools) {
    const name = "Checking tools on the box";
    if (online) {
      try {
        const check = dependencies.tools;
        tools = await step(progress, name, () => check.check(true), undefined, (rows) => {
          const warnings = rows.filter((row) => TOOL_WARNINGS.includes(row.state)).length;
          return warnings > 0 ? plural(warnings, "warning") : undefined;
        });
      } catch (cause) {
        errors.push(dependencyError("box", cause));
        tools = [];
      }
    } else {
      progress.skip(name, OFFLINE);
      tools = await dependencies.tools.check(false);
    }
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
    integrations[integration.id] = await integrationStatus(progress, name, integration, "box", errors);
  }

  const localMatchesRemote = shared.local !== null && shared.local === shared.remote;
  const remoteMatchesBox = shared.remote !== null && shared.remote === boxTip;
  return {
    name: dependencies.name,
    host: dependencies.host,
    gitAuth: dependencies.gitAuth,
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
    ...(tools ? { tools } : {}),
    ...(boxOnlySkills ? { boxOnlySkills } : {}),
    ...(enabledIntegrations.length > 0 ? { integrations } : {}),
    errors,
  };
}

/** Run one integration health check as a progress step. A failed check adds its error to `errors`. */
async function integrationStatus(
  progress: Progress,
  name: string,
  integration: IntegrationCheck,
  origin: StatusDependencyError["origin"],
  errors: StatusError[],
): Promise<IntegrationStatus> {
  try {
    const health = await step(progress, name, () => integration.health(), undefined, (health) =>
      health.warnings.length > 0 ? plural(health.warnings.length, "warning") : undefined,
    );
    return { name: integration.name, lines: health.lines, warnings: health.warnings, state: health.json };
  } catch (cause) {
    const error = dependencyError(origin, cause);
    errors.push(error);
    return { name: integration.name, lines: ["unavailable"], warnings: [], state: { error: error.message } };
  }
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
  // A reporter with groups shows the boxes at the same time, with real step durations.
  if (progress.group) return { views: names.map((box) => groupProgress(progress, box)), end() {} };
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
/** The tool states that print a warning. */
const TOOL_WARNINGS: readonly ToolStatus["state"][] = ["drift", "missing", "hidden"];

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
