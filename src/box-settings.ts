/**
 * Put the carried settings keys into box settings files and install the
 * Claude plugins they declare.
 *
 * The box keeps every settings key that ferry does not carry. A carried key
 * that the operator no longer has is removed, because the box never wins.
 */

import { posix } from "node:path";
import { parse as parseToml, stringify as stringifyToml } from "smol-toml";
import type { GitAuth } from "./config.ts";
import type { LinkResult, RunOptions } from "./link.ts";
import type { SeedSettings } from "./manifest.ts";
import type { Progress } from "./progress.ts";
import { linkFailure } from "./errors.ts";
import type { HarnessDescriptor } from "./registry/types.ts";

/** The harness whose carried keys declare plugins for the `claude` CLI. */
const CLAUDE_HARNESS = "claude";
/** Marketplace installs clone git repositories, so they get more time than one command. */
const PLUGIN_TIMEOUT_MS = 600_000;
/** The end of each warning for a `claude` command that failed on the box. */
const RUN_ON_BOX = "Run it on the box to see the error.";

export type BoxSettingsLink = {
  run(command: string, options?: RunOptions): Promise<LinkResult>;
};

export class BoxSettingsError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "BoxSettingsError";
  }
}

/**
 * Replace `keys` in the box settings text with the carried values. Keep all
 * other keys. Return `box` unchanged when it already holds the carried values,
 * so a TOML file keeps its comments until a carried key changes.
 */
export function mergeSettings(
  box: string | null,
  carried: Readonly<Record<string, unknown>>,
  keys: readonly string[],
  format: "json" | "toml",
): string {
  let settings: unknown = {};
  if (box !== null && box.trim() !== "") {
    try {
      settings = format === "toml" ? parseToml(box) : JSON.parse(box);
    } catch {
      settings = null;
    }
  }
  if (typeof settings !== "object" || settings === null || Array.isArray(settings)) {
    throw new BoxSettingsError(`the box settings file is not a ${format.toUpperCase()} object`);
  }
  const merged = settings as Record<string, unknown>;
  if (box !== null && keys.every((key) => Bun.deepEquals(merged[key], carried[key]))) return box;
  for (const key of keys) {
    if (Object.hasOwn(carried, key)) merged[key] = carried[key];
    else delete merged[key];
  }
  if (format === "toml") return `${stringifyToml(merged).trimEnd()}\n`;
  return `${JSON.stringify(merged, null, 2)}\n`;
}

/** A shell test that fails when jq is not on the box. */
const HAS_JQ = "command -v jq >/dev/null 2>&1";
/** A jq filter: set each key of `$k` to its value in `$c`, or delete the key when `$c` has none. */
const MERGE_JSON = "reduce $k[] as $n (.; if $c | has($n) then .[$n] = $c[$n] else del(.[$n]) end)";

/**
 * An awk program that merges carried top-level keys into a TOML file on the
 * box. `FERRY_KEYS` names the keys, and `FERRY_V<n>` holds the TOML text of
 * key n, empty when the operator has none. The program replaces the root line
 * of each key and each table whose name starts with the key. It keeps all
 * other lines, comments included. It follows brackets and strings, so it never
 * reads a line of a multi-line value as a key or a table.
 *
 * It reads each key and table name as TOML does: it keeps the spaces in a
 * quoted name, decodes the escapes of a basic string, and reads a literal
 * string as it is. So `"model"` is the key `model`, and `["model "]` is
 * not.
 *
 * It prints the new file only after it reads its own result again and finds
 * the carried values and each line that it must keep. It exits 3 when the
 * file already holds the carried values. It exits 4 when it cannot read a line
 * as TOML, and then prints only the number of that line. It exits 5 when its
 * result fails the check.
 */
