import { homedir } from "node:os";
import { join, posix } from "node:path";
import { apply, type ApplyPlan, type RemoteApplyInput } from "./apply.ts";
import {
  AuthStart,
  type AuthLink,
  type AuthStatusReport,
  type McpLoginStatus,
} from "./auth-start.ts";
import { resolveBoxes, type ResolvedBox } from "./boxes.ts";
import { readConfig, resolveLinkOptions, type OperatorHostConfig, type PartialOperatorConfig } from "./config.ts";
import { INTEGRATIONS, type Integration } from "./integrations/index.ts";
import { Link, type LinkOptions } from "./link.ts";
import {
  BOX_GIT_IDENTITY_COMMAND,
  readOperatorGitIdentity,
  type GitIdentity,
} from "./git-identity.ts";
import { denyRules, type DenyRuleDescription } from "./manifest.ts";
import { noProgress, type Progress } from "./progress.ts";
import {
  loadRegistry,
  type Registry,
  type RegistryConfig,
  type RegistryResult,
} from "./registry/load.ts";
import type { ToolDescriptor } from "./registry/types.ts";
import { composeStatus, type BoxStatus, type BoxStatusDependencies, type StatusReport } from "./status.ts";
import { effectivePolicy } from "./tools/resolve.ts";
import { RealGitRunner, Store, type TipReport } from "./store.ts";
import { boxChangesCommand } from "./sync.ts";

const STORE_RELATIVE_PATH = ".ferry/store";
/** `sudo -n` fails when sudo asks for a password. Only the answer goes to stdout. */
const BOX_SUDO_COMMAND = "sudo -n /usr/bin/true >/dev/null 2>&1 && echo yes || echo no";

export type StatusCommandInput = {
  readonly json: boolean;
  /** Box names. An empty selection selects all boxes. */
  readonly selection?: readonly string[];
};

type StatusConfig = PartialOperatorConfig & RegistryConfig;
type StatusLink = AuthLink;
type StatusStore = {
  inspectTips(boxTip: string | null): Promise<TipReport>;
};
type StatusAuth = {
  status(): Promise<AuthStatusReport>;
  mcpStatus(): Promise<readonly McpLoginStatus[]>;
};

export type StatusCommandDependencies = {
  readonly readConfig: () => StatusConfig | null;
  readonly loadRegistry: (config: RegistryConfig) => RegistryResult;
  readonly home: () => string;
  readonly createLink: (options: LinkOptions) => StatusLink;
  readonly createStore: (home: string) => StatusStore;
  readonly readOperatorGitIdentity: (home: string) => Promise<GitIdentity>;
  readonly inspectApply: (input: RemoteApplyInput) => Promise<ApplyPlan>;
  readonly createAuthStart: (
    link: StatusLink,
    tools: readonly ToolDescriptor[],
  ) => StatusAuth;
  readonly denyRules: () => readonly DenyRuleDescription[];
  /** All built-in integrations. Status checks the ones that the config enables. */
  readonly integrations: readonly Integration[];
  readonly writeLine: (line: string) => void;
  readonly progress: Progress;
};

/** Read the selected boxes and print one report without changing any machine. */
export async function runStatusCommand(
  input: StatusCommandInput,
  dependencies: Partial<StatusCommandDependencies> = {},
): Promise<StatusReport> {
  const resolved = { ...defaultDependencies, ...dependencies };
  const config = resolved.readConfig() ?? {};
  const boxes = resolveBoxes(config, input.selection ?? []);
  const registry = effectiveRegistry(config, resolved.loadRegistry);
  const home = resolved.home();
  const store = resolved.createStore(home);

  const report = await composeStatus({
    operator: { gitIdentity: () => resolved.readOperatorGitIdentity(home) },
    store,
    manifest: { denyRules: resolved.denyRules },
    boxes: boxes.map((box) => boxDependencies(box, config, registry, resolved)),
    progress: resolved.progress,
  });

  resolved.writeLine(input.json ? JSON.stringify(report) : formatStatus(report));
  return report;
}

