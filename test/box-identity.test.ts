import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { apply } from "../src/apply.ts";
import {
  boxInstructionsHeader,
  boxInstructionsInput,
  readBoxInstructions,
  recordManagedPathsCommand,
  writeBoxFilesCommand,
} from "../src/box-identity.ts";
import { runCli } from "../src/cli.ts";
import type { LinkResult } from "../src/link.ts";
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

/** A fake SSH host: it runs each box command with `sh`. */
const boxLink = {
  run: async (command: string): Promise<LinkResult> => {
    const child = Bun.spawn(["sh", "-c", command], { stdin: "ignore", stdout: "pipe", stderr: "pipe" });
    const [exitCode, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
    return exitCode === 0
      ? { ok: true, address: "box.example", stdout, stderr }
      : { ok: false, error: { code: "command-failed", origin: "box", message: stderr.trim() || "command failed" } };
  },
};

const customHarness = {
  id: "opencode",
  name: "OpenCode",
  skillRoot: ".config/opencode/skills",
  instructionFile: ".config/opencode/AGENTS.md",
  extraRoots: [".config/opencode/commands"],
};

/** The box steps of a sync: write the box files, apply the checkout, and record the managed paths. Pi is off for this box. */
async function syncBox(home: string, harnesses = BUILTIN_HARNESSES): Promise<void> {
  const checkout = join(home, ".ferry", "store");
  write(join(checkout, "AGENTS.md"), "shared\n");
  write(join(checkout, "skills", "unslop", "SKILL.md"), "unslop");
  write(join(checkout, "roots", ".claude", "agents", "reviewer.md"), "review agent");
  write(join(checkout, "roots", ".config", "opencode", "commands", "ship.md"), "ship");
  await runOnBox(writeBoxFilesCommand(home, checkout, "fsn1"));
  const plan = await apply({
    checkout,
    targetHome: home,
    harnesses: harnesses.filter((harness) => harness.id !== "pi"),
    offHarnesses: harnesses.filter((harness) => harness.id === "pi"),
    link: boxLink,
  });
  await runOnBox(recordManagedPathsCommand(home, "fsn1", false, plan.managed));
}

function identityOf(home: string): unknown {
  return JSON.parse(readFileSync(join(home, ".ferry", "box", "identity.json"), "utf8"));
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

describe("the managed paths in the identity file", () => {
  // A quote, a space, and a variable in a path check the shell quoting.
  const managed = {
    instructionFiles: ["AGENTS.md", ".config/it's $HOME/AGENTS.md"],
    skillRoots: [".agents/skills"],
    roots: [".claude/agents"],
  };

  test("go into the file after Apply, next to the box name and the per-box flag", async () => {
    const home = makeHome();
    const checkout = join(home, ".ferry", "store");
    write(join(checkout, "AGENTS.md"), "shared\n");
    await runOnBox(writeBoxFilesCommand(home, checkout, "fsn1", true), boxInstructionsInput(new TextEncoder().encode("box\n")));

    await runOnBox(recordManagedPathsCommand(home, "fsn1", true, managed));

    expect(identityOf(home)).toEqual({ name: "fsn1", boxInstructions: true, managedPaths: managed });
    // The command replaces the file in one step and leaves no temporary file.
    expect(readdirSync(join(home, ".ferry", "box")).sort()).toEqual(["AGENTS.md", "identity.json"]);
  });

  test("keep the per-box flag off on a box without the generated file", async () => {
    const home = makeHome();
    const checkout = join(home, ".ferry", "store");
    mkdirSync(checkout, { recursive: true });
    await runOnBox(writeBoxFilesCommand(home, checkout, "fsn1", true), boxInstructionsInput(new TextEncoder().encode("box\n")));

    await runOnBox(recordManagedPathsCommand(home, "fsn1", true, { ...managed, instructionFiles: [] }));

    expect(identityOf(home)).toEqual({ name: "fsn1", boxInstructions: false, managedPaths: { ...managed, instructionFiles: [] } });
  });

  test("leave the file when the next sync starts, until its Apply records them again", async () => {
    const home = makeHome();
    const checkout = join(home, ".ferry", "store");
    write(join(checkout, "AGENTS.md"), "shared\n");
    await runOnBox(writeBoxFilesCommand(home, checkout, "fsn1"));
    await runOnBox(recordManagedPathsCommand(home, "fsn1", false, managed));

    // A sync whose Apply fails must not keep the list of the sync before it.
    await runOnBox(writeBoxFilesCommand(home, checkout, "fsn1"));

    expect(identityOf(home)).toEqual({ name: "fsn1", boxInstructions: false });
  });

  test("are the record of a real Apply on a box with Pi off", async () => {
    const home = makeHome();

    await syncBox(home);

    expect(identityOf(home)).toEqual({
      name: "fsn1",
      boxInstructions: false,
      managedPaths: {
        instructionFiles: ["AGENTS.md", ".claude/CLAUDE.md", ".codex/AGENTS.md"],
        skillRoots: [".agents/skills", ".claude/skills"],
        roots: [".claude/agents"],
      },
    });
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
    expect(JSON.parse((await whoami(home, true, ["--json"]))[0] ?? "").result).toMatchObject({ role: "box", box: "fsn1" });
  });

  test("a box before its first sync has no name and no managed path", async () => {
    const home = makeHome();
    expect(JSON.parse((await whoami(home, true, ["--json"]))[0] ?? "").result).toEqual({
      role: "box",
      box: null,
      instructions: null,
      managedPaths: { instructionFiles: [], skillRoots: [], roots: [] },
    });
    expect((await whoami(home, true)).at(-1)).toBe("Managed paths: none");
  });

  test("a box with Pi off lists the paths of the last sync, and no Pi path", async () => {
    const home = makeHome();
    await syncBox(home);

    const out = await whoami(home, true);

    expect(out.slice(out.indexOf("Managed paths:"))).toEqual([
      "Managed paths:",
      "  ~/AGENTS.md",
      "  ~/.claude/CLAUDE.md",
      "  ~/.codex/AGENTS.md",
      "  ~/.agents/skills/<skill>",
      "  ~/.claude/skills/<skill>",
      "  ~/.claude/agents",
    ]);
    expect(out.join("\n")).not.toContain(".pi/");
    // Each listed path is there on the box.
    for (const path of ["AGENTS.md", ".claude/CLAUDE.md", ".codex/AGENTS.md", ".agents/skills/unslop", ".claude/skills/unslop", ".claude/agents"]) {
      expect(existsSync(join(home, path))).toBe(true);
    }
  });

  test("a box lists the paths of a custom harness of the operator config", async () => {
    const home = makeHome();
    await syncBox(home, [...BUILTIN_HARNESSES, customHarness]);

    // The box has no operator config, so the list comes from the record of the sync.
    const out = await whoami(home, true);

    expect(out.slice(out.indexOf("Managed paths:"))).toEqual([
      "Managed paths:",
      "  ~/AGENTS.md",
      "  ~/.claude/CLAUDE.md",
      "  ~/.codex/AGENTS.md",
      "  ~/.config/opencode/AGENTS.md",
      "  ~/.agents/skills/<skill>",
      "  ~/.claude/skills/<skill>",
      "  ~/.config/opencode/skills/<skill>",
      "  ~/.claude/agents",
      "  ~/.config/opencode/commands",
    ]);
  });

  test("--json on a box has the same list in the same fields", async () => {
    const home = makeHome();
    await syncBox(home, [...BUILTIN_HARNESSES, customHarness]);

    expect(JSON.parse((await whoami(home, true, ["--json"]))[0] ?? "")).toEqual({
      schemaVersion: 1,
      command: "whoami",
      ok: true,
      result: {
        role: "box",
        box: "fsn1",
        instructions: {
          file: "~/.ferry/box/AGENTS.md",
          sources: [{ part: "header", path: null }, { part: "shared", path: "~/AGENTS.md" }],
        },
        managedPaths: {
          instructionFiles: ["~/AGENTS.md", "~/.claude/CLAUDE.md", "~/.codex/AGENTS.md", "~/.config/opencode/AGENTS.md"],
          skillRoots: ["~/.agents/skills", "~/.claude/skills", "~/.config/opencode/skills"],
          roots: ["~/.claude/agents", "~/.config/opencode/commands"],
        },
      },
      warnings: [],
      error: null,
    });
  });

  test("a box that an earlier Ferry synced lists only the builtin paths that are Ferry links", async () => {
    const home = makeHome();
    const checkout = join(home, ".ferry", "store");
    const generated = join(home, ".ferry", "box", "AGENTS.md");
    write(join(checkout, "AGENTS.md"), "shared\n");
    write(join(checkout, "skills", "unslop", "SKILL.md"), "unslop");
    write(join(checkout, "roots", ".claude", "agents", "reviewer.md"), "review agent");
    write(generated, "header\n\nshared\n");
    // The identity file of an earlier Ferry has no list.
    write(join(home, ".ferry", "box", "identity.json"), '{"name":"fsn1","boxInstructions":false}\n');
    const link = (target: string, path: string) => {
      mkdirSync(dirname(join(home, path)), { recursive: true });
      symlinkSync(target, join(home, path));
    };
    link(generated, "AGENTS.md");
    // A link from before the generated file points into the checkout.
    link(join(checkout, "AGENTS.md"), ".claude/CLAUDE.md");
    link(join(checkout, "skills", "unslop"), ".claude/skills/unslop");
    link(join(checkout, "roots", ".claude", "agents"), ".claude/agents");
    // These paths are there, but they are not links of Ferry. The Pi paths are not there.
    write(join(home, ".codex", "AGENTS.md"), "box codex rules\n");
    write(join(home, ".agents", "skills", "own", "SKILL.md"), "own");
    link(join(home, "elsewhere"), ".claude/commands");

    const out = await whoami(home, true);

    expect(out.slice(out.indexOf("Managed paths:"))).toEqual([
      "Managed paths:",
      "  ~/AGENTS.md",
      "  ~/.claude/CLAUDE.md",
      "  ~/.claude/skills/<skill>",
      "  ~/.claude/agents",
    ]);
    expect(JSON.parse((await whoami(home, true, ["--json"]))[0] ?? "").result.managedPaths).toEqual({
      instructionFiles: ["~/AGENTS.md", "~/.claude/CLAUDE.md"],
      skillRoots: ["~/.claude/skills"],
      roots: ["~/.claude/agents"],
    });
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
