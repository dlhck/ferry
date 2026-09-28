import { describe, expect, test } from "bun:test";
import {
  BOX_FERRY_VERSION_COMMAND,
  boxFerryInstallCommand,
  boxFerryStatus,
  planBoxFerry,
} from "../src/box-ferry.ts";
import type { LinkResult } from "../src/link.ts";
import { isReleaseVersion } from "../src/version.ts";

/** A box whose Ferry version command prints `version`, or nothing when it is null. */
function box(version: string | null) {
  const commands: string[] = [];
  return {
    commands,
    async run(command: string): Promise<LinkResult> {
      commands.push(command);
      if (command === BOX_FERRY_VERSION_COMMAND && version !== null) {
        return { ok: true, address: "box.example", stdout: `${version}\n`, stderr: "" };
      }
      return { ok: false, error: { code: "command-failed", origin: "box", message: "no ferry" } };
    },
  };
}

describe("isReleaseVersion", () => {
  test("a release version passes, and a development build or other text does not", () => {
    expect(isReleaseVersion("1.2.3")).toBe(true);
    expect(isReleaseVersion("1.2.3-rc.1")).toBe(true);
    expect(isReleaseVersion("0.0.0-dev")).toBe(false);
    expect(isReleaseVersion("v1.2.3")).toBe(false);
    expect(isReleaseVersion("1.2.3; rm -rf ~")).toBe(false);
  });
});

describe("boxFerryInstallCommand", () => {
  test("installs the release of the version with its own install.sh to ~/.local/bin, then writes the box marker", () => {
    const command = boxFerryInstallCommand("1.2.3");
    expect(command).toContain("https://raw.githubusercontent.com/dlhck/ferry/v1.2.3/install.sh");
    expect(command).toContain('FERRY_VERSION=v1.2.3 FERRY_INSTALL_DIR="$HOME/.local/bin" sh "$ferry_tmp"');
    expect(command).toContain(`'{"mode":"box","version":"1.2.3"}' > "$HOME/.ferry/box.json"`);
    // The marker is written only after the installer succeeds.
    expect(command.indexOf('exit "$ferry_rc"')).toBeLessThan(command.indexOf("box.json"));
  });

  test("refuses a version without a release", () => {
    expect(() => boxFerryInstallCommand("0.0.0-dev")).toThrow("not a Ferry release version");
  });
});

describe("planBoxFerry", () => {
  test("a development build is skipped and does not read the box", async () => {
    const fake = box("1.0.0");
    expect(await planBoxFerry("install", fake, "0.0.0-dev")).toEqual({
      tool: "ferry",
      policy: "operator",
      version: null,
      action: "skip-dev-build",
      dependsOn: [],
    });
    expect(fake.commands).toEqual([]);
  });

  test("the box version follows the version of this Ferry", async () => {
    expect(await planBoxFerry("update", box("1.2.3"), "1.2.3")).toMatchObject({ action: "skip-same", version: "1.2.3" });
    expect(await planBoxFerry("update", box("1.2.0"), "1.2.3")).toMatchObject({
      action: "update",
      version: "1.2.3",
      command: boxFerryInstallCommand("1.2.3"),
    });
    // A newer box version goes back to the version of this Ferry.
    expect(await planBoxFerry("update", box("1.3.0"), "1.2.3")).toMatchObject({ action: "update", version: "1.2.3" });
    expect(await planBoxFerry("update", box(null), "1.2.3")).toMatchObject({ action: "install", version: "1.2.3" });
    expect(await planBoxFerry("install", box("1.2.0"), "1.2.3")).toMatchObject({ action: "install", version: "1.2.3" });
  });

  test("the box version command needs the box marker", () => {
    expect(BOX_FERRY_VERSION_COMMAND).toBe('[ -f "$HOME/.ferry/box.json" ] && "$HOME/.local/bin/ferry" --version');
  });
});

describe("boxFerryStatus", () => {
  test("compares the box version with the version of this Ferry", async () => {
    const base = { id: "ferry", mode: "always", policy: "operator", operator: "1.2.3", target: "1.2.3" } as const;
    expect(await boxFerryStatus(box("1.2.3"), "1.2.3")).toEqual({ ...base, box: "1.2.3", state: "ok" });
    expect(await boxFerryStatus(box("1.2.0"), "1.2.3")).toEqual({ ...base, box: "1.2.0", state: "drift" });
    expect(await boxFerryStatus(box(null), "1.2.3")).toEqual({ ...base, box: null, state: "missing" });
    expect(await boxFerryStatus(null, "1.2.3")).toEqual({ ...base, box: null, state: "unknown", reason: "host offline" });
  });

  test("a development build has no target", async () => {
    expect(await boxFerryStatus(box("1.2.3"), "0.0.0-dev")).toEqual({
      id: "ferry",
      mode: "always",
      policy: "operator",
      operator: "0.0.0-dev",
      target: null,
      box: "1.2.3",
      state: "skipped",
      reason: "this Ferry is a development build",
    });
  });
});
