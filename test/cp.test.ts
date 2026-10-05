import { afterEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, symlinkSync, truncateSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runCp, type CpDependencies, type CpInput } from "../src/cp.ts";
import { buildProgram } from "../src/cli.ts";
import type { Link, RunOptions } from "../src/link.ts";
import { DENY_RULES_VERSION } from "../src/manifest.ts";
import { MAX_FILE_BYTES } from "../src/scan.ts";
import { installBoxFerry } from "./box-ferry-shim.ts";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function world() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "ferry-cp-test-")));
  roots.push(root);
  const operator = join(root, "operator");
  const box = join(root, "box");
  mkdirSync(operator);
  mkdirSync(box);
  installBoxFerry(box);
  const received: string[] = [];
  const sent: Uint8Array[] = [];
  let transform = (command: string, options: RunOptions) => ({ command, options });
  const link: Pick<Link, "run"> = {
    async run(command, options = {}) {
      if (options.input) sent.push(options.input);
      const changed = transform(command, options);
      const child = Bun.spawnSync(["sh", "-c", changed.command], {
        stdin: changed.options.input ?? "ignore",
        env: { ...process.env, HOME: box },
      });
      const stdout = child.stdout.toString();
      const stderr = child.stderr.toString();
      received.push(stdout, stderr);
      return child.exitCode === 0
        ? { ok: true, address: "user@box.example", stdout, stderr }
        : { ok: false, error: { code: "command-failed", origin: "box", message: stderr || "failed" } };
    },
  };
  const dependencies: CpDependencies = {
    readConfig: () => ({ host: { transport: "ssh", destination: "user@box.example" } }),
    createLink: () => link,
    home: operator,
    cwd: operator,
  };
  return { root, operator, box, dependencies, sent, received, transform: (fn: typeof transform) => { transform = fn; } };
}

