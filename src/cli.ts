#!/usr/bin/env bun

import { Command } from "commander";

const DESCRIPTION = `Ferry keeps a remote Linux agent box in the same shape as this machine.

No commands work yet. init, install, sync, auth, and status arrive in later
issues. See PRD.md for the v1 specification.

Ferry never copies logins. Vendor sessions stay on the machine that created
them. Ferry starts a login on the box and you finish it in a browser here.`;

export function buildProgram(): Command {
  const program = new Command();
  program
    .name("ferry")
    .description(DESCRIPTION)
    .showHelpAfterError()
    .action(() => {
      program.outputHelp();
    });
  return program;
}

if (import.meta.main) {
  await buildProgram().parseAsync(Bun.argv);
}
