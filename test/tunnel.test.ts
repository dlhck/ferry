import { describe, expect, test } from "bun:test";
import type { ForwardResult, LinkOptions, LinkResult, TunnelOptions } from "../src/link.ts";
import {
  isPortFree,
  LIST_COMMAND,
  parseListeners,
  parsePortSpecs,
  runTunnel,
  type TunnelDependencies,
  type TunnelInput,
} from "../src/tunnel.ts";

const BOX: TunnelInput["box"] = { name: "lab", host: { transport: "ssh", destination: "dev@lab.example" } };

class FakeLink {
  readonly tunnels: TunnelOptions[] = [];
  readonly commands: string[] = [];

  constructor(
    private readonly tunnelResult: (options: TunnelOptions) => Promise<ForwardResult>,
    private readonly runResult: LinkResult = { ok: true, address: "dev@lab.example", stdout: "", stderr: "" },
  ) {}

  tunnel(options: TunnelOptions): Promise<ForwardResult> {
    this.tunnels.push(options);
    return this.tunnelResult(options);
  }

  async run(command: string): Promise<LinkResult> {
    this.commands.push(command);
    return this.runResult;
  }
}

function harness(link: FakeLink, overrides: Partial<TunnelDependencies> = {}) {
  const lines: string[] = [];
  const links: LinkOptions[] = [];
  let interrupt: (() => void) | undefined;
  const dependencies: TunnelDependencies = {
    createLink: (options) => {
      links.push(options);
      return link;
    },
    writeLine: (line) => lines.push(line),
    onInterrupt: (stop) => {
      interrupt = stop;
      return () => {
        interrupt = undefined;
      };
    },
    isPortFree: async () => true,
    ...overrides,
  };
  return { dependencies, lines, links, interrupt: () => interrupt?.() };
}

const stopped: ForwardResult = { ok: true, stopped: true, address: "dev@lab.example", stdout: "", stderr: "" };

/** A tunnel that stays open until its signal aborts, like `ssh -N`. */
function untilAborted(options: TunnelOptions): Promise<ForwardResult> {
  return new Promise((resolve) => options.signal?.addEventListener("abort", () => resolve(stopped), { once: true }));
}

describe("parsePortSpecs", () => {
  test("a port maps the same local port, and box:local picks another local port", () => {
    expect(parsePortSpecs(["3000", "5173", "3001:4000"])).toEqual([
      { remotePort: 3000, localPort: 3000 },
      { remotePort: 5173, localPort: 5173 },
      { remotePort: 3001, localPort: 4000 },
    ]);
  });

  test("invalid port specs are refused", () => {
    for (const spec of ["0", "65536", "abc", "30a0", "3000:", ":3000", "3000:0", "1:2:3", "-1", "3000.5"]) {
      expect(() => parsePortSpecs([spec])).toThrow(`invalid port ${spec}`);
    }
  });

  test("two specs for the same local port are refused", () => {
    expect(() => parsePortSpecs(["3000", "3000"])).toThrow("local port 3000 is given more than once");
    expect(() => parsePortSpecs(["3000", "5173:3000"])).toThrow("local port 3000 is given more than once");
  });
});

