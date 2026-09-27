import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { plainProgress, step } from "../src/progress.ts";
import { recordProgress } from "./fake-progress.ts";

describe("plainProgress", () => {
  test("writes one plain line for each step start and count, without control characters", () => {
    const lines: string[] = [];
    const progress = plainProgress((line) => lines.push(line));

    progress.start("Publishing the snapshot");
    progress.done();
    progress.start("Installing Claude plugins");
    progress.count(1, 2);
    progress.count(2, 2);
    progress.fail();

    expect(lines).toEqual([
      "Publishing the snapshot...",
      "Installing Claude plugins...",
      "Installing Claude plugins (1/2)...",
      "Installing Claude plugins (2/2)...",
    ]);
    expect(lines.join("\n")).not.toMatch(/[\x00-\x09\x0b-\x1f\x7f]/);
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
  test("writes plain lines to stderr, and nothing to stdout, when the output is a pipe", async () => {
    const script = [
      'import { terminalProgress } from "./src/progress.ts";',
      "const progress = terminalProgress();",
      'progress.start("Declaring MCP servers");',
      "progress.count(2, 9);",
      "progress.done();",
    ].join("\n");
    const child = Bun.spawn(["bun", "-e", script], { cwd: join(import.meta.dir, ".."), stdout: "pipe", stderr: "pipe" });
    const [stdout, stderr] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text()]);
    await child.exited;

    expect(stdout).toBe("");
    expect(stderr).toBe("Declaring MCP servers...\nDeclaring MCP servers (2/9)...\n");
    expect(stderr).not.toContain("\x1b");
  });
});
