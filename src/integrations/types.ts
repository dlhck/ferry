/**
 * The contract for a built-in integration. An integration has a box part, an
 * operator part, or both. The box part runs one service on the box. The
 * operator part adds commands and status checks on this machine.
 */

import type { Command } from "commander";
import type { IntegrationsConfig } from "../config.ts";
import type { Link } from "../link.ts";
import type { Progress } from "../progress.ts";

export type IntegrationId = "paseo" | "sherlock";

/** The box commands of an integration need only `run`. Tests inject a fake. */
export type IntegrationLink = Pick<Link, "run">;

/** The local app version that pins the box version, and the file that Ferry read it from. */
export type LocalVersion =
  | { readonly version: string; readonly source: string }
  | { readonly version: null; readonly source: null };

/** The work that `plan` describes. `purge` is disable with `--purge`. */
export type IntegrationAction = "enable" | "disable" | "purge" | "update";

/** The result of the health check. `ferry status` shows it. */
export type IntegrationHealth = {
  /** Human lines for `ferry status`. */
  readonly lines: readonly string[];
  /** One line for each problem that the operator must fix. */
  readonly warnings: readonly string[];
  /** The value for `integrations.<id>` in `ferry status --json`. */
  readonly json: Readonly<Record<string, unknown>>;
};

export interface Integration {
  readonly id: IntegrationId;
  readonly name: string;
  /** One line that says what the integration does. */
  readonly description: string;
  readonly box?: IntegrationBoxPart;
  readonly operator?: IntegrationOperatorPart;
}

export type BoxIntegration = Integration & { readonly box: IntegrationBoxPart };
export type OperatorIntegration = Integration & { readonly operator: IntegrationOperatorPart };

/** The service of an integration on the box. */
export interface IntegrationBoxPart {
  /** Find the local app version. It runs only on the operator machine. */
  localVersion(): Promise<LocalVersion>;
  /**
   * Lines with the exact box commands of `action`. Ferry prints them before it
   * asks for confirmation. Only the `update` plan uses `link`, to read the box
   * version. The other plans do not connect to the box.
   */
  plan(action: IntegrationAction, link?: IntegrationLink, config?: IntegrationsConfig): Promise<readonly string[]>;
  /** Install and start the service on the box. A repeat run gives the same result. Returns report lines. */
  enable(link: IntegrationLink, progress: Progress, config?: IntegrationsConfig): Promise<readonly string[]>;
  /** Stop and remove the service. `purge` also removes the package on the box. Returns report lines. */
  disable(
    link: IntegrationLink,
    progress: Progress,
    options: { readonly purge: boolean },
  ): Promise<readonly string[]>;
  /** Install the local app version on the box and restart the service, if the box version differs. Only `ferry update` calls it. Returns report lines. */
  update(link: IntegrationLink, progress: Progress): Promise<readonly string[]>;
  /** Read the state of the service on the box without changes. */
  health(link: IntegrationLink, config?: IntegrationsConfig): Promise<IntegrationHealth>;
  /** Tell the service about a project that `ferry move` put at `path` on the box. */
  onProjectMoved(link: IntegrationLink, path: string): Promise<void>;
  /** The steps that the operator does on this machine to connect to the box at `destination`. */
  connectSteps(destination: string): readonly string[];
}

/** The output of the Ferry CLI for the commands of an integration. */
export type IntegrationCommandContext = {
  /** True with --json. Then a command asks nothing. */
  json(): boolean;
  /** Writes a text line: to stdout, or to stderr with --json. */
  writeLine(line: string): void;
  /** Prints the result: the --json envelope, or else the text of `text`. */
  report<T>(result: T, text?: (result: T) => void): void;
};

/** The commands and checks of an integration on the operator machine. */
export interface IntegrationOperatorPart {
  /** True when the integration can run on this machine, for example when its executable is on the PATH. */
  available(): boolean;
  /** The command that installs the integration on this machine. `ferry integrations enable` stops with it when `available()` is false. */
  readonly install?: string;
  /** Add the commands of the integration to the Ferry CLI. Ferry calls it only when the integration is enabled and available. */
  registerCommands?(program: Command, context: IntegrationCommandContext): void;
  /** Check the integration on this machine for `ferry status`. Ferry calls it only when the integration is enabled and available. */
  health?(): Promise<IntegrationHealth>;
}
