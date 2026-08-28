import { afterEach, describe, expect, test } from "bun:test";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { ApplyError, apply, commitApply, planApply } from "../src/apply.ts";

const roots: string[] = [];
const skillRoots = [
  ".agents/skills",
  ".claude/skills",
  ".codex/skills",
  ".pi/agent/skills",
  ".cursor/skills",
] as const;

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function makeRoot(label: string): string {
  const root = realpathSync(mkdtempSync(join(tmpdir(), `ferry-${label}-`)));
  roots.push(root);
  return root;
}

function write(path: string, body: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, body);
}

function makeCheckout(skills: readonly string[] = ["tdd", "unslop"]): string {
  const checkout = makeRoot("store");
  for (const name of skills) write(join(checkout, "skills", name, "SKILL.md"), name);
  write(join(checkout, "AGENTS.md"), "global instructions");
  return checkout;
}

describe("apply plan and commit", () => {
  test("every managed harness sees the same snapshot names", () => {
    const checkout = makeCheckout();
    const home = makeRoot("home");

    const plan = planApply({ checkout, targetHome: home });
    expect(plan.actions.filter((action) => action.kind === "create-symlink")).toHaveLength(14);
    commitApply(plan);

    for (const root of skillRoots) {
      expect(readdirSync(join(home, root)).sort()).toEqual(["tdd", "unslop"]);
      for (const name of ["tdd", "unslop"]) {
        expect(realpathSync(join(home, root, name))).toBe(join(checkout, "skills", name));
      }
    }
    expect(realpathSync(join(home, "AGENTS.md"))).toBe(join(checkout, "AGENTS.md"));
    expect(realpathSync(join(home, ".claude", "CLAUDE.md"))).toBe(join(checkout, "AGENTS.md"));
    expect(realpathSync(join(home, ".codex", "AGENTS.md"))).toBe(join(checkout, "AGENTS.md"));
    expect(realpathSync(join(home, ".pi", "agent", "AGENTS.md"))).toBe(join(checkout, "AGENTS.md"));
  });

  test("a deleted snapshot name is planned and removed", () => {
    const checkout = makeCheckout();
    const home = makeRoot("home");
    commitApply(planApply({ checkout, targetHome: home }));
    rmSync(join(checkout, "skills", "tdd"), { recursive: true });

    const plan = planApply({ checkout, targetHome: home });

    expect(plan.actions.filter((action) => action.kind === "delete-managed-name")).toHaveLength(5);
    commitApply(plan);
    for (const root of skillRoots) expect(existsSync(join(home, root, "tdd"))).toBe(false);
  });

  test("dry-run returns the plan without writing", () => {
    const checkout = makeCheckout();
    const home = makeRoot("home");

    const plan = apply({ checkout, targetHome: home, dryRun: true });

    expect(plan.actions.length).toBeGreaterThan(0);
    expect(readdirSync(home)).toEqual([]);
  });

  test("a live non-empty skill directory refuses before any write", () => {
    const checkout = makeCheckout(["unslop"]);
    const home = makeRoot("home");
    write(join(home, ".claude", "skills", "unslop", "local.md"), "box copy");

    const plan = planApply({ checkout, targetHome: home });

    expect(plan.actions).toContainEqual({
      kind: "refuse-live-directory",
      harness: "Claude",
      path: join(home, ".claude", "skills", "unslop"),
    });
    expect(() => commitApply(plan)).toThrow(ApplyError);
    expect(existsSync(join(home, ".agents"))).toBe(false);
    expect(readFileSync(join(home, ".claude", "skills", "unslop", "local.md"), "utf8")).toBe(
      "box copy",
    );
  });

  test("force moves a live directory to a timestamped backup, then links", () => {
    const checkout = makeCheckout(["unslop"]);
    const home = makeRoot("home");
    const live = join(home, ".claude", "skills", "unslop");
    write(join(live, "local.md"), "box copy");

    const plan = planApply({
      checkout,
      targetHome: home,
      force: true,
      timestamp: "20260828T101112Z",
    });
    const action = plan.actions.find(
      (candidate) => candidate.kind === "backup-and-link" && candidate.path === live,
    );
    expect(action).toEqual({
      kind: "backup-and-link",
      harness: "Claude",
      path: live,
      target: join(checkout, "skills", "unslop"),
      backupPath: `${live}.ferry-backup-20260828T101112Z`,
    });

    commitApply(plan);

    expect(realpathSync(live)).toBe(join(checkout, "skills", "unslop"));
    expect(readFileSync(`${live}.ferry-backup-20260828T101112Z/local.md`, "utf8")).toBe("box copy");
    expect(existsSync(join(checkout, "skills", "unslop", "local.md"))).toBe(false);
  });

  test("a wrong symlink is repaired", () => {
    const checkout = makeCheckout(["unslop"]);
    const home = makeRoot("home");
    const old = makeRoot("old-store");
    write(join(old, "SKILL.md"), "old");
    const path = join(home, ".codex", "skills", "unslop");
    mkdirSync(dirname(path), { recursive: true });
    symlinkSync(old, path);

    const plan = planApply({ checkout, targetHome: home });

    expect(plan.actions).toContainEqual({
      kind: "repair-symlink",
      harness: "Codex",
      path,
      target: join(checkout, "skills", "unslop"),
    });
    commitApply(plan);
    expect(readlinkSync(path)).toBe(join(checkout, "skills", "unslop"));
  });

  test("unmanaged extras are reported and preserved", () => {
    const checkout = makeCheckout(["unslop"]);
    const home = makeRoot("home");
    const extra = join(home, ".cursor", "skills", "local-only", "SKILL.md");
    write(extra, "local");

    const plan = apply({ checkout, targetHome: home });

    expect(plan.unmanaged).toContainEqual({
      harness: "Cursor Agent",
      path: dirname(extra),
      name: "local-only",
    });
    expect(readFileSync(extra, "utf8")).toBe("local");
  });

  test("auth, sessions, and logs beside managed paths stay unchanged", () => {
    const checkout = makeCheckout(["unslop"]);
    const home = makeRoot("home");
    const state = {
      ".claude/.credentials.json": "claude auth",
      ".codex/auth.json": "codex auth",
      ".pi/agent/sessions/run.jsonl": "pi session",
      ".cursor/logs/agent.log": "cursor log",
    };
    for (const [path, body] of Object.entries(state)) write(join(home, path), body);

    apply({ checkout, targetHome: home });

    for (const [path, body] of Object.entries(state)) {
      expect(readFileSync(join(home, path), "utf8")).toBe(body);
    }
  });

  test("a commit failure stops at the named harness", () => {
    const checkout = makeCheckout(["unslop"]);
    const home = makeRoot("home");
    writeFileSync(join(home, ".claude"), "blocks the Claude directory");
    const plan = planApply({ checkout, targetHome: home });

    expect(() => commitApply(plan)).toThrow(
      expect.objectContaining({ code: "commit-failed", harness: "Claude" }),
    );
    expect(lstatSync(join(home, ".agents", "skills", "unslop")).isSymbolicLink()).toBe(true);
    expect(existsSync(join(home, ".codex"))).toBe(false);
  });
});
