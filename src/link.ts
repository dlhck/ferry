/** Link resolves a configured target and owns ordinary OpenSSH transport. */

import { BUILTIN_BOX_PATH_DIRS, pathExport } from "./tools/path.ts";

export type HostCommand = {
  readonly argv: readonly string[];
  /** `Number.POSITIVE_INFINITY` runs the command without a timeout. */
  readonly timeoutMs: number;
  /** Bytes for the standard input of the command. Without input, stdin is closed. */
  readonly input?: Uint8Array;
  /** The command is stopped when this signal aborts. */
  readonly signal?: AbortSignal;
};

export type HostCommandResult = {
  readonly exitCode: number | null;
  readonly stdout: string;
  readonly stderr: string;
  readonly timedOut: boolean;
};

/** Runs local commands on the operator machine. Tests inject a recording fake. */
export interface HostAdapter {
  run(command: HostCommand): Promise<HostCommandResult>;
}

export type LinkOrigin = "operator" | "network" | "box";

export type LinkErrorCode =
  | "invalid-config"
  | "tailscale-status-failed"
  | "tailscale-status-timeout"
  | "tailscale-status-invalid"
  | "host-not-found"
  | "host-offline"
  | "ssh-start-failed"
  | "ssh-failed"
  | "command-failed"
  | "command-timeout"
  | "forward-failed"
  | "forward-timeout";

export type LinkError = {
  readonly code: LinkErrorCode;
  readonly origin: LinkOrigin;
  readonly message: string;
};

export type LinkFailure = { readonly ok: false; readonly error: LinkError };

export type LinkSuccess = {
  readonly ok: true;
  readonly address: string;
  readonly stdout: string;
  readonly stderr: string;
};

export type LinkResult = LinkSuccess | LinkFailure;

/** A port forward that its signal stopped. This is not an error. */
export type ForwardStopped = LinkSuccess & { readonly stopped: true };

export type ForwardResult = LinkResult | ForwardStopped;

type LinkTimeouts = {
  readonly probeTimeoutMs?: number;
  readonly connectTimeoutMs?: number;
  readonly commandTimeoutMs?: number;
  /** The box PATH directories from `boxPathDirs`. The default is the directories of the built-in tools. */
  readonly pathDirs?: readonly string[];
};

type TailscaleLinkOptions = LinkTimeouts & {
  readonly host: string;
  readonly user: string;
};

type DirectLinkOptions = LinkTimeouts & {
  readonly destination: string;
};

export type LinkOptions = TailscaleLinkOptions | DirectLinkOptions;

export type RunOptions = {
  readonly timeoutMs?: number;
  /** Agent forwarding is only for a remote git command that uses SSH. */
  readonly agentForwarding?: "git";
  /** Bytes for the standard input of the command on the box, such as a tar archive. */
  readonly input?: Uint8Array;
};

export type ForwardOptions = {
  readonly localPort: number;
  readonly remotePort: number;
  readonly remoteHost?: string;
  /** The forward is stopped and returns `forward-timeout` after this interval. */
  readonly timeoutMs: number;
  /** The forward is stopped and returns `ForwardStopped` when this signal aborts. */
  readonly signal?: AbortSignal;
};

export type TunnelPort = { readonly localPort: number; readonly remotePort: number };

export type TunnelOptions = {
  /** Each local port forwards to `127.0.0.1` on the box, in one OpenSSH connection. */
  readonly ports: readonly TunnelPort[];
  /** The tunnel has no timeout. It is stopped and returns `ForwardStopped` when this signal aborts. */
  readonly signal?: AbortSignal;
};

const DEFAULT_PROBE_TIMEOUT_MS = 5_000;
const DEFAULT_CONNECT_TIMEOUT_MS = 10_000;
const DEFAULT_COMMAND_TIMEOUT_MS = 30_000;

export class Link {
  constructor(
    private readonly options: LinkOptions,
    private readonly adapter: HostAdapter = new BunHostAdapter(),
  ) {}

  /** The directories, relative to the home, that each box command puts in front of PATH. Child processes get the same PATH. */
  get pathDirs(): readonly string[] {
    return this.options.pathDirs ?? BUILTIN_BOX_PATH_DIRS;
  }

  async run(command: string, options: RunOptions = {}): Promise<LinkResult> {
    const invalid = this.validateConfig();
    if (invalid) return invalid;

    const resolved = await this.resolve();
    if (!resolved.ok) return resolved;

    const argv = this.sshBase(resolved.destination);
    if (options.agentForwarding === "git") argv.splice(1, 0, "-A");
    argv.push(`${pathExport(this.pathDirs)}; ${command}`);

    let execution: HostCommandResult;
    try {
      execution = await this.adapter.run({
        argv,
        timeoutMs: options.timeoutMs ?? this.options.commandTimeoutMs ?? DEFAULT_COMMAND_TIMEOUT_MS,
        ...(options.input ? { input: options.input } : {}),
      });
    } catch (error) {
      return failure("ssh-start-failed", "operator", messageOf(error, "could not start OpenSSH"));
    }

    if (execution.timedOut) {
      return failure("command-timeout", "box", "the command on the box timed out");
    }
    if (execution.exitCode === 255) {
      return failure("ssh-failed", "network", outputMessage(execution, "OpenSSH could not reach the box"));
    }
    if (execution.exitCode !== 0) {
      return failure("command-failed", "box", outputMessage(execution, "the command failed on the box"));
    }
    return success(resolved.address, execution);
  }

