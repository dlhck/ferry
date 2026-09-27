import { homedir } from "node:os";
import { join, posix } from "node:path";
import { apply, type ApplyPlan, type RemoteApplyInput } from "./apply.ts";
import { AuthStart, type AuthLink, type AuthStatusReport } from "./auth-start.ts";
import { readConfig, resolveLinkOptions, type PartialOperatorConfig } from "./config.ts";
import { Link, type LinkOptions } from "./link.ts";
import {
  BOX_GIT_IDENTITY_COMMAND,
  readOperatorGitIdentity,
  type GitIdentity,
} from "./git-identity.ts";
import { denyRules, type DenyRuleDescription } from "./manifest.ts";
import {
  loadRegistry,
  type Registry,
  type RegistryConfig,
  type RegistryResult,
} from "./registry/load.ts";
import type { ToolDescriptor } from "./registry/types.ts";
import { composeStatus, type StatusReport } from "./status.ts";
import { RealGitRunner, Store, type TipReport } from "./store.ts";
import { boxChangesCommand } from "./sync.ts";

const STORE_RELATIVE_PATH = ".ferry/store";
/** `sudo -n` fails when sudo asks for a password. Only the answer goes to stdout. */
const BOX_SUDO_COMMAND = "sudo -n true >/dev/null 2>&1 && echo yes || echo no";

export type StatusCommandInput = {
  readonly json: boolean;
};

type StatusConfig = PartialOperatorConfig & RegistryConfig;
type StatusLink = AuthLink;
type StatusStore = {
  inspectTips(boxTip: string | null): Promise<TipReport>;
};
type StatusAuth = {
  status(): Promise<AuthStatusReport>;
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
  readonly writeLine: (line: string) => void;
};

/** Read the configured box and print one report without changing either machine. */
export async function runStatusCommand(
  input: StatusCommandInput,
  dependencies: Partial<StatusCommandDependencies> = {},
): Promise<StatusReport> {
  const resolved = { ...defaultDependencies, ...dependencies };
  const config = resolved.readConfig() ?? {};
  const target = configuredTarget(config);
  const registry = effectiveRegistry(config, resolved.loadRegistry);
  const home = resolved.home();
  const link = resolved.createLink(target);
  const store = resolved.createStore(home);
  const auth = resolved.createAuthStart(link, registry.tools);
  let boxHome: string | null = null;

  const report = await composeStatus({
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
    updateWatch: config.update?.watch === true,
    operator: { gitIdentity: () => resolved.readOperatorGitIdentity(home) },
    store,
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
    auth,
    manifest: { denyRules: resolved.denyRules },
  });

  resolved.writeLine(input.json ? JSON.stringify(report) : formatStatus(report));
  return report;
}

export function formatStatus(report: StatusReport): string {
  const lines = [
    `Host: ${report.link.online ? "ONLINE" : "OFFLINE"}`,
    `Address: ${report.link.address ?? "unavailable"}`,
    "",
    "Store tips:",
    `  Local: ${tip(report.store.local)}`,
    `  Git remote: ${tip(report.store.remote)}`,
    `  Box: ${tip(report.store.box)}`,
    `  Local = remote: ${yesNo(report.store.localMatchesRemote)}`,
    `  Remote = box: ${yesNo(report.store.remoteMatchesBox)}`,
    `  All agree: ${yesNo(report.store.allMatch)}`,
    "",
    boxCheckout(report),
    ...report.boxCheckout.changes.map((path) => `  - ${path}`),
    "",
    gitIdentity(report),
    "",
    ...boxSudo(report),
    "",
    managedPaths(report),
    ...report.managedPaths.unhealthy.map((action) => `  - ${managedPath(action)}`),
    "",
    "Authentication:",
    ...(report.auth.providers.length === 0
      ? ["  unavailable while host is offline"]
      : report.auth.providers.map((provider) => {
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
    `Paseo listen hint: ${report.paseo.listen ?? "unavailable while host is offline"}`,
    "",
    "Deny list:",
    ...report.denyList.map(
      (rule) => `  ${rule.code}: ${rule.behavior} ${rule.description}`,
    ),
  ];

  if (report.errors.length > 0) {
    lines.push(
      "",
      "Errors:",
      ...report.errors.map((error) => `  ${error.origin}/${error.code}: ${error.message}`),
    );
  }
  return lines.join("\n");
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
  writeLine: console.log,
};

function configuredTarget(config: StatusConfig): LinkOptions {
  const target = resolveLinkOptions(config.host);
  if (!target) throw new Error("operator: Ferry config has no complete host. Run ferry init.");
  return target;
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

function boxCheckout(report: StatusReport): string {
  if (report.boxCheckout.dirty === null) return "Box checkout: unavailable";
  return report.boxCheckout.dirty
    ? `Box checkout: DIRTY (${report.boxCheckout.changes.length}), the next sync discards these changes`
    : "Box checkout: CLEAN";
}

function gitIdentity(report: StatusReport): string {
  const { box, operator, boxConfigured, matchesOperator } = report.gitIdentity;
  if (box === null) return "Box git identity: unavailable";
  if (!boxConfigured) {
    const missing = [box.name === null && "user.name", box.email === null && "user.email"];
    return `Box git identity: MISSING ${missing.filter(Boolean).join(" and ")}, run ferry install`;
  }
  if (matchesOperator) return `Box git identity: MATCHES operator (${person(box)})`;
  if (operator === null) return `Box git identity: SET (${person(box)})`;
  return `Box git identity: DIFFERENT from operator (${person(box)}, operator: ${person(operator)})`;
}

function boxSudo(report: StatusReport): string[] {
  const { passwordless, watchUpdateBlocked } = report.boxSudo;
  if (passwordless === null) return ["Box sudo: unavailable"];
  if (passwordless) return ["Box sudo: PASSWORDLESS"];
  return [
    "Box sudo: PASSWORD REQUIRED",
    ...(watchUpdateBlocked
      ? [
          "  WARNING: [update] watch = true, but the watch cannot update gh because sudo on the box asks for a password. See the sudoers rule in the README.",
        ]
      : []),
  ];
}

function person(identity: GitIdentity): string {
  return `${identity.name ?? "no user.name"} <${identity.email ?? "no user.email"}>`;
}

function managedPaths(report: StatusReport): string {
  if (report.managedPaths.allHealthy === null) {
    return "Managed links: unavailable while host is offline";
  }
  return report.managedPaths.allHealthy
    ? "Managed links: HEALTHY"
    : `Managed links: UNHEALTHY (${report.managedPaths.unhealthy.length})`;
}

function managedPath(action: StatusReport["managedPaths"]["unhealthy"][number]): string {
  if ("target" in action) return `${action.harness}: ${action.path} -> ${action.target}`;
  return `${action.harness}: ${action.path} (${action.kind})`;
}
