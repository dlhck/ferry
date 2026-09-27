import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Link, type HostAdapter, type HostCommand } from "../src/link.ts";
import { loadRegistry } from "../src/registry/load.ts";
import type { ToolDescriptor } from "../src/registry/types.ts";
import { BUILTIN_BOX_PATH_DIRS, boxPathDirs, profileBlockCommand } from "../src/tools/path.ts";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function tool(id: string, pathDirs: readonly string[]): ToolDescriptor {
  return { id, kind: "tool", pathDirs };
}

describe("boxPathDirs", () => {
  test("the built-in tools give .local/bin and .pi/agent/bin", () => {
    expect(BUILTIN_BOX_PATH_DIRS).toEqual([".local/bin", ".pi/agent/bin"]);
  });

  test("keeps .local/bin first, keeps the registry order, and removes duplicates", () => {
    const dirs = boxPathDirs([
      tool("bun", [".bun/bin"]),
      tool("claude", [".local/bin"]),
      tool("node", [".nvm/current/bin", "./.bun/bin/"]),
      tool("pi", [".pi/agent/bin"]),
    ]);

    expect(dirs).toEqual([".local/bin", ".bun/bin", ".nvm/current/bin", ".pi/agent/bin"]);
  });

  test("adds the directories of the config tools after the built-ins", () => {
    const registry = loadRegistry({
      tools: { bun: { local: "bun --version", install: "curl -fsSL https://bun.sh/install | bash", path: [".bun/bin"] } },
    });
    if (!registry.ok) throw new Error(JSON.stringify(registry.problems));

    expect(boxPathDirs(registry.tools)).toEqual([".local/bin", ".pi/agent/bin", ".bun/bin"]);
  });

  test.each([
    ["/usr/local/go/bin", "is not a directory inside the home"],
    ["../other/bin", "is not a directory inside the home"],
    [".tools/../../bin", "is not a directory inside the home"],
    [".", "is not a directory inside the home"],
    ['.bin"; rm -rf ~; "', "has a character"],
    [".bin:/tmp", "has a character"],
    ["$HOME/bin", "has a character"],
    ["%h/bin", "has a character"],
    ["my bin", "has a character"],
  ])("refuses %s", (dir, reason) => {
    expect(() => boxPathDirs([tool("bad", [dir])])).toThrow(reason);
  });
});

describe("Link PATH prefix", () => {
  const recorded = (): { host: HostAdapter; commands: HostCommand[] } => {
    const commands: HostCommand[] = [];
    return {
      commands,
      host: {
        run: async (command) => {
          commands.push(command);
          return { exitCode: 0, stdout: "", stderr: "", timedOut: false };
        },
      },
    };
  };

  test("uses the built-in directories when no directories are given", async () => {
    const { host, commands } = recorded();
    await new Link({ destination: "user@box.example" }, host).run("true");

    expect(commands[0]?.argv.at(-1)).toBe('export PATH="$HOME/.local/bin:$HOME/.pi/agent/bin:$PATH"; true');
  });

  test("puts the directory of a config tool on the box PATH", async () => {
    const { host, commands } = recorded();
    const dirs = boxPathDirs([...loadTools(), tool("bun", [".bun/bin"])]);
    await new Link({ destination: "user@box.example", pathDirs: dirs }, host).run("bun --version");

    expect(commands[0]?.argv.at(-1)).toBe(
      'export PATH="$HOME/.local/bin:$HOME/.pi/agent/bin:$HOME/.bun/bin:$PATH"; bun --version',
    );
  });
});

function loadTools(): readonly ToolDescriptor[] {
  const registry = loadRegistry();
  if (!registry.ok) throw new Error("expected the builtin registry");
  return registry.tools;
}

describe("profile block", () => {
  const START = "# >>> ferry PATH >>>";
  const END = "# <<< ferry PATH <<<";
  const block = (dirs: readonly string[]) =>
    [
      START,
      "# Managed by ferry. ferry sync rewrites this block. Do not edit it.",
      `export PATH="${dirs.map((dir) => `$HOME/${dir}`).join(":")}:$PATH"`,
      END,
      "",
    ].join("\n");

  function home(): string {
    const root = mkdtempSync(join(tmpdir(), "ferry-profile-"));
    roots.push(root);
    return root;
  }

  async function write(dir: string, dirs: readonly string[]): Promise<string> {
    const process = Bun.spawn(["sh", "-c", profileBlockCommand(dirs)], {
      cwd: dir,
      env: { PATH: Bun.env.PATH ?? "/usr/bin:/bin", HOME: dir },
      stdout: "pipe",
      stderr: "pipe",
    });
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(process.stdout).text(),
      new Response(process.stderr).text(),
      process.exited,
    ]);
    if (exitCode !== 0) throw new Error(`exit ${exitCode}: ${stderr}`);
    return stdout.trim();
  }

  test("creates ~/.profile with the block when the file is missing", async () => {
    const dir = home();

    expect(await write(dir, [".local/bin", ".bun/bin"])).toBe("changed");
    expect(readFileSync(join(dir, ".profile"), "utf8")).toBe(block([".local/bin", ".bun/bin"]));
    expect(existsSync(join(dir, ".profile.ferry-tmp"))).toBe(false);
  });

  test("appends the block and keeps every other line and the file mode", async () => {
    const dir = home();
    const profile = join(dir, ".profile");
    writeFileSync(profile, '# ~/.profile\nif [ -n "$BASH_VERSION" ]; then\n  . "$HOME/.bashrc"\nfi\n');
    chmodSync(profile, 0o640);

    expect(await write(dir, [".local/bin"])).toBe("changed");
    expect(readFileSync(profile, "utf8")).toBe(
      `# ~/.profile\nif [ -n "$BASH_VERSION" ]; then\n  . "$HOME/.bashrc"\nfi\n${block([".local/bin"])}`,
    );
    expect(statSync(profile).mode & 0o777).toBe(0o640);
  });

  test("does not write the file when the block is current", async () => {
    const dir = home();
    const profile = join(dir, ".profile");
    writeFileSync(profile, `umask 022\n${block([".local/bin"])}export EDITOR=vi\n`);
    const before = statSync(profile);

    expect(await write(dir, [".local/bin"])).toBe("unchanged");
    const after = statSync(profile);
    expect(after.ino).toBe(before.ino);
    expect(after.mtimeMs).toBe(before.mtimeMs);
    expect(existsSync(join(dir, ".profile.ferry-tmp"))).toBe(false);
  });

  test("rewrites only the block in place when the directories change", async () => {
    const dir = home();
    const profile = join(dir, ".profile");
    writeFileSync(profile, `umask 022\n${START}\nexport PATH="$HOME/old:$PATH"\n${END}\nexport EDITOR=vi\n`);

    expect(await write(dir, [".local/bin", ".bun/bin"])).toBe("changed");
    expect(readFileSync(profile, "utf8")).toBe(`umask 022\n${block([".local/bin", ".bun/bin"])}export EDITOR=vi\n`);
    expect(await write(dir, [".local/bin", ".bun/bin"])).toBe("unchanged");
  });

  test("a login shell that reads the block finds the tool directories first", async () => {
    const dir = home();
    await write(dir, [".local/bin", ".bun/bin"]);
    const process = Bun.spawn(["sh", "-c", '. "$HOME/.profile" && printf %s "$PATH"'], {
      env: { PATH: "/usr/bin:/bin", HOME: dir },
      stdout: "pipe",
    });
    const path = await new Response(process.stdout).text();

    expect(path).toBe(`${dir}/.local/bin:${dir}/.bun/bin:/usr/bin:/bin`);
  });
});