const MERGE_TOML = String.raw`
function hex(s, want,   i, d, v) {
  if (length(s) != want) return -1
  for (i = 1; i <= want; i++) {
    d = index("0123456789abcdef", tolower(substr(s, i, 1)))
    if (!d) return -1
    v = v * 16 + d - 1
  }
  return v + 0
}
# Decode the basic string at the start of s and set rest to the text after it.
# A carried key is printable ASCII, so each other decoded character becomes
# \001, which no carried key holds.
function basic(s,   i, c, h, v, r) {
  r = ""
  for (i = 2; i <= length(s); i++) {
    c = substr(s, i, 1)
    if (c == "\"") { rest = substr(s, i + 1); return r }
    if (c != "\\") { r = r c; continue }
    c = substr(s, ++i, 1)
    if (c == "\"" || c == "\\") { r = r c; continue }
    h = c == "x" ? 2 : (c == "u" ? 4 : (c == "U" ? 8 : 0))
    if (!h && (c == "" || !index("btnfre", c))) break
    v = h ? hex(substr(s, i + 1, h), h) : 0
    if (v < 0) break
    i += h
    r = r (v > 31 && v < 127 ? sprintf("%c", v) : "\001")
  }
  fail = 1
}
# Read the dotted key at the start of s. Set name to its decoded first part,
# parts to the number of parts, canon to its text without the spaces around
# the parts, and rest to the text after it. Return 0 for a key that is not TOML.
function path(s,   c, j, part) {
  parts = 0; canon = ""
  while (1) {
    sub(/^[ \t]+/, "", s); c = substr(s, 1, 1)
    if (c == "\"") { part = basic(s); if (fail) return 0; j = length(s) - length(rest) }
    else if (c == "'") { j = index(substr(s, 2), c); if (!j) return 0; part = substr(s, 2, j - 1); j++ }
    else { if (!match(s, /^[A-Za-z0-9_-]+/)) return 0; j = RLENGTH; part = substr(s, 1, j) }
    if (++parts == 1) name = part
    canon = canon substr(s, 1, j); s = substr(s, j + 1)
    sub(/^[ \t]+/, "", s)
    if (substr(s, 1, 1) != ".") { rest = s; return 1 }
    canon = canon "."; s = substr(s, 2)
  }
}
function scan(s,   i, n, c, q) {
  cpos = 0; n = length(s); i = 1
  while (i <= n) {
    c = substr(s, i, 1); q = substr(s, i, 3)
    if (mls != "") {
      if (mls == "\"\"\"" && c == "\\") { i += 2; continue }
      if (q != mls) { i++; continue }
      # One or two quotes before the closing quotes are part of the string.
      i += 3; if (substr(s, i, 1) == c) i++; if (substr(s, i, 1) == c) i++
      mls = ""
      continue
    }
    if (c == "#") { cpos = i; return }
    if (q == "\"\"\"" || q == "'''") { mls = q; i += 3; continue }
    if (c == "\"") { for (i++; i <= n && substr(s, i, 1) != "\""; i++) if (substr(s, i, 1) == "\\") i++; if (i > n) fail = 1; i++; continue }
    if (c == "'") { for (i++; i <= n && substr(s, i, 1) != "'"; i++); if (i > n) fail = 1; i++; continue }
    if (c == "[" || c == "{") depth++
    else if ((c == "]" || c == "}") && --depth < 0) fail = 1
    i++
  }
}
function trim(s) { sub(/^[ \t]+/, "", s); sub(/[ \t\r]+$/, "", s); return s }
function classify(s,   t, fin) {
  fail = 0
  if (depth != 0 || mls != "") { scan(s); kind = fail ? "bad" : "cont"; norm = s; sub(/\r$/, "", norm); return }
  t = trim(s)
  if (t == "" || substr(t, 1, 1) == "#") { kind = "blank"; return }
  kind = "bad"
  if (substr(t, 1, 1) == "[") {
    fin = substr(t, 2, 1) == "[" ? "]]" : "]"
    if (!path(substr(t, length(fin) + 1)) || substr(rest, 1, length(fin)) != fin) return
    t = trim(substr(rest, length(fin) + 1))
    if (t != "" && substr(t, 1, 1) != "#") return
    kind = "header"; norm = canon fin
    return
  }
  if (!path(t) || substr(rest, 1, 1) != "=") return
  t = substr(rest, 2); scan(t)
  if (fail) return
  kind = "key"; norm = canon " = " trim(cpos ? substr(t, 1, cpos - 1) : t)
}
# Read the lines a[1..count]. Set type, own, and first for each line, top to
# the first table header, and have[k] to the text that defines key k. Return
# the number of the first line that is not TOML, or 0.
function load(a, count,   i, k, root, section, last, at) {
  depth = 0; mls = ""; root = 1; section = 0; top = 0
  for (k = 1; k <= n; k++) have[k] = ""
  for (i = 1; i <= count; i++) {
    classify(a[i])
    if (kind == "bad") return i
    type[i] = kind; own[i] = 0; first[i] = 0
    if (kind == "header") { if (root) top = i; root = 0; section = (name in slot) ? slot[name] : 0; own[i] = section }
    else if (kind == "key") { at = i; own[i] = root ? ((name in slot) ? slot[name] : 0) : section; last = own[i]; first[i] = root && parts == 1 }
    else if (kind == "cont") own[i] = last
    if (own[i] && kind != "blank") have[own[i]] = have[own[i]] norm "\n"
  }
  return (depth != 0 || mls != "") ? at : 0
}
# The lines that an edit must keep: all but the empty lines and the lines of a changed key.
function kept(a, count,   i, s) {
  s = ""
  for (i = 1; i <= count; i++) if (!(own[i] && !same[own[i]]) && !(type[i] == "blank" && trim(a[i]) == "")) s = s a[i] "\n"
  return s
}
function out(s) { res[++rn] = s }
function emit(k,   m, j, part) {
  done[k] = 1; m = split(text[k], part, "\n")
  for (j = 1; j <= m; j++) if (j < m || part[j] != "") out(part[j] eol)
}
function scalars(gap,   k, any) {
  for (k = 1; k <= n; k++) if (!same[k] && !done[k] && !table[k] && text[k] != "") { emit(k); any = 1 }
  if (any && gap) out(eol)
}
BEGIN {
  n = split(ENVIRON["FERRY_KEYS"], keys, " ")
  for (k = 1; k <= n; k++) {
    slot[keys[k]] = k
    text[k] = ENVIRON["FERRY_V" k]
    table[k] = substr(text[k], 1, 1) == "["
  }
  for (k = 1; k <= n; k++) { m = split(text[k], part, "\n"); load(part, m); want[k] = have[k] }
}
NR == 1 && sub(/^\357\273\277/, "") { bom = "\357\273\277" }
NR == 1 && /\r$/ { eol = "\r" }
{ line[NR] = $0 }
END {
  bad = load(line, NR)
  if (bad) { print bad; exit 4 }
  for (k = 1; k <= n; k++) { same[k] = have[k] == want[k]; if (!same[k]) changed = 1 }
  if (!changed) exit 3
  keep = kept(line, NR)
  # New root keys go before the comments and blank lines above the first table.
  lead = top ? top : NR + 1
  while (lead > 1 && type[lead - 1] == "blank") lead--
  for (i = 1; i <= NR; i++) {
    k = own[i]
    if (i == lead) scalars(trim(line[i]) != "")
    if (!k || same[k]) { out(line[i]); continue }
    if (done[k] || text[k] == "") continue
    if (type[i] == "header" && table[k] || type[i] == "key" && first[i] && !table[k]) emit(k)
  }
  if (lead > NR) scalars(0)
  for (k = 1; k <= n; k++) if (!same[k] && !done[k] && table[k]) { if (rn && trim(res[rn]) != "") out(eol); emit(k) }
  # Read the result again. It must hold the carried values and each line to keep.
  if (load(res, rn) || kept(res, rn) != keep) exit 5
  for (k = 1; k <= n; k++) if (have[k] != want[k]) exit 5
  res[1] = bom res[1]
  for (i = 1; i <= rn; i++) print res[i]
}
`;

