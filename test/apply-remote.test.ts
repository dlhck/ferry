import { afterEach, describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { ApplyError, apply, planApply, type ApplyPlan } from "../src/apply.ts";
import { BUILTIN_HARNESSES } from "../src/registry/builtin.ts";
import type { LinkResult } from "../src/link.ts";

const roots: string[] = [];
const ownedSkillRoots = [".agents/skills", ".claude/skills"] as const;
const sharedSkillRoots = [".codex/skills", ".pi/agent/skills", ".cursor/skills"] as const;

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

class ShellLink {
  readonly commands: string[] = [];

  constructor(private readonly cwd: string) {}

  async run(command: string): Promise<LinkResult> {
    this.commands.push(command);
    const process = Bun.spawn(["sh", "-c", command], {
      cwd: this.cwd,
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    });
    const [exitCode, stdout, stderr] = await Promise.all([
      process.exited,
      new Response(process.stdout).text(),
      new Response(process.stderr).text(),
    ]);
    if (exitCode !== 0) {
      return {
        ok: false,
        error: {
          code: "command-failed",
          origin: "box",
          message: stderr.trim() || stdout.trim() || "command failed",
        },
      };
    }
    return { ok: true, address: "test-box", stdout, stderr };
  }
}

function makeRoot(label: string): string {
  const root = realpathSync(mkdtempSync(join(tmpdir(), `ferry-${label}-`)));
  roots.push(root);
  return root;
}

function write(path: string, body: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, body);
}

function makeCheckout(root: string, skills: readonly string[] = ["tdd", "unslop"]): string {
  const checkout = join(root, "store space '$HOME' $(touch checkout-injected)");
  for (const name of skills) write(join(checkout, "skills", name, "SKILL.md"), name);
  write(join(checkout, "AGENTS.md"), "global instructions");
  return checkout;
}

/** A remote target is a box. Its instruction files link to the generated box file, not to the checkout. */
function boxPlan(plan: ApplyPlan): ApplyPlan {
  const checkoutInstructions = join(plan.checkout, "AGENTS.md");
  const boxInstructions = join(plan.targetHome, ".ferry", "box", "AGENTS.md");
  return {
    ...plan,
    actions: plan.actions.map((action) => {
      if ("target" in action && action.target === checkoutInstructions) return { ...action, target: boxInstructions };
      if ("expectedTarget" in action && action.expectedTarget === checkoutInstructions) {
        return { ...action, expectedTarget: boxInstructions };
      }
      return action;
    }),
  };
}

