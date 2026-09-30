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
/**
 * The start of a quoted string, also with a prefix letter such as `b"` or
 * `f'`. Group 1 is the quote: one quote character, or three for a string of
 * Python or TOML that can have line ends.
 */
const QUOTE = /^[A-Za-z]{0,2}("""|'''|["'])/;
/** A word directly after a closing quote, which a shell joins to the string, as in `""hunter2`. It does not start with a sign. */
const JOINED_WORD = /^[A-Za-z0-9_$][\w+/=.~@%:!#^*${}-]*/;
/** The `|` or `>` of a YAML block scalar, with its chomping sign, its indentation digit, and a comment. */
const BLOCK_SCALAR = /^[|>][+-]?\d?\s*(?:#.*)?$/;

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
  const lines = text.split("\n").map((line) => line.replace(LINE_NUMBER, ""));
  return lines.flatMap((line, index) => {
    const record = line === text ? undefined : parseJson(line, nesting);
    if (record !== undefined) return valueKeys(record, nesting + 1);
    // A value can go on in the lines after its key: a string with line ends, or a YAML value.
    const after = lines.slice(index + 1);
    const config = line.match(CONFIG_LINE);
    const found = config && isSecretKey(config[1]!) && (isLiteral(config[2]!, false, after) || isNextLineValue(config[2]!, line, after));
    return [...(found ? [config[1]!] : []), ...commandKeys(line, after)];
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
 * the key to the end of the line, so a quoted value can have spaces. `after`
 * has the lines after `line`, for a string that goes on there.
 */
function commandKeys(line: string, after: readonly string[]): string[] {
  return [...line.matchAll(/\S+/g)].flatMap((match) => {
    const word = match[0];
    const pair = word.match(/^(-{0,2}([\w-]+)=)/);
    if (pair) {
      const value = line.slice(match.index + pair[1]!.length);
      // A space after `=` ends the value, so the value is empty.
      return isSecretKey(pair[2]!) && !/^\s/.test(value) && isLiteral(value, ENV_KEY.test(pair[2]!), after) ? [pair[2]!] : [];
    }
    const flag = word.match(/^--?([\w-]+)$/);
    const next = line.slice(match.index + word.length).trimStart();
    return flag && isSecretKey(flag[1]!) && !next.startsWith("-") && isLiteral(next, false, after) ? [flag[1]!] : [];
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
function isLiteral(text: string, env = false, after: readonly string[] = []): boolean {
  const value = text.trim();
  // In code, strings in parentheses are one value, also on the lines after the parenthesis.
  const open = [value, ...after].join("\n").match(/^\(\s*/);
  const strings = open ? [value, ...after].join("\n").slice(open[0].length) : value;
  if (QUOTE.test(strings)) {
    const body = (open ? quotedValue(strings, [], true) : quotedValue(value, after, false)).trim();
    return isSecretValue(body) && !ONLY_REFERENCES.test(body);
  }
  // The references go out of a bare word. The text that stays decides.
  const word = value.split(/\s/, 1)[0]!.replace(/[,;]+$/, "").replace(REFERENCE, "");
  const identifier = env ? ENV_KEYWORDS.has(word.toLowerCase()) : IDENTIFIER.test(word);
  return BARE_WORD.test(word) && !identifier && !NUMBER.test(word) && isSecretValue(word);
}

/**
 * True when the value of a YAML key is in the lines after the key, and is a
 * literal. `value` is the text after the key in `line`. After `|` or `>`, the
 * lines with more indentation than the key are a block scalar, which is a
 * string. After no value, the next line with more indentation is the value,
 * or the first item of a list, when it is not a key of its own.
 */
function isNextLineValue(value: string, line: string, after: readonly string[]): boolean {
  const indent = (text: string) => text.length - text.trimStart().length;
  const block = BLOCK_SCALAR.test(value.trim());
  if (!block && value.trim() !== "") return false;
  const end = after.findIndex((next) => next.trim() !== "" && indent(next) <= indent(line));
  const inner = (end === -1 ? after : after.slice(0, end)).filter((next) => next.trim() !== "");
  if (inner.length === 0) return false;
  if (block) {
    const body = inner.map((next) => next.trim()).join("\n");
    return isSecretValue(body) && !ONLY_REFERENCES.test(body);
  }
  const item = inner[0]!.trim().replace(/^-\s+/, "");
  return !CONFIG_LINE.test(item) && isLiteral(item, false, inner.slice(1));
}

/**
 * The text of the quoted strings at the start of `value`, as one value.
 * Strings next to each other are one value: `"hun" "ter2"` and `"" + "x"` in
 * code, and `""hunter2` in a shell, where a word directly after the closing
 * quote is a part of the value. So an empty first string does not hide the
 * rest. A string goes on in the lines of `after` until its closing quote. A
 * backslash keeps the next character in a string. With `lines`, the next
 * string can be on the next line, as in parentheses.
 */
function quotedValue(value: string, after: readonly string[], lines: boolean): string {
  let rest = [value, ...after].join("\n");
  let body = "";
  for (let quote = rest.match(QUOTE); quote; quote = rest.match(QUOTE)) {
    rest = rest.slice(quote[0].length);
    let end = 0;
    while (end < rest.length && !rest.startsWith(quote[1]!, end)) end += rest[end] === "\\" ? 2 : 1;
    body += rest.slice(0, end);
    rest = rest.slice(end + quote[1]!.length);
    const joined = rest.match(JOINED_WORD);
    if (joined) {
      body += joined[0].replace(REFERENCE, "");
      rest = rest.slice(joined[0].length);
    }
    // Only a string can follow after a space or a plus sign. Other text ends the value. With `lines`, a line end is a space.
    rest = rest.replace(lines ? /^\s*(?:\+\s*)?/ : /^[ \t]*(?:\+[ \t]*)?/, "");
  }
  return body;
}
