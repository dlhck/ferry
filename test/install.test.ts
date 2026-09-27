import { describe, expect, test } from "bun:test";
import { Install, type InstallProgress } from "../src/install.ts";
import type { HostAdapter, HostCommand, HostCommandResult, LinkResult, RunOptions } from "../src/link.ts";
import { BUILTIN_TOOLS } from "../src/registry/builtin.ts";
import { loadRegistry } from "../src/registry/load.ts";
import type { ToolDescriptor } from "../src/registry/types.ts";

const PREFIX_END = 'cd "$HOME" || exit 1; ';

const GH_INSTALL =
  "(type -p wget >/dev/null || (sudo apt update && sudo apt install wget -y)) \\\n" +
  "&& sudo mkdir -p -m 755 /etc/apt/keyrings \\\n" +
  "&& out=$(mktemp) && wget -nv -O$out https://cli.github.com/packages/githubcli-archive-keyring.gpg \\\n" +
  "&& cat $out | sudo tee /etc/apt/keyrings/githubcli-archive-keyring.gpg > /dev/null \\\n" +
  "&& sudo chmod go+r /etc/apt/keyrings/githubcli-archive-keyring.gpg \\\n" +
  "&& sudo mkdir -p -m 755 /etc/apt/sources.list.d \\\n" +
  '&& echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" | sudo tee /etc/apt/sources.list.d/github-cli.list > /dev/null \\\n' +
  "&& sudo apt update \\\n" +
  "&& sudo apt install gh -y";

const AGENT_INSTALLS = {
  claude: "curl -fsSL https://claude.ai/install.sh | bash",
  codex: "curl -fsSL https://chatgpt.com/codex/install.sh | sh",
  pi:
    "(command -v node >/dev/null \\\n" +
    "&& node -e 'const [major, minor] = process.versions.node.split(\".\").map(Number); process.exit(major > 22 || (major === 22 && minor >= 19) ? 0 : 1)' >/dev/null \\\n" +
    "&& command -v npm >/dev/null \\\n" +
    "|| (sudo apt update && sudo apt install nodejs npm -y)) \\\n" +
    "&& curl -fsSL https://pi.dev/install.sh | sh",
  cursor: "curl https://cursor.com/install -fsS | bash",
} as const;

/** The operator machine. Each key is a version command, each value its output. Other commands fail. */
function fakeLocal(outputs: Readonly<Record<string, string>> = {}): HostAdapter {
  return {
    run: async (command: HostCommand): Promise<HostCommandResult> => {
      const script = command.argv.at(-1) ?? "";
      const stdout = outputs[script.slice(script.indexOf(PREFIX_END) + PREFIX_END.length)];
      if (stdout === undefined) return { exitCode: 127, stdout: "", stderr: "not found", timedOut: false };
      return { exitCode: 0, stdout, stderr: "", timedOut: false };
    },
  };
}

/**
 * The box. A version read answers from `versions`, and fails for a missing
 * tool. Each other command is recorded and answers with the next result.
 */
class FakeBox {
  readonly commands: string[] = [];
  readonly timeouts: (number | undefined)[] = [];

  constructor(
    private readonly versions: Readonly<Record<string, string>> = {},
    private readonly results: LinkResult[] = [],
  ) {}

  async run(command: string, options: RunOptions = {}): Promise<LinkResult> {
    if (command.includes(PREFIX_END)) {
      const stdout = this.versions[command.slice(command.indexOf(PREFIX_END) + PREFIX_END.length)];
      if (stdout === undefined) return { ok: false, error: { code: "command-failed", origin: "box", message: "missing" } };
      return success(stdout);
    }
    this.commands.push(command);
    this.timeouts.push(options.timeoutMs);
    return this.results.shift() ?? success("");
  }
}

function success(stdout: string): LinkResult {
  return { ok: true, address: "build-box", stdout, stderr: "" };
}

function registry(tools: NonNullable<Parameters<typeof loadRegistry>[0]>["tools"]): readonly ToolDescriptor[] {
  const result = loadRegistry({ tools });
  if (!result.ok) throw new Error(result.problems.map((problem) => problem.reason).join("; "));
  return result.tools;
}

const NODE = {
  local: "node --version",
  box: "node --version",
  install: "nvm install {version}",
};
const PNPM = {
  local: "pnpm --version",
  box: "pnpm --version",
  install: "npm install -g pnpm@{version}",
  depends: ["node"],
};

