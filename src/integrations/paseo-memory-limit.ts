/**
 * Apply `agent_memory_max` of a box to the agents that the Paseo daemon starts.
 * Paseo uses `agents.providers.<id>.command` as the start of the command line
 * of each agent of that provider, and adds its own arguments after it. Ferry
 * puts `systemd-run --user --scope -p MemoryMax=<value> --` in front of the
 * box command, so each agent runs in its own scope with that limit. Ferry
 * carries no command from the operator machine: it changes only the box value.
 */
import { jqCommandScript, jqReadScript, quoteShell } from "../box-settings.ts";
import { CONFIG_FILE, editBoxConfig, jqObjects, noJqWarning, PaseoError } from "./paseo.ts";
import { SYSTEM_PATH } from "../tools/path.ts";
import type { IntegrationLink } from "./types.ts";

const BOX_TIMEOUT_MS = 30_000;
const UNIT = "ferry-paseo.service";
/**
 * The executable of each Paseo 0.16 built-in provider when its box entry has
 * no command. Each one is the provider ID, so the removal of the prefix needs
 * no copy of this list.
 */
const DEFAULT_COMMANDS: Readonly<Record<string, string>> = {
  claude: "claude",
  codex: "codex",
  copilot: "copilot",
  opencode: "opencode",
  pi: "pi",
  omp: "omp",
};

/** The words in front of the box command. Ferry finds its own prefix by this shape. */
export function memoryPrefix(max: string): readonly string[] {
  return ["systemd-run", "--user", "--scope", "-p", `MemoryMax=${max}`, "--"];
}

/**
 * jq definitions. `ferry` is true for a command with the Ferry prefix. `base`
 * gives the command of a provider entry without the Ferry prefix, or the
 * default executable of its built-in provider, or null.
 */
const DEFS = [
  'def ferry: type == "array" and length > 6 and .[0:4] == ["systemd-run", "--user", "--scope", "-p"]',
  'and (.[4] | type == "string" and startswith("MemoryMax=")) and .[5] == "--";',
  'def base($id): if (.command | ferry) then .command[6:] elif (.command | type) == "array" then .command',
  'else ($d[$id] // $d[.extends // ""]) as $c | if $c == null then null else [$c] end end;',
].join(" ");
const VALID = jqObjects(".agents", ".agents.providers");
/**
 * A jq filter: print `<id>\t<state>` for each ID of `$ids`. The state is
 * `legacy` for an entry in the legacy provider format, `unknown` for an entry
 * without a known command, or `ok\t<executable>`. It prints `E` for a config
 * that fails `VALID`. Only the IDs that Ferry sent, these words, and the
 * executable name leave the box. No argument of a command does.
 */
const STATES = [
  DEFS,
  `if ${VALID} then (.agents.providers // {}) as $b | $ids[] as $id | ($b[$id] // {}) as $e | "\\($id)\\t" +`,
  '(if ($e | type) != "object" or ($e.command | type) == "object" then "legacy"',
  'else ($e | base($id)) as $x | if $x == null or ($x[0] | type) != "string" or ($x[0] | test("[\\\\x00-\\\\x1f]")) then "unknown"',
  'else "ok\\t\\($x[0])" end end)',
  'else "E" end',
].join(" ");
/**
 * A jq filter: put `$p` in front of the command of each provider of `$w`,
 * and add an entry for a built-in provider that the box config does not
 * have. Remove the Ferry prefix from each other provider. When the command
 * without the prefix is only the provider ID, or the ID that the entry extends,
 * it is the default executable: remove the command, and remove the entry when
 * it is then empty. With nothing to wrap and no Ferry
 * prefix on the box, the config stays as it is.
 */
const EDIT = [
  DEFS,
  "(.agents.providers // {}) as $b |",
  "if ($w | length) == 0 and ([$b[] | objects | .command | ferry] | any | not) then . else",
  ".agents.providers = ($b + ($w | with_entries(select(.key as $k | $b | has($k) | not)) | map_values({}))",
  '| with_entries(.key as $k | if (.value | type) != "object" or (.value.command | type) == "object" then .',
  "elif $w[$k] then .value.command = $p + (.value | base($k))",
  "elif (.value.command | ferry) then (.value | base($k)) as $x |",
  'if (.value.extends == null and $x == [$k]) or (.value.extends != "acp" and $x == [.value.extends])',
  "then .value |= del(.command) else .value.command = $x end",
  "else . end)",
  "| with_entries(select(.value != {} or $b[.key] == {})))",
  "end",
].join(" ");
/** A jq filter: print the ID of each provider that the Paseo registry has as available and enabled. */
const AVAILABLE = 'if type == "array" then .[] | select(.status == "available" and .enabled == "Enabled") | .provider | select(type == "string" and test("^[a-z][a-z0-9-]*$")) else error("invalid registry") end';

export type MemoryLimitResult = {
  /** The IDs of the providers whose agents get the limit. */
  readonly wrapped: readonly string[];
  readonly warnings: readonly string[];
  /** True when Ferry wrote the box config and reloaded the daemon. */
  readonly changed: boolean;
};

