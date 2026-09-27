/** The contract for a built-in integration. An integration runs one service on the box. */

import type { IntegrationsConfig } from "../config.ts";
import type { Link } from "../link.ts";
import type { Progress } from "../progress.ts";

export type IntegrationId = keyof IntegrationsConfig;

/** The box commands of an integration need only `run`. Tests inject a fake. */
export type IntegrationLink = Pick<Link, "run">;

/** The local app version that pins the box version, and the file that Ferry read it from. */
export type LocalVersion =
  | { readonly version: string; readonly source: string }
  | { readonly version: null; readonly source: null };

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
  /** One line that says what the integration runs. */
  readonly description: string;
  /** Find the local app version. It runs only on the operator machine. */
  localVersion(): Promise<LocalVersion>;
  /** Lines that describe the enable steps. Ferry prints them before it asks for confirmation. */
  plan(link: IntegrationLink): Promise<readonly string[]>;
  /** Install and start the service on the box. A repeat run gives the same result. */
  enable(link: IntegrationLink, progress: Progress): Promise<void>;
  /** Stop and remove the service. `purge` also removes the package and its data on the box. */
  disable(
    link: IntegrationLink,
    progress: Progress,
    options: { readonly purge: boolean },
  ): Promise<void>;
  /** Install the local app version on the box and restart the service. Only `ferry update` calls it. */
  update(link: IntegrationLink, progress: Progress): Promise<void>;
  /** Read the state of the service on the box without changes. */
  health(link: IntegrationLink): Promise<IntegrationHealth>;
  /** Tell the service about a project that `ferry move` put at `path` on the box. */
  onProjectMoved(link: IntegrationLink, path: string): Promise<void>;
  /** The steps that the operator does on this machine to connect to the box at `destination`. */
  connectSteps(destination: string): readonly string[];
}
