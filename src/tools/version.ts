/** Read the version of a tool on the operator machine. */

import type { HostAdapter } from "../link.ts";
import type { ToolDescriptor } from "../registry/types.ts";

const VERSION_TIMEOUT_MS = 15_000;

/**
 * Load nvm when it is there, so node, npm, and the npm global CLIs are the
 * ones of the nvm default Node. The command runs in the home directory, so
 * the package.json of the current directory cannot change the pnpm version.
 */
const PREFIX =
  'nvm_sh="${NVM_DIR:-$HOME/.nvm}/nvm.sh"; [ -s "$nvm_sh" ] && . "$nvm_sh" >/dev/null 2>&1; cd "$HOME" || exit 1; ';

/** The first version in the output: `v24.16.0` gives `24.16.0`, and `chromium 1234` gives `1234`. */
export function parseVersion(output: string): string | null {
  return /\d+(?:\.\d+)*(?:-[0-9A-Za-z.]+)?/.exec(output)?.[0] ?? null;
}

/**
 * The version of the tool on the operator machine, or null when the machine
 * does not have the tool. A failed command, a timeout, or output without a
 * version all mean that the tool is not there. Standard output comes first.
 */
export async function readLocalVersion(
  tool: Pick<ToolDescriptor, "localVersion">,
  local: HostAdapter,
): Promise<string | null> {
  if (tool.localVersion === undefined) return null;
  try {
    const result = await local.run({
      argv: ["sh", "-c", PREFIX + tool.localVersion],
      timeoutMs: VERSION_TIMEOUT_MS,
    });
    if (result.timedOut || result.exitCode !== 0) return null;
    // Some tools print the version on standard error.
    return parseVersion(result.stdout) ?? parseVersion(result.stderr);
  } catch {
    return null;
  }
}
