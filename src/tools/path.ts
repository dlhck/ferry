/**
 * The box PATH. A non-interactive SSH command does not read the shell profile,
 * so PATH does not contain the user install directories of the tools. Ferry
 * puts the same directories in front of each box command, in the Paseo unit,
 * and in one marked block of the box `~/.profile`.
 */

import { BUILTIN_TOOLS } from "../registry/builtin.ts";
import type { ToolDescriptor } from "../registry/types.ts";

/** The Claude, Codex, Cursor and Paseo installers use it, so it is always first. */
const FIRST_DIR = ".local/bin";
/** The characters are safe in a double-quoted shell string, in PATH, and in a systemd unit. */
const SAFE_DIR = /^[A-Za-z0-9._@+/-]+$/;

/**
 * The `pathDirs` of each tool, relative to the home, with `.local/bin` first,
 * then in registry order, without duplicates. Throws when a directory is not
 * inside the home or has a character that is not safe.
 */
export function boxPathDirs(tools: readonly ToolDescriptor[]): readonly string[] {
  const dirs = [FIRST_DIR];
  for (const tool of tools) {
    for (const dir of tool.pathDirs ?? []) {
      const plain = dir
        .split("/")
        .filter((segment) => segment !== "" && segment !== ".")
        .join("/");
      if (dir.startsWith("/") || plain === "" || plain.split("/").includes("..")) {
        throw new Error(`tool ${tool.id} path ${dir} is not a directory inside the home`);
      }
      if (!SAFE_DIR.test(plain)) {
        throw new Error(`tool ${tool.id} path ${dir} has a character that is not safe in PATH. Use letters, digits, and . _ @ + - /.`);
      }
      if (!dirs.includes(plain)) dirs.push(plain);
    }
  }
  return dirs;
}

/** The box PATH of the built-in tools. A Link uses it when it gets no directories. */
export const BUILTIN_BOX_PATH_DIRS = boxPathDirs(BUILTIN_TOOLS);

/** A shell statement that puts `dirs` in front of PATH. */
export function pathExport(dirs: readonly string[]): string {
  return `export PATH="${dirs.map((dir) => `$HOME/${dir}`).join(":")}:$PATH"`;
}

const BLOCK_START = "# >>> ferry PATH >>>";
const BLOCK_END = "# <<< ferry PATH <<<";

/**
 * A box command that writes the ferry block of `~/.profile` with `dirs`. It
 * replaces an existing block in place, or appends the block, and keeps every
 * other line and the file mode. It writes a temporary file and moves it over
 * the profile only when the text changes. It prints `changed` or `unchanged`.
 */
export function profileBlockCommand(dirs: readonly string[]): string {
  const block = [
    BLOCK_START,
    "# Managed by ferry. ferry sync rewrites this block. Do not edit it.",
    pathExport(dirs),
    BLOCK_END,
  ].join("\n");
  return [
    "set -e",
    'profile="$HOME/.profile"',
    'tmp="$HOME/.profile.ferry-tmp"',
    `FERRY_BLOCK='${block.replaceAll("'", `'"'"'`)}'`,
    "export FERRY_BLOCK",
    'rm -f "$tmp"',
    'if [ -f "$profile" ]; then cp -p "$profile" "$tmp"; else : > "$tmp"; fi',
    "{ [ -f \"$profile\" ] && cat \"$profile\"; true; } | awk '",
    `  $0 == "${BLOCK_START}" { if (!done) print ENVIRON["FERRY_BLOCK"]; done = 1; skip = 1; next }`,
    `  skip && $0 == "${BLOCK_END}" { skip = 0; next }`,
    "  !skip { print }",
    '  END { if (!done) print ENVIRON["FERRY_BLOCK"] }',
    "' > \"$tmp\"",
    'if [ -f "$profile" ] && cmp -s "$tmp" "$profile"; then rm -f "$tmp"; echo unchanged; else mv "$tmp" "$profile"; echo changed; fi',
  ].join("\n");
}
