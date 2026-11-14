import { randomUUID } from 'node:crypto';
import type { Database } from '../database/db.js';
import { hashPassword, verifyPassword } from './passwords.js';

export interface Account {
  id: number;
  username: string;
  displayName: string;
}

export const USERNAME_MAX_LENGTH = 64;
export const PASSWORD_MAX_LENGTH = 256;
const USERNAME_PATTERN = /^[a-z0-9][a-z0-9._-]{1,63}$/;

/** Usernames are case-insensitive; this is the form stored and compared. */
export function normalizeUsername(raw: string): string {
  return raw.trim().toLowerCase();
}

export async function createAccount(
  db: Database,
  input: { username: string; displayName: string; password: string; createdAt: string },
  passwordCostLog2?: number,
): Promise<Account> {
  const username = normalizeUsername(input.username);
  if (!USERNAME_PATTERN.test(username)) {
    throw new Error('username must be 2-64 characters: letters, digits, dot, dash or underscore');
  }
  const passwordHash = await hashPassword(input.password, passwordCostLog2);
  const result = db
    .prepare(
      'INSERT INTO accounts (username, display_name, password_hash, created_at) VALUES (?, ?, ?, ?)',
    )
    .run(username, input.displayName, passwordHash, input.createdAt);
  return { id: Number(result.lastInsertRowid), username, displayName: input.displayName };
}

/**
 * A real hash of a random throwaway password. Unknown usernames are verified against it so a
 * failed sign-in costs the same whether or not the account exists.
 */
let decoyHash: Promise<string> | undefined;
function getDecoyHash(costLog2?: number): Promise<string> {
  decoyHash ??= hashPassword(randomUUID(), costLog2);
  return decoyHash;
}

/** Returns the account when the credentials are right, otherwise null. Never says which part failed. */
export async function authenticate(
  db: Database,
  rawUsername: string,
  password: string,
  passwordCostLog2?: number,
): Promise<Account | null> {
  const username = normalizeUsername(rawUsername);
  const tooLong = username.length > USERNAME_MAX_LENGTH || password.length > PASSWORD_MAX_LENGTH;

  const row = tooLong
    ? undefined
    : db
        .prepare(
          'SELECT id, username, display_name, password_hash FROM accounts WHERE username = ?',
        )
        .get(username);

  if (row === undefined) {
    await verifyPassword(
      password.slice(0, PASSWORD_MAX_LENGTH),
      await getDecoyHash(passwordCostLog2),
    );
    return null;
  }

  const matches = await verifyPassword(password, String(row.password_hash));
  if (!matches) return null;
  return {
    id: Number(row.id),
    username: String(row.username),
    displayName: String(row.display_name),
  };
}