function boxDependencies(
  box: ResolvedBox,
  config: StatusConfig,
  registry: Registry,
  resolved: StatusCommandDependencies,
): BoxStatusDependencies {
  const link = resolved.createLink(resolveLinkOptions(box.host));
  let boxHome: string | null = null;
  return {
    name: box.name,
    host: destination(box.host),
    link: {
      async probe() {
        const result = await link.run(`printf '%s\\n' "$HOME"`);
        if (result.ok) boxHome = validBoxHome(result.stdout);
        return result;
      },
      async readBoxTip() {
        const checkout = posix.join(required(boxHome), STORE_RELATIVE_PATH);
        return link.run(`git -C ${quoteShell(checkout)} rev-parse --verify HEAD 2>/dev/null || true`);
      },
      async readBoxChanges() {
        const checkout = posix.join(required(boxHome), STORE_RELATIVE_PATH);
        return link.run(`${boxChangesCommand(checkout)} 2>/dev/null || true`);
      },
      async readBoxGitIdentity() {
        return link.run(BOX_GIT_IDENTITY_COMMAND);
      },
      async readBoxSudo() {
        return link.run(BOX_SUDO_COMMAND);
      },
    },
    watchUpdatesGh: config.update?.watch === true && watchUpdates(registry.tools, box, "gh"),
    apply: {
      plan() {
        const remoteHome = required(boxHome);
        return resolved.inspectApply({
          checkout: posix.join(remoteHome, STORE_RELATIVE_PATH),
          targetHome: remoteHome,
          harnesses: registry.harnesses,
          dryRun: true,
          link,
        });
      },
    },
    auth: resolved.createAuthStart(link, registry.tools),
    integrations: resolved.integrations
      .filter((integration) => box.integrations[integration.id] === true)
      .map((integration) => ({
        id: integration.id,
        name: integration.name,
        health: () => integration.health(link),
      })),
  };
}

/** The shared block, then one block for each box. */
export function formatStatus(report: StatusReport): string {
  const lines = [
    "Store tips:",
    `  Local: ${tip(report.store.local)}`,
    `  Git remote: ${tip(report.store.remote)}`,
    `  Local = remote: ${yesNo(report.store.localMatchesRemote)}`,
    "",
    "Deny list:",
    ...report.denyList.map(
      (rule) => `  ${rule.code}: ${rule.behavior} ${rule.description}`,
    ),
    ...errorLines(report.errors),
    ...report.boxes.flatMap((box) => ["", ...boxLines(box, report.operator.gitIdentity)]),
  ];
  return lines.join("\n");
}

function boxLines(box: BoxStatus, operator: GitIdentity | null): string[] {
  return [
    `Box ${box.name} (${box.host})`,
    `Host: ${box.link.online ? "ONLINE" : "OFFLINE"}`,
    `Address: ${box.link.address ?? "unavailable"}`,
    "",
    "Store tips:",
    `  Box: ${tip(box.tip)}`,
    `  Remote = box: ${yesNo(box.remoteMatchesBox)}`,
    `  All agree: ${yesNo(box.allMatch)}`,
    "",
    boxCheckout(box),
    ...box.boxCheckout.changes.map((path) => `  - ${path}`),
    "",
    gitIdentity(box, operator),
    "",
    ...boxSudo(box),
    "",
    managedPaths(box),
    ...box.managedPaths.unhealthy.map((action) => `  - ${managedPath(action)}`),
    "",
    "Authentication:",
    ...(box.auth.providers.length === 0
      ? ["  unavailable while host is offline"]
      : box.auth.providers.map((provider) => {
          switch (provider.status) {
            case "authenticated":
              return `  ${provider.provider}: authenticated`;
            case "login-required":
              return `  ${provider.provider}: LOGIN REQUIRED`;
            case "manual":
              return `  ${provider.provider}: MANUAL LOGIN REQUIRED. ${provider.instruction}`;
            case "unavailable":
              return `  ${provider.provider}: unavailable (${provider.error.origin}/${provider.error.code})`;
          }
        })),
    "",
    "MCP logins:",
    ...mcpLogins(box),
    ...integrations(box),
    ...errorLines(box.errors),
  ];
}

function errorLines(errors: StatusReport["errors"]): string[] {
  if (errors.length === 0) return [];
  return ["", "Errors:", ...errors.map((error) => `  ${error.origin}/${error.code}: ${error.message}`)];
}

const defaultDependencies: StatusCommandDependencies = {
  readConfig,
  loadRegistry,
  home: homedir,
  createLink: (options) => new Link(options),
  createStore: (home) =>
    new Store(new RealGitRunner(), join(home, STORE_RELATIVE_PATH), ""),
  readOperatorGitIdentity: (home) =>
    readOperatorGitIdentity(new RealGitRunner(), join(home, STORE_RELATIVE_PATH)),
  inspectApply: (input) => apply(input),
  createAuthStart: (link, tools) => new AuthStart(link, tools),
  denyRules,
  integrations: INTEGRATIONS,
  writeLine: console.log,
  progress: noProgress,
};

