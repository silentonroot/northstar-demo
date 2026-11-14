import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import type { Database } from '../database/db.js';

export const SESSION_COOKIE = 'northstar_sid';

export interface Session {
  accountId: number;
  username: string;
  displayName: string;
  /** Embedded in every form of this session and checked on every state-changing request. */
  csrfToken: string;
  /** Milliseconds since the epoch. */
  expiresAt: number;
}

function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

function randomToken(): string {
  return randomBytes(32).toString('base64url');
}

/**
 * Starts a session and returns the cookie token. The token itself is never stored: the
 * database keeps only its SHA-256, so a copy of the database cannot be replayed as a login.
 */
export function createSession(
  db: Database,
  accountId: number,
  now: number,
  ttlSeconds: number,
): { token: string; expiresAt: number } {
  const token = randomToken();
  const expiresAt = now + ttlSeconds * 1000;
  db.prepare(
    'INSERT INTO sessions (token_hash, account_id, csrf_token, created_at, expires_at) VALUES (?, ?, ?, ?, ?)',
  ).run(hashToken(token), accountId, randomToken(), now, expiresAt);
  return { token, expiresAt };
}

/** Looks up a live session. Expired sessions are deleted and reported as absent. */
export function findSession(db: Database, token: string, now: number): Session | null {
  // Tokens are 43 characters; anything wildly different is not ours, so skip the lookup.
  if (token.length < 20 || token.length > 100) return null;

  const tokenHash = hashToken(token);
  const row = db
    .prepare(
      `SELECT s.account_id, s.csrf_token, s.expires_at, a.username, a.display_name
         FROM sessions s JOIN accounts a ON a.id = s.account_id
        WHERE s.token_hash = ?`,
    )
    .get(tokenHash);
  if (row === undefined) return null;

  const expiresAt = Number(row.expires_at);
  if (expiresAt <= now) {
    db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(tokenHash);
    return null;
  }
  return {
    accountId: Number(row.account_id),
    username: String(row.username),
    displayName: String(row.display_name),
    csrfToken: String(row.csrf_token),
    expiresAt,
  };
}

export function destroySession(db: Database, token: string): void {
  db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(hashToken(token));
}

export function purgeExpiredSessions(db: Database, now: number): void {
  db.prepare('DELETE FROM sessions WHERE expires_at <= ?').run(now);
}

/** Constant-time comparison of a submitted CSRF token with the session's. */
export function csrfTokenMatches(session: Session, submitted: string | undefined): boolean {
  if (submitted === undefined) return false;
  const expected = Buffer.from(session.csrfToken);
  const actual = Buffer.from(submitted);
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}
