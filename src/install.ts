/** Install runs the registered install command of every tool on the box. */

import type { Link, LinkFailure } from "./link.ts";
import type { ToolDescriptor } from "./registry/types.ts";

const INSTALL_COMMAND_TIMEOUT_MS = 30 * 60 * 1_000;

export type InstallRecipe = {
  readonly tool: string;
  readonly command: string;
};

export type InstallProgress = {
  readonly phase: "started" | "completed";
  readonly tool: string;
  readonly current: number;
  readonly total: number;
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

export class Install {
  constructor(
    private readonly link: Pick<Link, "run">,
    private readonly tools: readonly ToolDescriptor[],
  ) {}

  plan(): readonly InstallRecipe[] {
    return this.tools.flatMap((tool) =>
      tool.install ? [{ tool: tool.id, command: tool.install.command }] : [],
    );
  }

  async run(
    confirmed: boolean,
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

    const plan = this.plan();
    for (const [index, recipe] of plan.entries()) {
      const progress = { tool: recipe.tool, current: index + 1, total: plan.length };
      reportProgress?.({ phase: "started", ...progress });
      const result = await this.link.run(recipe.command, { timeoutMs: INSTALL_COMMAND_TIMEOUT_MS });
      if (!result.ok) return result;
      reportProgress?.({ phase: "completed", ...progress });
    }
    return { ok: true };
  }
}
