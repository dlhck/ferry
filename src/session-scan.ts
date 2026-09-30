/**
 * Session scan applies the secret-field rule to a session transcript. A
 * transcript is a JSONL file: each line is one JSON record. The records hold
 * tool inputs and tool results, and these hold file content, command output,
 * and commands. `carriedContentHits` does not parse a `.jsonl` file, so its
 * secret-field rule does not see a password in a record.
 *
 * The scan reads each record and applies the rule to each key at any depth.
 * It also reads each string value. It parses JSON text in a string and reads
 * the result in the same way. It applies the token patterns to each decoded
 * string, because JSON can write a token with an escape. It matches other text line by line as config
 * text and as a command line. A hit names the key, never the value.
 *
 * A transcript holds much source code, where a secret key has a type or an
 * expression as its value. So a value in text counts only when it looks like
 * a literal: see `isLiteral`. A value that is only a variable reference is
 * not a literal, also in parsed JSON. The token patterns of `carriedContentHits` do
 * not have this condition.
 *
 * The scan has limits. It finds a secret only next to a secret key or flag.
 * A secret in free prose, such as "the password is ...", passes. A bare value
 * of only letters, such as `password: swordfish`, also passes, unless the key
 * is in the env form, such as `PASSWORD=swordfish`.
 *
 * A change to this scan must raise `DENY_RULES_VERSION` in `manifest.ts`.
 */

import { CONFIG_LINE, isSecretKey, isSecretValue, secretKeyHits, tokenHits, type ForbiddenHit } from "./manifest.ts";

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
/** A variable reference in a bare word: `$TOKEN` or `${TOKEN}`. */
const REFERENCE = /\$\{[^{}]*\}|\$\w+/g;
/**
 * A value that is only references or command substitutions, with no other
 * text: `$TOKEN`, `${TOKEN}`, `{{token}}`, `${{ secrets.TOKEN }}`, the format
 * field `{token}`, `$(command)`, and a command in backticks. A value with
 * other text next to a reference, such as `abc${SUFFIX}`, is a literal.
 */
const ONLY_REFERENCES = /^(?:\$\w+|\$\{[^{}]*\}|\$?\{\{[^{}]*\}\}|\{[^{}]*\}|\$\([^()]*\)|`[^`]*`)+$/;
/** The start of a quoted string, also with a prefix letter such as `b"` or `f'`. Group 1 is the quote. */
const QUOTE = /^[A-Za-z]{0,2}(["'])/;

/**
 * The hits of the session transcript `path`: the token hits in its decoded
 * strings, then the secret-field hits. A file that is not a `.jsonl` file has
 * none.
 */
export function sessionContentHits(path: string, bytes: Uint8Array): ForbiddenHit[] {
  if (!path.toLowerCase().endsWith(".jsonl")) return [];
  const records = Buffer.from(bytes).toString("utf8").split("\n");
  // JSON can write a token with an escape, such as `ghp\u005f...`. The token rule on the file bytes does not see it.
  const decoded = records.flatMap((record) => decodedText(parseJson(record, 0), 1));
  return [...tokenHits(path, Buffer.from(decoded.join("\n"))), ...secretKeyHits(path, records.flatMap((record) => textKeys(record, 0)))];
}

/** Each key and each string under `value`, and the same for JSON text in a string or in a line of a string. */
function decodedText(value: unknown, nesting: number): string[] {
  if (typeof value === "string") {
    const lines = value.includes("\n") ? value.split("\n").map((line) => line.replace(LINE_NUMBER, "")) : [];
    return [value, ...[value, ...lines].flatMap((text) => decodedText(parseJson(text, nesting), nesting + 1))];
  }
  if (typeof value !== "object" || value === null) return [];
  return Object.entries(value).flatMap(([key, child]) => [key, ...decodedText(child, nesting)]);
}

/** Each secret key under `value` whose value is a secret string, and the secret keys in each other string. */
function valueKeys(value: unknown, nesting: number): string[] {
  if (typeof value === "string") return textKeys(value, nesting);
  if (typeof value !== "object" || value === null) return [];
  return Object.entries(value).flatMap(([key, child]) =>
    !Array.isArray(value) && isSecretKey(key) && typeof child === "string" && isSecretValue(child) && !ONLY_REFERENCES.test(child.trim())
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

/**
 * The secret keys with a literal value in the words of a command line, as
 * `--key=value`, `key=value`, or `--key value`. The value is the text after
 * the key to the end of the line, so a quoted value can have spaces.
 */
function commandKeys(line: string): string[] {
  return [...line.matchAll(/\S+/g)].flatMap((match) => {
    const word = match[0];
    const pair = word.match(/^(-{0,2}([\w-]+)=)/);
    if (pair) {
      const value = line.slice(match.index + pair[1]!.length);
      // A space after `=` ends the value, so the value is empty.
      return isSecretKey(pair[2]!) && !/^\s/.test(value) && isLiteral(value, ENV_KEY.test(pair[2]!)) ? [pair[2]!] : [];
    }
    const flag = word.match(/^--?([\w-]+)$/);
    const next = line.slice(match.index + word.length).trimStart();
    return flag && isSecretKey(flag[1]!) && !next.startsWith("-") && isLiteral(next) ? [flag[1]!] : [];
  });
}

/**
 * True when the text after a secret key starts with a literal value: a quoted
 * string, or a bare word that is not an identifier, a number, or a
 * placeholder. A type, a function call, a member access, and a keyword are
 * not literals. `hunter2` is a literal, and `string` is not, so a bare
 * password of only letters passes.
 *
 * A value that is only references, such as `$TOKEN` or `"${TOKEN}"`, is not a
 * literal, in each kind of quote. A reference in a longer value does not
 * change the value: `abc${SUFFIX}` is a literal.
 *
 * With `env`, the key is in the env form, where a value is not code. A bare
 * word of only letters is then a literal too, but not a word of `ENV_KEYWORDS`.
 */
function isLiteral(text: string, env = false): boolean {
  const value = text.trim();
  const quote = value.match(QUOTE);
  if (quote) {
    const body = quotedBody(value.slice(quote[0].length), quote[1]!);
    return isSecretValue(body) && !ONLY_REFERENCES.test(body.trim());
  }
  // The references go out of a bare word. The text that stays decides.
  const word = value.split(/\s/, 1)[0]!.replace(/[,;]+$/, "").replace(REFERENCE, "");
  const identifier = env ? ENV_KEYWORDS.has(word.toLowerCase()) : IDENTIFIER.test(word);
  return BARE_WORD.test(word) && !identifier && !NUMBER.test(word) && isSecretValue(word);
}

/** The text of a quoted string up to its closing `quote`. A backslash keeps the next character in the string. */
function quotedBody(text: string, quote: string): string {
  for (let index = 0; index < text.length; index++) {
    if (text[index] === "\\") index++;
    else if (text[index] === quote) return text.slice(0, index);
  }
  return text;
}