/**
 * Make the box Paseo config match `max`. With a limit, Ferry wraps each
 * provider that the Paseo registry has as available and enabled, when Ferry
 * knows its command and the command is on the PATH of ferry-paseo.service.
 * A provider that Ferry cannot wrap gets a warning and starts without the
 * limit. With no limit, Ferry removes its prefix, and a box without a Ferry
 * prefix stays as it is. The box edits the file with jq, and Ferry reloads
 * the daemon only after a write. The errors never hold box output.
 */
export async function applyAgentMemoryLimit(
  link: IntegrationLink,
  max: string | null,
  pathDirs: readonly string[],
): Promise<MemoryLimitResult> {
  const run = async (command: string, what: string): Promise<string> => {
    const result = await link.run(command, { timeoutMs: BOX_TIMEOUT_MS });
    if (!result.ok) throw new PaseoError(what);
    return result.stdout;
  };
  const d = quoteShell(JSON.stringify(DEFAULT_COMMANDS));
  // Without a provider to wrap, the edit needs no default executables. So the command names no agent CLI.
  const edit = async (wrap: readonly string[], prefix: readonly string[]) =>
    editBoxConfig(run, {
      args: `--argjson d ${wrap.length === 0 ? "'{}'" : d} --argjson p ${quoteShell(JSON.stringify(prefix))} --argjson w ${quoteShell(JSON.stringify(Object.fromEntries(wrap.map((id) => [id, true]))))}`,
      valid: VALID,
      filter: EDIT,
      what: "the agent memory limit",
    });

  if (max === null) {
    // No limit is the default, so a box that Ferry cannot read gets no warning.
    const status = await edit([], []);
    return { wrapped: [], warnings: [], changed: status === "written" };
  }

  const invalid = new PaseoError(`~/${CONFIG_FILE} on the box is not a JSON object with agents and agents.providers objects`);
  const registry = (await run(
    `sh -c ${quoteShell(jqCommandScript("paseo provider ls --json", "", AVAILABLE))}`,
    "Ferry could not read the available Paseo providers on the box",
  )).split("\n").filter((line) => line !== "");
  if (registry.includes("J")) return { wrapped: [], warnings: [noJqWarning("the agent memory limit")], changed: false };
  if (registry.includes("E")) throw new PaseoError("Ferry could not read the available Paseo providers on the box");

  const warnings: string[] = [];
  const executables = new Map<string, string>();
  if (registry.length > 0) {
    const lines = (await run(
      `sh -c ${quoteShell(jqReadScript(CONFIG_FILE, `--argjson d ${d} --argjson ids ${quoteShell(JSON.stringify(registry))}`, STATES))}`,
      `Ferry could not read the Paseo providers in ~/${CONFIG_FILE} on the box`,
    )).split("\n").filter((line) => line !== "");
    if (lines.includes("J")) return { wrapped: [], warnings: [noJqWarning("the agent memory limit")], changed: false };
    if (lines.includes("E")) throw invalid;
    for (const line of lines) {
      const [id = "", state, executable = ""] = line.split("\t");
      if (!registry.includes(id)) continue;
      if (state === "ok") executables.set(id, executable);
      else if (state === "legacy") {
        warnings.push(`Paseo provider ${id} has no memory limit: its box entry uses the legacy provider format. Open and save it in Paseo on the box to migrate it.`);
      } else {
        warnings.push(`Paseo provider ${id} has no memory limit: Ferry does not know its command. Set command for it in ~/${CONFIG_FILE} on the box.`);
      }
    }
  }

  // The daemon starts the command with the unit PATH, not with the PATH of the SSH login shell.
  const names = [...new Set(["systemd-run", ...executables.values()])];
  const unitPath = [...pathDirs.map((dir) => `"$HOME"/${quoteShell(dir)}`), SYSTEM_PATH].join(":");
  const found = await run(
    [
      `PATH=${unitPath}`,
      ...names.map((name) => `case "$(command -v -- ${quoteShell(name)} 2>/dev/null)" in /*) echo ok ${quoteShell(name)};; esac`),
      "true",
    ].join("\n"),
    "Ferry could not check the Paseo provider commands on the box",
  );
  const onPath = new Set(found.split("\n").filter((line) => line.startsWith("ok ")).map((line) => line.slice(3)));
  const wrap: string[] = [];
  if (!onPath.has("systemd-run")) {
    warnings.push(`The agents on the box have no memory limit: systemd-run is not on the PATH of ${UNIT}.`);
  } else {
    for (const [id, executable] of executables) {
      if (onPath.has(executable)) wrap.push(id);
      else {
        warnings.push(`Paseo provider ${id} has no memory limit: its command ${executable} is not on the PATH of ${UNIT}. Ferry did not wrap it, so its agents still start.`);
      }
    }
  }
  const status = await edit(wrap, memoryPrefix(max));
  if (status === "no-jq") return { wrapped: [], warnings: [...warnings, noJqWarning("the agent memory limit")], changed: false };
  if (status === "invalid") throw invalid;
  return { wrapped: wrap, warnings, changed: status === "written" };
}
