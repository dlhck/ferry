import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { runBoxAdd, runBoxDefault, runBoxList, runBoxRemove, type BoxCommandDependencies } from "../src/box.ts";
import { readConfig, writeConfig, type BoxesOperatorConfig } from "../src/config.ts";
import type { LinkOptions } from "../src/link.ts";
import { noProgress } from "../src/progress.ts";
import { recordProgress } from "./fake-progress.ts";

const homes: string[] = [];

afterEach(() => {
  for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true });
});

const HOST_CONFIG = [
  "version = 1",
  'publisher = "operator"',
  'snapshot_url = "snapshot.git"',
  "",
  "[host]",
  'transport = "ssh"',
  'destination = "dev@box-a.example"',
  "",
  "[integrations]",
  "paseo = true",
  "",
].join("\n");

const BOXES_CONFIG = [
  "version = 1",
  'publisher = "operator"',
  'snapshot_url = "snapshot.git"',
  'default_box = "a"',
  "",
  "[box.a]",
  'transport = "ssh"',
  'destination = "dev@box-a.example"',
  "",
  "[box.b]",
  'tailscale = "box-b"',
  'ssh_user = "dev"',
  "",
].join("\n");

function makeHome(config?: string): string {
  const home = realpathSync(mkdtempSync(join(tmpdir(), "ferry-box-")));
  homes.push(home);
  if (config !== undefined) {
    const path = join(home, ".ferry/config.toml");
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, config);
  }
  return home;
}

function dependencies(home: string, overrides: Partial<BoxCommandDependencies> = {}) {
  const lines: string[] = [];
  const links: LinkOptions[] = [];
  const commands: string[] = [];
  const confirms: string[] = [];
  const deps: BoxCommandDependencies = {
    readConfig: () => readConfig(home),
    writeConfig: (config: BoxesOperatorConfig) => writeConfig(config, home),
    createLink: (options) => {
      links.push(options);
      return {
        async run(command) {
          commands.push(command);
          const stdout = command.includes("ssh-keygen -F") ? "trusted\n" : "";
          return { ok: true, address: "100.64.0.9", stdout, stderr: "" };
        },
      };
    },
    checkAgent: async () => ({ ok: true }),
    approveHostKeys: async () => true,
    confirm: async (message) => {
      confirms.push(message);
      return true;
    },
    writeLine: (line) => lines.push(line),
    progress: noProgress,
    ...overrides,
  };
  return { deps, lines, links, commands, confirms };
}

function configText(home: string): string {
  return readFileSync(join(home, ".ferry/config.toml"), "utf8");
}

describe("ferry box list", () => {
  test("lists a [host] config as one box named default, marked as the default", () => {
    const { deps, lines } = dependencies(makeHome(HOST_CONFIG));

    runBoxList(deps);

    expect(lines).toEqual([
      "Box      Transport  Destination        Default",
      "default  ssh        dev@box-a.example  yes",
    ]);
  });

  test("lists each box in config order and marks default_box", () => {
    const { deps, lines } = dependencies(makeHome(BOXES_CONFIG));

    runBoxList(deps);

    expect(lines).toEqual([
      "Box  Transport  Destination        Default",
      "a    ssh        dev@box-a.example  yes",
      "b    tailscale  dev@box-b",
    ]);
  });

  test("marks no box when there is more than one box and no default_box", () => {
    const { deps, lines } = dependencies(makeHome(BOXES_CONFIG.replace('default_box = "a"\n', "")));

    runBoxList(deps);

    expect(lines.slice(1)).toEqual(["a    ssh        dev@box-a.example", "b    tailscale  dev@box-b"]);
  });

  test("tells the operator to run ferry init when there is no config", () => {
    const { deps } = dependencies(makeHome());

    expect(() => runBoxList(deps)).toThrow("Run ferry init");
  });
});

