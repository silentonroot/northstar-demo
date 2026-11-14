import { randomBytes, scrypt, timingSafeEqual, type ScryptOptions } from 'node:crypto';

/*
 * Stored format: scrypt$<log2 N>$<r>$<p>$<salt, base64url>$<derived key, base64url>
 * The parameters travel with the hash so the cost can be raised later without a migration.
 */

const KEY_LENGTH = 32;
const SALT_LENGTH = 16;
const BLOCK_SIZE = 8;
const PARALLELIZATION = 1;

export const DEFAULT_COST_LOG2 = 15;
const MIN_COST_LOG2 = 10;
const MAX_COST_LOG2 = 18;

function derive(password: string, salt: Buffer, costLog2: number): Promise<Buffer> {
  const options: ScryptOptions = {
    N: 2 ** costLog2,
    r: BLOCK_SIZE,
    p: PARALLELIZATION,
    maxmem: 256 * 2 ** costLog2 * BLOCK_SIZE,
  };
  return new Promise((resolve, reject) => {
    scrypt(password.normalize('NFKC'), salt, KEY_LENGTH, options, (error, key) => {
      if (error) reject(error);
      else resolve(key);
    });
  });
}

export async function hashPassword(
  password: string,
  costLog2: number = DEFAULT_COST_LOG2,
): Promise<string> {
  if (!Number.isInteger(costLog2) || costLog2 < MIN_COST_LOG2 || costLog2 > MAX_COST_LOG2) {
    throw new RangeError(`scrypt cost must be between ${MIN_COST_LOG2} and ${MAX_COST_LOG2}`);
  }
  const salt = randomBytes(SALT_LENGTH);
  const key = await derive(password, salt, costLog2);
  return [
    'scrypt',
    costLog2,
    BLOCK_SIZE,
    PARALLELIZATION,
    salt.toString('base64url'),
    key.toString('base64url'),
  ].join('$');
}

/** Returns false for a wrong password and for any stored value it cannot parse. */
export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const parts = stored.split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false;

  const costLog2 = Number(parts[1]);
  if (!Number.isInteger(costLog2) || costLog2 < MIN_COST_LOG2 || costLog2 > MAX_COST_LOG2) {
    return false;
  }
  if (Number(parts[2]) !== BLOCK_SIZE || Number(parts[3]) !== PARALLELIZATION) return false;

  const salt = Buffer.from(parts[4] ?? '', 'base64url');
  const expected = Buffer.from(parts[5] ?? '', 'base64url');
  if (salt.length !== SALT_LENGTH || expected.length !== KEY_LENGTH) return false;

  const actual = await derive(password, salt, costLog2);
  return timingSafeEqual(actual, expected);
}
