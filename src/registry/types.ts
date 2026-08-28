/**
 * Descriptors for the harnesses ferry manages and the vendor CLIs it installs
 * and logs in.
 *
 * A descriptor is data. Ferry never loads code from one. A descriptor names
 * paths and commands; it cannot widen the deny set, which stays in Manifest.
 */

/**
 * One agent harness. `id` is the identifier a store records, `name` is the
 * label plans and errors print. Both paths are relative to a home.
 */
export type HarnessDescriptor = {
  readonly id: string;
  readonly name: string;
  /** Skill directory of the harness, such as `.claude/skills`. */
  readonly skillRoot?: string;
  /** Instruction file the harness reads, such as `.claude/CLAUDE.md`. */
  readonly instructionFile?: string;
};

/** How the operator finishes a login that started on the box. */
export type AuthCompletion =
  /** The tool prints a code for a fixed vendor device page. */
  | {
      readonly kind: "device-url";
      readonly url: string;
      /** Regular expression source for the user code. No code is read without it. */
      readonly codePattern?: string;
    }
  /** The tool prints the login URL. Only these hosts are passed on. */
  | { readonly kind: "printed-url"; readonly allowedHosts: readonly string[] }
  /** The tool has no remote login ferry can drive. The operator finishes it by hand. */
  | { readonly kind: "manual"; readonly command: string; readonly instruction: string };

/** The callback login a tool falls back to when its first login command fails. */
export type AuthFallback = {
  readonly login: string;
  readonly allowedHosts: readonly string[];
  readonly forward: {
    readonly localPort: number;
    readonly remotePort: number;
    readonly remoteHost: string;
    readonly timeoutMs: number;
  };
};

/**
 * A login recipe. `probe` and `login` are the remote commands ferry runs. A
 * tool whose completion is manual has neither: ferry never starts that login.
 */
export type ToolAuth = {
  readonly probe?: string;
  readonly login?: string;
  readonly completion: AuthCompletion;
  readonly fallback?: AuthFallback;
};

/** One vendor CLI on the box. */
export type ToolDescriptor = {
  readonly id: string;
  readonly install?: { readonly command: string };
  readonly auth?: ToolAuth;
};