describe("remote apply", () => {
  test("local and remote planning produce the same actions", async () => {
    const root = makeRoot("remote-plan");
    const checkout = makeCheckout(root);
    const home = join(root, "home space '$USER'");
    mkdirSync(home);
    const wrong = join(root, "wrong target");
    mkdirSync(wrong);
    const wrongLink = join(home, ".codex", "skills", "unslop");
    mkdirSync(dirname(wrongLink), { recursive: true });
    symlinkSync(wrong, wrongLink);

    const local = planApply({
      checkout,
      targetHome: home,
      harnesses: BUILTIN_HARNESSES,
      timestamp: "20260828T101112Z",
    });
    const link = new ShellLink(root);
    const remote = await apply({
      checkout,
      targetHome: home,
      harnesses: BUILTIN_HARNESSES,
      timestamp: "20260828T101112Z",
      dryRun: true,
      link,
    });

    expect(remote).toEqual(boxPlan(local));
    expect(link.commands).toHaveLength(1);
  });

  test("dry-run inspects once and performs no mutation", async () => {
    const root = makeRoot("remote-dry-run");
    const checkout = makeCheckout(root, ["unslop"]);
    const home = join(root, "home");
    mkdirSync(home);
    const link = new ShellLink(root);

    const plan = await apply({ checkout, targetHome: home, harnesses: BUILTIN_HARNESSES, dryRun: true, link });

    expect(plan.actions.length).toBeGreaterThan(0);
    expect(link.commands).toHaveLength(1);
    expect(existsSync(join(home, ".agents"))).toBe(false);
  });

  test("force produces backup-and-link in one mutation call", async () => {
    const root = makeRoot("remote-force");
    const checkout = makeCheckout(root, ["unslop"]);
    const home = join(root, "home");
    const live = join(home, ".claude", "skills", "unslop");
    const backup = join(home, ".ferry", "backups", "20260828T101112Z", "claude", "unslop");
    write(join(live, "local.md"), "box copy");
    const link = new ShellLink(root);

    const plan = await apply({
      checkout,
      targetHome: home,
      harnesses: BUILTIN_HARNESSES,
      force: true,
      timestamp: "20260828T101112Z",
      link,
    });

    expect(plan.actions).toContainEqual({
      kind: "backup-and-link",
      harness: "Claude",
      path: live,
      target: join(checkout, "skills", "unslop"),
      backupPath: backup,
    });
    expect(link.commands).toHaveLength(2);
    expect(realpathSync(live)).toBe(join(checkout, "skills", "unslop"));
    expect(readFileSync(join(backup, "local.md"), "utf8")).toBe("box copy");
  });

  test("deleted managed names are removed while unmanaged names remain", async () => {
    const root = makeRoot("remote-delete");
    const checkout = makeCheckout(root, ["unslop"]);
    const home = join(root, "home");
    mkdirSync(home);
    for (const skillRoot of [...ownedSkillRoots, ...sharedSkillRoots]) {
      const managed = join(home, skillRoot, "deleted");
      mkdirSync(dirname(managed), { recursive: true });
      symlinkSync(join(checkout, "skills", "deleted"), managed);
    }
    const unmanaged = join(home, ".cursor", "skills", "local-only", "SKILL.md");
    write(unmanaged, "local");

    const plan = await apply({ checkout, targetHome: home, harnesses: BUILTIN_HARNESSES, link: new ShellLink(root) });

    expect(plan.actions.filter((action) => action.kind === "delete-managed-name")).toHaveLength(5);
    for (const skillRoot of [...ownedSkillRoots, ...sharedSkillRoots]) {
      expect(existsSync(join(home, skillRoot, "deleted"))).toBe(false);
    }
    expect(readFileSync(unmanaged, "utf8")).toBe("local");
  });

  test("leftover links to the Codex system skills are removed and a real directory stays", async () => {
    const root = makeRoot("remote-system");
    const checkout = makeCheckout(root, ["unslop", ".system"]);
    const home = join(root, "home");
    const leftovers = [...ownedSkillRoots, ".pi/agent/skills", ".cursor/skills"].map((skillRoot) =>
      join(home, skillRoot, ".system"),
    );
    for (const leftover of leftovers) {
      mkdirSync(dirname(leftover), { recursive: true });
      symlinkSync(join(checkout, "skills", ".system"), leftover);
    }
    const official = join(home, ".codex", "skills", ".system", "SKILL.md");
    write(official, "codex system skill");

    const plan = await apply({ checkout, targetHome: home, harnesses: BUILTIN_HARNESSES, link: new ShellLink(root) });

    expect(plan.actions.filter((action) => action.path.endsWith(".system")).map((action) => action.kind)).toEqual(
      leftovers.map(() => "delete-managed-name"),
    );
    for (const leftover of leftovers) expect(existsSync(leftover)).toBe(false);
    expect(readFileSync(official, "utf8")).toBe("codex system skill");
  });

  test("a partial mutation failure names the correct harness", async () => {
    const root = makeRoot("remote-failure");
    const checkout = makeCheckout(root, ["unslop"]);
    const home = join(root, "home");
    mkdirSync(home);
    writeFileSync(join(home, ".claude"), "blocks the Claude directory");

    await expect(apply({ checkout, targetHome: home, harnesses: BUILTIN_HARNESSES, link: new ShellLink(root) })).rejects.toEqual(
      expect.objectContaining({
        code: "commit-failed",
        harness: "Claude",
        path: join(home, ".claude", "skills", "unslop"),
      }),
    );
    expect(existsSync(join(home, ".agents", "skills", "unslop"))).toBe(true);
    expect(existsSync(join(home, ".codex"))).toBe(false);
  });

  test("shell metacharacters remain data and private state stays outside the command set", async () => {
    const root = makeRoot("remote-shell");
    const skill = "skill '$VALUE' $(touch skill-injected)";
    const checkout = makeCheckout(root, [skill]);
    const home = join(root, "home ' $HOME $(touch home-injected)");
    mkdirSync(home);
    const state = {
      ".claude/.credentials.json": "claude auth",
      ".codex/auth.json": "codex auth",
      ".pi/agent/sessions/run.jsonl": "pi session",
      ".cursor/logs/agent.log": "cursor log",
    };
    for (const [path, body] of Object.entries(state)) write(join(home, path), body);
    const link = new ShellLink(root);

    await apply({ checkout, targetHome: home, harnesses: BUILTIN_HARNESSES, link });

    expect(link.commands).toHaveLength(2);
    expect(existsSync(join(root, "checkout-injected"))).toBe(false);
    expect(existsSync(join(root, "home-injected"))).toBe(false);
    expect(existsSync(join(root, "skill-injected"))).toBe(false);
    for (const command of link.commands) {
      expect(command).not.toContain(".credentials.json");
      expect(command).not.toContain("auth.json");
      expect(command).not.toContain("sessions/run.jsonl");
      expect(command).not.toContain("logs/agent.log");
    }
    for (const [path, body] of Object.entries(state)) {
      expect(readFileSync(join(home, path), "utf8")).toBe(body);
    }
    expect(realpathSync(join(home, ".agents", "skills", skill))).toBe(
      join(checkout, "skills", skill),
    );
  });

  test("remote refusal happens before the mutation call", async () => {
    const root = makeRoot("remote-refusal");
    const checkout = makeCheckout(root, ["unslop"]);
    const home = join(root, "home");
    write(join(home, ".claude", "skills", "unslop", "local.md"), "box copy");
    const link = new ShellLink(root);

    await expect(apply({ checkout, targetHome: home, harnesses: BUILTIN_HARNESSES, link })).rejects.toBeInstanceOf(ApplyError);
    expect(link.commands).toHaveLength(1);
    expect(existsSync(join(home, ".agents"))).toBe(false);
  });
});

