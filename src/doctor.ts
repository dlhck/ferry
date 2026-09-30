/**
 * `ferry doctor`: check the setup that Ferry needs, and give a fix for each
 * failed check. Each check only reads. A failed check does not stop the
 * other checks, so one run names every problem.
 */

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { BOX_SNAPSHOT_KEY, resolveBoxes, snapshotGit, type ResolvedBox } from "./boxes.ts";
import { ConfigMissingError, readConfig, resolveLinkOptions, type PartialOperatorConfig } from "./config.ts";
import { BunHostAdapter, Link, type HostAdapter, type LinkError, type LinkOptions } from "./link.ts";
import { noProgress, step, type Progress } from "./progress.ts";
import {
  currentFerryCommand,
  installedServices,
  sameCommand,
  serviceFerryCommand,
  type SelfUpdateDependencies,
} from "./self-update.ts";
import { RealGitRunner, type GitRunner } from "./store.ts";
import { boxLockFile, boxLockOwner, ferryProcess, lockOwnerLine } from "./sync.ts";

const STORE_RELATIVE_PATH = ".ferry/store";
const LOCAL_TIMEOUT_MS = 10_000;
/** A new ref name, so the push check never fails as a non-fast-forward. The dry run does not create it. */
const PUSH_PROBE_REF = "refs/heads/ferry-doctor-probe";
/** Prints `unit=<name>` for each Ferry user service on the box, then `linger=<value>`. */
const BOX_LINGER_COMMAND = [
  'for unit in "$HOME"/.config/systemd/user/ferry-*.service; do [ -e "$unit" ] && printf \'unit=%s\\n\' "${unit##*/}"; done',
  'printf \'linger=%s\\n\' "$(loginctl show-user "$USER" -p Linger --value 2>/dev/null)"',
].join("; ");
/** Link errors of Tailscale on this machine. */
const LOCAL_TAILSCALE_ERRORS: readonly LinkError["code"][] = [
  "tailscale-status-failed",
  "tailscale-status-timeout",
  "tailscale-status-invalid",
];
/** Link errors of a box that the tailnet does not reach. */
const BOX_TAILSCALE_ERRORS: readonly LinkError["code"][] = ["host-not-found", "host-offline"];

export type DoctorCheckStatus = "ok" | "failed" | "skipped";

export type DoctorCheck = {
  /** A stable id, such as `ssh-agent` or `box-ssh`. */
  readonly id: string;
  /** The box of the check, or null for a check of this machine. */
  readonly box: string | null;
  readonly status: DoctorCheckStatus;
  readonly message: string;
  /** The command that fixes a failed check, or null. */
  readonly fix: string | null;
};

export type DoctorReport = {
  readonly schemaVersion: 1;
  /** True when no check failed. */
  readonly ok: boolean;
  readonly checks: readonly DoctorCheck[];
};

type DoctorLink = Pick<Link, "run">;

export type DoctorDependencies = {
  readonly readConfig: () => PartialOperatorConfig | null;
  readonly home: string;
  readonly createLink: (options: LinkOptions) => DoctorLink;
  /** Runs `ssh-add` and `tailscale` on this machine. */
  readonly local: HostAdapter;
  readonly git: GitRunner;
  /** The service files of this machine, and the command of this Ferry. */
  readonly services: Pick<
    SelfUpdateDependencies,
    "platform" | "home" | "exists" | "readFile" | "readDirectory" | "execPath" | "scriptPath"
  >;
  readonly progress: Progress;
};

export type DoctorInput = {
  /** Box names. An empty selection selects all boxes. */
  readonly selection?: readonly string[];
};

/** Run all checks and return one report. It changes nothing on this machine, the snapshot, or a box. */
export async function runDoctor(input: DoctorInput = {}, dependencies: Partial<DoctorDependencies> = {}): Promise<DoctorReport> {
  const resolved = { ...defaultDependencies(), ...dependencies };
  const config = resolved.readConfig();
  if (config === null) throw new ConfigMissingError("Ferry has no config. Run ferry init.");
  const boxes = resolveBoxes(config, input.selection ?? []);
  const progress = resolved.progress;
  const checks: DoctorCheck[] = [];

  checks.push(await checkAgent(resolved.local, progress));
  if (boxes.some((box) => box.host.transport !== "ssh")) checks.push(await checkLocalTailscale(resolved.local, progress));
  const snapshotUrl = config.snapshotUrl ?? null;
  const read = await checkSnapshotRead(resolved.git, snapshotUrl, progress);
  checks.push(read);
  checks.push(await checkSnapshotPush(resolved.git, resolved.home, snapshotUrl, read, progress));
  checks.push(...checkServices(resolved.services));

  for (const box of boxes) {
    const flag = config.boxes ? ` --box ${box.name}` : "";
    checks.push(...(await checkBox(box, flag, snapshotUrl, resolved.createLink(resolveLinkOptions(box.host)), progress)));
    checks.push(checkBoxLock(box, resolved));
  }
  return { schemaVersion: 1, ok: checks.every((check) => check.status !== "failed"), checks };
}

