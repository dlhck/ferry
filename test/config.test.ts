import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { configPath, readConfig } from "../src/config.ts";

const homes: string[] = [];

afterEach(() => {
  for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true });
});

describe("operator config", () => {
  test("reads custom harness roots and instruction targets", () => {
    const home = mkdtempSync(join(tmpdir(), "ferry-config-"));
    homes.push(home);
    const path = configPath(home);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, [
      "version = 1",
      'publisher = "operator"',
      'snapshot_url = "snapshot.git"',
      "",
      "[host]",
      'tailscale = "box"',
      'ssh_user = "ferry"',
      "",
      "[[harness]]",
      'id = "opencode"',
      'name = "OpenCode"',
      'skill_root = ".config/opencode/skills"',
      'instruction_file = ".config/opencode/AGENTS.md"',
      "",
    ].join("\n"));

    expect(readConfig(home)).toMatchObject({
      harness: [{
        id: "opencode",
        name: "OpenCode",
        skillRoot: ".config/opencode/skills",
        instructionFile: ".config/opencode/AGENTS.md",
      }],
    });
  });
});
