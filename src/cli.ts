#!/usr/bin/env bun

import { Command } from "commander";
import * as prompts from "@clack/prompts";
import {
  runInit,
  type InitDependencies,
  type InitField,
  type InitInput,
  type InitPrompt,
  type InitResult,
  type SnapshotHostKeyApproval,
} from "./init.ts";
import {
  InstallAuthCommandError,
  runAuthCommand,
  runInstallCommand,
  type AuthCommandDependencies,
  type AuthCommandInput,
  type InstallCommandDependencies,
  type InstallCommandInput,
} from "./install-auth.ts";
import {
  denyListLines,
  runSync as runSyncCommand,
  type SyncDependencies,
  type SyncInput,
  type SyncResult,
} from "./sync.ts";
import { noProgress, plainProgress, terminalProgress, type Progress } from "./progress.ts";
import { readConfig, type PartialOperatorConfig } from "./config.ts";
import { INTEGRATIONS, integrationLines, type Integration } from "./integrations/index.ts";
import {
  runIntegrationCommand,
  type IntegrationCommandDependencies,
  type IntegrationCommandInput,
} from "./integrations/command.ts";
import { loadRegistry, type Registry } from "./registry/load.ts";
import {
  runStatusCommand,
  type StatusCommandDependencies,
  type StatusCommandInput,
} from "./status-command.ts";
import { runToolsCommand, type ToolsCommandDependencies } from "./tools/command.ts";
import { runWatch, type WatchDependencies, type WatchInput } from "./watch.ts";
import {
  installWatchService,
  type WatchServiceDependencies,
  type WatchServiceInput,
  type WatchServiceResult,
} from "./watch-service.ts";
import {
  runUninstall,
  type UninstallInput,
  type UninstallResult,
} from "./uninstall.ts";
import { runSkillsAdd, SkillsAddError, type RunProcess } from "./skills-add.ts";
import { runMove, type MoveDependencies, type MoveInput } from "./move.ts";
import {
  runUpdateCommand,
  type UpdateCommandDependencies,
  type UpdateCommandInput,
} from "./update.ts";

const DESCRIPTION = `Ferry keeps a remote Linux agent box in the same shape as this machine.

Use ferry init to record a Tailscale host or OpenSSH destination and seed the
private snapshot.

Ferry never copies logins. Vendor sessions stay on the machine that created
them. Ferry starts a login on the box and you finish it in a browser here.`;

// The release build sets FERRY_VERSION with `bun build --define`. A run from source does not.
declare const FERRY_VERSION: string | undefined;
const VERSION = typeof FERRY_VERSION === "string" ? FERRY_VERSION : "0.0.0-dev";

type CliDependencies = {
  readonly runInit?: (input: InitInput, dependencies?: InitDependencies) => Promise<InitResult>;
  readonly runInstall?: (
    input: InstallCommandInput,
    dependencies?: Partial<InstallCommandDependencies>,
  ) => Promise<void>;
  readonly runAuth?: (
    input: AuthCommandInput,
    dependencies?: Partial<AuthCommandDependencies>,
  ) => Promise<void>;
  readonly runUpdate?: (
    input: UpdateCommandInput,
    dependencies?: Partial<UpdateCommandDependencies>,
  ) => Promise<void>;
  readonly runSync?: (input: SyncInput, dependencies?: SyncDependencies) => Promise<SyncResult>;
  readonly runMove?: (input: MoveInput, dependencies?: Partial<MoveDependencies>) => Promise<void>;
  readonly runStatus?: (
    input: StatusCommandInput,
    dependencies?: Partial<StatusCommandDependencies>,
  ) => Promise<unknown>;
  readonly runWatch?: (input: WatchInput, dependencies?: WatchDependencies) => Promise<void>;
  readonly runUninstall?: (input: UninstallInput) => UninstallResult;
  readonly installWatchService?: (
    input?: WatchServiceInput,
    dependencies?: WatchServiceDependencies,
  ) => Promise<WatchServiceResult>;
  readonly runIntegration?: (
    input: IntegrationCommandInput,
    dependencies?: Partial<IntegrationCommandDependencies>,
  ) => Promise<void>;
  readonly runTools?: (
    dependencies: Pick<ToolsCommandDependencies, "tools"> & Partial<ToolsCommandDependencies>,
  ) => Promise<void>;
  readonly runProcess?: RunProcess;
  readonly readConfig?: () => PartialOperatorConfig | null;
  readonly integrations?: readonly Integration[];
  readonly prompt?: InitPrompt;
  readonly approveHostKeys?: (request: SnapshotHostKeyApproval) => Promise<boolean>;
  readonly confirmUninstall?: () => Promise<boolean>;
  readonly writeLine?: (line: string) => void;
  /** The reporter for one command run. The default is one live line and a table on a terminal, else plain lines. */
  readonly createProgress?: () => Progress;
  /** The reporter for `ferry watch`, whose log must stay plain. */
  readonly createPlainProgress?: () => Progress;
};

