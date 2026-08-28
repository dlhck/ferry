/** Install runs the registered install command of every tool on the box. */

import type { Link, LinkFailure } from "./link.ts";
import type { ToolDescriptor } from "./registry/types.ts";

export type InstallRecipe = {
  readonly tool: string;
  readonly command: string;
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

  async run(confirmed: boolean): Promise<InstallResult> {
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

    for (const recipe of this.plan()) {
      const result = await this.link.run(recipe.command);
      if (!result.ok) return result;
    }
    return { ok: true };
  }
}
