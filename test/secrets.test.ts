import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runSecrets, secretsStartupCommand, type SecretsDependencies, type SecretsInput } from "../src/secrets.ts";
import { Link, type HostCommand, type RunOptions } from "../src/link.ts";
import { readSeed as readManifest } from "../src/manifest.ts";
import { createPaseo, ensureSecretsUnit, refreshUnit, unitFile } from "../src/integrations/paseo.ts";
import { buildProgram, runCli } from "../src/cli.ts";
import { commitBoxUninstall, planBoxUninstall } from "../src/box-uninstall.ts";
import { profileBlockCommand } from "../src/tools/path.ts";
import { runSync } from "../src/sync.ts";
import { noProgress } from "../src/progress.ts";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
const value = ` spaces 'quotes' "double" $HOME $(touch BAD) \\tail\\ `;
const input: SecretsInput = { action: "set", names: ["EXAMPLE_KEY"], yes: true };

function world() {
  const root = mkdtempSync(join(tmpdir(), "ferry-secrets-"));
  roots.push(root);
  const home = join(root, "home");
  mkdirSync(home);
  const commands: HostCommand[] = [];
  const outputs: string[] = [];
  const lines: string[] = [];
  const link = new Link({ destination: "user@box.example" }, {
    async run(command) {
      commands.push(command);
      const p = Bun.spawnSync(["sh", "-c", command.argv.at(-1)!], {
        cwd: home, env: { ...process.env, HOME: home }, stdin: command.input ?? "ignore",
      });
      const stdout = p.stdout.toString();
      const stderr = p.stderr.toString();
      outputs.push(stdout, stderr);
      return { exitCode: p.exitCode, stdout, stderr, timedOut: false };
    },
  });
  const dependencies: SecretsDependencies = {
    readConfig: () => ({ host: { transport: "ssh", destination: "user@box.example" } }),
    createLink: () => link, env: { EXAMPLE_KEY: value, OTHER: "unselected" },
    confirm: async () => true, prompt: async () => value, writeLine: (line) => lines.push(line),
  };
  const file = (name = "agent.env") => join(home, ".ferry/secrets/current", name);
  return { root, home, commands, outputs, lines, dependencies, file, link };
}

