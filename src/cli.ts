#!/usr/bin/env bun

import { Command, CommanderError, Option } from "commander";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
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
  type AuthCommandResult,
  type InstallCommandDependencies,
  type InstallCommandInput,
  type InstallCommandResult,
} from "./install-auth.ts";
import {
  BoxesSyncError,
  denyListLines,
  runSync as runSyncCommand,
  type SyncDependencies,
  type SyncInput,
  type SyncResult,
} from "./sync.ts";
import { plainProgress, terminalProgress, type Progress } from "./progress.ts";
import { confirmationRequired, ERROR_CODES, FerryError } from "./errors.ts";
import {
  errorEvent,
  errorInfo,
  EVENT_TYPES,
  failureEnvelope,
  successEnvelope,
  type OutputEvent,
} from "./output.ts";
import {
  isBoxName,
  readConfig,
  setIntegration,
  writeConfig,
  type GitAuth,
  type PartialOperatorConfig,
} from "./config.ts";
import { BOX_MARKER } from "./box-ferry.ts";
import { BoxRequiredError, resolveBoxes, resolveTargetBox, type ResolvedBox } from "./boxes.ts";
import {
  boxListLines,
  runBoxAdd,
  runBoxDefault,
  runBoxList,
  runBoxRemove,
  type BoxCommandDependencies,
} from "./box.ts";
import type { IntegrationId } from "./integrations/types.ts";
import { INTEGRATIONS, integrationLines, listIntegrations, operatorIntegrations, type Integration } from "./integrations/index.ts";
import {
  runIntegrationCommand,
  type IntegrationCommandDependencies,
  type IntegrationCommandInput,
  type IntegrationCommandResult,
} from "./integrations/command.ts";
import { Link, type LinkOptions } from "./link.ts";
import { loadRegistry, type Registry } from "./registry/load.ts";
import {
  formatBriefStatus,
  formatStatus,
  runBriefStatusCommand,
  runStatusCommand,
  type StatusCommandDependencies,
  type StatusCommandInput,
} from "./status-command.ts";
import type { BriefStatusReport, StatusReport } from "./status.ts";
import { failedChecks, formatDoctor, runDoctor, type DoctorDependencies, type DoctorInput, type DoctorReport } from "./doctor.ts";
import { runToolsCommand, toolsLines, type ToolsCommandDependencies, type ToolsReport } from "./tools/command.ts";
import { boxPathDirs } from "./tools/path.ts";
import { runWatch, type WatchDependencies, type WatchInput } from "./watch.ts";
import {
  installMenuBar,
  uninstallMenuBar,
  type MenuBarInput,
  type MenuBarInstallResult,
  type MenuBarUninstallResult,
} from "./menubar.ts";
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
import {
  historyLines,
  HISTORY_LIMIT,
  runHistory,
  runRevert,
  type RevertDependencies,
  type RevertInput,
  type RevertResult,
} from "./revert.ts";
import { runSkillsAdd, SkillsAddError, type RunProcess } from "./skills-add.ts";
import { runMove, type MoveDependencies, type MoveInput, type MoveResult } from "./move.ts";
import { runExpose, type ExposeDependencies, type ExposeInput } from "./expose.ts";
import { runTunnel, type Listener, type TunnelDependencies, type TunnelInput } from "./tunnel.ts";
import {
  installTunnelService,
  uninstallTunnelService,
  type TunnelServiceInput,
  type TunnelServiceUninstallResult,
} from "./tunnel-service.ts";
import {
  runUpdateCommand,
  UpdateError,
  type UpdateCommandDependencies,
  type UpdateCommandInput,
  type UpdateCommandResult,
} from "./update.ts";
import { isReleaseVersion, VERSION } from "./version.ts";
import { offerSelfUpdate, offersSelfUpdate, runSelfUpdate, type SelfUpdateDependencies } from "./self-update.ts";

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
  ) => Promise<InstallCommandResult | null>;
  readonly runAuth?: (
    input: AuthCommandInput,
    dependencies?: Partial<AuthCommandDependencies>,
  ) => Promise<AuthCommandResult | null>;
  readonly runUpdate?: (
    input: UpdateCommandInput,
    dependencies?: Partial<UpdateCommandDependencies>,
  ) => Promise<UpdateCommandResult | null>;
  readonly runSync?: (input: SyncInput, dependencies?: SyncDependencies) => Promise<SyncResult>;
  readonly runHistory?: typeof runHistory;
  readonly runRevert?: (input: RevertInput, dependencies?: RevertDependencies) => Promise<RevertResult>;
  readonly runMove?: (input: MoveInput, dependencies?: Partial<MoveDependencies>) => Promise<MoveResult | null>;
  readonly runTunnel?: (
    input: TunnelInput,
    dependencies?: Partial<TunnelDependencies>,
  ) => Promise<readonly Listener[] | undefined>;
  readonly installTunnelService?: (input: TunnelServiceInput) => Promise<WatchServiceResult>;
  readonly uninstallTunnelService?: (input: TunnelServiceInput) => Promise<TunnelServiceUninstallResult>;
  readonly runBoxAdd?: typeof runBoxAdd;
  readonly runExpose?: (input: ExposeInput, dependencies?: Partial<ExposeDependencies>) => Promise<number>;
  /** True when this is a box install. The default is `isBoxMode`. */
  readonly isBoxMode?: () => boolean;
  /** True when stdin and stdout are a terminal, so Ferry can ask to update itself. */
  readonly isInteractive?: () => boolean;
  /** Asks to update Ferry. True when the update ran and the command must stop. The default is `offerSelfUpdate`. */
  readonly offerSelfUpdate?: () => Promise<boolean>;
  readonly runSelfUpdate?: typeof runSelfUpdate;
  /** Sets the exit code of `ferry expose`. */
  readonly setExitCode?: (code: number) => void;
  readonly runStatus?: (
    input: StatusCommandInput,
    dependencies?: Partial<StatusCommandDependencies>,
  ) => Promise<StatusReport>;
  readonly runDoctor?: (input: DoctorInput, dependencies?: Partial<DoctorDependencies>) => Promise<DoctorReport>;
  readonly runBriefStatus?: (
    input: StatusCommandInput,
    dependencies?: Partial<StatusCommandDependencies>,
  ) => Promise<BriefStatusReport>;
  readonly runWatch?: (input: WatchInput, dependencies?: WatchDependencies) => Promise<void>;
  readonly runUninstall?: (input: UninstallInput) => UninstallResult;
  readonly installWatchService?: (
    input?: WatchServiceInput,
    dependencies?: WatchServiceDependencies,
  ) => Promise<WatchServiceResult>;
  readonly installMenuBar?: (input: MenuBarInput) => Promise<MenuBarInstallResult>;
  readonly uninstallMenuBar?: () => Promise<MenuBarUninstallResult>;
  readonly runIntegration?: (
    input: IntegrationCommandInput,
    dependencies?: Partial<IntegrationCommandDependencies>,
  ) => Promise<IntegrationCommandResult | null>;
  readonly runTools?: (
    dependencies: Pick<ToolsCommandDependencies, "tools"> & Partial<ToolsCommandDependencies>,
  ) => Promise<ToolsReport>;
  readonly runProcess?: RunProcess;
  readonly readConfig?: () => PartialOperatorConfig | null;
  readonly integrations?: readonly Integration[];
  readonly prompt?: InitPrompt;
  readonly approveHostKeys?: (request: SnapshotHostKeyApproval) => Promise<boolean>;
  readonly confirmUninstall?: () => Promise<boolean>;
  /** The question of `ferry box add` before it changes a `[host]` config. */
  readonly confirm?: (message: string) => Promise<boolean | symbol | undefined>;
  /** Writes a line to stdout: the text of a command, or with --json, the JSON. */
  readonly writeLine?: (line: string) => void;
  /** Writes a line to stderr. With --json, the text lines of a command go here. */
  readonly writeError?: (line: string) => void;
  /** The reporter for one command run. The default is one live line and a table on a terminal, else plain lines. */
  readonly createProgress?: () => Progress;
  /** The reporter for `ferry watch` and for --json, whose log must stay plain. The default writes to stderr. */
  readonly createPlainProgress?: () => Progress;
};

