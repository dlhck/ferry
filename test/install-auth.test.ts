import { describe, expect, test } from "bun:test";
import type { AuthLink, AuthStartResult } from "../src/auth-start.ts";
import {
  runAuthCommand,
  runInstallCommand,
  type AuthCommandDependencies,
  type InstallCommandDependencies,
} from "../src/install-auth.ts";
import type { GitIdentity } from "../src/git-identity.ts";
import { errorInfo, type OutputEvent } from "../src/output.ts";
import { Install, type InstallProgress, type InstallResult } from "../src/install.ts";
import type { ToolDescriptor } from "../src/registry/types.ts";
import type { LinkResult } from "../src/link.ts";
import { BUILTIN_TOOLS } from "../src/registry/builtin.ts";
import { noProgress } from "../src/progress.ts";
import { ToolPlanError, type ToolStep } from "../src/tools/resolve.ts";
import { recordProgress } from "./fake-progress.ts";

const config = {
  version: 1 as const,
  publisher: "operator",
  snapshotUrl: "git@example.com:snapshot.git",
  host: { tailscale: "builder.tailnet.ts.net", sshUser: "david" },
};

describe("install command", () => {
  const plan: readonly ToolStep[] = [
    { tool: "gh", policy: "operator", version: "2.92.0", action: "install", command: "install gh\nwith the full command", dependsOn: [] },
    { tool: "codex", policy: "latest", version: null, action: "install", command: "install codex", dependsOn: [] },
    { tool: "node", policy: "operator", version: "24.16.0", action: "skip-same", dependsOn: [] },
    { tool: "bun", policy: "operator", version: null, action: "skip-not-on-operator", dependsOn: [] },
  ];

  test("prints the exact plan before confirmation", async () => {
    const output: string[] = [];
    let outputAtPrompt: readonly string[] = [];

    await runInstallCommand(
      { yes: false },
      installDependencies({
        plan,
        output,
        confirm: async () => {
          outputAtPrompt = [...output];
          return false;
        },
      }),
    );

    expect(outputAtPrompt).toEqual([
      "gh: install 2.92.0 (policy operator): install gh\nwith the full command",
      "codex: install latest (policy latest): install codex",
      "node: skipped, the box has 24.16.0 (policy operator)",
      "bun: skipped, not on the operator machine (policy operator)",
      "ferry: skipped, this Ferry is a development build without a release version (policy operator)",
      `git identity: ${identityCommand}`,
    ]);
  });

  test("passes the [tools] config to the install and runs the plan that it printed", async () => {
    let received: unknown;
    let ran: readonly ToolStep[] = [];
    const tools = { gh: "latest" };

    await runInstallCommand(
      { yes: true },
      {
        ...installDependencies({ plan }),
        readConfig: () => ({ ...config, tools }),
        createInstall: (_link, _tools, toolsConfig) => {
          received = toolsConfig;
          return {
            plan: async () => plan,
            run: async (_confirmed, planned) => {
              ran = planned;
              return { ok: true };
            },
          };
        },
      },
    );

    expect(received).toEqual(tools);
    expect(ran).toEqual([
      ...plan,
      { tool: "ferry", policy: "operator", version: null, action: "skip-dev-build", dependsOn: [] },
    ]);
  });

  test("prints the output of an installer after its step, such as the gh fallback warning", async () => {
    const output: string[] = [];
    const progress: string[] = [];
    const events = { output, progress };

    await runInstallCommand(
      { yes: true },
      {
        ...installDependencies({
          plan,
          progress,
          run: async (_confirmed, _plan, reportProgress) => {
            reportProgress?.({ phase: "started", tool: "gh", current: 1, total: 1 });
            reportProgress?.({
              phase: "completed",
              tool: "gh",
              current: 1,
              total: 1,
              stdout: "Warning: the GitHub apt repository has no gh 2.92.0. Ferry installs the latest gh.\n\nReading package lists...\n",
            });
            return { ok: true };
          },
        }),
        writeLine: (line) => {
          events.output.push(line);
          events.progress.push(`line:${line}`);
        },
      },
    );

    expect(output).toContain("  Warning: the GitHub apt repository has no gh 2.92.0. Ferry installs the latest gh.");
    expect(output).toContain("  Reading package lists...");
    expect(output).not.toContain("  ");
    const warning = progress.indexOf("line:  Warning: the GitHub apt repository has no gh 2.92.0. Ferry installs the latest gh.");
    expect(progress.slice(warning - 2, warning)).toEqual(["start:Installing gh (1/1)", "done"]);
  });

  test("prints the plan of the real install from the versions on this machine and on the box", async () => {
    const output: string[] = [];
    const PREFIX_END = 'cd "$HOME" || exit 1; ';
    const localVersions: Record<string, string> = { "gh --version": "gh version 2.92.0", "bun --version": "1.4.2" };
    const boxVersions: Record<string, string> = { "bun --version": "1.4.2" };
    const read = (script: string, versions: Record<string, string>) =>
      versions[script.slice(script.indexOf(PREFIX_END) + PREFIX_END.length)];
    const bun: ToolDescriptor = {
      id: "bun",
      kind: "tool",
      localVersion: "bun --version",
      boxVersion: "bun --version",
      recipe: { install: (version) => `install bun ${version}`, update: (version) => `install bun ${version}` },
    };

    await runInstallCommand(
      { yes: false },
      {
        ...installDependencies({ plan, output, confirm: async () => false }),
        tools: [BUILTIN_TOOLS[0]!, BUILTIN_TOOLS[1]!, bun],
        createLink: () => ({
          ...fakeLink(),
          run: async (command) => {
            const stdout = read(command, boxVersions);
            if (stdout === undefined) return { ok: false, error: { code: "command-failed", origin: "box", message: "missing" } };
            return { ok: true, address: "builder", stdout, stderr: "" };
          },
        }),
        createInstall: (link, tools, toolsConfig) =>
          new Install(link, tools, toolsConfig, {
            run: async (command) => {
              const stdout = read(command.argv.at(-1) ?? "", localVersions);
              return { exitCode: stdout === undefined ? 127 : 0, stdout: stdout ?? "", stderr: "", timedOut: false };
            },
          }),
      },
    );

    expect(output.map((line) => line.split("\n")[0])).toEqual([
      "gh: install 2.92.0 (policy operator): (type -p wget >/dev/null || (sudo apt update && sudo apt install wget -y)) \\",
      "claude: install latest (policy latest): curl -fsSL https://claude.ai/install.sh | bash",
      "bun: skipped, the box has 1.4.2 (policy operator)",
      "ferry: skipped, this Ferry is a development build without a release version (policy operator)",
      `git identity: ${identityCommand}`,
    ]);
  });

  test("skips an off tool: no version read and no install command", async () => {
    const output: string[] = [];
    const commands: string[] = [];

    await runInstallCommand(
      { yes: true },
      {
        ...installDependencies({ plan, output }),
        tools: [BUILTIN_TOOLS[0]!, BUILTIN_TOOLS[1]!],
        readConfig: () => ({ ...config, tools: { gh: "off", claude: "off" } }),
        createLink: () => ({
          ...fakeLink(),
          run: async (command) => {
            commands.push(command);
            return { ok: true, address: "builder", stdout: "", stderr: "" };
          },
        }),
        createInstall: (link, tools, toolsConfig) =>
          new Install(link, tools, toolsConfig, {
            run: async (command) => {
              commands.push(`local: ${command.argv.at(-1)}`);
              return { exitCode: 127, stdout: "", stderr: "", timedOut: false };
            },
          }),
      },
    );

    expect(output.slice(0, 2)).toEqual([
      "gh: skipped, Ferry does not manage it (policy off)",
      "claude: skipped, Ferry does not manage it (policy off)",
    ]);
    expect(commands.some((command) => /\bgh\b|claude/.test(command))).toBe(false);
  });

  test("stops before any box change when the plan is refused", async () => {
    const output: string[] = [];
    const linkRuns: string[] = [];
    let runs = 0;

    await expect(
      runInstallCommand(
        { yes: true },
        {
          ...installDependencies({ plan, output, linkRuns }),
          createInstall: () => ({
            plan: async () => {
              throw new ToolPlanError("pnpm depends on node, which is not on the operator machine.");
            },
            run: async () => {
              runs += 1;
              return { ok: true };
            },
          }),
        },
      ),
    ).rejects.toThrow(
      "operator/tool-plan: Install stopped before it changed the box. pnpm depends on node, which is not on the operator machine.",
    );
    expect(runs).toBe(0);
    expect(linkRuns).toEqual([]);
  });

  test("does not run when confirmation is false", async () => {
    let runs = 0;
    const linkRuns: string[] = [];

    await runInstallCommand(
      { yes: false },
      installDependencies({
        plan,
        confirm: async () => false,
        linkRuns,
        run: async () => {
          runs += 1;
          return { ok: true };
        },
      }),
    );

    expect(runs).toBe(0);
    expect(linkRuns).toEqual([]);
  });

  test("sets a missing box git identity after the tools install", async () => {
    const events: string[] = [];

    await runInstallCommand(
      { yes: true },
      installDependencies({
        plan,
        linkRuns: events,
        run: async () => {
          events.push("install.run");
          return { ok: true };
        },
      }),
    );

    expect(events).toEqual(["install.run", identityCommand]);
  });

  test("skips the box git identity when the operator has none", async () => {
    const output: string[] = [];
    const linkRuns: string[] = [];

    await runInstallCommand(
      { yes: true },
      installDependencies({
        plan,
        output,
        linkRuns,
        operatorIdentity: { name: "Operator", email: null },
      }),
    );

    expect(output).toContain(
      "git identity: skipped, the operator machine has no git user.name and user.email",
    );
    expect(linkRuns).toEqual([]);
  });

  test("fails safely when the box git identity cannot be set", async () => {
    const output: string[] = [];

    await expect(
      runInstallCommand(
        { yes: true },
        installDependencies({
          plan,
          output,
          linkResult: {
            ok: false,
            error: { code: "command-failed", origin: "box", message: "raw stderr" },
          },
        }),
      ),
    ).rejects.toThrow("Install stopped because Link reported command-failed from box.");
    expect(output.join("\n")).not.toContain("raw stderr");
  });

  test("--yes skips confirmation and runs once", async () => {
    let prompts = 0;
    let runs = 0;
    let confirmed: boolean | undefined;

    const result = await runInstallCommand(
      { yes: true },
      installDependencies({
        plan,
        confirm: async () => {
          prompts += 1;
          return false;
        },
        run: async (value) => {
          runs += 1;
          confirmed = value;
          return { ok: true };
        },
      }),
    );

    expect(prompts).toBe(0);
    expect(runs).toBe(1);
    expect(confirmed).toBe(true);
    expect(result?.plan.map((entry) => `${entry.tool} ${entry.action}`)).toEqual([
      "gh install",
      "codex install",
      "node skip-same",
      "bun skip-not-on-operator",
      "ferry skip-dev-build",
    ]);
    expect(result?.gitIdentity).not.toBeNull();
  });

  test("shows one progress step for each tool and for the box git identity", async () => {
    const progress: string[] = [];

    await runInstallCommand(
      { yes: true },
      installDependencies({
        plan,
        progress,
        run: async (_confirmed, _plan, reportProgress) => {
          reportProgress?.({ phase: "started", tool: "gh", current: 1, total: 2 });
          reportProgress?.({ phase: "completed", tool: "gh", current: 1, total: 2 });
          reportProgress?.({ phase: "started", tool: "codex", current: 2, total: 2 });
          reportProgress?.({ phase: "completed", tool: "codex", current: 2, total: 2 });
          return { ok: true };
        },
      }),
    );

    expect(progress).toEqual([
      "start:Checking the tool versions",
      "done",
      "start:Installing gh (1/2)",
      "done",
      "start:Installing codex (2/2)",
      "done",
      "start:Setting the box git identity",
      "done",
    ]);
  });

  test("fails safely when an installer fails", async () => {
    const output: string[] = [];
    const progress: string[] = [];

    await expect(
      runInstallCommand(
        { yes: true },
        installDependencies({
          plan,
          output,
          progress,
          run: async (_confirmed, _plan, reportProgress) => {
            reportProgress?.({ phase: "started", tool: "gh", current: 1, total: 2 });
            return {
              ok: false,
              error: {
                code: "command-failed",
                origin: "box",
                message: "raw remote stderr with token-secret",
              },
            };
          },
        }),
      ),
    ).rejects.toThrow("Install stopped because Link reported command-failed from box.");
    expect(progress).toEqual(["start:Checking the tool versions", "done", "start:Installing gh (1/2)", "fail"]);
    expect(output.join("\n")).toContain("box/command-failed");
    expect(output.join("\n")).not.toContain("token-secret");
  });

  test("prints the last lines of stderr and stdout of a failed installer, and puts them in the JSON error", async () => {
    const output: string[] = [];
    const stdout = Array.from({ length: 25 }, (_, index) => `step ${index + 1}`).join("\n");

    const error = await runInstallCommand(
      { yes: true },
      installDependencies({
        plan,
        output,
        run: async (_confirmed, _plan, reportProgress) => {
          reportProgress?.({ phase: "started", tool: "codex", current: 2, total: 2 });
          return {
            ok: false,
            error: {
              code: "command-failed",
              origin: "box",
              message: "error: unzip is required",
              output: { stdout, stderr: "\nerror: unzip is required to install bun\n" },
            },
          };
        },
      }),
    ).catch((caught: unknown) => caught);

    const stdoutTail = Array.from({ length: 20 }, (_, index) => `step ${index + 6}`);
    expect(output.slice(output.findIndex((line) => line.startsWith("git identity: ")) + 1)).toEqual([
      "The last lines of the codex install stderr:",
      "  error: unzip is required to install bun",
      "The last lines of the codex install stdout:",
      ...stdoutTail.map((line) => `  ${line}`),
      "box/command-failed: Install stopped because Link reported command-failed from box.",
    ]);
    expect(errorInfo(error)).toEqual({
      code: "box-command-failed",
      message: "box/command-failed: Install stopped because Link reported command-failed from box.",
      hint: null,
      details: { tool: "codex", stderr: ["error: unzip is required to install bun"], stdout: stdoutTail },
    });
  });
});

