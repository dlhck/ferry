/**
 * Descriptors for the harnesses ferry manages and the tools it installs and
 * logs in.
 *
 * A descriptor is data. Ferry never loads code from one. Only gh and a tool
 * that the operator defines in a `[tools.<id>]` table of the config have a
 * `recipe`, which builds a command from a version. A descriptor names paths and
 * commands; it cannot widen the deny set, which stays in Manifest.
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

/**
 * `agent` is the vendor CLI of a harness. `tool` is every other program: gh,
 * and each tool that the config defines. The kind sets the defaults in
 * TOOL_KIND_DEFAULTS.
 */
export type ToolKind = "agent" | "tool";

/**
 * `always`: ferry installs the tool on every box. `mirror`: ferry installs the
 * tool only when the operator machine has it.
 */
export type ToolInstallMode = "always" | "mirror";

/**
 * The version policy of a tool in the config. `operator` is the version on
 * the operator machine, `latest` follows the vendor, and any other value is an
 * exact version that the config parser validated.
 */
export type ToolPolicy = string;

export const TOOL_KIND_DEFAULTS: Readonly<
  Record<ToolKind, { readonly mode: ToolInstallMode; readonly policy: "operator" | "latest" }>
> = {
  agent: { mode: "always", policy: "latest" },
  tool: { mode: "mirror", policy: "operator" },
};

/**
 * One program on the box: a vendor agent CLI, gh, or a tool that the config
 * defines. The config `[tools]` table sets the version policy of each one.
 */
export type ToolDescriptor = {
  readonly id: string;
  /** The registry sets it on each tool. A descriptor without a kind counts as `agent`. */
  readonly kind?: ToolKind;
  /** The label that `ferry tools` prints. */
  readonly name?: string;
  /** The executable on `PATH`, when the tool has one. */
  readonly binary?: string;
  /**
   * A shell command that prints the version on the operator machine. Ferry
   * runs it in the home directory after it loads nvm, when nvm is there, and
   * takes the first version in the output. A failed command or no version
   * means that the operator machine does not have the tool.
   */
  readonly localVersion?: string;
  /** A shell command that prints the version on the box. The same rules apply. */
  readonly boxVersion?: string;
  /**
   * A shell command that prints the newest version. Ferry runs it on the
   * operator machine for the `latest` policy of a tool that the config defines.
   */
  readonly latestVersion?: string;
  /** The recipe for the `latest` policy. The agent CLIs use it today. */
  readonly install?: { readonly command: string };
  readonly update?: ToolUpdate;
  /**
   * Recipes for one version. For a config tool, each one puts the
   * shell-quoted version in place of `{version}` in the command of the config. A tool without them can
   * follow only the `latest` policy.
   */
  readonly recipe?: {
    readonly install: (version: string) => string;
    readonly update: (version: string) => string;
  };
  /** Directories, relative to the home, that the tool adds to the box `PATH`. */
  readonly pathDirs?: readonly string[];
  /** Tool ids that ferry installs before this tool. */
  readonly dependsOn?: readonly string[];
  readonly auth?: ToolAuth;
  readonly mcp?: ToolMcp;
};

/** The install mode and default policy of a tool, from its kind. */
export function toolDefaults(tool: ToolDescriptor): (typeof TOOL_KIND_DEFAULTS)[ToolKind] {
  return TOOL_KIND_DEFAULTS[tool.kind ?? "agent"];
}
