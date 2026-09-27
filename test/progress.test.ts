import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { lineProgress, plainProgress, step } from "../src/progress.ts";
import { fakeTerminal, recordProgress } from "./fake-progress.ts";

const HIDE = "\x1b[?25l";
const SHOW = "\x1b[?25h";
const CLEAR = "\r\x1b[2K";

describe("plainProgress", () => {
  test("writes one plain line for each step start and count, without control characters", () => {
    const lines: string[] = [];
    const progress = plainProgress((line) => lines.push(line));

    progress.plan(3);
    progress.start("Publishing the snapshot");
    progress.done("published abc1234");
    progress.skip("Updating the box checkout", "host offline");
    progress.start("Installing Claude plugins");
    progress.count(1, 2);
    progress.count(2, 2);
    progress.fail("offline");
    progress.pause();
    progress.finish();

    expect(lines).toEqual([
      "Publishing the snapshot...",
      "Installing Claude plugins...",
      "Installing Claude plugins (1/2)...",
      "Installing Claude plugins (2/2)...",
    ]);
    expect(lines.join("\n")).not.toMatch(/[\x00-\x09\x0b-\x1f\x7f]/);
  });

  test("writes held lines at once", () => {
    const lines: string[] = [];
    const writeLine = (line: string) => lines.push(line);

    expect(plainProgress(() => {}).hold(writeLine)).toBe(writeLine);
  });
});

describe("lineProgress", () => {
  test("rewrites one line with the position and the step, and leaves no line behind", () => {
    const terminal = fakeTerminal();

    terminal.progress.plan(3);
    terminal.progress.start("Publishing the snapshot");
    terminal.progress.done("published abc1234");
    terminal.progress.skip("Updating the box checkout", "host offline");
    terminal.progress.start("Installing Claude plugins");
    terminal.progress.count(3, 10);
    terminal.progress.done();

    expect(terminal.writes).toEqual([
      HIDE,
      `${CLEAR}◒ [1/3] Publishing the snapshot`,
      `${CLEAR}${SHOW}`,
      HIDE,
      `${CLEAR}◒ [3/3] Installing Claude plugins`,
      `${CLEAR}◒ [3/3] Installing Claude plugins (3/10)`,
      `${CLEAR}${SHOW}`,
    ]);
  });

  test("prints the summary table at finish, and then the held lines", () => {
    const log: string[] = [];
    let clock = 0;
    const progress = lineProgress({ write: (text) => log.push(text), columns: 80, color: false, now: () => (clock += 1500) });
    const writeLine = progress.hold((line) => log.push(`line:${line}`));

    progress.start("Checking the installed tools");
    writeLine("Box claude: claude update");
    progress.done("1 update, 0 skipped");
    progress.pause();
    progress.start("Updating box claude (1/1)");
    writeLine("Updated box claude.");
    progress.done();
    progress.finish();

    expect(log.filter((text) => !text.startsWith("\x1b") && !text.startsWith("\r"))).toEqual([
      "line:Box claude: claude update",
      [
        "Step                          Result     Detail                 Time",
        "Checking the installed tools  ✔ done     1 update, 0 skipped    1.5s",
        "Updating box claude (1/1)     ✔ done                            1.5s",
        "",
      ].join("\n"),
      "line:Updated box claude.",
    ]);
  });

  test("truncates the step and the detail so that the table fits the terminal", () => {
    for (const columns of [80, 50]) {
      const terminal = fakeTerminal(columns);
      terminal.progress.start(`Trusting the SSH host keys of ${"git.example.".repeat(4)}com on the box`);
      terminal.progress.fail(`box: ${"the command failed on the box, ".repeat(5)}`);
      terminal.progress.finish();

      const table = terminal.table();
      expect(table).toHaveLength(2);
      for (const line of table) expect(line.length).toBeLessThan(columns);
      expect(table[1]).toMatch(/^Trusting the SSH.*… +✖ failed +box: the c.*… +0\.1s$/);
    }
  });

  test("colors only the result marks when color is on", () => {
    const writes: string[] = [];
    const progress = lineProgress({ write: (text) => writes.push(text), columns: 80, color: true, now: () => 0 });

    progress.start("Merging settings on the box");
    progress.done();
    progress.finish();

    expect(writes.at(-1)).toContain("\x1b[32m✔ done   \x1b[0m");
  });

  test("shows the cursor again and marks the step failed when the step throws", async () => {
    const terminal = fakeTerminal();

    await expect(
      step(terminal.progress, "Publishing the snapshot", async () => {
        throw new Error("git remote: push rejected");
      }),
    ).rejects.toThrow("push rejected");
    terminal.progress.finish();

    expect(terminal.writes.slice(0, 3)).toEqual([HIDE, `${CLEAR}◒ Publishing the snapshot`, `${CLEAR}${SHOW}`]);
    expect(terminal.table()[1]).toBe("Publishing the snapshot  ✖ failed   git remote: push rejected    0.1s");
  });

  test("prints no table when no step ran", () => {
    const terminal = fakeTerminal();

    terminal.progress.finish();

    expect(terminal.writes).toEqual([]);
  });
});