describe("ferry box add", () => {
  test("checks the new box like init, then adds its table and keeps the other boxes", async () => {
    const home = makeHome(BOXES_CONFIG);
    const { deps, links, commands, lines, confirms } = dependencies(home);

    await runBoxAdd({ name: "c", sshDestination: "dev@box-c.example", yes: false }, deps);

    expect(links).toEqual([{ destination: "dev@box-c.example" }]);
    expect(commands).toEqual(["true"]);
    expect(confirms).toEqual([]);
    expect(readConfig(home)?.boxes?.map((box) => box.name)).toEqual(["a", "b", "c"]);
    expect(readConfig(home)?.boxes?.[2]).toEqual({ name: "c", host: { transport: "ssh", destination: "dev@box-c.example" } });
    expect(readConfig(home)?.defaultBox).toBe("a");
    expect(lines).toEqual(["Add box c: ssh dev@box-c.example", "Added box c."]);
  });

  test("adds a Tailscale box", async () => {
    const home = makeHome(BOXES_CONFIG);
    const { deps, links } = dependencies(home);

    await runBoxAdd({ name: "c", host: "box-c", sshUser: "dev", yes: false }, deps);

    expect(links).toEqual([{ host: "box-c", user: "dev" }]);
    expect(readConfig(home)?.boxes?.[2]).toEqual({ name: "c", host: { tailscale: "box-c", sshUser: "dev" } });
  });

  test("runs the agent, host key, and snapshot access checks of init for an SSH snapshot", async () => {
    const home = makeHome(BOXES_CONFIG.replace("snapshot.git", "git@github.com:you/ferry-snapshot.git"));
    const progress = recordProgress();
    const { deps, commands } = dependencies(home, { progress });

    await runBoxAdd({ name: "c", sshDestination: "dev@box-c.example", yes: true }, deps);

    expect(commands).toHaveLength(3);
    expect(commands[0]).toContain("ssh-add -l");
    expect(commands[1]).toContain("ssh-keygen -F 'github.com'");
    expect(commands[2]).toBe("git ls-remote 'git@github.com:you/ferry-snapshot.git' HEAD");
    expect(progress.events).toContain("skip:Trusting the SSH host keys of github.com on the box");
  });

  test("writes nothing when the new box cannot be reached", async () => {
    const home = makeHome(BOXES_CONFIG);
    const before = configText(home);
    const { deps } = dependencies(home, {
      createLink: () => ({
        async run() {
          return { ok: false, error: { origin: "network", code: "host-offline", message: "box-c is offline" } };
        },
      }),
    });

    await expect(runBoxAdd({ name: "c", sshDestination: "dev@box-c.example", yes: true }, deps)).rejects.toThrow(
      "box-c is offline",
    );
    expect(configText(home)).toBe(before);
  });

  test("refuses an invalid name, a known name, and bad transport flags before it connects", async () => {
    const home = makeHome(BOXES_CONFIG);
    const { deps, links } = dependencies(home);

    await expect(runBoxAdd({ name: "Box", sshDestination: "dev@x.example", yes: true }, deps)).rejects.toThrow(
      "invalid box name Box",
    );
    await expect(runBoxAdd({ name: "all", sshDestination: "dev@x.example", yes: true }, deps)).rejects.toThrow(
      "invalid box name all",
    );
    await expect(runBoxAdd({ name: "b", sshDestination: "dev@x.example", yes: true }, deps)).rejects.toThrow(
      "box b is already in the config",
    );
    await expect(runBoxAdd({ name: "c", yes: true }, deps)).rejects.toThrow(
      "--ssh-destination <destination>, or --host <host> with --ssh-user <user>",
    );
    await expect(runBoxAdd({ name: "c", host: "box-c", yes: true }, deps)).rejects.toThrow(
      "--ssh-destination <destination>, or --host <host> with --ssh-user <user>",
    );
    await expect(
      runBoxAdd({ name: "c", host: "box-c", sshUser: "dev", sshDestination: "dev@x.example", yes: true }, deps),
    ).rejects.toThrow("--ssh-destination cannot be combined with --host or --ssh-user");
    expect(links).toEqual([]);
  });

  test("tells the operator to run ferry init when there is no config", async () => {
    const { deps } = dependencies(makeHome());

    await expect(runBoxAdd({ name: "c", sshDestination: "dev@box-c.example", yes: true }, deps)).rejects.toThrow(
      "Run ferry init",
    );
  });

  describe("migration of a [host] config", () => {
    test("shows the change, asks, then writes [box.default], the new box, and default_box", async () => {
      const home = makeHome(HOST_CONFIG);
      const progress = recordProgress();
      const { deps, lines, confirms } = dependencies(home, { progress });

      await runBoxAdd({ name: "b", host: "box-b", sshUser: "dev", yes: false }, deps);

      expect(lines).toEqual([
        "Add box b: tailscale dev@box-b",
        "The config has a [host] table. Ferry moves it to [box.default], adds [box.b], and sets default_box = \"default\".",
        "install, auth, move, and integrations enable|disable still use the old host when you give no --box.",
        "Added box b.",
      ]);
      expect(confirms).toEqual(["Change the config and add box b?"]);
      expect(progress.events.indexOf("pause")).toBeLessThan(progress.events.indexOf("start:Connecting to the box"));
      expect(readConfig(home)).toEqual({
        version: 1,
        publisher: "operator",
        snapshotUrl: "snapshot.git",
        defaultBox: "default",
        integrations: { paseo: true },
        boxes: [
          { name: "default", host: { transport: "ssh", destination: "dev@box-a.example" } },
          { name: "b", host: { tailscale: "box-b", sshUser: "dev" } },
        ],
      });
      expect(configText(home)).not.toContain("[host]");
    });

    test("--yes writes without the question", async () => {
      const home = makeHome(HOST_CONFIG);
      const { deps, confirms } = dependencies(home);

      await runBoxAdd({ name: "b", sshDestination: "dev@box-b.example", yes: true }, deps);

      expect(confirms).toEqual([]);
      expect(readConfig(home)?.defaultBox).toBe("default");
    });

    test("a refused question connects to nothing and writes nothing", async () => {
      const home = makeHome(HOST_CONFIG);
      const { deps, links, lines } = dependencies(home, { confirm: async () => false });

      await runBoxAdd({ name: "b", sshDestination: "dev@box-b.example", yes: false }, deps);

      expect(links).toEqual([]);
      expect(configText(home)).toBe(HOST_CONFIG);
      expect(lines.at(-1)).toBe("Box add cancelled.");
    });

    test("refuses the name default, which the old host gets", async () => {
      const home = makeHome(HOST_CONFIG);
      const { deps } = dependencies(home);

      await expect(runBoxAdd({ name: "default", sshDestination: "dev@box-b.example", yes: true }, deps)).rejects.toThrow(
        "box default is already in the config",
      );
    });
  });
});

