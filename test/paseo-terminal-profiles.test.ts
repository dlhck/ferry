import { afterEach, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";
import {
  carryPaseoTerminalProfiles,
  PASEO_DEFAULT_TERMINAL_PROFILES,
  readPaseoTerminalProfiles,
  type TerminalProfile,
} from "../src/integrations/paseo-terminal-profiles.ts";
import type { IntegrationLink } from "../src/integrations/types.ts";
import { runSync, type SyncDependencies } from "../src/sync.ts";
import { runWatch } from "../src/watch.ts";

const homes: string[] = [];
afterEach(() => { for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true }); });
// Build the values at run time so this file holds no string a secret scanner flags.
const token = "gh" + "p_" + "A".repeat(36);
const lazygit = { id: "lazygit", name: "Lazygit", command: "lazygit", icon: "git" };
const claude = { id: "claude", name: "Claude Code", command: "claude", args: ["--model=opus", "{{{prompt}}}"], icon: "claude" };

function home(profiles?: unknown, daemon: Record<string, unknown> = {}): string {
  const path = mkdtempSync(join(tmpdir(), "ferry-terminals-"));
  homes.push(path);
  if (profiles !== undefined) write(path, profiles, daemon);
  return path;
}
function write(path: string, profiles: unknown, daemon: Record<string, unknown> = {}): void {
  mkdirSync(join(path, ".paseo"), { recursive: true });
  writeFileSync(join(path, ".paseo/config.json"), JSON.stringify({ version: 1, daemon: { ...daemon, terminalProfiles: profiles } }));
}
function refusal(path: string): string {
  try { readPaseoTerminalProfiles(path); } catch (error) { return String(error); }
  throw new Error("accepted the config");
}
function source(profiles: unknown) {
  const read = readPaseoTerminalProfiles(home(profiles));
  if (read === null) throw new Error("no list");
  return read;
}

const readConfig = "if [ -e '.paseo/config.json' ]; then printf 'F' && cat '.paseo/config.json'; else printf 'M'; fi";
function box(config: unknown = {}, onPath: readonly string[] = ["claude", "lazygit", "bash", "codex"]) {
  const commands: string[] = [];
  const link: IntegrationLink = { run: async (command) => {
    commands.push(command);
    if (command === readConfig) {
      return { ok: true, address: "box", stdout: config === null ? "M" : `F${typeof config === "string" ? config : JSON.stringify(config)}`, stderr: "" };
    }
    if (command.includes("command -v")) {
      const names = [...command.matchAll(/command -v -- '([^']+)'/g)].map((match) => match[1]!);
      return { ok: true, address: "box", stdout: names.filter((name) => onPath.includes(name)).map((name) => `ok ${name}\n`).join(""), stderr: "" };
    }
    return { ok: true, address: "box", stdout: "", stderr: "" };
  } };
  return { commands, link };
}
function written(commands: readonly string[]): any {
  const write = commands.find((command) => command.includes("config.json.ferry-tmp"));
  const text = write?.match(/^umask 077 && mkdir -p '\.paseo' && printf '%s' '(.*)' > /s)?.[1];
  return text === undefined ? undefined : JSON.parse(text.replaceAll("'\"'\"'", "'"));
}

