/**
 * Backup and restore of the relay store (design section 10.4).
 *
 * A backup is a `VACUUM INTO` copy, which is consistent while the relay runs.
 * Ferry checks each copy with `PRAGMA integrity_check`. The default target is
 * `backups/relay-<UTC time>.db` next to the store, and Ferry keeps the newest 14
 * there. A backup has mode 0600 and holds no GitHub App key.
 */

import { Database } from "bun:sqlite";
import { chmodSync, closeSync, copyFileSync, existsSync, openSync, readdirSync, renameSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { SCHEMA_VERSION, schemaVersion } from "./migrate.ts";
import { acquireRelayLock, ensurePrivateDir, systemClock, type Clock } from "./store.ts";

export const BACKUPS_KEPT = 14;

export function backupDir(path: string): string {
  return join(dirname(path), "backups");
}

function stamp(at: number): string {
  return new Date(at).toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
}

/**
 * Copy the store at `path` to `target`, or to a new file in `backups/`. The
 * target must not exist. Returns the path of the copy.
 */
export function backupStore(path: string, target?: string, clock: Clock = systemClock): string {
  if (!existsSync(path)) throw new Error(`The relay store ${path} does not exist.`);
  const automatic = target === undefined;
  const dir = backupDir(path);
  if (automatic) ensurePrivateDir(dir);
  let file = target ?? join(dir, `relay-${stamp(clock.now())}.db`);
  for (let index = 1; automatic && existsSync(file); index++) file = join(dir, `relay-${stamp(clock.now())}-${index}.db`);
  // VACUUM INTO takes an empty file. Make it first with mode 0600, so the copy is never readable by others.
  closeSync(openSync(file, "wx", 0o600));
  try {
    const db = new Database(path, { readonly: true });
    try {
      db.query("VACUUM INTO ?").run(file);
    } finally {
      db.close();
    }
    chmodSync(file, 0o600);
    checkIntegrity(file);
  } catch (error) {
    rmSync(file, { force: true });
    throw error;
  }
  if (automatic) pruneBackups(dir);
  return file;
}

/** Remove all but the newest `keep` backups in `dir`. */
export function pruneBackups(dir: string, keep = BACKUPS_KEPT): void {
  const files = readdirSync(dir).filter((name) => /^relay-\d{8}T\d{6}Z(-\d+)?\.db$/.test(name)).sort();
  for (const name of files.slice(0, Math.max(0, files.length - keep))) rmSync(join(dir, name), { force: true });
}

/** The newest backup in the backup directory of `path`, or null. */
export function latestBackup(path: string): string | null {
  const dir = backupDir(path);
  if (!existsSync(dir)) return null;
  const files = readdirSync(dir).filter((name) => /^relay-\d{8}T\d{6}Z(-\d+)?\.db$/.test(name)).sort();
  const last = files.at(-1);
  return last === undefined ? null : join(dir, last);
}

/** Throw when `file` is not a sound SQLite file. Returns its schema version. */
export function checkIntegrity(file: string): number {
  const db = new Database(file, { readonly: true });
  try {
    const rows = db.query<{ integrity_check: string }, []>("PRAGMA integrity_check").all();
    if (rows.length !== 1 || rows[0]?.integrity_check !== "ok") {
      throw new Error(`The integrity check of ${file} failed: ${rows.map((row) => row.integrity_check).join("; ")}`);
    }
    return schemaVersion(db);
  } finally {
    db.close();
  }
}

/**
 * Put the backup `file` in place of the store at `path`. The relay must not run.
 * Ferry checks the backup, moves the current store to
 * `relay.db.before-restore-<time>`, and copies the backup in place. Returns the
 * path of the moved store, or null when there was none.
 */
export function restoreStore(file: string, path: string, clock: Clock = systemClock): string | null {
  const version = checkIntegrity(file);
  if (version === 0) throw new Error(`${file} is not a relay store.`);
  if (version > SCHEMA_VERSION) {
    throw new Error(`${file} has schema version ${version}. This Ferry knows version ${SCHEMA_VERSION} at most. Update Ferry.`);
  }
  const release = acquireRelayLock(dirname(path));
  if (release === null) throw new Error("The relay runs. Stop the relay service, then restore.");
  try {
    let previous: string | null = null;
    if (existsSync(path)) {
      previous = `${path}.before-restore-${stamp(clock.now())}`;
      renameSync(path, previous);
      for (const suffix of ["-wal", "-shm"]) if (existsSync(path + suffix)) renameSync(path + suffix, previous + suffix);
    }
    copyFileSync(file, path);
    chmodSync(path, 0o600);
    return previous;
  } finally {
    release();
  }
}
