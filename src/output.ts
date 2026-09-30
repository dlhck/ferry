/**
 * The `--json` contract. A command that runs and exits prints one envelope on
 * stdout. `watch`, `tunnel`, and `expose` print one event for each line
 * (NDJSON). The error codes are stable strings, so an agent can use the code,
 * not the message text. Progress and the text lines of a command go to stderr.
 */

import { CommanderError } from "commander";
import { BoxRequiredError, UnknownBoxError } from "./boxes.ts";
import { ConfigError, ConfigMissingError } from "./config.ts";
import { FerryError, linkCode, type ErrorCode } from "./errors.ts";

export const SCHEMA_VERSION = 1;

/** The `type` of each event. `error` is the last event of a command that stays running and fails. */
export const EVENT_TYPES = [
  "watch-started",
  "synced",
  "sync-failed",
  "sync-refused",
  "content-refused",
  "config-error",
  "update-started",
  "update-failed",
  "status-failed",
  "watch-stopped",
  "following",
  "forward-opened",
  "forward-closed",
  "forward-failed",
  "connection-lost",
  "tunnel-closed",
  "exposed",
  "exited",
  "login",
  "error",
] as const;

/** The hint of each code, when the error gives none. */
const HINTS: Record<ErrorCode, string | null> = {
  usage: "Run the command with --help.",
  "config-missing": "Run ferry init.",
  "config-invalid": "Correct ~/.ferry/config.toml.",
  "unknown-box": "Run ferry box list for the box names.",
  "box-required": "Name the box, or set default_box with ferry box default <name>.",
  "box-offline": "Make sure that the box is on and that this machine can reach it. Run ferry status.",
  "box-command-failed": null,
  "forward-failed": null,
  "confirmation-required": "Add --yes to confirm.",
  "missing-values": "Give the missing values as options.",
  "deny-rule-match": "Remove the file that the deny rule refuses, or move it out of the portable set.",
  refused: null,
  "sync-busy": "Wait for the other Ferry command to end, then run the command again.",
  "sync-failed": null,
  "update-failed": null,
  "login-failed": null,
  "command-failed": null,
  failed: null,
};

export type ErrorInfo = {
  readonly code: ErrorCode;
  readonly message: string;
  readonly hint: string | null;
  /** Data for the code, such as `hostKeys` for a host key confirmation. Only some errors have it. */
  readonly details?: Readonly<Record<string, unknown>>;
};

export type Envelope = {
  readonly schemaVersion: typeof SCHEMA_VERSION;
  readonly command: string;
  readonly ok: boolean;
  readonly result: unknown;
  readonly warnings: readonly string[];
  readonly error: ErrorInfo | null;
};

/** One NDJSON line of a command that stays running. An error event also has `code`, `message`, and `hint`. */
export type OutputEvent = { readonly type: string } & Readonly<Record<string, unknown>>;

export function successEnvelope(command: string, result: unknown, warnings: readonly string[]): Envelope {
  return { schemaVersion: SCHEMA_VERSION, command, ok: true, result: result ?? null, warnings, error: null };
}

/** `result` is null, or the outcome of each box when the command ran on the boxes. */
export function failureEnvelope(command: string, error: unknown, warnings: readonly string[], result: unknown = null): Envelope {
  return { schemaVersion: SCHEMA_VERSION, command, ok: false, result, warnings, error: errorInfo(error) };
}

/** The error event of a command that stays running. */
export function errorEvent(type: string, error: unknown, fields: Readonly<Record<string, unknown>> = {}): OutputEvent {
  return { type, ...fields, ...errorInfo(error) };
}

/**
 * The stable code, the message, and a hint for an error. The code comes from
 * the class of the error or its `code` property, never from the message. A
 * cause with its own code, such as the Link error of a failed box command,
 * gives the code of the error that wraps it.
 */
export function errorInfo(error: unknown): ErrorInfo {
  const message = messageOf(error);
  for (let current = error, depth = 0; current instanceof Error && depth < 8; current = current.cause, depth++) {
    if (current instanceof FerryError) {
      return {
        code: current.code,
        message,
        hint: current.hint ?? HINTS[current.code],
        ...(current.details !== undefined ? { details: current.details } : {}),
      };
    }
    const code = ownCode(current);
    if (code !== null) return { code, message, hint: HINTS[code] };
  }
  const code = errorCode(error);
  return { code, message, hint: HINTS[code] };
}

/** The code of an error class whose code wins over the code of an error that wraps it. */
function ownCode(error: Error): ErrorCode | null {
  if (error instanceof UnknownBoxError) return "unknown-box";
  if (error instanceof BoxRequiredError) return "box-required";
  if (error instanceof ConfigMissingError) return "config-missing";
  return null;
}

function errorCode(error: unknown): ErrorCode {
  if (error instanceof CommanderError) return "usage";
  // The other classes match by name, because their modules import this module.
  const name = error instanceof Error ? error.name : "";
  const code = (error as { code?: unknown } | null)?.code;
  if (name === "BoxesSyncError") return "sync-failed";
  if (name === "InstallAuthCommandError" && typeof code === "string") return installAuthCode(code);
  if (error instanceof ConfigError) return "config-invalid";
  switch (name) {
    case "SyncError":
      if (code === "concurrent-sync" || code === "lock-failure") return "sync-busy";
      if (code === "invalid-config" || code === "wrong-publisher" || code === "registry-failure" || code === "registry-refusal") {
        return "config-invalid";
      }
      return code === "manifest-refusal" ? "refused" : "sync-failed";
    case "InitRefusal":
      if (code === "missing-values") return "missing-values";
      return code === "invalid-values" ? "usage" : "refused";
    case "ExposeError":
    case "IntegrationCommandError":
      return "usage";
    case "UpdateError":
      return "update-failed";
    case "SkillsAddError":
      return "command-failed";
    case "MoveError":
    case "UninstallRefusal":
    case "ApplyError":
    case "StoreRefusal":
    case "AdoptionRefusal":
    case "ToolPlanError":
      return "refused";
  }
  return "failed";
}

/** `install` and `auth` codes are `<origin>/<code>`, such as `network/host-offline` or `box/login-unfinished`. */
function installAuthCode(code: string): ErrorCode {
  const [origin, kind = ""] = code.split("/");
  const link = linkCode(kind);
  if (link) return link;
  if (kind === "confirmation-required") return "confirmation-required";
  if (kind === "invalid-config") return "config-missing";
  if (kind === "tool-plan") return "refused";
  if (origin === "box") return "login-failed";
  return "usage";
}

function messageOf(error: unknown): string {
  if (error instanceof Error && error.message) return error.message;
  if (typeof error === "string" && error) return error;
  return "Ferry failed.";
}
