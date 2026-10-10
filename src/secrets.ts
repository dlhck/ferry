import { readFileSync } from "node:fs";
import * as prompts from "@clack/prompts";
import { resolveTargetBox } from "./boxes.ts";
import { quoteShell } from "./box-settings.ts";
import { readConfig, resolveLinkOptions, type PartialOperatorConfig } from "./config.ts";
import { confirmationRequired, FerryError } from "./errors.ts";
import { Link, type LinkOptions, type RunOptions } from "./link.ts";
import type { BoxLocker } from "./sync.ts";

export type SecretsInput = {
  readonly action: "set" | "remove" | "status";
  readonly names: readonly string[];
  readonly box?: string;
  readonly file?: string;
  readonly prompt?: boolean;
  readonly replace?: boolean;
  readonly yes?: boolean;
  readonly json?: boolean;
};

export type SecretsStatus = { readonly present: boolean; readonly names: readonly string[] };
export type SecretsResult = {
  readonly box: string;
  readonly secrets: SecretsStatus;
  readonly steps: readonly string[];
};
export type SecretsDependencies = {
  readonly readConfig: () => PartialOperatorConfig | null;
  readonly createLink: (options: LinkOptions) => Pick<Link, "run">;
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly confirm: (message: string) => Promise<boolean>;
  readonly prompt: (name: string) => Promise<string | null>;
  readonly writeLine: (line: string) => void;
  readonly lockBox?: BoxLocker;
};

export type SecretsShellInstallInput = {
  readonly file: string;
  readonly box?: string;
  readonly yes?: boolean;
  readonly json?: boolean;
};
export type SecretsShellInstallResult = {
  readonly box: string;
  readonly file: string;
  readonly changed: boolean;
  readonly steps: readonly string[];
};
type SecretsShellInstallDependencies = Pick<SecretsDependencies, "readConfig" | "createLink" | "confirm" | "writeLine" | "lockBox">;

export const SECRETS_LOAD_LINE = '[ -r "$HOME/.ferry/secrets/load.sh" ] && . "$HOME/.ferry/secrets/load.sh"';
export const SECRETS_UNIT_LINE = "EnvironmentFile=-%h/.ferry/secrets/current/systemd.env";
const STARTUP_FILES = [".profile", ".bashrc", ".bash_profile", ".bash_login", ".zprofile", ".zshrc"];
const NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
const validName = (name: string) => NAME.test(name) && !name.startsWith("FERRY_SECRET_");
const SCOPE = "Every process started from a shell or service that loads these variables can access them. Values are plaintext for the box user, outside the snapshot.";

/** Literal records. This file is data, and must never be sourced. */
function validateValue(value: string): void {
  const noncharacter = [...value].some((char) => {
    const point = char.codePointAt(0)!;
    return (point >= 0xfdd0 && point <= 0xfdef) || (point & 0xffff) >= 0xfffe;
  });
  if (/[\x00-\x08\x0a-\x1f\x7f-\x9f\ufeff]/.test(value) || noncharacter || Buffer.from(value).toString("utf8") !== value) {
    throw new FerryError("usage", "A selected value has an unsupported control character, line break, or invalid UTF-8.");
  }
}

const LOADER = String.raw`# Managed by ferry. Read literal data, never shell code.
case $- in
  *x*) set +x; FERRY_SECRET_TRACE=1 ;;
  *) FERRY_SECRET_TRACE=0 ;;
esac
if [ -r "$HOME/.ferry/secrets/current/agent.env" ]; then
  while IFS= read -r FERRY_SECRET_LINE; do
    case "$FERRY_SECRET_LINE" in *=*) ;; *) continue ;; esac
    FERRY_SECRET_NAME=\${FERRY_SECRET_LINE%%=*}
    case "$FERRY_SECRET_NAME" in
      ''|[0-9]*|*[!a-zA-Z0-9_]*|FERRY_SECRET_*) continue ;;
    esac
    export "$FERRY_SECRET_LINE" 2>/dev/null || printf '%s\n' 'Ferry could not export a selected variable.' >&2
  done < "$HOME/.ferry/secrets/current/agent.env"
fi
unset FERRY_SECRET_LINE FERRY_SECRET_NAME
if [ "$FERRY_SECRET_TRACE" = 1 ]; then
  unset FERRY_SECRET_TRACE
  set -x
else
  unset FERRY_SECRET_TRACE
fi
`.replaceAll("\\${", "${");

