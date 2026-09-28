/**
 * The stable error codes of `--json`, and the error that carries one. This
 * module imports no other Ferry module, so each module can throw a coded error.
 */

import type { LinkError, LinkErrorCode } from "./link.ts";

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

/** An error with a stable code. Put it in the `cause` of another error to give that error a code. */
export class FerryError extends Error {
  readonly hint?: string;
  readonly details?: Readonly<Record<string, unknown>>;

  constructor(
    readonly code: ErrorCode,
    message: string,
    options: { readonly hint?: string; readonly details?: Readonly<Record<string, unknown>> } = {},
  ) {
    super(message);
    this.name = "FerryError";
    if (options.hint !== undefined) this.hint = options.hint;
    if (options.details !== undefined) this.details = options.details;
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

/** The code of a Link error code, such as `box-offline` for `host-offline`. */
export function linkCode(kind: string): ErrorCode | null {
  return Object.hasOwn(LINK_CODES, kind) ? LINK_CODES[kind as LinkErrorCode] : null;
}
