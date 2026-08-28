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
  SyncError,
  type SyncInput,
  type SyncResult,
} from "./sync.ts";
import { loadRegistry, type Registry } from "./registry/load.ts";
import {
  runStatusCommand,
  type StatusCommandDependencies,
  type StatusCommandInput,
} from "./status-command.ts";

const DESCRIPTION = `Ferry keeps a remote Linux agent box in the same shape as this machine.

Use ferry init to record one Tailscale host and seed the private snapshot.

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
  readonly prompt?: InitPrompt;
  readonly writeLine?: (line: string) => void;
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
    .description("Record a host, seed the snapshot, and convert this machine")
    .option("--host <host>", "Tailscale host name or IP address")
    .option("--ssh-user <user>", "SSH user on the host")
    .option("--snapshot-url <url>", "private snapshot git URL")
    .action(async (options: { host?: string; sshUser?: string; snapshotUrl?: string }) => {
      const execute = dependencies.runInit ?? runInit;
      const result = await execute(
        {
          host: options.host,
          sshUser: options.sshUser,
          snapshotUrl: options.snapshotUrl,
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
  return program;
}

if (import.meta.main) {
  try {
    await buildProgram().parseAsync(Bun.argv);
  } catch (error) {
    if (error instanceof SyncError) {
      console.error(error.message);
      process.exitCode = 1;
    } else if (error instanceof InstallAuthCommandError) {
      process.exitCode = 1;
    } else {
      throw error;
    }
  }
}

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
  const result: { host?: string; sshUser?: string; snapshotUrl?: string } = {};

  for (const field of missing) {
    const answer = await prompts.text({
      message: promptMessage(field),
      initialValue: current[field],
      validate: (value) =>
        !value || value.trim() === "" ? "This value is required." : undefined,
    });
    if (prompts.isCancel(answer)) {
      prompts.cancel("Init cancelled.");
      throw new Error("init cancelled");
    }
    result[field] = answer;
  }
  return result;
}

function promptMessage(field: InitField): string {
  switch (field) {
    case "host":
      return "Tailscale host name or IP";
    case "sshUser":
      return "SSH user";
    case "snapshotUrl":
      return "Private snapshot git URL";
  }
}

function reportInit(result: InitResult, writeLine: (line: string) => void): void {
  for (const leftover of result.leftovers) {
    writeLine(`Leftover: ${leftover.path} (${leftover.reason})`);
  }
  writeLine(`Paseo: ${result.address}:${result.paseoPort}`);
  writeLine(result.published ? "Snapshot seed published." : "Snapshot already matches the seed.");
}