/**
 * Merge each carried settings entry into the box. The box merges the file
 * itself, with jq for JSON and with awk for TOML, and prints back only a
 * status letter. A secret in a box settings file never reaches Ferry.
 * Return the files the box wrote, and a warning for each file it did not
 * merge.
 */
export async function mergeBoxSettings(input: {
  readonly remoteHome: string;
  readonly harnesses: readonly HarnessDescriptor[];
  readonly settings: readonly SeedSettings[];
  readonly link: BoxSettingsLink;
}): Promise<{ readonly written: readonly string[]; readonly warnings: readonly string[] }> {
  const written: string[] = [];
  const warnings: string[] = [];
  for (const entry of input.settings) {
    const descriptor = input.harnesses.find((harness) => harness.id === entry.harness)?.settings;
    if (!descriptor) continue;
    const path = posix.join(input.remoteHome, descriptor.file);
    const carried = parse(entry);
    const values = Object.fromEntries(
      descriptor.keys.filter((key) => Object.hasOwn(carried, key)).map((key) => [key, carried[key]]),
    );
    let script: string;
    try {
      script =
        descriptor.format === "toml" ? tomlScript(path, descriptor.keys, values) : jsonScript(path, descriptor.keys, values);
    } catch (error) {
      throw new BoxSettingsError(`${path}: ${messageOf(error)}`);
    }

    const { stdout } = await checked(input.link, `sh -c ${quoteShell(script)}`);
    if (stdout.startsWith("W")) written.push(path);
    if (stdout.startsWith("J")) {
      warnings.push(`jq is not on the box, so Ferry did not update ${descriptor.file}. Run ferry update to install jq.`);
    }
    if (stdout.startsWith("E")) {
      const line = /^E (\d+)\n/.exec(stdout)?.[1];
      throw new BoxSettingsError(
        line
          ? `${path}: Ferry cannot read line ${line} as TOML, so it left the file unchanged`
          : `${path}: the box settings file is not a ${descriptor.format.toUpperCase()} object`,
      );
    }
    if (stdout.startsWith("S")) throw new BoxSettingsError(`${path}: the box could not merge the settings file`);
  }
  return { written, warnings };
}

