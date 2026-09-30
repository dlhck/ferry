import { afterEach, describe, expect, test } from "bun:test";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { runBoxUninstall, type BoxUninstallDependencies } from "../src/box.ts";
import { boxUninstallLines, commitBoxUninstall, planBoxUninstall } from "../src/box-uninstall.ts";
import { readConfig, writeConfig, type BoxesOperatorConfig } from "../src/config.ts";
import { errorInfo } from "../src/output.ts";
import { noProgress } from "../src/progress.ts";
import { BUILTIN_HARNESSES } from "../src/registry/builtin.ts";
import { profileBlockCommand } from "../src/tools/path.ts";
import { recordProgress } from "./fake-progress.ts";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const CONFIG = [
  "version = 1",
  'publisher = "operator"',
  'snapshot_url = "snapshot.git"',
  'default_box = "b"',
  "",
  "[box.a]",
  'transport = "ssh"',
  'destination = "user@box-a.example"',
  "",
  "[box.b]",
  'transport = "ssh"',
  'destination = "user@box.example"',
  "",
].join("\n");

/**
 * A fake box. Each Link command runs in `sh` in a temporary home, with a fake
 * `systemctl` that logs its arguments. With `systemctl: "fails"`, it exits with 1.
 */
function fakeBox(options: { readonly systemctl?: "fails" } = {}) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "ferry-box-uninstall-")));
  roots.push(root);
  const home = join(root, "home");
  const bin = join(root, "bin");
  const log = join(root, "systemctl.log");
  mkdirSync(home);
  mkdirSync(bin);
  writeFileSync(log, "");
  writeFileSync(
    join(bin, "systemctl"),
    `#!/bin/sh\necho "$*" >> ${JSON.stringify(log)}\n${options.systemctl === "fails" ? "echo 'Failed to connect to bus' >&2\nexit 1\n" : ""}`,
  );
  chmodSync(join(bin, "systemctl"), 0o755);
  const commands: string[] = [];
  const link = {
    async run(command: string) {
      commands.push(command);
      const process = Bun.spawn(["/bin/sh", "-c", command], {
        cwd: home,
        env: { ...Bun.env, HOME: home, PATH: `${bin}:${Bun.env.PATH}` },
        stdin: "ignore",
        stdout: "pipe",
        stderr: "pipe",
      });
      const [exitCode, stdout, stderr] = await Promise.all([
        process.exited,
        new Response(process.stdout).text(),
        new Response(process.stderr).text(),
      ]);
      return exitCode === 0
        ? ({ ok: true, address: "box", stdout, stderr } as const)
        : ({ ok: false, error: { code: "command-failed", origin: "box", message: stderr.trim() || `exit ${exitCode}` } } as const);
    },
  };
  const file = (path: string, text = "") => {
    mkdirSync(dirname(join(home, path)), { recursive: true });
    writeFileSync(join(home, path), text);
  };
  const symlink = (path: string, target: string) => {
    mkdirSync(dirname(join(home, path)), { recursive: true });
    symlinkSync(target, join(home, path));
  };
  return {
    home,
    link,
    commands,
    file,
    symlink,
    read: (path: string) => readFileSync(join(home, path), "utf8"),
    exists: (path: string) => existsSync(join(home, path)),
    isLink: (path: string) => lstatSync(join(home, path), { throwIfNoEntry: false })?.isSymbolicLink() === true,
    systemctl: () => readFileSync(log, "utf8").split("\n").filter((line) => line !== ""),
  };
}

const OLD = "20260101T000000Z";
const NEW = "20260202T000000Z";

