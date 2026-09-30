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
 * reads a line of a multi-line value as a key or a table. It prints the new
 * file. It exits 3 when the file already holds the carried values, and 4 when
 * it cannot follow the file.
 */
const MERGE_TOML = String.raw`
function scan(s,   i, n, c, q) {
  cpos = 0; n = length(s); i = 1
  while (i <= n) {
    if (mls != "") {
      if (mls == "\"\"\"" && substr(s, i, 1) == "\\") { i += 2; continue }
      if (substr(s, i, 3) == mls) { mls = ""; i += 3 } else i++
      continue
    }
    c = substr(s, i, 1); q = substr(s, i, 3)
    if (c == "#") { cpos = i; return }
    if (q == "\"\"\"" || q == "'''") { mls = q; i += 3; continue }
    if (c == "\"") { for (i++; i <= n && substr(s, i, 1) != "\""; i++) if (substr(s, i, 1) == "\\") i++; i++; continue }
    if (c == "'") { for (i++; i <= n && substr(s, i, 1) != "'"; i++); i++; continue }
    if (c == "[" || c == "{") depth++
    else if (c == "]" || c == "}") depth--
    i++
  }
}
function trim(s) { sub(/^[ \t]+/, "", s); sub(/[ \t\r]+$/, "", s); return s }
function head(s,   c, j) {
  s = trim(s); c = substr(s, 1, 1)
  if (c == "\"" || c == "'") { j = index(substr(s, 2), c); return j ? substr(s, 2, j - 1) : "" }
  if (!match(s, /^[A-Za-z0-9_-]+/)) return ""
  return substr(s, 1, RLENGTH)
}
function classify(s,   t, eq) {
  if (depth != 0 || mls != "") { scan(s); kind = "cont"; norm = "~"; return }
  t = trim(s)
  if (t == "" || substr(t, 1, 1) == "#") { kind = "blank"; return }
  if (substr(t, 1, 1) == "[") {
    scan(s)
    t = cpos ? substr(s, 1, cpos - 1) : s
    gsub(/[ \t\r]/, "", t)
    kind = "header"; norm = t
    t = substr(t, 2); if (substr(t, 1, 1) == "[") t = substr(t, 2)
    name = head(t)
    return
  }
  eq = index(s, "=")
  if (!eq) { kind = "bad"; return }
  kind = "key"; name = head(substr(s, 1, eq - 1)); simple = trim(substr(s, 1, eq - 1)) == name
  scan(substr(s, eq + 1))
  t = cpos ? substr(s, eq + 1, cpos - 1) : substr(s, eq + 1)
  norm = trim(substr(s, 1, eq - 1)) " = " trim(t)
  if (depth != 0 || mls != "") norm = norm "~"
}
function out(s) { print s; printed = 1; prev = s }
function emit(k,   m, j, part) {
  done[k] = 1; m = split(text[k], part, "\n")
  for (j = 1; j <= m; j++) if (j < m || part[j] != "") out(part[j])
}
function scalars(gap,   k, any) {
  for (k = 1; k <= n; k++) if (!same[k] && !done[k] && !table[k] && text[k] != "") { emit(k); any = 1 }
  if (any && gap) out("")
}
BEGIN {
  n = split(ENVIRON["FERRY_KEYS"], keys, " ")
  for (k = 1; k <= n; k++) {
    slot[keys[k]] = k
    text[k] = ENVIRON["FERRY_V" k]
    table[k] = substr(text[k], 1, 1) == "["
    m = split(text[k], part, "\n")
    for (j = 1; j <= m; j++) { classify(part[j]); if (kind == "header" || kind == "key") want[k] = want[k] norm "\n" }
  }
  depth = 0; mls = ""; root = 1
}
{
  line[NR] = $0
  classify($0)
  type[NR] = kind
  if (kind == "bad") bad = 1
  if (kind == "header" && root) top = NR
  if (kind == "header") { root = 0; section = (name in slot) ? slot[name] : 0; own[NR] = section }
  else if (kind == "key") { own[NR] = root ? ((name in slot) ? slot[name] : 0) : section; last = own[NR]; first[NR] = root && simple }
  else if (kind == "cont") own[NR] = last
  if (own[NR] && kind != "blank") have[own[NR]] = have[own[NR]] norm "\n"
}
END {
  if (bad || depth != 0 || mls != "") exit 4
  for (k = 1; k <= n; k++) { same[k] = have[k] == want[k]; if (!same[k]) changed = 1 }
  if (!changed) exit 3
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
  for (k = 1; k <= n; k++) if (!same[k] && !done[k] && table[k]) { if (printed && prev != "") out(""); emit(k) }
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
      throw new BoxSettingsError(`${path}: the box settings file is not a ${descriptor.format.toUpperCase()} object`);
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
 * The box script for a TOML settings file. awk merges the carried keys into a
 * temporary file, and the script moves it into place only when a carried key
 * changed. awk is on every POSIX box. The status letters are those of
 * `jsonScript`; `E` also stands for a file that awk cannot follow.
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
    `${env} awk ${quoteShell(MERGE_TOML)} "$src" > "$f.ferry-tmp" 2>/dev/null`,
    "case $? in",
    `  0) mv "$f.ferry-tmp" "$f" && printf 'W\\n' || printf 'S\\n' ;;`,
    `  3) rm -f "$f.ferry-tmp" ;;`,
    `  4) rm -f "$f.ferry-tmp"; printf 'E\\n' ;;`,
    `  *) rm -f "$f.ferry-tmp"; printf 'S\\n' ;;`,
    "esac",
  ].join("\n");
}

/**
 * Add each carried marketplace and install each enabled plugin with the box
 * `claude` CLI. Claude does not install a plugin from settings alone. Each
 * marketplace and plugin is one box command, so progress can count them.
 * Return one warning for each marketplace or plugin the box could not take.
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
  const steps: string[] = [];

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
    steps.push(step("M", name, `claude plugin marketplace add ${quoteShell(location)}`));
  }
  for (const [id, enabled] of Object.entries(record(carried.enabledPlugins))) {
    if (enabled === true) steps.push(step("P", id, `claude plugin install ${quoteShell(id)}`));
  }

  for (const [index, command] of steps.entries()) {
    input.progress?.count(index + 1, steps.length);
    const script = ["command -v claude >/dev/null 2>&1 || { printf 'C\\n'; exit 0; }", command].join("\n");
    const result = await checked(input.link, `sh -c ${quoteShell(script)}`, {
      ...(input.gitAuth === "box" ? {} : { agentForwarding: "git" as const }),
      timeoutMs: PLUGIN_TIMEOUT_MS,
    });

    for (const line of result.stdout.split("\n")) {
      const [kind, name, ...message] = line.split("\t");
      const detail = message.join("\t").trim();
      if (kind === "C") {
        warnings.push("the claude CLI is not on the box PATH; no plugin was installed");
        return warnings;
      }
      if (kind === "M") warnings.push(`could not add marketplace ${name}: ${detail}`);
      if (kind === "P") warnings.push(`could not install plugin ${name}: ${detail}`);
    }
  }
  return warnings;
}

/** One `claude` call. On failure it prints the kind, the name, and the last output line. */
function step(kind: "M" | "P", name: string, command: string): string {
  return [
    `if ! out=$(${command} 2>&1); then`,
    `printf '${kind}\\t%s\\t%s\\n' ${quoteShell(name)} "$(printf '%s\\n' "$out" | tail -n 1)";`,
    "fi",
  ].join(" ");
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
