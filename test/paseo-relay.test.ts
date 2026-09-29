import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readCommand, writeCommand } from "../src/box-settings.ts";
import { BUILTIN_BOX_PATH_DIRS } from "../src/tools/path.ts";
import { resolveBoxes } from "../src/boxes.ts";
import { configPath, readConfig, setIntegration } from "../src/config.ts";
import { runIntegrationCommand } from "../src/integrations/command.ts";
import { createPaseo, refreshUnitPath, unitFile } from "../src/integrations/paseo.ts";
import type { IntegrationLink } from "../src/integrations/types.ts";
import { noProgress } from "../src/progress.ts";

const homes: string[] = [];
afterEach(() => {
  for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true });
});

function configHome(lines: string[]): string {
  const home = mkdtempSync(join(tmpdir(), "ferry-relay-"));
  homes.push(home);
  mkdirSync(join(home, ".ferry"));
  writeFileSync(configPath(home), ['version = 1', 'publisher = "operator"', 'snapshot_url = "snapshot.git"', ...lines].join("\n"));
  return home;
}

const host = ['[host]', 'transport = "ssh"', 'destination = "user@box.example"'];

test("relay config survives enable and disable", () => {
  const home = configHome([...host, "[integrations]", "paseo_relay = true", "paseo = false"]);
  expect(readConfig(home)?.integrations).toEqual({ paseo: false, paseo_relay: true });
  for (const enabled of [true, false]) {
    setIntegration("paseo", enabled, home);
    expect(readConfig(home)?.integrations).toEqual({ paseo: enabled, paseo_relay: true });
    expect(readFileSync(configPath(home), "utf8")).toContain("paseo_relay = true");
  }
});

test("box relay overrides inherit and survive config writes", () => {
  const home = configHome([
    "[integrations]", "paseo = true", "paseo_relay = true",
    "[box.a]", 'transport = "ssh"', 'destination = "user@a.example"',
    "[box.a.integrations]", "paseo_relay = false",
    "[box.b]", 'transport = "ssh"', 'destination = "user@b.example"',
  ]);
  setIntegration("paseo", true, home, "a");
  expect(resolveBoxes(readConfig(home)!).map((box) => box.integrations.paseo_relay)).toEqual([false, true]);
});

test("relay config rejects non-booleans", () => {
  const home = configHome([...host, "[integrations]", 'paseo_relay = "true"']);
  expect(() => readConfig(home)).toThrow("invalid boolean for paseo_relay");
});

function box(current = "") {
  const commands: string[] = [];
  const link: IntegrationLink = {
    async run(command) {
      commands.push(command);
      let stdout = "";
      if (command === readCommand(".config/systemd/user/ferry-paseo.service")) stdout = current ? `F${current}` : "M";
      if (command === "node --version") stdout = "v22.0.0";
      if (command.includes("paseo daemon status")) stdout = JSON.stringify({ localDaemon: "running", daemonVersion: "0.9.2", relay: { enabled: true } });
      return { ok: true, address: "box", stdout, stderr: "" };
    },
  };
  return { link, commands };
}

test("enable uses config in the plan and service, and restarts a changed unit", async () => {
  const home = configHome([...host, "[integrations]", "paseo_relay = true"]);
  const remote = box(unitFile(BUILTIN_BOX_PATH_DIRS));
  const paseo = createPaseo({ platform: "win32" });
  const result = await runIntegrationCommand({ name: "paseo", action: "enable", yes: true, dryRun: false }, {
    integrations: [paseo], readConfig: () => readConfig(home), setIntegration: (id, enabled) => setIntegration(id, enabled, home),
    createLink: () => remote.link, writeLine: () => {}, progress: noProgress,
  });
  expect(result?.plan.join("\n")).toContain("PASEO_RELAY_ENABLED=true");
  expect(result?.output.join("\n")).toContain("The relay is on.");
  expect(remote.commands).toContain(writeCommand(".config/systemd/user/ferry-paseo.service", unitFile(BUILTIN_BOX_PATH_DIRS, true)));
  expect(remote.commands).toContain("systemctl --user restart ferry-paseo.service");
});

test("PATH refresh preserves an enabled relay", async () => {
  const remote = box(unitFile([".local/bin"], true));
  await refreshUnitPath(remote.link, [".local/bin", ".bun/bin"]);
  expect(remote.commands).toContain(writeCommand(".config/systemd/user/ferry-paseo.service", unitFile([".local/bin", ".bun/bin"], true)));
});

test("status accepts the configured relay", async () => {
  const remote = box();
  const link: IntegrationLink = {
    async run(command) {
      const result = await remote.link.run(command);
      return { ...result, stdout: 'active=active\nenabled=enabled\nold=inactive\nferry-section\n' + JSON.stringify({ localDaemon: "running", relay: { enabled: true } }) };
    },
  };
  const health = await createPaseo({ platform: "win32" }).box.health(link, { paseo_relay: true });
  expect(health.warnings).toEqual([]);
});

for (const relay of [false, true]) {
  test(`enable applies relay=${relay} without restarting an unchanged unit`, async () => {
    const remote = box(unitFile(BUILTIN_BOX_PATH_DIRS, relay));
    await createPaseo({ platform: "win32" }).box.enable(remote.link, noProgress, { paseo_relay: relay });
    expect(remote.commands).not.toContain("systemctl --user restart ferry-paseo.service");
    expect(remote.commands).toContain(writeCommand(".config/systemd/user/ferry-paseo.service", unitFile(BUILTIN_BOX_PATH_DIRS, relay)));
  });
}

test("enable turns the relay off again", async () => {
  const remote = box(unitFile(BUILTIN_BOX_PATH_DIRS, true));
  const lines = await createPaseo({ platform: "win32" }).box.enable(remote.link, noProgress, { paseo_relay: false });
  expect(lines.at(-1)).toContain("The relay is off.");
  expect(remote.commands).toContain(writeCommand(".config/systemd/user/ferry-paseo.service", unitFile(BUILTIN_BOX_PATH_DIRS)));
  expect(remote.commands).toContain("systemctl --user restart ferry-paseo.service");
});
