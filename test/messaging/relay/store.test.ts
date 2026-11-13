import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { existsSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { BACKUPS_KEPT, backupDir, backupStore, latestBackup, restoreStore } from "../../../src/messaging/relay/backup.ts";
import { SCHEMA_VERSION } from "../../../src/messaging/relay/migrate.ts";
import { acquireRelayLock, openStore } from "../../../src/messaging/relay/store.ts";
import { FakeClock, pair, tempDir, world } from "./helpers.ts";

const mode = (path: string) => statSync(path).mode & 0o777;

describe("store", () => {
  test("a new store has mode 0600 in a 0700 directory, WAL, full sync, foreign keys, and the current schema", () => {
    const dir = join(tempDir(), "relay");
    const store = openStore(join(dir, "relay.db"), new FakeClock());
    try {
      expect(mode(dir)).toBe(0o700);
      expect(mode(join(dir, "relay.db"))).toBe(0o600);
      const pragma = (name: string) => Object.values(store.db.query(`PRAGMA ${name}`).get() as Record<string, unknown>)[0];
      expect(pragma("journal_mode")).toBe("wal");
      expect(pragma("synchronous")).toBe(2);
      expect(pragma("foreign_keys")).toBe(1);
      expect(pragma("user_version")).toBe(SCHEMA_VERSION);
    } finally {
      store.close();
    }
  });

  test("a store with a newer schema is refused", () => {
    const path = join(tempDir(), "relay.db");
    const db = new Database(path, { create: true });
    db.run(`PRAGMA user_version = ${SCHEMA_VERSION + 1}`);
    db.close();
    expect(() => openStore(path, new FakeClock())).toThrow(/schema version 2/);
  });

  test("the relay lock admits one holder at a time", () => {
    const dir = tempDir();
    const release = acquireRelayLock(dir);
    expect(release).not.toBeNull();
    expect(acquireRelayLock(dir)).toBeNull();
    release?.();
    const again = acquireRelayLock(dir);
    expect(again).not.toBeNull();
    again?.();
  });
});

describe("backup and restore", () => {
  test("a backup is a checked 0600 copy, and a restore brings the data back and keeps the replaced store", async () => {
    const { w, alice } = await pair();
    const backup = backupStore(w.store.path, undefined, w.clock);
    expect(backup.startsWith(backupDir(w.store.path))).toBe(true);
    expect(mode(backup)).toBe(0o600);
    expect(latestBackup(w.store.path)).toBe(backup);
    w.store.db.query("DELETE FROM memberships").run();
    w.store.db.query("DELETE FROM messages").run();
    w.relay.close();
    w.store.close();
    const previous = restoreStore(backup, w.store.path, w.clock);
    expect(previous).not.toBeNull();
    expect(existsSync(previous ?? "")).toBe(true);
    expect(mode(w.store.path)).toBe(0o600);
    const restored = openStore(w.store.path, w.clock);
    try {
      expect(restored.db.query("SELECT count(*) AS n FROM memberships WHERE session_id = ?").get(alice.id)).toEqual({ n: 1 });
    } finally {
      restored.close();
    }
  });

  test("restore refuses while a relay holds the lock, and refuses a file that is not a relay store", async () => {
    const { w } = await pair();
    const backup = backupStore(w.store.path, undefined, w.clock);
    const release = acquireRelayLock(w.dir);
    try {
      expect(() => restoreStore(backup, w.store.path, w.clock)).toThrow(/relay runs/);
    } finally {
      release?.();
    }
    const other = join(tempDir(), "other.db");
    new Database(other, { create: true }).close();
    expect(() => restoreStore(other, w.store.path, w.clock)).toThrow(/not a relay store/);
    const junk = join(tempDir(), "junk.db");
    writeFileSync(junk, "not sqlite");
    expect(() => restoreStore(junk, w.store.path, w.clock)).toThrow();
  });

  test("the backup directory keeps the newest 14, also for two backups in one second", async () => {
    const { w } = await pair();
    const made: string[] = [];
    for (let index = 0; index < 16; index++) {
      made.push(backupStore(w.store.path, undefined, w.clock));
      if (index % 2 === 1) w.clock.advance(1_000);
    }
    const kept = readdirSync(backupDir(w.store.path)).map((name) => join(backupDir(w.store.path), name));
    expect(kept.sort()).toEqual(made.slice(16 - BACKUPS_KEPT).sort());
    expect(latestBackup(w.store.path)).toBe(made.at(-1) ?? "");
  });

  test("maintenance makes one backup a day at 03:00 local time", async () => {
    const w = world();
    const local = new Date(w.clock.now());
    local.setHours(27, 0, 0, 0);
    w.clock.set(local.getTime());
    await w.tick();
    await w.tick(60_000);
    expect(readdirSync(backupDir(w.store.path))).toHaveLength(1);
    expect(w.logs.some((line) => line.startsWith("relay.backup"))).toBe(true);
  });
});
