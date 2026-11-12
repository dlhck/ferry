import { afterEach, describe, expect, test } from "bun:test";
import { createHmac } from "node:crypto";
import { chmodSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { knownKeys, pinHostKey, unpinBox } from "../src/known-hosts.ts";

const homes: string[] = [];
afterEach(() => {
  for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true });
});

function home(knownHosts?: string): string {
  const path = mkdtempSync(join(tmpdir(), "ferry-known-hosts-"));
  homes.push(path);
  if (knownHosts !== undefined) {
    mkdirSync(join(path, ".ssh"));
    writeFileSync(join(path, ".ssh/known_hosts"), knownHosts);
  }
  return path;
}

const KEY_A = "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIExampleHostKeyA";
const KEY_B = "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIExampleHostKeyB";

function hashed(host: string): string {
  const salt = Buffer.from("0123456789abcdefghij");
  return `|1|${salt.toString("base64")}|${createHmac("sha1", salt).update(host).digest("base64")}`;
}

describe("known_hosts", () => {
  test("knownKeys reads plain, bracketed, and hashed host names", () => {
    const text = [
      `other.example,203.0.113.10 ${KEY_A}`,
      `[203.0.113.11]:22 ${KEY_B}`,
      `${hashed("203.0.113.12")} ${KEY_A}`,
      `@revoked 203.0.113.13 ${KEY_A}`,
      `# 203.0.113.14 ${KEY_A}`,
    ].join("\n");
    expect(knownKeys(text, "203.0.113.10")).toEqual([KEY_A]);
    expect(knownKeys(text, "203.0.113.11")).toEqual([KEY_B]);
    expect(knownKeys(text, "203.0.113.12")).toEqual([KEY_A]);
    expect(knownKeys(text, "203.0.113.13")).toEqual([]);
    expect(knownKeys(text, "203.0.113.14")).toEqual([]);
  });

  test("pinHostKey appends one line with the box comment, and creates the file with mode 600", () => {
    const path = home();
    pinHostKey(path, "b", ["203.0.113.10", "ferry-b.tail.example"], `${KEY_A} root@box`);
    const file = join(path, ".ssh/known_hosts");
    expect(readFileSync(file, "utf8")).toBe(`203.0.113.10,ferry-b.tail.example ${KEY_A} ferry:b\n`);
    expect(statSync(file).mode & 0o777).toBe(0o600);
    // The same key again adds nothing.
    pinHostKey(path, "b", ["203.0.113.10"], KEY_A);
    expect(readFileSync(file, "utf8").split("\n").filter(Boolean)).toHaveLength(1);
  });

  test("another key for a reused address stops the pin and names ssh-keygen -R", () => {
    const original = `${hashed("203.0.113.10")} ${KEY_B}\n`;
    const path = home(original);
    let error: unknown;
    try {
      pinHostKey(path, "b", ["203.0.113.10"], KEY_A);
    } catch (cause) {
      error = cause;
    }
    expect(error).toMatchObject({ code: "refused", hint: expect.stringContaining("ssh-keygen -R 203.0.113.10") });
    expect(readFileSync(join(path, ".ssh/known_hosts"), "utf8")).toBe(original);
  });

  test("unpinBox removes only the lines of the box", () => {
    const path = home(`keep.example ${KEY_B}\n203.0.113.10 ${KEY_A} ferry:b\n203.0.113.11 ${KEY_A} ferry:c\n`);
    expect(unpinBox(path, "b")).toBe(1);
    expect(readFileSync(join(path, ".ssh/known_hosts"), "utf8")).toBe(`keep.example ${KEY_B}\n203.0.113.11 ${KEY_A} ferry:c\n`);
    expect(unpinBox(path, "b")).toBe(0);
  });

  test("pinHostKey and unpinBox replace the file with a rename and keep its mode", () => {
    const path = home(`keep.example ${KEY_B}\n`);
    const file = join(path, ".ssh/known_hosts");
    chmodSync(file, 0o644);
    const before = statSync(file).ino;
    pinHostKey(path, "b", ["203.0.113.10"], KEY_A);
    const pinned = statSync(file);
    // A new inode shows that Ferry renamed a new file over the old one, so ssh never reads a part of it.
    expect(pinned.ino).not.toBe(before);
    expect(pinned.mode & 0o777).toBe(0o644);
    expect(unpinBox(path, "b")).toBe(1);
    const unpinned = statSync(file);
    expect(unpinned.ino).not.toBe(pinned.ino);
    expect(unpinned.mode & 0o777).toBe(0o644);
    expect(readFileSync(file, "utf8")).toBe(`keep.example ${KEY_B}\n`);
    expect(readdirSync(join(path, ".ssh"))).toEqual(["known_hosts"]);
  });
});
