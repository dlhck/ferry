/**
 * The tools part of `ferry status`: the operator version, the target version,
 * and the box version of each tool, and a state for each one.
 *
 * One box command reads all box versions. It runs the `boxVersion` command of
 * each tool two times: with the ferry PATH that each box command gets, and in
 * a clean login shell (`env -i ... sh -lc`) that reads `~/.profile`. When the
 * two runs do not agree, the ferry PATH block of `~/.profile` is missing or
 * old, and the state is `hidden`.
 *
 * Status does not run the `latest` command of a tool. It can be slow and needs
 * the vendor server. A tool with the `latest` policy has no target, and is
 * `ok` when the box has it.
 */

import { quoteShell } from "../box-settings.ts";
import type { ToolsConfig } from "../config.ts";
import type { HostAdapter, Link } from "../link.ts";
import { toolDefaults, type ToolDescriptor, type ToolInstallMode, type ToolPolicy } from "../registry/types.ts";
import { effectivePolicy, resolveToolVersion, type ResolvedVersion } from "./resolve.ts";
import { parseVersion, PREFIX, readLocalVersion } from "./version.ts";

/**
 * `ok`: the box has the target version, or any version for `latest`.
 * `drift`: the box has another version. `missing`: the box does not have the
 * tool. `hidden`: the login shell PATH does not find the same version.
 * `skipped`: the tool has no target. `off`: the policy is `off`, so ferry does
 * not manage the tool and does not uninstall it. `unknown`: ferry cannot read the box.
 */
export type ToolState = "ok" | "drift" | "missing" | "hidden" | "skipped" | "off" | "unknown";

export type ToolStatus = {
  readonly id: string;
  readonly mode: ToolInstallMode;
  readonly policy: ToolPolicy;
  /** The version on the operator machine. */
  readonly operator: string | null;
  /** The version the box must have. Null for `latest`, and when the tool is skipped. */
  readonly target: string | null;
  /** The version with the ferry PATH on the box. */
  readonly box: string | null;
  readonly state: ToolState;
  /** Why the state is `hidden`, `skipped`, `off`, or `unknown`. */
  readonly reason?: string;
};

/** The whole box command. Each version command has its own limit in `readBoxVersion`; this one covers all tools. */
const BOX_TIMEOUT_MS = 60_000;
/** The PATH of a new SSH login before the shell reads the profile. */
const LOGIN_PATH = "/usr/local/bin:/usr/bin:/bin";

/**
 * A box command that prints one line for each run of each tool:
 * `<id> TAB ferry|login TAB <exit code> TAB <stdout> TAB <stderr>`. It
 * changes tabs and new lines in the output to spaces.
 */
export function boxToolsCommand(tools: readonly ToolDescriptor[]): string {
  const runs = tools.flatMap((tool) => {
    if (tool.boxVersion === undefined) return [];
    const command = PREFIX + tool.boxVersion;
    const login = `env -i HOME="$HOME" USER="$USER" LOGNAME="$LOGNAME" PATH=${LOGIN_PATH} sh -lc ${quoteShell(command)}`;
    return [
      `ferry_tool ${quoteShell(tool.id)} ferry ${quoteShell(command)}`,
      `ferry_tool ${quoteShell(tool.id)} login ${quoteShell(login)}`,
    ];
  });
  return [
    // A version needs a digit. Standard error is read only when standard output has none, as in readBoxVersion.
    "ferry_tool() {",
    '  ferry_out=$( (eval "$3") 2>/dev/null < /dev/null ); ferry_rc=$?; ferry_err=',
    '  case "$ferry_out" in *[0-9]*) ;; *) ferry_err=$( (eval "$3") 2>&1 >/dev/null < /dev/null ) ;; esac',
    "  printf '%s\\t%s\\t%s\\t%s\\t%s\\n' \"$1\" \"$2\" \"$ferry_rc\" \"$(printf '%s' \"$ferry_out\" | tr '\\t\\n' '  ')\" \"$(printf '%s' \"$ferry_err\" | tr '\\t\\n' '  ')\"",
    "}",
    ...runs,
  ].join("\n");
}

/**
 * The status of each tool on one box. `box` is null when the box is offline.
 * A failed box command throws.
 */
export async function checkTools(
  tools: readonly ToolDescriptor[],
  config: ToolsConfig | undefined,
  local: HostAdapter,
  box: Pick<Link, "run"> | null,
): Promise<ToolStatus[]> {
  const [targets, versions] = await Promise.all([
    Promise.all(tools.map((tool) => target(tool, config, local))),
    box === null ? null : readBoxTools(tools, box),
  ]);
  return tools.map((tool, index) => {
    const { operator, resolved } = targets[index]!;
    const base = {
      id: tool.id,
      mode: toolDefaults(tool).mode,
      policy: resolved.policy,
      operator,
      target: resolved.kind === "version" ? resolved.version : null,
    };
    const runs = versions?.get(tool.id);
    const onBox = runs?.ferry ?? null;
    if (resolved.kind === "skip" && resolved.reason === "off") {
      const reason = onBox === null ? "Ferry does not manage it" : "Ferry does not manage it and does not uninstall it from the box";
      return { ...base, box: onBox, state: "off", reason };
    }
    if (resolved.kind !== "version") return { ...base, box: onBox, state: "skipped", reason: resolved.reason };
    if (tool.boxVersion === undefined) return { ...base, box: null, state: "unknown", reason: "no box version command" };
    if (versions === null) return { ...base, box: null, state: "unknown", reason: "host offline" };
    if (onBox === null) return { ...base, box: null, state: "missing" };
    if (base.target !== null && onBox !== base.target) return { ...base, box: onBox, state: "drift" };
    if (runs?.login !== onBox) {
      const reason = runs?.login ? `the login shell PATH finds ${runs.login}` : "the login shell PATH does not find it";
      return { ...base, box: onBox, state: "hidden", reason };
    }
    return { ...base, box: onBox, state: "ok" };
  });
}

/**
 * The operator version and the resolved target. A `latest` tool with a
 * `latest` command gets no target, so status does not run that command.
 */
async function target(
  tool: ToolDescriptor,
  config: ToolsConfig | undefined,
  local: HostAdapter,
): Promise<{ readonly operator: string | null; readonly resolved: ResolvedVersion }> {
  const policy = effectivePolicy(tool, config);
  const [operator, resolved] = await Promise.all([
    readLocalVersion(tool, local),
    policy === "latest" && tool.latestVersion !== undefined
      ? ({ kind: "version", policy, version: null } as const)
      : resolveToolVersion(tool, config, local),
  ]);
  return { operator, resolved };
}

type BoxRuns = { ferry: string | null; login: string | null };

async function readBoxTools(
  tools: readonly ToolDescriptor[],
  box: Pick<Link, "run">,
): Promise<ReadonlyMap<string, BoxRuns>> {
  const versions = new Map<string, BoxRuns>();
  if (!tools.some((tool) => tool.boxVersion !== undefined)) return versions;
  const result = await box.run(boxToolsCommand(tools), { timeoutMs: BOX_TIMEOUT_MS });
  if (!result.ok) throw new Error(result.error.message);
  for (const line of result.stdout.split("\n")) {
    const [id, run, exitCode, stdout = "", stderr = ""] = line.split("\t");
    if (id === undefined || (run !== "ferry" && run !== "login")) continue;
    const entry = versions.get(id) ?? { ferry: null, login: null };
    entry[run] = exitCode === "0" ? (parseVersion(stdout) ?? parseVersion(stderr)) : null;
    versions.set(id, entry);
  }
  return versions;
}
