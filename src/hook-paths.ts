import { readFileSync } from "node:fs";
import { join } from "node:path";
import { hookCommands, unmanagedWords } from "./manifest.ts";
import type { HarnessDescriptor } from "./registry/types.ts";

/** One hook command word that refers to a home file the box will not have. */
export type UncarriedHookPath = {
  /** The settings file that declares the hook. */
  readonly file: string;
  /** The JSON location of the command, for example `hooks.Stop[0].hooks[0].command`. */
  readonly at: string;
  /** The word of the command, for example `~/bin/notify.sh`. */
  readonly path: string;
};

/**
 * Find the hook commands in the carried settings of `harnesses` that refer to
 * a home file outside the carried roots. A command without a home path, such
 * as `paseo hooks claude stop`, gives nothing. A settings file that is missing
 * or not valid gives nothing, because sync reports it.
 */
export function uncarriedHookPaths(
  home: string,
  harnesses: readonly HarnessDescriptor[],
): UncarriedHookPath[] {
  const found: UncarriedHookPath[] = [];
  for (const harness of harnesses) {
    const settings = harness.settings;
    if (!settings?.keys.includes("hooks")) continue;
    const file = join(home, settings.file);
    let parsed: unknown;
    try {
      const text = readFileSync(file, "utf8");
      parsed = settings.format === "toml" ? Bun.TOML.parse(text) : JSON.parse(text);
    } catch {
      continue;
    }
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) continue;
    const hooks = (parsed as Record<string, unknown>).hooks;
    for (const { at, command } of hookCommands(hooks, "hooks")) {
      for (const path of unmanagedWords(command, home, harnesses)) found.push({ file, at, path });
    }
  }
  return found;
}
