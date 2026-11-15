/**
 * The part of #306 that is not on `main` yet: lane D (#313), the `ferry messaging`
 * commands that the real-CLI suite starts.
 *
 * The suite checks for the file of lane D, so it skips with the name of the lane,
 * and `bun run typecheck` stays green. Remove this file when lane D is on `main`.
 */

import { existsSync } from "node:fs";
import { join } from "node:path";

const CLI_FILE = "src/messaging/commands.ts";

/** Lane D: `ferry messaging worker`, `hook`, and `mcp` exist in the CLI. */
export const cliReady = existsSync(join(import.meta.dir, "..", "..", "..", CLI_FILE));

/** The missing lanes, as "lane D (src/messaging/commands.ts)". Empty when all are present. */
export function waitingFor(): string[] {
  return cliReady ? [] : [`lane D (${CLI_FILE})`];
}