/** One line for each check. A failed check ends with its fix. */
export function formatDoctor(report: DoctorReport): string {
  return [
    ...report.checks.map((check) => {
      const label = check.box === null ? check.id : `${check.box} ${check.id}`;
      const fix = check.status === "failed" && check.fix !== null ? ` Fix: ${check.fix}` : "";
      return `${check.status.toUpperCase().padEnd(7)} ${label}: ${check.message}${fix}`;
    }),
    ...(report.ok ? ["", "All checks passed."] : []),
  ].join("\n");
}

/** The number of failed checks. */
export function failedChecks(report: DoctorReport): number {
  return report.checks.filter((check) => check.status === "failed").length;
}

async function checkAgent(local: HostAdapter, progress: Progress): Promise<DoctorCheck> {
  const base = { id: "ssh-agent", box: null } as const;
  const result = await step(progress, "Checking the SSH agent", () => runLocal(local, ["ssh-add", "-l"]), failed);
  if (result.ok) return { ...base, status: "ok", message: "The SSH agent has a key.", fix: null };
  return { ...base, status: "failed", message: `The SSH agent has no key: ${result.message}`, fix: "ssh-add" };
}

async function checkLocalTailscale(local: HostAdapter, progress: Progress): Promise<DoctorCheck> {
  const base = { id: "tailscale", box: null } as const;
  const result = await step(
    progress,
    "Checking Tailscale on this machine",
    () => runLocal(local, ["tailscale", "status", "--json"]),
    failed,
  );
  if (!result.ok) {
    return { ...base, status: "failed", message: `Tailscale does not run on this machine: ${result.message}`, fix: "tailscale up" };
  }
  let state: unknown;
  try {
    state = (JSON.parse(result.stdout) as { BackendState?: unknown }).BackendState;
  } catch {
    return { ...base, status: "failed", message: "Tailscale returned invalid status JSON.", fix: null };
  }
  if (state === "Running") return { ...base, status: "ok", message: "Tailscale is up on this machine.", fix: null };
  return { ...base, status: "failed", message: `Tailscale is ${String(state)} on this machine.`, fix: "tailscale up" };
}

async function checkSnapshotRead(git: GitRunner, url: string | null, progress: Progress): Promise<DoctorCheck> {
  const base = { id: "snapshot-read", box: null } as const;
  if (url === null) return { ...base, status: "failed", message: "The config has no snapshot_url.", fix: "ferry init" };
  const result = await step(progress, "Reading the snapshot", () => runGit(git, ["ls-remote", url, "HEAD"]), failed);
  if (result.ok) return { ...base, status: "ok", message: `This machine can read ${url}.`, fix: null };
  return { ...base, status: "failed", message: `This machine cannot read ${url}: ${result.message}`, fix: keyFix(url) };
}

/** `git push --dry-run` connects to the remote with write access, but sends no objects and changes no ref. */
async function checkSnapshotPush(
  git: GitRunner,
  home: string,
  url: string | null,
  read: DoctorCheck,
  progress: Progress,
): Promise<DoctorCheck> {
  const base = { id: "snapshot-push", box: null } as const;
  if (url === null || read.status !== "ok") {
    return { ...base, status: "skipped", message: "This machine cannot read the snapshot.", fix: null };
  }
  const store = join(home, STORE_RELATIVE_PATH);
  const result = await step(
    progress,
    "Checking push access to the snapshot",
    () => runGit(git, ["-C", store, "push", "--dry-run", "--porcelain", "origin", `HEAD:${PUSH_PROBE_REF}`]),
    failed,
  );
  if (result.ok) return { ...base, status: "ok", message: `This machine can push to ${url}.`, fix: null };
  return {
    ...base,
    status: "failed",
    message: `This machine cannot push to ${url} from ~/${STORE_RELATIVE_PATH}. The key needs write access: ${result.message}`,
    fix: keyFix(url),
  };
}