  async forward(options: ForwardOptions): Promise<ForwardResult> {
    const invalid = this.validateConfig() ?? validateForward(options);
    if (invalid) return invalid;

    const resolved = await this.resolve();
    if (!resolved.ok) return resolved;

    const remoteHost = options.remoteHost ?? "127.0.0.1";
    const argv = [
      "ssh",
      "-N",
      "-o",
      "ExitOnForwardFailure=yes",
      ...this.sshOptions(),
      "-L",
      `127.0.0.1:${options.localPort}:${remoteHost}:${options.remotePort}`,
      resolved.destination,
    ];
    return this.runForward(resolved.address, argv, options.timeoutMs, options.signal);
  }

  /**
   * Forward several local ports to `127.0.0.1` on the box in one OpenSSH
   * connection, until the signal aborts or the connection drops. Keepalives
   * let OpenSSH notice a dropped connection.
   */
  async tunnel(options: TunnelOptions): Promise<ForwardResult> {
    const invalid = this.validateConfig() ?? validateTunnel(options);
    if (invalid) return invalid;

    const resolved = await this.resolve();
    if (!resolved.ok) return resolved;

    const argv = [
      "ssh",
      "-N",
      "-o",
      "ExitOnForwardFailure=yes",
      "-o",
      "ServerAliveInterval=15",
      "-o",
      "ServerAliveCountMax=3",
      ...this.sshOptions(),
      ...options.ports.flatMap((port) => ["-L", `127.0.0.1:${port.localPort}:127.0.0.1:${port.remotePort}`]),
      resolved.destination,
    ];
    return this.runForward(resolved.address, argv, Number.POSITIVE_INFINITY, options.signal);
  }

  private async runForward(
    address: string,
    argv: readonly string[],
    timeoutMs: number,
    signal: AbortSignal | undefined,
  ): Promise<ForwardResult> {
    let execution: HostCommandResult;
    try {
      execution = await this.adapter.run({
        argv,
        timeoutMs,
        ...(signal ? { signal } : {}),
      });
    } catch (error) {
      return failure("ssh-start-failed", "operator", messageOf(error, "could not start OpenSSH"));
    }

    if (signal?.aborted) return { ...success(address, execution), stopped: true };
    if (execution.timedOut) {
      return failure(
        "forward-timeout",
        "network",
        `the port forward timed out after ${timeoutMs} ms`,
      );
    }
    if (execution.exitCode !== 0) {
      return failure("forward-failed", "network", outputMessage(execution, "the port forward failed"));
    }
    return success(address, execution);
  }

  private validateConfig(): LinkFailure | null {
    if (isDirect(this.options)) {
      const destination = this.options.destination.trim();
      if (destination === "") {
        return failure("invalid-config", "operator", "the SSH destination is empty");
      }
      if (destination.startsWith("-") || /[\s\0]/.test(destination)) {
        return failure("invalid-config", "operator", "the SSH destination is invalid");
      }
      return null;
    }
    if (this.options.host.trim() === "") {
      return failure("invalid-config", "operator", "the Tailscale host is empty");
    }
    if (this.options.user.trim() === "") {
      return failure("invalid-config", "operator", "the SSH user is empty");
    }
    return null;
  }

  private async resolve(): Promise<ResolvedTarget | LinkFailure> {
    const options = this.options;
    if (isDirect(options)) {
      return {
        ok: true,
        address: options.destination,
        destination: options.destination,
      };
    }

    let status: HostCommandResult;
    try {
      status = await this.adapter.run({
        argv: ["tailscale", "status", "--json"],
        timeoutMs: options.probeTimeoutMs ?? DEFAULT_PROBE_TIMEOUT_MS,
      });
    } catch (error) {
      return failure(
        "tailscale-status-failed",
        "operator",
        messageOf(error, "could not run Tailscale on the operator machine"),
      );
    }

    if (status.timedOut) {
      return failure("tailscale-status-timeout", "operator", "Tailscale status timed out");
    }
    if (status.exitCode !== 0) {
      return failure(
        "tailscale-status-failed",
        "operator",
        outputMessage(status, "Tailscale status failed on the operator machine"),
      );
    }

    let parsed: TailscaleStatus;
    try {
      parsed = JSON.parse(status.stdout) as TailscaleStatus;
    } catch {
      return failure("tailscale-status-invalid", "operator", "Tailscale returned invalid status JSON");
    }

    const peer = Object.values(parsed.Peer ?? {}).find((candidate) =>
      peerMatches(candidate, options.host),
    );
    if (!peer) {
      return failure(
        "host-not-found",
        "network",
        `Tailscale status does not contain host ${options.host}`,
      );
    }
    if (peer.Online !== true) {
      return failure("host-offline", "network", `Tailscale host ${options.host} is offline`);
    }

    const address = addressOf(peer, options.host);
    if (!address) {
      return failure(
        "host-not-found",
        "network",
        `Tailscale host ${options.host} has no reachable address`,
      );
    }
    return { ok: true, address, destination: `${options.user}@${address}` };
  }

