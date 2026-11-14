/**
 * `ferry messaging enroll` (design section 3.5).
 *
 * `enroll` runs on the operator machine. It makes the credential in memory,
 * sends only its SHA-256 to `POST /v1/enroll/start`, prints the GitHub user
 * code, and polls `POST /v1/enroll/poll` at the interval of the relay. The
 * relay runs the device flow against GitHub, so no GitHub token reaches this
 * machine. On `complete`, it writes `credential` and `client.json`.
 *
 * `enrollBox` makes a credential for a box without a second browser flow. It
 * registers the hash with `POST /v1/devices` with the credential of this
 * machine, then sends the plain value to the box on the standard input of the
 * SSH command. The value never appears in a command line or in output.
 */

import type { Link } from "../../link.ts";
import { credentialSha256, newDeviceCredential } from "../ids.ts";
import type { Owner } from "../protocol.ts";
import { readClientConfig, readCredential, writeClientConfig, writeCredential, type ClientConfig } from "./credential.ts";
import { checkRelayUrl, RelayClient, RelayError, type RelayClientOptions } from "./relay-client.ts";

export type Platform = "linux" | "darwin";

/** The platform of this machine. Messaging supports Linux and macOS only. */
export function currentPlatform(): Platform {
  if (process.platform === "linux" || process.platform === "darwin") return process.platform;
  throw new Error(`Ferry messaging supports Linux and macOS, not ${process.platform}.`);
}

/** The relay options that the commands share. Tests give a fetch and a sleep. */
export type ClientDependencies = Pick<RelayClientOptions, "fetch" | "sleep" | "retries" | "timeoutMs">;

export type EnrollInput = {
  readonly home: string;
  readonly relayUrl: string;
  readonly deviceName: string;
  readonly platform: Platform;
  readonly ferryVersion: string;
  readonly print: (line: string) => void;
  readonly client?: ClientDependencies;
  readonly sleep?: (ms: number) => Promise<void>;
};

export type EnrollResult = { readonly owner: Owner; readonly device: { readonly id: string; readonly name: string }; readonly relayUrl: string };

/** A relay restart loses the device code. The client starts again this many times. */
const MAX_RESTARTS = 3;

export async function enroll(input: EnrollInput): Promise<EnrollResult> {
  const relayUrl = checkRelayUrl(input.relayUrl);
  const client = new RelayClient({ ...input.client, url: relayUrl, credential: null, ferryVersion: input.ferryVersion });
  const sleep = input.sleep ?? ((ms: number) => Bun.sleep(ms));

  for (let restart = 0; ; restart++) {
    const credential = newDeviceCredential();
    const started = await client.enrollStart({
      deviceName: input.deviceName,
      platform: input.platform,
      ferryVersion: input.ferryVersion,
      credentialSha256: credentialSha256(credential),
    });
    input.print(`Open ${started.verificationUri} and enter the code ${started.userCode}.`);
    input.print("Ferry waits for the GitHub authorization.");
    let intervalMs = started.intervalMs;
    try {
      for (;;) {
        await sleep(intervalMs);
        const polled = await client.enrollPoll({ enrollmentId: started.enrollmentId });
        if (polled.state === "pending") {
          intervalMs = polled.intervalMs;
          continue;
        }
        writeCredential(input.home, credential);
        writeClientConfig(input.home, { schemaVersion: 1, relayUrl, deviceId: polled.device.id, ownerLogin: polled.owner.login });
        input.print(`Enrolled ${polled.device.name} for the GitHub user ${polled.owner.login}.`);
        return { owner: polled.owner, device: polled.device, relayUrl };
      }
    } catch (error) {
      if (!(error instanceof RelayError)) throw error;
      if (error.code === "enrollment-unknown" && restart < MAX_RESTARTS) {
        input.print("The relay lost the enrollment, for example after a restart. Ferry starts it again with a new code.");
        continue;
      }
      if (error.code === "enrollment-expired") throw new Error("The code expired before the GitHub authorization. Run ferry messaging enroll again.");
      if (error.code === "enrollment-denied") throw new Error("GitHub denied the authorization. Run ferry messaging enroll again to retry.");
      throw error;
    }
  }
}

/** The script on the box. Line 1 of its input is `client.json`, line 2 the credential. */
export const BOX_ENROLL_SCRIPT = [
  "set -e; set +x; umask 077",
  'dir="$HOME/.ferry/messaging"; mkdir -p "$dir"; chmod 700 "$dir"',
  'tmp_client="$dir/.client.json.$$"; tmp_credential="$dir/.credential.$$"',
  'trap \'rm -f "$tmp_client" "$tmp_credential"\' EXIT',
  "IFS= read -r client; IFS= read -r credential",
  'printf \'%s\\n\' "$client" > "$tmp_client"',
  'printf \'%s\\n\' "$credential" > "$tmp_credential"',
  'chmod 600 "$tmp_client" "$tmp_credential"',
  'mv -f "$tmp_credential" "$dir/credential"',
  'mv -f "$tmp_client" "$dir/client.json"',
  "echo written",
].join("\n");

export type EnrollBoxInput = {
  readonly home: string;
  readonly box: string;
  readonly link: Pick<Link, "run">;
  /** The device name. Default: the box name. */
  readonly deviceName?: string;
  readonly ferryVersion: string;
  readonly client?: ClientDependencies;
};

/** Enroll a box as a device of the owner of this machine. */
export async function enrollBox(input: EnrollBoxInput): Promise<{ readonly device: { readonly id: string; readonly name: string } }> {
  const config = readClientConfig(input.home);
  const own = readCredential(input.home);
  if (!config || !own) throw new Error("This machine is not enrolled. Run ferry messaging enroll --relay <url> first.");
  const client = new RelayClient({ ...input.client, url: config.relayUrl, credential: own, ferryVersion: input.ferryVersion });
  const credential = newDeviceCredential();
  const { device } = await client.createDevice({ name: input.deviceName ?? input.box, platform: "linux", credentialSha256: credentialSha256(credential) });
  const boxConfig: ClientConfig = { schemaVersion: 1, relayUrl: config.relayUrl, deviceId: device.id, ownerLogin: config.ownerLogin };
  let written = false;
  try {
    const result = await input.link.run(BOX_ENROLL_SCRIPT, { input: Buffer.from(`${JSON.stringify(boxConfig)}\n${credential}\n`) });
    written = result.ok && result.stdout.trim() === "written";
  } catch {
    written = false;
  }
  if (!written) {
    // No box holds the new credential. Revoke the device, so it does not stay valid.
    await client.revokeDevice(device.id).catch(() => {});
    throw new Error(`Ferry could not write the credential on box ${input.box}. It revoked the new device ${device.id}.`);
  }
  return { device };
}
