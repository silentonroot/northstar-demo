import type { FastifyInstance, LightMyRequestResponse } from 'fastify';
import { parse, type HTMLElement } from 'node-html-parser';
import { openDatabase, type Database } from '../database/db.js';
import { migrate } from '../database/migrate.js';
import { buildApp } from '../server/app.js';
import { createAccount } from '../server/accounts.js';
import { insertOrder, type NewOrder, type OrderItem } from '../server/orders.js';
import type { ThrottleOptions } from '../server/login-throttle.js';
import { SESSION_COOKIE } from '../server/sessions.js';

/** Minimum scrypt cost the password module accepts; keeps the suite fast. */
export const TEST_COST_LOG2 = 10;
export const START_TIME = Date.parse('2026-10-01T12:00:00.000Z');

/** Test-only credentials. They exist nowhere outside this test suite. */
export const USERS = {
  alice: { username: 'alice.test', password: 'alice-test-only-pw-1' },
  bob: { username: 'bob.test', password: 'bob-test-only-pw-2' },
} as const;

export interface TestContext {
  app: FastifyInstance;
  db: Database;
  aliceId: number;
  bobId: number;
  /** Advances the injected clock; nothing in the suite sleeps. */
  advance: (seconds: number) => void;
  now: () => number;
}

export async function createTestContext(
  options: { ttlSeconds?: number; throttle?: ThrottleOptions } = {},
): Promise<TestContext> {
  const db = openDatabase(':memory:');
  migrate(db);
  let current = START_TIME;
  const now = () => current;

  const createdAt = new Date(START_TIME).toISOString();
  const alice = await createAccount(
    db,
    { ...USERS.alice, displayName: 'Alice Test', createdAt },
    TEST_COST_LOG2,
  );
  const bob = await createAccount(
    db,
    { ...USERS.bob, displayName: 'Bob Test', createdAt },
    TEST_COST_LOG2,
  );

  const app = await buildApp({
    db,
    config: { sessionTtlSeconds: options.ttlSeconds ?? 3600, cookieSecure: false },
    clock: now,
    passwordCostLog2: TEST_COST_LOG2,
    ...(options.throttle === undefined ? {} : { throttle: options.throttle }),
  });
  return {
    app,
    db,
    aliceId: alice.id,
    bobId: bob.id,
    advance: (seconds) => {
      current += seconds * 1000;
    },
    now,
  };
}

export function makeOrder(
  accountId: number,
  number: number,
  overrides: Partial<NewOrder> = {},
): NewOrder {
  const items: OrderItem[] = [
    { sku: 'TEST-SKU-1', name: 'Test widget', quantity: 3, unitPriceCents: 1250 },
    { sku: 'TEST-SKU-2', name: 'Test gadget', quantity: 1, unitPriceCents: 99_900 },
  ];
  return {
    id: `NS-${number}`,
    accountId,
    customer: 'Example Customer Ltd',
    status: 'open',
    shippingMethod: 'standard',
    notes: 'Leave at the loading dock.',
    createdAt: '2026-09-01T08:00:00.000Z',
    updatedAt: '2026-09-02T09:30:00.000Z',
    items,
    ...overrides,
  };
}

export function addOrders(
  ctx: TestContext,
  accountId: number,
  count: number,
  first = 1001,
  overrides: Partial<NewOrder> = {},
): void {
  for (let i = 0; i < count; i += 1)
    insertOrder(ctx.db, makeOrder(accountId, first + i, overrides));
}

export async function login(
  ctx: TestContext,
  user: { username: string; password: string },
): Promise<string> {
  const response = await ctx.app.inject({
    method: 'POST',
    url: '/login',
    payload: { username: user.username, password: user.password },
  });
  if (response.statusCode !== 302) throw new Error(`login failed with ${response.statusCode}`);
  const cookie = response.cookies.find((c) => c.name === SESSION_COOKIE);
  if (cookie === undefined) throw new Error('no session cookie issued');
  return `${SESSION_COOKIE}=${cookie.value}`;
}

export function get(
  ctx: TestContext,
  url: string,
  cookie?: string,
): Promise<LightMyRequestResponse> {
  return ctx.app.inject({
    method: 'GET',
    url,
    ...(cookie === undefined ? {} : { headers: { cookie } }),
  });
}

export function post(
  ctx: TestContext,
  url: string,
  payload: Record<string, string>,
  cookie?: string,
): Promise<LightMyRequestResponse> {
  return ctx.app.inject({
    method: 'POST',
    url,
    payload,
    ...(cookie === undefined ? {} : { headers: { cookie } }),
  });
}

export function dom(response: LightMyRequestResponse): HTMLElement {
  return parse(response.body);
}

export function hiddenValue(root: HTMLElement, name: string): string {
  const input = root.querySelector(`input[type="hidden"][name="${name}"]`);
  const value = input?.getAttribute('value');
  if (value === undefined) throw new Error(`no hidden input named ${name}`);
  return value;
}

/** Loads the edit form and returns its CSRF token and version. */
export async function editFormFor(
  ctx: TestContext,
  cookie: string,
  orderId: string,
): Promise<{ csrf: string; version: string }> {
  const response = await get(ctx, `/orders/${orderId}/edit`, cookie);
  const root = dom(response);
  return { csrf: hiddenValue(root, '_csrf'), version: hiddenValue(root, 'version') };
}
