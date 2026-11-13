/**
 * The identifier formats of agent messaging (design section 5.1), and the format of
 * the device credential (design section 1.2).
 *
 * - A record id is `<prefix>_<ULID>`: a ULID is 26 Crockford base32 characters in
 *   upper case. The first 10 characters are the time in milliseconds. The relay
 *   makes all record ids. The worker makes the idempotency keys.
 * - A session address is `@<login>/<runtime>-<6 lower case base32 characters>`.
 * - A conversation slug is 1 to 48 characters from `[a-z0-9-]`, and does not
 *   start with a hyphen.
 * - A device credential is `fmr_` and 32 random bytes in base64url (43 characters).
 *   The relay stores only its SHA-256.
 *
 * This module has no state except the last ULID, which keeps ids of one millisecond in order.
 */

import { createHash, randomBytes } from "node:crypto";

export const ID_PREFIXES = {
  owner: "own",
  device: "dev",
  session: "ses",
  project: "prj",
  conversation: "cnv",
  message: "msg",
  receipt: "dlv",
  constraint: "con",
  idempotencyKey: "idk",
} as const;

export type IdKind = keyof typeof ID_PREFIXES;

/** Crockford base32: no I, L, O, or U. */
const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

const ULID = "[0-7][0-9A-HJKMNP-TV-Z]{25}";

/** The pattern of an id of one kind, for a validator. */
export function idPattern(kind: IdKind): RegExp {
  return new RegExp(`^${ID_PREFIXES[kind]}_${ULID}$`);
}

const PATTERNS = Object.fromEntries(Object.keys(ID_PREFIXES).map((kind) => [kind, idPattern(kind as IdKind)])) as Record<
  IdKind,
  RegExp
>;

export function isId(kind: IdKind, value: unknown): value is string {
  return typeof value === "string" && PATTERNS[kind].test(value);
}

const MAX_TIME = 2 ** 48 - 1;

let last: { time: number; random: Uint8Array } | null = null;

/**
 * A new ULID for the time `now` in milliseconds. Two ULIDs of the same millisecond
 * are in order: the second one has the random part of the first one plus 1. A time
 * that is not the last time gets a new random part, so a test clock that goes back
 * gives no duplicate.
 */
export function newUlid(now: number = Date.now()): string {
  const time = Math.floor(now);
  if (!Number.isSafeInteger(time) || time < 0 || time > MAX_TIME) throw new RangeError(`ULID time out of range: ${now}`);
  let random: Uint8Array;
  if (last !== null && last.time === time && increment(last.random)) random = last.random;
  else random = new Uint8Array(randomBytes(10));
  last = { time, random };
  return encode(BigInt(time), 10) + encode(bytesToBigInt(random), 16);
}

/** Add 1 to the bytes. False when they overflow. */
function increment(bytes: Uint8Array): boolean {
  for (let index = bytes.length - 1; index >= 0; index--) {
    if (bytes[index] !== 0xff) {
      bytes[index] = (bytes[index] ?? 0) + 1;
      return true;
    }
    bytes[index] = 0;
  }
  return false;
}

function bytesToBigInt(bytes: Uint8Array): bigint {
  let value = 0n;
  for (const byte of bytes) value = (value << 8n) | BigInt(byte);
  return value;
}

function encode(value: bigint, length: number): string {
  let text = "";
  for (let index = 0; index < length; index++) {
    text = CROCKFORD[Number(value & 31n)] + text;
    value >>= 5n;
  }
  return text;
}

/** A new record id `<prefix>_<ULID>`. */
export function newId(kind: IdKind, now: number = Date.now()): string {
  return `${ID_PREFIXES[kind]}_${newUlid(now)}`;
}

/** The creation time of an id in milliseconds, from its ULID. Null for a value that is not an id. */
export function idTime(id: string): number | null {
  const ulid = id.slice(id.indexOf("_") + 1);
  if (!new RegExp(`^${ULID}$`).test(ulid)) return null;
  let time = 0;
  for (const char of ulid.slice(0, 10)) time = time * 32 + CROCKFORD.indexOf(char);
  return time;
}

export const RUNTIMES = ["claude", "codex"] as const;

/** A GitHub login: letters, digits, and hyphens, at most 39 characters. */
export const LOGIN = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/;

/** The random part of a session address: 6 lower case Crockford base32 characters. */
export const ADDRESS_SUFFIX = /^[0-9a-hjkmnp-tv-z]{6}$/;

export const SESSION_ADDRESS = /^@([A-Za-z0-9](?:[A-Za-z0-9-]{0,38}))\/(claude|codex)-([0-9a-hjkmnp-tv-z]{6})$/;

/** A new random suffix for a session address. The relay keeps the address unique. */
export function newAddressSuffix(): string {
  const bytes = randomBytes(6);
  let suffix = "";
  for (const byte of bytes) suffix += (CROCKFORD[byte & 31] ?? "0").toLowerCase();
  return suffix;
}

export function sessionAddress(login: string, runtime: (typeof RUNTIMES)[number], suffix: string): string {
  return `@${login}/${runtime}-${suffix}`;
}

export function parseSessionAddress(
  value: string,
): { readonly login: string; readonly runtime: (typeof RUNTIMES)[number]; readonly suffix: string } | null {
  const match = SESSION_ADDRESS.exec(value);
  if (match === null) return null;
  return { login: match[1] ?? "", runtime: match[2] as (typeof RUNTIMES)[number], suffix: match[3] ?? "" };
}

/** A conversation slug. */
export const SLUG = /^[a-z0-9][a-z0-9-]{0,47}$/;

/** A normalized repository key, as design section 4.2 makes it. */
export const REPO_KEY = /^github\.com\/[a-z0-9][a-z0-9-]*\/[a-z0-9._-]+$/;

/** A device credential: `fmr_` and 32 bytes in base64url without padding. */
export const DEVICE_CREDENTIAL = /^fmr_[A-Za-z0-9_-]{43}$/;

export function isDeviceCredential(value: unknown): value is string {
  return typeof value === "string" && DEVICE_CREDENTIAL.test(value);
}

/** A new device credential. Only the device keeps the plain value. */
export function newDeviceCredential(): string {
  return `fmr_${randomBytes(32).toString("base64url")}`;
}

/** The SHA-256 of a credential in lower case hex. The client sends it at enrollment, and the relay looks the bearer up with it. */
export function credentialSha256(credential: string): string {
  return createHash("sha256").update(credential, "utf8").digest("hex");
}