type CliRuntime = {
  readonly renderError?: (message: string) => void;
  readonly setExitCode?: (code: number) => void;
};

export function buildProgram(dependencies: CliDependencies = {}): Command {
  // Commands that need the registry resolve it when they run, so help never reads the config.
  const config = () => (dependencies.readConfig ?? readConfig)() ?? {};
  const registry = () => resolveRegistry(config());
  const progress = () => (dependencies.createProgress ?? terminalProgress)();
  const writeLine = (line: string) => (dependencies.writeLine ?? console.log)(line);
  /**
   * Run a command with one reporter. The command's own lines go through the
   * reporter, and the summary table prints when the command ends, also after an error.
   */
  const withProgress = async <T>(
    run: (progress: Progress, writeLine: (line: string) => void) => Promise<T>,
    reporter: Progress = progress(),
  ): Promise<T> => {
    try {
      return await run(reporter, reporter.hold(writeLine));
    } finally {
      reporter.finish();
    }
  };
  const program = new Command();
  program
    .name("ferry")
    .description(DESCRIPTION)
    .version(VERSION)
    .showHelpAfterError()
    .action(() => {
      program.outputHelp();
    });

  program
    .command("init")
    .description("Record a Tailscale host or SSH destination, seed the snapshot, and convert this machine")
    .option("--host <host>", "Tailscale host name or IP address")
    .option("--ssh-user <user>", "SSH user on the host")
    .option("--ssh-destination <destination>", "explicit OpenSSH destination")
    .option("--snapshot-url <url>", "private snapshot git URL")
    .option("--dry-run", "print the init plan without writing or connecting")
    .action(async (options: {
      host?: string;
      sshUser?: string;
      sshDestination?: string;
      snapshotUrl?: string;
      dryRun?: boolean;
    }) => {
      const execute = dependencies.runInit ?? runInit;
      const result = await withProgress((progress) =>
        execute(
          {
            host: options.host,
            sshUser: options.sshUser,
            sshDestination: options.sshDestination,
            snapshotUrl: options.snapshotUrl,
            dryRun: options.dryRun === true,
            harnesses: registry().harnesses,
          },
          {
            prompt: dependencies.prompt ?? promptForInit,
            approveHostKeys: dependencies.approveHostKeys ?? approveHostKeys,
            progress,
          },
        ),
      );
      reportInit(result, writeLine);
    });

  program
    .command("install")
    .description("Install the supported agent tools on the configured box")
    .option("--yes", "run without a confirmation prompt")
    .action(async (options: { yes?: boolean }) => {
      await withProgress((progress, writeLine) =>
        (dependencies.runInstall ?? runInstallCommand)(
          { yes: options.yes === true },
          { tools: registry().tools, progress, writeLine },
        ),
      );
    });

  program
    .command("update")
    .description("Update the agent tools on the configured box and on this machine")
    .option("--yes", "run without a confirmation prompt")
    .option("--dry-run", "print the update plan without running it")
    .action(async (options: { yes?: boolean; dryRun?: boolean }) => {
      await withProgress((progress, writeLine) =>
        (dependencies.runUpdate ?? runUpdateCommand)(
          { yes: options.yes === true, dryRun: options.dryRun === true, includeIntegrations: true },
          { tools: registry().tools, progress, writeLine },
        ),
      );
    });

  program
    .command("uninstall")
    .description("Remove Ferry's local state and restore paths changed by init")
    .option("--yes", "run without a confirmation prompt")
    .action(async (options: { yes?: boolean }) => {
      if (!options.yes && !(await (dependencies.confirmUninstall ?? confirmUninstall)())) {
        (dependencies.writeLine ?? console.log)("Uninstall cancelled.");
        return;
      }
      const result = (dependencies.runUninstall ?? runUninstall)({ harnesses: registry().harnesses });
      const restored = `${result.restored} ${result.restored === 1 ? "path" : "paths"}`;
      const removed = `${result.removed} managed ${result.removed === 1 ? "path" : "paths"}`;
      (dependencies.writeLine ?? console.log)(
        `Uninstalled Ferry. Restored ${restored} and removed ${removed}.`,
      );
    });

  program
    .command("auth [provider]")
    .description("Start a login on the configured box without copying credentials")
    .option("--mcp <server>", "start the MCP server login of the provider CLI on the box")
    .action(async (provider: string | undefined, options: { mcp?: string }) => {
      await (dependencies.runAuth ?? runAuthCommand)(
        options.mcp === undefined ? { provider } : { provider, mcp: options.mcp },
        { tools: registry().tools, progress: progress() },
      );
    });

  program
    .command("sync")
    .description("Publish the snapshot and apply it to the configured box")
    .option("--dry-run", "print the plan without writing")
    .option("--force", "back up live managed paths before Apply links them")
    .option("-m, --message <message>", "snapshot commit message")
    .action(async (options: { dryRun?: boolean; force?: boolean; message?: string }) => {
      await withProgress((progress, writeLine) =>
        (dependencies.runSync ?? runSyncCommand)(
          {
            dryRun: options.dryRun === true,
            force: options.force === true,
            message: options.message,
          },
          { progress, writeLine },
        ),
      );
    });

  program
    .command("move")
    .description("Continue a project on the box, or with --from-box on this machine")
    .argument("<path>", "project folder inside the home directory")
    .option("--from-box", "move the project from the box to this machine")
    .option("--dry-run", "print what Ferry would carry, refuse, and skip without changes")
    .option("--remove", "after verification, move the source copy to a trash directory")
    .option("--include-env", "also carry .env files that pass the token and secret rules")
    .option("--allow-secrets", "with --include-env, also carry .env files that hold tokens or secrets")
    .option("--yes", "carry .env files with secrets without a confirmation prompt")
    .action(
      async (
        path: string,
        options: {
          fromBox?: boolean;
          dryRun?: boolean;
          remove?: boolean;
          includeEnv?: boolean;
          allowSecrets?: boolean;
          yes?: boolean;
        },
      ) => {
        await withProgress((progress, writeLine) =>
          (dependencies.runMove ?? runMove)(
            {
              path,
              fromBox: options.fromBox === true,
              dryRun: options.dryRun === true,
              remove: options.remove === true,
              includeEnv: options.includeEnv === true,
              allowSecrets: options.allowSecrets === true,
              yes: options.yes === true,
            },
            { writeLine, progress },
          ),
        );
      },
    );

  program
    .command("status")
    .description("Inspect link, snapshot, managed paths, and box logins without writing")
    .option("--json", "print the status report as JSON")
    .action(async (options: { json?: boolean }) => {
      await withProgress(
        (progress, writeLine) =>
          (dependencies.runStatus ?? runStatusCommand)({ json: options.json === true }, { writeLine, progress }),
        options.json === true ? noProgress : progress(),
      );
    });

  const integrations = program
    .command("integrations")
    .description("List the integrations, whether each one is enabled, and the local app versions")
    .action(async () => {
      const lines = await integrationLines(config(), dependencies.integrations ?? INTEGRATIONS);
      for (const line of lines) writeLine(line);
    });
  integrations
    .command("enable")
    .description("Install and start an integration on the box, then turn it on in the config")
    .argument("<name>", "integration name, such as paseo")
    .option("--dry-run", "print the box commands without connecting or writing")
    .option("--yes", "run without a confirmation prompt")
    .action(async (name: string, options: { dryRun?: boolean; yes?: boolean }) => {
      await withProgress((progress, writeLine) =>
        (dependencies.runIntegration ?? runIntegrationCommand)(
          { action: "enable", name, dryRun: options.dryRun === true, yes: options.yes === true },
          { progress, writeLine, ...(dependencies.integrations ? { integrations: dependencies.integrations } : {}) },
        ),
      );
    });
  integrations
    .command("disable")
    .description("Stop and remove an integration on the box, then turn it off in the config")
    .argument("<name>", "integration name, such as paseo")
    .option("--purge", "also uninstall the integration package on the box")
    .option("--yes", "run without a confirmation prompt")
    .action(async (name: string, options: { purge?: boolean; yes?: boolean }) => {
      await withProgress((progress, writeLine) =>
        (dependencies.runIntegration ?? runIntegrationCommand)(
          { action: "disable", name, purge: options.purge === true, yes: options.yes === true },
          { progress, writeLine, ...(dependencies.integrations ? { integrations: dependencies.integrations } : {}) },
        ),
      );
    });

  program
    .command("tools")
    .description("List the tools, the version policy of each one, and the versions on this machine")
    .action(async () => {
      await (dependencies.runTools ?? runToolsCommand)({ tools: registry().tools, readConfig: config, writeLine });
    });

  const watch = program
    .command("watch")
    .description("Watch the portable set and sync accepted changes")
    .action(async () => {
      const controller = new AbortController();
      const stop = () => controller.abort();
      process.once("SIGINT", stop);
      process.once("SIGTERM", stop);
      try {
        await (dependencies.runWatch ?? runWatch)(
          {
            signal: controller.signal,
            dailyUpdate: config().update?.watch === true,
          },
          {
            progress: (
              dependencies.createPlainProgress ??
              (() => plainProgress((line) => process.stderr.write(`${line}\n`)))
            )(),
          },
        );
      } finally {
        process.off("SIGINT", stop);
        process.off("SIGTERM", stop);
      }
    });
  watch
    .command("install")
    .description("Install and start the watch user service")
    .action(async () => {
      const result = await (dependencies.installWatchService ?? installWatchService)();
      (dependencies.writeLine ?? console.log)(`Installed ${result.manager} service at ${result.path}`);
    });

  program
    .command("skills")
    .description("Install skills into the global harness roots that Ferry manages")
    .command("add")
    .description(`Run npx skills add as a global copy install.

Ferry adds -g and --copy unless you pass them.
Global copy installs match Ferry's snapshot model. The skill is a real
directory in a global harness root, and the next sync links it to the store.
Put arguments after -- to keep Ferry from reading them.
Run ferry sync or ferry watch to publish the skill.`)
    .argument("<source>", "skill source, such as owner/repo or a git URL")
    .argument("[args...]", "other npx skills add arguments, passed through unchanged")
    .option("--project", "install into the current project and do not add -g")
    .allowUnknownOption()
    .action(async (source: string, args: string[], options: { project?: boolean }) => {
      await runSkillsAdd(
        { args: [source, ...args], project: options.project === true },
        dependencies.runProcess,
      );
    });
  return program;
}