describe("lineProgress and Ctrl-C", () => {
  /** Start a live step in a child process, send SIGINT, and return its stderr and exit state. */
  async function interrupt(extra: string): Promise<{ stderr: string; exitCode: number | null; signalCode: string | null }> {
    const script = [
      'import { lineProgress } from "./src/progress.ts";',
      "const progress = lineProgress({ write: (text) => process.stderr.write(text), columns: 80, color: false, now: () => 0 });",
      'progress.start("Waiting for the login");',
      "const keepAlive = setTimeout(() => {}, 5000);",
      extra,
      'process.stdout.write("ready\\n");',
    ].join("\n");
    const child = Bun.spawn(["bun", "-e", script], { cwd: join(import.meta.dir, ".."), stdout: "pipe", stderr: "pipe" });
    const reader = child.stdout.getReader();
    await reader.read();
    child.kill("SIGINT");
    const stderr = await new Response(child.stderr).text();
    await child.exited;
    return { stderr, exitCode: child.exitCode, signalCode: child.signalCode };
  }

  test("clears the line, shows the cursor, and stops the process", async () => {
    const result = await interrupt("");

    expect(result.signalCode).toBe("SIGINT");
    expect(result.stderr.startsWith(HIDE)).toBe(true);
    expect(result.stderr.endsWith(`${CLEAR}${SHOW}`)).toBe(true);
  });

  test("leaves the interrupt to another SIGINT handler, such as the login wait", async () => {
    const result = await interrupt(
      'process.once("SIGINT", () => { process.stderr.write("stopped the wait\\n"); clearTimeout(keepAlive); });',
    );

    expect(result.exitCode).toBe(0);
    expect(result.stderr.endsWith(`${CLEAR}${SHOW}stopped the wait\n`)).toBe(true);
  });
});

describe("step", () => {
  test("ends the step with a done mark and returns the result", async () => {
    const progress = recordProgress();

    expect(await step(progress, "Connecting to the box", async () => 42)).toBe(42);
    expect(progress.events).toEqual(["start:Connecting to the box", "done"]);
  });

  test("ends the step with a failed mark and throws the error again", async () => {
    const progress = recordProgress();

    await expect(
      step(progress, "Connecting to the box", async () => {
        throw new Error("offline");
      }),
    ).rejects.toThrow("offline");
    expect(progress.events).toEqual(["start:Connecting to the box", "fail"]);
  });
});

describe("step with a failure check", () => {
  test("ends the step with a failed mark when the result is a failure", async () => {
    const progress = recordProgress();

    const result = await step(progress, "Checking sudo on the box", async () => ({ ok: false }), (value) => !value.ok);

    expect(result).toEqual({ ok: false });
    expect(progress.events).toEqual(["start:Checking sudo on the box", "fail"]);
  });
});

describe("terminalProgress", () => {
  test("writes plain lines to stderr, no table, and the held lines at once, when the output is a pipe", async () => {
    const script = [
      'import { terminalProgress } from "./src/progress.ts";',
      "const progress = terminalProgress();",
      "progress.plan(2);",
      'progress.start("Declaring MCP servers");',
      "progress.count(2, 9);",
      'progress.done("2 servers");',
      'progress.skip("Adopting published local skills", "none");',
      'progress.hold((line) => console.log(line))("Box MCP: a warning");',
      "progress.finish();",
    ].join("\n");
    const child = Bun.spawn(["bun", "-e", script], { cwd: join(import.meta.dir, ".."), stdout: "pipe", stderr: "pipe" });
    const [stdout, stderr] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text()]);
    await child.exited;

    expect(stdout).toBe("Box MCP: a warning\n");
    expect(stderr).toBe("Declaring MCP servers...\nDeclaring MCP servers (2/9)...\n");
    expect(stderr).not.toContain("\x1b");
  });
});
