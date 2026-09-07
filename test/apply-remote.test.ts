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
import { ApplyError, apply, planApply } from "../src/apply.ts";
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

    expect(remote).toEqual(local);
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