/** The commands that stay running and print one event for each line with --json. */
const STREAM_COMMANDS = new Set(["watch", "tunnel", "expose"]);

const JSON_HELP = `JSON output (--json):
  stdout has only JSON. Progress and the text lines go to stderr. Ferry
  shows no prompt: a confirmation fails with confirmation-required unless
  you give --yes. The SSH host keys of init and box add need
  --accept-host-keys: --yes does not trust them, and error.details.hostKeys
  lists them. A command that runs and exits prints one envelope:
    {"schemaVersion":1,"command","ok","result","warnings","error"}
  error is null, or {"code","message","hint"}. On failure, ok is false and
  the exit code is not 0. A failed update, or a failed sync of more than
  one box, keeps the outcome of each box in result. watch, tunnel,
  tunnel --follow, and expose print one event for each line. Each event
  has "type". An error event also has "code", "message", and "hint".

${helpList("Error codes", ERROR_CODES)}
${helpList("Event types", EVENT_TYPES)}

  The help of each command gives its result. The ferry agent skill
  describes the full contract.`;

/** A labeled list for the help, wrapped at 78 columns. */
function helpList(label: string, items: readonly string[]): string {
  const lines = [`  ${label}:`];
  for (const item of items) {
    const last = lines.length - 1;
    if (`${lines[last]} ${item},`.length > 78) lines.push(`    ${item},`);
    else lines[last] = `${lines[last]} ${item},`;
  }
  return lines.join("\n").replace(/,$/, ".");
}

/** The --json result of each command, for its help. */
const JSON_RESULTS: Record<string, string> = {
  init: "{ dryRun, leftovers, published }, or with --dry-run { dryRun, leftovers, plan }",
  install: "{ plan: [{ tool, policy, version, action, command, dependsOn }], gitIdentity }",
  update: "{ dryRun, boxes: [{ name, ok, error, offline, plan, integrations }], operator, updated, failed }, also on failure",
  uninstall: "{ removed, restored }",
  auth:
    '{ providers: [{ id, login }] } without a provider, where login is "startable", "manual", or "off", else the login result { kind, provider, ... }. ' +
    'A "login" event line with the URL comes before the envelope. A login that needs the code from the browser reads it as one line on stdin',
  sync: "{ dryRun, published, boxes: [{ name, ok, step, error, plan, applyPlan, discarded }] }, also on failure of more than one box",
  history: "{ commits: [{ commit, date, subject, paths }] }, newest first",
  revert:
    "{ dryRun, commit, subject, tip, paths, settings: [{ file, keys }], sync }. sync is the sync result, or null with --dry-run or --no-sync",
  move: "{ path, source, destination, dryRun, git, carry, refused, skipped, notes, trash, sessions }",
  tunnel:
    "events forward-opened, forward-closed, forward-failed, following, connection-lost, tunnel-closed. " +
    "With --list, one envelope: { box, listeners: [{ port, address, process }] }",
  "tunnel install": "{ manager, path }",
  "tunnel uninstall": "{ manager, path, removed }",
  expose: "events exposed and exited. The output of the command goes to stderr",
  status:
    "the status report, schema version 2. With --brief, { schemaVersion: 1, checkedAt, boxes: [{ name, host, online, error, issues: [{ kind, name, state, message, command }], resources: { disk, memory, load } }] }",
  doctor:
    "{ schemaVersion: 1, ok, checks: [{ id, box, status, message, fix }] }, also on failure. status is ok, failed, or skipped",
  integrations: "{ boxes: [{ name, destination, integrations: [{ id, description, enabled, parts, available, localVersion, localSource, connectSteps }] }] }",
  "integrations enable": "{ integration, action, dryRun, plan, output, enabled, connectSteps }",
  "integrations disable": "{ integration, action, dryRun, plan, output, enabled, connectSteps }",
  tools: "{ tools: [{ id, name, kind, install, policy: { policy, default }, boxes, operatorVersion }] }",
  watch:
    "events watch-started, synced, sync-failed, sync-refused, content-refused, config-error, update-started, update-failed, status-failed, watch-stopped",
  "watch install": "{ manager, path }",
  "menubar install": "{ app, path, version, ferryPath }. version is null with --app",
  "menubar uninstall": "{ app, path, removed }",
  "self-update": "{ current, latest, updated, services: [{ service, action, message }] }. The output of the installer goes to stderr",
  "box list": "{ boxes: [{ name, transport, destination, default }] }",
  "box add": "{ name, transport, destination, gitAuth, migrated }",
  "box remove": "{ name, defaultBoxRemoved }",
  "box default": "{ defaultBox }",
  "skills add": "{ argv }. The output of npx goes to stderr",
};

type CliRuntime = {
  readonly renderError?: (message: string) => void;
  readonly setExitCode?: (code: number) => void;
};

/** The state of one run that `runCli` reads after an error. */
type RunState = {
  /** True when the run has --json. */
  json(): boolean;
  /** Print the error as JSON: an error event for a command that prints events, else the failure envelope. */
  printError(error: unknown, args: readonly string[]): void;
};

export function buildProgram(dependencies: CliDependencies = {}): Command {
  return createProgram(dependencies).program;
}