/** No value, value hash, or arbitrary box output can enter status. */
export const SECRETS_STATUS_COMMAND = String.raw`if [ -f "$HOME/.ferry/secrets/current/agent.env" ]; then
  echo present
  LC_ALL=C awk -F= 'index($0, "=") && $1 ~ /^[A-Za-z_][A-Za-z0-9_]*$/ && $1 !~ /^FERRY_SECRET_/ { print $1 }' "$HOME/.ferry/secrets/current/agent.env" 2>/dev/null
else
  echo absent
fi`;

export function parseSecretsStatus(stdout: string): SecretsStatus {
  const [presence, ...names] = stdout.trimEnd().split("\n");
  if (!["present", "absent"].includes(presence ?? "") || (presence === "absent" && names.length > 0) || names.some((name) => !validName(name))) {
    throw new FerryError("box-command-failed", "Ferry could not read secret names on the box.");
  }
  return { present: presence === "present", names: [...new Set(names)].sort() };
}

/** Merge on the box. A single rename selects both files. No old value leaves the box. */
function updateCommand(action: "set" | "remove", replace: boolean): string {
  const merge = String.raw`
function name(line) { return substr(line, 1, index(line, "=") - 1) }
FILENAME == ARGV[1] {
  key=name($0)
  if (key !~ /^[A-Za-z_][A-Za-z0-9_]*$/ || key ~ /^FERRY_SECRET_/ || index($0, "=") == 0) { bad=1; next }
  selected[key]=$0; next
}
{
  key=name($0)
  if (key !~ /^[A-Za-z_][A-Za-z0-9_]*$/ || key ~ /^FERRY_SECRET_/ || index($0, "=") == 0) { bad=1; next }
  if (key in selected) {
    if (ENVIRON["FERRY_SECRET_ACTION"] == "set" && ENVIRON["FERRY_SECRET_REPLACE"] != "1") conflict=1
  } else print
}
END {
  if (bad) exit 2
  if (conflict) exit 3
  if (ENVIRON["FERRY_SECRET_ACTION"] == "set") for (key in selected) print selected[key]
}`;
  const encode = String.raw`{
  equals=index($0, "="); printf "%s=\"", substr($0, 1, equals - 1)
  value=substr($0, equals + 1)
  for (i=1; i<=length(value); i++) {
    char=substr(value, i, 1)
    if (char == "\\" || char == "\"") printf "\\"
    printf "%s", char
  }
  print "\""
}`;
  return [
    "set -e; set +x; umask 077",
    'dir="$HOME/.ferry/secrets"',
    'test ! -L "$HOME/.ferry" && test ! -L "$dir"',
    'mkdir -p "$dir"; chmod 700 "$dir"',
    'mkdir "$dir/.lock" 2>/dev/null || { echo busy; exit 0; }',
    'stage=""; pointer=""',
    'trap \'[ -z "$stage" ] || rm -rf "$stage"; [ -z "$pointer" ] || rm -f "$pointer"; rmdir "$dir/.lock"\' EXIT',
    'stage=$(mktemp -d "$dir/.generation.XXXXXX")',
    'cat > "$stage/selected"',
    'old="$dir/current/agent.env"; [ -f "$old" ] || old=/dev/null',
    `export FERRY_SECRET_ACTION=${action} FERRY_SECRET_REPLACE=${replace ? 1 : 0}`,
    `if LC_ALL=C awk ${quoteShell(merge)} "$stage/selected" "$old" > "$stage/agent.env"; then :; else`,
    '  code=$?; if [ "$code" = 3 ]; then echo conflict; else echo invalid; fi; exit 0',
    'fi',
    `LC_ALL=C awk ${quoteShell(encode)} "$stage/agent.env" > "$stage/systemd.env"`,
    'chmod 600 "$stage/agent.env" "$stage/systemd.env"; rm -f "$stage/selected"',
    ...(action === "set" ? [
      `printf '%s' ${quoteShell(LOADER)} > "$stage/load.sh"`,
      'chmod 600 "$stage/load.sh"; mv -f "$stage/load.sh" "$dir/load.sh"',
    ] : []),
    'pointer="$dir/.current-$$"; ln -s "${stage##*/}" "$pointer"',
    'mv -Tf "$pointer" "$dir/current"',
    'committed="$stage"; stage=""; pointer=""',
    // An open file remains readable after its generation is removed.
    'for old in "$dir"/.generation.*; do [ "$old" = "$committed" ] || rm -rf "$old"; done',
    'echo updated',
  ].join("\n");
}

/** Suppress remote output and exceptions, which can include values even on failure. */
async function safeRun(link: Pick<Link, "run">, command: string, options?: RunOptions): Promise<string> {
  try {
    const result = await link.run(command, options);
    if (result.ok) return result.stdout;
  } catch { /* Report only the action. */ }
  throw new FerryError("box-command-failed", "The secrets command failed on the box. No values were reported.");
}

