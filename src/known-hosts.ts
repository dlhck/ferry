/**
 * The SSH host keys of the boxes that `ferry box create` makes, in the
 * `~/.ssh/known_hosts` of the operator. Ferry only appends lines with the
 * comment `ferry:<box>`, and it removes only those lines. It never changes or
 * removes a line of the operator.
 */

import { createHmac } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { FerryError } from "./errors.ts";

export const KNOWN_HOSTS_RELATIVE_PATH = ".ssh/known_hosts";

/** The comment of the known_hosts lines of a box. */
function marker(box: string): string {
  return `ferry:${box}`;
}

export function knownHostsPath(home: string): string {
  return join(home, KNOWN_HOSTS_RELATIVE_PATH);
}

/**
 * The keys (`<type> <base64>`) of the known_hosts text for the host on port
 * 22. Ferry reads plain and hashed host names. It does not evaluate wildcard
 * patterns, and it skips `@cert-authority` and `@revoked` lines.
 */
export function knownKeys(text: string, host: string): string[] {
  const keys: string[] = [];
  for (const line of text.split(/\r?\n/)) {
    const fields = line.trim().split(/\s+/);
    if (fields.length < 3 || fields[0]?.startsWith("#") || fields[0]?.startsWith("@")) continue;
    const [hosts = "", type = "", key = ""] = fields;
    if (hosts.split(",").some((pattern) => matches(pattern, host))) keys.push(`${type} ${key}`);
  }
  return keys;
}

function matches(pattern: string, host: string): boolean {
  if (pattern.startsWith("|1|")) {
    const [, , salt = "", hash = ""] = pattern.split("|");
    return createHmac("sha1", Buffer.from(salt, "base64")).update(host).digest("base64") === hash;
  }
  const name = pattern.startsWith("!") ? "" : pattern.replace(/^\[(.*)\]:22$/, "$1");
  return name.toLowerCase() === host.toLowerCase();
}

/**
 * Append the host key for these host names and addresses, with the comment of
 * the box. When the file has another key for one of them, Ferry refuses and
 * changes nothing. A provider can give the address of an old server to a new
 * one, so the operator removes the old key with `ssh-keygen -R`.
 */
export function pinHostKey(home: string, box: string, hosts: readonly string[], key: string): void {
  const path = knownHostsPath(home);
  const text = existsSync(path) ? readFileSync(path, "utf8") : "";
  const wanted = keyOf(key);
  const fresh: string[] = [];
  for (const host of hosts) {
    const known = knownKeys(text, host);
    const other = known.find((entry) => entry !== wanted);
    if (other !== undefined) {
      throw new FerryError("refused", `${path} has another SSH host key for ${host}. Ferry does not replace it.`, {
        hint: `If ${host} was an earlier server, remove the old key with ssh-keygen -R ${host}, then run the command again.`,
      });
    }
    if (known.length === 0) fresh.push(host);
  }
  if (fresh.length === 0) return;
  mkdirSync(join(home, ".ssh"), { recursive: true, mode: 0o700 });
  const prefix = text === "" || text.endsWith("\n") ? "" : "\n";
  replaceFile(path, `${text}${prefix}${fresh.join(",")} ${wanted} ${marker(box)}\n`);
}

/** Remove the lines that Ferry appended for the box. Returns the number of removed lines. */
export function unpinBox(home: string, box: string): number {
  const path = knownHostsPath(home);
  if (!existsSync(path)) return 0;
  const lines = readFileSync(path, "utf8").split("\n");
  const kept = lines.filter((line) => line.trim().split(/\s+/)[3] !== marker(box));
  if (kept.length !== lines.length) replaceFile(path, kept.join("\n"));
  return lines.length - kept.length;
}

/**
 * Write the text to a temporary file in the same directory, then rename it,
 * so that ssh never reads a part of the file. The file keeps its mode. A new file gets mode 0600.
 */
function replaceFile(path: string, text: string): void {
  const mode = existsSync(path) ? statSync(path).mode & 0o777 : 0o600;
  const temporary = join(dirname(path), `.${basename(path)}.ferry-${process.pid}`);
  writeFileSync(temporary, text, { mode });
  chmodSync(temporary, mode);
  renameSync(temporary, path);
}

/** `<type> <base64>` of an OpenSSH public key line. */
export function keyOf(publicKey: string): string {
  const [type = "", key = ""] = publicKey.trim().split(/\s+/);
  return `${type} ${key}`;
}
