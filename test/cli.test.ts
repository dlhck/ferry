import { describe, expect, test } from "bun:test";
import { buildProgram } from "../src/cli.ts";
import type { InitInput, InitResult } from "../src/init.ts";

describe("ferry --help", () => {
  test("states that logins are not copied", () => {
    expect(buildProgram().helpInformation()).toContain("Ferry never copies logins.");
  });

  test("an unknown argument is refused", () => {
    const program = buildProgram().exitOverride();
    program.configureOutput({ writeOut: () => {}, writeErr: () => {} });
    expect(() => program.parse(["--sync-everything"], { from: "user" })).toThrow();
  });

  test("wires init flags to the init module", async () => {
    let received: InitInput | undefined;
    const result: InitResult = {
      address: "100.64.0.9",
      paseoPort: 6767,
      leftovers: [],
      published: true,
    };
    const output: string[] = [];
    const program = buildProgram({
      runInit: async (input) => {
        received = input;
        return result;
      },
      prompt: async () => ({}),
      writeLine: (line) => output.push(line),
    });

    await program.parseAsync(
      [
        "init",
        "--host",
        "builder.tailnet.ts.net",
        "--ssh-user",
        "david",
        "--snapshot-url",
        "snapshot.git",
      ],
      { from: "user" },
    );

    expect(received).toMatchObject({
      host: "builder.tailnet.ts.net",
      sshUser: "david",
      snapshotUrl: "snapshot.git",
    });
    expect(output).toContain("Paseo: 100.64.0.9:6767");
  });

  test("init help lists every non-interactive flag", () => {
    const help = buildProgram().commands
      .find((command) => command.name() === "init")
      ?.helpInformation();

    expect(help).toContain("--host <host>");
    expect(help).toContain("--ssh-user <user>");
    expect(help).toContain("--snapshot-url <url>");
  });
});