/** Only this explicit command edits a selected startup file. Its content stays on the box. */
export async function runSecretsShellInstall(
  input: SecretsShellInstallInput,
  overrides: Partial<SecretsShellInstallDependencies> = {},
): Promise<SecretsShellInstallResult | null> {
  const dependencies: SecretsShellInstallDependencies = {
    readConfig, createLink: (options) => new Link(options),
    confirm: async (message) => (await prompts.confirm({ message })) === true,
    writeLine: console.log, ...overrides,
  };
  if (!STARTUP_FILES.includes(input.file)) throw new FerryError("usage", `Select --file with one startup filename: ${STARTUP_FILES.join(", ")}.`);
  const config = dependencies.readConfig();
  if (!config) throw new FerryError("config-missing", "Ferry has no config. Run ferry init first.");
  const box = resolveTargetBox(config, input.box);
  const question = `${SCOPE} Prepend the loader line to ~/${input.file} on box ${box.name}, creating that file if absent?`;
  dependencies.writeLine(question);
  if ([".bash_profile", ".bash_login"].includes(input.file)) {
    dependencies.writeLine("Creating ~/.bash_profile or ~/.bash_login can stop bash from reading ~/.profile.");
  }
  if (!input.yes) {
    if (input.json) throw confirmationRequired(question);
    if (!await dependencies.confirm(question)) return null;
  }
  const link = dependencies.createLink(resolveLinkOptions(box.host));
  const lock = dependencies.lockBox?.(box);
  if (lock !== undefined && typeof lock !== "function") {
    const { boxLockError } = await import("./sync.ts");
    throw boxLockError(lock);
  }
  try {
    const state = (await safeRun(link, [
      "set -e; set +x; umask 077",
      `profile="$HOME"/${quoteShell(input.file)}`,
      'if [ -L "$profile" ]; then echo symlink; exit 0; fi',
      'if [ -e "$profile" ] && [ ! -f "$profile" ]; then echo not-file; exit 0; fi',
      `if [ -f "$profile" ] && grep -qxF ${quoteShell(SECRETS_LOAD_LINE)} "$profile"; then echo unchanged; exit 0; fi`,
      'tmp=$(mktemp "$HOME/.ferry-shell.XXXXXX")',
      'trap \'rm -f "$tmp"\' EXIT',
      'if [ -f "$profile" ]; then cp -p "$profile" "$tmp"; fi',
      `{ printf '%s\\n' ${quoteShell(SECRETS_LOAD_LINE)}; if [ -f "$profile" ]; then cat "$profile"; fi; } > "$tmp"`,
      'mv -f "$tmp" "$profile"',
      'echo changed',
    ].join("\n"))).trim();
    if (state === "symlink") throw new FerryError("refused", `Ferry refuses ~/${input.file} on box ${box.name} because it is a symbolic link. Add the loading line through your dotfile manager.`);
    if (state === "not-file") throw new FerryError("refused", `Ferry refuses ~/${input.file} on box ${box.name} because it is not a regular file.`);
    if (state !== "changed" && state !== "unchanged") throw new FerryError("box-command-failed", `Ferry could not install shell loading in ~/${input.file} on box ${box.name}. No file content was reported.`);
    return { box: box.name, file: input.file, changed: state === "changed", steps: [
      "Open a new shell session that reads this file and start the agent from that environment. Existing shells, agents, and daemons keep their old environment.",
    ] };
  } finally { if (typeof lock === "function") lock(); }
}

