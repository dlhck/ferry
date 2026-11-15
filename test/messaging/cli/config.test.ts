import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveBoxes } from "../../../src/boxes.ts";
import { isRelayUrl, readConfig, setBoxMessagingKey, setMessagingRelay } from "../../../src/config.ts";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const BASE = ["version = 1", 'publisher = "operator"', 'snapshot_url = "git@example.test:operator/store.git"', ""];
const BOX = ["[box.dev]", 'transport = "ssh"', 'destination = "user@box.example"', ""];

function home(lines: readonly string[]): string {
  const root = mkdtempSync(join(tmpdir(), "ferry-msg-config-"));
  roots.push(root);
  mkdirSync(join(root, ".ferry"));
  writeFileSync(join(root, ".ferry", "config.toml"), lines.join("\n"));
  return root;
}

const text = (root: string) => readFileSync(join(root, ".ferry", "config.toml"), "utf8");

describe("isRelayUrl", () => {
  test("takes https with a host, and http only for this machine", () => {
    expect(isRelayUrl("https://relay.example")).toBe(true);
    expect(isRelayUrl("https://relay.example:8443/")).toBe(true);
    expect(isRelayUrl("http://127.0.0.1:47830")).toBe(true);
    expect(isRelayUrl("http://localhost:47830")).toBe(true);
    expect(isRelayUrl("http://[::1]:47830")).toBe(true);
    expect(isRelayUrl("http://relay.example")).toBe(false);
    expect(isRelayUrl("https://user:secret@relay.example")).toBe(false);
    expect(isRelayUrl("https://relay.example/?token=x")).toBe(false);
    expect(isRelayUrl("https://relay.example/#x")).toBe(false);
    expect(isRelayUrl("relay.example")).toBe(false);
  });
});

describe("the [messaging] section and the box keys", () => {
  test("a config without them reads as before", () => {
    const config = readConfig(home([...BASE, ...BOX]))!;
    expect(config.messaging).toBeUndefined();
    expect(resolveBoxes(config)[0]).toMatchObject({ messaging: false, relay: false });
  });

  test("reads the relay URL and the box keys", () => {
    const config = readConfig(home([...BASE, "[messaging]", 'relay = "https://relay.example"', "", ...BOX, "messaging = true", "relay = true", ""]))!;
    expect(config.messaging).toEqual({ relay: "https://relay.example" });
    expect(resolveBoxes(config)[0]).toMatchObject({ messaging: true, relay: true });
  });

  test("refuses a relay URL that is not https", () => {
    expect(() => readConfig(home([...BASE, "[messaging]", 'relay = "http://relay.example"', ""]))).toThrow(/relay/);
  });

  test("refuses a box key that is not a boolean", () => {
    expect(() => readConfig(home([...BASE, ...BOX, 'messaging = "yes"', ""]))).toThrow(/messaging/);
  });

  test("setMessagingRelay and setBoxMessagingKey write the keys and keep the rest", () => {
    const root = home([...BASE, 'default_box = "dev"', "", ...BOX, "mcp_gateway = true", ""]);

    setMessagingRelay("https://relay.example", root);
    expect(setBoxMessagingKey("dev", "messaging", true, root)).toBe(true);
    expect(setBoxMessagingKey("dev", "messaging", true, root)).toBe(false);
    expect(setBoxMessagingKey("dev", "relay", true, root)).toBe(true);

    const config = readConfig(root)!;
    expect(config.messaging).toEqual({ relay: "https://relay.example" });
    expect(config.defaultBox).toBe("dev");
    expect(config.boxes![0]).toMatchObject({ name: "dev", mcpGateway: true, messaging: true, relay: true });
    expect(text(root)).toContain('[messaging]\nrelay = "https://relay.example"');

    expect(setBoxMessagingKey("dev", "relay", false, root)).toBe(true);
    expect(readConfig(root)!.boxes![0]!.relay).toBeUndefined();
    expect(text(root)).not.toContain("relay = true");
  });

  test("setBoxMessagingKey needs a box table", () => {
    const root = home([...BASE, "[host]", 'transport = "ssh"', 'destination = "user@box.example"', ""]);
    expect(() => setBoxMessagingKey("dev", "messaging", true, root)).toThrow(/box add/);
  });
});
