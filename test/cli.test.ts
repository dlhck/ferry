import { describe, expect, test } from "bun:test";
import { buildProgram } from "../src/cli.ts";

describe("ferry --help", () => {
  test("states that logins are not copied", () => {
    expect(buildProgram().helpInformation()).toContain("Ferry never copies logins.");
  });

  test("an unknown argument is refused", () => {
    const program = buildProgram().exitOverride();
    program.configureOutput({ writeOut: () => {}, writeErr: () => {} });
    expect(() => program.parse(["--sync-everything"], { from: "user" })).toThrow();
  });
});