/** Each installed watch and tunnel service must run this Ferry. */
function checkServices(dependencies: DoctorDependencies["services"]): DoctorCheck[] {
  if (dependencies.platform !== "darwin" && dependencies.platform !== "linux") return [];
  const current = currentFerryCommand(dependencies);
  return installedServices(dependencies).map((entry): DoctorCheck => {
    const id = entry.box === undefined ? "watch-service" : `tunnel-service-${entry.box}`;
    const fix = entry.box === undefined ? "ferry watch install" : `ferry tunnel install --box ${entry.box}`;
    let command: readonly string[] | null;
    try {
      command = serviceFerryCommand(dependencies.readFile(entry.path), entry.service.args, dependencies.platform);
    } catch (error) {
      return { id, box: null, status: "failed", message: `Ferry cannot read ${entry.path}: ${messageOf(error)}`, fix };
    }
    if (command !== null && sameCommand(command, current)) {
      return { id, box: null, status: "ok", message: `${entry.path} runs this Ferry.`, fix: null };
    }
    return {
      id,
      box: null,
      status: "failed",
      message: `${entry.path} runs ${command?.join(" ") ?? "an unrecognized command"}, not ${current.join(" ")}.`,
      fix,
    };
  });
}

async function checkBox(
  box: ResolvedBox,
  flag: string,
  url: string | null,
  link: DoctorLink,
  progress: Progress,
): Promise<DoctorCheck[]> {
  const checks: DoctorCheck[] = [];
  const destination = box.host.transport === "ssh" ? box.host.destination : `${box.host.sshUser}@${box.host.tailscale}`;
  const check = (id: string, status: DoctorCheckStatus, message: string, fix: string | null = null) =>
    checks.push({ id, box: box.name, status, message, fix });

  const probe = await step(progress, `[${box.name}] Connecting to the box`, () => link.run("true"), failed);
  const error = probe.ok ? null : probe.error;
  const tailscale = box.host.transport !== "ssh";
  const tailscaleDown = error !== null && tailscale && [...LOCAL_TAILSCALE_ERRORS, ...BOX_TAILSCALE_ERRORS].includes(error.code);

  if (error === null) check("box-ssh", "ok", `${destination} responds over SSH.`);
  else if (tailscaleDown) check("box-ssh", "skipped", "Tailscale does not reach the box.");
  else check("box-ssh", "failed", `${destination} does not respond over SSH: ${error.message}`, sshFix(error, destination));

  if (tailscale) {
    if (error !== null && LOCAL_TAILSCALE_ERRORS.includes(error.code)) {
      check("box-tailscale", "skipped", "Tailscale does not run on this machine.");
    } else if (error !== null && BOX_TAILSCALE_ERRORS.includes(error.code)) {
      check("box-tailscale", "failed", `${error.message}. Run the fix on the box.`, "sudo tailscale up");
    } else {
      check("box-tailscale", "ok", "Tailscale is up on the box.");
    }
  }

  const offline = "The box does not respond over SSH.";
  if (url === null) {
    check("box-snapshot", "skipped", "The config has no snapshot_url.");
  } else if (error !== null) {
    check("box-snapshot", "skipped", offline);
  } else if (box.gitAuth === "box") {
    const read = await step(
      progress,
      `[${box.name}] Reading the snapshot with the deploy key`,
      () => link.run(`${snapshotGit("box")} ls-remote ${quoteShell(url)} HEAD`),
      failed,
    );
    if (read.ok) check("box-snapshot", "ok", `The deploy key ~/${BOX_SNAPSHOT_KEY} on the box can read the snapshot.`);
    else {
      check(
        "box-snapshot",
        "failed",
        `The deploy key ~/${BOX_SNAPSHOT_KEY} on the box cannot read the snapshot: ${read.error.message} ` +
          "Add the public key that the fix prints as a read-only deploy key on the snapshot repository.",
        `ssh ${destination} cat ~/${BOX_SNAPSHOT_KEY}.pub`,
      );
    }
  } else {
    const read = await step(
      progress,
      `[${box.name}] Reading the snapshot through the forwarded agent`,
      () => link.run(`git ls-remote ${quoteShell(url)} HEAD`, { agentForwarding: "git" }),
      failed,
    );
    if (read.ok) check("box-snapshot", "ok", "The box can read the snapshot through the forwarded SSH agent.");
    else {
      check(
        "box-snapshot",
        "failed",
        `The box cannot read the snapshot through the forwarded SSH agent: ${read.error.message}`,
        `ferry init${flag}`,
      );
    }
  }

  if (error !== null) {
    check("box-linger", "skipped", offline);
  } else {
    const result = await step(progress, `[${box.name}] Checking linger on the box`, () => link.run(BOX_LINGER_COMMAND), failed);
    if (!result.ok) check("box-linger", "failed", `Ferry cannot read linger on the box: ${result.error.message}`);
    else {
      const lines = result.stdout.split("\n");
      const units = lines.filter((line) => line.startsWith("unit=")).map((line) => line.slice("unit=".length));
      const linger = lines.find((line) => line.startsWith("linger="))?.slice("linger=".length) ?? "";
      if (units.length === 0) check("box-linger", "skipped", "No Ferry service runs on the box.");
      else if (linger === "yes") check("box-linger", "ok", `Linger is on for the box user, for ${units.join(", ")}.`);
      else {
        check(
          "box-linger",
          "failed",
          `Linger is off for the box user, so ${units.join(", ")} stops at logout.`,
          `ssh ${destination} 'sudo loginctl enable-linger "$USER"'`,
        );
      }
    }
  }
  return checks;
}

