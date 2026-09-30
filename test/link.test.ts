import { describe, expect, test } from "bun:test";
import { BunHostAdapter, Link, reachCommand } from "../src/link.ts";
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

const BOX_PATH = 'export PATH="$HOME/.local/bin:$HOME/.pi/agent/bin:$PATH"; ';

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
      `${BOX_PATH}uname -a`,
    ]);
  });

  test("runs a command through an explicit SSH destination without Tailscale", async () => {
    const host = new FakeHost([result({ stdout: "/home/user\n" })]);
    const link = new Link({ destination: "user@box.example" }, host);

    const outcome = await link.run(`printf '%s\\n' "$HOME"`);

    expect(outcome).toEqual({
      ok: true,
      address: "user@box.example",
      stdout: "/home/user\n",
      stderr: "",
    });
    expect(host.commands).toEqual([
      {
        argv: [
          "ssh",
          "-o",
          "BatchMode=yes",
          "-o",
          "ConnectTimeout=10",
          "user@box.example",
          `${BOX_PATH}printf '%s\\n' "$HOME"`,
        ],
        timeoutMs: 30_000,
      },
    ]);
  });

  test("refuses an option-shaped SSH destination before execution", async () => {
    const host = new FakeHost([]);
    const link = new Link({ destination: "-oProxyCommand=unsafe" }, host);

    const outcome = await link.run("true");

    expect(outcome).toEqual({
      ok: false,
      error: {
        code: "invalid-config",
        origin: "operator",
        message: "the SSH destination is invalid",
      },
    });
    expect(host.commands).toEqual([]);
  });

  test("agent forwarding is explicit and limited to the git purpose", async () => {
    const host = new FakeHost([result({ stdout: onlineStatus }), result()]);
    const link = new Link({ host: "build-box", user: "ferry" }, host);

    await link.run("git fetch", { agentForwarding: "git" });

    expect(host.commands[1]?.argv).toContain("-A");
    expect(host.commands[1]?.argv.at(-1)).toBe(`${BOX_PATH}git fetch`);
  });

  test("input bytes go to the standard input of the SSH command", async () => {
    const host = new FakeHost([result()]);
    const link = new Link({ destination: "ubuntu@orb" }, host);
    const input = new Uint8Array([0, 1, 2, 255]);

    await link.run("tar -xf -", { input });

    expect(host.commands[0]?.input).toEqual(input);
    expect(host.commands[0]?.argv.at(-1)).toBe(`${BOX_PATH}tar -xf -`);
  });

  test("the host adapter writes input bytes to stdin and closes stdin without input", async () => {
    const adapter = new BunHostAdapter();

    const withInput = await adapter.run({
      argv: ["sh", "-c", "wc -c"],
      timeoutMs: 5_000,
      input: new Uint8Array(1_000),
    });
    const without = await adapter.run({ argv: ["sh", "-c", "wc -c"], timeoutMs: 5_000 });

    expect(withInput.stdout.trim()).toBe("1000");
    expect(without.stdout.trim()).toBe("0");
  });

  test("the box shell finds vendor CLIs in the user install directories", async () => {
    const host = new FakeHost([result()]);
    const link = new Link({ destination: "user@box.example" }, host);

    await link.run(`printf '%s|%s' "$PATH" "a b"`);

    const remote = host.commands[0]?.argv.at(-1) ?? "";
    const shell = Bun.spawnSync(["sh", "-c", remote], {
      env: { HOME: "/home/ubuntu", PATH: "/usr/bin:/bin" },
    });
    expect(shell.stdout.toString()).toBe(
      "/home/ubuntu/.local/bin:/home/ubuntu/.pi/agent/bin:/usr/bin:/bin|a b",
    );
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
      error: {
        code: "command-failed",
        origin: "box",
        message: "command failed",
        output: { stdout: "", stderr: "command failed" },
      },
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

  test("an aborted signal stops the port forward and reports forward-stopped, not an error", async () => {
    const stop = new AbortController();
    const host = new FakeHost([result({ exitCode: 255 })]);
    const link = new Link({ destination: "user@box.example" }, host);
    stop.abort();

    const outcome = await link.forward({
      localPort: 1455,
      remotePort: 1455,
      timeoutMs: 2_000,
      signal: stop.signal,
    });

    expect(host.commands[0]?.signal).toBe(stop.signal);
    expect(outcome).toEqual({
      ok: true,
      stopped: true,
      address: "user@box.example",
      stdout: "",
      stderr: "",
    });
  });

  test("the host adapter stops the command when its signal aborts", async () => {
    const stop = new AbortController();
    const started = Date.now();
    setTimeout(() => stop.abort(), 50);

    const outcome = await new BunHostAdapter().run({
      argv: ["sleep", "30"],
      timeoutMs: 20_000,
      signal: stop.signal,
    });

    expect(Date.now() - started).toBeLessThan(5_000);
    expect(outcome.timedOut).toBe(false);
    expect(outcome.exitCode).not.toBe(0);
  });

  test("a tunnel forwards several ports in one OpenSSH connection without a timeout", async () => {
    const host = new FakeHost([result({ exitCode: 255, stderr: "Connection to box.example closed by remote host." })]);
    const link = new Link({ destination: "user@box.example" }, host);

    const outcome = await link.tunnel({
      ports: [
        { localPort: 3000, remotePort: 3000 },
        { localPort: 4000, remotePort: 5173 },
      ],
    });

    expect(host.commands[0]).toEqual({
      argv: [
        "ssh",
        "-N",
        "-o",
        "ExitOnForwardFailure=yes",
        "-o",
        "ServerAliveInterval=15",
        "-o",
        "ServerAliveCountMax=3",
        "-o",
        "BatchMode=yes",
        "-o",
        "ConnectTimeout=10",
        "-L",
        "127.0.0.1:3000:127.0.0.1:3000",
        "-L",
        "127.0.0.1:4000:127.0.0.1:5173",
        "user@box.example",
      ],
      timeoutMs: Number.POSITIVE_INFINITY,
    });
    expect(outcome).toEqual({
      ok: false,
      error: {
        code: "forward-failed",
        origin: "network",
        message: "Connection to box.example closed by remote host.",
      },
    });
  });

  test("a tunnel port with a remote host forwards to that host, with an IPv6 address in brackets", async () => {
    const host = new FakeHost([result({ exitCode: 255 })]);
    const link = new Link({ destination: "user@box.example" }, host);

    await link.tunnel({
      ports: [
        { localPort: 15432, remotePort: 5432, remoteHost: "db.example" },
        { localPort: 6379, remotePort: 6379, remoteHost: "fd00::1" },
      ],
    });

    expect(host.commands[0]?.argv.slice(-5)).toEqual([
      "-L",
      "127.0.0.1:15432:db.example:5432",
      "-L",
      "127.0.0.1:6379:[fd00::1]:6379",
      "user@box.example",
    ]);
  });

  const REACH_TIMEOUT_MS = 25_000;
  const reachArgv = (host: string, port: number) => [
    "ssh", "-o", "BatchMode=yes", "-o", "ConnectTimeout=10", "user@box.example", `${BOX_PATH}${reachCommand(host, port, 10)}`,
  ];

  test("reach runs a TCP connect test on the box, with an IPv6 address without brackets", async () => {
    const host = new FakeHost([result({ stdout: "exit 0\n" }), result({ stdout: "exit 0\n" })]);
    const link = new Link({ destination: "user@box.example" }, host);

    expect(await link.reach({ host: "db.example", port: 5432 })).toEqual({
      ok: true,
      address: "user@box.example",
      stdout: "",
      stderr: "",
    });
    expect((await link.reach({ host: "fd00::1", port: 5432 })).ok).toBe(true);
    expect(reachCommand("fd00::1", 5432, 10)).toContain(`bash -c 'exec 3<>"/dev/tcp/$1/$2"' bash 'fd00::1' 5432`);
    expect(host.commands.map((command) => [command.argv, command.timeoutMs, command.input])).toEqual([
      [reachArgv("db.example", 5432), REACH_TIMEOUT_MS, undefined],
      [reachArgv("fd00::1", 5432), REACH_TIMEOUT_MS, undefined],
    ]);
  });

  test("reach reports a target that does not answer, refuses, or has no address, with the origin box", async () => {
    const host = new FakeHost([
      result({ stdout: "exit 124\n" }),
      result({ stdout: "bash: connect: Connection refused\nbash: line 1: /dev/tcp/db.example/5432: Connection refused\nexit 1\n" }),
      result({ stdout: "bash: line 1: db.example: Name or service not known\nbash: line 1: /dev/tcp/db.example/5432: Invalid argument\nexit 1\n" }),
    ]);
    const link = new Link({ destination: "user@box.example" }, host);
    const reach = () => link.reach({ host: "db.example", port: 5432 });

    // A target that drops the packets of the box runs to the timeout on the box.
    expect(await reach()).toEqual({ ok: false, error: { code: "forward-timeout", origin: "box", message: "no answer in 10 s" } });
    expect(await reach()).toEqual({ ok: false, error: { code: "forward-failed", origin: "box", message: "Connection refused" } });
    expect(await reach()).toEqual({ ok: false, error: { code: "forward-failed", origin: "box", message: "Name or service not known" } });
    expect(host.commands).toHaveLength(3);
  });

  test("reach reports a box that does not answer with the origin network, not as a reached target", async () => {
    const host = new FakeHost([
      result({ exitCode: 255, stderr: "ssh: connect to host box.example port 22: Connection refused\n" }),
      result({ timedOut: true, exitCode: null }),
      result({ exitCode: 1, stderr: "sh: broken profile\n" }),
    ]);
    const link = new Link({ destination: "user@box.example" }, host);
    const reach = () => link.reach({ host: "db.example", port: 5432 });

    expect(await reach()).toEqual({
      ok: false,
      error: { code: "ssh-failed", origin: "network", message: "ssh: connect to host box.example port 22: Connection refused" },
    });
    expect(await reach()).toEqual({
      ok: false,
      error: { code: "ssh-failed", origin: "network", message: "the check on the box failed: the command on the box timed out" },
    });
    expect(await reach()).toEqual({
      ok: false,
      error: { code: "ssh-failed", origin: "network", message: "the check on the box failed: sh: broken profile" },
    });
    expect(host.commands).toHaveLength(3);
  });

  test("reach uses ssh -W on a box without bash, timeout, or /dev/tcp", async () => {
    const stdio = ["ssh", "-o", "BatchMode=yes", "-o", "ConnectTimeout=10", "-W", "db.example:5432", "user@box.example"];
    const host = new FakeHost([
      result({ stdout: "unsupported\n" }),
      result({ timedOut: true, exitCode: null }),
      result({ stdout: "bash: line 1: /dev/tcp/db.example/5432: No such file or directory\nexit 1\n" }),
      result(),
      result({ stdout: "timeout: unrecognized option\nexit 125\n" }),
      result({ exitCode: 255, stderr: "channel 0: open failed: connect failed: Name or service not known\nstdio forwarding failed\n" }),
      result({ stdout: "unsupported\n" }),
      result({ exitCode: 255, stderr: "ssh: connect to host box.example port 22: Connection refused\n" }),
    ]);
    const link = new Link({ destination: "user@box.example" }, host);
    const reach = () => link.reach({ host: "db.example", port: 5432 });

    // With ssh -W, a timeout does not show that the connection opened.
    expect(await reach()).toEqual({
      ok: false,
      unknown: true,
      reason: "the box has no bash, timeout, or /dev/tcp for the connect test, and the test with ssh -W gave no answer in 10 s",
    });
    expect(await reach()).toEqual({ ok: true, address: "user@box.example", stdout: "", stderr: "" });
    expect(await reach()).toEqual({
      ok: false,
      error: { code: "forward-failed", origin: "box", message: "connect failed: Name or service not known" },
    });
    expect(await reach()).toEqual({
      ok: false,
      error: { code: "ssh-failed", origin: "network", message: "ssh: connect to host box.example port 22: Connection refused" },
    });
    expect(host.commands.map((command) => [command.argv, command.timeoutMs])).toEqual(
      [1, 2, 3, 4].flatMap(() => [[reachArgv("db.example", 5432), REACH_TIMEOUT_MS], [stdio, 10_000]]),
    );
    expect((await new Link({ destination: "user@box.example" }, new FakeHost([
      result({ stdout: "unsupported\n" }),
      result({ exitCode: 255, stderr: "channel 0: open failed: connect failed: Connection refused\n" }),
    ])).reach({ host: "fd00::1", port: 5432 })).ok).toBe(false);
  });

  test("an aborted signal stops the tunnel and reports it as stopped", async () => {
    const stop = new AbortController();
    const host = new FakeHost([result({ exitCode: 255 })]);
    const link = new Link({ destination: "user@box.example" }, host);
    stop.abort();

    const outcome = await link.tunnel({ ports: [{ localPort: 3000, remotePort: 3000 }], signal: stop.signal });

    expect(host.commands[0]?.signal).toBe(stop.signal);
    expect(outcome).toEqual({ ok: true, stopped: true, address: "user@box.example", stdout: "", stderr: "" });
  });

  test("a tunnel refuses an empty port list and invalid ports", async () => {
    const link = new Link({ destination: "user@box.example" }, new FakeHost([]));

    for (const ports of [[], [{ localPort: 0, remotePort: 3000 }], [{ localPort: 3000, remotePort: 65_536 }]]) {
      expect(await link.tunnel({ ports })).toEqual({
        ok: false,
        error: { code: "invalid-config", origin: "operator", message: expect.any(String) },
      });
    }
  });

  test("the host adapter does not time out a command with an infinite timeout", async () => {
    const outcome = await new BunHostAdapter().run({ argv: ["sleep", "0.2"], timeoutMs: Number.POSITIVE_INFINITY });

    expect(outcome).toEqual({ exitCode: 0, stdout: "", stderr: "", timedOut: false });
  });

  test("a direct port forward uses the SSH destination without Tailscale", async () => {
    const host = new FakeHost([result()]);
    const link = new Link({ destination: "user@box.example" }, host);

    await link.forward({ localPort: 1455, remotePort: 1455, timeoutMs: 2_000 });

    expect(host.commands[0]?.argv).toEqual([
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
      "user@box.example",
    ]);
  });
});