export async function runCli(
  args: readonly string[],
  dependencies: CliDependencies = {},
  runtime: CliRuntime = {},
): Promise<void> {
  try {
    await buildProgram(dependencies).parseAsync([...args], { from: "user" });
  } catch (error) {
    if (!(error instanceof InstallAuthCommandError)) {
      (runtime.renderError ?? renderError)(errorMessage(error));
    }
    (runtime.setExitCode ?? setExitCode)(error instanceof SkillsAddError ? error.exitCode : 1);
  }
}

if (import.meta.main) await runCli(Bun.argv.slice(2));

/** Merge the operator's config entries into the builtin registry. */
function resolveRegistry(config: PartialOperatorConfig): Registry {
  const registry = loadRegistry(config);
  if (!registry.ok) {
    throw new Error(
      `ferry refused the registry: ${registry.problems.map((problem) => problem.reason).join("; ")}`,
    );
  }
  return registry;
}

async function promptForInit(
  missing: readonly InitField[],
  current: InitInput,
): Promise<Pick<InitInput, InitField>> {
  prompts.intro("ferry init");
  const result: { [Field in InitField]?: string } = {};
  const fields = await resolvePromptFields(missing, current);

  for (const field of fields) {
    result[field] = await askText(field, current[field]);
  }
  return result;
}