describe("auth command", () => {
  test("lists the exported startable providers and Pi as manual", async () => {
    const output: string[] = [];
    let links = 0;

    const result = await runAuthCommand(
      {},
      authDependencies({
        output,
        createLink: () => {
          links += 1;
          return fakeLink();
        },
      }),
    );

    expect(output).toEqual([
      "gh: startable",
      "claude: startable",
      "codex: startable",
      "cursor: startable",
      "pi: manual SSH flow",
    ]);
    expect(links).toBe(0);
    expect(result).toEqual({
      providers: [
        { id: "gh", login: "startable" },
        { id: "claude", login: "startable" },
        { id: "codex", login: "startable" },
        { id: "cursor", login: "startable" },
        { id: "pi", login: "manual" },
      ],
    });
  });

  test("lists the tools with the policy off as off", async () => {
    const output: string[] = [];

    const result = await runAuthCommand(
      {},
      authDependencies({ output, readConfig: () => ({ ...config, tools: { cursor: "off", pi: "off" } }) }),
    );

    expect(output).toEqual(["gh: startable", "claude: startable", "codex: startable", "cursor: off", "pi: off"]);
    expect(result).toEqual({
      providers: [
        { id: "gh", login: "startable" },
        { id: "claude", login: "startable" },
        { id: "codex", login: "startable" },
        { id: "cursor", login: "off" },
        { id: "pi", login: "off" },
      ],
    });
  });

  test("constructs Link from config and calls start once", async () => {
    const link = fakeLink();
    let linkOptions: unknown;
    let authLink: unknown;
    const providers: string[] = [];

    await runAuthCommand(
      { provider: "gh" },
      authDependencies({
        createLink: (options) => {
          linkOptions = options;
          return link;
        },
        createAuthStart: (receivedLink) => {
          authLink = receivedLink;
          return {
            ...noMcp,
            start: async (provider: string) => {
              providers.push(provider);
              return { kind: "already-done", provider: "gh" };
            },
          };
        },
      }),
    );

    expect(linkOptions).toEqual({ host: config.host.tailscale, user: config.host.sshUser });
    expect(authLink).toBe(link);
    expect(providers).toEqual(["gh"]);
  });

  test("shows the login start as a step and ends it before the result prints", async () => {
    const events: string[] = [];
    const progress = recordProgress();

    await runAuthCommand(
      { provider: "cursor" },
      authDependencies({
        output: events,
        progress: { ...progress, done: () => events.push("done") },
        createAuthStart: () => ({
          ...noMcp,
          start: async () => ({ kind: "printed-url", provider: "cursor", url: "https://cursor.com/login" }),
          finish: async () => ({ kind: "logged-in", provider: "cursor" }),
        }),
      }),
    );

    expect(progress.events).toEqual([
      "start:Starting the cursor login on the box",
      "start:Waiting for you to finish the login in the browser (up to 15 min)",
    ]);
    expect(events).toEqual([
      "done",
      "URL: https://cursor.com/login",
      "Open the URL in a browser on this machine.",
      "done",
      "cursor: logged in",
    ]);
  });

  test("holds the Codex callback forward in the wait step and gives it the Ctrl-C signal", async () => {
    const output: string[] = [];
    const progress = recordProgress();
    let interrupt = () => {};
    const started = {
      kind: "local-port-forward",
      provider: "codex",
      url: "https://auth.openai.com/oauth/authorize?state=opaque",
      localPort: 1455,
      remotePort: 1455,
      timeoutMs: 120_000,
    } as const;

    await runAuthCommand(
      { provider: "codex" },
      authDependencies({
        output,
        progress,
        onInterrupt: (stop) => {
          interrupt = stop;
          return () => {};
        },
        createAuthStart: () => ({
          ...noMcp,
          start: async () => started,
          finish: async (_result, code, signal) => {
            interrupt();
            output.push(`finish ${code} ${signal?.aborted}`);
            return { kind: "logged-in", provider: "codex" };
          },
        }),
      }),
    );

    expect(progress.events).toEqual([
      "start:Starting the codex login on the box",
      "done",
      "start:Waiting for you to finish the login in the browser (up to 2 min)",
      "done",
    ]);
    expect(output).toEqual([
      `URL: ${started.url}`,
      "Open the URL in a browser on this machine.",
      "Ferry forwards local port 1455 to the box for up to 120 s and closes it when the login is done. Press Ctrl-C to stop early.",
      "finish undefined true",
      "codex: logged in",
    ]);
  });

  test("prints the device code, then waits for the login and reports the setup steps", async () => {
    const output: string[] = [];
    const progress = recordProgress();
    const started: AuthStartResult = {
      kind: "device-url",
      provider: "gh",
      url: "https://github.com/login/device",
      userCode: "A1B2-C3D4",
    };

    await runAuthCommand(
      { provider: "gh" },
      authDependencies({
        output,
        progress,
        createAuthStart: () => ({
          ...noMcp,
          start: async () => started,
          finish: async (result, code) => {
            output.push(`finish ${result === started} ${code}`);
            return { kind: "logged-in", provider: "gh", notes: ["SSH key: added to GitHub as box1 (ferry)"] };
          },
        }),
      }),
    );

    expect(output).toEqual([
      "URL: https://github.com/login/device",
      "Code: A1B2-C3D4",
      "Open the URL in a browser on this machine and enter the code.",
      "finish true undefined",
      "gh: logged in",
      "SSH key: added to GitHub as box1 (ferry)",
    ]);
    expect(progress.events).toEqual([
      "start:Starting the gh login on the box",
      "done",
      "start:Waiting for you to finish the login in the browser (up to 15 min)",
      "done",
    ]);
  });

  test("with --json, prints the login event with the URL and the device code, and returns the login result", async () => {
    const events: unknown[] = [];
    const result = await runAuthCommand(
      { provider: "gh" },
      authDependencies({
        output: [],
        emit: (event) => events.push(event),
        createAuthStart: () => ({
          ...noMcp,
          start: async () => ({ kind: "device-url", provider: "gh", url: "https://github.com/login/device", userCode: "A1B2-C3D4" }),
          finish: async () => ({ kind: "logged-in", provider: "gh" }),
        }),
      }),
    );

    expect(events).toEqual([
      {
        type: "login",
        provider: "gh",
        url: "https://github.com/login/device",
        userCode: "A1B2-C3D4",
        codeRequired: false,
        localPort: null,
        timeoutMs: null,
      },
    ]);
    expect(result).toEqual({ kind: "logged-in", provider: "gh" });
  });

  test("the login event says when the login waits for the code from the browser", async () => {
    const events: OutputEvent[] = [];
    await runAuthCommand(
      { provider: "claude" },
      authDependencies({
        output: [],
        emit: (event) => events.push(event),
        readLoginCode: async () => "code",
        createAuthStart: () => ({
          ...noMcp,
          start: async () => ({ kind: "printed-url", provider: "claude", url: "https://claude.com/x", codeInput: "/tmp/in" }),
          finish: async () => ({ kind: "logged-in", provider: "claude" }),
        }),
      }),
    );

    expect(events.map((event) => event.codeRequired)).toEqual([true]);
  });

  test("runs the setup of an already authenticated tool as its own step", async () => {
    const output: string[] = [];
    const progress = recordProgress();

    await runAuthCommand(
      { provider: "gh" },
      authDependencies({
        output,
        progress,
        createAuthStart: () => ({
          ...noMcp,
          start: async () => ({ kind: "already-done", provider: "gh" }),
          finish: async () => ({ kind: "already-done", provider: "gh", notes: ["SSH key: already on GitHub"] }),
        }),
      }),
    );

    expect(output).toEqual(["gh: already authenticated", "SSH key: already on GitHub"]);
    expect(progress.events).toEqual([
      "start:Starting the gh login on the box",
      "done",
      "start:Checking the gh setup on the box",
      "done",
    ]);
  });

  test("asks for the code that the browser shows between steps and gives it to the login", async () => {
    const output: string[] = [];
    const progress = recordProgress();
    const started: AuthStartResult = {
      kind: "printed-url",
      provider: "claude",
      url: "https://claude.com/cai/oauth/authorize?state=s",
      codeInput: "/tmp/ferry-login.abc/in",
    };

    await runAuthCommand(
      { provider: "claude" },
      authDependencies({
        output,
        progress,
        readLoginCode: async () => {
          output.push(`prompt after ${progress.events.join(",")}`);
          return " code#state \n";
        },
        createAuthStart: () => ({
          ...noMcp,
          start: async () => started,
          finish: async (_result, code) => {
            output.push(`finish ${code}`);
            return { kind: "logged-in", provider: "claude" };
          },
        }),
      }),
    );

    expect(output).toEqual([
      "URL: https://claude.com/cai/oauth/authorize?state=s",
      "Open the URL in a browser on this machine. After the login, paste the code that the browser shows.",
      "prompt after start:Starting the claude login on the box,done,pause",
      "finish code#state",
      "claude: logged in",
    ]);
  });

  test("stops without waiting when the operator cancels the code prompt", async () => {
    let finished = false;

    await runAuthCommand(
      { provider: "claude" },
      authDependencies({
        readLoginCode: async () => Symbol("cancel"),
        createAuthStart: () => ({
          ...noMcp,
          start: async () => ({ kind: "printed-url", provider: "claude", url: "https://claude.com/x", codeInput: "/tmp/f/in" }),
          finish: async (result) => {
            finished = true;
            return result;
          },
        }),
      }),
    );

    expect(finished).toBe(false);
  });

  test("marks the wait failed when the operator did not finish the login", async () => {
    const progress = recordProgress();

    await expect(
      runAuthCommand(
        { provider: "gh" },
        authDependencies({
          progress,
          createAuthStart: () => ({
            ...noMcp,
            start: async () => ({ kind: "device-url", provider: "gh", url: "https://github.com/login/device", userCode: "A1B2-C3D4" }),
            finish: async () => ({
              kind: "failed",
              provider: "gh",
              code: "login-unfinished",
              message: "The gh login did not finish in 900 s. Ferry did not run the setup steps.",
            }),
          }),
        }),
      ),
    ).rejects.toThrow("box/login-unfinished");
    expect(progress.events.slice(-2)).toEqual([
      "start:Waiting for you to finish the login in the browser (up to 15 min)",
      "fail",
    ]);
  });

  test("marks the login step failed when the box reports a failure", async () => {
    const progress = recordProgress();

    await expect(
      runAuthCommand(
        { provider: "gh" },
        authDependencies({
          progress,
          result: { kind: "failed", provider: "gh", code: "login-output", message: "no URL" },
        }),
      ),
    ).rejects.toThrow("box/login-output");
    expect(progress.events).toEqual(["start:Starting the gh login on the box", "fail"]);
  });

  test("constructs Link from a direct SSH destination", async () => {
    let linkOptions: unknown;

    await runAuthCommand(
      { provider: "gh" },
      authDependencies({
        readConfig: () => ({
          ...config,
          host: { transport: "ssh", destination: "user@box.example" },
        }),
        createLink: (options) => {
          linkOptions = options;
          return fakeLink();
        },
      }),
    );

    expect(linkOptions).toEqual({ destination: "user@box.example" });
  });

  const renderCases: readonly {
    readonly name: string;
    readonly provider: string;
    readonly result: AuthStartResult;
    readonly expected: readonly string[];
  }[] = [
    {
      name: "already authenticated",
      provider: "gh",
      result: { kind: "already-done", provider: "gh" },
      expected: ["gh: already authenticated"],
    },
    {
      name: "device URL and code",
      provider: "gh",
      result: {
        kind: "device-url",
        provider: "gh",
        url: "https://github.com/login/device",
        userCode: "ABCD-EFGH",
      },
      expected: ["URL: https://github.com/login/device", "Code: ABCD-EFGH"],
    },
    {
      name: "printed URL",
      provider: "claude",
      result: { kind: "printed-url", provider: "claude", url: "https://claude.ai/login" },
      expected: ["URL: https://claude.ai/login"],
    },
    {
      name: "local port forward",
      provider: "codex",
      result: {
        kind: "local-port-forward",
        provider: "codex",
        url: "https://auth.openai.com/codex",
        localPort: 1455,
        remotePort: 1455,
        timeoutMs: 120_000,
      },
      expected: ["URL: https://auth.openai.com/codex", "Local port: 1455", "Timeout: 120000 ms"],
    },
    {
      name: "Pi manual SSH instruction",
      provider: "pi",
      result: {
        kind: "manual-ssh",
        provider: "pi",
        command: "pi",
        instruction: "SSH to the box and run pi.",
      },
      expected: ["pi: manual SSH flow", "SSH to the box and run pi."],
    },
    {
      name: "structured Link failure",
      provider: "cursor",
      result: {
        kind: "link-failure",
        provider: "cursor",
        result: {
          ok: false,
          error: { code: "command-failed", origin: "box", message: "raw token-secret" },
        },
      },
      expected: ["box/command-failed", "AuthStart stopped because Link reported command-failed from box."],
    },
    {
      name: "safe login output failure",
      provider: "cursor",
      result: {
        kind: "failed",
        provider: "cursor",
        code: "login-output",
        message: "The cursor login did not return a safe operator URL.",
      },
      expected: ["box/login-output", "The cursor login did not return a safe operator URL."],
    },
  ];

  for (const renderCase of renderCases) {
    test(`renders ${renderCase.name} without raw output`, async () => {
      const output: string[] = [];
      const promise = runAuthCommand(
        { provider: renderCase.provider },
        authDependencies({ output, result: renderCase.result }),
      );

      if (renderCase.result.kind === "link-failure" || renderCase.result.kind === "failed") {
        await expect(promise).rejects.toThrow();
      } else {
        await promise;
      }

      for (const expected of renderCase.expected) expect(output.join("\n")).toContain(expected);
      expect(output.join("\n")).not.toContain("token-secret");
    });
  }

  for (const input of [{ provider: "codex" }, { provider: "claude", mcp: "linear" }]) {
    test(`refuses ${input.provider}${input.mcp ? " --mcp" : ""} when the tool is off, before Link or AuthStart, with the code refused`, async () => {
      let links = 0;
      const output: string[] = [];

      const error = await runAuthCommand(
        input,
        authDependencies({
          output,
          readConfig: () => ({ ...config, tools: { [input.provider]: "off" } }),
          createLink: () => {
            links += 1;
            return fakeLink();
          },
          createAuthStart: () => {
            throw new Error("unexpected AuthStart");
          },
        }),
      ).catch((caught: unknown) => caught);

      expect(error).toBeInstanceOf(Error);
      expect((error as Error).message).toBe(
        `operator/tool-off: The ${input.provider} tool is off for this box, so Ferry does not log it in. Set another policy for ${input.provider} in [tools] or [box.<name>.tools] to turn it on.`,
      );
      expect(errorInfo(error).code).toBe("refused");
      expect(links).toBe(0);
      expect(output).toEqual([(error as Error).message]);
    });
  }

  test("refuses an unknown provider before config, Link, or AuthStart", async () => {
    let configReads = 0;
    let links = 0;
    let authStarts = 0;
    const output: string[] = [];

    await expect(
      runAuthCommand(
        { provider: "unknown" },
        authDependencies({
          output,
          readConfig: () => {
            configReads += 1;
            return config;
          },
          createLink: () => {
            links += 1;
            return fakeLink();
          },
          createAuthStart: () => {
            authStarts += 1;
            return { ...noMcp, start: async () => ({ kind: "already-done", provider: "gh" }) };
          },
        }),
      ),
    ).rejects.toThrow("Unknown auth provider");

    expect(configReads).toBe(0);
    expect(links).toBe(0);
    expect(authStarts).toBe(0);
    expect(output.join("\n")).toContain("operator/invalid-provider");
  });
});

