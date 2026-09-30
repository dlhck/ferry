import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { boxInstructionsHeader, boxInstructionsInput, readBoxInstructions, writeBoxFilesCommand } from "../src/box-identity.ts";
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

async function runOnBox(command: string, input?: Uint8Array): Promise<void> {
  const child = Bun.spawn(["sh", "-c", command], { stdin: input ?? "ignore", stdout: "pipe", stderr: "pipe" });
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
    expect(JSON.parse(readFileSync(join(home, ".ferry", "box", "identity.json"), "utf8"))).toEqual({ name: "fsn1", boxInstructions: false });
  });

  test("hold the per-box instructions between the header and the shared instructions, with one blank line between the parts", async () => {
    const home = makeHome();
    const checkout = join(home, ".ferry", "store");
    const shared = new Uint8Array([...new TextEncoder().encode("# Rules\n"), 0xff, 0x0a]);
    write(join(checkout, "AGENTS.md"), shared);
    // The blank lines at the start and the end of the per-box file do not add blank lines.
    const perBox = "\n\nUse the GPU here.\n\n`$HOME` 'quoted' \\n\n\n\n";

    await runOnBox(writeBoxFilesCommand(home, checkout, "fsn1", true), boxInstructionsInput(new TextEncoder().encode(perBox)));

    const start = new TextEncoder().encode(`${boxInstructionsHeader("fsn1")}\n\nUse the GPU here.\n\n\`$HOME\` 'quoted' \\n\n\n`);
    const generated = new Uint8Array(readFileSync(join(home, ".ferry", "box", "AGENTS.md")));
    expect(generated.slice(0, start.length)).toEqual(start);
    expect(generated.slice(start.length)).toEqual(shared);
    expect(JSON.parse(readFileSync(join(home, ".ferry", "box", "identity.json"), "utf8"))).toEqual({ name: "fsn1", boxInstructions: true });
  });

  test("lose the per-box part when a later sync has none", async () => {
    const home = makeHome();
    const checkout = join(home, ".ferry", "store");
    write(join(checkout, "AGENTS.md"), "shared\n");
    await runOnBox(writeBoxFilesCommand(home, checkout, "fsn1", true), boxInstructionsInput(new TextEncoder().encode("box\n")));
    await runOnBox(writeBoxFilesCommand(home, checkout, "fsn1"));

    expect(readFileSync(join(home, ".ferry", "box", "AGENTS.md"), "utf8")).toBe(`${boxInstructionsHeader("fsn1")}\n\nshared\n`);
    expect(JSON.parse(readFileSync(join(home, ".ferry", "box", "identity.json"), "utf8"))).toEqual({ name: "fsn1", boxInstructions: false });
  });

  test("keep the per-box text out of the box command", () => {
    expect(writeBoxFilesCommand("/home/user", "/home/user/.ferry/store", "fsn1", true)).not.toContain("GPU");
    expect(writeBoxFilesCommand("/home/user", "/home/user/.ferry/store", "fsn1", true)).toContain(" cat; cat '/home/user/.ferry/store/AGENTS.md'; }");
  });

  test("follow a change of the shared instructions and of the box name", async () => {
    const home = makeHome();
    const checkout = join(home, ".ferry", "store");
    write(join(checkout, "AGENTS.md"), "old\n");
    await runOnBox(writeBoxFilesCommand(home, checkout, "fsn1"));
    write(join(checkout, "AGENTS.md"), "new\n");
    await runOnBox(writeBoxFilesCommand(home, checkout, "lab"));

    expect(readFileSync(join(home, ".ferry", "box", "AGENTS.md"), "utf8")).toBe(`${boxInstructionsHeader("lab")}\n\nnew\n`);
    expect(JSON.parse(readFileSync(join(home, ".ferry", "box", "identity.json"), "utf8"))).toEqual({ name: "lab", boxInstructions: false });
  });

  test("go away when the snapshot has no instructions", async () => {
    const home = makeHome();
    const checkout = join(home, ".ferry", "store");
    write(join(checkout, "AGENTS.md"), "shared\n");
    await runOnBox(writeBoxFilesCommand(home, checkout, "fsn1"));
    rmSync(join(checkout, "AGENTS.md"));
    await runOnBox(writeBoxFilesCommand(home, checkout, "fsn1", true), boxInstructionsInput(new TextEncoder().encode("box\n")));

    expect(existsSync(join(home, ".ferry", "box", "AGENTS.md"))).toBe(false);
    // Without the shared instructions, the box has no instruction file, so the per-box part is not applied.
    expect(JSON.parse(readFileSync(join(home, ".ferry", "box", "identity.json"), "utf8"))).toEqual({ name: "fsn1", boxInstructions: false });
  });

  test("the header is short", () => {
    expect(boxInstructionsHeader("fsn1").length).toBeLessThan(300);
  });
});

