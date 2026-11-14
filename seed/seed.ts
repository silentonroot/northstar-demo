import { openDatabase } from '../database/db.js';
import { migrate } from '../database/migrate.js';
import { loadConfig } from '../server/config.js';
import { seedDatabase } from './seed-database.js';

/*
 * Resets the local database to the demo data set and prints a freshly generated password for
 * each account. The passwords are shown here once and stored nowhere else in readable form;
 * run the command again to replace them.
 */
const config = loadConfig();
const db = openDatabase(config.dbPath);
migrate(db);
const result = await seedDatabase(db);
db.close();

console.log(`Seeded ${result.orderCount} orders into ${config.dbPath}.`);
console.log('Demo accounts (passwords are regenerated on every seed and not saved anywhere):');
for (const account of result.accounts) {
  console.log(`  ${account.username}  ${account.password}`);
}
