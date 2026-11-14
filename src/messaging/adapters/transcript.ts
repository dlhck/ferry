/**
 * The `transcript` evidence of design section 6.1: the message id in the
 * bytes that the runtime appended to its session transcript after the
 * injection. The format of a transcript is not documented, so the search
 * looks only for the id string, not for a record shape.
 */

import { closeSync, openSync, readSync, statSync } from "node:fs";

const CHUNK = 1 << 16;

/** The size of the transcript in bytes. 0 when the file does not exist yet. */
export function transcriptSize(path: string | null): number {
  if (!path) return 0;
  try {
    return statSync(path).size;
  } catch {
    return 0;
  }
}

/** True when `needle` is in the bytes of the transcript at `offset` or after it. */
export function transcriptHas(path: string | null, offset: number, needle: string): boolean {
  if (!path) return false;
  let fd: number;
  try {
    fd = openSync(path, "r");
  } catch {
    return false;
  }
  try {
    const target = Buffer.from(needle);
    const buffer = Buffer.alloc(CHUNK + target.length);
    // The last bytes of each chunk go to the start of the next one, so a match across two chunks counts.
    let carry = 0;
    let position = offset;
    for (;;) {
      const read = readSync(fd, buffer, carry, CHUNK, position);
      if (read === 0) return false;
      const filled = carry + read;
      if (buffer.subarray(0, filled).includes(target)) return true;
      position += read;
      carry = Math.min(target.length - 1, filled);
      buffer.copy(buffer, 0, filled - carry, filled);
    }
  } catch {
    return false;
  } finally {
    closeSync(fd);
  }
}
