import { describe, expect, test } from "bun:test";
import { carriedContentHits } from "../src/manifest.ts";
import { sessionContentHits } from "../src/session-scan.ts";

// Fake secrets, built at runtime so that no secret scanner flags this file.
const PASSWORD = "example" + "-pass";

function jsonl(...records: unknown[]): Uint8Array {
  return Buffer.from(records.map((record) => `${JSON.stringify(record)}\n`).join(""));
}

/** A Claude record with one tool call. */
function toolUse(name: string, input: unknown): unknown {
  return { type: "assistant", message: { role: "assistant", content: [{ type: "tool_use", id: "toolu_1", name, input }] } };
}

/** A Claude record with one tool result. */
function toolResult(content: unknown): unknown {
  return { type: "user", message: { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_1", content }] } };
}

function reasons(bytes: Uint8Array, path = "session.jsonl"): string[] {
  return sessionContentHits(path, bytes).map((hit) => hit.reason);
}

describe("sessionContentHits", () => {
  test("finds a password in JSON text that a Write tool call holds in a string", () => {
    const bytes = jsonl(toolUse("Write", { file_path: "config.json", content: JSON.stringify({ password: PASSWORD }) }));

    // The file rules do not parse a .jsonl file, and no token pattern matches a password.
    expect(carriedContentHits("session.jsonl", bytes)).toEqual([]);
    expect(sessionContentHits("session.jsonl", bytes)).toEqual([
      { path: "session.jsonl", code: "secret-field", reason: "key password holds a password or secret" },
    ]);
  });

  test("reads each record of a file with several records, and names each key one time", () => {
    const bytes = jsonl(
      { type: "user", message: { role: "user", content: "hello" } },
      toolUse("Bash", { command: "ls" }),
      toolResult([{ type: "text", text: "README.md\n" }]),
      toolUse("Write", { file_path: "a.json", content: JSON.stringify({ db: { password: PASSWORD } }) }),
      toolUse("Write", { file_path: "b.json", content: JSON.stringify({ password: PASSWORD, apiKey: PASSWORD }) }),
    );

    expect(reasons(bytes)).toEqual(["key password holds a password or secret", "key apiKey holds a password or secret"]);
  });

  test("finds a secret key of a structured tool input and of a structured tool result", () => {
    expect(reasons(jsonl(toolUse("mcp__db__connect", { host: "db.example", password: PASSWORD })))).toEqual([
      "key password holds a password or secret",
    ]);
    expect(reasons(jsonl({ type: "user", toolUseResult: { rows: [{ client_secret: PASSWORD }] } }))).toEqual([
      "key client_secret holds a password or secret",
    ]);
  });

  test("finds KEY=value text and key: value text in a tool result", () => {
    const env = `PORT=3000\nDB_PASSWORD=${PASSWORD}\n`;
    expect(reasons(jsonl(toolResult(env)))).toEqual(["key DB_PASSWORD holds a password or secret"]);
    expect(reasons(jsonl(toolResult([{ type: "text", text: env }])))).toEqual(["key DB_PASSWORD holds a password or secret"]);
    expect(reasons(jsonl(toolResult(`db:\n  password: ${PASSWORD}\n`)))).toEqual(["key password holds a password or secret"]);
    expect(reasons(jsonl(toolResult(`api_key = "${PASSWORD}"\n`)))).toEqual(["key api_key holds a password or secret"]);
  });

  test("finds config text behind the line numbers of a file that the harness read", () => {
    expect(reasons(jsonl(toolResult(`     1\tPORT=3000\n     2\tDB_PASSWORD=${PASSWORD}\n`)))).toEqual([
      "key DB_PASSWORD holds a password or secret",
    ]);
    expect(reasons(jsonl(toolResult(`1→{"password":"${PASSWORD}"}\n2→\n`)))).toEqual(["key password holds a password or secret"]);
  });

  test("finds a secret flag and a secret assignment in a shell command", () => {
    expect(reasons(jsonl(toolUse("Bash", { command: `psql --host db.example --password ${PASSWORD}` })))).toEqual([
      "key password holds a password or secret",
    ]);
    expect(reasons(jsonl(toolUse("Bash", { command: `deploy --api-key="${PASSWORD}" --region eu` })))).toEqual([
      "key api-key holds a password or secret",
    ]);
    expect(reasons(jsonl(toolUse("Bash", { command: `cd app && PGPASSWORD='${PASSWORD}' psql` })))).toEqual([
      "key PGPASSWORD holds a password or secret",
    ]);
  });

  test("follows JSON text that is nested in JSON text, as in a Codex function call", () => {
    const call = {
      type: "response_item",
      payload: { type: "function_call", name: "shell", arguments: JSON.stringify({ command: ["bash", "-lc", `tool --token ${PASSWORD}`] }) },
    };
    const output = {
      type: "response_item",
      payload: { type: "function_call_output", output: JSON.stringify({ output: JSON.stringify({ secret: PASSWORD }) }) },
    };

    expect(reasons(jsonl(call))).toEqual(["key token holds a password or secret"]);
    expect(reasons(jsonl(output))).toEqual(["key secret holds a password or secret"]);
  });

  test("finds a JSON record on one line of a string with several lines", () => {
    expect(reasons(jsonl(toolResult(`first\n{"password":"${PASSWORD}"}\nlast\n`)))).toEqual([
      "key password holds a password or secret",
    ]);
  });

  test("applies the text rules to a line that is not JSON", () => {
    expect(reasons(Buffer.from(`{"type":"user"}\nPASSWORD=${PASSWORD}\n`))).toEqual(["key PASSWORD holds a password or secret"]);
  });

  test("passes an empty value, a placeholder, a number, and a flag without a value", () => {
    const bytes = jsonl(
      { type: "assistant", message: { usage: { input_tokens: 12, output_tokens: 34 } } },
      toolUse("Write", { file_path: "a.json", content: JSON.stringify({ password: "", apiKey: "xxxx", maxTokens: 4096 }) }),
      toolResult("PASSWORD=\nAPI_KEY=xxxx-xxxx\n"),
      toolUse("Bash", { command: "gh auth status --show-token --hostname github.example" }),
      toolUse("Bash", { command: "psql --password" }),
    );

    expect(sessionContentHits("session.jsonl", bytes)).toEqual([]);
  });

  test("passes a value that is not a literal: a type, a call, a member access, an identifier, a number, or a variable reference", () => {
    const code = [
      "password: string;",
      "  token: str",
      "  token: Optional[str] = None",
      "  apiKey?: string | undefined,",
      "token = get_token()",
      'password = os.environ["DB_PASSWORD"]',
      "const x = 1;\n  apiKey: process.env.API_KEY,",
      "  password: config.password,",
      "  password=password,",
      "secret: null",
      "token = None",
      "password: undefined,",
      "use_token: true",
      "max_tokens = 4096",
      "PASSWORD=$DB_PASSWORD",
      'PASSWORD="${DB_PASSWORD}"',
      "token: {{token}}",
      'token: "{{ secrets.token }}"',
      "API_KEY=$(cat key.txt)",
      "password: ''",
      'token = ""',
      "- token: The token of the request",
    ];
    const commands = [
      "tool --token $TOKEN",
      'tool --token "$TOKEN" --password=${PASSWORD}',
      "tool --max-tokens 4096 --api-key-file key.txt",
      "gh auth login --with-token < token.txt",
      "call(a, password=password)",
      "Use the --password flag for the password.",
    ];

    for (const text of [...code, ...commands]) {
      expect([text, reasons(jsonl(toolResult(text)))]).toEqual([text, []]);
      expect([text, reasons(jsonl(toolUse("Bash", { command: text })))]).toEqual([text, []]);
    }
    expect(reasons(jsonl(toolUse("Write", { content: JSON.stringify({ password: "${DB_PASSWORD}", token: "{{token}}", apiKey: "$API_KEY" }) })))).toEqual([]);
  });

  test("finds a literal value: a quoted string, or a bare word that is not only letters", () => {
    const hunter = "hunt" + "er2";
    const cases: [string, string][] = [
      [`"password": "${hunter}"`, "password"],
      [`{"password": "${hunter}"}`, "password"],
      [`PASSWORD=${hunter}`, "PASSWORD"],
      [`tool --password ${hunter}`, "password"],
      [`Here is the config:\n\n\`\`\`python\npassword = "${hunter}"\n\`\`\`\n`, "password"],
      [`  apiKey: '${hunter}',`, "apiKey"],
      [`const config = {\n  token: "word",\n};`, "token"],
      [`token: ${hunter}  # the token`, "token"],
      [`tool --api-key="${hunter}"`, "api-key"],
      [`TOKEN='two words' tool`, "TOKEN"],
    ];

    for (const [text, key] of cases) {
      expect([text, reasons(jsonl(toolResult(text)))]).toEqual([text, [`key ${key} holds a password or secret`]]);
    }
  });

  test("in the env form, KEY=value with an upper-case key and no space, a bare value of only letters is a literal", () => {
    const word = "sword" + "fish";
    const hits: [string, string][] = [
      [`PASSWORD=${word}`, "PASSWORD"],
      [`export DB_PASSWORD=${word}`, "DB_PASSWORD"],
      [`PORT=3000\nAPI_KEY=${word}\n`, "API_KEY"],
      [`cd app && PGPASSWORD=${word} psql`, "PGPASSWORD"],
    ];
    const passes = [
      "password=password",
      `password=${word}`,
      "connect(password=password)",
      `password = ${word}`,
      `PASSWORD = ${word}`,
      `PASSWORD: ${word}`,
      "PASSWORD=$OTHER",
      "PASSWORD=${OTHER}",
      "PASSWORD=",
      "PASSWORD= ",
      "API_KEY=xxxx",
      "USE_TOKEN=true",
      "USE_TOKEN=False",
      "DB_PASSWORD=null",
      "DB_PASSWORD=None",
      "DB_PASSWORD=undefined",
      "MAX_TOKENS=4096",
    ];

    for (const [text, key] of hits) {
      expect([text, reasons(jsonl(toolResult(text)))]).toEqual([text, [`key ${key} holds a password or secret`]]);
    }
    for (const text of passes) expect([text, reasons(jsonl(toolResult(text)))]).toEqual([text, []]);
  });

  test("a value with a reference in a longer literal is a literal", () => {
    const word = "hunt" + "er";
    const json = (value: string) => reasons(jsonl(toolUse("Write", { file_path: "a.json", content: JSON.stringify({ password: value }) })));
    const hits: [string, string][] = [
      [`PASSWORD='${word}\${suffix}'`, "PASSWORD"],
      [`PASSWORD='${word}$SUFFIX'`, "PASSWORD"],
      [`PASSWORD="${word}\${SUFFIX}"`, "PASSWORD"],
      [`PASSWORD="\${PREFIX}${word}"`, "PASSWORD"],
      [`PASSWORD=${word}\${SUFFIX}`, "PASSWORD"],
      [`password: "${word}{{suffix}}"`, "password"],
      [`password = "{{a}}${word}{{b}}"`, "password"],
      [`password = "$(id -u)${word}$(id -g)"`, "password"],
      [`tool --password "${word}\${SUFFIX}"`, "password"],
      [`tool --password '${word} \${SUFFIX}'`, "password"],
      // An escape makes the next character a literal.
      [`PASSWORD="\\$NOT_A_VARIABLE"`, "PASSWORD"],
      [`PASSWORD="\\\${NOT_A_VARIABLE}"`, "PASSWORD"],
      [`password = "a\\"b"`, "password"],
      [`password = "\\"${word}\\""`, "password"],
      // A string with a prefix letter is a quoted string.
      [`password = b"${word}"`, "password"],
      [`password = r'${word}'`, "password"],
      [`password = f"${word}{suffix}"`, "password"],
    ];

    for (const [text, key] of hits) {
      expect([text, reasons(jsonl(toolResult(text)))]).toEqual([text, [`key ${key} holds a password or secret`]]);
    }
    for (const value of [`${word}\${suffix}`, `\${prefix}${word}`, `${word}{{suffix}}`, `${word}$SUFFIX`, `$(id)${word}`]) {
      expect([value, json(value)]).toEqual([value, ["key password holds a password or secret"]]);
    }
  });

  test("a value that is one reference or one command substitution is not a literal, in each kind of quote", () => {
    const json = (value: string) => reasons(jsonl(toolUse("Write", { file_path: "a.json", content: JSON.stringify({ password: value }) })));
    const passes = [
      "PASSWORD=$OTHER",
      "PASSWORD=${OTHER}",
      "PASSWORD=${OTHER:-}",
      "PASSWORD=$A$B",
      'PASSWORD="$OTHER"',
      'PASSWORD="${OTHER}"',
      "PASSWORD='$OTHER'",
      "PASSWORD='${OTHER}'",
      "PASSWORD=$(cat password.txt)",
      'PASSWORD="$(cat password.txt)"',
      "PASSWORD=`cat password.txt`",
      'PASSWORD="`cat password.txt`"',
      'export API_TOKEN="$(vault read -field=token secret/app)" && run',
      "token: ${{ secrets.TOKEN }}",
      "token: '${{ secrets.TOKEN }}'",
      'password: "{{ password }}"',
      "password = f\"{password}\"",
      'password = "{password}"',
      'tool --password "$(cat password.txt)" --verbose',
      "tool --token `cat token.txt`",
    ];

    for (const text of passes) expect([text, reasons(jsonl(toolResult(text)))]).toEqual([text, []]);
    for (const value of ["$OTHER", "${OTHER}", "{{ password }}", "${{ secrets.X }}", "$(cat password.txt)", "`cat password.txt`", "{password}"]) {
      expect([value, json(value)]).toEqual([value, []]);
    }
  });

  test("a vendor token with JSON escapes is a token in the decoded string, under any key and in nested JSON text", () => {
    const token = "gh" + "p_" + "c".repeat(36);
    const escaped = token.replace("_", "\\u005f");
    const hit = [{ path: "session.jsonl", code: "github-token", reason: "GitHub token in file content" }];
    const record = `{"type":"user","note":"use ${escaped}"}\n`;
    const nested = jsonl(toolUse("Write", { file_path: "a.json", content: `{"note":"${escaped}"}` }));
    const lines = jsonl(toolResult(`first\n{"note":"${escaped}"}\nlast\n`));
    const key = `{"type":"user","${escaped}":1}\n`;

    expect(record).not.toContain(token);
    expect(carriedContentHits("session.jsonl", Buffer.from(record))).toEqual([]);
    expect(sessionContentHits("session.jsonl", Buffer.from(record))).toEqual(hit);
    expect(sessionContentHits("session.jsonl", nested)).toEqual(hit);
    expect(sessionContentHits("session.jsonl", lines)).toEqual(hit);
    expect(sessionContentHits("session.jsonl", Buffer.from(key))).toEqual(hit);
    expect(sessionContentHits("session.jsonl", Buffer.from(`${record}${record}`))).toEqual(hit);
    expect(JSON.stringify(sessionContentHits("session.jsonl", Buffer.from(record)))).not.toContain(token);
  });

  test("a triple-quoted string is a literal, with each quote, with a prefix, and with its text on later lines", () => {
    const word = "hunt" + "er2";
    const hits: [string, string][] = [
      [`password = """${word}"""`, "password"],
      [`password = \'\'\'${word}\'\'\'`, "password"],
      [`password = r"""${word}"""`, "password"],
      [`password = f\'\'\'${word}{suffix}\'\'\'`, "password"],
      [`api_key = """\n${word}\n"""`, "api_key"],
      [`api_key = \'\'\'\n  ${word}\n\'\'\'\nport = 1`, "api_key"],
      [`  password: """${word}""",`, "password"],
      [`tool --password """${word}"""`, "password"],
      [`PASSWORD="""${word}"""`, "PASSWORD"],
      [`password = """ab"cd"""`, "password"],
    ];
    const passes = [
      'password = """"""',
      "password = ",
      'password = """\n"""',
      'password = """${PASSWORD}"""',
      'password = f"""{password}"""',
      'password = """\n  {{ password }}\n"""',
      // The text after the closing quotes is not in the string.
      'password = """""" + get_password()',
    ];

    for (const [text, key] of hits) {
      expect([text, reasons(jsonl(toolUse("Write", { file_path: "config.toml", content: text })))]).toEqual([text, [`key ${key} holds a password or secret`]]);
    }
    for (const text of passes) expect([text, reasons(jsonl(toolResult(text)))]).toEqual([text, []]);
  });

  test("strings next to each other are one value, so an empty first string does not hide the value", () => {
    const hits: [string, string][] = [
      ['password = "hun" "ter2"', "password"],
      ['password = "" "hunter2"', "password"],
      ["password = '' 'hunter2'", "password"],
      ['password = "" + "hunter2"', "password"],
      ['password = ("" "hunter2")', "password"],
      ['password = (\n    "hun"\n    "ter2"\n)', "password"],
      ['PASSWORD=""hunter2', "PASSWORD"],
      ["PASSWORD=''\"hunter2\"", "PASSWORD"],
      ['tool --password ""hunter2', "password"],
      ['PASSWORD="hun"ter2', "PASSWORD"],
    ];
    const passes = [
      'password = ""',
      'password = "",',
      "password: '' # none",
      'password = "" if missing else load()',
      'password = "" + load()',
      'password = "".join(parts)',
      'password = "" "" ""',
      'PASSWORD=""$OTHER',
      'PASSWORD="" tool --verbose',
      'token = "" or os.environ["TOKEN"]',
    ];

    for (const [text, key] of hits) expect([text, reasons(jsonl(toolResult(text)))]).toEqual([text, [`key ${key} holds a password or secret`]]);
    for (const text of passes) expect([text, reasons(jsonl(toolResult(text)))]).toEqual([text, []]);
  });

  test("a YAML value on the next lines is a value: a block scalar and an indented value", () => {
    const hits: [string, string][] = [
      ["db:\n  password: |\n    hunter2\n  port: 1\n", "password"],
      ["password: >-\n  hunter2\n", "password"],
      ["password: |+\n  first line\n  second line\n", "password"],
      ["password: | # the password\n  hunter2\n", "password"],
      ["password:\n  hunter2\n", "password"],
      ['password:\n  "swordfish"\n', "password"],
      ["api_keys:\n  - hunter2\n  - other3\n", "api_keys"],
    ];
    const passes = [
      "password: |\nport: 1\n",
      "password: |\n\nport: 1\n",
      "password: |\n  ${PASSWORD}\n",
      "password: >\n  {{ password }}\n",
      "password:\nport: 1\n",
      "password:\n  from: vault\n  path: secret/app\n",
      "password:\n  string\n",
      "tokens:\n  - name\n  - other\n",
      "token:\n    getToken(),\n",
      "password: |\n  xxxx\n",
    ];

    for (const [text, key] of hits) expect([text, reasons(jsonl(toolResult(text)))]).toEqual([text, [`key ${key} holds a password or secret`]]);
    for (const text of passes) expect([text, reasons(jsonl(toolResult(text)))]).toEqual([text, []]);
  });

  test("the text of a heredoc is scanned as config lines, and a heredoc in a command substitution is not a literal", () => {
    const yaml = "cat > config.yml <<EOF\ndb:\n  password: hunter2\nEOF";
    const env = "cat > .env <<-'EOF'\n\tDB_PASSWORD=swordfish\n\tEOF";
    const substitution = "PASSWORD=$(cat <<EOF\nplain words\nEOF\n)";
    const quoted = 'export TOKEN="$(cat <<EOF\nplain words\nEOF\n)"';

    expect(reasons(jsonl(toolUse("Bash", { command: yaml })))).toEqual(["key password holds a password or secret"]);
    expect(reasons(jsonl(toolUse("Bash", { command: env })))).toEqual(["key DB_PASSWORD holds a password or secret"]);
    expect(reasons(jsonl(toolUse("Bash", { command: substitution })))).toEqual([]);
    expect(reasons(jsonl(toolUse("Bash", { command: quoted })))).toEqual([]);
  });

  test("a vendor token after an underscore in a session is a content hit", () => {
    const token = "gh" + "p_" + "c".repeat(36);
    const bytes = jsonl(toolResult(`export MY_${token}=1`));

    expect(carriedContentHits("session.jsonl", bytes).map((hit) => hit.code)).toEqual(["github-token"]);
  });

  test("a vendor token fires in any form: the token patterns have no literal condition", () => {
    const token = "gh" + "p_" + "c".repeat(36);
    const bytes = jsonl(toolResult(`token = get_token("${token}")`));

    // The secret-field rule has no hit for the call. The token rule has one, in the file bytes and in the decoded string.
    expect(sessionContentHits("session.jsonl", bytes).map((hit) => hit.code)).toEqual(["github-token"]);
    expect(carriedContentHits("session.jsonl", bytes).map((hit) => hit.code)).toEqual(["github-token"]);
  });

  test("passes a secret in free prose: no rule sees it", () => {
    const bytes = jsonl({ type: "user", message: { role: "user", content: `the database password is ${PASSWORD}` } });

    expect(sessionContentHits("session.jsonl", bytes)).toEqual([]);
  });

  test("never returns a value", () => {
    const bytes = jsonl(
      toolUse("Write", { file_path: "a.json", content: JSON.stringify({ password: PASSWORD }) }),
      toolResult(`DB_PASSWORD=${PASSWORD}\n`),
      toolUse("Bash", { command: `psql --password ${PASSWORD}` }),
    );

    expect(JSON.stringify(sessionContentHits("session.jsonl", bytes))).not.toContain(PASSWORD);
  });

  test("does not print a key that is free text", () => {
    const bytes = jsonl(toolUse("Write", { file_path: "a.json", content: JSON.stringify({ [`token of alice ${PASSWORD}`]: "hunt" + "er2" }) }));

    expect(reasons(bytes)).toEqual(["a key holds a password or secret"]);
  });

  test("reads only .jsonl files", () => {
    expect(sessionContentHits("memory/MEMORY.md", Buffer.from(`PASSWORD=${PASSWORD}\n`))).toEqual([]);
    expect(reasons(jsonl(toolResult(`PASSWORD=${PASSWORD}\n`)), "SESSION.JSONL")).toHaveLength(1);
  });
});