describe("ferry box add --git-auth box", () => {
  const SSH_CONFIG = BOXES_CONFIG.replace('snapshot_url = "snapshot.git"', 'snapshot_url = "git@github.com:you/ferry-snapshot.git"');
  const PUBLIC_KEY = "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIExample ferry-snapshot";

  function deployKeyBox(home: string, readable: boolean) {
    const calls: { command: string; options: unknown }[] = [];
    const result = dependencies(home, {
      checkAgent: async () => {
        throw new Error("a git_auth = box box needs no operator agent");
      },
      createLink: () => ({
        async run(command, options) {
          calls.push({ command, options });
          if (command.includes("ssh-keygen -q")) return { ok: true, address: "box-c", stdout: `${PUBLIC_KEY}\n`, stderr: "" };
          if (command.includes("ssh-keygen -F")) return { ok: true, address: "box-c", stdout: "trusted\n", stderr: "" };
          if (command.includes("ls-remote") && !readable) {
            return { ok: false, error: { origin: "box", code: "command-failed", message: "git@github.com: Permission denied (publickey)." } };
          }
          return { ok: true, address: "box-c", stdout: "", stderr: "" };
        },
      }),
    });
    return { ...result, calls };
  }

  test("makes the deploy key on the box, reads the snapshot with it, and writes git_auth", async () => {
    const home = makeHome(SSH_CONFIG);
    const { deps, calls } = deployKeyBox(home, true);

    await runBoxAdd({ name: "c", sshDestination: "dev@box-c.example", gitAuth: "box", yes: false }, deps);

    expect(calls.every((call) => call.options === undefined)).toBe(true);
    expect(calls[0]?.command).toContain(
      `ssh-keygen -q -t ed25519 -N '' -C ferry-snapshot -f "$HOME/.ssh/ferry_snapshot"`,
    );
    expect(calls[0]?.command).toContain('[ -f "$HOME/.ssh/ferry_snapshot" ] ||');
    expect(calls.at(-1)?.command).toBe(
      "git -c core.sshCommand='ssh -i ~/.ssh/ferry_snapshot -o IdentitiesOnly=yes' ls-remote 'git@github.com:you/ferry-snapshot.git' HEAD",
    );
    expect(configText(home)).toContain('[box.c]\ntransport = "ssh"\ndestination = "dev@box-c.example"\ngit_auth = "box"\n');
  });

  test("prints the public key and the deploy key step when the box cannot read the snapshot", async () => {
    const home = makeHome(SSH_CONFIG);
    const { deps } = deployKeyBox(home, false);

    await expect(
      runBoxAdd({ name: "c", sshDestination: "dev@box-c.example", gitAuth: "box", yes: false }, deps),
    ).rejects.toThrow(
      "box: could not read git@github.com:you/ferry-snapshot.git with the box deploy key ~/.ssh/ferry_snapshot: git@github.com: Permission denied (publickey).\n" +
        "Add this public key as a read-only deploy key on the snapshot repository. Do not give it write access. Then run the command again.\n" +
        PUBLIC_KEY,
    );
    expect(configText(home)).toBe(SSH_CONFIG);
  });

  test("refuses a snapshot URL that is not SSH", async () => {
    const home = makeHome(BOXES_CONFIG.replace('"snapshot.git"', '"https://github.com/you/ferry-snapshot.git"'));
    const { deps, calls } = deployKeyBox(home, true);

    await expect(
      runBoxAdd({ name: "c", sshDestination: "dev@box-c.example", gitAuth: "box", yes: false }, deps),
    ).rejects.toThrow('git_auth = "box" needs an SSH snapshot URL');
    expect(calls).toEqual([]);
  });
});