/**
 * The box script for a JSON settings file. It creates a missing or empty file
 * from the carried values, and else merges with jq. It prints `W` when it
 * wrote the file, `J` without jq, `E` for a file that is not a JSON object,
 * and `S` when the write failed. jq stderr goes to /dev/null, because a jq
 * error can quote a value.
 */
function jsonScript(path: string, keys: readonly string[], values: Record<string, unknown>): string {
  const args = `--argjson c ${quoteShell(JSON.stringify(values))} --argjson k ${quoteShell(JSON.stringify(keys))}`;
  const created = `${JSON.stringify(values, null, 2)}\n`;
  return [
    `f=${quoteShell(path)}`,
    "umask 077",
    `if [ ! -e "$f" ] || ! grep -q '[^[:space:]]' "$f" 2>/dev/null; then`,
    `  mkdir -p "$(dirname "$f")" && printf '%s' ${quoteShell(created)} > "$f.ferry-tmp" && mv "$f.ferry-tmp" "$f" && printf 'W\\n' || printf 'S\\n'`,
    "  exit 0",
    "fi",
    `${HAS_JQ} || { printf 'J\\n'; exit 0; }`,
    `jq -e 'type == "object"' "$f" >/dev/null 2>&1 || { printf 'E\\n'; exit 0; }`,
    `jq -e ${args} ${quoteShell(`(${MERGE_JSON}) == .`)} "$f" >/dev/null 2>&1 && exit 0`,
    `if jq ${args} ${quoteShell(MERGE_JSON)} "$f" > "$f.ferry-tmp" 2>/dev/null; then`,
    `  mv "$f.ferry-tmp" "$f" && printf 'W\\n' || printf 'S\\n'`,
    "else",
    `  rm -f "$f.ferry-tmp"; printf 'S\\n'`,
    "fi",
  ].join("\n");
}

/**
 * The box script that edits a JSON file with the jq `filter`. jq gets `{}` for
 * a missing or empty file. The script prints `W` when it wrote the file, `J`
 * without jq, `E` for a file that fails the jq test `valid`, and `S` when the
 * write failed. It prints nothing when the filter changes nothing. `args` are
 * jq options, such as `--argjson`. jq stderr goes to /dev/null, because a jq
 * error can quote a value.
 */
