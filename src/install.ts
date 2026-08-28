/** Install owns the official remote installer recipes for the v1 allowlist. */

import type { Link, LinkFailure } from "./link.ts";

export type InstallTool = "gh" | "claude" | "codex" | "pi" | "cursor-agent";

export type InstallRecipe = {
  readonly tool: InstallTool;
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

const INSTALL_PLAN: readonly InstallRecipe[] = [
  {
    tool: "gh",
    command:
      "(type -p wget >/dev/null || (sudo apt update && sudo apt install wget -y)) \\\n" +
      "&& sudo mkdir -p -m 755 /etc/apt/keyrings \\\n" +
      "&& out=$(mktemp) && wget -nv -O$out https://cli.github.com/packages/githubcli-archive-keyring.gpg \\\n" +
      "&& cat $out | sudo tee /etc/apt/keyrings/githubcli-archive-keyring.gpg > /dev/null \\\n" +
      "&& sudo chmod go+r /etc/apt/keyrings/githubcli-archive-keyring.gpg \\\n" +
      "&& sudo mkdir -p -m 755 /etc/apt/sources.list.d \\\n" +
      '&& echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" | sudo tee /etc/apt/sources.list.d/github-cli.list > /dev/null \\\n' +
      "&& sudo apt update \\\n" +
      "&& sudo apt install gh -y",
  },
  { tool: "claude", command: "curl -fsSL https://claude.ai/install.sh | bash" },
  { tool: "codex", command: "curl -fsSL https://chatgpt.com/codex/install.sh | sh" },
  { tool: "pi", command: "curl -fsSL https://pi.dev/install.sh | sh" },
  { tool: "cursor-agent", command: "curl https://cursor.com/install -fsS | bash" },
];

export class Install {
  constructor(private readonly link: Pick<Link, "run">) {}

  plan(): readonly InstallRecipe[] {
    return INSTALL_PLAN;
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

    for (const recipe of INSTALL_PLAN) {
      const result = await this.link.run(recipe.command);
      if (!result.ok) return result;
    }
    return { ok: true };
  }
}
