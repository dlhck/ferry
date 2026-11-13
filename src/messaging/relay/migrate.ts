/**
 * The schema migrations of the relay store (design section 10.1).
 *
 * `MIGRATIONS[i]` moves the store from schema version `i` to `i + 1`. All
 * migrations run in one transaction. Before the migration of a store that has
 * data, the relay makes a backup in `backups/`.
 */

import type { Database } from "bun:sqlite";
import { backupStore } from "./backup.ts";
import schemaV1 from "./schema.sql" with { type: "text" };
import type { Clock } from "./store.ts";

const MIGRATIONS: readonly string[] = [schemaV1];

export const SCHEMA_VERSION = MIGRATIONS.length;

export function schemaVersion(db: Database): number {
  return db.query<{ user_version: number }, []>("PRAGMA user_version").get()?.user_version ?? 0;
}

/**
 * Bring the store at `path` to `SCHEMA_VERSION`. Refuses a store of a newer
 * Ferry. Returns the path of the backup, or null when it made none.
 */
export function migrate(db: Database, path: string, clock: Clock): string | null {
  const version = schemaVersion(db);
  if (version > SCHEMA_VERSION) {
    throw new Error(`The relay store ${path} has schema version ${version}. This Ferry knows version ${SCHEMA_VERSION} at most. Update Ferry.`);
  }
  if (version === SCHEMA_VERSION) return null;
  const backup = version > 0 ? backupStore(path, undefined, clock) : null;
  db.transaction(() => {
    for (let index = version; index < SCHEMA_VERSION; index++) db.run(MIGRATIONS[index] ?? "");
    db.run(`PRAGMA user_version = ${SCHEMA_VERSION}`);
  }).immediate();
  return backup;
}