const identityCommand =
  "{ git config --global --get user.name >/dev/null || git config --global user.name 'Operator O'\"'\"'Neil'; } && " +
  "{ git config --global --get user.email >/dev/null || git config --global user.email 'operator@example.com'; }";

function installDependencies(overrides: {
  readonly plan: readonly ToolStep[];
  readonly output?: string[];
  readonly linkRuns?: string[];
  readonly linkResult?: LinkResult;
  readonly operatorIdentity?: GitIdentity;
  readonly progress?: string[];
  readonly confirm?: () => Promise<boolean | symbol | undefined>;
  readonly run?: (
    confirmed: boolean,
    plan: readonly ToolStep[],
    reportProgress?: (progress: InstallProgress) => void,
  ) => Promise<InstallResult>;
}): InstallCommandDependencies {
  return {
    ferryVersion: "0.0.0-dev",
    tools: BUILTIN_TOOLS,
    readConfig: () => config,
    createLink: () => ({
      ...fakeLink(),
      run: async (command) => {
        overrides.linkRuns?.push(command);
        return overrides.linkResult ?? { ok: true, address: "builder", stdout: "", stderr: "" };
      },
    }),
    readOperatorGitIdentity: async () =>
      overrides.operatorIdentity ?? { name: "Operator O'Neil", email: "operator@example.com" },
    createInstall: () => ({
      plan: async () => overrides.plan,
      run: overrides.run ?? (async () => ({ ok: true })),
    }),
    progress: {
      ...noProgress,
      start: (step) => overrides.progress?.push(`start:${step}`),
      count: (current, total) => overrides.progress?.push(`count:${current}/${total}`),
      done: () => overrides.progress?.push("done"),
      fail: () => overrides.progress?.push("fail"),
    },
    confirm: overrides.confirm ?? (async () => true),
    writeLine: (line) => overrides.output?.push(line),
  };
}