describe("Paseo terminal profile discovery", () => {
  test("reads only the allowlisted fields and keeps the prompt sentinel", () => {
    expect(source([claude, lazygit])).toEqual({ profiles: [claude, lazygit], warnings: [] });
  });

  test("gives null without a config or a list, and an empty set for an empty list", () => {
    expect(readPaseoTerminalProfiles(home())).toBeNull();
    const path = home();
    mkdirSync(join(path, ".paseo"));
    writeFileSync(join(path, ".paseo/config.json"), JSON.stringify({ daemon: { listen: "127.0.0.1:6767" } }));
    expect(readPaseoTerminalProfiles(path)).toBeNull();
    expect(source([])).toEqual({ profiles: [], warnings: [] });
  });

  test("refuses entries that Paseo's schema rejects, by position and without values", () => {
    for (const entry of [
      { name: "No ID", command: "x" }, { id: "", name: "x", command: "x" }, { id: "x", name: "x" },
      { id: "x", name: "x", command: "x", args: "--flag" }, { id: "x", name: "x", command: "x", args: [1] },
      { id: "x", name: "x", command: "x", icon: 3 }, "claude",
    ]) {
      expect(refusal(home([lazygit, entry]))).toContain("profile #2 is not an object with a non-empty id");
    }
    expect(refusal(home({}))).toContain("daemon.terminalProfiles");
    expect(refusal(home([lazygit, { ...lazygit, name: "Other" }]))).toContain("profile #2 repeats the ID");
  });

  test("refuses a secret in a carried field without the value, the name, or the ID", () => {
    for (const profile of [
      { id: "gh", name: "Forge", command: "gh", args: [`--with-token=${token}`] },
      { id: token, name: "x", command: "x" },
      { id: "x", name: `Uses ${token}`, command: "x" },
    ]) {
      const message = refusal(home([profile]));
      expect(message).toContain("Ferry refused to carry daemon.terminalProfiles");
      expect(message).toContain("profile #1");
      expect(message).not.toContain(token);
      expect(message).not.toContain("Forge");
    }
  });

  test("skips an env block or other field with a fixed reason and never prints the key or the value", () => {
    const read = source([{ ...lazygit, env: { GIT_TOKEN: "local-only" } }, { ...lazygit, id: "b", name: "B", cwdMode: "home" }]);
    expect(read.profiles).toEqual([]);
    expect(read.warnings).toEqual([
      "Paseo terminal profile Lazygit was not carried: it has fields other than id, name, command, args, and icon, such as an env block.",
      "Paseo terminal profile B was not carried: it has fields other than id, name, command, args, and icon, such as an env block.",
    ]);
    expect(read.warnings.join("\n")).not.toContain("GIT_TOKEN");
    expect(read.warnings.join("\n")).not.toContain("cwdMode");
  });

  test("keeps bare shells and allowlisted interactive flags", () => {
    const shells = [
      { id: "bash", name: "Bash", command: "bash" },
      { id: "login", name: "Login", command: "bash", args: ["-l"] },
      { id: "zsh", name: "Zsh", command: "zsh", args: ["--login", "-i"] },
      { id: "py", name: "Python", command: "python3" },
    ];
    expect(source(shells)).toEqual({ profiles: shells, warnings: [] });
  });

  test("skips paths, script payloads, credential URLs, and loopback endpoints without printing arguments", () => {
    const cases: [unknown[], string, string][] = [
      [[], "/bin/zsh", "its command is not a bare executable name"],
      [[], "~/bin/tool", "its command is not a bare executable name"],
      [[], "./tool", "its command is not a bare executable name"],
      [[], "-tool", "its command is not a bare executable name"],
      [[], ".", "its command is not a bare executable name"],
      [[], "C:\\Tools\\tool.exe", "its command is not a bare executable name"],
      [[], "tool {{{prompt}}}", "its command is not a bare executable name"],
      [["-c", "hidden"], "sh", "it runs a shell or interpreter with a script or an unknown flag"],
      [["-lc", "hidden"], "bash", "it runs a shell or interpreter with a script or an unknown flag"],
      [["-e", "hidden"], "node", "it runs a shell or interpreter with a script or an unknown flag"],
      [["-c", "hidden"], "python3", "it runs a shell or interpreter with a script or an unknown flag"],
      [["script-name"], "bash", "it runs a shell or interpreter with a script or an unknown flag"],
      [["hidden=1", "tool"], "env", "it runs a shell or interpreter with a script or an unknown flag"],
      [["--config=./relative"], "tool", "it has a local path argument"],
      [["--config", "conf/tool"], "tool", "it has a local path argument"],
      [["settings.json"], "tool", "it has a local path argument"],
      [["C:\\Users\\hidden"], "tool", "it has a local path argument"],
      [["--from=file:///hidden"], "tool", "it has a local path argument"],
      [["~/hidden"], "tool", "it has a local path argument"],
      [["--url=https://user:hidden@example.com"], "tool", "it has a credential-like argument"],
      [["https://example.com/?key=hidden"], "tool", "it has a credential-like argument"],
      [["https://example.com/#hidden"], "tool", "it has a credential-like argument"],
      [["--api-key=hidden"], "tool", "it has a credential-like argument"],
      [["--url=http://localhost:3000"], "tool", "it has a loopback or non-HTTP URL argument"],
      [["127.0.0.1:8080"], "tool", "it has a loopback or non-HTTP URL argument"],
      [["--url=ssh://example.com"], "tool", "it has a loopback or non-HTTP URL argument"],
      [["run hidden"], "tool", "it has an argument with spaces or control characters"],
    ];
    for (const [args, command, reason] of cases) {
      const read = source([{ id: "p", name: "P", command, args }]);
      expect(read.profiles).toEqual([]);
      expect(read.warnings).toEqual([`Paseo terminal profile P was not carried: ${reason}.`]);
      for (const arg of args) expect(read.warnings[0]).not.toContain(String(arg));
    }
    expect(source([{ id: "p", name: "P", command: "tool", args: ["--url=https://example.com/api", "@scope/pkg@1.0.0"] }]).warnings).toEqual([]);
  });
});

