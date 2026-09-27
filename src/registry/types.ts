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
  /**
   * When false, ferry inspects `skillRoot` only to remove leftover store
   * links. Codex, Pi, and Cursor Agent already read `.agents/skills`.
   */
  readonly ownSkills?: boolean;
  /** Instruction file the harness reads, such as `.claude/CLAUDE.md`. */
  readonly instructionFile?: string;
  /**
   * Directories ferry carries whole, such as `.claude/agents`. Each one links
   * to one store directory. Only a builtin descriptor sets them.
   */
  readonly extraRoots?: readonly string[];
  /**
   * The settings file of the harness and the keys ferry carries from it. No
   * other key leaves the machine, and the box keeps its other keys. Only a
   * builtin descriptor sets this.
   */
  readonly settings?: { readonly file: string; readonly keys: readonly string[] };
  /**
   * The file and key where the harness declares its user-scope MCP servers.
   * Ferry carries only the remote servers from it. Only a builtin descriptor
   * sets this.
   */
  readonly mcp?: { readonly file: string; readonly format: "json" | "toml"; readonly key: string };
};

/** Codex, Pi, and Cursor Agent read `.agents/skills` instead of their own copies. */
export function ownsSkills(harness: HarnessDescriptor): boolean {
  return harness.skillRoot !== undefined && harness.ownSkills !== false;
}

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
  | {
      readonly kind: "printed-url";
      readonly allowedHosts: readonly string[];
      /**
       * Regular expression source for the code that the browser shows after
       * the login. The operator pastes it, and ferry gives it to the login on
       * the box. Without it, the login finishes without input.
       */
      readonly pastedCode?: string;
    }
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
  /** A box command that runs before the login, and also when the tool is already logged in. */
  readonly prepare?: string;
  /**
   * A box command that runs after the login completes, and also when the tool
   * is already logged in. It prints one line for each step, and the line
   * `ferry-setup-ok` last when all steps passed.
   */
  readonly setup?: string;
};

/** How ferry updates a tool. */
export type ToolUpdate = {
  /** The update command. Ferry runs it on the box. */
  readonly command: string;
  /**
   * The executable of the tool. When set, ferry also runs `command` on the
   * operator machine if this executable is there. Leave it unset when
   * `command` works only on the box, such as an apt command.
   */
  readonly binary?: string;
};

/**
 * How ferry declares, lists, and logs in remote MCP servers with the CLI of a
 * harness. The tool id is the harness id. In a command, `{name}`, `{url}`, and
 * `{type}` are replaced with shell-quoted values.
 */
export type ToolMcp = {
  /**
   * Commands that register one server. `get` prints the server URL when the
   * server is declared. Without them, ferry merges the server into the MCP
   * file of the harness.
   */
  readonly register?: { readonly get: string; readonly remove: string; readonly add: string };
  /** Lists the declared servers and their login state. */
  readonly list: string;
  /** Regular expression source for one `list` line of a server that needs a login. Group 1 is the name. */
  readonly loginRequired: string;
  /** Starts a login. It prints an authorize URL and waits on a loopback callback. */
  readonly login: string;
};

/** One vendor CLI on the box. */
export type ToolDescriptor = {
  readonly id: string;
  readonly install?: { readonly command: string };
  readonly update?: ToolUpdate;
  readonly auth?: ToolAuth;
  readonly mcp?: ToolMcp;
};