describe("runTunnel", () => {
  test("opens the ports on the selected box, prints one line for each port, and Ctrl-C closes it with exit 0", async () => {
    const link = new FakeLink(untilAborted);
    const run = harness(link);

    const done = runTunnel({ ports: ["3000", "5173:4000"], list: false, box: BOX }, run.dependencies);
    await Bun.sleep(0);
    run.interrupt();
    await done;

    expect(run.links).toEqual([{ destination: "dev@lab.example" }]);
    expect(link.tunnels).toEqual([
      {
        ports: [
          { remotePort: 3000, localPort: 3000 },
          { remotePort: 5173, localPort: 4000 },
        ],
        signal: expect.any(AbortSignal),
      },
    ]);
    expect(link.tunnels[0]?.signal?.aborted).toBe(true);
    expect(run.lines).toEqual([
      "http://localhost:3000 -> lab:127.0.0.1:3000",
      "http://localhost:4000 -> lab:127.0.0.1:5173",
      "Press Ctrl-C to close the tunnel.",
      "Tunnel closed.",
    ]);
  });

  test("a dropped connection prints the SSH error and fails", async () => {
    const link = new FakeLink(async () => ({
      ok: false,
      error: { code: "forward-failed", origin: "network", message: "Connection to lab.example closed by remote host." },
    }));
    const run = harness(link);

    await expect(runTunnel({ ports: ["3000"], list: false, box: BOX }, run.dependencies)).rejects.toThrow(
      "The tunnel to lab closed: Connection to lab.example closed by remote host.",
    );
    expect(run.lines).not.toContain("Tunnel closed.");
  });

  test("an SSH exit that Ctrl-C caused is a clean close", async () => {
    let stop: (() => void) | undefined;
    const link = new FakeLink(async () => {
      // OpenSSH gets the SIGINT too and can exit before the abort reaches the link.
      setTimeout(() => stop?.(), 10);
      return { ok: false, error: { code: "forward-failed", origin: "network", message: "Killed by signal 2." } };
    });
    const run = harness(link, {
      onInterrupt: (handler) => {
        stop = handler;
        return () => {};
      },
    });

    await runTunnel({ ports: ["3000"], list: false, box: BOX }, run.dependencies);

    expect(run.lines.at(-1)).toBe("Tunnel closed.");
  });

  test("a busy local port is refused before Ferry connects", async () => {
    const link = new FakeLink(untilAborted);
    const run = harness(link, { isPortFree: async (port) => port !== 3000 });

    await expect(runTunnel({ ports: ["5173", "3000"], list: false, box: BOX }, run.dependencies)).rejects.toThrow(
      "Local port 3000 is in use on this machine. Pick another local port with box:local, such as ferry tunnel 3000:3001.",
    );
    expect(run.links).toEqual([]);
    expect(link.tunnels).toEqual([]);
  });

  test("an invalid port spec is refused before Ferry connects", async () => {
    const link = new FakeLink(untilAborted);
    const run = harness(link);

    await expect(runTunnel({ ports: ["70000"], list: false, box: BOX }, run.dependencies)).rejects.toThrow(
      "invalid port 70000",
    );
    expect(run.links).toEqual([]);
  });

  test("needs ports or --list, not both", async () => {
    const run = harness(new FakeLink(untilAborted));

    await expect(runTunnel({ ports: [], list: false, box: BOX }, run.dependencies)).rejects.toThrow(
      "Give at least one box port",
    );
    await expect(runTunnel({ ports: ["3000"], list: true, box: BOX }, run.dependencies)).rejects.toThrow(
      "Give box ports or --list, not both.",
    );
  });

  test("--list runs one read-only command on the box and prints the listeners", async () => {
    const link = new FakeLink(untilAborted, {
      ok: true,
      address: "dev@lab.example",
      stdout: `# ss
LISTEN 0      511        127.0.0.1:3000       0.0.0.0:*    users:(("next-server",pid=812,fd=21))
LISTEN 0      4096         0.0.0.0:22         0.0.0.0:*
`,
      stderr: "",
    });
    const run = harness(link);

    await runTunnel({ ports: [], list: true, box: BOX }, run.dependencies);

    expect(link.commands).toEqual([LIST_COMMAND]);
    expect(link.tunnels).toEqual([]);
    expect(run.lines).toEqual(["PORT  ADDRESS    PROCESS", "22    0.0.0.0    -", "3000  127.0.0.1  next-server"]);
  });

  test("--list reports a failed box command", async () => {
    const link = new FakeLink(untilAborted, {
      ok: false,
      error: { code: "ssh-failed", origin: "network", message: "ssh: connect to host lab.example port 22: Connection refused" },
    });

    await expect(runTunnel({ ports: [], list: true, box: BOX }, harness(link).dependencies)).rejects.toThrow(
      "Could not list the ports on lab: ssh: connect to host lab.example port 22: Connection refused",
    );
  });

  test("--list with no listeners says so", async () => {
    const link = new FakeLink(untilAborted, { ok: true, address: "dev@lab.example", stdout: "# ss\n", stderr: "" });
    const run = harness(link);

    await runTunnel({ ports: [], list: true, box: BOX }, run.dependencies);

    expect(run.lines).toEqual(["No TCP port listens on loopback or all interfaces on lab."]);
  });
});

