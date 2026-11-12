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
  readonly settings?: {
    readonly file: string;
    readonly format: "json" | "toml";
    readonly keys: readonly string[];
  };
  /**
   * The file and key where the harness declares its user-scope MCP servers.
   * Ferry carries only the remote servers from it. Only a builtin descriptor
   * sets this.
   */
  readonly mcp?: { readonly file: string; readonly format: "json" | "toml"; readonly key: string };
  /** Where the harness keeps its sessions. `ferry move` carries the sessions of the project. Only a builtin descriptor sets this. */
  readonly sessions?: SessionStore;
  /**
   * The program names of the agent process, such as `claude`. `ferry ps`
   * compares them with the file name of the first argument of each box
   * process, or of the second argument after `node` or `bun`. Only a builtin
   * descriptor sets this.
   */
  readonly processNames?: readonly string[];
  /** Where the harness records token counts. `ferry usage` shows a harness without it as not available. Only a builtin descriptor sets this. */
  readonly usage?: UsageRecords;
};

/**
 * The token counts in the JSONL session files of a harness. A dotted path,
 * such as `message.usage`, names a value in the JSON of one line. Each line
 * has the time of its record in `timestamp`, in ISO 8601 form.
 */
export type UsageRecords = {
  /** The directory of the session files, relative to a home. Ferry looks in all its subdirectories. */
  readonly root: string;
  /** A glob for the file name, such as `*.jsonl`. */
  readonly files: string;
  /** The paths of the token record in a line. The first path that holds an object counts. */
  readonly records: readonly string[];
  /** The keys of the counts in a record. */
  readonly fields: { readonly input: string; readonly output: string; readonly cacheRead: string; readonly cacheWrite: string };
  /** True when the input count includes the cache read count. Ferry then subtracts it. */
  readonly inputIncludesCacheRead?: boolean;
  /** The path of the project directory in the line of the record, else in the first line of the file. */
  readonly project: string;
  /**
   * A record counts once for each value at `path`: once in each file, or once
   * in all files of the harness. A harness can write the same record two
   * times, or copy it into a new file.
   */
  readonly once?: { readonly path: string; readonly scope: "file" | "harness" };
};

/**
 * A session store and how ferry finds the sessions of one project path. The
 * paths are relative to a home.
 */
export type SessionStore =
  /**
   * One directory under `root` for each project. Its name is the absolute
   * project path with each character that is not a letter or a digit changed
   * to `-`. Each `<id>.jsonl` in it is a session, and the directory `<id>`
   * next to it holds more files of that session. `memory` names a directory
   * in it that holds the project memory.
   */
  | { readonly layout: "project-directory"; readonly root: string; readonly memory: string }
  /**
   * Session files anywhere under `root` whose name matches the glob `files`.
   * The first line of a session is JSON that records the session `id` and the
   * project path `cwd` in its `payload`.
   */
  | { readonly layout: "first-line-cwd"; readonly root: string; readonly files: string };

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
      /**
       * The URL carries the login session in its fragment or in a query key
       * such as `sessionToken`, and ferry passes it on. Only a tool that the
       * config defines sets it, because the operator names its hosts.
       */
      readonly sessionInUrl?: boolean;
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
  /**
   * Skip the operator update when the resolved executable path contains this
   * text. The program that bundles the executable owns its update.
   */
  readonly operatorSkip?: { readonly pathIncludes: string; readonly reason: string };
};

/**
 * How ferry declares, lists, and logs in MCP servers with the CLI of a
 * harness. The tool id is the harness id. In a command, `{name}`, `{url}`,
 * and `{type}` are replaced with shell-quoted values. The box fills in
 * `{json}` and `{command}` itself.
 */
export type ToolMcp = {
  /**
   * Commands that register one remote server. `get` prints the server URL
   * when the server is declared, and fails when it is not. Without them,
   * ferry merges the server into the MCP file of the harness.
   *
   * For a stdio server: `addJson` adds one server from its JSON declaration
   * in `{json}`. `addStdio` adds one server that runs `{command}`, the
   * command and its arguments. `getJson` prints one server as JSON, with
   * `command`, `args`, and `env` at the top or under `transport`. Without
   * `addJson` and `addStdio`, ferry merges stdio servers into the JSON MCP
   * file of the harness.
   *
   * For an entry of the MCP gateway: `addJson` adds the URL and the header.
   * Without `addJson`, `add` adds the URL, and the box appends the header in
   * `headersTable`, a table under the server entry of the TOML MCP file.
   */
  readonly register?: {
    readonly get: string;
    readonly remove: string;
    readonly add: string;
    readonly addJson?: string;
    readonly addStdio?: string;
    readonly getJson?: string;
    readonly headersTable?: string;
  };
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
 * the operator machine, `latest` follows the vendor, `off` turns off a builtin
 * tool and the harness with the same id, and any other value is an exact
 * version that the config parser validated.
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
  /** The install mode and default policy, when they differ from those of the kind. */
  readonly defaults?: (typeof TOOL_KIND_DEFAULTS)[ToolKind];
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
  return tool.defaults ?? TOOL_KIND_DEFAULTS[tool.kind ?? "agent"];
}
