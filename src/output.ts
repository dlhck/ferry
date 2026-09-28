/**
 * The `--json` contract. A command that runs and exits prints one envelope on
 * stdout. `watch`, `tunnel`, and `expose` print one event for each line
 * (NDJSON). The error codes are stable strings, so an agent can use the code,
 * not the message text. Progress and the text lines of a command go to stderr.
 */

import { CommanderError } from "commander";
import { BoxRequiredError, UnknownBoxError } from "./boxes.ts";
import { ConfigError } from "./config.ts";
import type { LinkError, LinkErrorCode } from "./link.ts";

export const SCHEMA_VERSION = 1;

export const ERROR_CODES = [
  "usage",
  "config-missing",
  "config-invalid",
  "unknown-box",
  "box-required",
  "box-offline",
  "box-command-failed",
  "forward-failed",
  "confirmation-required",
  "missing-values",
  "deny-rule-match",
  "refused",
  "sync-busy",
  "sync-failed",
  "update-failed",
  "login-failed",
  "command-failed",
  "failed",
] as const;

export type ErrorCode = (typeof ERROR_CODES)[number];

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
  "sync-busy": "Wait for the other sync to end, then run the command again.",
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

/** An error with a stable code. Put it in the `cause` of another error to give that error a code. */
export class FerryError extends Error {
  constructor(
    readonly code: ErrorCode,
    message: string,
    readonly hint?: string,
  ) {
    super(message);
    this.name = "FerryError";
  }
}

/** A step that needs a confirmation, with `--json` and without `--yes`. */
export function confirmationRequired(question: string): FerryError {
  return new FerryError("confirmation-required", `${question} Ferry does not ask with --json.`);
}

/** The code of a Link error, for the `cause` of a refusal that a failed box command gives. */
export function linkFailure(error: LinkError): FerryError {
  return new FerryError(LINK_CODES[error.code], `${error.origin}/${error.code}: ${error.message}`);
}

/** A Manifest refusal with a forbidden hit has the code `deny-rule-match`. A refusal with clashes only has none. */
export function denyRuleCause(forbidden: readonly { readonly path: string; readonly reason: string }[]): ErrorOptions | undefined {
  const [first] = forbidden;
  return first ? { cause: new FerryError("deny-rule-match", `${first.reason}: ${first.path}`) } : undefined;
}

export function successEnvelope(command: string, result: unknown, warnings: readonly string[]): Envelope {
  return { schemaVersion: SCHEMA_VERSION, command, ok: true, result: result ?? null, warnings, error: null };
}

export function failureEnvelope(command: string, error: unknown, warnings: readonly string[]): Envelope {
  return { schemaVersion: SCHEMA_VERSION, command, ok: false, result: null, warnings, error: errorInfo(error) };
}

/** The error event of a command that stays running. */
export function errorEvent(type: string, error: unknown, fields: Readonly<Record<string, unknown>> = {}): OutputEvent {
  return { type, ...fields, ...errorInfo(error) };
}

/** The stable code, the message, and a hint for an error. */
export function errorInfo(error: unknown): ErrorInfo {
  const message = messageOf(error);
  const coded = codedCause(error);
  if (coded) return { code: coded.code, message, hint: coded.hint ?? HINTS[coded.code] };
  const code = errorCode(error, message);
  return { code, message, hint: HINTS[code] };
}

function errorCode(error: unknown, message: string): ErrorCode {
  if (error instanceof CommanderError) return "usage";
  if (error instanceof UnknownBoxError) return "unknown-box";
  if (error instanceof BoxRequiredError) return "box-required";
  // Each module that reads the config says this when the config is missing or incomplete.
  if (/Run ferry init\.?$/.test(message)) return "config-missing";
  // The other classes match by name, because their modules import this module.
  const name = error instanceof Error ? error.name : "";
  const code = (error as { code?: unknown } | null)?.code;
  if (name === "BoxesSyncError") return "sync-failed";
  if (name === "InstallAuthCommandError" && typeof code === "string") return installAuthCode(code);
  const link = linkCodeIn(message);
  if (link) return link;
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

/** The first `FerryError` in the error and its causes. */
function codedCause(error: unknown): FerryError | null {
  for (let current = error, depth = 0; current instanceof Error && depth < 8; current = current.cause, depth++) {
    if (current instanceof FerryError) return current;
  }
  return null;
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

const LINK_CODES: Record<LinkErrorCode, ErrorCode> = {
  "invalid-config": "config-invalid",
  "tailscale-status-failed": "box-offline",
  "tailscale-status-timeout": "box-offline",
  "tailscale-status-invalid": "box-offline",
  "host-not-found": "box-offline",
  "host-offline": "box-offline",
  "ssh-start-failed": "box-offline",
  "ssh-failed": "box-offline",
  "command-failed": "box-command-failed",
  "command-timeout": "box-command-failed",
  "forward-failed": "forward-failed",
  "forward-timeout": "forward-failed",
};

function linkCode(kind: string): ErrorCode | null {
  return Object.hasOwn(LINK_CODES, kind) ? LINK_CODES[kind as LinkErrorCode] : null;
}

/** A Link error in a message, as `<origin>/<code>`, such as `network/host-offline`. */
function linkCodeIn(message: string): ErrorCode | null {
  const match = /\b(?:operator|network|box)\/([a-z-]+)/.exec(message);
  return match?.[1] ? linkCode(match[1]) : null;
}

function messageOf(error: unknown): string {
  if (error instanceof Error && error.message) return error.message;
  if (typeof error === "string" && error) return error;
  return "Ferry failed.";
}
