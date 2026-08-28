import { describe, expect, test } from "bun:test";
import { Link } from "../src/link.ts";
import type { HostAdapter, HostCommand, HostCommandResult } from "../src/link.ts";

const onlineStatus = JSON.stringify({
  Peer: {
    peerKey: {
      DNSName: "build-box.example.ts.net.",
      HostName: "build-box",
      Online: true,
      TailscaleIPs: ["100.64.0.8"],
    },
  },
});

class FakeHost implements HostAdapter {
  readonly commands: HostCommand[] = [];

  constructor(private readonly results: HostCommandResult[]) {}

  async run(command: HostCommand): Promise<HostCommandResult> {
    this.commands.push(command);
    const result = this.results.shift();
    if (!result) throw new Error(`unexpected command: ${command.argv.join(" ")}`);
    return result;
  }
}

function result(overrides: Partial<HostCommandResult> = {}): HostCommandResult {
  return { exitCode: 0, stdout: "", stderr: "", timedOut: false, ...overrides };
}

describe("Link", () => {
  test("an offline host returns one structured network failure without retrying", async () => {
    const status = JSON.stringify({
      Peer: {
        peerKey: {
          DNSName: "build-box.example.ts.net.",
          HostName: "build-box",
          Online: false,
          TailscaleIPs: ["100.64.0.8"],
        },
      },
    });
    const host = new FakeHost([result({ stdout: status })]);
    const link = new Link({ host: "build-box", user: "ferry" }, host);

    const outcome = await link.run("uname -a");

    expect(outcome).toEqual({
      ok: false,
      error: {
        code: "host-offline",
        origin: "network",
        message: expect.stringContaining("build-box"),
      },
    });
    expect(host.commands).toHaveLength(1);
    expect(host.commands[0]?.argv).toEqual(["tailscale", "status", "--json"]);
  });

  test("runs a command through ordinary OpenSSH at the resolved MagicDNS name", async () => {
    const host = new FakeHost([
      result({ stdout: onlineStatus }),
      result({ stdout: "Linux build-box\n" }),
    ]);
    const link = new Link({ host: "build-box", user: "ferry" }, host);

    const outcome = await link.run("uname -a");

    expect(outcome).toEqual({
      ok: true,
      address: "build-box.example.ts.net",
      stdout: "Linux build-box\n",
      stderr: "",
    });
    expect(host.commands[1]?.argv).toEqual([
      "ssh",
      "-o",
      "BatchMode=yes",
      "-o",
      "ConnectTimeout=10",
      "ferry@build-box.example.ts.net",
      "uname -a",
    ]);
  });

  test("agent forwarding is explicit and limited to the git purpose", async () => {
    const host = new FakeHost([result({ stdout: onlineStatus }), result()]);
    const link = new Link({ host: "build-box", user: "ferry" }, host);

    await link.run("git fetch", { agentForwarding: "git" });

    expect(host.commands[1]?.argv).toContain("-A");
  });

  test("a remote command failure names the box", async () => {
    const host = new FakeHost([
      result({ stdout: onlineStatus }),
      result({ exitCode: 7, stderr: "command failed" }),
    ]);
    const link = new Link({ host: "build-box", user: "ferry" }, host);

    const outcome = await link.run("false");

    expect(outcome).toEqual({
      ok: false,
      error: { code: "command-failed", origin: "box", message: "command failed" },
    });
  });

  test("a failed local Tailscale probe names the operator machine", async () => {
    const host = new FakeHost([result({ exitCode: 1, stderr: "tailscale not found" })]);
    const link = new Link({ host: "build-box", user: "ferry" }, host);

    const outcome = await link.run("true");

    expect(outcome).toEqual({
      ok: false,
      error: {
        code: "tailscale-status-failed",
        origin: "operator",
        message: "tailscale not found",
      },
    });
  });

  test("a port forward uses OpenSSH and reports its timeout", async () => {
    const host = new FakeHost([
      result({ stdout: onlineStatus }),
      result({ timedOut: true, exitCode: null }),
    ]);
    const link = new Link({ host: "build-box", user: "ferry" }, host);

    const outcome = await link.forward({ localPort: 1455, remotePort: 1455, timeoutMs: 2_000 });

    expect(outcome).toEqual({
      ok: false,
      error: {
        code: "forward-timeout",
        origin: "network",
        message: expect.stringContaining("2000 ms"),
      },
    });
    expect(host.commands[1]).toEqual({
      argv: [
        "ssh",
        "-N",
        "-o",
        "ExitOnForwardFailure=yes",
        "-o",
        "BatchMode=yes",
        "-o",
        "ConnectTimeout=10",
        "-L",
        "127.0.0.1:1455:127.0.0.1:1455",
        "ferry@build-box.example.ts.net",
      ],
      timeoutMs: 2_000,
    });
  });
});
