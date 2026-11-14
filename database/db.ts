import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

export type Database = DatabaseSync;

export const IN_MEMORY = ':memory:';

/** Opens (and if needed creates) the SQLite database. Use ':memory:' for tests. */
export function openDatabase(path: string): Database {
  if (path !== IN_MEMORY) {
    mkdirSync(dirname(resolve(path)), { recursive: true, mode: 0o700 });
  }
  const db = new DatabaseSync(path);
  db.exec('PRAGMA foreign_keys = ON');
  if (path !== IN_MEMORY) {
    db.exec('PRAGMA journal_mode = WAL');
    db.exec('PRAGMA busy_timeout = 5000');
  }
  return db;
}

/** Runs `work` in one transaction, rolling back if it throws. */
export function inTransaction<T>(db: Database, work: () => T): T {
  db.exec('BEGIN IMMEDIATE');
  try {
    const result = work();
    db.exec('COMMIT');
    return result;
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}