export function jqEditScript(path: string, args: string, valid: string, filter: string): string {
  return [
    `f=${quoteShell(path)}`,
    "umask 077",
    `${HAS_JQ} || { printf 'J\\n'; exit 0; }`,
    JQ_SOURCE,
    `src | jq -e ${args} ${quoteShell(valid)} >/dev/null 2>&1 || { printf 'E\\n'; exit 0; }`,
    `src | jq -e ${args} ${quoteShell(`(${filter}) == .`)} >/dev/null 2>&1 && exit 0`,
    `if mkdir -p "$(dirname "$f")" && src | jq ${args} ${quoteShell(filter)} > "$f.ferry-tmp" 2>/dev/null; then`,
    `  mv "$f.ferry-tmp" "$f" && printf 'W\\n' || printf 'S\\n'`,
    "else",
    `  rm -f "$f.ferry-tmp"; printf 'S\\n'`,
    "fi",
  ].join("\n");
}

/**
 * The box script that prints the output of the jq `filter` for a JSON file.
 * jq gets `{}` for a missing or empty file. The script prints `J` without jq
 * and `E` when jq fails. Ferry reads all that the filter prints, so the filter
 * must print only the fields that Ferry compares, and never a value that can
 * hold a secret.
 */
export function jqReadScript(path: string, args: string, filter: string): string {
  return [
    `f=${quoteShell(path)}`,
    `${HAS_JQ} || { printf 'J\\n'; exit 0; }`,
    JQ_SOURCE,
    `src | jq -r ${args} ${quoteShell(filter)} 2>/dev/null || printf 'E\\n'`,
  ].join("\n");
}

/**
 * The box script that prints the output of the jq `filter` for the JSON that
 * the box `command` prints. The script prints `J` without jq and `E` when jq
 * fails. It exits with 1 when the command fails. The command output and
 * stderr stay on the box. Ferry reads all that the filter prints, so the
 * filter must print only the fields that Ferry compares, and never a value
 * that can hold a secret.
 */
export function jqCommandScript(command: string, args: string, filter: string): string {
  return [
    `${HAS_JQ} || { printf 'J\\n'; exit 0; }`,
    `out=$(${command} 2>/dev/null) || exit 1`,
    `printf '%s' "$out" | jq -r ${args} ${quoteShell(filter)} 2>/dev/null || printf 'E\\n'`,
  ].join("\n");
}

/** A shell function that prints the file `$f`, or `{}` for a missing or empty file. */
const JQ_SOURCE = `src() { if grep -q '[^[:space:]]' "$f" 2>/dev/null; then cat "$f"; else printf '{}'; fi; }`;

/**
 * The box script for a TOML settings file. awk merges the carried keys into a
 * temporary file, and the script moves it into place only when a carried key
 * changed and awk accepted its own result. awk is on every POSIX box. The
 * status letters are those of `jsonScript`. For a line that awk cannot read as
 * TOML, the script prints `E` and the line number, never the line.
 */
function tomlScript(path: string, keys: readonly string[], values: Record<string, unknown>): string {
  const env = [
    `FERRY_KEYS=${quoteShell(keys.join(" "))}`,
    ...keys.map(
      (key, index) =>
        `FERRY_V${index + 1}=${quoteShell(Object.hasOwn(values, key) ? stringifyToml({ [key]: values[key] }) : "")}`,
    ),
  ].join(" ");
  return [
    `f=${quoteShell(path)}`,
    "umask 077",
    `src="$f"; [ -e "$f" ] || src=/dev/null`,
    `mkdir -p "$(dirname "$f")" || { printf 'S\\n'; exit 0; }`,
    `${env} LC_ALL=C awk ${quoteShell(MERGE_TOML)} "$src" > "$f.ferry-tmp" 2>/dev/null`,
    "case $? in",
    `  0) mv "$f.ferry-tmp" "$f" && printf 'W\\n' || printf 'S\\n' ;;`,
    `  3) rm -f "$f.ferry-tmp" ;;`,
    `  4) read -r n < "$f.ferry-tmp"; rm -f "$f.ferry-tmp"; printf 'E %s\\n' "$n" ;;`,
    `  *) rm -f "$f.ferry-tmp"; printf 'S\\n' ;;`,
    "esac",
  ].join("\n");
}

