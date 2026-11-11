/**
 * Read a secret of the operator machine for `ferry box create`: the provider
 * token and the Tailscale auth key. Ferry reads them in this order, and the
 * first that has a value wins:
 *
 *   1. the environment variable, such as `HCLOUD_TOKEN`;
 *   2. on macOS, the login keychain:
 *      `security find-generic-password -s ferry -a <account> -w`;
 *   3. on Linux, the Secret Service, when `secret-tool` is on the PATH:
 *      `secret-tool lookup service ferry account <account>`.
 *
 * The value never goes into the config, the snapshot, the output, or a box
 * file. The result names the source, never the value.
 */

/** Runs a program and returns its exit code and stdout. */
export type ReadProcess = (argv: readonly string[]) => Promise<{ readonly exitCode: number; readonly stdout: string }>;

export type SecretDependencies = {
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly platform: string;
  readonly readProcess: ReadProcess;
  /** The path of the program, or null when it is not on the PATH. */
  readonly which: (program: string) => string | null;
};

export type SecretName = {
  /** The environment variable, such as `HCLOUD_TOKEN`. */
  readonly env: string;
  /** The account of the keychain or Secret Service entry of the service `ferry`, such as `hetzner`. */
  readonly account: string;
};

export type Secret = { readonly value: string; readonly source: string };

/** The token of Hetzner Cloud. `HCLOUD_TOKEN` is the variable of the hcloud CLI too. */
export const HETZNER_TOKEN: SecretName = { env: "HCLOUD_TOKEN", account: "hetzner" };
/** The Tailscale auth key for the join of a new box. Without it, Ferry prints a login URL. */
export const TAILSCALE_AUTH_KEY: SecretName = { env: "FERRY_TAILSCALE_AUTHKEY", account: "tailscale" };

/** The places that Ferry reads for the secret on this machine, in order, for the plan and for an error. */
export function secretSources(name: SecretName, platform: string): string[] {
  return [
    `the environment variable ${name.env}`,
    ...(platform === "darwin" ? [`the macOS keychain (security add-generic-password -s ferry -a ${name.account} -w)`] : []),
    ...(platform === "linux" ? [`the Secret Service (secret-tool store --label=ferry service ferry account ${name.account})`] : []),
  ];
}

export async function findSecret(name: SecretName, dependencies: SecretDependencies): Promise<Secret | null> {
  const fromEnv = dependencies.env[name.env]?.trim();
  if (fromEnv) return { value: fromEnv, source: `environment variable ${name.env}` };
  const lookup =
    dependencies.platform === "darwin"
      ? { program: "security", argv: ["security", "find-generic-password", "-s", "ferry", "-a", name.account, "-w"], source: "macOS keychain" }
      : dependencies.platform === "linux"
        ? { program: "secret-tool", argv: ["secret-tool", "lookup", "service", "ferry", "account", name.account], source: "Secret Service" }
        : null;
  if (lookup === null || dependencies.which(lookup.program) === null) return null;
  let result: { exitCode: number; stdout: string };
  try {
    result = await dependencies.readProcess(lookup.argv);
  } catch {
    return null;
  }
  const value = result.exitCode === 0 ? result.stdout.trim() : "";
  return value === "" ? null : { value, source: lookup.source };
}

/** The default dependencies: this process, and programs with stdout captured and stderr dropped. */
export function systemSecretDependencies(): SecretDependencies {
  return {
    env: process.env,
    platform: process.platform,
    which: (program) => Bun.which(program),
    readProcess: async (argv) => {
      const child = Bun.spawn([...argv], { stdin: "ignore", stdout: "pipe", stderr: "ignore" });
      const [stdout, exitCode] = await Promise.all([new Response(child.stdout).text(), child.exited]);
      return { exitCode, stdout };
    },
  };
}
