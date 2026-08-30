import { describe, expect, test } from "bun:test";
import { Install, type InstallProgress } from "../src/install.ts";
import type { LinkResult, RunOptions } from "../src/link.ts";
import { BUILTIN_TOOLS } from "../src/registry/builtin.ts";

const expectedPlan = [
  {
    tool: "gh",
    command:
      "(type -p wget >/dev/null || (sudo apt update && sudo apt install wget -y)) \\\n" +
      "&& sudo mkdir -p -m 755 /etc/apt/keyrings \\\n" +
      "&& out=$(mktemp) && wget -nv -O$out https://cli.github.com/packages/githubcli-archive-keyring.gpg \\\n" +
      "&& cat $out | sudo tee /etc/apt/keyrings/githubcli-archive-keyring.gpg > /dev/null \\\n" +
      "&& sudo chmod go+r /etc/apt/keyrings/githubcli-archive-keyring.gpg \\\n" +
      "&& sudo mkdir -p -m 755 /etc/apt/sources.list.d \\\n" +
      '&& echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" | sudo tee /etc/apt/sources.list.d/github-cli.list > /dev/null \\\n' +
      "&& sudo apt update \\\n" +
      "&& sudo apt install gh -y",
  },
  { tool: "claude", command: "curl -fsSL https://claude.ai/install.sh | bash" },
  { tool: "codex", command: "curl -fsSL https://chatgpt.com/codex/install.sh | sh" },
  {
    tool: "pi",
    command:
      "(command -v node >/dev/null \\\n" +
      "&& node -e 'const [major, minor] = process.versions.node.split(\".\").map(Number); process.exit(major > 22 || (major === 22 && minor >= 19) ? 0 : 1)' >/dev/null \\\n" +
      "&& command -v npm >/dev/null \\\n" +
      "|| (sudo apt update && sudo apt install nodejs npm -y)) \\\n" +
      "&& curl -fsSL https://pi.dev/install.sh | sh",
  },
  { tool: "cursor", command: "curl https://cursor.com/install -fsS | bash" },
] as const;

class FakeLink {
  readonly commands: string[] = [];

  constructor(private readonly results: LinkResult[]) {}

  async run(command: string): Promise<LinkResult> {
    this.commands.push(command);
    const result = this.results.shift();
    if (!result) throw new Error(`unexpected command: ${command}`);
    return result;
  }
}

const success: LinkResult = { ok: true, address: "build-box", stdout: "", stderr: "" };

describe("Install", () => {
  test("plan contains only the five current official install commands", () => {
    const install = new Install(new FakeLink([]), BUILTIN_TOOLS);

    expect(install.plan()).toEqual(expectedPlan);
  });

  test("run refuses without explicit confirmation and does not call Link", async () => {
    const link = new FakeLink([]);
    const install = new Install(link, BUILTIN_TOOLS);

    const outcome = await install.run(false);

    expect(outcome).toEqual({
      ok: false,
      error: {
        code: "confirmation-required",
        origin: "operator",
        message: "installation requires explicit confirmation",
      },
    });
    expect(link.commands).toEqual([]);
  });

  test("a confirmed run executes every planned command through Link", async () => {
    const link = new FakeLink(expectedPlan.map(() => success));
    const install = new Install(link, BUILTIN_TOOLS);

    const outcome = await install.run(true);

    expect(outcome).toEqual({ ok: true });
    expect(link.commands).toEqual(expectedPlan.map((entry) => entry.command));
  });

  test("allows thirty minutes for each first-time install", async () => {
    let timeoutMs: number | undefined;
    const link = {
      run: async (_command: string, options: RunOptions = {}): Promise<LinkResult> => {
        timeoutMs = options.timeoutMs;
        return success;
      },
    };
    const install = new Install(link, [BUILTIN_TOOLS[0]!]);

    const outcome = await install.run(true);

    expect(outcome).toEqual({ ok: true });
    expect(timeoutMs).toBe(30 * 60 * 1_000);
  });

  test("reports progress before and after each installer", async () => {
    const link = new FakeLink([success, success]);
    const install = new Install(link, BUILTIN_TOOLS.slice(0, 2));
    const progress: InstallProgress[] = [];

    const outcome = await install.run(true, (update) => progress.push(update));

    expect(outcome).toEqual({ ok: true });
    expect(progress).toEqual([
      { phase: "started", tool: "gh", current: 1, total: 2 },
      { phase: "completed", tool: "gh", current: 1, total: 2 },
      { phase: "started", tool: "claude", current: 2, total: 2 },
      { phase: "completed", tool: "claude", current: 2, total: 2 },
    ]);
  });

  test("a failed remote command fails the install with the Link details", async () => {
    const failure: LinkResult = {
      ok: false,
      error: { code: "command-failed", origin: "box", message: "installer failed" },
    };
    const link = new FakeLink([success, failure]);
    const install = new Install(link, BUILTIN_TOOLS);

    const outcome = await install.run(true);

    expect(outcome).toBe(failure);
    expect(link.commands).toEqual(expectedPlan.slice(0, 2).map((entry) => entry.command));
  });
});