describe("ferry box remove", () => {
  test("removes the table and does not connect to the box", () => {
    const home = makeHome(BOXES_CONFIG.replace('default_box = "a"\n', "") + "[box.c]\ntransport = \"ssh\"\ndestination = \"dev@box-c.example\"\n");
    const { deps, links, lines } = dependencies(home);

    runBoxRemove({ name: "b" }, deps);

    expect(links).toEqual([]);
    expect(readConfig(home)?.boxes?.map((box) => box.name)).toEqual(["a", "c"]);
    expect(lines).toEqual(["Removed box b from the config. Ferry did not change the box."]);
  });

  test("warns and removes default_box when it named the removed box", () => {
    const home = makeHome(BOXES_CONFIG);
    const { deps, lines } = dependencies(home);

    runBoxRemove({ name: "a" }, deps);

    expect(readConfig(home)?.defaultBox).toBeUndefined();
    expect(readConfig(home)?.boxes?.map((box) => box.name)).toEqual(["b"]);
    expect(lines).toEqual([
      "Removed box a from the config. Ferry did not change the box.",
      "Warning: box a was the default_box. Ferry removed default_box. Set a new one with ferry box default <name>.",
    ]);
  });

  test("refuses the last box", () => {
    const oneBox = makeHome(BOXES_CONFIG.replace('default_box = "a"\n', "").split("[box.b]")[0]);
    expect(() => runBoxRemove({ name: "a" }, dependencies(oneBox).deps)).toThrow("box a is the last box");

    const host = makeHome(HOST_CONFIG);
    expect(() => runBoxRemove({ name: "default" }, dependencies(host).deps)).toThrow("box default is the last box");
    expect(configText(host)).toBe(HOST_CONFIG);
  });

  test("refuses an unknown box", () => {
    const { deps } = dependencies(makeHome(BOXES_CONFIG));

    expect(() => runBoxRemove({ name: "c" }, deps)).toThrow("unknown box c. Known boxes: a, b.");
  });
});

describe("ferry box default", () => {
  test("sets default_box", () => {
    const home = makeHome(BOXES_CONFIG);
    const { deps, lines } = dependencies(home);

    runBoxDefault({ name: "b" }, deps);

    expect(readConfig(home)?.defaultBox).toBe("b");
    expect(lines).toEqual(['Set default_box = "b".']);
  });

  test("refuses an unknown box", () => {
    const { deps } = dependencies(makeHome(BOXES_CONFIG));

    expect(() => runBoxDefault({ name: "c" }, deps)).toThrow("unknown box c. Known boxes: a, b.");
  });

  test("refuses a [host] config, which has one box only", () => {
    const home = makeHome(HOST_CONFIG);
    const { deps } = dependencies(home);

    expect(() => runBoxDefault({ name: "default" }, deps)).toThrow("Add a box with ferry box add first.");
    expect(configText(home)).toBe(HOST_CONFIG);
  });
});
