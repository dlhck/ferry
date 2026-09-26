import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { configPath, readConfig, writeConfig } from "../src/config.ts";

const homes: string[] = [];

function homeWithConfig(lines: readonly string[]): string {
  const home = mkdtempSync(join(tmpdir(), "ferry-config-"));
  homes.push(home);
  const path = configPath(home);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, [...lines, ""].join("\n"));
  return home;
}

const BASE = [
  "version = 1",
  'publisher = "operator"',
  'snapshot_url = "snapshot.git"',
  "",
  "[host]",
  'tailscale = "box"',
  'ssh_user = "ferry"',
];

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

  test("writing the config keeps custom harness entries", () => {
    const home = homeWithConfig(BASE);
    const harness = [{
      id: "opencode",
      name: "OpenCode",
      skillRoot: ".config/opencode/skills",
      instructionFile: ".config/opencode/AGENTS.md",
    }];

    writeConfig({
      version: 1,
      publisher: "operator",
      snapshotUrl: "snapshot.git",
      host: { tailscale: "box", sshUser: "ferry" },
      harness,
    }, home);

    expect(readConfig(home)?.harness).toEqual(harness);
  });

  test("refuses an unknown key and names it", () => {
    const home = homeWithConfig([...BASE, "", "[[harness]]", 'id = "opencode"', 'skil_root = ".config/opencode/skills"']);

    expect(() => readConfig(home)).toThrow("unknown key skil_root in [[harness]]");
  });

  test("refuses a known key in the wrong section", () => {
    const home = homeWithConfig([...BASE, 'snapshot_url = "other.git"']);

    expect(() => readConfig(home)).toThrow("unknown key snapshot_url in [host]");
  });

  test("refuses an unknown section", () => {
    const home = homeWithConfig([...BASE, "", "[[tool]]", 'id = "aider"']);

    expect(() => readConfig(home)).toThrow("unsupported line [[tool]]");
  });
});