export async function runSecrets(input: SecretsInput, overrides: Partial<SecretsDependencies> = {}): Promise<SecretsResult | null> {
  const dependencies: SecretsDependencies = {
    readConfig, createLink: (options) => new Link(options), env: process.env,
    confirm: async (message) => (await prompts.confirm({ message })) === true,
    prompt: async (name) => {
      const value = await prompts.password({ message: `Value for ${name}` });
      return prompts.isCancel(value) ? null : value;
    },
    writeLine: console.log, ...overrides,
  };
  if (input.names.some((name) => !validName(name))) throw new FerryError("usage", "Use portable environment variable names. The FERRY_SECRET_ prefix is reserved.");
  if (input.action !== "status" && input.names.length === 0) throw new FerryError("usage", "Select at least one variable name.");
  if (input.file && input.prompt) throw new FerryError("usage", "Choose either --file or --prompt.");
  if (input.prompt && input.json) throw new FerryError("usage", "Hidden prompt input is unavailable with --json. Select environment variables or a file.");
  if (input.prompt && !overrides.prompt && !process.stdin.isTTY) throw new FerryError("usage", "Hidden prompt input requires a terminal.");
  const config = dependencies.readConfig();
  if (!config) throw new FerryError("config-missing", "Ferry has no config. Run ferry init first.");
  const box = resolveTargetBox(config, input.box);
  const names = [...new Set(input.names)];
  if (input.action !== "status") {
    const scope = `${SCOPE} ${input.action === "remove" ? "Remove" : "Transfer"} ${names.join(", ")} on box ${box.name}?`;
    dependencies.writeLine(scope);
    if (!input.yes) {
      if (input.json) throw confirmationRequired(scope);
      if (!await dependencies.confirm(scope)) return null;
    }
  }
  let records: string[] = [];
  if (input.action === "set") {
    let file: Map<string, string> | undefined;
    if (input.file) {
      try {
        file = new Map();
        const bytes = readFileSync(input.file);
        const text = bytes.toString("utf8");
        if (!Buffer.from(text).equals(bytes)) throw new Error();
        for (const line of text.split("\n")) {
          if (line === "" || line.startsWith("#")) continue;
          const equals = line.indexOf("=");
          if (equals < 1 || !validName(line.slice(0, equals)) || file.has(line.slice(0, equals))) throw new Error();
          file.set(line.slice(0, equals), line.slice(equals + 1));
        }
      } catch { throw new FerryError("usage", "Cannot read the selected file as unique literal NAME=value records."); }
    }
    for (const name of names) {
      let value: string | null | undefined;
      try { value = input.prompt ? await dependencies.prompt(name) : input.file ? file?.get(name) : dependencies.env[name]; }
      catch { throw new FerryError("failed", "Ferry could not read a selected value."); }
      if (value === null) return null;
      if (value === undefined) throw new FerryError("missing-values", `The selected source has no ${name}.`);
      validateValue(value);
      records.push(`${name}=${value}`);
    }
  } else records = names.map((name) => `${name}=`);
  const link = dependencies.createLink(resolveLinkOptions(box.host));
  const lock = input.action === "status" ? undefined : dependencies.lockBox?.(box);
  if (lock !== undefined && typeof lock !== "function") {
    const { boxLockError } = await import("./sync.ts");
    throw boxLockError(lock);
  }
  try {
    if (input.action !== "status") {
      const state = (await safeRun(link, updateCommand(input.action, input.replace === true), { input: Buffer.from(records.join("\n") + "\n") })).trim();
      if (state === "conflict") throw new FerryError("refused", "A selected variable already exists. Add --replace to authorize replacement.");
      if (state === "busy") throw new FerryError("refused", "The box secrets lock directory ~/.ferry/secrets/.lock is busy. Wait for the active command. If no secrets command is running, remove that empty directory on the box and retry. Ferry does not remove stale locks automatically.");
      if (state !== "updated") throw new FerryError("refused", "The box secrets contain invalid records. No values were changed.");
    }
    const secrets = parseSecretsStatus(await safeRun(link, SECRETS_STATUS_COMMAND));
    const steps = input.action === "status" ? [] : [
      ...(input.action === "set" ? [
        "Provisioning writes the loader but does not edit shell startup files. To configure loading explicitly, run ferry secrets shell install --file <name> for a selected startup file on this box, or add this exact line yourself:",
        SECRETS_LOAD_LINE,
        "Use ~/.profile for sh/dash login; interactive non-login sh/dash use the file selected by ENV, if set. For bash login use the first existing ~/.bash_profile, ~/.bash_login, or ~/.profile, and use ~/.bashrc for interactive non-login shells. Use ~/.zprofile for zsh login and ~/.zshrc for interactive shells, under ZDOTDIR if set. Put the line before an early return.",
      ] : []),
      "After you configure shell loading, open a new shell session and start the agent from that environment. Existing shells, agents, and daemons keep their old environment.",
      ...(input.action === "remove" ? ["Removal does not revoke a key at its issuer or clear a running process environment."] : []),
    ];
    if (input.action !== "status" && box.integrations.paseo === true) {
      // Add the line without restarting any agent. Enable and sync also keep this line.
      const { ensureSecretsUnit } = await import("./integrations/paseo.ts");
      try { await ensureSecretsUnit(link); }
      catch {
        steps.push("Secrets were stored for shell sessions. Ferry could not configure the optional Paseo service. Run ferry integrations enable paseo for this box to repair it.");
      }
      steps.push("On the box, run systemctl --user restart ferry-paseo.service to load the service environment. This stops active Paseo agents. Start new agents after the restart.");
    }
    return { box: box.name, secrets, steps };
  } finally { if (typeof lock === "function") lock(); }
}
