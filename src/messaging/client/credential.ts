/**
 * The device credential and the client config of messaging (design sections
 * 3.5 and 11.1), in `~/.ferry/messaging/` (mode 0700):
 *
 * - `credential` (0600): `fmr_` and 43 base64url characters. Only the worker
 *   reads it. The relay keeps only its SHA-256.
 * - `client.json` (0600): `{ schemaVersion: 1, relayUrl, deviceId, ownerLogin }`.
 *
 * Neither path is a managed path, so sync never carries them. The deny rule
 * `ferry-credential` refuses a carried file that holds a credential. No error
 * here has the credential.
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { writePrivate } from "../github/app.ts";
import { isDeviceCredential, isId } from "../ids.ts";

export type ClientConfig = {
  readonly schemaVersion: 1;
  readonly relayUrl: string;
  readonly deviceId: string;
  readonly ownerLogin: string;
};

export function messagingDir(home: string): string {
  return join(home, ".ferry", "messaging");
}

/** The credential of this device. Null before enrollment. A file with another form is an error. */
export function readCredential(home: string): string | null {
  const path = join(messagingDir(home), "credential");
  if (!existsSync(path)) return null;
  const credential = readFileSync(path, "utf8").trim();
  if (!isDeviceCredential(credential)) throw new Error("~/.ferry/messaging/credential is not a device credential. Run ferry messaging enroll again.");
  return credential;
}

export function writeCredential(home: string, credential: string): void {
  if (!isDeviceCredential(credential)) throw new Error("Ferry refuses to write a value that is not a device credential.");
  writePrivate(join(messagingDir(home), "credential"), `${credential}\n`);
}

/** `client.json`. Null before enrollment. */
export function readClientConfig(home: string): ClientConfig | null {
  const path = join(messagingDir(home), "client.json");
  if (!existsSync(path)) return null;
  return parseClientConfig(readFileSync(path, "utf8"));
}

export function parseClientConfig(text: string): ClientConfig {
  let value: { schemaVersion?: unknown; relayUrl?: unknown; deviceId?: unknown; ownerLogin?: unknown };
  try {
    value = JSON.parse(text) as typeof value;
  } catch {
    throw new Error("~/.ferry/messaging/client.json is not valid JSON.");
  }
  if (value?.schemaVersion !== 1 || typeof value.relayUrl !== "string" || !isId("device", value.deviceId) || typeof value.ownerLogin !== "string") {
    throw new Error("~/.ferry/messaging/client.json is not a valid client config. Run ferry messaging enroll again.");
  }
  return { schemaVersion: 1, relayUrl: value.relayUrl, deviceId: value.deviceId, ownerLogin: value.ownerLogin };
}

export function writeClientConfig(home: string, config: ClientConfig): void {
  writePrivate(join(messagingDir(home), "client.json"), `${JSON.stringify(config, null, 2)}\n`);
}
