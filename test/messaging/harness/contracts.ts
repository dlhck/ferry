/**
 * The contracts of the fakes that the messaging integration suites use.
 *
 * Lane B implements `FakeGitHub` in `test/messaging/fakes/github.ts` and exports
 * `startFakeGitHub: StartFakeGitHub`. Lane C implements `FakeRuntimes` in
 * `test/messaging/fakes/runtimes.ts` and exports `createFakeRuntimes: CreateFakeRuntimes`.
 * The suites in `test/messaging/integration` import only these names.
 *
 * Rules for both fakes (CONTRIBUTING.md): localhost only, no real `gh`, `claude`, or
 * `codex` binary, example names and generated keys only. All state lives under the
 * directories that the test gives.
 */

import type { Clock } from "./clock.ts";
import type { TestHome, TestIdentity } from "./homes.ts";

// ---------------------------------------------------------------------------
// Fake GitHub (lane B, design 14.2)
// ---------------------------------------------------------------------------

export type FakePermission = "admin" | "write" | "read" | "none";

export type FakeRepository = {
  readonly owner: string;
  readonly name: string;
  /** The numeric repository id. The relay keys the project on it (design 4.2). */
  readonly id: number;
};

/** A fault that the fake applies to each request until the test clears it. */
export type FakeGitHubFault =
  /** Answer 503. */
  | "server-error"
  /** Answer 403 with `x-ratelimit-remaining: 0`. */
  | "rate-limit"
  /** Close the connection without an answer. */
  | "drop";

export type StartFakeGitHubOptions = {
  /** The users that exist at start. Default: none. */
  readonly users?: readonly Pick<TestIdentity, "login" | "githubUserId">[];
  /** The repositories that exist at start. Default: none. */
  readonly repositories?: readonly FakeRepository[];
  /** The clock for token expiry and device code expiry. Default: the system clock. */
  readonly clock?: Clock;
};

export interface FakeGitHub {
  /** Replaces `https://api.github.com`. Loopback HTTP. */
  readonly apiUrl: string;
  /** Replaces `https://github.com` for `/login/device/code`, `/login/oauth/access_token`, and the manifest flow. */
  readonly webUrl: string;
  /**
   * The App that the fake knows. The key is generated at start for this run only.
   * `POST /app/installations/{id}/access_tokens` refuses a JWT with another key.
   */
  readonly app: { readonly appId: number; readonly clientId: string; readonly slug: string; readonly privateKeyPem: string };

  addUser(user: Pick<TestIdentity, "login" | "githubUserId">): void;
  /** Changes the login of a user id. `GET /user/{id}` returns the new login. */
  renameUser(githubUserId: number, login: string): void;
  addRepository(repository: FakeRepository): void;
  /** Installs the App on an account, for all its repositories or only the named ones. Returns the installation id. */
  install(owner: string, repositories?: readonly string[]): number;
  /** Removes the installation. Lookups for its repositories return 404. */
  uninstall(owner: string): void;
  /**
   * Sets the `permission` field of the collaborator permission endpoint for a user on
   * `<owner>/<name>`. `none` makes the endpoint return 404, as GitHub does for a non-collaborator.
   */
  setPermission(fullName: string, login: string, permission: FakePermission, roleName?: string | null): void;

  /** The user codes of the device flows that wait for the user. */
  pendingUserCodes(): string[];
  /** The user enters the code and authorizes. The next poll returns a token for that user. */
  authorizeDevice(userCode: string, githubUserId: number): void;
  /** The user denies. The next poll returns `access_denied`. */
  denyDevice(userCode: string): void;
  /** The code expires. The next poll returns `expired_token`. */
  expireDevice(userCode: string): void;
  /** The next poll for the code returns `slow_down`. */
  slowDownDevice(userCode: string): void;

  /** Applies a fault to each later request, or clears it with `null`. */
  setFault(fault: FakeGitHubFault | null): void;
  /** The requests that the fake got, without headers or bodies, oldest first. */
  requests(): readonly { readonly method: string; readonly path: string }[];
  stop(): Promise<void>;
}

export type StartFakeGitHub = (options?: StartFakeGitHubOptions) => Promise<FakeGitHub>;

