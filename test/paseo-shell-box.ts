import { test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { IntegrationLink } from "../src/integrations/types.ts";

const HAS_JQ = Bun.which("jq") !== null;

/** A test that runs box scripts with a real jq. It skips, and says why, when jq is not on the PATH. */
export function jqTest(title: string, run: () => void | Promise<void>): void {
  test.skipIf(!HAS_JQ)(HAS_JQ ? title : `${title} (skipped: jq is not on the PATH)`, run);
}

export type ShellBox = {
  readonly home: string;
  readonly link: IntegrationLink;
  readonly commands: string[];
  /** The stdout and stderr of each command, as Ferry receives them. */
  readonly outputs: string[];
  /** The box Paseo config, parsed. Undefined when the file is missing. */
  config(): any;
  /** The box Paseo config text. */
  text(): string;
  /** The `paseo` calls, such as `paseo daemon reload`. */
  log(): string[];
  remove(): void;
};

/**
 * A fake box for the Paseo config. Each Link command runs in `sh` in a
 * temporary home, with the real jq, a fake `systemctl`, and a fake `paseo`
 * that logs its arguments.
 * `config` is the box `~/.paseo/config.json`: a value, the file text, or null
 * for no file. `answer` replies to a command without the shell, when it
 * returns text. With `jq: false`, the box PATH has no jq.
 */
export function shellBox(options: {
  readonly config?: unknown;
  readonly status?: unknown;
  readonly plugins?: unknown;
  readonly jq?: boolean;
  readonly answer?: (command: string) => string | undefined;
} = {}): ShellBox {
  const root = mkdtempSync(join(tmpdir(), "ferry-paseo-shell-"));
  const home = join(root, "home");
  const bin = join(root, "bin");
  const logPath = join(root, "log");
  const file = join(home, ".paseo/config.json");
  mkdirSync(bin, { recursive: true });
  writeFileSync(logPath, "");
  writeFileSync(join(root, "status"), JSON.stringify(options.status ?? { localDaemon: "running", providers: [] }));
  writeFileSync(join(root, "plugins"), JSON.stringify(options.plugins ?? []));
  writeFileSync(join(bin, "paseo"), [
    "#!/bin/sh",
    `echo "paseo $*" >> ${JSON.stringify(logPath)}`,
    'case "$1 $2" in',
    `  "daemon status") cat ${JSON.stringify(join(root, "status"))} ;;`,
    `  "plugin ls") cat ${JSON.stringify(join(root, "plugins"))} ;;`,
    '  "daemon reload") ;;',
    "  *) echo '{}' ;;",
    "esac",
    "",
  ].join("\n"));
  // The daemon status command asks systemctl first whether the unit is active.
  writeFileSync(join(bin, "systemctl"), "#!/bin/sh\nexit 0\n");
  for (const name of ["paseo", "systemctl"]) chmodSync(join(bin, name), 0o755);
  if (options.jq === false) {
    for (const program of ["sh", "cat"]) symlinkSync(Bun.which(program) as string, join(bin, program));
  }
  const config = options.config === undefined ? {} : options.config;
  mkdirSync(join(home, ".paseo"), { recursive: true });
  if (config !== null) writeFileSync(file, typeof config === "string" ? config : JSON.stringify(config));

  const commands: string[] = [];
  const outputs: string[] = [];
  const link: IntegrationLink = {
    run: async (command) => {
      commands.push(command);
      const answer = options.answer?.(command);
      if (answer !== undefined) return { ok: true, address: "box", stdout: answer, stderr: "" };
      const process = Bun.spawn(["/bin/sh", "-c", command], {
        cwd: home,
        env: { ...Bun.env, HOME: home, PATH: options.jq === false ? bin : `${bin}:${Bun.env.PATH}` },
        stdin: "ignore",
        stdout: "pipe",
        stderr: "pipe",
      });
      const [exitCode, stdout, stderr] = await Promise.all([
        process.exited,
        new Response(process.stdout).text(),
        new Response(process.stderr).text(),
      ]);
      outputs.push(stdout, stderr);
      return exitCode === 0
        ? { ok: true, address: "box", stdout, stderr }
        : { ok: false, error: { code: "command-failed", origin: "box", message: stderr.trim() || `exit ${exitCode}` } };
    },
  };
  return {
    home,
    link,
    commands,
    outputs,
    config: () => (existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : undefined),
    text: () => readFileSync(file, "utf8"),
    log: () => readFileSync(logPath, "utf8").split("\n").filter((line) => line !== "" && !line.startsWith("paseo daemon status") && !line.startsWith("paseo plugin ls")),
    remove: () => rmSync(root, { recursive: true, force: true }),
  };
}