function authDependencies(overrides: {
  readonly output?: string[];
  readonly result?: AuthStartResult;
  readonly readConfig?: AuthCommandDependencies["readConfig"];
  readonly createLink?: AuthCommandDependencies["createLink"];
  readonly createAuthStart?: AuthCommandDependencies["createAuthStart"];
  readonly progress?: AuthCommandDependencies["progress"];
  readonly readLoginCode?: AuthCommandDependencies["readLoginCode"];
  readonly onInterrupt?: AuthCommandDependencies["onInterrupt"];
  readonly emit?: AuthCommandDependencies["emit"];
} = {}): AuthCommandDependencies {
  return {
    tools: BUILTIN_TOOLS,
    readConfig: overrides.readConfig ?? (() => config),
    createLink: overrides.createLink ?? fakeLink,
    createAuthStart: overrides.createAuthStart ?? (() => ({
      ...noMcp,
      start: async () => overrides.result ?? ({ kind: "already-done", provider: "gh" }),
    })),
    readLoginCode: overrides.readLoginCode ?? (async () => {
      throw new Error("unexpected code prompt");
    }),
    writeLine: (line) => overrides.output?.push(line),
    progress: overrides.progress ?? recordProgress(),
    onInterrupt: overrides.onInterrupt ?? (() => () => {}),
    ...(overrides.emit ? { emit: overrides.emit } : {}),
  };
}

