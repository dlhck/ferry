import { describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { HostAdapter, HostCommand, LinkResult } from "../src/link.ts";
import type { ToolDescriptor } from "../src/registry/types.ts";
import { checkTools } from "../src/tools/check.ts";
import { pathExport } from "../src/tools/path.ts";

/** Operator versions by local version command. A command that is not here fails. */
function fakeLocal(versions: Record<string, string>): HostAdapter & { readonly calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    async run(command: HostCommand) {
      const script = command.argv.at(-1) ?? "";
      calls.push(script);
      const entry = Object.entries(versions).find(([key]) => script.endsWith(key));
      return entry
        ? { exitCode: 0, stdout: `${entry[1]}\n`, stderr: "", timedOut: false }
        : { exitCode: 127, stdout: "", stderr: "not found", timedOut: false };
    },
  };
}

/** One line of the box script output: id, run, exit code, stdout, stderr. */
function line(id: string, run: "ferry" | "login", version: string | null): string {
  return version === null ? `${id}\t${run}\t127\t\tnot found` : `${id}\t${run}\t0\t${version}\t`;
}

function fakeBox(lines: readonly string[]): { run(command: string): Promise<LinkResult>; readonly calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    async run(command: string) {
      calls.push(command);
      return { ok: true, address: "100.64.0.8", stdout: `${lines.join("\n")}\n`, stderr: "" };
    },
  };
}

const tool = (id: string, extra: Partial<ToolDescriptor> = {}): ToolDescriptor => ({
  id,
  kind: "tool",
  localVersion: `${id} --version`,
  boxVersion: `${id} --version`,
  recipe: { install: (v) => `install ${id} ${v}`, update: (v) => `update ${id} ${v}` },
  pathDirs: [`.${id}/bin`],
  ...extra,
});

