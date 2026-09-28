import { describe, expect, test } from "bun:test";
import { quoteShell } from "../src/box-settings.ts";
import type { OutputEvent } from "../src/output.ts";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  ControlConnection,
  ForwardResult,
  LinkFailure,
  LinkOptions,
  LinkResult,
  MasterOptions,
  TunnelOptions,
  TunnelPort,
} from "../src/link.ts";
import {
  diffEntries,
  FOLLOW_COMMAND,
  isPortFree,
  pickLocalPort,
  snapshotReader,
  type FollowEntry,
  type FollowForward,
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

  async master(_options: MasterOptions): Promise<ControlConnection | LinkFailure> {
    throw new Error("unexpected master connection");
  }
}

function harness(link: FakeLink, overrides: Partial<TunnelDependencies> = {}) {
  const lines: string[] = [];
  const events: OutputEvent[] = [];
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
    controlPath: join(tmpdir(), "ferry-tunnel-test.sock"),
    reconnectMs: 0,
    emit: (event) => events.push(event),
    ...overrides,
  };
  return { dependencies, lines, events, links, interrupt: () => interrupt?.() };
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
    expect(run.events).toEqual([
      { type: "forward-opened", name: null, localPort: 3000, box: "lab", remotePort: 3000 },
      { type: "forward-opened", name: null, localPort: 4000, box: "lab", remotePort: 5173 },
      { type: "tunnel-closed", box: "lab" },
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

    const listeners = await runTunnel({ ports: [], list: true, box: BOX }, run.dependencies);

    expect(link.commands).toEqual([LIST_COMMAND]);
    expect(link.tunnels).toEqual([]);
    expect(run.lines).toEqual(["PORT  ADDRESS    PROCESS", "22    0.0.0.0    -", "3000  127.0.0.1  next-server"]);
    expect(listeners).toEqual([
      { port: 22, address: "0.0.0.0", process: "-" },
      { port: 3000, address: "127.0.0.1", process: "next-server" },
    ]);
    expect(run.events).toEqual([]);
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

const ok: LinkResult = { ok: true, address: "dev@lab.example", stdout: "", stderr: "" };

/** A master connection whose box command output the test writes. */
class FakeMaster implements ControlConnection {
  readonly calls: string[] = [];
  write: (text: string) => void = () => {};
  readonly closed: Promise<ForwardResult>;
  private close!: (result: ForwardResult) => void;
  private endStream!: (result: ForwardResult) => void;

  constructor() {
    this.closed = new Promise((resolve) => {
      this.close = resolve;
    });
  }

  stream(command: string, onStdout: (text: string) => void, signal?: AbortSignal): Promise<ForwardResult> {
    expect(command).toBe(`sh -c ${quoteShell(FOLLOW_COMMAND)}`);
    this.write = onStdout;
    return new Promise((resolve) => {
      this.endStream = resolve;
      signal?.addEventListener("abort", () => resolve(stopped), { once: true });
    });
  }

  /** The box command ends, as when the connection drops. */
  drop(message: string): void {
    this.endStream({ ok: false, error: { code: "forward-failed", origin: "network", message } });
  }

  async forward(port: TunnelPort): Promise<LinkResult> {
    this.calls.push(`forward ${port.localPort}:${port.remotePort}`);
    return ok;
  }

  async cancel(port: TunnelPort): Promise<LinkResult> {
    this.calls.push(`cancel ${port.localPort}:${port.remotePort}`);
    return ok;
  }

  async exit(): Promise<LinkResult> {
    this.calls.push("exit");
    this.close(stopped);
    return ok;
  }
}

class FollowLink extends FakeLink {
  readonly masters: MasterOptions[] = [];

  constructor(private readonly next: () => FakeMaster | LinkFailure) {
    super(async () => stopped);
  }

  override async master(options: MasterOptions): Promise<ControlConnection | LinkFailure> {
    this.masters.push(options);
    return this.next();
  }
}

async function waitFor(check: () => boolean): Promise<void> {
  for (let tries = 0; !check(); tries += 1) {
    if (tries > 200) throw new Error("condition not met");
    await Bun.sleep(5);
  }
}

const entry = (pid: number, port: number, name: string, cwd = "/home/dev/app") =>
  `${pid}\t${JSON.stringify({ port, name, cwd, startedAt: "2026-09-28T10:00:00.000Z" })}\n`;

describe("ferry tunnel --follow", () => {
  const followInput: TunnelInput = { ports: [], list: false, follow: true, box: BOX };

  test("opens a forward for each entry, closes only the one that goes away, and Ctrl-C closes the master", async () => {
    const master = new FakeMaster();
    const link = new FollowLink(() => master);
    const busy = new Set([3000]);
    const { dependencies, lines, events, interrupt } = harness(link, {
      isPortFree: async (port) => !busy.has(port),
    });

    const running = runTunnel(followInput, dependencies);
    await waitFor(() => lines.length > 0);
    master.write(`home\t/home/dev\n${entry(11, 3000, "web")}${entry(12, 5173, "docs", "/srv/docs").slice(0, 10)}`);
    master.write(`${entry(12, 5173, "docs", "/srv/docs").slice(10)}.\n`);
    await waitFor(() => master.calls.length === 2);

    expect(master.calls).toEqual(["forward 3001:3000", "forward 5173:5173"]);
    expect(lines.slice(1)).toEqual([
      "web  http://localhost:3001 -> lab:3000 (~/app)",
      "docs  http://localhost:5173 -> lab:5173 (/srv/docs)",
    ]);

    master.write(`${entry(12, 5173, "docs", "/srv/docs")}.\n`);
    await waitFor(() => master.calls.length === 3);
    expect(master.calls[2]).toBe("cancel 3001:3000");
    expect(lines.at(-1)).toBe("web  http://localhost:3001 -> lab:3000 (~/app) closed");

    interrupt();
    await running;
    expect(master.calls).toEqual(["forward 3001:3000", "forward 5173:5173", "cancel 3001:3000", "exit"]);
    expect(lines.at(-1)).toBe("Tunnel closed.");
    expect(link.masters).toHaveLength(1);
    const web = { name: "web", localPort: 3001, box: "lab", remotePort: 3000, pid: 11, cwd: "/home/dev/app" };
    expect(events).toEqual([
      { type: "following", box: "lab", reconnected: false },
      { type: "forward-opened", ...web },
      { type: "forward-opened", name: "docs", localPort: 5173, box: "lab", remotePort: 5173, pid: 12, cwd: "/srv/docs" },
      { type: "forward-closed", ...web },
      { type: "tunnel-closed", box: "lab" },
    ]);
  });

  test("connects again after the connection drops, and reads the entries again", async () => {
    const masters = [new FakeMaster(), new FakeMaster()];
    let index = 0;
    const link = new FollowLink(() => masters[index++]!);
    const { dependencies, lines, events, interrupt } = harness(link, {
      reconnectMs: 0,
    });

    const running = runTunnel(followInput, dependencies);
    await waitFor(() => lines.length > 0);
    masters[0]!.write(`${entry(11, 3000, "web")}.\n`);
    await waitFor(() => masters[0]!.calls.length === 1);
    masters[0]!.drop("Connection reset by peer");
    await waitFor(() => lines.some((line) => line.startsWith("Connected again.")));
    masters[1]!.write(`${entry(11, 3000, "web")}.\n`);
    await waitFor(() => masters[1]!.calls.length === 1);
    interrupt();
    await running;

    expect(lines).toContain("The connection to lab closed: Connection reset by peer. Ferry connects again in 0 s.");
    expect(events).toContainEqual({
      type: "connection-lost",
      box: "lab",
      retryInMs: 0,
      code: "box-offline",
      message: "The connection to lab closed: Connection reset by peer",
      hint: expect.any(String),
    });
    expect(events).toContainEqual({ type: "following", box: "lab", reconnected: true });
    expect(masters[1]!.calls).toEqual(["forward 3000:3000", "exit"]);
  });

  test("a master connection that does not start fails the command", async () => {
    const link = new FollowLink(() => ({ ok: false, error: { code: "ssh-failed", origin: "network", message: "no route to host" } }));
    const { dependencies } = harness(link);

    await expect(runTunnel(followInput, dependencies)).rejects.toThrow("Could not connect to lab: no route to host");
  });

  test("--follow does not take ports or --list", async () => {
    const { dependencies } = harness(new FollowLink(() => new FakeMaster()));
    await expect(runTunnel({ ...followInput, ports: ["3000"] }, dependencies)).rejects.toThrow("not more than one");
    await expect(runTunnel({ ...followInput, list: true }, dependencies)).rejects.toThrow("not more than one");
  });
});

describe("diffEntries", () => {
  const web: FollowEntry = { pid: 11, port: 3000, name: "web", cwd: null };
  const docs: FollowEntry = { pid: 12, port: 5173, name: "docs", cwd: null };
  const open = (entry: FollowEntry): [number, FollowForward] => [entry.port, { ...entry, localPort: entry.port }];

  test("adds new entries and removes the forwards whose entry went away", () => {
    expect(diffEntries(new Map([open(web)]), [docs])).toEqual({ add: [docs], remove: [{ ...web, localPort: 3000 }] });
  });

  test("keeps the forward when a new process announces the same port, and uses the first entry of a port", () => {
    expect(diffEntries(new Map([open(web)]), [{ ...web, pid: 99 }])).toEqual({ add: [], remove: [] });
    expect(diffEntries(new Map(), [web, { ...web, pid: 99 }])).toEqual({ add: [web], remove: [] });
  });
});

describe("pickLocalPort", () => {
  test("uses the box port when it is free, else the next free port that no other forward holds", async () => {
    expect(await pickLocalPort(3000, new Set(), async () => true)).toBe(3000);
    expect(await pickLocalPort(3000, new Set(), async (port) => port !== 3000)).toBe(3001);
    expect(await pickLocalPort(3000, new Set([3001]), async (port) => port !== 3000)).toBe(3002);
    expect(await pickLocalPort(65_535, new Set(), async () => false)).toBeNull();
  });
});

describe("snapshotReader", () => {
  test("reads the home, the entries of each snapshot, and ignores lines that are not valid entries", () => {
    const homes: string[] = [];
    const snapshots: FollowEntry[][] = [];
    const read = snapshotReader((home) => homes.push(home), (entries) => snapshots.push(entries));

    read("home\t/home/dev\n\n.\n");
    read(`${entry(11, 3000, "web")}12\tnot json\n13\t{"port":0}\nx\t{"port":1}\n\n`);
    read(`14\t{"port":4000}\n.\n`);

    expect(homes).toEqual(["/home/dev"]);
    expect(snapshots).toEqual([
      [],
      [
        { pid: 11, port: 3000, name: "web", cwd: "/home/dev/app" },
        { pid: 14, port: 4000, name: null, cwd: null },
      ],
    ]);
  });
});

describe("FOLLOW_COMMAND", () => {
  test("prints the entries whose pid runs, and a new snapshot after a change", async () => {
    const home = mkdtempSync(join(tmpdir(), "ferry-follow-"));
    const dir = join(home, ".ferry", "exposed");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, `${process.pid}.json`), '{"port":3000,\n"name":"web"}\n');
    // A pid above the Linux and macOS limits never runs.
    writeFileSync(join(dir, "99999999.json"), '{"port":4000}\n');
    const box = Bun.spawn(["sh", "-c", FOLLOW_COMMAND], { env: { ...process.env, HOME: home }, stdout: "pipe" });
    const snapshots: FollowEntry[][] = [];
    const read = snapshotReader(() => {}, (entries) => snapshots.push(entries));
    const reading = (async () => {
      const decoder = new TextDecoder();
      for await (const chunk of box.stdout) read(decoder.decode(chunk, { stream: true }));
    })();
    try {
      await waitFor(() => snapshots.length === 1);
      expect(snapshots[0]).toEqual([{ pid: process.pid, port: 3000, name: "web", cwd: null }]);

      rmSync(join(dir, `${process.pid}.json`));
      const started = Date.now();
      for (let tries = 0; snapshots.length < 2 && tries < 60; tries += 1) await Bun.sleep(50);
      expect(snapshots[1]).toEqual([]);
      expect(Date.now() - started).toBeLessThan(2_000);
    } finally {
      box.kill();
      await reading;
      rmSync(home, { recursive: true, force: true });
    }
  });
});
