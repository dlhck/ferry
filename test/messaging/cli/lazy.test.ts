import { expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";

const ROOT = resolve(import.meta.dir, "../../..");

/**
 * The static import graph of `entry`: each file and package that a load of it
 * loads. `import type` and `await import(...)` do not count, because they load
 * nothing at the start.
 */
function staticGraph(entry: string): { files: Set<string>; packages: Set<string> } {
  const files = new Set<string>();
  const packages = new Set<string>();
  const visit = (file: string) => {
    if (files.has(file)) return;
    files.add(file);
    const source = readFileSync(file, "utf8");
    const pattern = /^\s*(?:import|export)\s+(?!type\b)(?:[^;'"]*?\sfrom\s+)?["']([^"']+)["']/gm;
    for (const match of source.matchAll(pattern)) {
      const specifier = match[1]!;
      if (specifier.startsWith(".")) {
        const target = resolve(dirname(file), specifier);
        if (existsSync(target) && target.endsWith(".ts")) visit(target);
      } else if (!specifier.startsWith("node:") && !specifier.startsWith("bun:")) {
        packages.add(specifier);
      }
    }
  };
  visit(join(ROOT, entry));
  return { files: new Set([...files].map((file) => relative(ROOT, file))), packages };
}

test("the hook command loads no relay, worker, relay client, or MCP SDK module", () => {
  const { files, packages } = staticGraph("src/messaging/hook.ts");
  expect([...packages]).toEqual([]);
  expect([...files].filter((file) => /^src\/messaging\/(relay|worker|client|github|adapters)\/|^src\/messaging\/(mcp|commands|setup)\.ts$|^src\/sync\.ts$/.test(file))).toEqual([]);
});

test("the CLI loads the messaging commands, the MCP server, and the MCP SDK only in their actions", () => {
  const { files, packages } = staticGraph("src/cli.ts");
  expect(files.has("src/messaging/commands.ts")).toBe(false);
  expect(files.has("src/messaging/mcp.ts")).toBe(false);
  expect([...files].filter((file) => /^src\/messaging\/(relay|worker|client|github|adapters)\//.test(file))).toEqual([]);
  expect([...packages].filter((name) => name.startsWith("@modelcontextprotocol/"))).toEqual([]);
});
