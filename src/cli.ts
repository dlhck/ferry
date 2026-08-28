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

const DESCRIPTION = `Ferry keeps a remote Linux agent box in the same shape as this machine.

Use ferry init to record one Tailscale host and seed the private snapshot.

Ferry never copies logins. Vendor sessions stay on the machine that created
them. Ferry starts a login on the box and you finish it in a browser here.`;

type CliDependencies = {
  readonly runInit?: (input: InitInput, dependencies?: InitDependencies) => Promise<InitResult>;
  readonly prompt?: InitPrompt;
  readonly writeLine?: (line: string) => void;
};

export function buildProgram(dependencies: CliDependencies = {}): Command {
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
        { host: options.host, sshUser: options.sshUser, snapshotUrl: options.snapshotUrl },
        { prompt: dependencies.prompt ?? promptForInit },
      );
      reportInit(result, dependencies.writeLine ?? console.log);
    });
  return program;
}

if (import.meta.main) {
  await buildProgram().parseAsync(Bun.argv);
}

async function promptForInit(missing: readonly InitField[], current: InitInput): Promise<InitInput> {
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