describe("the per-box instruction file on the operator machine", () => {
  test("is ~/.ferry/boxes/<name>/AGENTS.md", () => {
    const home = makeHome();
    write(join(home, ".ferry", "boxes", "fsn1", "AGENTS.md"), "Use the GPU here.\n");

    const instructions = readBoxInstructions(home, "fsn1");

    expect(instructions?.path).toBe(join(home, ".ferry/boxes/fsn1/AGENTS.md"));
    expect(Buffer.from(instructions!.bytes).toString()).toBe("Use the GPU here.\n");
  });

  test("adds nothing when it is missing, empty, or blank", () => {
    const home = makeHome();
    write(join(home, ".ferry", "boxes", "empty", "AGENTS.md"), "");
    write(join(home, ".ferry", "boxes", "blank", "AGENTS.md"), " \n\t\r\n");

    expect(readBoxInstructions(home, "missing")).toBeNull();
    expect(readBoxInstructions(home, "empty")).toBeNull();
    expect(readBoxInstructions(home, "blank")).toBeNull();
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
    expect(envelope).toMatchObject({ command: "whoami", ok: true, result: { role: "operator", box: null, instructions: null } });
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
    expect(JSON.parse((await whoami(home, true, ["--json"]))[0] ?? "").result).toMatchObject({ role: "box", box: null, instructions: null });
  });

  test("lists the per-box file as a merged part of the generated instructions", async () => {
    const home = makeHome();
    const checkout = join(home, ".ferry", "store");
    write(join(checkout, "AGENTS.md"), "shared\n");
    await runOnBox(writeBoxFilesCommand(home, checkout, "fsn1", true), boxInstructionsInput(new TextEncoder().encode("box\n")));

    const out = await whoami(home, true);
    const at = out.indexOf("Ferry writes ~/.ferry/box/AGENTS.md on each sync. Do not edit it. It has these parts, in this order:");
    expect(out.slice(at + 1, at + 4)).toEqual([
      "  The Ferry header",
      "  ~/.ferry/boxes/fsn1/AGENTS.md on the operator machine",
      "  ~/AGENTS.md on the operator machine",
    ]);
    expect(JSON.parse((await whoami(home, true, ["--json"]))[0] ?? "").result.instructions).toEqual({
      file: "~/.ferry/box/AGENTS.md",
      sources: [
        { part: "header", path: null },
        { part: "box", path: "~/.ferry/boxes/fsn1/AGENTS.md" },
        { part: "shared", path: "~/AGENTS.md" },
      ],
    });
  });

  test("lists only the header and the shared instructions on a box without per-box instructions", async () => {
    const home = makeHome();
    const checkout = join(home, ".ferry", "store");
    write(join(checkout, "AGENTS.md"), "shared\n");
    await runOnBox(writeBoxFilesCommand(home, checkout, "fsn1"));

    const result = JSON.parse((await whoami(home, true, ["--json"]))[0] ?? "").result;
    expect(result.instructions.sources.map((source: { part: string }) => source.part)).toEqual(["header", "shared"]);
    expect((await whoami(home, true)).join("\n")).not.toContain(".ferry/boxes/");
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