/** A host whose OpenSSH master stays open until its signal aborts. */
class MasterHost implements HostAdapter {
  readonly commands: HostCommand[] = [];

  constructor(private checkFails = 0) {}

  async run(command: HostCommand): Promise<HostCommandResult> {
    this.commands.push(command);
    const argv = command.argv;
    if (argv.includes("-M")) {
      return new Promise((resolve) =>
        command.signal?.addEventListener("abort", () => resolve(result({ exitCode: 255 })), { once: true }),
      );
    }
    if (argv.includes("check") && this.checkFails > 0) {
      this.checkFails -= 1;
      return result({ exitCode: 255, stderr: "Control socket connect: No such file or directory" });
    }
    if (argv.includes("-o") && argv.includes("ControlMaster=no")) {
      command.onStdout?.("home\t/home/dev\n");
      return result();
    }
    return result();
  }
}

describe("Link.master", () => {
  test("opens one master connection, waits until it accepts commands, and runs forwards over its socket", async () => {
    const host = new MasterHost(2);
    const link = new Link({ destination: "dev@box.example" }, host);
    const controller = new AbortController();

    const master = await link.master({ controlPath: "/tmp/ferry.sock", signal: controller.signal });
    if ("ok" in master) throw new Error(master.error.message);
    expect(await master.forward({ localPort: 3001, remotePort: 3000 })).toMatchObject({ ok: true });
    expect(await master.cancel({ localPort: 3001, remotePort: 3000 })).toMatchObject({ ok: true });
    const chunks: string[] = [];
    await master.stream("watch", (text) => chunks.push(text));
    expect(await master.exit()).toMatchObject({ ok: true });
    controller.abort();
    expect(await master.closed).toMatchObject({ ok: true, stopped: true });

    const argv = host.commands.map((command) => command.argv.join(" "));
    expect(argv[0]).toBe(
      "ssh -N -M -S /tmp/ferry.sock -o ControlPersist=no -o ServerAliveInterval=15 -o ServerAliveCountMax=3 " +
        "-o BatchMode=yes -o ConnectTimeout=10 dev@box.example",
    );
    expect(argv.filter((line) => line.includes("-O check"))).toHaveLength(3);
    expect(argv.slice(4)).toEqual([
      "ssh -S /tmp/ferry.sock -O forward -L 127.0.0.1:3001:127.0.0.1:3000 dev@box.example",
      "ssh -S /tmp/ferry.sock -O cancel -L 127.0.0.1:3001:127.0.0.1:3000 dev@box.example",
      `ssh -S /tmp/ferry.sock -o ControlMaster=no -o BatchMode=yes -o ConnectTimeout=10 dev@box.example ${BOX_PATH}watch`,
      "ssh -S /tmp/ferry.sock -O exit dev@box.example",
    ]);
    expect(chunks).toEqual(["home\t/home/dev\n"]);
  });

  test("a master that exits before it accepts commands returns its failure", async () => {
    const host: HostAdapter = {
      run: async (command) =>
        command.argv.includes("-M")
          ? result({ exitCode: 255, stderr: "ssh: connect to host box.example port 22: Connection refused" })
          : result({ exitCode: 255 }),
    };
    const link = new Link({ destination: "dev@box.example" }, host);

    expect(await link.master({ controlPath: "/tmp/ferry.sock" })).toEqual({
      ok: false,
      error: { code: "forward-failed", origin: "network", message: "ssh: connect to host box.example port 22: Connection refused" },
    });
  });
});

