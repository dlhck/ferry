import { describe, expect, test } from "bun:test";
import {
  ID_PREFIXES,
  credentialSha256,
  idTime,
  isDeviceCredential,
  isId,
  newAddressSuffix,
  newDeviceCredential,
  newId,
  newUlid,
  parseSessionAddress,
  sessionAddress,
  SLUG,
  type IdKind,
} from "../../src/messaging/ids.ts";

const NOW = Date.parse("2026-11-13T10:00:00.000Z");

describe("record ids", () => {
  test("each kind has its prefix and a ULID of 26 Crockford characters", () => {
    for (const [kind, prefix] of Object.entries(ID_PREFIXES)) {
      const id = newId(kind as IdKind, NOW);
      expect(id).toMatch(new RegExp(`^${prefix}_[0-9A-HJKMNP-TV-Z]{26}$`));
      expect(isId(kind as IdKind, id)).toBe(true);
    }
  });

  test("an id of another kind, a lower case ULID, or a short ULID is not an id", () => {
    const message = newId("message", NOW);
    expect(isId("session", message)).toBe(false);
    expect(isId("message", message.toLowerCase())).toBe(false);
    expect(isId("message", message.slice(0, -1))).toBe(false);
    expect(isId("message", `${message.slice(0, 4)}8${message.slice(5)}`)).toBe(false);
    expect(isId("message", 42)).toBe(false);
  });

  test("the ULID holds the time", () => {
    expect(idTime(newId("owner", NOW))).toBe(NOW);
    expect(idTime(newId("owner", 0))).toBe(0);
    expect(idTime("not an id")).toBeNull();
  });

  test("ids of one millisecond are in order", () => {
    const ids = Array.from({ length: 50 }, () => newUlid(NOW));
    expect([...ids].sort()).toEqual(ids);
    expect(new Set(ids).size).toBe(ids.length);
  });

  test("a clock that goes back gives no duplicate", () => {
    const later = newUlid(NOW + 1000);
    const earlier = newUlid(NOW);
    expect(earlier < later).toBe(true);
    expect(idTime(`x_${earlier}`)).toBe(NOW);
  });

  test("a time out of range is an error", () => {
    expect(() => newUlid(-1)).toThrow(RangeError);
    expect(() => newUlid(2 ** 48)).toThrow(RangeError);
  });
});

describe("session addresses", () => {
  test("an address has the login, the runtime, and a suffix of 6 lower case base32 characters", () => {
    const suffix = newAddressSuffix();
    expect(suffix).toMatch(/^[0-9a-hjkmnp-tv-z]{6}$/);
    const address = sessionAddress("alice", "codex", suffix);
    expect(address).toBe(`@alice/codex-${suffix}`);
    expect(parseSessionAddress(address)).toEqual({ login: "alice", runtime: "codex", suffix });
  });

  test("an address with another runtime, a bad suffix, or a bad login does not parse", () => {
    expect(parseSessionAddress("@alice/pi-7k2m9q")).toBeNull();
    expect(parseSessionAddress("@alice/codex-7k2m9")).toBeNull();
    expect(parseSessionAddress("@alice/codex-7K2M9Q")).toBeNull();
    expect(parseSessionAddress("@alice/codex-7k2m9u")).toBeNull();
    expect(parseSessionAddress("@-alice/claude-7k2m9q")).toBeNull();
    expect(parseSessionAddress("alice/claude-7k2m9q")).toBeNull();
  });
});

describe("slugs", () => {
  test("a slug has 1 to 48 characters from a-z, 0-9, and hyphen, and does not start with a hyphen", () => {
    expect(SLUG.test("production-applies")).toBe(true);
    expect(SLUG.test("a")).toBe(true);
    expect(SLUG.test("a".repeat(48))).toBe(true);
    expect(SLUG.test("a".repeat(49))).toBe(false);
    expect(SLUG.test("-applies")).toBe(false);
    expect(SLUG.test("Applies")).toBe(false);
    expect(SLUG.test("")).toBe(false);
  });
});

describe("device credentials", () => {
  test("a new credential is fmr_ and 43 base64url characters", () => {
    const credential = newDeviceCredential();
    expect(credential).toMatch(/^fmr_[A-Za-z0-9_-]{43}$/);
    expect(isDeviceCredential(credential)).toBe(true);
    expect(newDeviceCredential()).not.toBe(credential);
  });

  test("a value with another prefix or length is not a credential", () => {
    expect(isDeviceCredential(`fmr_${"a".repeat(42)}`)).toBe(false);
    expect(isDeviceCredential(`fmx_${"a".repeat(43)}`)).toBe(false);
    expect(isDeviceCredential(`fmr_${"a".repeat(42)}=`)).toBe(false);
    expect(isDeviceCredential(undefined)).toBe(false);
  });

  test("the hash is the SHA-256 in lower case hex", () => {
    expect(credentialSha256(`fmr_${"a".repeat(43)}`)).toBe(
      new Bun.CryptoHasher("sha256").update(`fmr_${"a".repeat(43)}`).digest("hex"),
    );
    expect(credentialSha256(newDeviceCredential())).toMatch(/^[0-9a-f]{64}$/);
  });
});