// ---------------------------------------------------------------------------
// Fake runtimes (lane C, design 14.3)
// ---------------------------------------------------------------------------

export type FakeRuntime = "claude" | "codex";
export type FakeActivity = "idle" | "busy" | "awaiting-approval";

/** What a hook or MCP process sends as `caller` (design 8.1). */
export type FakeCaller = { readonly ancestors: readonly { readonly pid: number; readonly startTime: string }[] };

export type FakeHookEvent =
  | "SessionStart"
  | "UserPromptSubmit"
  | "Stop"
  | "PermissionRequest"
  | "Notification"
  | "PostToolUse"
  | "SessionEnd";

/**
 * One fake Claude Code session or Codex thread. It is a real child process with the
 * executable name `claude` or `codex` in a directory of the test, so the worker
 * finds it in the caller ancestry and checks its liveness as it does for a real one.
 *
 * Fake Claude: listens on a fake inbox socket. It checks the auth line and the token,
 * and appends each frame to its transcript when it is idle, or at the next tool call
 * boundary when it is busy.
 *
 * Fake Codex: holds a `flock` write lock on `<codex home>/thread-writer-locks/<thread>.lock`.
 * The fake `codex queue` program writes rows to `<codex home>/queue_1.sqlite`, table
 * `queued_items`, and prints `Queued message <id> for thread <thread>.`. The session
 * consumes a row and appends it to its transcript when it is idle or when its turn ends.
 */
export interface FakeRuntimeSession {
  readonly runtime: FakeRuntime;
  readonly runtimeSessionId: string;
  readonly runtimeVersion: string;
  readonly pid: number;
  readonly cwd: string;
  readonly transcriptPath: string;
  /** The home of the identity that runs the session. */
  readonly home: TestHome;

  /** The ancestors that a hook child of this session sends to the worker. */
  caller(): FakeCaller;
  /** The hook input JSON that the real runtime gives for the event (design 8.1 lists the fields). */
  hookInput(event: FakeHookEvent, fields?: Readonly<Record<string, unknown>>): Record<string, unknown>;
  /** The environment of a hook child: `CLAUDE_CODE_MESSAGING_SOCKET` and `CLAUDE_CODE_MESSAGING_TOKEN` for Claude, `CODEX_HOME` for Codex. */
  hookEnv(): Record<string, string>;

  activity(): FakeActivity;
  /** Changes the activity. Going to `idle` lets the session consume what waits. */
  setActivity(activity: FakeActivity): void;
  /** The envelopes that reached the model, in order. A duplicate injection shows twice. */
  received(): readonly string[];

  /** A normal close (`/exit`): Claude removes its socket, Codex releases and removes the lock file. */
  exit(): Promise<void>;
  /** `kill -9`: the process is gone, the Codex lock file stays without a holder, the Claude socket file stays. */
  crash(): Promise<void>;
  /** A new process for the same runtime session id, as `claude --resume` or `codex resume` do. Waiting Codex rows run. */
  resume(): Promise<FakeRuntimeSession>;
}

export type CreateFakeRuntimesOptions = {
  /** Directory for the fake executables, sockets, transcripts, and queue stores. */
  readonly root: string;
  readonly clock?: Clock;
  /** The versions that the fake executables report. Default: the newest tested versions of design 9.2 and 9.3. */
  readonly versions?: { readonly claude?: string; readonly codex?: string };
};

/** Adapter type parameter: lane C's `Adapter` from `src/messaging/adapters/types.ts`. */
export interface FakeRuntimes<Adapter = unknown> {
  /** The real adapters of lane C, set up to use the fake executables and paths. Give them to `runWorker`. */
  adapters(home: TestHome): readonly Adapter[];
  /** Starts a session in `cwd` for the identity of `home`. */
  start(runtime: FakeRuntime, options: { readonly home: TestHome; readonly cwd: string }): Promise<FakeRuntimeSession>;
  /** Ends all sessions and removes nothing outside `root`. */
  stop(): Promise<void>;
}

export type CreateFakeRuntimes<Adapter = unknown> = (options: CreateFakeRuntimesOptions) => Promise<FakeRuntimes<Adapter>>;
