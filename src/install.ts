/**
 * Install puts each registry tool on the box, in `depends` order, at the
 * version that its policy selects. It skips a tool that the box already has at
 * that version, and a mirror tool that the operator machine does not have.
 */

import type { ToolsConfig } from "./config.ts";
import { BunHostAdapter, type HostAdapter, type Link, type LinkFailure } from "./link.ts";
import type { ToolDescriptor } from "./registry/types.ts";
import { planTools, type ToolStep } from "./tools/resolve.ts";

const INSTALL_COMMAND_TIMEOUT_MS = 30 * 60 * 1_000;

export type InstallProgress = {
  readonly phase: "started" | "completed";
  readonly tool: string;
  readonly current: number;
  readonly total: number;
  /** The standard output of the install command, when the phase is `completed`. */
  readonly stdout?: string;
};

export type InstallResult =
  | { readonly ok: true }
  | LinkFailure
  | {
      readonly ok: false;
      readonly error: {
        readonly code: "confirmation-required";
        readonly origin: "operator";
        readonly message: string;
      };
    };

/** The lines of a command output that hold text. */
export function outputLines(stdout: string | undefined): string[] {
  return (stdout ?? "").split(/\r?\n/).filter((line) => line.trim() !== "");
}

export class Install {
  constructor(
    private readonly link: Pick<Link, "run">,
    private readonly tools: readonly ToolDescriptor[],
    private readonly config: ToolsConfig | undefined = undefined,
    private readonly local: HostAdapter = new BunHostAdapter(),
  ) {}

  /** Read the versions on the operator machine and on the box. Throws ToolPlanError when the plan cannot run. */
  plan(): Promise<readonly ToolStep[]> {
    return planTools("install", this.tools, this.config, this.local, this.link);
  }

  /** Run the install steps of the plan. The first failure stops the install, so no dependent tool runs. */
  async run(
    confirmed: boolean,
    plan: readonly ToolStep[],
    reportProgress?: (progress: InstallProgress) => void,
  ): Promise<InstallResult> {
    if (confirmed !== true) {
      return {
        ok: false,
        error: {
          code: "confirmation-required",
          origin: "operator",
          message: "installation requires explicit confirmation",
        },
      };
    }

    const steps = plan.flatMap(({ tool, command }) => (command === undefined ? [] : [{ tool, command }]));
    for (const [index, step] of steps.entries()) {
      const progress = { tool: step.tool, current: index + 1, total: steps.length };
      reportProgress?.({ phase: "started", ...progress });
      const result = await this.link.run(step.command, { timeoutMs: INSTALL_COMMAND_TIMEOUT_MS });
      if (!result.ok) return result;
      reportProgress?.({ phase: "completed", ...progress, stdout: result.stdout });
    }
    return { ok: true };
  }
}