function createProgram(dependencies: CliDependencies): { program: Command; state: RunState } {
  // Commands that need the registry resolve it when they run. The program build reads the config
  // one time to add the operator commands of the integrations. A failed read does not stop the start.
  const config = () => (dependencies.readConfig ?? readConfig)() ?? {};
  const registry = () => resolveRegistry(config());
  /** Each box command puts the PATH directories of the registry tools in front of PATH. `ferry sync` adds them itself. */
  const createLink = (options: LinkOptions) => new Link({ ...options, pathDirs: boxPathDirs(registry().tools) });
  const program = new Command();
  const json = () => program.opts<{ json?: boolean }>().json === true;
  const writeOut = (line: string) => (dependencies.writeLine ?? console.log)(line);
  const writeError = (line: string) => (dependencies.writeError ?? ((text: string) => process.stderr.write(`${text}\n`)))(line);
  /** The text lines of a command. With --json, stdout carries only JSON, so they go to stderr. */
  const writeLine = (line: string) => (json() ? writeError : writeOut)(line);
  const plainReporter = () => (dependencies.createPlainProgress ?? (() => plainProgress(writeError)))();
  /** With --json, the progress is plain lines on stderr, with no live line. */
  const progress = () => (json() ? plainReporter() : (dependencies.createProgress ?? terminalProgress)());
  /** The command path of the run, such as `box add`. The preAction hook sets it. */
  let active: string | undefined;
  const warnings: string[] = [];
  /** The result of a failed run that keeps the outcome of each box, for the failure envelope. */
  let failedResult: unknown = null;
  const warn = (line: string) => {
    warnings.push(line);
  };
  /** Print the envelope with --json. Else `text` prints the result. */
  const report = <T>(result: T, text?: (result: T) => void) => {
    if (json()) writeOut(JSON.stringify(successEnvelope(active ?? "", result, warnings)));
    else text?.(result);
  };
  /** With --json, the dependency that prints one event for each line. */
  const events = () => (json() ? { emit: (event: OutputEvent) => writeOut(JSON.stringify(event)) } : {});
  /** With --json, a confirmation fails instead of a prompt. */
  const refuse = (question: string) => async (): Promise<never> => {
    throw confirmationRequired(question);
  };
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
  /**
   * The approval of the snapshot host keys. --accept-host-keys trusts them
   * without a prompt. --yes does not. With --json and without
   * --accept-host-keys, the approval fails, and the error has the keys.
   */
  const hostKeyApproval = (accept: boolean) => async (request: SnapshotHostKeyApproval): Promise<boolean> => {
    const keys = request.keys.map((key) => `${key.algorithm} ${key.fingerprint}`).join(", ");
    if (accept) {
      writeLine(`Trusting the SSH host keys for ${request.host} on the box (--accept-host-keys): ${keys}`);
      return true;
    }
    if (json()) {
      throw new FerryError(
        "confirmation-required",
        `Trust these SSH host keys for ${request.host} on the box: ${keys}? Ferry does not ask with --json.`,
        {
          hint: "Show the fingerprints to the operator. When the operator accepts them, add --accept-host-keys.",
          details: {
            hostKeys: request.keys.map((key) => ({ host: request.host, type: key.algorithm, fingerprint: key.fingerprint })),
          },
        },
      );
    }
    return (dependencies.approveHostKeys ?? approveHostKeys)(request);
  };
  const state: RunState = {
    json,
    printError(error, args) {
      const command = active ?? commandOf(program, args);
      const options = args.slice(0, args.includes("--") ? args.indexOf("--") : args.length);
      // A command that stays running prints events, also for an error before it starts. `tunnel --list` runs and exits.
      const events = STREAM_COMMANDS.has(command) && !(command === "tunnel" && options.includes("--list"));
      writeOut(JSON.stringify(events ? errorEvent("error", error) : failureEnvelope(command, error, warnings, failedResult)));
    },
  };
  program
    .name("ferry")
    .description(DESCRIPTION)
    .version(VERSION)
    // Commander throws instead of calling process.exit, so runCli can print a usage error as JSON.
    .exitOverride()
    .option(
      "--box <name>",
      "select a box of the config; repeat it to select more boxes",
      (name: string, names: string[] = []) => [...names, name],
    )
    .option(
      "--json",
      "print JSON on stdout: one result envelope, or one event for each line for watch, tunnel, and expose. Progress goes to stderr",
    )
    .showHelpAfterError()
    .addHelpText("after", `\n${JSON_HELP}`)
    .action(() => {
      program.outputHelp();
    });
  const boxNames = (): string[] => program.opts<{ box?: string[] }>().box ?? [];
  /** The commands that accept --box. Each other command refuses it. */
  const boxCommands = new Set<Command>();
  program.hook("preAction", async (_program, action) => {
    active = commandPath(action);
    // A box install runs only the box commands. Commander prints the version and help before this hook.
    if (action !== program && action.name() !== "expose" && (dependencies.isBoxMode ?? isBoxMode)()) {
      throw new FerryError(
        "usage",
        `This is a box install of Ferry (~/${BOX_MARKER}). Only ferry expose runs here. Run ferry ${commandPath(action)} on the operator machine.`,
      );
    }
    const names = boxNames();
    const invalid = names.find((name) => !isBoxName(name));
    if (invalid !== undefined) {
      throw new FerryError(
        "usage",
        `invalid box name ${invalid}. Use 1 to 32 characters from a-z, 0-9, and -, with no - at the start. The name all is reserved.`,
      );
    }
    if (names.length > 0 && !boxCommands.has(action)) {
      throw new FerryError("usage", `--box does not apply to ferry ${commandPath(action)}.`);
    }
    const offers = offersSelfUpdate({
      json: json(),
      // `self-update` does the check itself.
      streaming: STREAM_COMMANDS.has(active) || active === "self-update",
      interactive: (dependencies.isInteractive ?? isInteractive)(),
      env: process.env,
    });
    // After the update, the process is still the old version. Commander ends a run with exit code 0 without an error.
    if (offers && (await (dependencies.offerSelfUpdate ?? offerSelfUpdate)())) {
      throw new CommanderError(0, "ferry.selfUpdated", "");
    }
  });
  /**
   * The box of a single-target command, from `resolveTargetBox`. Undefined
   * for a `[host]` config without --box, so the command reads the config as
   * before.
   */
  const selectBox = (command: string): { config: PartialOperatorConfig; box: ResolvedBox } | undefined => {
    const names = boxNames();
    let current: PartialOperatorConfig;
    try {
      current = config();
    } catch (error) {
      // The command reports a config that it cannot read, as before.
      if (names.length === 0) return undefined;
      throw error;
    }
    if (!current.boxes && names.length === 0) return undefined;
    if (names.length > 1) throw new FerryError("usage", `ferry ${command} changes one box. Give --box once.`);
    return { config: current, box: resolveTargetBox(current, names[0]) };
  };
  /** A `readConfig` that shows the command one box as a `[host]` config, or nothing. */
  const boxConfig = (selected: { config: PartialOperatorConfig; box: ResolvedBox } | undefined) => {
    if (!selected) return {};
    const { boxes: _boxes, defaultBox: _defaultBox, ...rest } = selected.config;
    const view: PartialOperatorConfig = {
      ...rest,
      host: selected.box.host,
      integrations: selected.box.integrations,
      tools: selected.box.tools,
    };
    return { readConfig: () => view };
  };
  /** With box tables, `integrations enable|disable` sets the key in `[box.<name>.integrations]`. */
  const integrationBox = (selected: { config: PartialOperatorConfig; box: ResolvedBox } | undefined) => ({
    ...boxConfig(selected),
    ...(selected?.config.boxes
      ? {
          setIntegration: (id: IntegrationId, enabled: boolean) => setIntegration(id, enabled, homedir(), selected.box.name),
          box: selected.box.name,
        }
      : {}),
  });

  program
    .command("init")
    .summary("Record a Tailscale host or SSH destination, seed the snapshot, and convert this machine")
    .description(`Record a Tailscale host or SSH destination, seed the snapshot, and convert this machine.

The snapshot URL is an empty private git repository. Ferry does not create it.
For an SSH snapshot URL, load a key that can push to it into your SSH agent.
Ferry forwards the agent to the box to test read access, and asks before it
trusts the Git host key on the box. Ferry never falls back from Tailscale to
direct SSH.

With box tables, init runs again for the box of --box, else default_box, else
the only box. Use ferry box add to add a box.

Add a custom harness in ~/.ferry/config.toml. A repeat init keeps it:

  [[harness]]
  id = "opencode"
  name = "OpenCode"
  skill_root = ".config/opencode/skills"
  instruction_file = ".config/opencode/AGENTS.md"`)
    .option("--host <host>", "Tailscale host name or IP address")
    .option("--ssh-user <user>", "SSH user on the host")
    .option("--ssh-destination <destination>", "explicit OpenSSH destination")
    .option("--snapshot-url <url>", "private snapshot git URL")
    .option("--dry-run", "print the init plan without writing or connecting")
    .option("--accept-host-keys", "trust the SSH host keys of the snapshot host on the box without a confirmation prompt")
    .action(async (options: {
      host?: string;
      sshUser?: string;
      sshDestination?: string;
      snapshotUrl?: string;
      dryRun?: boolean;
      acceptHostKeys?: boolean;
    }) => {
      const execute = dependencies.runInit ?? runInit;
      const [box, ...others] = boxNames();
      if (others.length > 0) throw new FerryError("usage", "ferry init changes one box. Give --box once.");
      const result = await withProgress((progress) =>
        execute(
          {
            host: options.host,
            sshUser: options.sshUser,
            sshDestination: options.sshDestination,
            snapshotUrl: options.snapshotUrl,
            dryRun: options.dryRun === true,
            harnesses: registry().harnesses,
            ...(box !== undefined ? { box } : {}),
          },
          {
            // With --json, init asks for nothing, so missing values fail with missing-values.
            ...(json() ? {} : { prompt: dependencies.prompt ?? promptForInit }),
            approveHostKeys: hostKeyApproval(options.acceptHostKeys === true),
            createLink,
            progress,
          },
        ),
      );
      report(result, (result) => reportInit(result, writeLine));
    });

  program
    .command("install")
    .summary("Install the supported agent tools on the configured box")
    .description(`Install gh, jq, the agent CLIs, the tools of the config, and Ferry on the box.

Ferry prints the plan for each tool and asks before it runs a command on the
box. gh and jq come from apt, so Debian or Ubuntu is the tested target. Ferry on the
box is the version of this machine. It is a box install that runs only
ferry expose. Run ferry tools --help for the tool config.`)
    .option("--yes", "run without a confirmation prompt")
    .action(async (options: { yes?: boolean }) => {
      const result = await withProgress((progress, writeLine) =>
        (dependencies.runInstall ?? runInstallCommand)(
          { yes: options.yes === true },
          {
            tools: registry().tools,
            createLink,
            progress,
            writeLine,
            ...(json() ? { confirm: refuse("Run these commands on the box?") } : {}),
            ...boxConfig(selectBox("install")),
          },
        ),
      );
      report(result);
    });

  program
    .command("update")
    .summary("Update the agent tools on the configured box and on this machine")
    .description(`Update the agent tools on the boxes and on this machine.

On this machine, Ferry updates only the agent CLIs that are installed. It does
not update Ferry itself. Each box gets the tool versions of its policy, the
Ferry version of this machine, and Paseo when the integration is on. The Paseo
update restarts the daemon, which stops the agents on the box.

With [update] watch = true in ~/.ferry/config.toml, ferry watch runs this
update once each day for the tools with the "latest" policy. The gh update
runs sudo apt on the box, and the watch has no terminal for a password. Add
this rule on the box with sudo visudo -f /etc/sudoers.d/ferry:

  <ssh-user> ALL=(root) NOPASSWD: /usr/bin/true, \\
    /usr/bin/apt update, /usr/bin/apt install gh -y

ferry status shows "Box sudo: PASSWORDLESS" when the rule works.`)
    .option("--yes", "run without a confirmation prompt")
    .option("--dry-run", "print the update plan without running it")
    .action(async (options: { yes?: boolean; dryRun?: boolean }) => {
      const result = await withProgress((progress, writeLine) =>
        (dependencies.runUpdate ?? runUpdateCommand)(
          { yes: options.yes === true, dryRun: options.dryRun === true, includeIntegrations: true, boxes: boxNames() },
          {
            tools: registry().tools,
            readConfig: config,
            createLink,
            progress,
            writeLine,
            ...(json() ? { confirm: refuse("Run these updates?") } : {}),
          },
        ),
      ).catch((error: unknown) => {
        if (error instanceof UpdateError && error.result) failedResult = error.result;
        throw error;
      });
      report(result);
    });

  program
    .command("uninstall")
    .description("Remove Ferry's local state and restore paths changed by init")
    .option("--yes", "run without a confirmation prompt")
    .action(async (options: { yes?: boolean }) => {
      const question = "Remove Ferry's local state and restore the paths changed by init?";
      if (!options.yes && !(await (json() ? refuse(question) : (dependencies.confirmUninstall ?? confirmUninstall))())) {
        writeLine("Uninstall cancelled.");
        return;
      }
      const result = (dependencies.runUninstall ?? runUninstall)({ harnesses: registry().harnesses });
      report(result, (result) => {
        const restored = `${result.restored} ${result.restored === 1 ? "path" : "paths"}`;
        const removed = `${result.removed} managed ${result.removed === 1 ? "path" : "paths"}`;
        writeLine(`Uninstalled Ferry. Restored ${restored} and removed ${removed}.`);
      });
    });

  program
    .command("auth [provider]")
    .summary("Start a login on the configured box without copying credentials")
    .description(`Start a login on the configured box without copying credentials.

Tools: gh, claude, codex, cursor, and each [tools.<id>] table with login keys
(see ferry tools --help). Ferry starts the vendor login on the box and prints
a URL, and a code if the tool has one. Finish the login in a browser
on this machine. When codex gives no device code, Ferry forwards local port
1455 to the box for up to 120 seconds. Pi has no remote login. Run pi on the
box and use /login.

ferry auth gh also creates ~/.ssh/id_ed25519 on the box if it is missing, and
adds it to your GitHub account with the title "<box host> (ferry)", so agents
on the box can push. Delete that key in GitHub to revoke it.

--mcp <server> logs in to a remote MCP server on the box. Give the provider,
as in ferry auth codex --mcp linear, or the name that ferry status shows, as
in ferry auth --mcp codex/linear. Ferry forwards the localhost callback port,
such as 3118 for Claude, for up to 300 seconds. The port must be free on
this machine.

Without a provider, Ferry lists the tools and their login: startable,
manual SSH flow, or off.`)
    .option("--mcp <server>", "start the MCP server login of the provider CLI on the box, such as linear or codex/linear")
    .action(async (provider: string | undefined, options: { mcp?: string }) => {
      const result = await (dependencies.runAuth ?? runAuthCommand)(
        options.mcp === undefined ? { provider } : { provider, mcp: options.mcp },
        {
          tools: registry().tools,
          createLink,
          progress: progress(),
          writeLine,
          ...events(),
          // With --json, Ferry shows no prompt. A login that needs the code from the browser reads it from stdin.
          ...(json() ? { readLoginCode: readStdinLine } : {}),
          ...boxConfig(selectBox("auth")),
        },
      );
      report(result);
    });

  program
    .command("sync")
    .summary("Publish the snapshot and apply it to the selected boxes, or to all boxes")
    .description(`Publish the snapshot and apply it to the selected boxes, or to all boxes.

A file that looks like a secret stops the sync before the publish. The error
names the file, never the value. Ferry skips MCP servers that are neither
remote HTTPS servers nor stdio commands, stdio MCP servers and hooks that refer
to home paths that the box does not have, and prints a line for each. A stdio
MCP server carries its command, its arguments, and the names of its env keys,
never their values.
Ferry syncs up to 4 boxes at the same time. A failed box does not stop the
other boxes. Sync also writes the ferry PATH block in ~/.profile on the box.

If a plugin in enabledPlugins comes from a marketplace that
extraKnownMarketplaces does not list, run claude plugin marketplace add for it
once on this machine.`)
    .option("--dry-run", "print the plan without writing")
    .option("--force", "back up live managed paths before Apply links them")
    .option("-m, --message <message>", "snapshot commit message")
    .action(async (options: { dryRun?: boolean; force?: boolean; message?: string }) => {
      const result = await withProgress((progress, writeLine) =>
        (dependencies.runSync ?? runSyncCommand)(
          {
            dryRun: options.dryRun === true,
            force: options.force === true,
            message: options.message,
            boxes: boxNames(),
          },
          { progress, writeLine, warn },
        ),
      ).catch((error: unknown) => {
        if (error instanceof BoxesSyncError) {
          failedResult = syncResult({ dryRun: false, published: error.published, boxes: error.results });
        }
        throw error;
      });
      report(syncResult(result));
    });

  program
    .command("history")
    .summary("List the recent snapshot commits and the paths each one changed")
    .description(`List the recent snapshot commits and the paths each one changed.

Ferry reads the local snapshot checkout in ~/.ferry/store. Give a commit id to
ferry revert to undo that commit.`)
    .option("-n, --limit <count>", `the number of commits (default: ${HISTORY_LIMIT})`, (value: string) => {
      const count = Number(value);
      if (!Number.isInteger(count) || count < 1) throw new FerryError("usage", "--limit must be a whole number above 0.");
      return count;
    })
    .action(async (options: { limit?: number }) => {
      const commits = await (dependencies.runHistory ?? runHistory)({ limit: options.limit });
      report({ commits }, ({ commits }) => {
        for (const line of historyLines(commits)) writeLine(line);
      });
    });

  program
    .command("revert")
    .summary("Undo one snapshot commit on this machine and on all boxes")
    .description(`Undo one snapshot commit on this machine and on all boxes.

Ferry undoes the commit as git revert does, and later commits stay. The
skills, AGENTS.md, and extra roots on this machine link into the snapshot, so
they change with it. Ferry writes the reverted settings keys back into the
local settings files and keeps all other keys. Then Ferry syncs all boxes.

Ferry stops and changes nothing when a later commit changes the same lines,
or when this machine has changes that are not in the snapshot. Run ferry sync
first. Run ferry history for the commit ids.`)
    .argument("<commit>", "the snapshot commit to undo")
    .option("--dry-run", "print what the revert changes without writing")
    .option("--no-sync", "do not sync the boxes after the revert")
    .action(async (commit: string, options: { dryRun?: boolean; sync: boolean }) => {
      const result = await withProgress((progress, writeLine) =>
        (dependencies.runRevert ?? runRevert)(
          { commit, dryRun: options.dryRun === true, sync: options.sync },
          { progress, writeLine, syncDependencies: { warn } },
        ),
      ).catch((error: unknown) => {
        if (error instanceof BoxesSyncError) {
          failedResult = syncResult({ dryRun: false, published: error.published, boxes: error.results });
        }
        throw error;
      });
      report({ ...result, sync: result.sync ? syncResult(result.sync) : null });
    });

  program
    .command("move")
    .summary("Continue a project on a box, on this machine with --from-box, or on another box with both")
    .description(`Continue a project on a box, on this machine with --from-box, or on another box with both.

The path must be inside the home directory. The destination uses the same path
relative to its home. Ferry refuses unpushed commits, uncommitted changes to
tracked files, and a destination path that exists. The destination clones from
origin with its own SSH key, so run ferry auth gh for a box first. Ferry
carries the untracked and ignored files that pass the deny rules, skips build
output such as node_modules and dist, and checks each file with SHA-256.
Between two boxes, the files go through a temporary directory on this machine,
and nothing stays here. With --remove, the source copy goes to ~/.Trash on
macOS, else to ~/.ferry/trash. Run --dry-run first.

Ferry also carries the Claude and Codex sessions of the project and the Claude
project memory, so claude --resume and codex resume find them on the
destination. A session file there stays, unless the source has the same file.
Ferry skips a session that fails the deny rules and names the file and the
rule. The source keeps its sessions.`)
    .argument("<path>", "project folder inside the home directory")
    .option("--from-box <name>", "move the project from this box. Without --to-box, the destination is this machine")
    .option("--to-box <name>", "move the project to this box. Without it and --from-box, Ferry uses default_box or the only box")
    .option("--dry-run", "print what Ferry would carry, refuse, and skip without changes")
    .option("--remove", "after verification, move the source copy to a trash directory")
    .option("--include-env", "also carry .env files that pass the token and secret rules")
    .option("--no-sessions", "do not carry the agent sessions and the project memory")
    .option("--allow-secrets", "also carry sessions, and with --include-env .env files, that hold tokens or secrets")
    .option("--yes", "carry .env files with secrets without a confirmation prompt")
    .action(
      async (
        path: string,
        options: {
          fromBox?: string;
          toBox?: string;
          dryRun?: boolean;
          remove?: boolean;
          includeEnv?: boolean;
          sessions?: boolean;
          allowSecrets?: boolean;
          yes?: boolean;
        },
      ) => {
        if (boxNames().length > 0) {
          throw new FerryError("usage", "ferry move does not accept --box. Use --from-box <name> or --to-box <name>.");
        }
        const result = await withProgress((progress, writeLine) =>
          (dependencies.runMove ?? runMove)(
            {
              path,
              fromBox: options.fromBox,
              toBox: options.toBox,
              dryRun: options.dryRun === true,
              remove: options.remove === true,
              includeEnv: options.includeEnv === true,
              sessions: options.sessions !== false,
              allowSecrets: options.allowSecrets === true,
              yes: options.yes === true,
            },
            {
              createLink,
              writeLine,
              progress,
              warn,
              // With --json, Ferry asks nothing, so files with secrets need --yes.
              ...(json() ? { interactive: false } : {}),
            },
          ),
        );
        report(result);
      },
    );

  const tunnel = program
    .command("tunnel")
    .summary("Open box ports on this machine until Ctrl-C, list the ports that listen on the box, or follow the ports of ferry expose")
    .description(`Open box ports on this machine until Ctrl-C, list the ports that listen on the box, or follow the ports of ferry expose.

Local ports bind to 127.0.0.1 only. The box end is 127.0.0.1 on the box, so a
dev server that listens only on ::1 does not answer. A plain tunnel does not
reconnect. With --follow, the local port is the box port when it is free, else
the next free port, and Ferry connects again 5 seconds after a drop. Run
ferry tunnel install to run --follow as a user service.

Put a host before the box port to forward to a host that the box can reach,
such as a database that accepts connections only from the box network. A
numeric first part is a box port. The box resolves the host name. Put an IPv6
address in brackets. Ferry first checks that the box can connect to the host,
and stops with an error when it cannot.

  5432                   127.0.0.1:5432 on the box, local port 5432
  5432:15432             127.0.0.1:5432 on the box, local port 15432
  db.example:5432        db.example:5432 from the box, local port 5432
  db.example:5432:15432  db.example:5432 from the box, local port 15432
  [fd00::1]:5432         [fd00::1]:5432 from the box, local port 5432

A plain tunnel works as the child process of another program. It never
prompts: OpenSSH runs in batch mode. The local port accepts connections after
the SSH connection is ready. SIGTERM closes the tunnel with exit code 0.

--follow writes its forwards to ~/.ferry/tunnels/<box>.json when it connects,
after each change, and when the connection drops. The menu bar app reads the
file. Fields: schemaVersion (1), box, pid, connected (false after a drop, with
no forwards), updatedAt, and forwards: [{ name, cwd, boxPort, localPort }].
name and cwd are missing when the entry of ferry expose has none. Ferry
removes the file when --follow stops on Ctrl-C or SIGTERM.`)
    .argument(
      "[ports...]",
      "box port, box:local to pick another local port, or host:port[:local] for a host that the box can reach, such as 3000, 3000:4000, or db.example:5432",
    )
    .option("--list", "list the TCP ports that listen on the box, with process names")
    .option("--follow", "open a forward for each port that ferry expose announces on the box, and close it when the port goes away")
    .action(async (ports: string[], options: { list?: boolean; follow?: boolean }) => {
      const { name, host } = tunnelBox();
      const listeners = await (dependencies.runTunnel ?? runTunnel)(
        { ports, list: options.list === true, ...(options.follow === true ? { follow: true } : {}), box: { name, host } },
        { createLink, writeLine, ...events() },
      );
      if (options.list === true) report({ box: name, listeners: listeners ?? [] });
    });
  const tunnelInstall = tunnel
    .command("install")
    .summary("Install and start a user service that runs ferry tunnel --follow for one box")
    .description(`Install and start a user service that runs ferry tunnel --follow for one box.

The box is --box, then default_box, then the only box. The service always
runs with --box <box>, so a later default_box does not change it. Each box has
its own service:

  macOS  ~/Library/LaunchAgents/dev.ferry.tunnel.<box>.plist
         log: ~/Library/Logs/ferry-tunnel-<box>.log
  Linux  ~/.config/systemd/user/ferry-tunnel-<box>.service
         log: journalctl --user -u ferry-tunnel-<box>.service -f

The service writes ~/.ferry/tunnels/<box>.json, as ferry tunnel --follow does.
The menu bar app shows its ports.

The service starts again each time it exits. The service records the path of
this Ferry, the current PATH, and SSH_AUTH_SOCK. PATH must find ssh, and
tailscale for a Tailscale box. Run the command again after you move Ferry or
change these values. A successful ferry self-update restarts the service when
it points at the updated Ferry.`)
    .action(async () => {
      const { name } = tunnelBox();
      const result = await (dependencies.installTunnelService ?? installTunnelService)({ box: name });
      report(result, (result) => writeLine(`Installed ${result.manager} service at ${result.path}`));
    });
  const tunnelUninstall = tunnel
    .command("uninstall")
    .summary("Stop and remove the tunnel user service of one box")
    .description(`Stop and remove the tunnel user service of one box.

The box is --box, then default_box, then the only box. Ferry removes the file
that ferry tunnel install wrote. The macOS log stays.`)
    .action(async () => {
      const { name } = tunnelBox();
      const result = await (dependencies.uninstallTunnelService ?? uninstallTunnelService)({ box: name });
      report(result, (result) =>
        writeLine(result.removed ? `Removed ${result.manager} service at ${result.path}` : `No ${result.manager} service at ${result.path}`),
      );
    });
  boxCommands.add(tunnelInstall);
  boxCommands.add(tunnelUninstall);
  /** The one box of `ferry tunnel`: --box, then default_box, then the only box. */
  const tunnelBox = (): ResolvedBox => {
    const names = boxNames();
    if (names.length > 1) throw new FerryError("usage", "ferry tunnel opens the ports of one box. Give --box once.");
    const current = config();
    const selected = names[0] ?? current.defaultBox;
    const boxes = resolveBoxes(current, selected === undefined ? [] : [selected]);
    if (boxes.length === 1) return boxes[0]!;
    throw new BoxRequiredError(
      `ferry tunnel opens the ports of one box, and ${boxes.length} boxes are configured (${boxes.map((box) => box.name).join(", ")}). ` +
        "Add --box <name>, or set default_box in the config.",
    );
  };

  program
    .command("expose")
    .summary("Run a command on the box and announce its port to ferry tunnel --follow")
    .description(`Run a command on the box and announce its port to ferry tunnel --follow.

Ferry writes ~/.ferry/exposed/<pid>.json before the command starts and
removes it when the command exits. At the start, Ferry removes the entries
whose pid does not run. Ferry forwards SIGINT, SIGTERM, and SIGHUP to the
command and exits with its exit code. Put the command after --.

For example, a service script in paseo.json on the box:

  "web": {
    "type": "service",
    "command": "ferry expose -- bun run dev --port $PASEO_PORT"
  }`)
    .argument("<command...>", "the command to run, after --, such as -- bun run dev")
    .option("--port <n>", "the port of the command. The default is $PASEO_PORT")
    .action(async (command: string[], options: { port?: string }) => {
      const code = await (dependencies.runExpose ?? runExpose)(
        {
          command,
          ...(options.port !== undefined ? { port: options.port } : {}),
        },
        // With --json, stdout carries only the events, so the output of the command goes to stderr.
        json() ? { ...events(), stdout: "stderr" } : {},
      );
      (dependencies.setExitCode ?? setExitCode)(code);
    });

  program
    .command("status")
    .summary("Inspect link, snapshot, managed paths, and box logins without writing")
    .description(`Inspect link, snapshot, managed paths, and box logins without writing.

The Tools part of each box shows one state for each tool: ok; drift, run
ferry update; missing, run ferry install; hidden, a login shell on the box
does not find the tool, run ferry sync; skipped, the tool has no target;
unknown, Ferry cannot read the box version. With --json, result is the
status report, schema version 2. The ferry agent skill describes its fields.
Install the skill with ferry skills add dlhck/ferry --skill ferry.

--brief checks only the link, the free disk, memory, and load, the logins, the
MCP logins, the carried stdio MCP servers, and the tools of each box, and the
hooks of this machine that run a home file Ferry does not carry. It prints one
line for each item that needs action, with the Ferry command that fixes it.
ferry watch writes the same report to ~/.ferry/status.json.

The probe reads the free disk of the box home file system, the available
memory, and the load average in its SSH command. --brief shows an item when
the free disk is below both 10% and 5 GiB, or the available memory is below
10%. Set other limits in [status] of ~/.ferry/config.toml with
disk_free_percent, disk_free_gib, and memory_available_percent. A limit of 0
turns its part of the check off. When one disk limit is 0, the other decides.
The load is only in the JSON report.`)
    .option("--brief", "check only the link, the disk and memory, the logins, the MCP logins, and the tools, and print what needs action")
    .action(async (options: { brief?: boolean }) => {
      await withProgress(async (progress, writeLine) => {
        if (options.brief === true) {
          const result = await (dependencies.runBriefStatus ?? runBriefStatusCommand)(
            { selection: boxNames() },
            { createLink, progress },
          );
          report(result, (result) => writeLine(formatBriefStatus(result)));
          return;
        }
        const result = await (dependencies.runStatus ?? runStatusCommand)(
          { selection: boxNames() },
          { createLink, progress },
        );
        report(result, (result) => writeLine(formatStatus(result)));
      });
    });

  program
    .command("doctor")
    .summary("Check SSH, Tailscale, snapshot access, linger, and services, and print a fix for each failure")
    .description(`Check SSH, Tailscale, snapshot access, linger, and services, and print a fix for each failure.

Ferry runs each check, also after a check fails, and changes nothing. It
checks that the SSH agent has a key, that this machine can read the snapshot
and push to it (git push --dry-run), and that the installed watch and tunnel
services run this Ferry. For each box, it checks that the box responds over
SSH with host key checks on, that Tailscale reaches a Tailscale box, that the
box can read the snapshot with the forwarded agent or the deploy key of
git_auth = "box", and that linger is on when a Ferry service runs on the box.

The exit code is 1 when a check fails. With --json, result has one entry for
each check, also on failure.`)
    .action(async () => {
      const result = await withProgress((progress) =>
        (dependencies.runDoctor ?? runDoctor)({ selection: boxNames() }, { createLink, progress }),
      );
      if (result.ok) {
        report(result, (result) => writeLine(formatDoctor(result)));
        return;
      }
      if (!json()) writeLine(formatDoctor(result));
      failedResult = result;
      const count = failedChecks(result);
      throw new FerryError("failed", `${count} of ${result.checks.length} checks failed.`, {
        hint: "Run the fix of each failed check, then run ferry doctor again.",
      });
    });

  const integrations = program
    .command("integrations")
    .description("List the integrations of each box, whether each one is enabled, its parts, and the local app versions")
    .action(async () => {
      const result = await listIntegrations(config(), dependencies.integrations ?? INTEGRATIONS, boxNames());
      report(result, (result) => {
        for (const line of integrationLines(result)) writeLine(line);
      });
    });
  integrations
    .command("enable")
    .summary("Install and start an integration on the box, then turn it on in the config")
    .description(`Install and start an integration on the box, then turn it on in the config.

paseo: Ferry installs Node 22 or later and the Paseo CLI at the version of the
local Paseo app, then starts the user service ferry-paseo.service. The daemon
listens on 127.0.0.1:6767 with the relay off by default. It has no password, so use it
only on a box with one user. To connect Paseo Desktop, add the Remote SSH host
ssh://<box destination>. With Paseo on, sync carries the Paseo agent profiles,
managed Git and npm plugins, the portable fields of agents.providers,
agents.metadataGeneration.providers, daemon.appendSystemPrompt, and the
portable daemon.terminalProfiles, and move registers the project in Paseo on
the box.

For relay pairing, set paseo_relay = true in [integrations] of
~/.ferry/config.toml. A [box.<name>.integrations] table can override it.
Run ferry integrations enable paseo --box <name> again to apply a change.
A changed service config restarts the daemon and stops its agents.

To carry daemon.autoArchiveAfterMerge, set paseo_auto_archive = true in
[integrations] of ~/.ferry/config.toml. A [box.<name>.integrations] table can
override it. Sync applies it with paseo daemon reload, without a restart.

An integration without a box part runs only on this machine. For it, Ferry
changes only the config and adds its commands when it can run here.

sherlock: needs the sherlock executable on this machine. Ferry adds ferry
sherlock add, and ferry status checks each connection that it added.`)
    .argument("<name>", "integration name, such as paseo")
    .option("--dry-run", "print the box commands without connecting or writing")
    .option("--yes", "run without a confirmation prompt")
    .action(async (name: string, options: { dryRun?: boolean; yes?: boolean }) => {
      const result = await withProgress((progress, writeLine) =>
        (dependencies.runIntegration ?? runIntegrationCommand)(
          { action: "enable", name, dryRun: options.dryRun === true, yes: options.yes === true },
          {
            createLink,
            progress,
            writeLine,
            ...(dependencies.integrations ? { integrations: dependencies.integrations } : {}),
            ...(json() ? { confirm: refuse(`Enable ${name} on the box?`) } : {}),
            ...integrationBox(selectBox("integrations enable")),
          },
        ),
      );
      report(result);
    });
  integrations
    .command("disable")
    .summary("Stop and remove an integration on the box, then turn it off in the config")
    .description(`Stop and remove an integration on the box, then turn it off in the config.

Ferry never removes ~/.paseo on the box. An integration without a box part
changes only the config.`)
    .argument("<name>", "integration name, such as paseo")
    .option("--purge", "also uninstall the integration package on the box")
    .option("--yes", "run without a confirmation prompt")
    .action(async (name: string, options: { purge?: boolean; yes?: boolean }) => {
      const result = await withProgress((progress, writeLine) =>
        (dependencies.runIntegration ?? runIntegrationCommand)(
          { action: "disable", name, purge: options.purge === true, yes: options.yes === true },
          {
            createLink,
            progress,
            writeLine,
            ...(dependencies.integrations ? { integrations: dependencies.integrations } : {}),
            ...(json() ? { confirm: refuse(`Disable ${name} on the box?`) } : {}),
            ...integrationBox(selectBox("integrations disable")),
          },
        ),
      );
      report(result);
    });

  // An enabled integration with an operator part adds its commands only when it can run on this machine.
  let current: PartialOperatorConfig = {};
  try {
    current = config();
  } catch {
    // The commands that read the config report the error.
  }
  // The commands of an integration accept --box.
  const addBoxCommand = (command: Command) => {
    boxCommands.add(command);
    command.commands.forEach(addBoxCommand);
  };
  for (const integration of operatorIntegrations(current, dependencies.integrations ?? INTEGRATIONS)) {
    if (!integration.operator.available()) continue;
    const known = new Set(program.commands);
    integration.operator.registerCommands?.(program, { json, writeLine, report });
    for (const command of program.commands) if (!known.has(command)) addBoxCommand(command);
  }

  program
    .command("tools")
    .summary("List the tools, the version policy of each one and of each box, and the versions on this machine")
    .description(`List the tools, the version policy of each one and of each box, and the versions on this machine.

Ferry has recipes for gh and the agent CLIs claude, codex, pi, and cursor.
Define each other tool in ~/.ferry/config.toml. Ferry does not scan projects.

A policy is "operator" (the version on this machine), "latest", or an exact
version. The default is "latest" for an agent CLI and "operator" for a tool.
With "operator", Ferry skips a tool that this machine does not have.
[box.<name>.tools] sets the policy for one box.

"off" turns off gh or an agent CLI (claude, codex, pi, cursor). install,
update, and the daily watch update skip it, ferry auth refuses it, and
ferry status shows it as off. Ferry does not uninstall it from the box. An
off agent also turns off its harness: sync does not read it on this machine
and does not write it on the box, and removes the links that Ferry made
there before. Ferry never removes other files there. A box policy can turn
the tool on again. "off" is not valid in a [tools.<id>] table. To remove
such a tool, delete its table.

  [tools]
  gh = "latest"
  codex = "0.156.1"
  pi = "off"

  [box.b.tools]
  pi = "latest"

  [tools.pnpm]
  version = "operator"
  local = "pnpm --version"
  box = "pnpm --version"
  latest = "npm view pnpm version"
  install = 'npm install -g --prefix "$HOME/.local" pnpm@{version}'
  path = [".local/bin"]
  depends = ["node"]

  [tools.northflank]
  local = "northflank --version"
  install = "npm install -g @northflank/cli@{version}"
  auth_status = "northflank list projects"
  auth_login = "northflank login --do-not-open-browser"
  auth_hosts = ["northflank.com"]

local and install are required. local prints the version on this machine, box
prints the version on the box, and latest prints the newest version, which the
"latest" policy needs. update is the update command, and the default is
install. {version} is the only placeholder. path adds home directories to the
box PATH, and depends names the tools to install first. A comment must be on
its own line. Run ferry sync after a path change.

The auth keys let ferry auth <id> log the tool in on the box. auth_status
passes when the tool is logged in. auth_login starts a login that prints a URL
and finishes after the browser step, with no input on the box. auth_hosts names
the hosts that URL may have. Ferry passes the URL on with its fragment and
query, which can hold the login session. Give all three keys or none.`)
    .action(async () => {
      const result = await (dependencies.runTools ?? runToolsCommand)({ tools: registry().tools, readConfig: config, boxes: boxNames() });
      report(result, (result) => {
        for (const line of toolsLines(result)) writeLine(line);
      });
    });

  const watch = program
    .command("watch")
    .summary("Watch the portable set and sync accepted changes")
    .description(`Watch the portable set and sync accepted changes.

The watch syncs all boxes one second after a change stays stable. A box that
fails retries with its own backoff, up to 60 seconds. The watch reads the
config in each cycle. With [update] watch = true, it also runs ferry update
once each day. Run ferry update --help for the sudo rule on the box.

At the start, every 5 minutes, and after each sync, the watch runs
ferry status --brief for all boxes and writes the report to
~/.ferry/status.json.`)
    .action(async () => {
      // The watch syncs all boxes and reads the config in each cycle. It does not accept --box,
      // because one watch-state.json follows all boxes, and the watch service runs without flags.
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
            progress: plainReporter(),
            writeLine,
            ...events(),
            status: () => (dependencies.runBriefStatus ?? runBriefStatusCommand)({}, { createLink }),
          },
        );
      } finally {
        process.off("SIGINT", stop);
        process.off("SIGTERM", stop);
      }
    });
  watch
    .command("install")
    .summary("Install and start the watch user service")
    .description(`Install and start the watch user service.

The macOS service is ~/Library/LaunchAgents/dev.ferry.watch.plist. Its log
is ~/Library/Logs/ferry-watch.log. The Linux service is
~/.config/systemd/user/ferry-watch.service. Read its log with
journalctl --user -u ferry-watch.service -f.

The service records the path of this Ferry, the current PATH, and
SSH_AUTH_SOCK. PATH must find git, ssh, and tailscale for a Tailscale box.
Run the command again after you move Ferry or change these values. A
successful ferry self-update restarts the service when it points at the
updated Ferry.`)
    .action(async () => {
      const result = await (dependencies.installWatchService ?? installWatchService)();
      report(result, (result) => writeLine(`Installed ${result.manager} service at ${result.path}`));
    });

  const menubar = program
    .command("menubar")
    .description("Install or remove the macOS menu bar app that shows what needs action on the boxes");
  menubar
    .command("install")
    .summary("Install and start the macOS menu bar app")
    .description(`Install and start the macOS menu bar app.

The app shows the report of ~/.ferry/status.json: offline boxes, logins, MCP
logins, and tool drift. ferry watch writes the file, so run ferry watch
install too. Click an item with a Ferry command to run it in Terminal.

The app also shows the ports of each running ferry tunnel --follow, from
~/.ferry/tunnels/<box>.json. Click a port to open it in the browser.

Ferry downloads ferry-menubar-macos.zip of the release of this Ferry,
verifies it against SHA256SUMS of the release, and unpacks it to
~/Applications/Ferry Menu Bar.app. --app installs a local build of
macos/build.sh, a .app directory or its zip, without a checksum. A
development build of Ferry needs --app.

The app starts at login with ~/Library/LaunchAgents/dev.ferry.menubar.plist.
It records the path of this Ferry as FERRY_PATH, the current PATH, and
SSH_AUTH_SOCK. Run the command again after you move Ferry or update it.`)
    .option("--app <path>", "install a local build of macos/build.sh: a .app directory or its zip")
    .action(async (options: { app?: string }) => {
      const result = await (dependencies.installMenuBar ?? installMenuBar)(options.app === undefined ? {} : { app: options.app });
      report(result, (result) => writeLine(`Installed ${result.app}. It starts at login with ${result.path}.`));
    });
  menubar
    .command("uninstall")
    .summary("Stop and remove the macOS menu bar app")
    .description(`Stop and remove the macOS menu bar app.

Ferry stops the app, and removes ~/Library/LaunchAgents/dev.ferry.menubar.plist
and ~/Applications/Ferry Menu Bar.app. The log stays.`)
    .action(async () => {
      const result = await (dependencies.uninstallMenuBar ?? uninstallMenuBar)();
      report(result, (result) => writeLine(result.removed ? `Removed ${result.app}` : `No menu bar app at ${result.app}`));
    });

  program
    .command("self-update")
    .description(`Update Ferry on this machine to the latest release.

Ferry updates in the same way as it was installed: with npm, or with the
release installer in the directory of this binary. It restarts installed
watch and tunnel services that point at this Ferry. On macOS, it also updates
an installed release menu bar app. Then run ferry update to put the new
version on the boxes.

On a terminal, each command also asks to update when a newer release is
there. Ferry reads the latest release at most once a day. It does not ask
with --json, with CI set, or with FERRY_NO_UPDATE_CHECK=1.`)
    .action(async () => {
      const selfUpdateDependencies: Partial<SelfUpdateDependencies> = {
        writeLine,
        warn,
        json: json(),
        // With --json, stdout carries only JSON, so the output of the installer goes to stderr.
        ...(json() ? { run: runToStderr } : {}),
      };
      report(await (dependencies.runSelfUpdate ?? runSelfUpdate)(selfUpdateDependencies));
    });

  const box = program.command("box").description("List, add, and remove the boxes of the config");
  const boxDependencies = (
    reporter: Progress,
    writeLine: (line: string) => void,
    acceptHostKeys: boolean,
  ): BoxCommandDependencies => ({
    readConfig: config,
    writeConfig: (value) => writeConfig(value),
    createLink,
    approveHostKeys: hostKeyApproval(acceptHostKeys),
    confirm: json()
      ? (message) => refuse(message)()
      : (dependencies.confirm ?? ((message) => prompts.confirm({ message, initialValue: false }))),
    writeLine,
    warn,
    progress: reporter,
  });
  box
    .command("list")
    .description("List the boxes, their transport and destination, and the default box")
    .action(() => report(runBoxList({ readConfig: config }), (result) => {
      for (const line of boxListLines(result)) writeLine(line);
    }));
  box
    .command("add")
    .summary("Check a new box like ferry init, then add it to the config")
    .description(`Check a new box like ferry init, then add it to the config.

The first box add on a [host] config moves [host] to [box.default] and sets
default_box = "default". Ferry asks before it writes.

With --git-auth box, Ferry never forwards your SSH agent to the box. Ferry
creates ~/.ssh/ferry_snapshot on the box and tests read access to the
snapshot with it. If the test fails, Ferry prints the public key and does not
change the config. Add the key as a read-only deploy key on the snapshot
repository, then run the command again. To change an existing box, set
git_auth = "box" in its [box.<name>] table and run ferry init --box <name>.`)
    .argument("<name>", "box name: 1 to 32 characters from a-z, 0-9, and -")
    .option("--host <host>", "Tailscale host name or IP address")
    .option("--ssh-user <user>", "SSH user on the host")
    .option("--ssh-destination <destination>", "explicit OpenSSH destination")
    .addOption(
      new Option("--git-auth <mode>", "agent forwards your SSH agent to the box git; box uses a read-only deploy key on the box").choices([
        "agent",
        "box",
      ]),
    )
    .option("--yes", "change a [host] config to box tables without a confirmation prompt")
    .option("--accept-host-keys", "trust the SSH host keys of the snapshot host on the box without a confirmation prompt")
    .action(async (
      name: string,
      options: { host?: string; sshUser?: string; sshDestination?: string; gitAuth?: GitAuth; yes?: boolean; acceptHostKeys?: boolean },
    ) => {
      const result = await withProgress((reporter, writeLine) =>
        (dependencies.runBoxAdd ?? runBoxAdd)(
          {
            name,
            host: options.host,
            sshUser: options.sshUser,
            sshDestination: options.sshDestination,
            ...(options.gitAuth !== undefined ? { gitAuth: options.gitAuth } : {}),
            yes: options.yes === true,
          },
          boxDependencies(reporter, writeLine, options.acceptHostKeys === true),
        ),
      );
      report(result);
    });
  box
    .command("remove")
    .description("Remove a box from the config. Ferry does not connect to the box")
    .argument("<name>", "box name")
    .action((name: string) => report(runBoxRemove({ name }, { readConfig: config, writeConfig: (value) => writeConfig(value), writeLine, warn })));
  box
    .command("default")
    .description("Set default_box, the box of install, auth, move, tunnel, and integrations enable|disable without --box")
    .argument("<name>", "box name")
    .action((name: string) => report(runBoxDefault({ name }, { readConfig: config, writeConfig: (value) => writeConfig(value), writeLine })));

  for (const name of ["init", "install", "update", "auth", "sync", "move", "tunnel", "status", "doctor", "integrations", "tools"]) {
    const command = program.commands.find((known) => known.name() === name);
    if (command) boxCommands.add(command);
  }
  for (const command of integrations.commands) boxCommands.add(command);

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
      const argv = await runSkillsAdd(
        { args: [source, ...args], project: options.project === true },
        // With --json, stdout carries only JSON, so the output of npx goes to stderr.
        dependencies.runProcess ?? (json() ? runToStderr : undefined),
      );
      report({ argv });
    });
  const addJsonHelp = (command: Command) => {
    const result = JSON_RESULTS[commandPath(command)];
    if (result !== undefined) command.addHelpText("after", `\nWith --json: ${result}.`);
    command.commands.forEach(addJsonHelp);
  };
  program.commands.forEach(addJsonHelp);
  return { program, state };
}

