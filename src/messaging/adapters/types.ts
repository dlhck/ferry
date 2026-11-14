/**
 * The contract between the messaging worker and the code that delivers into
 * one runtime (design section 9). An adapter never starts a runtime, never
 * answers a prompt, and passes no permission mode, sandbox, or approval
 * policy to the runtime.
 */

import type { AdapterState, Runtime } from "../protocol.ts";

export type { AdapterState, Runtime };

/** One runtime session on this host, as the worker store keeps it. */
export type LocalSession = {
  readonly runtime: Runtime;
  readonly runtimeSessionId: string;
  readonly runtimeVersion: string;
  /** The program of the runtime process. The adapter runs it for `--version` and `codex queue`. */
  readonly runtimeExe: string;
  readonly runtimePid: number;
  readonly runtimePidStart: string;
  readonly relaySessionId: string | null;
  readonly transcriptPath: string | null;
  /** Claude only. The inbox socket and its token. They stay on this host. */
  readonly claudeSocket: string | null;
  readonly claudeToken: string | null;
  /** Codex only. The `CODEX_HOME` of the session. */
  readonly codexHome: string | null;
  readonly state: "live" | "offline";
  readonly activity: "idle" | "busy" | "awaiting-approval" | null;
  readonly registeredAt: string;
};

/** One injection of one receipt, as the worker store keeps it. */
export type Attempt = {
  readonly receiptId: string;
  readonly attempt: number;
  readonly generation: number;
  readonly sessionId: string;
  readonly messageId: string;
  /** Codex: the queue item id that `codex queue` printed. */
  readonly runtimeRef: string | null;
  /** The transcript size before the injection. The search for the message id starts there. */
  readonly transcriptOffset: number | null;
  readonly injectedAt: string | null;
};

export type Check = { readonly adapter: AdapterState; readonly reason: string | null };

export type Confirmation =
  | { readonly state: "delivered"; readonly evidence: "transcript" | "codex-queue-consumed" }
  | { readonly state: "pending" }
  | { readonly state: "stranded" };

export interface Adapter {
  readonly runtime: Runtime;
  /** The version in the output of `<runtime exe> --version`, or null when the output is not of this runtime. */
  version(output: string): string | null;
  /** The version gate and the capability check. */
  check(session: LocalSession): Promise<Check>;
  live(session: LocalSession): Promise<boolean>;
  inject(session: LocalSession, envelope: string, messageId: string): Promise<{ ok: true; runtimeRef: string | null } | { ok: false; error: string }>;
  confirm(session: LocalSession, attempt: Attempt): Promise<Confirmation>;
}

/** -1, 0, or 1. Each version is three numbers. */
export function compareVersions(a: string, b: string): number {
  const left = a.split(".").map(Number);
  const right = b.split(".").map(Number);
  for (let i = 0; i < 3; i++) {
    const difference = (left[i] ?? 0) - (right[i] ?? 0);
    if (difference !== 0) return Math.sign(difference);
  }
  return 0;
}

/**
 * The version gate of both adapters: below `minimum` is `unsupported`, a
 * version in `passed` is `supported`, and any other version is `untested`.
 * `passed` is the list of versions that passed the real-CLI suite.
 */
export function gate(name: string, version: string, minimum: string, passed: readonly string[]): Check {
  if (!/^\d+\.\d+\.\d+$/.test(version)) return { adapter: "unsupported", reason: `Ferry cannot read the ${name} version.` };
  if (compareVersions(version, minimum) < 0) return { adapter: "unsupported", reason: `${name} ${version} is older than ${minimum}, the first version that Ferry supports.` };
  if (passed.includes(version)) return { adapter: "supported", reason: null };
  return { adapter: "untested", reason: `${name} ${version} did not pass the Ferry runtime tests yet.` };
}
