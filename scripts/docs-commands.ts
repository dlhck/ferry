/**
 * Write docs/commands.md from the --help text of each command and subcommand.
 * Run `bun scripts/docs-commands.ts` after a change to a command, an option, or a help text.
 * test/docs-commands.test.ts fails when the committed file differs from this output.
 */
import type { Command } from "commander";
import { join } from "node:path";
import { buildProgram } from "../src/cli.ts";
import { createSherlock } from "../src/integrations/sherlock.ts";
import { paseo } from "../src/integrations/paseo.ts";

export const COMMANDS_PAGE = join(import.meta.dir, "..", "docs", "commands.md");

/** The help text does not depend on the terminal. */
const HELP_WIDTH = 80;

const INTRO = `---
title: Commands
description: The help text of each Ferry command and subcommand.
---

<!-- This file is generated. Do not edit it. Run: bun scripts/docs-commands.ts -->

# Commands

This page has the \`--help\` text of each Ferry command and subcommand, from the Ferry source. Run \`ferry <command> --help\` to get the text of your version.

The \`ferry sherlock\` commands exist only when the Sherlock integration is on and \`sherlock\` is on the PATH.
`;

/**
 * The CLI of a machine with each integration on, so that the page has the commands of each one.
 * It does not read the config or the PATH of this machine.
 */
function program(): Command {
  return buildProgram({
    readConfig: () => ({ integrations: { sherlock: true } }),
    integrations: [paseo, createSherlock({ which: () => "/usr/local/bin/sherlock" })],
  });
}

/** The help of one command, with the text that the command adds after it. */
function helpText(command: Command): string {
  let text = "";
  command.configureHelp({ ...command.configureHelp(), helpWidth: HELP_WIDTH });
  command.configureOutput({
    ...command.configureOutput(),
    writeOut: (chunk) => {
      text += chunk;
    },
    getOutHelpWidth: () => HELP_WIDTH,
    getOutHasColors: () => false,
  });
  command.outputHelp();
  return text
    .split("\n")
    .map((line) => line.trimEnd())
    .join("\n")
    .trim();
}

function commandPath(command: Command): string {
  const names: string[] = [];
  for (let current: Command | null = command; current; current = current.parent) names.unshift(current.name());
  return names.join(" ");
}

/** The visible commands below `command`, each one before its subcommands. */
function visibleCommands(command: Command): Command[] {
  const help = command.createHelp();
  return help
    .visibleCommands(command)
    .filter((child) => child.name() !== "help")
    .flatMap((child) => [child, ...visibleCommands(child)]);
}

function anchor(path: string): string {
  return path.replaceAll(" ", "-");
}

export function renderCommandsPage(): string {
  const root = program();
  const commands = [root, ...visibleCommands(root)];
  const index = commands.map((command) => {
    const path = commandPath(command);
    const indent = "  ".repeat(path.split(" ").length - 1);
    return `${indent}- [\`${path}\`](#${anchor(path)})`;
  });
  // The help of Sherlock has {{port}}, which Liquid must not read.
  const sections = commands.map((command) => {
    const path = commandPath(command);
    const level = path.split(" ").length > 2 ? "###" : "##";
    return `${level} ${path}\n\n\`\`\`text\n${helpText(command)}\n\`\`\``;
  });
  return `${INTRO}\n${index.join("\n")}\n\n<!-- {% raw %} -->\n\n${sections.join("\n\n")}\n\n<!-- {% endraw %} -->\n`;
}

if (import.meta.main) {
  await Bun.write(COMMANDS_PAGE, renderCommandsPage());
  console.log(`Wrote ${COMMANDS_PAGE}`);
}