export async function runCli(
  args: readonly string[],
  dependencies: CliDependencies = {},
  runtime: CliRuntime = {},
): Promise<void> {
  const { program, state } = createProgram(dependencies);
  try {
    await program.parseAsync([...args], { from: "user" });
  } catch (error) {
    // Commander ends --help and --version with an error whose exit code is 0.
    if (error instanceof CommanderError && error.exitCode === 0) return;
    if (state.json()) {
      state.printError(error, args);
    } else if (!(error instanceof InstallAuthCommandError) && !(error instanceof CommanderError)) {
      // Commander wrote its own error. InstallAuthCommandError wrote its line.
      (runtime.renderError ?? renderError)(errorMessage(error));
    }
    (runtime.setExitCode ?? setExitCode)(
      error instanceof SkillsAddError || error instanceof CommanderError ? error.exitCode : 1,
    );
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

/** The shape of `result` for `ferry sync --json`: one entry for each selected box, also when some boxes failed. */
function syncResult(result: Pick<SyncResult, "dryRun" | "published" | "boxes">) {
  return {
    dryRun: result.dryRun,
    published: result.published,
    boxes: result.boxes.map((box) => ({
      name: box.name,
      ok: box.failure === undefined,
      ...(box.failure ? { step: box.failure.step, error: errorInfo(box.failure.error) } : {}),
      plan: box.plan,
      applyPlan: box.applyPlan ?? null,
      discarded: box.discarded ?? [],
    })),
  };
}

/** The command path of `args`, for a usage error before a command runs. */
function commandOf(program: Command, args: readonly string[]): string {
  const names: string[] = [];
  let current = program;
  for (const arg of args) {
    if (arg === "--") break;
    const next = current.commands.find((command) => command.name() === arg);
    if (!next) continue;
    names.push(arg);
    current = next;
  }
  return names.join(" ");
}

/** Read one line from stdin, such as the code that the browser shows after a login. */
async function readStdinLine(): Promise<string> {
  let text = "";
  const decoder = new TextDecoder();
  for await (const chunk of Bun.stdin.stream()) {
    text += decoder.decode(chunk, { stream: true });
    const end = text.indexOf("\n");
    if (end !== -1) return text.slice(0, end);
  }
  if (text.trim() === "") {
    throw new FerryError("missing-values", "The login needs the code that the browser shows. Ferry read no line from stdin.", {
      hint: "Write the code as one line on stdin.",
    });
  }
  return text;
}

/** Run a command with the stdout of the command on stderr, and return its exit code. */
async function runToStderr(argv: readonly string[]): Promise<number> {
  return Bun.spawn([...argv], { stdin: "inherit", stdout: 2, stderr: "inherit" }).exited;
}

function commandPath(command: Command): string {
  const names: string[] = [];
  for (let current: Command | null = command; current?.parent; current = current.parent) names.unshift(current.name());
  return names.join(" ");
}

/**
 * True for a release build that finds `~/.ferry/box.json`. A development
 * build ignores the marker, so a checkout on a box runs each command, and so
 * do its tests.
 */
export function isBoxMode(version = VERSION, home = homedir()): boolean {
  return isReleaseVersion(version) && existsSync(join(home, BOX_MARKER));
}

function isInteractive(): boolean {
  return process.stdin.isTTY === true && process.stdout.isTTY === true;
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
