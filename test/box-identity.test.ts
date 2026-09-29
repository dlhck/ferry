import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { boxInstructionsHeader, writeBoxFilesCommand } from "../src/box-identity.ts";
import { runCli } from "../src/cli.ts";
import { BUILTIN_HARNESSES } from "../src/registry/builtin.ts";
import { runUninstall } from "../src/uninstall.ts";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function makeHome(): string {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "ferry-box-identity-")));
  roots.push(root);
  // A quote and a space in the home check the shell quoting.
  const home = join(root, "home 'user'");
  mkdirSync(home);
  return home;
}

function write(path: string, body: string | Uint8Array): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, body);
}

async function runOnBox(command: string): Promise<void> {
  const child = Bun.spawn(["sh", "-c", command], { stdout: "pipe", stderr: "pipe" });
  expect(await child.exited).toBe(0);
}

describe("the generated box instructions", () => {
  test("hold the header, then the shared instructions byte for byte", async () => {
    const home = makeHome();
    const checkout = join(home, ".ferry", "store");
    const shared = new Uint8Array([...new TextEncoder().encode("# Rules\n\n`$HOME` 'quoted' \\n"), 0xff, 0x00, 0x0a]);
    write(join(checkout, "AGENTS.md"), shared);

    await runOnBox(writeBoxFilesCommand(home, checkout, "fsn1"));

    const header = new TextEncoder().encode(`${boxInstructionsHeader("fsn1")}\n\n`);
    const generated = new Uint8Array(readFileSync(join(home, ".ferry", "box", "AGENTS.md")));
    expect(generated.slice(0, header.length)).toEqual(header);
    expect(generated.slice(header.length)).toEqual(shared);
    expect(JSON.parse(readFileSync(join(home, ".ferry", "box", "identity.json"), "utf8"))).toEqual({ name: "fsn1" });
  });

  test("follow a change of the shared instructions and of the box name", async () => {
    const home = makeHome();
    const checkout = join(home, ".ferry", "store");
    write(join(checkout, "AGENTS.md"), "old\n");
    await runOnBox(writeBoxFilesCommand(home, checkout, "fsn1"));
    write(join(checkout, "AGENTS.md"), "new\n");
    await runOnBox(writeBoxFilesCommand(home, checkout, "lab"));

    expect(readFileSync(join(home, ".ferry", "box", "AGENTS.md"), "utf8")).toBe(`${boxInstructionsHeader("lab")}\n\nnew\n`);
    expect(JSON.parse(readFileSync(join(home, ".ferry", "box", "identity.json"), "utf8"))).toEqual({ name: "lab" });
  });

  test("go away when the snapshot has no instructions", async () => {
    const home = makeHome();
    const checkout = join(home, ".ferry", "store");
    write(join(checkout, "AGENTS.md"), "shared\n");
    await runOnBox(writeBoxFilesCommand(home, checkout, "fsn1"));
    rmSync(join(checkout, "AGENTS.md"));
    await runOnBox(writeBoxFilesCommand(home, checkout, "fsn1"));

    expect(existsSync(join(home, ".ferry", "box", "AGENTS.md"))).toBe(false);
    expect(existsSync(join(home, ".ferry", "box", "identity.json"))).toBe(true);
  });

  test("the header is short", () => {
    expect(boxInstructionsHeader("fsn1").length).toBeLessThan(300);
  });
});

describe("ferry whoami", () => {
  async function whoami(home: string, boxMode: boolean, args: string[] = []) {
    const out: string[] = [];
    const errors: string[] = [];
    await runCli(["whoami", ...args], {
      isBoxMode: () => boxMode,
      home: () => home,
      readConfig: () => null,
      writeLine: (line) => out.push(line),
    }, { renderError: (message) => errors.push(message), setExitCode: () => {} });
    expect(errors).toEqual([]);
    return out;
  }

  test("prints the operator role on the operator machine", async () => {
    const home = makeHome();
    const out = await whoami(home, false, ["--json"]);
    const envelope = JSON.parse(out[0] ?? "");
    expect(envelope).toMatchObject({ command: "whoami", ok: true, result: { role: "operator", box: null } });
    expect(envelope.result.managedPaths.instructionFiles).toEqual(["~/AGENTS.md", "~/.claude/CLAUDE.md", "~/.codex/AGENTS.md", "~/.pi/agent/AGENTS.md"]);
    expect(envelope.result.managedPaths.skillRoots).toContain("~/.agents/skills");
    expect(envelope.result.managedPaths.roots).toContain("~/.claude/agents");
  });

  test("runs on a box install and prints the box role and name", async () => {
    const home = makeHome();
    write(join(home, ".ferry", "box", "identity.json"), '{"name":"fsn1"}\n');
    const out = await whoami(home, true);
    expect(out[0]).toBe("This machine is the Ferry box fsn1.");
    expect(out).toContain("Managed paths:");
    expect(out).toContain("  ~/.agents/skills/<skill>");
    expect(JSON.parse((await whoami(home, true, ["--json"]))[0] ?? "").result).toMatchObject({ role: "box", box: "fsn1" });
  });

  test("a box before its first sync has no name", async () => {
    const home = makeHome();
    expect(JSON.parse((await whoami(home, true, ["--json"]))[0] ?? "").result).toMatchObject({ role: "box", box: null });
  });
});

describe("ferry uninstall on a box", () => {
  test("removes the links to the generated instructions and the generated files", () => {
    const home = makeHome();
    write(join(home, ".ferry", "store", "AGENTS.md"), "shared\n");
    write(join(home, ".ferry", "box", "AGENTS.md"), "header\n\nshared\n");
    write(join(home, ".ferry", "box", "identity.json"), '{"name":"fsn1"}\n');
    symlinkSync(join(home, ".ferry", "box", "AGENTS.md"), join(home, "AGENTS.md"));
    mkdirSync(join(home, ".codex"));
    symlinkSync(join(home, ".ferry", "box", "AGENTS.md"), join(home, ".codex", "AGENTS.md"));
    // An earlier sync backed up the live AGENTS.md of the box.
    write(join(home, ".ferry", "backups", "20260828T101112Z", "codex", "AGENTS.md"), "box codex rules\n");

    runUninstall({ home, harnesses: BUILTIN_HARNESSES });

    expect(existsSync(join(home, "AGENTS.md"))).toBe(false);
    expect(readFileSync(join(home, ".codex", "AGENTS.md"), "utf8")).toBe("box codex rules\n");
    expect(existsSync(join(home, ".ferry", "box"))).toBe(false);
  });
});