describe("Paseo terminal profile carry", () => {
  test("merges by ID, keeps target-only fields and profiles in place, and appends new IDs", async () => {
    const boxList = [
      { id: "shell", name: "Box shell", command: "fish" },
      { id: "claude", env: { BOX: "keep" }, name: "Old", command: "claude", args: ["--old"], icon: "x", extra: 1 },
    ];
    const b = box({ version: 1, daemon: { listen: "127.0.0.1:6767", terminalProfiles: boxList }, agents: { providers: {} } });
    const carry = await carryPaseoTerminalProfiles(b.link, source([lazygit, { ...claude, icon: undefined }]), [".local/bin"]);
    expect(carry).toEqual({ carried: ["Lazygit", "Claude Code"], warnings: [], changed: true });
    const config = written(b.commands);
    expect(config.daemon.listen).toBe("127.0.0.1:6767");
    expect(config.agents).toEqual({ providers: {} });
    expect(config.daemon.terminalProfiles).toEqual([
      boxList[0],
      { id: "claude", env: { BOX: "keep" }, name: "Claude Code", command: "claude", args: claude.args, extra: 1 },
      lazygit,
    ]);
    expect(Object.keys(config.daemon.terminalProfiles[1])).toEqual(["id", "env", "name", "command", "args", "extra"]);
    expect(b.commands.at(-1)).toBe("paseo daemon reload");
  });

  test("keeps box fields named like Object.prototype keys on a same-ID profile, and stays idempotent", async () => {
    const boxProfile = { id: "lazygit", constructor: "box-value", toString: "box-text", env: { BOX: "keep" }, name: "Old", command: "lazygit" };
    const first = box(`{"daemon":{"terminalProfiles":[${JSON.stringify(boxProfile)}]}}`);
    expect((await carryPaseoTerminalProfiles(first.link, source([lazygit]), [])).changed).toBe(true);
    const profile = written(first.commands).daemon.terminalProfiles[0];
    expect(profile).toEqual({ ...boxProfile, name: "Lazygit", icon: "git" });
    expect(Object.keys(profile)).toEqual(["id", "constructor", "toString", "env", "name", "command", "icon"]);
    const again = box(written(first.commands));
    expect((await carryPaseoTerminalProfiles(again.link, source([lazygit]), [])).changed).toBe(false);
    expect(again.commands.some((command) => command.includes("ferry-tmp"))).toBe(false);
  });

  test("keeps the Paseo defaults when the box has no list", async () => {
    for (const config of [null, {}, { daemon: {} }]) {
      const b = box(config);
      await carryPaseoTerminalProfiles(b.link, source([lazygit]), []);
      expect(written(b.commands).daemon.terminalProfiles).toEqual([...PASEO_DEFAULT_TERMINAL_PROFILES, lazygit]);
    }
  });

  test("writes nothing when the carried profiles match the box defaults, or the list is unchanged", async () => {
    const defaults = box({});
    const carry = await carryPaseoTerminalProfiles(defaults.link, source([PASEO_DEFAULT_TERMINAL_PROFILES[1]]), []);
    expect(carry).toEqual({ carried: ["Codex"], warnings: [], changed: false });
    expect(defaults.commands.some((command) => command.includes("ferry-tmp"))).toBe(false);

    const first = box({ daemon: { terminalProfiles: [{ id: "shell", name: "Shell", command: "fish" }] } });
    await carryPaseoTerminalProfiles(first.link, source([lazygit, claude]), []);
    const again = box(written(first.commands));
    expect(await carryPaseoTerminalProfiles(again.link, source([lazygit, claude]), [])).toEqual({
      carried: ["Lazygit", "Claude Code"], warnings: [], changed: false,
    });
    expect(again.commands).toEqual([expect.stringContaining("command -v"), readConfig]);
  });

  test("runs no box command for an empty list or all-skipped profiles, and never removes box profiles", async () => {
    const empty = box({ daemon: { terminalProfiles: [lazygit] } });
    expect(await carryPaseoTerminalProfiles(empty.link, source([]), [])).toEqual({ carried: [], warnings: [], changed: false });
    const skipped = source([{ id: "s", name: "S", command: "sh", args: ["-c", "hidden"] }]);
    expect((await carryPaseoTerminalProfiles(empty.link, skipped, [])).warnings).toHaveLength(1);
    expect(empty.commands).toEqual([]);
  });

  test("skips a profile whose command is not on the unit PATH, and writes nothing when none remains", async () => {
    const b = box({}, []);
    const carry = await carryPaseoTerminalProfiles(b.link, source([lazygit]), [".local/bin"]);
    expect(carry).toEqual({
      carried: [],
      warnings: ["Paseo terminal profile Lazygit was not carried: its command is not on the PATH of ferry-paseo.service on the box."],
      changed: false,
    });
    expect(b.commands).toHaveLength(1);
    expect(b.commands[0]).toStartWith(`PATH="$HOME"/'.local/bin':/usr/local/sbin:`);
  });

  test("the command check finds only executables on the unit PATH, not builtins or the login PATH", () => {
    const b = box();
    const boxHome = home();
    mkdirSync(join(boxHome, "tools"));
    writeFileSync(join(boxHome, "tools/fake-tool"), "#!/bin/sh\n");
    chmodSync(join(boxHome, "tools/fake-tool"), 0o755);
    void carryPaseoTerminalProfiles(b.link, source([
      { id: "a", name: "A", command: "fake-tool" }, { id: "b", name: "B", command: "cd" },
      { id: "c", name: "C", command: "missing-tool" },
    ]), ["tools"]);
    const output = execFileSync("/bin/sh", ["-c", b.commands[0]!], { env: { HOME: boxHome, PATH: "/nowhere" }, encoding: "utf8" });
    expect(output).toBe("ok fake-tool\n");
  });

  test("fails with a fixed message when the box config or a command is bad, without box output", async () => {
    for (const config of ["not json", [], { daemon: [] }, { daemon: { terminalProfiles: {} } },
      { daemon: { terminalProfiles: [{ name: "no id" }] } }, { daemon: { terminalProfiles: [lazygit, lazygit] } }]) {
      const b = box(config);
      const error = await carryPaseoTerminalProfiles(b.link, source([lazygit]), []).catch((caught: unknown) => caught);
      expect(String(error)).toContain("~/.paseo/config.json on the box");
      expect(b.commands.some((command) => command.includes("ferry-tmp"))).toBe(false);
    }
    const secret = `hidden ${token}`;
    const failing: IntegrationLink = { run: async () => ({
      ok: false, error: { origin: "box", code: "exit", message: secret }, address: "box", stdout: secret, stderr: secret,
    }) as never };
    const throwing: IntegrationLink = { run: async () => { throw new Error(secret); } };
    for (const link of [failing, throwing]) {
      const error = await carryPaseoTerminalProfiles(link, source([lazygit]), []).catch((caught: unknown) => caught);
      expect(String(error)).toContain("Ferry could not check the Paseo terminal profile commands on the box");
      expect(String(error)).not.toContain(token);
    }
  });
});