/** Parse the double-quoted EnvironmentFile subset per systemd.exec, with no expansion. */
function systemdEnvironment(text: string): Record<string, string> {
  return Object.fromEntries(text.trimEnd().split("\n").map((line) => {
    const match = /^([A-Za-z_][A-Za-z0-9_]*)="(.*)"$/.exec(line)!;
    return [match[1]!, match[2]!.replace(/\\(["\\$`])/g, "$1")];
  }));
}

describe("box secrets", () => {
  test("transfers only selected values through SSH stdin, with no value in argv or reports", async () => {
    const w = world();
    const result = await runSecrets(input, w.dependencies);
    expect(readFileSync(w.file(), "utf8")).toBe(`EXAMPLE_KEY=${value}\n`);
    expect(w.commands.some((c) => c.input && Buffer.from(c.input).includes(value))).toBe(true);
    expect(JSON.stringify({ argv: w.commands.map((c) => c.argv), result, outputs: w.outputs, lines: w.lines })).not.toContain(value);
    expect(readFileSync(w.file(), "utf8")).not.toContain("unselected");
    expect(existsSync(join(w.home, ".ferry/store"))).toBe(false);
    expect(statSync(join(w.home, ".ferry/secrets")).mode & 0o777).toBe(0o700);
    for (const name of ["agent.env", "systemd.env"]) expect(statSync(w.file(name)).mode & 0o777).toBe(0o600);
    expect(result?.steps.join(" ")).toContain("new shell");
    expect(result?.steps.join(" ")).not.toContain("restart ferry-paseo");
  });

  test("merge, explicit replace, and remove preserve unrelated entries and commit atomically", async () => {
    const w = world();
    await runSecrets(input, w.dependencies);
    const before = statSync(w.file()).ino;
    await expect(runSecrets(input, w.dependencies)).rejects.toThrow("--replace");
    expect(statSync(w.file()).ino).toBe(before);
    await runSecrets({ ...input, names: ["OTHER"] }, w.dependencies);
    await runSecrets({ ...input, replace: true }, { ...w.dependencies, env: { EXAMPLE_KEY: "updated" } });
    expect(readFileSync(w.file(), "utf8")).toContain("OTHER=unselected\n");
    expect(readFileSync(w.file(), "utf8")).toContain("EXAMPLE_KEY=updated\n");
    const result = await runSecrets({ action: "remove", names: ["EXAMPLE_KEY"], yes: true }, w.dependencies);
    expect(readFileSync(w.file(), "utf8")).toBe("OTHER=unselected\n");
    expect(result?.steps.join(" ")).toContain("does not revoke");
    expect(readdirSync(join(w.home, ".ferry/secrets")).filter((n) => n.startsWith(".next"))).toEqual([]);
  });

  test("loader exports literal values to a direct child CLI and suppresses tracing", async () => {
    const w = world();
    await runSecrets(input, w.dependencies);
    const cli = join(w.root, "example-cli");
    writeFileSync(cli, '#!/bin/sh\nprintf "%s" "$EXAMPLE_KEY"\n', { mode: 0o755 });
    for (const shell of ["sh", "bash"]) {
      const p = Bun.spawnSync([shell, "-xc", `. "$HOME/.ferry/secrets/load.sh"; ${cli}`], {
        env: { ...process.env, HOME: w.home }, cwd: w.home,
      });
      expect(p.exitCode).toBe(0);
      expect(p.stdout.toString()).toBe(value);
      expect(p.stderr.toString()).not.toContain(value);
    }
    expect(existsSync(join(w.home, "BAD"))).toBe(false);
  });

  test("startup blocks are idempotent, precede bashrc early returns, and keep unrelated text", async () => {
    const w = world();
    for (const file of [".profile", ".bash_profile", ".bash_login", ".bashrc", ".zprofile", ".zshrc"]) {
      writeFileSync(join(w.home, file), "# user config\nreturn 0\n", { mode: 0o640 });
    }
    await runSecrets(input, w.dependencies);
    await w.dependencies.createLink({ destination: "user@box.example" }).run(secretsStartupCommand());
    for (const file of [".profile", ".bash_profile", ".bash_login", ".bashrc", ".zprofile", ".zshrc"]) {
      const text = readFileSync(join(w.home, file), "utf8");
      expect(text.match(/# >>> ferry secrets >>>/g)?.length).toBe(1);
      expect(text).toContain("# user config\nreturn 0\n");
      expect(statSync(join(w.home, file)).mode & 0o777).toBe(0o640);
    }
    const p = Bun.spawnSync(["bash", "-ic", 'printf "%s" "$EXAMPLE_KEY"'], { env: { ...process.env, HOME: w.home } });
    expect(p.stdout.toString()).toBe(value);
    rmSync(join(w.home, ".ferry/secrets/current"));
    const absent = Bun.spawnSync(["bash", "-ic", "true"], { env: { ...process.env, HOME: w.home } });
    expect(absent.exitCode).toBe(0);
  });

  test("status returns only presence and names, and no value hashes", async () => {
    const w = world();
    await runSecrets(input, w.dependencies);
    const result = await runSecrets({ action: "status", names: [] }, w.dependencies);
    expect(result?.secrets).toEqual({ present: true, names: ["EXAMPLE_KEY"] });
    expect(JSON.stringify(result)).not.toContain(value);
    expect(JSON.stringify(result)).not.toMatch(/hash|sha256/);
    // A damaged record without '=' must not be reported as a variable name.
    const bareValue = "example_value_without_separator";
    writeFileSync(w.file(), `${bareValue}\nEXAMPLE_KEY=${value}\n`);
    const damaged = await runSecrets({ action: "status", names: [] }, w.dependencies);
    expect(damaged?.secrets.names).toEqual(["EXAMPLE_KEY"]);
    expect(JSON.stringify(damaged)).not.toContain(bareValue);
  });

  test("errors do not echo malformed values, transport output, or thrown exceptions", async () => {
    const w = world();
    for (const bad of [value + "\n", value + "\r", value + "\0", value + "\ufdd0", value + "\u{1ffff}", value + "\ud800"]) {
      const error = await runSecrets(input, { ...w.dependencies, env: { EXAMPLE_KEY: bad } }).catch(String);
      expect(error).not.toContain(value);
      expect(w.commands).toEqual([]);
    }
    for (const thrown of [false, true]) {
      const error = await runSecrets(input, { ...w.dependencies, createLink: () => ({
        async run(_command: string, _options?: RunOptions) {
          if (thrown) throw new Error(value);
          return { ok: false as const, error: { code: "command-failed" as const, origin: "box" as const, message: value } };
        },
      }) }).catch(String);
      expect(error).not.toContain(value);
    }
  });

  test("scope confirmation precedes transfer; JSON cannot prompt", async () => {
    const w = world();
    await expect(runSecrets({ ...input, yes: false, json: true }, w.dependencies)).rejects.toThrow("Every process");
    expect(w.commands).toEqual([]);
    expect(await runSecrets({ ...input, yes: false }, { ...w.dependencies, confirm: async () => false })).toBeNull();
    expect(w.commands).toEqual([]);
  });

  test("file selection is literal and prompt input is hidden through the injected reader", async () => {
    const w = world();
    const path = join(w.root, "selected.env");
    writeFileSync(path, `EXAMPLE_KEY=${value}\nOTHER=unselected\n`);
    await runSecrets({ ...input, file: path }, { ...w.dependencies, env: {} });
    expect(readFileSync(w.file(), "utf8")).toBe(`EXAMPLE_KEY=${value}\n`);
    await runSecrets({ ...input, prompt: true, replace: true }, w.dependencies);
    expect(readFileSync(w.file(), "utf8")).toBe(`EXAMPLE_KEY=${value}\n`);
  });

  test("normal manifest ignores the box-local secrets directory", async () => {
    const w = world();
    await runSecrets(input, w.dependencies);
    const manifest = readManifest(w.home, []);
    expect(JSON.stringify(manifest)).not.toContain(value);
    expect(JSON.stringify(manifest)).not.toContain("secrets/current");
    const plans: unknown[] = [];
    const result = await runSync({ home: w.home, dryRun: true }, {
      readConfig: () => ({ ...w.dependencies.readConfig(), publisher: "operator", snapshotUrl: "snapshot.git", version: 1 }),
      publisher: () => "operator", writePlan: (plan) => plans.push(plan), writeLine: (line) => w.lines.push(line),
    });
    expect(JSON.stringify({ plans, result, lines: w.lines })).not.toContain(value);
  });

  test("systemd quoting preserves spaces, quotes, dollars, backticks, backslashes, tabs, and empty values", async () => {
    const w = world();
    const values = { EXAMPLE_KEY: value, EMPTY: "", TAB: "\t tab \t", QUOTED: '\\$`\\"\\\\', UNICODE: "caf\u00e9" };
    await runSecrets({ ...input, names: Object.keys(values) }, { ...w.dependencies, env: values });
    expect(systemdEnvironment(readFileSync(w.file("systemd.env"), "utf8"))).toEqual(values);
    expect(existsSync(join(w.home, "BAD"))).toBe(false);
  });

  test("Paseo unit changes reload systemd without a restart; a restarted fake daemon passes values to a child", async () => {
    const w = world();
    const bin = join(w.root, "bin");
    mkdirSync(bin);
    const log = join(w.root, "service.log");
    writeFileSync(join(bin, "systemctl"), '#!/bin/sh\nprintf "%s\\n" "$*" >> "$SERVICE_LOG"\n', { mode: 0o755 });
    const unit = join(w.home, ".config/systemd/user/ferry-paseo.service");
    mkdirSync(join(unit, ".."), { recursive: true });
    writeFileSync(unit, unitFile([]).replace(/^EnvironmentFile=.*\n/m, "") + "# user line\n");
    const link = { run: async (command: string, options?: RunOptions) => {
      const p = Bun.spawnSync(["sh", "-c", command], {
        cwd: w.home, env: { ...process.env, HOME: w.home, PATH: `${bin}:${process.env.PATH}`, SERVICE_LOG: log }, stdin: options?.input ?? "ignore",
      });
      const stdout = p.stdout.toString();
      return p.exitCode === 0 ? { ok: true as const, address: "box", stdout, stderr: "" }
        : { ok: false as const, error: { code: "command-failed" as const, origin: "box" as const, message: p.stderr.toString() } };
    } };
    const result = await runSecrets(input, { ...w.dependencies, createLink: () => link,
      readConfig: () => ({ ...w.dependencies.readConfig(), integrations: { paseo: true } }),
    });
    expect(result?.steps.join(" ")).toContain("restart ferry-paseo.service");
    expect(await ensureSecretsUnit(link)).toBe(false);
    await refreshUnit(link, []);
    expect(readFileSync(unit, "utf8").match(/^EnvironmentFile=/gm)).toHaveLength(1);
    expect(readFileSync(unit, "utf8")).toContain("# user line");
    expect(readFileSync(log, "utf8")).toBe("--user daemon-reload\n");
    const oldEnvironment = systemdEnvironment(readFileSync(w.file("systemd.env"), "utf8"));
    await runSecrets({ ...input, replace: true }, { ...w.dependencies, env: { EXAMPLE_KEY: "new value" } });
    const child = (env: Record<string, string>) => Bun.spawnSync(["sh", "-c", 'sh -c \'printf "%s" "$EXAMPLE_KEY"\''], { env }).stdout.toString();
    expect(child(oldEnvironment)).toBe(value);
    expect(child(systemdEnvironment(readFileSync(w.file("systemd.env"), "utf8")))).toBe("new value");
    // An update repairs an old unit even when the package version is current, without a restart.
    writeFileSync(unit, unitFile([]).replace(/^EnvironmentFile=.*\n/m, ""));
    const paseo = createPaseo({ platform: "win32", host: { run: async () => ({ exitCode: 0, stdout: "0.9.2", stderr: "", timedOut: false }) } });
    const updated = await paseo.box.update({ run: (command, options) => command.includes("paseo daemon status")
      ? Promise.resolve({ ok: true, address: "box", stdout: '{"localDaemon":"running","daemonVersion":"0.9.2"}', stderr: "" })
      : link.run(command, options) }, noProgress);
    expect(updated.join(" ")).toContain("Restart ferry-paseo.service explicitly");
    expect(readFileSync(unit, "utf8")).toContain("EnvironmentFile=-");
    expect(readFileSync(log, "utf8")).not.toContain("restart");
  });

  test("login startup covers bash overrides and sh/dash; sync keeps the blocks; uninstall keeps secrets", async () => {
    const w = world();
    writeFileSync(join(w.home, ".bash_profile"), "# login config\n");
    await runSecrets(input, w.dependencies);
    for (const shell of ["sh", "dash", "bash"]) {
      const p = Bun.spawnSync([shell, "-lc", 'sh -c \'printf "%s" "$EXAMPLE_KEY"\''], { env: { ...process.env, HOME: w.home } });
      expect(p.exitCode).toBe(0);
      expect(p.stdout.toString()).toBe(value);
    }
    await w.link.run(profileBlockCommand([".local/bin"]));
    await w.link.run(secretsStartupCommand());
    expect(readFileSync(join(w.home, ".profile"), "utf8").match(/# >>> ferry secrets >>>/g)).toHaveLength(1);
    const plan = await planBoxUninstall([], w.link);
    expect(plan.secretsBlocks).toBe(true);
    await commitBoxUninstall(plan, w.link);
    for (const file of [".profile", ".bashrc", ".bash_profile", ".zprofile", ".zshrc"]) {
      expect(readFileSync(join(w.home, file), "utf8")).not.toContain("# >>> ferry secrets >>>");
    }
    expect(readFileSync(w.file(), "utf8")).toContain(value);
  });

  test("an interrupted publication keeps both old files, cleans the stage, and reports no value", async () => {
    const w = world();
    await runSecrets(input, w.dependencies);
    const before = readFileSync(w.file(), "utf8");
    const systemd = readFileSync(w.file("systemd.env"), "utf8");
    const error = await runSecrets({ ...input, replace: true }, { ...w.dependencies,
      createLink: () => ({ run: (command, options) => w.link.run(command.replace('mv -Tf "$pointer" "$dir/current"', "false"), options) }),
    }).catch(String);
    expect(error).not.toContain(value);
    expect(readFileSync(w.file(), "utf8")).toBe(before);
    expect(readFileSync(w.file("systemd.env"), "utf8")).toBe(systemd);
    expect(readdirSync(join(w.home, ".ferry/secrets")).filter((name) => name.startsWith(".generation."))).toHaveLength(1);
  });

  test("rejects unsupported names and combinations before SSH and releases the box lock", async () => {
    const w = world();
    for (const name of ["1KEY", "BAD-NAME", "FERRY_SECRET_LINE", value]) {
      const error = await runSecrets({ ...input, names: [name] }, w.dependencies).catch(String);
      expect(error).not.toContain(value);
      expect(w.commands).toEqual([]);
    }
    await expect(runSecrets({ ...input, file: "file", prompt: true }, w.dependencies)).rejects.toThrow("either");
    await expect(runSecrets({ ...input, prompt: true, json: true }, w.dependencies)).rejects.toThrow("unavailable");
    let released = false;
    await runSecrets(input, w.dependencies);
    await expect(runSecrets(input, { ...w.dependencies, lockBox: () => () => { released = true; } })).rejects.toThrow("--replace");
    expect(released).toBe(true);
  });

  test("uses only the selected box and refuses an ambiguous target", async () => {
    const w = world();
    const boxes = ["a", "b"].map((name) => ({ name, host: { transport: "ssh" as const, destination: `user@${name}.example` } }));
    const selected: string[] = [];
    const deps = { ...w.dependencies, readConfig: () => ({ boxes }), createLink: (options: Parameters<SecretsDependencies["createLink"]>[0]) => {
      selected.push("destination" in options ? options.destination : options.host); return w.link;
    } };
    await expect(runSecrets(input, deps)).rejects.toThrow("More than one box");
    expect(selected).toEqual([]);
    await runSecrets({ ...input, box: "b" }, deps);
    expect(selected).toEqual(["user@b.example"]);
  });

  test("CLI selects one box, wires flags, and reports names in JSON only", async () => {
    const out: string[] = [];
    const inputs: SecretsInput[] = [];
    for (const args of [["set", "EXAMPLE_KEY", "--file", "selected.env", "--replace", "--yes"], ["remove", "EXAMPLE_KEY", "--yes"], ["status"]]) {
      await buildProgram({ runSecrets: async (input) => {
        inputs.push(input); return { box: "a", secrets: { present: true, names: ["EXAMPLE_KEY"] }, steps: [] };
      }, writeLine: (line) => out.push(line) }).parseAsync(["secrets", ...args, "--box", "a", "--json"], { from: "user" });
    }
    expect(inputs.map((input) => [input.action, input.box])).toEqual([["set", "a"], ["remove", "a"], ["status", "a"]]);
    expect(inputs[0]).toMatchObject({ names: ["EXAMPLE_KEY"], file: "selected.env", replace: true, yes: true });
    expect(out.map((line) => JSON.parse(line).result.secrets)).toEqual(Array(3).fill({ present: true, names: ["EXAMPLE_KEY"] }));
    const w = world();
    const errors: string[] = [];
    await runCli(["secrets", "set", "EXAMPLE_KEY", "--json"], {
      isBoxMode: () => false, readConfig: w.dependencies.readConfig,
      runSecrets: (input, dependencies) => runSecrets(input, { ...w.dependencies, ...dependencies }),
      writeLine: (line) => errors.push(line), writeError: () => {},
    }, { setExitCode: () => {} });
    expect(JSON.parse(errors[0]!).error.code).toBe("confirmation-required");
    expect(errors.join("\n")).not.toContain(value);
    expect(w.commands).toEqual([]);
  });

  test("file, prompt, status, and optional service failures cannot report a value", async () => {
    const w = world();
    const path = join(w.root, "bad.env");
    for (const contents of [Buffer.from(`INVALID ${value}`), Buffer.from([0xff])]) {
      writeFileSync(path, contents);
      const error = await runSecrets({ ...input, file: path }, w.dependencies).catch(String);
      expect(error).toContain("literal NAME=value");
      expect(error).not.toContain(value);
    }
    const error = await runSecrets({ ...input, prompt: true }, { ...w.dependencies, prompt: async () => { throw new Error(value); } }).catch(String);
    expect(error).not.toContain(value);
    await runSecrets(input, w.dependencies);
    const statusError = await runSecrets({ action: "status", names: [] }, { ...w.dependencies,
      createLink: () => ({ run: async () => ({ ok: true, address: "box", stdout: value, stderr: value }) }),
    }).catch(String);
    expect(statusError).not.toContain(value);
    const result = await runSecrets({ ...input, replace: true }, { ...w.dependencies,
      readConfig: () => ({ ...w.dependencies.readConfig(), integrations: { paseo: true } }),
      createLink: () => ({ run: (command, options) => command.includes("ferry-paseo.service")
        ? Promise.reject(new Error(value)) : w.link.run(command, options) }),
    });
    expect(result?.steps.join(" ")).toContain("Secrets were stored for shell sessions");
    expect(JSON.stringify(result)).not.toContain(value);
  });
});