/**
 * Add each carried marketplace and install each enabled plugin with the box
 * `claude` CLI. Claude does not install a plugin from settings alone. Each
 * marketplace and plugin is one box command, so progress can count them.
 * Return one warning for each marketplace or plugin the box could not take.
 * A warning names the step, never the `claude` output: that output can hold a
 * credential, such as a token in a git URL, so it stays on the box.
 */
export async function installBoxPlugins(input: {
  readonly settings: readonly SeedSettings[];
  readonly link: BoxSettingsLink;
  readonly progress?: Pick<Progress, "count">;
  /** With `"box"`, the plugin git commands get no forwarded agent. */
  readonly gitAuth?: GitAuth;
}): Promise<readonly string[]> {
  const entry = input.settings.find((candidate) => candidate.harness === CLAUDE_HARNESS);
  if (!entry) return [];
  const carried = parse(entry);
  const warnings: string[] = [];
  const steps: { failure: string; command: string }[] = [];

  for (const [name, value] of Object.entries(record(carried.extraKnownMarketplaces))) {
    const source = record(record(value).source);
    // A directory, file, or inline source names nothing the box can fetch.
    const location =
      source.source === "github"
        ? source.repo
        : source.source === "git" || source.source === "url"
          ? source.url
          : undefined;
    if (typeof location !== "string") {
      warnings.push(
        `marketplace ${name} has a ${String(source.source)} source; add it on the box by hand`,
      );
      continue;
    }
    steps.push({
      failure: `could not add marketplace ${name}: claude plugin marketplace add failed on the box. ${RUN_ON_BOX}`,
      command: `claude plugin marketplace add ${quoteShell(location)}`,
    });
  }
  for (const [id, enabled] of Object.entries(record(carried.enabledPlugins))) {
    if (enabled === true) {
      steps.push({
        failure: `could not install plugin ${id}: claude plugin install failed on the box. ${RUN_ON_BOX}`,
        command: `claude plugin install ${quoteShell(id)}`,
      });
    }
  }

  for (const [index, step] of steps.entries()) {
    input.progress?.count(index + 1, steps.length);
    const script = [
      "command -v claude >/dev/null 2>&1 || { printf 'C\\n'; exit 0; }",
      `${step.command} >/dev/null 2>&1 || printf 'F\\n'`,
    ].join("\n");
    const result = await checked(input.link, `sh -c ${quoteShell(script)}`, {
      ...(input.gitAuth === "box" ? {} : { agentForwarding: "git" as const }),
      timeoutMs: PLUGIN_TIMEOUT_MS,
    });

    if (result.stdout.startsWith("C")) {
      warnings.push("the claude CLI is not on the box PATH; no plugin was installed");
      return warnings;
    }
    if (result.stdout.startsWith("F")) warnings.push(step.failure);
  }
  return warnings;
}

export function readCommand(path: string): string {
  const quoted = quoteShell(path);
  return `if [ -e ${quoted} ]; then printf 'F' && cat ${quoted}; else printf 'M'; fi`;
}

/** Write through a temporary file, so Claude never reads a half-written file. */
export function writeCommand(path: string, text: string): string {
  const temporary = quoteShell(`${path}.ferry-tmp`);
  return [
    "umask 077 &&",
    `mkdir -p ${quoteShell(posix.dirname(path))} &&`,
    `printf '%s' ${quoteShell(text)} > ${temporary} &&`,
    `mv ${temporary} ${quoteShell(path)}`,
  ].join(" ");
}

export async function checked(
  link: BoxSettingsLink,
  command: string,
  options?: RunOptions,
): Promise<Extract<LinkResult, { ok: true }>> {
  const result = await link.run(command, options);
  if (!result.ok) {
    throw new BoxSettingsError(`${result.error.origin}/${result.error.code}: ${result.error.message}`, {
      cause: linkFailure(result.error),
    });
  }
  return result;
}

function parse(entry: SeedSettings): Record<string, unknown> {
  return record(JSON.parse(Buffer.from(entry.bytes).toString()));
}

export function record(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

export function quoteShell(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

function messageOf(error: unknown): string {
  return error instanceof Error && error.message ? error.message : String(error);
}