function syncConfig() {
  return {
    version: 1 as const, publisher: "operator", snapshotUrl: "snapshot.git", integrations: { paseo: true },
    boxes: [
      { name: "on", host: { tailscale: "on", sshUser: "user" } },
      { name: "off", host: { tailscale: "off", sshUser: "user" }, integrations: { paseo: false } },
    ],
  };
}

test("dry runs show terminal profiles only for Paseo boxes, without arguments, and make no connections", async () => {
  const path = home([claude, { id: "s", name: "Script", command: "sh", args: ["-c", "hidden-script"] }]);
  const lines: string[] = [];
  const deps: SyncDependencies = {
    publisher: () => "operator", readConfig: syncConfig,
    createLink: () => { throw new Error("must stay offline"); }, writeLine: (line) => lines.push(line),
  };
  const result = await runSync({ home: path, dryRun: true }, deps);
  expect(result.boxes[0]?.plan.paseoTerminalProfiles).toEqual({
    profiles: [{ id: "claude", name: "Claude Code", command: "claude", argCount: 2 }],
    warnings: ["Paseo terminal profile Script was not carried: it runs a shell or interpreter with a script or an unknown flag."],
  });
  expect(result.boxes[1]?.plan.paseoTerminalProfiles).toBeNull();
  const text = lines.join("\n");
  expect(text).toContain("Paseo terminal profiles: Claude Code (claude, 2 arguments) -> merge by ID");
  expect(text).not.toContain("hidden-script");
  expect(text).not.toContain("--model=opus");
});

