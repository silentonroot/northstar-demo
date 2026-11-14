import { openDatabase } from '../database/db.js';
import { migrate } from '../database/migrate.js';
import { buildApp } from './app.js';
import { loadConfig } from './config.js';

const config = loadConfig();
const db = openDatabase(config.dbPath);
const applied = migrate(db);

const app = await buildApp({ db, config, logLevel: config.logLevel });
if (applied.length > 0) {
  app.log.info({ migrations: applied }, 'applied database migrations');
}

const accounts = db.prepare('SELECT COUNT(*) AS n FROM accounts').get();
if (Number(accounts?.n ?? 0) === 0) {
  app.log.warn('no accounts exist yet; run "pnpm run seed" to create the demo accounts');
}

let stopping = false;
async function stop(signal: string): Promise<void> {
  if (stopping) return;
  stopping = true;
  app.log.info({ signal }, 'shutting down');
  await app.close();
  db.close();
}
process.on('SIGINT', () => void stop('SIGINT'));
process.on('SIGTERM', () => void stop('SIGTERM'));

await app.listen({ host: config.host, port: config.port });
