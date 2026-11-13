import { afterEach, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { boxUninstallLines, commitBoxUninstall, planBoxUninstall, removeBoxMessaging } from "../../../src/box-uninstall.ts";
import { addMessagingHooks } from "../../../src/messaging/hooks.ts";
import { BUILTIN_HARNESSES } from "../../../src/registry/builtin.ts";

const HAS_JQ = Bun.which("jq") !== null;
const jqTest = (title: string, run: () => Promise<void>) =>
  test.skipIf(!HAS_JQ)(HAS_JQ ? title : `${title} (skipped: jq is not on the PATH)`, run);

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

/** A box install of Ferry with agent messaging and the relay. Each command runs in `sh` with fake systemctl, claude, and codex. */
function messagingBox() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "ferry-msg-uninstall-")));
  roots.push(root);
  const home = join(root, "home");
  const bin = join(root, "bin");
  const log = join(root, "commands.log");
  mkdirSync(home);
  mkdirSync(bin);
  for (const name of ["systemctl", "claude", "codex"]) {
    writeFileSync(join(bin, name), `#!/bin/sh\nprintf '%s\\n' "${name} $*" >> '${log}'\n`);
    chmodSync(join(bin, name), 0o755);
  }
  const file = (path: string, text: string) => {
    mkdirSync(dirname(join(home, path)), { recursive: true });
    writeFileSync(join(home, path), text);
  };
  file(".ferry/box.json", '{"mode":"box"}\n');
  file(".local/bin/ferry", "binary\n");
  file(".ferry/messaging/credential", "fmr_example\n");
  file(".ferry/messaging/client.json", "{}\n");
  file(".ferry/relay/relay.sqlite", "team data\n");
  file(".config/systemd/user/ferry-messaging.service", "[Unit]\n");
  file(".config/systemd/user/ferry-relay.service", "[Unit]\n");
  const own = { hooks: { Stop: [{ hooks: [{ type: "command", command: "own-stop" }] }] }, permissions: { allow: ["Bash(ls)"] } };
  file(".claude/settings.json", JSON.stringify(addMessagingHooks(own, "claude", true)));
  file(".codex/hooks.json", JSON.stringify(addMessagingHooks({}, "codex")));
  const link = {
    async run(command: string) {
      const child = Bun.spawn(["/bin/sh", "-c", command], {
        cwd: home,
        env: { HOME: home, PATH: `${bin}:/usr/bin:/bin` },
        stdin: "ignore",
        stdout: "pipe",
        stderr: "pipe",
      });
      const [status, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
      return status === 0
        ? ({ ok: true, address: "box", stdout, stderr } as const)
        : ({ ok: false, error: { code: "command-failed", origin: "box", message: stderr.trim() } } as const);
    },
  };
  const logged = () => (existsSync(log) ? readFileSync(log, "utf8").trim().split("\n") : []);
  return { home, link, logged, read: (path: string) => readFileSync(join(home, path), "utf8") };
}

jqTest("box uninstall removes the messaging hooks, the MCP entries, the units, and ~/.ferry/messaging, and keeps ~/.ferry/relay", async () => {
  const box = messagingBox();

  const plan = await planBoxUninstall(BUILTIN_HARNESSES, box.link);

  expect(plan.messagingHooks).toEqual([".claude/settings.json", ".codex/hooks.json"]);
  expect(plan.services).toEqual(["ferry-messaging.service", "ferry-relay.service"]);
  expect(plan.paths).toContain(".ferry/messaging");
  expect(plan.paths).not.toContain(".ferry/relay");
  const lines = boxUninstallLines(plan, "b");
  expect(lines).toContain("Remove the hooks of agent messaging from ~/.codex/hooks.json, and keep the other hooks");
  expect(lines).toContain("Remove the MCP entry ferry-messaging of agent messaging from Claude and Codex");
  expect(lines).toContain("Remove ~/.ferry/messaging, with the messaging credential of the box");

  expect(await removeBoxMessaging(plan, box.link)).toEqual([]);
  const remaining = await commitBoxUninstall(plan, box.link);

  expect(JSON.parse(box.read(".claude/settings.json"))).toEqual({
    hooks: { Stop: [{ hooks: [{ type: "command", command: "own-stop" }] }] },
    permissions: { allow: ["Bash(ls)"] },
  });
  expect(JSON.parse(box.read(".codex/hooks.json"))).toEqual({});
  expect(box.logged()).toContain("claude mcp remove --scope user ferry-messaging");
  expect(box.logged()).toContain("codex mcp remove ferry-messaging");
  expect(existsSync(join(box.home, ".ferry/messaging"))).toBe(false);
  expect(existsSync(join(box.home, ".config/systemd/user/ferry-relay.service"))).toBe(false);
  expect(box.read(".ferry/relay/relay.sqlite")).toBe("team data\n");
  expect(remaining).toEqual(["relay"]);
});
