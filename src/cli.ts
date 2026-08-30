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
  runSync as runSyncCommand,
  type SyncInput,
  type SyncResult,
} from "./sync.ts";
import { loadRegistry, type Registry } from "./registry/load.ts";
import {
  runStatusCommand,
  type StatusCommandDependencies,
  type StatusCommandInput,
} from "./status-command.ts";
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

const DESCRIPTION = `Ferry keeps a remote Linux agent box in the same shape as this machine.

Use ferry init to record a Tailscale host or OpenSSH destination and seed the
private snapshot.

Ferry never copies logins. Vendor sessions stay on the machine that created
them. Ferry starts a login on the box and you finish it in a browser here.`;

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
  readonly runSync?: (input: SyncInput) => Promise<SyncResult>;
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
  readonly prompt?: InitPrompt;
  readonly writeLine?: (line: string) => void;
};

type CliRuntime = {
  readonly renderError?: (message: string) => void;
  readonly setExitCode?: (code: number) => void;
};

export function buildProgram(dependencies: CliDependencies = {}): Command {
  // One registry for the whole run. Every command below reads it, none owns it.
  const registry = resolveRegistry();
  const program = new Command();
  program
    .name("ferry")
    .description(DESCRIPTION)
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
      const result = await execute(
        {
          host: options.host,
          sshUser: options.sshUser,
          sshDestination: options.sshDestination,
          snapshotUrl: options.snapshotUrl,
          dryRun: options.dryRun === true,
          harnesses: registry.harnesses,
        },
        { prompt: dependencies.prompt ?? promptForInit },
      );
      reportInit(result, dependencies.writeLine ?? console.log);
    });

  program
    .command("install")
    .description("Install the supported agent tools on the configured box")
    .option("--yes", "run without a confirmation prompt")
    .action(async (options: { yes?: boolean }) => {
      await (dependencies.runInstall ?? runInstallCommand)(
        { yes: options.yes === true },
        { tools: registry.tools },
      );
    });

  program
    .command("uninstall")
    .description("Remove Ferry's local state and restore paths changed by init")
    .action(() => {
      const result = (dependencies.runUninstall ?? runUninstall)({ harnesses: registry.harnesses });
      const restored = `${result.restored} ${result.restored === 1 ? "path" : "paths"}`;
      const removed = `${result.removed} managed ${result.removed === 1 ? "path" : "paths"}`;
      (dependencies.writeLine ?? console.log)(
        `Uninstalled Ferry. Restored ${restored} and removed ${removed}.`,
      );
    });

  program
    .command("auth [provider]")
    .description("Start a login on the configured box without copying credentials")
    .action(async (provider?: string) => {
      await (dependencies.runAuth ?? runAuthCommand)({ provider }, { tools: registry.tools });
    });

  program
    .command("sync")
    .description("Publish the snapshot and apply it to the configured box")
    .option("--dry-run", "print the plan without writing")
    .option("--force", "back up live managed paths before Apply links them")
    .option("-m, --message <message>", "snapshot commit message")
    .action(async (options: { dryRun?: boolean; force?: boolean; message?: string }) => {
      await (dependencies.runSync ?? runSyncCommand)({
        dryRun: options.dryRun === true,
        force: options.force === true,
        message: options.message,
      });
    });

  program
    .command("status")
    .description("Inspect link, snapshot, managed paths, and box logins without writing")
    .option("--json", "print the status report as JSON")
    .action(async (options: { json?: boolean }) => {
      await (dependencies.runStatus ?? runStatusCommand)(
        { json: options.json === true },
        {
          writeLine: dependencies.writeLine ?? console.log,
        },
      );
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
        await (dependencies.runWatch ?? runWatch)({ signal: controller.signal });
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
    (runtime.setExitCode ?? setExitCode)(1);
  }
}

if (import.meta.main) await runCli(Bun.argv.slice(2));

/** Resolve the builtin registry. Operator entries arrive when config carries them. */
function resolveRegistry(): Registry {
  const registry = loadRegistry();
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

function promptMessage(field: InitField): string {
  switch (field) {
    case "host":
      return "Tailscale host name or IP";
    case "sshUser":
      return "SSH user";
    case "sshDestination":
      return "SSH destination, such as ubuntu@orb";
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
    return;
  }
  writeLine(`Paseo: ${result.address}:${result.paseoPort}`);
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
