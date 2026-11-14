import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { inTransaction, type Database } from './db.js';

const MIGRATIONS_DIR = fileURLToPath(new URL('./migrations/', import.meta.url));
const MIGRATION_FILE = /^(\d{3})_[a-z0-9_]+\.sql$/;

interface Migration {
  version: number;
  name: string;
  sql: string;
}

function loadMigrations(): Migration[] {
  return readdirSync(MIGRATIONS_DIR)
    .filter((name) => MIGRATION_FILE.test(name))
    .sort()
    .map((name) => ({
      version: Number(name.slice(0, 3)),
      name,
      sql: readFileSync(`${MIGRATIONS_DIR}${name}`, 'utf8'),
    }));
}

/**
 * Applies every migration in database/migrations that has not run yet, in file order.
 * Returns the names of the migrations applied by this call.
 */
export function migrate(db: Database): string[] {
  db.exec(
    `CREATE TABLE IF NOT EXISTS schema_migrations (
       version    INTEGER PRIMARY KEY,
       name       TEXT NOT NULL,
       applied_at TEXT NOT NULL
     ) STRICT`,
  );

  const appliedRows = db.prepare('SELECT version FROM schema_migrations').all();
  const applied = new Set(appliedRows.map((row) => Number(row.version)));
  const record = db.prepare(
    'INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)',
  );

  const ran: string[] = [];
  for (const migration of loadMigrations()) {
    if (applied.has(migration.version)) continue;
    inTransaction(db, () => {
      db.exec(migration.sql);
      record.run(migration.version, migration.name, new Date().toISOString());
    });
    ran.push(migration.name);
  }
  return ran;
}