/**
 * The lock of the box on this machine. A live owner of this Ferry version is information. The lock
 * of an earlier Ferry version has no process start, so Ferry keeps it while a process has its pid.
 * The fix stops the process only when it is a Ferry process. When a different program has the
 * pid, the fix removes the lock file.
 */
function checkBoxLock(box: ResolvedBox, dependencies: Pick<DoctorDependencies, "home" | "services">): DoctorCheck {
  const base = { id: "box-lock", box: box.name } as const;
  const owner = boxLockOwner(dependencies.home, box);
  if (owner === null) return { ...base, status: "ok", message: "No Ferry command holds the lock of the box.", fix: null };
  const line = lockOwnerLine(box.name, owner);
  if (!owner.earlierVersion) return { ...base, status: "ok", message: line, fix: null };
  if (owner.otherProgram) {
    return {
      ...base,
      status: "failed",
      message: `${line} Remove the lock file.`,
      fix: `rm ${quoteShell(boxLockFile(dependencies.home, box))}`,
    };
  }
  const running = ferryProcess(owner.pid);
  const stop = `kill ${owner.pid}`;
  const platform = dependencies.services.platform;
  const watch = (platform === "darwin" || platform === "linux") &&
    installedServices(dependencies.services).some((entry) => entry.box === undefined);
  return {
    ...base,
    status: "failed",
    message: `${line} A sync of the box fails while a process has that pid.${
      watch
        ? ` If the fix does not free the lock, stop the process with ${stop}.`
        : running === null ? " Stop the process." : ` The process is ${running}. Stop it.`
    }`,
    fix: watch ? "ferry watch install" : stop,
  };
}

/** The fix of an SSH failure. A changed or unknown host key needs the operator to check the fingerprint. */
function sshFix(error: LinkError, destination: string): string {
  if (/host key/i.test(error.message)) return `ssh ${destination}`;
  if (/permission denied/i.test(error.message)) return `ssh-copy-id ${destination}`;
  return `ssh ${destination} true`;
}

/** Load a key with access to the snapshot. Only an SSH remote uses the agent. */
function keyFix(url: string): string | null {
  return /^(https?|file):\/\//.test(url) ? null : "ssh-add";
}

/** A failed probe is a failed progress step. */
function failed(result: { readonly ok: boolean }): boolean {
  return !result.ok;
}

type LocalResult = { readonly ok: true; readonly stdout: string } | { readonly ok: false; readonly message: string };

async function runLocal(local: HostAdapter, argv: readonly string[]): Promise<LocalResult> {
  try {
    const result = await local.run({ argv, timeoutMs: LOCAL_TIMEOUT_MS });
    if (result.timedOut) return { ok: false, message: `${argv[0]} timed out.` };
    if (result.exitCode === 0) return { ok: true, stdout: result.stdout };
    return { ok: false, message: result.stderr.trim() || result.stdout.trim() || `${argv[0]} failed.` };
  } catch (error) {
    return { ok: false, message: messageOf(error) };
  }
}

async function runGit(git: GitRunner, args: readonly string[]): Promise<LocalResult> {
  const decoder = new TextDecoder();
  try {
    const result = await git.run({ args });
    const stdout = decoder.decode(result.stdout);
    if (result.status === 0) return { ok: true, stdout };
    return { ok: false, message: decoder.decode(result.stderr).trim() || stdout.trim() || "git failed." };
  } catch (error) {
    return { ok: false, message: messageOf(error) };
  }
}

function quoteShell(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

function messageOf(error: unknown): string {
  return error instanceof Error && error.message ? error.message : String(error);
}

function defaultDependencies(): DoctorDependencies {
  const home = homedir();
  return {
    readConfig,
    home,
    createLink: (options) => new Link(options),
    local: new BunHostAdapter(),
    git: new RealGitRunner(),
    services: {
      platform: process.platform,
      home,
      exists: existsSync,
      readFile: (path) => readFileSync(path, "utf8"),
      readDirectory: readdirSync,
      execPath: process.execPath,
      scriptPath: process.argv[1],
    },
    progress: noProgress,
  };
}
