/**
 * Session scan applies the secret-field rule to a session transcript. A
 * transcript is a JSONL file: each line is one JSON record. The records hold
 * tool inputs and tool results, and these hold file content, command output,
 * and commands. `carriedContentHits` does not parse a `.jsonl` file, so its
 * secret-field rule does not see a password in a record.
 *
 * The scan reads each record and applies the rule to each key at any depth.
 * It also reads each string value. It parses JSON text in a string and reads
 * the result in the same way. It matches other text line by line as config
 * text and as a command line. A hit names the key, never the value.
 *
 * The scan has a limit. It finds a secret only next to a secret key or flag.
 * A secret in free prose, such as "the password is ...", passes.
 */

import { isSecretKey, isSecretValue, secretKeyHits, secretLineKeys, type ForbiddenHit } from "./manifest.ts";

/** How deep the scan follows JSON text in the string values of JSON text. */
const MAX_NESTING = 8;
/** The line number that a harness puts before each line of a file that it read. */
const LINE_NUMBER = /^\s*\d+(?:\t|→)/;

/** The secret-field hits of the session transcript `path`. A file that is not a `.jsonl` file has none. */
export function sessionContentHits(path: string, bytes: Uint8Array): ForbiddenHit[] {
  if (!path.toLowerCase().endsWith(".jsonl")) return [];
  const records = Buffer.from(bytes).toString("utf8").split("\n");
  return secretKeyHits(path, records.flatMap((record) => textKeys(record, 0)));
}

/** Each secret key under `value` whose value is a secret string, and the secret keys in each other string. */
function valueKeys(value: unknown, nesting: number): string[] {
  if (typeof value === "string") return textKeys(value, nesting);
  if (typeof value !== "object" || value === null) return [];
  return Object.entries(value).flatMap(([key, child]) =>
    !Array.isArray(value) && isSecretKey(key) && typeof child === "string" && isSecretValue(child)
      ? [key]
      : valueKeys(child, nesting),
  );
}

/** The secret keys in `text`: in its JSON when it parses, else in its config lines and command lines. */
function textKeys(text: string, nesting: number): string[] {
  const whole = parseJson(text, nesting);
  if (whole !== undefined) return valueKeys(whole, nesting + 1);
  const lines = text.split("\n");
  return lines.flatMap((numbered) => {
    const line = numbered.replace(LINE_NUMBER, "");
    const record = line === text ? undefined : parseJson(line, nesting);
    if (record !== undefined) return valueKeys(record, nesting + 1);
    return [...secretLineKeys(line), ...commandKeys(line)];
  });
}

/** The object or array that `text` holds as JSON, else undefined. */
function parseJson(text: string, nesting: number): object | undefined {
  if (nesting >= MAX_NESTING || !/^\s*[{[]/.test(text)) return undefined;
  try {
    const parsed: unknown = JSON.parse(text);
    return typeof parsed === "object" && parsed !== null ? parsed : undefined;
  } catch {
    return undefined;
  }
}

/** The secret keys with a value in the words of a command line, as `--key=value`, `key=value`, or `--key value`. */
function commandKeys(line: string): string[] {
  const words = line.split(/\s+/).filter((word) => word !== "");
  return words.flatMap((word, index) => {
    const pair = word.match(/^-{0,2}([\w-]+)=(.*)$/);
    if (pair) return isSecretKey(pair[1]!) && isSecretValue(unquote(pair[2]!)) ? [pair[1]!] : [];
    const flag = word.match(/^--?([\w-]+)$/);
    const next = words[index + 1];
    if (!flag || !isSecretKey(flag[1]!) || next === undefined || next.startsWith("-")) return [];
    return isSecretValue(unquote(next)) ? [flag[1]!] : [];
  });
}

function unquote(word: string): string {
  return word.replace(/^["']|["']$/g, "");
}