  private sshBase(destination: string): string[] {
    return ["ssh", ...this.sshOptions(), destination];
  }

  private sshOptions(): string[] {
    const connectTimeoutMs = this.options.connectTimeoutMs ?? DEFAULT_CONNECT_TIMEOUT_MS;
    const connectTimeoutSeconds = Math.max(1, Math.ceil(connectTimeoutMs / 1_000));
    return ["-o", "BatchMode=yes", "-o", `ConnectTimeout=${connectTimeoutSeconds}`];
  }
}

type ResolvedTarget = {
  readonly ok: true;
  readonly address: string;
  readonly destination: string;
};

function isDirect(options: LinkOptions): options is DirectLinkOptions {
  return "destination" in options && typeof options.destination === "string";
}

/** Production adapter. It runs only on the operator machine. */
export class BunHostAdapter implements HostAdapter {
  async run(command: HostCommand): Promise<HostCommandResult> {
    const process = Bun.spawn([...command.argv], {
      stdin: command.input ?? "ignore",
      stdout: "pipe",
      stderr: "pipe",
    });
    const stdout = new Response(process.stdout).text();
    const stderr = new Response(process.stderr).text();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<"timeout">((resolve) => {
      if (Number.isFinite(command.timeoutMs)) timer = setTimeout(() => resolve("timeout"), command.timeoutMs);
    });
    const exited = process.exited.then((exitCode) => ({ exitCode }));
    const stop = () => process.kill();
    command.signal?.addEventListener("abort", stop, { once: true });
    if (command.signal?.aborted) stop();
    const settled = await Promise.race([exited, timeout]);
    command.signal?.removeEventListener("abort", stop);

    if (settled === "timeout") {
      process.kill();
      await process.exited;
      return { exitCode: null, stdout: await stdout, stderr: await stderr, timedOut: true };
    }

    if (timer) clearTimeout(timer);
    return {
      exitCode: settled.exitCode,
      stdout: await stdout,
      stderr: await stderr,
      timedOut: false,
    };
  }
}

type TailscalePeer = {
  readonly DNSName?: unknown;
  readonly HostName?: unknown;
  readonly Online?: unknown;
  readonly TailscaleIPs?: unknown;
};

type TailscaleStatus = { readonly Peer?: Record<string, TailscalePeer> };

function peerMatches(peer: TailscalePeer, requested: string): boolean {
  const host = requested.toLowerCase().replace(/\.$/, "");
  const dnsName = stringValue(peer.DNSName)?.toLowerCase().replace(/\.$/, "");
  const hostName = stringValue(peer.HostName)?.toLowerCase();
  const addresses = stringArray(peer.TailscaleIPs);
  return dnsName === host || hostName === host || addresses.includes(requested);
}

function addressOf(peer: TailscalePeer, requested: string): string | null {
  const addresses = stringArray(peer.TailscaleIPs);
  if (addresses.includes(requested)) return requested;
  const dnsName = stringValue(peer.DNSName)?.replace(/\.$/, "");
  return dnsName || addresses[0] || null;
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" && value !== "" ? value : null;
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

function validateForward(options: ForwardOptions): LinkFailure | null {
  if (!validPort(options.localPort) || !validPort(options.remotePort)) {
    return failure("invalid-config", "operator", "port numbers must be integers from 1 through 65535");
  }
  if (!Number.isFinite(options.timeoutMs) || options.timeoutMs <= 0) {
    return failure("invalid-config", "operator", "the port-forward timeout must be greater than zero");
  }
  return null;
}

function validateTunnel(options: TunnelOptions): LinkFailure | null {
  if (options.ports.length === 0) {
    return failure("invalid-config", "operator", "a tunnel needs at least one port");
  }
  if (options.ports.some((port) => !validPort(port.localPort) || !validPort(port.remotePort))) {
    return failure("invalid-config", "operator", "port numbers must be integers from 1 through 65535");
  }
  return null;
}

function validPort(port: number): boolean {
  return Number.isInteger(port) && port >= 1 && port <= 65_535;
}

function success(address: string, result: HostCommandResult): LinkSuccess {
  return { ok: true, address, stdout: result.stdout, stderr: result.stderr };
}

function failure(code: LinkErrorCode, origin: LinkOrigin, message: string): LinkFailure {
  return { ok: false, error: { code, origin, message } };
}

function outputMessage(result: HostCommandResult, fallback: string): string {
  return result.stderr.trim() || result.stdout.trim() || fallback;
}

function messageOf(error: unknown, fallback: string): string {
  return error instanceof Error && error.message ? error.message : fallback;
}
