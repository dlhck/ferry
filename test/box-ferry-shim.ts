import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const CLI = join(import.meta.dir, "../src/cli.ts");

/**
 * Put a box install of this Ferry in the box home `home`: the box-mode marker
 * and `~/.local/bin/ferry`, which runs the CLI of this checkout. With `script`,
 * `~/.local/bin/ferry` is that `sh` script, for a Ferry of another version.
 */
export function installBoxFerry(
  home: string,
  // Without its transpiler cache, bun writes nothing to the box home.
  script = `BUN_RUNTIME_TRANSPILER_CACHE_PATH=0 exec '${process.execPath}' '${CLI}' "$@"`,
): void {
  mkdirSync(join(home, ".ferry"), { recursive: true });
  writeFileSync(join(home, ".ferry/box.json"), '{"mode":"box","version":"0.0.0-dev"}\n');
  mkdirSync(join(home, ".local/bin"), { recursive: true });
  writeFileSync(join(home, ".local/bin/ferry"), `#!/bin/sh\n${script}\n`);
  chmodSync(join(home, ".local/bin/ferry"), 0o755);
}