describe("remote apply of the box instructions", () => {
  test("moves an instruction link from the checkout to the generated box file", async () => {
    const root = makeRoot("remote-box-instructions");
    const checkout = makeCheckout(root, ["unslop"]);
    const home = join(root, "home");
    write(join(home, ".ferry", "box", "AGENTS.md"), "box header\n\nglobal instructions");
    // A box from before the generated file links the instructions into the checkout.
    symlinkSync(join(checkout, "AGENTS.md"), join(home, "AGENTS.md"));

    const plan = await apply({ checkout, targetHome: home, harnesses: BUILTIN_HARNESSES, link: new ShellLink(root) });

    expect(plan.actions).toContainEqual({
      kind: "repair-symlink",
      harness: "Shared agents",
      path: join(home, "AGENTS.md"),
      target: join(home, ".ferry", "box", "AGENTS.md"),
    });
    expect(readFileSync(join(home, "AGENTS.md"), "utf8")).toBe("box header\n\nglobal instructions");
    expect(readFileSync(join(home, ".codex", "AGENTS.md"), "utf8")).toBe("box header\n\nglobal instructions");
  });

  test("an off harness also removes an instruction link into the checkout", async () => {
    const root = makeRoot("remote-box-off-old");
    const checkout = makeCheckout(root, ["unslop"]);
    const home = join(root, "home");
    const piInstructions = join(home, ".pi", "agent", "AGENTS.md");
    mkdirSync(dirname(piInstructions), { recursive: true });
    symlinkSync(join(checkout, "AGENTS.md"), piInstructions);

    const plan = await apply({
      checkout,
      targetHome: home,
      harnesses: BUILTIN_HARNESSES.filter((harness) => harness.id !== "pi"),
      offHarnesses: BUILTIN_HARNESSES.filter((harness) => harness.id === "pi"),
      dryRun: true,
      link: new ShellLink(root),
    });

    expect(plan.actions).toContainEqual({
      kind: "delete-managed-link",
      harness: "Pi",
      path: piInstructions,
      expectedTarget: join(checkout, "AGENTS.md"),
    });
  });
});

describe("remote apply of Claude subagent and command roots", () => {
  test("links a root the checkout holds and plans the same actions as a local apply", async () => {
    const root = makeRoot("remote-roots");
    const checkout = makeCheckout(root, ["unslop"]);
    write(join(checkout, "roots", ".claude", "agents", "reviewer.md"), "review agent");
    const home = join(root, "home");
    mkdirSync(home);
    const local = planApply({
      checkout,
      targetHome: home,
      harnesses: BUILTIN_HARNESSES,
      timestamp: "20260828T101112Z",
    });

    const remote = await apply({
      checkout,
      targetHome: home,
      harnesses: BUILTIN_HARNESSES,
      timestamp: "20260828T101112Z",
      link: new ShellLink(root),
    });

    expect(remote).toEqual(boxPlan(local));
    expect(remote.actions).toContainEqual({
      kind: "create-symlink",
      harness: "Claude",
      path: join(home, ".claude", "agents"),
      target: join(checkout, "roots", ".claude", "agents"),
    });
    expect(readFileSync(join(home, ".claude", "agents", "reviewer.md"), "utf8")).toBe("review agent");
    expect(existsSync(join(home, ".claude", "commands"))).toBe(false);
  });
});