describe("checkTools", () => {
  test("gives ok, drift, missing, and hidden rows from one box call", async () => {
    const tools = [tool("bun"), tool("node"), tool("pnpm"), tool("uv")];
    const local = fakeLocal({ "bun --version": "1.4.2", "node --version": "v24.16.0", "pnpm --version": "11.17.0", "uv --version": "0.9.2" });
    const box = fakeBox([
      line("bun", "ferry", "1.4.2"),
      line("bun", "login", "1.4.2"),
      line("node", "ferry", "v22.22.1"),
      line("node", "login", "v22.22.1"),
      line("pnpm", "ferry", null),
      line("pnpm", "login", null),
      line("uv", "ferry", "uv 0.9.2"),
      line("uv", "login", null),
    ]);

    const rows = await checkTools(tools, undefined, local, box);

    expect(box.calls).toHaveLength(1);
    expect(rows).toEqual([
      { id: "bun", mode: "mirror", policy: "operator", operator: "1.4.2", target: "1.4.2", box: "1.4.2", state: "ok" },
      { id: "node", mode: "mirror", policy: "operator", operator: "24.16.0", target: "24.16.0", box: "22.22.1", state: "drift" },
      { id: "pnpm", mode: "mirror", policy: "operator", operator: "11.17.0", target: "11.17.0", box: null, state: "missing" },
      {
        id: "uv",
        mode: "mirror",
        policy: "operator",
        operator: "0.9.2",
        target: "0.9.2",
        box: "0.9.2",
        state: "hidden",
        reason: "the login shell PATH does not find it",
      },
    ]);
  });

  test("a login shell that finds another version is hidden", async () => {
    const box = fakeBox([line("node", "ferry", "24.16.0"), line("node", "login", "22.22.1")]);

    const [row] = await checkTools([tool("node")], undefined, fakeLocal({ "node --version": "24.16.0" }), box);

    expect(row).toMatchObject({ state: "hidden", reason: "the login shell PATH finds 22.22.1" });
  });

  test("skips a mirror tool that the operator machine does not have, and still shows the box version", async () => {
    const box = fakeBox([line("uv", "ferry", "0.9.2"), line("uv", "login", "0.9.2")]);

    const [row] = await checkTools([tool("uv")], undefined, fakeLocal({}), box);

    expect(row).toEqual({
      id: "uv",
      mode: "mirror",
      policy: "operator",
      operator: null,
      target: null,
      box: "0.9.2",
      state: "skipped",
      reason: "not on the operator machine",
    });
  });

  test("skips the latest policy without a latest command, with the resolver reason", async () => {
    const box = fakeBox([line("uv", "ferry", "0.9.2"), line("uv", "login", "0.9.2")]);

    const [row] = await checkTools([tool("uv")], { uv: "latest" }, fakeLocal({ "uv --version": "0.9.2" }), box);

    expect(row?.state).toBe("skipped");
    expect(row?.reason).toContain('uv has the policy "latest" but no latest command');
  });

  test("does not run the latest command, and a latest tool on the box is ok", async () => {
    const local = fakeLocal({ "pnpm --version": "11.17.0", "npm view pnpm version": "11.18.0" });
    const box = fakeBox([line("pnpm", "ferry", "11.17.0"), line("pnpm", "login", "11.17.0")]);

    const [row] = await checkTools(
      [tool("pnpm", { latestVersion: "npm view pnpm version" })],
      { pnpm: "latest" },
      local,
      box,
    );

    expect(row).toEqual({ id: "pnpm", mode: "mirror", policy: "latest", operator: "11.17.0", target: null, box: "11.17.0", state: "ok" });
    expect(local.calls.some((call) => call.includes("npm view"))).toBe(false);
  });

  test("an off tool is off, with no drift or missing state, and says that the box keeps it", async () => {
    const tools = [tool("gh"), tool("pi")];
    const box = fakeBox([line("gh", "ferry", "2.90.0"), line("gh", "login", "2.90.0"), line("pi", "ferry", null), line("pi", "login", null)]);

    const rows = await checkTools(tools, { gh: "off", pi: "off" }, fakeLocal({ "gh --version": "2.92.0" }), box);

    expect(rows).toEqual([
      {
        id: "gh",
        mode: "mirror",
        policy: "off",
        operator: "2.92.0",
        target: null,
        box: "2.90.0",
        state: "off",
        reason: "Ferry does not manage it and does not uninstall it from the box",
      },
      { id: "pi", mode: "mirror", policy: "off", operator: null, target: null, box: null, state: "off", reason: "Ferry does not manage it" },
    ]);
  });

  test("an exact policy compares the box with that version", async () => {
    const box = fakeBox([line("bun", "ferry", "1.4.2"), line("bun", "login", "1.4.2")]);

    const [row] = await checkTools([tool("bun")], { bun: "1.3.9" }, fakeLocal({ "bun --version": "1.4.2" }), box);

    expect(row).toMatchObject({ policy: "1.3.9", operator: "1.4.2", target: "1.3.9", box: "1.4.2", state: "drift" });
  });

  test("a tool without a box command is unknown and is not in the box script", async () => {
    const box = fakeBox([line("bun", "ferry", "1.4.2"), line("bun", "login", "1.4.2")]);

    const rows = await checkTools(
      [tool("bun"), tool("docker", { boxVersion: undefined })],
      undefined,
      fakeLocal({ "bun --version": "1.4.2", "docker --version": "29.4.0" }),
      box,
    );

    expect(rows[1]).toEqual({
      id: "docker",
      mode: "mirror",
      policy: "operator",
      operator: "29.4.0",
      target: "29.4.0",
      box: null,
      state: "unknown",
      reason: "no box version command",
    });
    expect(box.calls[0]).not.toContain("docker");
  });

  test("an offline box gives unknown rows and no box call", async () => {
    const rows = await checkTools([tool("bun")], undefined, fakeLocal({ "bun --version": "1.4.2" }), null);

    expect(rows).toEqual([
      { id: "bun", mode: "mirror", policy: "operator", operator: "1.4.2", target: "1.4.2", box: null, state: "unknown", reason: "host offline" },
    ]);
  });

  test("makes no box call when no tool has a box command", async () => {
    const box = fakeBox([]);

    await checkTools([tool("docker", { boxVersion: undefined })], undefined, fakeLocal({}), box);

    expect(box.calls).toEqual([]);
  });

  test("a failed box call is an error", async () => {
    const box = {
      async run(): Promise<LinkResult> {
        return { ok: false, error: { code: "command-timeout", origin: "box", message: "box command timed out" } };
      },
    };

    await expect(checkTools([tool("bun")], undefined, fakeLocal({}), box)).rejects.toThrow("box command timed out");
  });
});

describe("the box tools script in a shell", () => {
  test("reads each version with the ferry PATH and with a clean login shell that reads ~/.profile", async () => {
    const home = mkdtempSync(join(tmpdir(), "ferry-tools-check-"));
    try {
      for (const [dir, name, version] of [
        [".bun/bin", "bun", "1.4.2"],
        [".uv/bin", "uv", "uv 0.9.2"],
      ] as const) {
        mkdirSync(join(home, dir), { recursive: true });
        writeFileSync(join(home, dir, name), `#!/bin/sh\necho '${version}'\n`);
        chmodSync(join(home, dir, name), 0o755);
      }
      writeFileSync(join(home, ".profile"), 'export PATH="$HOME/.bun/bin:$PATH"\n');
      const tools = [tool("bun"), tool("uv"), tool("pnpm")];
      const box = {
        /** Like Link, put the ferry PATH in front of the command. */
        async run(command: string): Promise<LinkResult> {
          const child = Bun.spawnSync(["sh", "-c", `${pathExport([".bun/bin", ".uv/bin"])}; ${command}`], {
            env: { HOME: home, PATH: "/usr/bin:/bin" },
          });
          return { ok: true, address: "local", stdout: child.stdout.toString(), stderr: child.stderr.toString() };
        },
      };
      const local = fakeLocal({ "bun --version": "1.4.2", "uv --version": "0.9.2", "pnpm --version": "11.17.0" });

      const rows = await checkTools(tools, undefined, local, box);

      expect(rows.map((row) => [row.id, row.box, row.state])).toEqual([
        ["bun", "1.4.2", "ok"],
        ["uv", "0.9.2", "hidden"],
        ["pnpm", null, "missing"],
      ]);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});