describe("Install plan", () => {
  test("installs gh at the operator version with its recipe and the agent CLIs at latest", async () => {
    const install = new Install(new FakeBox(), BUILTIN_TOOLS, undefined, fakeLocal({ "gh --version": "gh version 2.92.0" }));

    const plan = await install.plan();

    expect(plan.map(({ tool, policy, version, action, command }) => ({ tool, policy, version, action, command }))).toEqual([
      { tool: "gh", policy: "operator", version: "2.92.0", action: "install", command: GH_INSTALL },
      ...Object.entries(AGENT_INSTALLS).map(([tool, command]) => ({
        tool,
        policy: "latest",
        version: null,
        action: "install" as const,
        command,
      })),
    ]);
  });

  test("skips gh when the operator machine does not have it", async () => {
    const install = new Install(new FakeBox(), BUILTIN_TOOLS, undefined, fakeLocal());

    const plan = await install.plan();

    expect(plan[0]).toEqual({ tool: "gh", policy: "operator", version: null, action: "skip-not-on-operator", dependsOn: [] });
  });

  test("plans the config tools after their dependencies and skips a tool that the box has at the same version", async () => {
    const tools = registry({ pnpm: PNPM, node: NODE });
    const install = new Install(
      new FakeBox({ "node --version": "v24.16.0\n" }),
      tools.filter((tool) => tool.kind === "tool" && tool.id !== "gh"),
      { pnpm: PNPM, node: NODE },
      fakeLocal({ "node --version": "v24.16.0", "pnpm --version": "11.17.0" }),
    );

    const plan = await install.plan();

    expect(plan.map(({ tool, action, command }) => [tool, action, command])).toEqual([
      ["node", "skip-same", undefined],
      ["pnpm", "install", "npm install -g pnpm@'11.17.0'"],
    ]);
  });
});

describe("Install run", () => {
  const tools = registry({ node: NODE, pnpm: PNPM }).filter((tool) => ["node", "pnpm"].includes(tool.id));
  const local = fakeLocal({ "node --version": "v24.16.0", "pnpm --version": "11.17.0" });

  test("refuses without explicit confirmation and does not call Link", async () => {
    const box = new FakeBox();
    const install = new Install(box, tools, undefined, local);

    const outcome = await install.run(false, await install.plan());

    expect(outcome).toEqual({
      ok: false,
      error: {
        code: "confirmation-required",
        origin: "operator",
        message: "installation requires explicit confirmation",
      },
    });
    expect(box.commands).toEqual([]);
  });

  test("a confirmed run executes each planned command in depends order, with thirty minutes for each", async () => {
    const box = new FakeBox();
    const install = new Install(box, tools, undefined, local);

    const outcome = await install.run(true, await install.plan());

    expect(outcome).toEqual({ ok: true });
    expect(box.commands).toEqual(["nvm install '24.16.0'", "npm install -g pnpm@'11.17.0'"]);
    expect(box.timeouts).toEqual([30 * 60 * 1_000, 30 * 60 * 1_000]);
  });

  test("runs no command for a skipped tool", async () => {
    const box = new FakeBox({ "node --version": "v24.16.0" });
    const install = new Install(box, tools, undefined, local);

    await install.run(true, await install.plan());

    expect(box.commands).toEqual(["npm install -g pnpm@'11.17.0'"]);
  });

  test("reports progress before and after each installer", async () => {
    const install = new Install(new FakeBox(), tools, undefined, local);
    const progress: InstallProgress[] = [];

    const outcome = await install.run(true, await install.plan(), (update) => progress.push(update));

    expect(outcome).toEqual({ ok: true });
    expect(progress).toEqual([
      { phase: "started", tool: "node", current: 1, total: 2 },
      { phase: "completed", tool: "node", current: 1, total: 2, stdout: "" },
      { phase: "started", tool: "pnpm", current: 2, total: 2 },
      { phase: "completed", tool: "pnpm", current: 2, total: 2, stdout: "" },
    ]);
  });

  test("reports the standard output of each installer", async () => {
    const box = new FakeBox({}, [success("Warning: gh 2.92.0 is not in the apt repository. Installing the latest version.\n"), success("")]);
    const install = new Install(box, tools, undefined, local);
    const progress: InstallProgress[] = [];

    await install.run(true, await install.plan(), (update) => progress.push(update));

    expect(progress[1]?.stdout).toBe("Warning: gh 2.92.0 is not in the apt repository. Installing the latest version.\n");
  });

  test("a failed dependency stops the install before the tools that depend on it", async () => {
    const failure: LinkResult = {
      ok: false,
      error: { code: "command-failed", origin: "box", message: "installer failed" },
    };
    const box = new FakeBox({}, [failure]);
    const install = new Install(box, tools, undefined, local);

    const outcome = await install.run(true, await install.plan());

    expect(outcome).toBe(failure);
    expect(box.commands).toEqual(["nvm install '24.16.0'"]);
  });
});