describe("remote apply of an off harness", () => {
  const withoutHarness = (id: string) => BUILTIN_HARNESSES.filter((harness) => harness.id !== id);
  const harness = (id: string) => BUILTIN_HARNESSES.filter((entry) => entry.id === id);

  test("removes Ferry's earlier links in .pi/agent and keeps the other files", async () => {
    const root = makeRoot("remote-off-pi");
    const checkout = makeCheckout(root);
    const home = join(root, "home");
    mkdirSync(home);
    const link = new ShellLink(root);
    write(join(home, ".ferry", "box", "AGENTS.md"), "box header\n\nglobal instructions");
    await apply({ checkout, targetHome: home, harnesses: BUILTIN_HARNESSES, link });
    // An earlier Ferry linked store skills into .pi/agent/skills.
    const piSkill = join(home, ".pi", "agent", "skills", "tdd");
    mkdirSync(dirname(piSkill), { recursive: true });
    symlinkSync(join(checkout, "skills", "tdd"), piSkill);
    write(join(home, ".pi", "agent", "settings.json"), "{}");
    write(join(home, ".pi", "agent", "skills", "mine", "SKILL.md"), "own skill");
    const elsewhere = join(root, "elsewhere");
    mkdirSync(elsewhere);
    symlinkSync(elsewhere, join(home, ".pi", "agent", "skills", "other"));
    expect(realpathSync(join(home, ".pi", "agent", "AGENTS.md"))).toBe(realpathSync(join(home, ".ferry", "box", "AGENTS.md")));

    const input = { checkout, targetHome: home, harnesses: withoutHarness("pi"), offHarnesses: harness("pi") };
    const remote = await apply({ ...input, link });

    expect(remote.actions).toEqual([
      { kind: "delete-managed-name", harness: "Pi", path: piSkill, name: "tdd" },
      {
        kind: "delete-managed-link",
        harness: "Pi",
        path: join(home, ".pi", "agent", "AGENTS.md"),
        expectedTarget: join(home, ".ferry", "box", "AGENTS.md"),
      },
    ]);
    expect(remote.unmanaged).toEqual([]);
    expect(existsSync(piSkill)).toBe(false);
    expect(existsSync(join(home, ".pi", "agent", "AGENTS.md"))).toBe(false);
    expect(readFileSync(join(home, ".pi", "agent", "settings.json"), "utf8")).toBe("{}");
    expect(readFileSync(join(home, ".pi", "agent", "skills", "mine", "SKILL.md"), "utf8")).toBe("own skill");
    expect(realpathSync(join(home, ".pi", "agent", "skills", "other"))).toBe(realpathSync(elsewhere));
    expect(realpathSync(join(home, ".codex", "AGENTS.md"))).toBe(realpathSync(join(home, ".ferry", "box", "AGENTS.md")));

    // A second sync finds nothing more to remove.
    expect((await apply({ ...input, link })).actions).toEqual([]);
  });

  test("removes the Claude skill, instruction, and root links, and keeps a live root and a link that points elsewhere", async () => {
    const root = makeRoot("remote-off-claude");
    const checkout = makeCheckout(root, ["unslop"]);
    write(join(checkout, "roots", ".claude", "agents", "reviewer.md"), "review agent");
    const home = join(root, "home");
    mkdirSync(home);
    const link = new ShellLink(root);
    await apply({ checkout, targetHome: home, harnesses: BUILTIN_HARNESSES, link });
    write(join(home, ".claude", "commands", "mine.md"), "own command");
    write(join(home, ".claude", "settings.json"), '{"permissions":{}}');

    const plan = await apply({ checkout, targetHome: home, harnesses: withoutHarness("claude"), offHarnesses: harness("claude"), link });

    expect(plan.actions.map((action) => [action.kind, action.path])).toEqual([
      ["delete-managed-name", join(home, ".claude", "skills", "unslop")],
      ["delete-managed-link", join(home, ".claude", "CLAUDE.md")],
      ["delete-managed-link", join(home, ".claude", "agents")],
    ]);
    expect(existsSync(join(home, ".claude", "skills", "unslop"))).toBe(false);
    expect(existsSync(join(home, ".claude", "CLAUDE.md"))).toBe(false);
    expect(existsSync(join(home, ".claude", "agents"))).toBe(false);
    expect(existsSync(join(checkout, "roots", ".claude", "agents", "reviewer.md"))).toBe(true);
    expect(readFileSync(join(home, ".claude", "commands", "mine.md"), "utf8")).toBe("own command");
    expect(readFileSync(join(home, ".claude", "settings.json"), "utf8")).toBe('{"permissions":{}}');
    expect(realpathSync(join(home, ".agents", "skills", "unslop"))).toBe(realpathSync(join(checkout, "skills", "unslop")));

    // A link that the operator made to another file is not Ferry's.
    const own = join(root, "own-claude.md");
    write(own, "own instructions");
    symlinkSync(own, join(home, ".claude", "CLAUDE.md"));
    const again = await apply({ checkout, targetHome: home, harnesses: withoutHarness("claude"), offHarnesses: harness("claude"), link });
    expect(again.actions).toEqual([]);
    expect(readFileSync(join(home, ".claude", "CLAUDE.md"), "utf8")).toBe("own instructions");
  });
});