/** The SSH destination of a box, as the operator would type it. */
function destination(host: OperatorHostConfig): string {
  return host.transport === "ssh" ? host.destination : `${host.sshUser}@${host.tailscale}`;
}

/** The daily watch update changes only the tools whose policy is `latest` for the box. */
function watchUpdates(tools: readonly ToolDescriptor[], box: ResolvedBox, id: string): boolean {
  const tool = tools.find((entry) => entry.id === id);
  return tool !== undefined && effectivePolicy(tool, box.tools) === "latest";
}

function effectiveRegistry(
  config: RegistryConfig,
  load: StatusCommandDependencies["loadRegistry"],
): Registry {
  const result = load(config);
  if (!result.ok) {
    throw new Error(
      `operator: registry refused the config: ${result.problems
        .map((problem) => problem.reason)
        .join("; ")}`,
    );
  }
  return result;
}

function validBoxHome(stdout: string): string {
  const home = stdout.replace(/\r?\n$/, "");
  if (!posix.isAbsolute(home) || /[\r\n\0]/.test(home)) {
    throw new Error("box returned an invalid absolute home path");
  }
  return home;
}

function required(value: string | null): string {
  if (value === null) throw new Error("box home is unavailable");
  return value;
}

function quoteShell(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

function tip(value: string | null): string {
  return value ?? "unavailable";
}

function yesNo(value: boolean): string {
  return value ? "yes" : "no";
}

function boxCheckout(box: BoxStatus): string {
  if (box.boxCheckout.dirty === null) return "Box checkout: unavailable";
  return box.boxCheckout.dirty
    ? `Box checkout: DIRTY (${box.boxCheckout.changes.length}), the next sync discards these changes`
    : "Box checkout: CLEAN";
}

function gitIdentity(status: BoxStatus, operator: GitIdentity | null): string {
  const { box, boxConfigured, matchesOperator } = status.gitIdentity;
  if (box === null) return "Box git identity: unavailable";
  if (!boxConfigured) {
    const missing = [box.name === null && "user.name", box.email === null && "user.email"];
    return `Box git identity: MISSING ${missing.filter(Boolean).join(" and ")}, run ferry install`;
  }
  if (matchesOperator) return `Box git identity: MATCHES operator (${person(box)})`;
  if (operator === null) return `Box git identity: SET (${person(box)})`;
  return `Box git identity: DIFFERENT from operator (${person(box)}, operator: ${person(operator)})`;
}

function boxSudo(box: BoxStatus): string[] {
  const { passwordless, watchUpdateBlocked } = box.boxSudo;
  if (passwordless === null) return ["Box sudo: unavailable"];
  if (passwordless) return ["Box sudo: PASSWORDLESS"];
  return [
    "Box sudo: PASSWORD REQUIRED",
    ...(watchUpdateBlocked
      ? [
          "  WARNING: [update] watch = true and the gh policy is \"latest\", but the watch cannot update gh because sudo on the box asks for a password. See the sudoers rule in the README.",
        ]
      : []),
  ];
}

function mcpLogins(box: BoxStatus): string[] {
  if (!box.link.online) return ["  unavailable while host is offline"];
  if (box.mcpLogins.error) return ["  unavailable"];
  if (box.mcpLogins.loginRequired.length === 0) return ["  none required"];
  return box.mcpLogins.loginRequired.map((entry) => {
    const [tool, server] = entry.split("/");
    return `  ${entry}: LOGIN REQUIRED, run ferry auth ${tool} --mcp ${server}`;
  });
}

function integrations(box: BoxStatus): string[] {
  const entries = Object.values(box.integrations ?? {});
  if (entries.length === 0) return [];
  return [
    "",
    "Integrations:",
    ...entries.flatMap((entry) => [
      `  ${entry.name}:`,
      ...entry.lines.map((line) => `    ${line}`),
      ...entry.warnings.map((warning) => `    WARNING: ${warning}`),
    ]),
  ];
}

function person(identity: GitIdentity): string {
  return `${identity.name ?? "no user.name"} <${identity.email ?? "no user.email"}>`;
}

function managedPaths(box: BoxStatus): string {
  if (box.managedPaths.allHealthy === null) {
    return "Managed links: unavailable while host is offline";
  }
  return box.managedPaths.allHealthy
    ? "Managed links: HEALTHY"
    : `Managed links: UNHEALTHY (${box.managedPaths.unhealthy.length})`;
}

function managedPath(action: BoxStatus["managedPaths"]["unhealthy"][number]): string {
  if ("target" in action) return `${action.harness}: ${action.path} -> ${action.target}`;
  return `${action.harness}: ${action.path} (${action.kind})`;
}