const noMcp = {
  startMcp: async (): Promise<AuthStartResult> => {
    throw new Error("unexpected MCP login");
  },
  finishMcp: async (): Promise<AuthStartResult> => {
    throw new Error("unexpected MCP login");
  },
  finish: async (started: AuthStartResult): Promise<AuthStartResult> => started,
};

function fakeLink(): AuthLink {
  const success = { ok: true as const, address: "builder.tailnet.ts.net", stdout: "", stderr: "" };
  return {
    run: async () => success,
    forward: async () => success,
  };
}

describe("runAuthCommand with --mcp", () => {
  const started = {
    kind: "local-port-forward",
    provider: "claude/linear",
    url: "https://auth.example/authorize?redirect_uri=http%3A%2F%2Flocalhost%3A3118%2Fcallback",
    localPort: 3118,
    remotePort: 3118,
    timeoutMs: 300_000,
  } as const;

  test("prints the URL before the forward, then waits for the login as a step", async () => {
    const output: string[] = [];
    const calls: string[] = [];
    const progress = recordProgress();

    await runAuthCommand(
      { provider: "claude", mcp: "linear" },
      authDependencies({
        output,
        progress,
        createAuthStart: () => ({
          start: noMcp.startMcp,
          finish: noMcp.finish,
          startMcp: async (tool: string, server: string) => {
            calls.push(`start ${tool} ${server}`);
            return started;
          },
          finishMcp: async (result) => {
            calls.push(`finish ${output.length} lines printed`);
            expect(result).toBe(started);
            return { kind: "logged-in", provider: "claude/linear" };
          },
        }),
      }),
    );

    expect(calls).toEqual(["start claude linear", "finish 3 lines printed"]);
    expect(progress.events).toEqual([
      "start:Starting the claude/linear MCP login on the box",
      "done",
      "start:Waiting for you to finish the login in the browser (up to 5 min)",
      "done",
    ]);
    expect(output).toEqual([
      `URL: ${started.url}`,
      "Open the URL in a browser on this machine.",
      "Ferry forwards local port 3118 to the box for up to 300 s and closes it when the login is done. Press Ctrl-C to stop early.",
      "claude/linear: logged in",
    ]);
  });

  test("Ctrl-C during the wait aborts the signal of the forward, and the handler ends after the wait", async () => {
    const events: string[] = [];
    let interrupt = () => {};

    await runAuthCommand(
      { provider: "claude", mcp: "linear" },
      authDependencies({
        onInterrupt: (stop) => {
          events.push("listen");
          interrupt = stop;
          return () => events.push("unlisten");
        },
        createAuthStart: () => ({
          ...noMcp,
          start: noMcp.startMcp,
          startMcp: async () => started,
          finishMcp: async (_result, signal) => {
            events.push(`aborted ${signal?.aborted}`);
            interrupt();
            events.push(`aborted ${signal?.aborted}`);
            return { kind: "logged-in", provider: "claude/linear" };
          },
        }),
      }),
    );

    expect(events).toEqual(["listen", "aborted false", "aborted true", "unlisten"]);
  });

  test("--mcp without a provider is a usage error that names both forms", async () => {
    const output: string[] = [];

    const error = await runAuthCommand(
      { mcp: "linear" },
      authDependencies({
        output,
        createAuthStart: () => {
          throw new Error("unexpected AuthStart");
        },
      }),
    ).catch((caught: unknown) => caught);

    const message =
      "operator/usage: Give the provider: ferry auth <provider> --mcp linear, or ferry auth --mcp <provider>/linear. " +
      "The providers with an MCP login are claude, codex, cursor.";
    expect((error as Error).message).toBe(message);
    expect(errorInfo(error).code).toBe("usage");
    expect(output).toEqual([message]);
  });

  for (const input of [{ mcp: "codex/linear" }, { provider: "codex", mcp: "codex/linear" }]) {
    test(`accepts the ferry status name ${input.provider ? "with" : "without"} the provider argument`, async () => {
      const calls: string[] = [];

      await runAuthCommand(
        input,
        authDependencies({
          createAuthStart: () => ({
            ...noMcp,
            start: noMcp.startMcp,
            startMcp: async (tool: string, server: string) => {
              calls.push(`${tool} ${server}`);
              return { kind: "already-done", provider: `${tool}/${server}` };
            },
          }),
        }),
      );

      expect(calls).toEqual(["codex linear"]);
    });
  }

  test("accepts a claude plugin server name from ferry status", async () => {
    const calls: string[] = [];

    await runAuthCommand(
      { mcp: "claude/plugin:figma:figma" },
      authDependencies({
        createAuthStart: () => ({
          ...noMcp,
          start: noMcp.startMcp,
          startMcp: async (tool: string, server: string) => {
            calls.push(`${tool} ${server}`);
            return { kind: "already-done", provider: `${tool}/${server}` };
          },
        }),
      }),
    );

    expect(calls).toEqual(["claude plugin:figma:figma"]);
  });

  test("refuses a tool without an MCP login before it reads the config", async () => {
    const output: string[] = [];

    await expect(
      runAuthCommand(
        { provider: "gh", mcp: "linear" },
        authDependencies({
          output,
          readConfig: () => {
            throw new Error("config read");
          },
        }),
      ),
    ).rejects.toThrow("operator/invalid-provider");
  });

  test("prints a refused server name and forwards nothing", async () => {
    const output: string[] = [];

    await expect(
      runAuthCommand(
        { provider: "claude", mcp: "x;y" },
        authDependencies({
          output,
          createAuthStart: () => ({
            ...noMcp,
            start: noMcp.startMcp,
            startMcp: async () => ({ kind: "refused", code: "invalid-server", message: "bad name" }),
          }),
        }),
      ),
    ).rejects.toThrow("operator/invalid-server: bad name");
  });
});