describe("ferry cp", () => {
  test.each([false, true])("copies and verifies a binary file, from box: %s", async (fromBox) => {
    const w = world();
    const bytes = Buffer.from([0, 1, 2, 255, 128, 10]);
    const name = "report's $file.pdf";
    writeFileSync(join(fromBox ? w.box : w.operator, name), bytes, { mode: 0o640 });
    const source = fromBox ? `default:~/${name}` : name;
    const destination = fromBox ? "report.pdf" : "default:~/report.pdf";
    const result = await runCp({ source, destination, force: false }, w.dependencies);
    const target = join(fromBox ? w.operator : w.box, "report.pdf");
    expect(readFileSync(target)).toEqual(bytes);
    expect(result.sha256).toBe(createHash("sha256").update(bytes).digest("hex"));
    expect(statSync(target).mode & 0o777).toBe(0o640);
    expect(readdirSync(fromBox ? w.operator : w.box).some((name) => name.startsWith(".ferry-cp."))).toBe(false);
    expect(existsSync(join(fromBox ? w.box : w.operator, name))).toBe(true);
  });

  test.each([false, true])("refuses overwrite and supports force, from box: %s", async (fromBox) => {
    const w = world();
    writeFileSync(join(fromBox ? w.box : w.operator, "report.pdf"), "new report");
    const target = join(fromBox ? w.operator : w.box, "report.pdf");
    writeFileSync(target, "old report");
    const input = { source: fromBox ? "default:report.pdf" : "report.pdf", destination: fromBox ? "report.pdf" : "default:report.pdf", force: false };
    await expect(runCp(input, w.dependencies)).rejects.toThrow("destination exists");
    expect(readFileSync(target, "utf8")).toBe("old report");
    await runCp({ ...input, force: true }, w.dependencies);
    expect(readFileSync(target, "utf8")).toBe("new report");
  });

  test.each([false, true])("does not transfer denied bytes, from box: %s", async (fromBox) => {
    const w = world();
    const secret = "ghp_" + "a".repeat(36);
    writeFileSync(join(fromBox ? w.box : w.operator, "report.pdf"), secret);
    await expect(runCp({ source: fromBox ? "default:report.pdf" : "report.pdf", destination: fromBox ? "copy.pdf" : "default:copy.pdf", force: true }, w.dependencies)).rejects.toThrow("GitHub token");
    expect(existsSync(join(fromBox ? w.operator : w.box, "copy.pdf"))).toBe(false);
    expect(Buffer.concat(w.sent.map((bytes) => Buffer.from(bytes))).includes(secret)).toBe(false);
    expect(w.received.join("\n")).not.toContain(secret);
    expect(w.received.join("\n")).not.toContain(Buffer.from(secret).toString("base64"));
  });

  test.each([".env", "credentials.json", "id_rsa"])("refuses denied name %s before a pack", async (name) => {
    const w = world();
    writeFileSync(join(w.box, name), "plain text");
    await expect(runCp({ source: `default:${name}`, destination: "copy.txt", force: false }, w.dependencies)).rejects.toThrow("refused the path");
    expect(w.received).toEqual([]);
  });

  test.each([false, true])("refuses a directory and symlinks, from box: %s", async (fromBox) => {
    const w = world();
    const home = fromBox ? w.box : w.operator;
    mkdirSync(join(home, "folder"));
    writeFileSync(join(home, "folder/report.pdf"), "report");
    symlinkSync("folder", join(home, "alias"));
    symlinkSync("folder/report.pdf", join(home, "link.pdf"));
    const copy = (name: string) => runCp({ source: fromBox ? `default:${name}` : name, destination: fromBox ? "copy.pdf" : "default:copy.pdf", force: false }, w.dependencies);
    await expect(copy("folder")).rejects.toThrow("not a regular file");
    await expect(copy("alias/report.pdf")).rejects.toThrow("symbolic link");
    await expect(copy("link.pdf")).rejects.toThrow("symbolic link");
    await expect(copy("missing.pdf")).rejects.toThrow();
  });

  test("supports absolute paths outside the home", async () => {
    const w = world();
    const source = join(w.root, "report.pdf");
    writeFileSync(source, "report");
    await runCp({ source, destination: `default:${join(w.root, "copy.pdf")}`, force: false }, w.dependencies);
    expect(readFileSync(join(w.root, "copy.pdf"), "utf8")).toBe("report");
  });

  test("rejects files over the scan limit", async () => {
    const w = world();
    writeFileSync(join(w.box, "large.pdf"), "");
    truncateSync(join(w.box, "large.pdf"), MAX_FILE_BYTES + 1);
    await expect(runCp({ source: "default:large.pdf", destination: "copy.pdf", force: false }, w.dependencies)).rejects.toThrow("too large");
  });

  test("rejects old box rules without copying bytes", async () => {
    const w = world();
    installBoxFerry(w.box, `echo '{"ok":true,"result":{"rules":${DENY_RULES_VERSION - 1},"carry":[],"refused":[]}}'`);
    await expect(runCp({ source: "default:report.pdf", destination: "copy.pdf", force: false }, w.dependencies)).rejects.toThrow("older deny rules");
    expect(existsSync(join(w.operator, "copy.pdf"))).toBe(false);
  });

  test.each([false, true])("refuses a box pack with denied bytes or an incorrect hash, corrupt hash: %s", async (corruptHash) => {
    const w = world();
    const bytes = Buffer.from("ghp_" + "a".repeat(36));
    w.transform((command, options) => {
      const request = options.input && JSON.parse(Buffer.from(options.input).toString());
      if (request?.pack !== true) return { command, options };
      const sha256 = corruptHash ? "0".repeat(64) : createHash("sha256").update(bytes).digest("hex");
      const output = [
        { pack: 1, rules: DENY_RULES_VERSION },
        { file: { path: request.paths[0], sha256, size: bytes.length, mode: 0o600, secrets: [], id: null } },
        { data: bytes.toString("base64") },
        { end: 1 },
      ].map((line) => JSON.stringify(line)).join("\n") + "\n";
      return { command: "cat", options: { input: Buffer.from(output) } };
    });
    await expect(runCp({ source: "default:report.pdf", destination: "copy.pdf", force: false }, w.dependencies)).rejects.toThrow();
    expect(existsSync(join(w.operator, "copy.pdf"))).toBe(false);
  });

  test("copies an empty file with a colon in its local name", async () => {
    const w = world();
    writeFileSync(join(w.operator, "report:empty.pdf"), "");
    await runCp({ source: "./report:empty.pdf", destination: "default:empty.pdf", force: false }, w.dependencies);
    expect(readFileSync(join(w.box, "empty.pdf")).length).toBe(0);
  });

  test("keeps the destination on checksum failure and removes temporary files", async () => {
    const w = world();
    writeFileSync(join(w.operator, "report.pdf"), "report");
    writeFileSync(join(w.box, "copy.pdf"), "old report");
    w.transform((command, options) => command.includes("SHA-256 verification failed")
      ? { command, options: { ...options, input: Buffer.from("damaged transfer") } }
      : { command, options });
    await expect(runCp({ source: "report.pdf", destination: "default:copy.pdf", force: true }, w.dependencies)).rejects.toThrow("SHA-256 verification failed");
    expect(readFileSync(join(w.box, "copy.pdf"), "utf8")).toBe("old report");
    expect(readdirSync(w.box).some((name) => name.startsWith(".ferry-cp."))).toBe(false);
  });

  test("a destination created during the copy stays", async () => {
    const w = world();
    writeFileSync(join(w.operator, "report.pdf"), "report");
    w.transform((command, options) => {
      if (command.includes("SHA-256 verification failed")) writeFileSync(join(w.box, "copy.pdf"), "other copy");
      return { command, options };
    });
    await expect(runCp({ source: "report.pdf", destination: "default:copy.pdf", force: false }, w.dependencies)).rejects.toThrow();
    expect(readFileSync(join(w.box, "copy.pdf"), "utf8")).toBe("other copy");
  });

  test.each(["folder", "link.pdf"])("force refuses destination %s", async (name) => {
    const w = world();
    writeFileSync(join(w.operator, "report.pdf"), "report");
    mkdirSync(join(w.box, "folder"));
    symlinkSync("folder", join(w.box, "link.pdf"));
    await expect(runCp({ source: "report.pdf", destination: `default:${name}`, force: true }, w.dependencies)).rejects.toThrow("directory or symbolic link");
  });

  test.each([
    ["report.pdf", "copy.pdf", undefined],
    ["a:report.pdf", "b:copy.pdf", undefined],
    ["a:report.pdf", "copy.pdf", "b"],
    [":", "copy.pdf", undefined],
  ])("rejects invalid endpoints %s %s", async (source, destination, box) => {
    const w = world();
    await expect(runCp({ source, destination, box, force: false }, w.dependencies)).rejects.toThrow();
    expect(w.received).toEqual([]);
  });

  test("uses explicit box, default box, and only box through the resolver", async () => {
    const w = world();
    writeFileSync(join(w.operator, "report.pdf"), "report");
    const boxes = ["a", "b"].map((name) => ({ name, host: { transport: "ssh" as const, destination: `user@${name}.example` } }));
    const copy = (destination: string, config: ReturnType<CpDependencies["readConfig"]>, box?: string) => runCp({ source: "report.pdf", destination, box, force: true }, { ...w.dependencies, readConfig: () => config });
    expect((await copy("a:copy.pdf", { boxes, defaultBox: "b" })).box).toBe("a");
    expect((await copy(":copy.pdf", { boxes, defaultBox: "b" }, "a")).box).toBe("a");
    expect((await copy(":copy.pdf", { boxes, defaultBox: "b" })).box).toBe("b");
    expect((await copy(":copy.pdf", { boxes: [boxes[0]!] })).box).toBe("a");
    await expect(copy(":copy.pdf", { boxes })).rejects.toThrow("More than one box");
    await expect(copy("unknown:copy.pdf", { boxes })).rejects.toThrow("unknown box");
  });

  test("releases the box lock after a refusal", async () => {
    const w = world();
    let released = false;
    await expect(runCp({ source: "default:missing.pdf", destination: "copy.pdf", force: false }, {
      ...w.dependencies,
      lockBox: () => () => { released = true; },
    })).rejects.toThrow();
    expect(released).toBe(true);
  });

  test("wires cp options and JSON output", async () => {
    let input: CpInput | undefined;
    const output: string[] = [];
    const program = buildProgram({
      runCp: async (value) => {
        input = value;
        return { box: "a", source: value.source, destination: value.destination, sha256: "a".repeat(64) };
      },
      writeLine: (line) => output.push(line),
    });
    await program.parseAsync(["cp", ":report.pdf", "copy.pdf", "--box", "a", "--force", "--json"], { from: "user" });
    expect(input).toEqual({ source: ":report.pdf", destination: "copy.pdf", box: "a", force: true });
    expect(JSON.parse(output[0]!).result.sha256).toBe("a".repeat(64));
  });
});