/** The box command of reach, run in a local shell against local listeners. */
describe("reachCommand", () => {
  const supported = Bun.which("bash") !== null && Bun.which("timeout") !== null;
  const shellTest = supported ? test : test.skip;

  async function run(host: string, port: number, seconds = 5): Promise<string> {
    const child = Bun.spawn(["/bin/sh", "-c", reachCommand(host, port, seconds)], { stdin: "ignore", stdout: "pipe", stderr: "pipe" });
    const [stdout] = await Promise.all([new Response(child.stdout).text(), child.exited]);
    return stdout;
  }

  function freePort(hostname: string): number {
    const server = Bun.listen({ hostname, port: 0, socket: { data() {} } });
    const port = server.port;
    server.stop(true);
    return port;
  }

  shellTest("exits 0 for a listener that accepts the connection and sends nothing", async () => {
    const server = Bun.listen({ hostname: "127.0.0.1", port: 0, socket: { data() {} } });
    try {
      expect(await run("127.0.0.1", server.port)).toBe("exit 0\n");
    } finally {
      server.stop(true);
    }
  });

  shellTest("opens an IPv6 address without brackets", async () => {
    const listen = () => Bun.listen({ hostname: "::1", port: 0, socket: { data() {} } });
    let server: ReturnType<typeof listen>;
    try {
      server = listen();
    } catch {
      // This machine has no IPv6 loopback address.
      return;
    }
    try {
      expect(await run("::1", server.port)).toBe("exit 0\n");
    } finally {
      server.stop(true);
    }
  });

  shellTest("prints the refusal and exits 1 for a port without a listener", async () => {
    const output = await run("127.0.0.1", freePort("127.0.0.1"));

    expect(output.split("\n")[0]).toBe("bash: connect: Connection refused");
    expect(output.endsWith("exit 1\n")).toBe(true);
  });

  // Linux drops the SYN for a listener whose accept queue is full, as a firewall drops it.
  const dropTest = supported && process.platform === "linux" && Bun.which("python3") !== null ? test : test.skip;
  dropTest("exits 124 for a target that drops the packets", async () => {
    const listener = Bun.spawn(
      [
        "python3",
        "-c",
        [
          "import socket, sys",
          "server = socket.socket()",
          "server.bind(('127.0.0.1', 0))",
          "server.listen(0)",
          "held = []",
          "for _ in range(3):",
          "    client = socket.socket()",
          "    client.setblocking(False)",
          "    try:",
          "        client.connect(server.getsockname())",
          "    except BlockingIOError:",
          "        pass",
          "    held.append(client)",
          "print(server.getsockname()[1], flush=True)",
          "sys.stdin.read()",
        ].join("\n"),
      ],
      { stdin: "pipe", stdout: "pipe", stderr: "inherit" },
    );
    try {
      const reader = listener.stdout.getReader();
      const port = Number(new TextDecoder().decode((await reader.read()).value).trim());
      reader.releaseLock();

      expect(await run("127.0.0.1", port, 1)).toBe("exit 124\n");
    } finally {
      listener.kill();
      await listener.exited;
    }
  }, 20_000);

  shellTest("quotes the host, so a host with shell characters runs no command", async () => {
    const output = await run("x'; echo injected; '", 5432);

    expect(output).not.toContain("\ninjected");
    expect(output.endsWith("exit 1\n")).toBe(true);
  });
});