async function resolvePromptFields(
  missing: readonly InitField[],
  current: InitInput,
): Promise<readonly InitField[]> {
  const needsFreshTarget =
    (missing.includes("host") || missing.includes("sshUser")) &&
    !current.host &&
    !current.sshUser &&
    !current.sshDestination;
  if (!needsFreshTarget) return missing.filter((field) => field !== "sshDestination");

  const transport = await prompts.select({
    message: "How should Ferry reach the box?",
    options: [
      { value: "tailscale", label: "Tailscale host" },
      { value: "ssh", label: "SSH only, no Tailscale" },
    ],
  });
  if (prompts.isCancel(transport)) {
    prompts.cancel("Init cancelled.");
    throw new Error("init cancelled");
  }
  if (transport === "ssh") {
    return missing.includes("snapshotUrl") ? ["sshDestination", "snapshotUrl"] : ["sshDestination"];
  }
  return missing.filter((field) => field !== "sshDestination");
}

async function askText(field: InitField, initialValue?: string): Promise<string> {
  const answer = await prompts.text({
    message: promptMessage(field),
    initialValue,
    validate: (value) =>
      !value || value.trim() === "" ? "This value is required." : undefined,
  });
  if (prompts.isCancel(answer)) {
    prompts.cancel("Init cancelled.");
    throw new Error("init cancelled");
  }
  return answer;
}