/** A box after `ferry install`, `ferry integrations enable paseo`, and a forced sync, with files of the box user. */
async function ferryBox(options: { readonly systemctl?: "fails" } = {}) {
  const box = fakeBox(options);
  const { home, file, symlink } = box;
  // The Ferry files.
  file(".ferry/store/AGENTS.md", "shared\n");
  file(".ferry/store/skills/review/SKILL.md", "review\n");
  file(".ferry/store/roots/.claude/agents/planner.md", "planner\n");
  file(".ferry/box/AGENTS.md", "header\n\nshared\n");
  file(".ferry/box/identity.json", '{"name":"b","boxInstructions":false}\n');
  file(".ferry/box.json", '{"mode":"box","version":"1.0.0"}\n');
  file(".ferry/exposed/123.json", "{}\n");
  file(".local/bin/ferry", "binary\n");
  file(".config/systemd/user/ferry-paseo.service", "[Unit]\n");
  file(".config/systemd/user/paseo.service", "[Unit]\n");
  file(".profile", "export EDITOR=vi\n");
  expect((await box.link.run(profileBlockCommand([".local/bin"]))).ok).toBe(true);
  // The links of Apply. The skill links are absolute, as Apply writes them.
  symlink(".agents/skills/review", join(home, ".ferry/store/skills/review"));
  symlink(".claude/skills/review", join(home, ".ferry/store/skills/review"));
  symlink(".codex/skills/review", "../../.ferry/store/skills/review");
  symlink("AGENTS.md", join(home, ".ferry/box/AGENTS.md"));
  symlink(".claude/CLAUDE.md", join(home, ".ferry/box/AGENTS.md"));
  symlink(".codex/AGENTS.md", join(home, ".ferry/store/AGENTS.md"));
  symlink(".claude/agents", join(home, ".ferry/store/roots/.claude/agents"));
  // The backups of `ferry sync --force`, and the backup of `ferry adopt`.
  file(`.ferry/backups/${OLD}/claude/CLAUDE.md`, "first box file\n");
  file(`.ferry/backups/${NEW}/claude/CLAUDE.md`, "last box file\n");
  file(`.ferry/backups/${NEW}/claude/.claude/agents/own.md`, "own agent\n");
  file(`.ferry/backups/${NEW}/adopt/.claude/skills/made-here/SKILL.md`, "adopted\n");
  // The files of the box user.
  file(".claude/skills/own/SKILL.md", "own\n");
  symlink(".claude/skills/elsewhere", "/opt/skills/elsewhere");
  file(".claude/.credentials.json", "login\n");
  file(".claude/settings.json", '{"model":"opus"}\n');
  file(".codex/auth.json", "login\n");
  file(".config/gh/hosts.yml", "login\n");
  file(".ssh/ferry_snapshot", "key\n");
  file(".paseo/config.json", "{}\n");
  file(".local/bin/claude", "tool\n");
  file(".ferry/trash/project/file.txt", "moved\n");
  file("project/.git/HEAD", "ref\n");
  return box;
}

const KEPT = [
  ".claude/skills/own/SKILL.md",
  ".claude/.credentials.json",
  ".claude/settings.json",
  ".codex/auth.json",
  ".config/gh/hosts.yml",
  ".ssh/ferry_snapshot",
  ".paseo/config.json",
  ".local/bin/claude",
  ".config/systemd/user/paseo.service",
  ".ferry/trash/project/file.txt",
  "project/.git/HEAD",
];