describe("parseListeners", () => {
  test("parses ss output and keeps only loopback and all-interface listeners", () => {
    const output = `# ss
LISTEN 0      511        127.0.0.1:3000       0.0.0.0:*    users:(("node",pid=812,fd=21))
LISTEN 0      4096   127.0.0.53%lo:53         0.0.0.0:*
LISTEN 0      4096         0.0.0.0:22         0.0.0.0:*
LISTEN 0      511            [::1]:5173          [::]:*    users:(("node",pid=900,fd=30))
LISTEN 0      4096            [::]:22            [::]:*
LISTEN 0      4096               *:8080             *:*    users:(("caddy",pid=1,fd=3))
LISTEN 0      4096     100.64.0.8:41641       0.0.0.0:*
LISTEN 0      4096     [fd7a::1]:443           [::]:*
`;

    expect(parseListeners(output)).toEqual([
      { port: 22, address: "0.0.0.0", process: "-" },
      { port: 22, address: "::", process: "-" },
      { port: 53, address: "127.0.0.53", process: "-" },
      { port: 3000, address: "127.0.0.1", process: "node" },
      { port: 5173, address: "::1", process: "node" },
      { port: 8080, address: "*", process: "caddy" },
    ]);
  });

  test("parses netstat output when ss is missing", () => {
    const output = `# netstat
Active Internet connections (only servers)
Proto Recv-Q Send-Q Local Address           Foreign Address         State       PID/Program name
tcp        0      0 127.0.0.1:3000          0.0.0.0:*               LISTEN      812/node
tcp        0      0 0.0.0.0:22              0.0.0.0:*               LISTEN      -
tcp        0      0 10.0.0.5:9000           0.0.0.0:*               LISTEN      77/other
tcp6       0      0 :::22                   :::*                    LISTEN      -
tcp6       0      0 ::1:5173                :::*                    LISTEN      900/vite dev
`;

    expect(parseListeners(output)).toEqual([
      { port: 22, address: "0.0.0.0", process: "-" },
      { port: 22, address: "::", process: "-" },
      { port: 3000, address: "127.0.0.1", process: "node" },
      { port: 5173, address: "::1", process: "vite dev" },
    ]);
  });

  test("parses /proc/net/tcp and /proc/net/tcp6 when ss and netstat are missing", () => {
    const output = `# proc
  sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode
   0: 0100007F:0BB8 00000000:0000 0A 00000000:00000000 00:00000000 00000000  1000        0 1 1 0000000000000000 100 0 0 10 0
   1: 00000000:0016 00000000:0000 0A 00000000:00000000 00:00000000 00000000     0        0 2 1 0000000000000000 100 0 0 10 0
   2: 0100007F:0BB8 0100007F:D431 01 00000000:00000000 00:00000000 00000000  1000        0 3 1 0000000000000000 20 4 30 10 -1
   3: 0500000A:2328 00000000:0000 0A 00000000:00000000 00:00000000 00000000     0        0 4 1 0000000000000000 100 0 0 10 0
  sl  local_address                         remote_address                        st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode
   0: 00000000000000000000000001000000:1435 00000000000000000000000000000000:0000 0A 00000000:00000000 00:00000000 00000000  1000        0 5 1 0000000000000000 100 0 0 10 0
   1: 00000000000000000000000000000000:0016 00000000000000000000000000000000:0000 0A 00000000:00000000 00:00000000 00000000     0        0 6 1 0000000000000000 100 0 0 10 0
`;

    expect(parseListeners(output)).toEqual([
      { port: 22, address: "0.0.0.0", process: "-" },
      { port: 22, address: "::", process: "-" },
      { port: 3000, address: "127.0.0.1", process: "-" },
      { port: 5173, address: "::1", process: "-" },
    ]);
  });
});

describe("isPortFree", () => {
  test("a port that a local server holds is busy, and it is free again after the server stops", async () => {
    const server = Bun.listen({ hostname: "127.0.0.1", port: 0, socket: { data() {} } });
    const port = server.port;

    expect(await isPortFree(port)).toBe(false);
    server.stop(true);
    expect(await isPortFree(port)).toBe(true);
  });
});
