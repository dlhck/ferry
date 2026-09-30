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
 * A transcript holds much source code, where a secret key has a type or an
 * expression as its value. So a value in text counts only when it looks like
 * a literal: see `isLiteral`. The token patterns of `carriedContentHits` do
 * not have this condition.
 *
 * The scan has limits. It finds a secret only next to a secret key or flag.
 * A secret in free prose, such as "the password is ...", passes. A bare value
 * of only letters, such as `password: swordfish`, also passes, unless the key
 * is in the env form, such as `PASSWORD=swordfish`.
 */

import { CONFIG_LINE, isSecretKey, isSecretValue, secretKeyHits, type ForbiddenHit } from "./manifest.ts";

/** How deep the scan follows JSON text in the string values of JSON text. */
const MAX_NESTING = 8;
/** The line number that a harness puts before each line of a file that it read. */
const LINE_NUMBER = /^\s*\d+(?:\t|→)/;
/** A bare word that can be a secret: no quote, bracket, `$`, or space. */
const BARE_WORD = /^[\w+/=.~@%:!#^*-]+$/;
/** An identifier, a keyword, a type name, or a member access such as `config.password`. It has no digit. */
const IDENTIFIER = /^[A-Za-z_]+(?:\.[A-Za-z_]+)*$/;
const NUMBER = /^[\d._]+$/;
/** The key of a `.env` line or of an `export` line: upper case, with `=` and no space after it. */
const ENV_KEY = /^[A-Z][A-Z0-9_]*$/;
/** Words that are not a secret as the value of an env key. */
const ENV_KEYWORDS = new Set(["true", "false", "null", "none", "undefined"]);
/** A variable reference, as `$TOKEN`, or text with `${...}`, `$(...)`, or `{{...}}`. */
const REFERENCE = /^\$\w+$|\$\{|\$\(|\{\{/;

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
    !Array.isArray(value) && isSecretKey(key) && typeof child === "string" && isSecretValue(child) && !REFERENCE.test(child)
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
    const config = line.match(CONFIG_LINE);
    return [...(config && isSecretKey(config[1]!) && isLiteral(config[2]!) ? [config[1]!] : []), ...commandKeys(line)];
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

/** The secret keys with a literal value in the words of a command line, as `--key=value`, `key=value`, or `--key value`. */
function commandKeys(line: string): string[] {
  const words = line.split(/\s+/).filter((word) => word !== "");
  return words.flatMap((word, index) => {
    const pair = word.match(/^-{0,2}([\w-]+)=(.*)$/);
    if (pair) return isSecretKey(pair[1]!) && isLiteral(pair[2]!, ENV_KEY.test(pair[1]!)) ? [pair[1]!] : [];
    const flag = word.match(/^--?([\w-]+)$/);
    const next = words[index + 1];
    if (!flag || !isSecretKey(flag[1]!) || next === undefined || next.startsWith("-")) return [];
    return isLiteral(next) ? [flag[1]!] : [];
  });
}

/**
 * True when the text after a secret key starts with a literal value: a quoted
 * string, or a bare word that is not an identifier, a number, or a
 * placeholder. A type, a function call, a member access, a keyword, and a
 * variable reference are not literals. `hunter2` is a literal, and `string`
 * is not, so a bare password of only letters passes.
 *
 * With `env`, the key is in the env form, where a value is not code. A bare
 * word of only letters is then a literal too, but not a word of `ENV_KEYWORDS`.
 */
function isLiteral(text: string, env = false): boolean {
  const value = text.trim();
  const quote = value[0];
  if (quote === '"' || quote === "'") {
    const end = value.indexOf(quote, 1);
    const body = value.slice(1, end === -1 ? undefined : end);
    return isSecretValue(body) && !REFERENCE.test(body);
  }
  const word = value.split(/\s/, 1)[0]!.replace(/[,;]+$/, "");
  const identifier = env ? ENV_KEYWORDS.has(word.toLowerCase()) : IDENTIFIER.test(word);
  return BARE_WORD.test(word) && !identifier && !NUMBER.test(word) && isSecretValue(word);
}