describe("planBoxUninstall", () => {
  test("names the services, the Ferry links with their newest backup, the PATH block, and the Ferry files", async () => {
    const box = await ferryBox();

    const plan = await planBoxUninstall(BUILTIN_HARNESSES, box.link);

    expect(plan).toEqual({
      home: box.home,
      services: ["ferry-paseo.service"],
      links: [
        { path: ".agents/skills/review", link: join(box.home, ".ferry/store/skills/review"), backup: null },
        { path: ".claude/CLAUDE.md", link: join(box.home, ".ferry/box/AGENTS.md"), backup: `.ferry/backups/${NEW}/claude/CLAUDE.md` },
        { path: ".claude/agents", link: join(box.home, ".ferry/store/roots/.claude/agents"), backup: `.ferry/backups/${NEW}/claude/.claude/agents` },
        { path: ".claude/skills/review", link: join(box.home, ".ferry/store/skills/review"), backup: null },
        { path: ".codex/AGENTS.md", link: join(box.home, ".ferry/store/AGENTS.md"), backup: null },
        { path: ".codex/skills/review", link: "../../.ferry/store/skills/review", backup: null },
        { path: "AGENTS.md", link: join(box.home, ".ferry/box/AGENTS.md"), backup: null },
      ],
      profileBlock: true,
      paths: [".ferry/box", ".ferry/exposed", ".ferry/store", ".local/bin/ferry", ".ferry/box.json"],
    });
    expect(boxUninstallLines(plan)).toEqual([
      "Stop and remove the user services: ferry-paseo.service. A stopped service stops its agents.",
      "Remove the link ~/.agents/skills/review",
      `Remove the link ~/.claude/CLAUDE.md and move ~/.ferry/backups/${NEW}/claude/CLAUDE.md back`,
      `Remove the link ~/.claude/agents and move ~/.ferry/backups/${NEW}/claude/.claude/agents back`,
      "Remove the link ~/.claude/skills/review",
      "Remove the link ~/.codex/AGENTS.md",
      "Remove the link ~/.codex/skills/review",
      "Remove the link ~/AGENTS.md",
      "Remove the ferry PATH block of ~/.profile",
      "Remove ~/.ferry/box",
      "Remove ~/.ferry/exposed",
      "Remove ~/.ferry/store",
      "Remove ~/.local/bin/ferry",
      "Remove ~/.ferry/box.json",
      "Ferry keeps the logins and credentials, the project directories, the installed tools, ~/.paseo, and the values that ferry sync merged into the config files of the box.",
    ]);
    expect(box.systemctl()).toEqual([]);
    expect(box.exists(".ferry/store")).toBe(true);
  });

  test("plans nothing for a box without Ferry, and keeps a ferry binary that has no box marker", async () => {
    const box = fakeBox();
    box.file(".local/bin/ferry", "binary\n");
    box.file(".profile", "export EDITOR=vi\n");

    const plan = await planBoxUninstall(BUILTIN_HARNESSES, box.link);

    expect(plan).toEqual({ home: box.home, services: [], links: [], profileBlock: false, paths: [] });
    expect(boxUninstallLines(plan)[0]).toBe("The box has no Ferry files.");
    expect(await commitBoxUninstall(plan, box.link)).toEqual([]);
    expect(box.read(".local/bin/ferry")).toBe("binary\n");
    expect(box.read(".profile")).toBe("export EDITOR=vi\n");
  });

  test("refuses a box that is an operator machine too", async () => {
    const box = await ferryBox();
    box.file(".ferry/config.toml", "version = 1\n");

    const error = await planBoxUninstall(BUILTIN_HARNESSES, box.link).catch((error) => error);

    expect(error.message).toContain("The box has a Ferry operator config, ~/.ferry/config.toml");
    expect(errorInfo(error)).toMatchObject({ code: "refused", hint: "Run ferry uninstall on that machine." });
  });
});

describe("commitBoxUninstall", () => {
  test("removes Ferry and leaves no link into the store, and keeps the files of the box user", async () => {
    const box = await ferryBox();

    const remaining = await commitBoxUninstall(await planBoxUninstall(BUILTIN_HARNESSES, box.link), box.link);

    expect(box.systemctl()).toEqual(["--user disable --now ferry-paseo.service", "--user daemon-reload"]);
    expect(box.exists(".config/systemd/user/ferry-paseo.service")).toBe(false);
    for (const path of [".agents/skills/review", ".claude/skills/review", ".codex/skills/review", "AGENTS.md", ".codex/AGENTS.md"]) {
      expect(box.isLink(path)).toBe(false);
      expect(box.exists(path)).toBe(false);
    }
    // The newest backup comes back. The older backup and the adopt backup stay.
    expect(box.isLink(".claude/CLAUDE.md")).toBe(false);
    expect(box.read(".claude/CLAUDE.md")).toBe("last box file\n");
    expect(box.isLink(".claude/agents")).toBe(false);
    expect(box.read(".claude/agents/own.md")).toBe("own agent\n");
    expect(box.read(`.ferry/backups/${OLD}/claude/CLAUDE.md`)).toBe("first box file\n");
    expect(box.read(`.ferry/backups/${NEW}/adopt/.claude/skills/made-here/SKILL.md`)).toBe("adopted\n");
    expect(box.exists(`.ferry/backups/${NEW}/claude`)).toBe(false);
    expect(box.read(".profile")).toBe("export EDITOR=vi\n");
    for (const path of [".ferry/store", ".ferry/box", ".ferry/exposed", ".ferry/box.json", ".local/bin/ferry"]) {
      expect(box.exists(path)).toBe(false);
    }
    expect(box.isLink(".claude/skills/elsewhere")).toBe(true);
    for (const path of KEPT) expect(box.exists(path)).toBe(true);
    expect(remaining).toEqual(["backups", "trash"]);
  });

  test("removes ~/.ferry and a profile that has only the ferry block", async () => {
    const box = fakeBox();
    box.file(".ferry/store/skills/review/SKILL.md", "review\n");
    box.symlink(".claude/skills/review", join(box.home, ".ferry/store/skills/review"));
    box.file(`.ferry/backups/${NEW}/claude/review/SKILL.md`, "own review\n");
    await box.link.run(profileBlockCommand([".local/bin"]));

    const remaining = await commitBoxUninstall(await planBoxUninstall(BUILTIN_HARNESSES, box.link), box.link);

    expect(remaining).toEqual([]);
    expect(readdirSync(box.home).sort()).toEqual([".claude"]);
    expect(box.read(".claude/skills/review/SKILL.md")).toBe("own review\n");
    expect(box.systemctl()).toEqual([]);
  });

  test("keeps a link that changed after the plan", async () => {
    const box = await ferryBox();
    const plan = await planBoxUninstall(BUILTIN_HARNESSES, box.link);
    rmSync(join(box.home, ".claude/CLAUDE.md"));
    box.symlink(".claude/CLAUDE.md", "/opt/own/CLAUDE.md");

    await commitBoxUninstall(plan, box.link);

    expect(box.isLink(".claude/CLAUDE.md")).toBe(true);
    expect(box.read(`.ferry/backups/${NEW}/claude/CLAUDE.md`)).toBe("last box file\n");
  });

  test("a service that does not stop removes nothing", async () => {
    const box = await ferryBox({ systemctl: "fails" });
    const plan = await planBoxUninstall(BUILTIN_HARNESSES, box.link);

    const error = await commitBoxUninstall(plan, box.link).catch((error) => error);

    expect(error.message).toBe("box/command-failed: Failed to connect to bus");
    expect(errorInfo(error).code).toBe("box-command-failed");
    expect(box.exists(".config/systemd/user/ferry-paseo.service")).toBe(true);
    expect(box.isLink(".claude/CLAUDE.md")).toBe(true);
    expect(box.exists(".ferry/store/AGENTS.md")).toBe(true);
    expect(box.read(".profile")).toContain("ferry PATH");
  });
});

