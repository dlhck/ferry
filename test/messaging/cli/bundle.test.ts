import { afterAll, expect, test } from "bun:test";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";

const ROOT = join(import.meta.dir, "..", "..", "..");
const out = mkdtempSync(join(tmpdir(), "ferry-msg-bundle-"));
afterAll(() => rmSync(out, { recursive: true, force: true }));

/**
 * `bun build --compile` bundles only the modules that it can find from
 * src/cli.ts. A module that the CLI loads through a variable specifier is not
 * in the release binary, and the command then fails there but works from
 * source. So each module of src/messaging must be in the bundle.
 */
test("the bundle of the CLI has each module of src/messaging", async () => {
  const build = await Bun.build({ entrypoints: [join(ROOT, "src", "cli.ts")], target: "bun", outdir: out });
  expect(build.success).toBe(true);
  const bundle = readFileSync(join(out, "cli.js"), "utf8");
  const bundled = new Set([...bundle.matchAll(/^\/\/ (src\/messaging\/\S+)$/gm)].map((match) => match[1]));
  const modules = readdirSync(join(ROOT, "src", "messaging"), { recursive: true, encoding: "utf8" })
    .filter((path) => path.endsWith(".ts") && !path.endsWith(".d.ts"))
    .map((path) => relative(ROOT, join(ROOT, "src", "messaging", path)).replaceAll("\\", "/"));

  expect(modules).toContain("src/messaging/hook.ts");
  expect(modules.filter((path) => !bundled.has(path))).toEqual([]);
}, 60_000);
