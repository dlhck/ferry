import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { packOnBox, scanOnBox } from "../src/scan.ts";

async function slowOutput(home: string, command: string, input: string): Promise<string> {
  // The shell pipe stays unread for one second, as it can during an SSH transfer.
  const child = Bun.spawn([
    "bash", "-o", "pipefail", "-c", '"$1" "$2" --json "$3" | (sleep 1; cat)',
    "ferry-stdout", process.execPath, join(import.meta.dir, "../src/cli.ts"), command,
  ], {
    cwd: home,
    env: { ...process.env, HOME: home, FERRY_NO_UPDATE_CHECK: "1" },
    stdin: new Blob([input]),
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited,
  ]);
  expect(code).toBe(0);
  expect(stderr).toBe("");
  return stdout;
}

test("scan packs every byte and its hash through a slow stdout pipe", async () => {
  const home = await mkdtemp(join(tmpdir(), "ferry-stdout-"));
  try {
    const bytes = Buffer.alloc(4 * 1024 * 1024 + 17, 0xab);
    await writeFile(join(home, "example.png"), bytes);
    const request = { kind: "files" as const, root: "", paths: ["example.png"], secrets: [] };
    const stdout = await slowOutput(home, "scan", JSON.stringify({ ...request, pack: true }));
    const pack = await packOnBox({ run: async () => ({ ok: true, stdout, stderr: "", address: "box.example" }) }, "box.example", request);
    expect(pack.refused).toEqual([]);
    expect(pack.files).toHaveLength(1);
    expect(pack.files[0]!.bytes).toEqual(bytes);
    expect(pack.files[0]!.sha256).toBe(createHash("sha256").update(bytes).digest("hex"));
    expect(stdout.endsWith('{"end":1}\n')).toBe(true);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("scan sends a large result envelope through a slow stdout pipe", async () => {
  const home = await mkdtemp(join(tmpdir(), "ferry-stdout-"));
  try {
    const paths = Array.from({ length: 3000 }, (_, index) => `missing-example-file-${index}.txt`);
    const request = { kind: "files" as const, root: "", paths, allowSecrets: false };
    const stdout = await slowOutput(home, "scan", JSON.stringify(request));
    const scan = await scanOnBox({ run: async () => ({ ok: true, stdout, stderr: "", address: "box.example" }) }, "box.example", request);
    expect(scan.carry).toEqual([]);
    expect(scan.refused.map((hit) => hit.path)).toEqual(paths);
    expect(stdout.endsWith("\n")).toBe(true);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("redact sends large filtered text through a slow stdout pipe without adding a newline", async () => {
  const home = await mkdtemp(join(tmpdir(), "ferry-stdout-"));
  try {
    const text = "example text\n".repeat(40000);
    const token = "gh" + "p_" + "a".repeat(36);
    expect(await slowOutput(home, "redact", text + token)).toBe(text + "[token]");
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});