async function approveHostKeys(request: SnapshotHostKeyApproval): Promise<boolean> {
  prompts.note(
    request.keys
      .map((key) => `${key.algorithm} ${key.fingerprint}`)
      .join("\n"),
    `SSH host keys for ${request.host}`,
  );
  const accepted = await prompts.confirm({
    message: `Trust these SSH host keys for ${request.host} on the box?`,
  });
  if (prompts.isCancel(accepted)) {
    prompts.cancel("Init cancelled.");
    throw new Error("init cancelled");
  }
  return accepted;
}

async function confirmUninstall(): Promise<boolean> {
  const accepted = await prompts.confirm({
    message: "Remove Ferry's local state and restore the paths changed by init?",
  });
  return accepted === true;
}

function promptMessage(field: InitField): string {
  switch (field) {
    case "host":
      return "Tailscale host name or IP";
    case "sshUser":
      return "SSH user";
    case "sshDestination":
      return "SSH destination, such as user@box.example";
    case "snapshotUrl":
      return "Private snapshot git URL";
  }
}

function reportInit(result: InitResult, writeLine: (line: string) => void): void {
  for (const leftover of result.leftovers) {
    writeLine(`Leftover: ${leftover.path} (${leftover.reason})`);
  }
  if (result.dryRun) {
    const plan = result.plan;
    const contents = `${plan.skills.length} ${plan.skills.length === 1 ? "skill" : "skills"}${plan.instructions ? " and AGENTS.md" : ""}`;
    writeLine("Init plan (no changes will be made):");
    writeLine(`Operator: ${plan.operator}`);
    writeLine(`Box: ${plan.box}`);
    writeLine(`Probe: SSH connection to ${plan.box}`);
    writeLine(`Snapshot: Clone or open ${plan.gitRemote} at ${plan.localCheckout}`);
    writeLine(`Publish: ${contents} to ${plan.gitRemote}`);
    writeLine(`Config: Write ${plan.configPath}`);
    writeLine("Convert: Back up live managed paths, then create these links:");
    for (const link of plan.links) {
      writeLine(`Link (${link.harness}): ${link.path} -> ${link.target}`);
    }
    for (const line of denyListLines()) writeLine(line);
    return;
  }
  writeLine(result.published ? "Snapshot seed published." : "Snapshot already matches the seed.");
}

function renderError(message: string): void {
  prompts.log.error(message);
}

function errorMessage(error: unknown): string {
  if (error instanceof Error && error.message) return error.message;
  if (typeof error === "string" && error) return error;
  return "Ferry failed.";
}

function setExitCode(code: number): void {
  process.exitCode = code;
}
