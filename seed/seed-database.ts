import { randomBytes } from 'node:crypto';
import type { Database } from '../database/db.js';
import { createAccount } from '../server/accounts.js';
import { insertOrder } from '../server/orders.js';
import { buildSeedOrders, SEED_ACCOUNTS, type SeedUsername } from './data.js';

export interface SeedResult {
  /** The passwords exist only in this return value and, hashed, in the database. */
  accounts: { username: SeedUsername; password: string }[];
  orderCount: number;
}

const ACCOUNTS_CREATED_AT = '2026-08-15T09:00:00.000Z';

/**
 * Resets the database to the demo data set: removes every account, session and order, then
 * recreates them. Safe to run repeatedly. Each account gets a new random password unless the
 * caller supplies one (tests do).
 */
export async function seedDatabase(
  db: Database,
  options: { passwords?: Partial<Record<SeedUsername, string>>; passwordCostLog2?: number } = {},
): Promise<SeedResult> {
  // Deleting accounts cascades to their sessions, orders and order items.
  db.exec('DELETE FROM accounts');

  const accounts: SeedResult['accounts'] = [];
  const accountIds = new Map<SeedUsername, number>();
  for (const { username, displayName } of SEED_ACCOUNTS) {
    const password = options.passwords?.[username] ?? randomBytes(15).toString('base64url');
    const account = await createAccount(
      db,
      { username, displayName, password, createdAt: ACCOUNTS_CREATED_AT },
      options.passwordCostLog2,
    );
    accountIds.set(username, account.id);
    accounts.push({ username, password });
  }

  const orders = buildSeedOrders();
  for (const { owner, ...order } of orders) {
    const accountId = accountIds.get(owner);
    if (accountId === undefined) throw new Error(`seed order ${order.id} has no owner account`);
    insertOrder(db, { ...order, accountId });
  }
  return { accounts, orderCount: orders.length };
}
