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

  test("reads only .jsonl files", () => {
    expect(sessionContentHits("memory/MEMORY.md", Buffer.from(`PASSWORD=${PASSWORD}\n`))).toEqual([]);
    expect(reasons(jsonl(toolResult(`PASSWORD=${PASSWORD}\n`)), "SESSION.JSONL")).toHaveLength(1);
  });
});