test("sync refuses a secret in a terminal profile before it connects", async () => {
  const path = home([{ id: "gh", name: "GitHub", command: "gh", args: [`--with-token=${token}`] }]);
  let connected = false;
  const error = await runSync({ home: path, publish: false }, {
    publisher: () => "operator", readConfig: syncConfig,
    createLink: () => { connected = true; throw new Error("connected"); }, writeLine: () => {},
  }).catch((caught: unknown) => caught);
  expect(String(error)).toContain("Ferry refused to carry daemon.terminalProfiles");
  expect(String(error)).not.toContain(token);
  expect(connected).toBe(false);
});

test("sync carries terminal profiles after the preferences and before the unit PATH refresh", async () => {
  const path = home([lazygit], { appendSystemPrompt: "Be brief." });
  const commands: string[] = [];
  const result = await runSync({ home: path, publish: false }, {
    publisher: () => "operator",
    readConfig: () => ({ version: 1, publisher: "operator", snapshotUrl: "snapshot.git",
      host: { tailscale: "box", sshUser: "user" }, integrations: { paseo: true } }),
    createLink: () => ({ run: async (command) => {
      commands.push(command);
      const status = JSON.stringify({ localDaemon: "running", providers: [] });
      return { ok: true, address: "box", stdout: command.startsWith("printf") ? "/home/user\n"
        : command.includes("paseo daemon status --json") ? status
        : command.includes("command -v -- 'lazygit'") ? "ok lazygit\n"
        : command === readConfig ? "M" : "", stderr: "" };
    } }),
    apply: async (input) => ({ checkout: input.checkout, targetHome: input.targetHome, actions: [], unmanaged: [] }),
    acquireLock: () => () => {}, adopt: () => {}, writePlan: () => {}, writeLine: () => {}, warn: () => {},
  });
  expect(result.boxes[0]?.failure).toBeUndefined();
  const preferences = commands.findIndex((command) => command.includes("appendSystemPrompt") && command.includes("ferry-tmp"));
  const terminals = commands.findIndex((command) => command.includes("terminalProfiles") && command.includes("ferry-tmp"));
  const unit = commands.findIndex((command) => command.includes("ferry-paseo.service"));
  expect(preferences).toBeGreaterThan(-1);
  expect(terminals).toBeGreaterThan(preferences);
  expect(unit).toBeGreaterThan(terminals);
});

test("watch detects terminal profile changes with its real observer, and only when the list is set", async () => {
  for (const [initial, changed, syncs] of [[[lazygit], [claude], 1], [undefined, undefined, 0]] as const) {
    const path = home(initial);
    mkdirSync(join(path, ".ferry"), { recursive: true });
    writeFileSync(join(path, ".ferry/config.toml"), `version = 1\npublisher = ${JSON.stringify(hostname())}\nsnapshot_url = "snapshot.git"\n[host]\ntailscale = "box"\nssh_user = "user"\n[integrations]\npaseo = true\n`);
    const controller = new AbortController();
    let polls = 0, count = 0;
    await runWatch({ home: path, signal: controller.signal, pollMs: 1, debounceMs: 1 }, {
      sleep: async () => {
        if (++polls === 1 && changed !== undefined) write(path, changed as unknown as TerminalProfile[]);
        if (polls > 5) controller.abort();
      },
      sync: async () => { count++; controller.abort(); }, writeLine: () => {},
      readState: () => null, writeState: () => {},
    });
    expect(count).toBe(syncs);
  }
});