describe("ferry box remove --uninstall", () => {
  function operator(
    box: { readonly link: ReturnType<BoxUninstallDependencies["createLink"]> },
    overrides: Partial<BoxUninstallDependencies> = {},
    config = CONFIG,
  ) {
    const home = realpathSync(mkdtempSync(join(tmpdir(), "ferry-box-operator-")));
    roots.push(home);
    mkdirSync(join(home, ".ferry"));
    writeFileSync(join(home, ".ferry/config.toml"), config);
    const lines: string[] = [];
    const warnings: string[] = [];
    const links: unknown[] = [];
    const questions: string[] = [];
    const deps: BoxUninstallDependencies = {
      readConfig: () => readConfig(home),
      writeConfig: (config: BoxesOperatorConfig) => writeConfig(config, home),
      createLink: (options) => {
        links.push(options);
        return box.link;
      },
      harnesses: BUILTIN_HARNESSES,
      confirmName: async (message) => {
        questions.push(message);
        return "b";
      },
      writeLine: (line) => lines.push(line),
      warn: (line) => warnings.push(line),
      progress: noProgress,
      ...overrides,
    };
    return { deps, lines, warnings, links, questions, boxes: () => readConfig(home)?.boxes?.map((entry) => entry.name), text: () => readFileSync(join(home, ".ferry/config.toml"), "utf8") };
  }

  const offline = {
    link: {
      async run() {
        return { ok: false, error: { origin: "network", code: "host-offline", message: "box.example is offline" } } as const;
      },
    },
  };

  test("asks for the box name after the plan, removes Ferry from the box, then removes the box from the config", async () => {
    const box = await ferryBox();
    const progress = recordProgress();
    const { deps, lines, warnings, links, questions, boxes } = operator(box, { progress });

    const result = await runBoxUninstall({ name: "b", yes: false, dryRun: false }, deps);

    expect(links).toEqual([{ destination: "user@box.example" }]);
    expect(questions).toEqual(["Type b to remove Ferry from the box."]);
    expect(progress.events.indexOf("pause")).toBeGreaterThan(progress.events.indexOf("start:Reading the box"));
    expect(progress.events.indexOf("pause")).toBeLessThan(progress.events.indexOf("start:Removing Ferry from the box"));
    expect(box.exists(".ferry/store")).toBe(false);
    expect(box.isLink("AGENTS.md")).toBe(false);
    expect(boxes()).toEqual(["a"]);
    expect(result).toMatchObject({ name: "b", defaultBoxRemoved: true, uninstall: { dryRun: false, remaining: ["backups", "trash"] } });
    expect(result?.uninstall.plan.services).toEqual(["ferry-paseo.service"]);
    expect(lines[0]).toBe("Remove Ferry from box b: ssh user@box.example");
    expect(lines.slice(-3)).toEqual([
      "Removed Ferry from box b. ~/.ferry stays on the box with: backups, trash.",
      "Removed box b from the config.",
      "Warning: box b was the default_box. Ferry removed default_box. Set a new one with ferry box default <name>.",
    ]);
    expect(warnings).toEqual(lines.slice(-1));
  });

  test("--yes asks nothing", async () => {
    const box = await ferryBox();
    const { deps, questions, boxes } = operator(box);

    await runBoxUninstall({ name: "b", yes: true, dryRun: false }, deps);

    expect(questions).toEqual([]);
    expect(box.exists(".ferry/store")).toBe(false);
    expect(boxes()).toEqual(["a"]);
  });

  test("another answer than the box name changes nothing", async () => {
    const box = await ferryBox();
    const { deps, lines, text } = operator(box, { confirmName: async () => "a" });

    expect(await runBoxUninstall({ name: "b", yes: false, dryRun: false }, deps)).toBeNull();

    expect(lines.at(-1)).toBe("Box remove cancelled.");
    expect(box.systemctl()).toEqual([]);
    expect(box.isLink("AGENTS.md")).toBe(true);
    expect(text()).toBe(CONFIG);
  });

  test("--dry-run prints the plan, asks nothing, and changes nothing", async () => {
    const box = await ferryBox();
    const { deps, lines, questions, text } = operator(box);

    const result = await runBoxUninstall({ name: "b", yes: false, dryRun: true }, deps);

    expect(result).toMatchObject({ name: "b", defaultBoxRemoved: false, uninstall: { dryRun: true, remaining: [] } });
    expect(lines).toContain("Remove ~/.ferry/store");
    expect(lines.at(-1)).toBe("Dry run: Ferry made no changes.");
    expect(questions).toEqual([]);
    expect(box.commands).toHaveLength(2);
    expect(box.exists(".ferry/store")).toBe(true);
    expect(box.isLink("AGENTS.md")).toBe(true);
    expect(text()).toBe(CONFIG);
  });

  test("a box that Ferry cannot reach stays in the config", async () => {
    const { deps, questions, text } = operator(offline);

    const error = await runBoxUninstall({ name: "b", yes: true, dryRun: false }, deps).catch((error) => error);

    expect(error.message).toBe(
      "Ferry could not read box b: network/host-offline: box.example is offline. Ferry changed nothing. To remove the box from the config only, run ferry box remove b.",
    );
    expect(errorInfo(error).code).toBe("box-offline");
    expect(questions).toEqual([]);
    expect(text()).toBe(CONFIG);
  });

  test("a box that is an operator machine too stays as it is, and stays in the config", async () => {
    const box = await ferryBox();
    box.file(".ferry/config.toml", "version = 1\n");
    const { deps, text } = operator(box);

    const error = await runBoxUninstall({ name: "b", yes: true, dryRun: false }, deps).catch((error) => error);

    expect(error.message).toStartWith("The box has a Ferry operator config, ~/.ferry/config.toml");
    expect(box.exists(".ferry/store")).toBe(true);
    expect(text()).toBe(CONFIG);
  });

  test("a failed box step keeps the box in the config", async () => {
    const box = await ferryBox({ systemctl: "fails" });
    const { deps, text } = operator(box);

    const error = await runBoxUninstall({ name: "b", yes: true, dryRun: false }, deps).catch((error) => error);

    expect(error.message).toBe(
      "Ferry could not remove Ferry from box b: box/command-failed: Failed to connect to bus. The box stays in the config. Correct the problem, then run the command again. To remove the box from the config only, run ferry box remove b.",
    );
    expect(errorInfo(error).code).toBe("box-command-failed");
    expect(box.exists(".ferry/store")).toBe(true);
    expect(text()).toBe(CONFIG);
  });

  test("refuses an unknown box and the last box before it connects", async () => {
    const unknown = operator(offline);
    await expect(runBoxUninstall({ name: "c", yes: true, dryRun: false }, unknown.deps)).rejects.toThrow("unknown box c. Known boxes: a, b.");
    expect(unknown.links).toEqual([]);

    const last = operator(offline, {}, CONFIG.replace('default_box = "b"\n', "").split("[box.b]")[0]);
    await expect(runBoxUninstall({ name: "a", yes: true, dryRun: false }, last.deps)).rejects.toThrow("box a is the last box");
    expect(last.links).toEqual([]);
  });
});
