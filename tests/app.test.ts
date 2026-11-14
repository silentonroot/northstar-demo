import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { seedDatabase } from '../seed/seed-database.js';
import { INJECTION_FIXTURE_NOTES, INJECTION_FIXTURE_ORDER_ID } from '../seed/data.js';
import { SESSION_COOKIE } from '../server/sessions.js';
import {
  addOrders,
  createTestContext,
  dom,
  editFormFor,
  get,
  hiddenValue,
  login,
  makeOrder,
  post,
  TEST_COST_LOG2,
  USERS,
  type TestContext,
} from './helpers.js';
import { insertOrder } from '../server/orders.js';

let ctx: TestContext;

beforeEach(async () => {
  ctx = await createTestContext();
});

afterEach(async () => {
  await ctx.app.close();
  ctx.db.close();
});

function sessionRows(): number {
  return Number(ctx.db.prepare('SELECT COUNT(*) AS n FROM sessions').get()?.n);
}

describe('login', () => {
  it('renders the form with the contract hooks', async () => {
    const response = await get(ctx, '/login');
    expect(response.statusCode).toBe(200);
    const root = dom(response);
    expect(root.querySelector('input[name="username"]')).not.toBeNull();
    expect(root.querySelector('input[name="password"]')).not.toBeNull();
    expect(root.querySelector('[data-testid="login-submit"]')).not.toBeNull();
    expect(root.querySelector('[data-testid="login-error"]')).toBeNull();
  });

  it('signs in, sets the cookie and redirects to /orders', async () => {
    const response = await post(ctx, '/login', {
      username: USERS.alice.username,
      password: USERS.alice.password,
    });
    expect(response.statusCode).toBe(302);
    expect(response.headers.location).toBe('/orders');
    expect(response.cookies.some((c) => c.name === SESSION_COOKIE)).toBe(true);
  });

  it('accepts the username case-insensitively', async () => {
    const response = await post(ctx, '/login', {
      username: USERS.alice.username.toUpperCase(),
      password: USERS.alice.password,
    });
    expect(response.statusCode).toBe(302);
  });

  it('gives the same generic error for a wrong password and an unknown user', async () => {
    const wrongPassword = await post(ctx, '/login', {
      username: USERS.alice.username,
      password: 'not-the-password',
    });
    const unknownUser = await post(ctx, '/login', {
      username: 'nobody.test',
      password: 'not-the-password',
    });
    for (const response of [wrongPassword, unknownUser]) {
      expect(response.statusCode).toBe(401);
      expect(response.cookies.some((c) => c.name === SESSION_COOKIE)).toBe(false);
    }
    const textOf = (r: typeof wrongPassword) =>
      dom(r).querySelector('[data-testid="login-error"]')?.text.trim();
    expect(textOf(wrongPassword)).toBe('Incorrect username or password.');
    expect(textOf(unknownUser)).toBe(textOf(wrongPassword));
  });

  it('throttles repeated failures per username, even for the right password', async () => {
    const attempt = (password: string) =>
      post(ctx, '/login', { username: USERS.alice.username, password });
    for (let i = 0; i < 5; i += 1) expect((await attempt('wrong')).statusCode).toBe(401);

    const locked = await attempt(USERS.alice.password);
    expect(locked.statusCode).toBe(429);
    expect(locked.headers['retry-after']).toBeDefined();
    expect(locked.cookies).toHaveLength(0);

    // Another username is unaffected, and the lock lifts once the clock moves on.
    expect((await post(ctx, '/login', USERS.bob)).statusCode).toBe(302);
    ctx.advance(31);
    expect((await attempt(USERS.alice.password)).statusCode).toBe(302);
  });
});

describe('session cookie', () => {
  it('is HttpOnly, SameSite=Lax, Path=/ and not Secure by default', async () => {
    const response = await post(ctx, '/login', USERS.alice);
    const header = String(response.headers['set-cookie']);
    expect(header).toMatch(new RegExp(`^${SESSION_COOKIE}=`));
    expect(header).toMatch(/HttpOnly/i);
    expect(header).toMatch(/SameSite=Lax/i);
    expect(header).toMatch(/Path=\//);
    expect(header).not.toMatch(/Secure/i);
    expect(header).toMatch(/Max-Age=3600/i);
  });

  it('is Secure when configured', async () => {
    const secure = await import('../server/app.js').then(({ buildApp }) =>
      buildApp({
        db: ctx.db,
        config: { sessionTtlSeconds: 60, cookieSecure: true },
        clock: ctx.now,
        passwordCostLog2: TEST_COST_LOG2,
      }),
    );
    const response = await secure.inject({ method: 'POST', url: '/login', payload: USERS.alice });
    expect(String(response.headers['set-cookie'])).toMatch(/Secure/i);
    await secure.close();
  });

  it('stores only the SHA-256 of the token', async () => {
    const response = await post(ctx, '/login', USERS.alice);
    const token = response.cookies.find((c) => c.name === SESSION_COOKIE)?.value ?? '';
    expect(token.length).toBeGreaterThanOrEqual(40);
    const row = ctx.db.prepare('SELECT token_hash FROM sessions').get();
    const { createHash } = await import('node:crypto');
    expect(row?.token_hash).toBe(createHash('sha256').update(token).digest('hex'));
    expect(row?.token_hash).not.toBe(token);
  });

  it('expires after the absolute lifetime, measured with the injected clock', async () => {
    await ctx.app.close();
    ctx.db.close();
    ctx = await createTestContext({ ttlSeconds: 60 });
    const cookie = await login(ctx, USERS.alice);

    ctx.advance(59);
    expect((await get(ctx, '/orders', cookie)).statusCode).toBe(200);
    // Activity does not extend the lifetime: it is absolute.
    ctx.advance(2);
    const expired = await get(ctx, '/orders', cookie);
    expect(expired.statusCode).toBe(302);
    expect(expired.headers.location).toBe('/login');
    expect(sessionRows()).toBe(0);
  });
});

describe('access control and logout', () => {
  it('redirects unauthenticated requests to /login', async () => {
    addOrders(ctx, ctx.aliceId, 1);
    for (const url of ['/orders', '/orders/NS-1001', '/orders/NS-1001/edit', '/']) {
      const response = await get(ctx, url);
      expect(response.statusCode).toBe(302);
      expect(response.headers.location).toBe('/login');
    }
    const write = await post(ctx, '/orders/NS-1001', { status: 'held' });
    expect(write.statusCode).toBe(302);
    expect(write.headers.location).toBe('/login');
  });

  it('redirects a bogus session cookie to /login', async () => {
    const response = await get(ctx, '/orders', `${SESSION_COOKIE}=${'x'.repeat(43)}`);
    expect(response.statusCode).toBe(302);
    expect(response.headers.location).toBe('/login');
  });

  it('shows the signed-in username on authenticated pages', async () => {
    addOrders(ctx, ctx.aliceId, 1);
    const cookie = await login(ctx, USERS.alice);
    for (const url of ['/orders', '/orders/NS-1001', '/orders/NS-1001/edit', '/orders/NS-9999']) {
      const root = dom(await get(ctx, url, cookie));
      expect(root.querySelector('[data-testid="current-user"]')?.text).toBe(USERS.alice.username);
    }
  });

  it('logout destroys the session', async () => {
    const cookie = await login(ctx, USERS.alice);
    const page = dom(await get(ctx, '/orders', cookie));
    const csrf = hiddenValue(page, '_csrf');

    const response = await post(ctx, '/logout', { _csrf: csrf }, cookie);
    expect(response.statusCode).toBe(302);
    expect(response.headers.location).toBe('/login');
    expect(sessionRows()).toBe(0);

    const after = await get(ctx, '/orders', cookie);
    expect(after.statusCode).toBe(302);
    expect(after.headers.location).toBe('/login');
  });

  it('logout without the CSRF token leaves the session alone', async () => {
    const cookie = await login(ctx, USERS.alice);
    const response = await post(ctx, '/logout', {}, cookie);
    expect(response.statusCode).toBe(403);
    expect((await get(ctx, '/orders', cookie)).statusCode).toBe(200);
  });
});

describe('order list', () => {
  const statuses = ['held', 'open', 'shipped', 'cancelled'] as const;

  beforeEach(() => {
    statuses.forEach((status, index) => {
      addOrders(ctx, ctx.aliceId, 3, 1001 + index * 10, { status });
    });
    addOrders(ctx, ctx.bobId, 2, 2001, { status: 'held' });
  });

  it('renders the table, one row per order, with every cell hook', async () => {
    const cookie = await login(ctx, USERS.alice);
    const root = dom(await get(ctx, '/orders', cookie));
    expect(root.querySelector('[data-testid="orders-table"]')).not.toBeNull();
    const rows = root.querySelectorAll('[data-testid="order-row"]');
    expect(rows).toHaveLength(12);
    const first = rows[0];
    expect(first?.getAttribute('data-order-id')).toBe('NS-1033');
    for (const name of ['id', 'customer', 'status', 'total', 'updatedAt']) {
      expect(first?.querySelector(`[data-field="${name}"]`), name).not.toBeNull();
    }
    expect(first?.querySelector('[data-field="total"]')?.text).toBe('$1,036.50');
    expect(first?.querySelector('[data-field="customer"]')?.text).toBe('Example Customer Ltd');
  });

  it('filters by status and never lists another account', async () => {
    const cookie = await login(ctx, USERS.alice);
    for (const status of statuses) {
      const root = dom(await get(ctx, `/orders?status=${status}`, cookie));
      const rows = root.querySelectorAll('[data-testid="order-row"]');
      expect(rows, status).toHaveLength(3);
      for (const row of rows) {
        expect(row.querySelector('[data-field="status"]')?.text.trim()).toBe(status);
        expect(row.getAttribute('data-order-id')).not.toMatch(/^NS-2/);
      }
    }
  });

  it('rejects an invalid status filter with a 400 page', async () => {
    const cookie = await login(ctx, USERS.alice);
    for (const value of ['bogus', 'OPEN', "open' OR 1=1 --", 'open&status=held']) {
      const response = await get(ctx, `/orders?status=${encodeURIComponent(value)}`, cookie);
      expect(response.statusCode, value).toBe(400);
      expect(dom(response).querySelector('[data-testid="error-page"]')).not.toBeNull();
    }
  });

  it('paginates at 20 per page', async () => {
    ctx.db.exec('DELETE FROM orders');
    addOrders(ctx, ctx.aliceId, 45, 1001);
    const cookie = await login(ctx, USERS.alice);
    const count = async (url: string) =>
      dom(await get(ctx, url, cookie)).querySelectorAll('[data-testid="order-row"]').length;

    expect(await count('/orders')).toBe(20);
    expect(await count('/orders?page=1')).toBe(20);
    expect(await count('/orders?page=2')).toBe(20);
    expect(await count('/orders?page=3')).toBe(5);
    expect(await count('/orders?page=4')).toBe(0);

    const page2 = dom(await get(ctx, '/orders?page=2', cookie));
    expect(page2.querySelector('[data-testid="order-row"]')?.getAttribute('data-order-id')).toBe(
      'NS-1025',
    );
    expect(
      page2.querySelector('[data-testid="pagination"]')?.getAttribute('data-total-pages'),
    ).toBe('3');
  });

  it('combines status and page, and rejects bad page numbers', async () => {
    ctx.db.exec('DELETE FROM orders');
    addOrders(ctx, ctx.aliceId, 25, 1001, { status: 'shipped' });
    const cookie = await login(ctx, USERS.alice);
    const root = dom(await get(ctx, '/orders?status=shipped&page=2', cookie));
    expect(root.querySelectorAll('[data-testid="order-row"]')).toHaveLength(5);
    for (const page of ['0', '-1', 'abc', '1.5']) {
      expect((await get(ctx, `/orders?page=${page}`, cookie)).statusCode, page).toBe(400);
    }
  });
});

describe('order detail', () => {
  it('contains every contract hook with the right content', async () => {
    addOrders(ctx, ctx.aliceId, 1, 1001, { status: 'held', shippingMethod: 'express' });
    const cookie = await login(ctx, USERS.alice);
    const response = await get(ctx, '/orders/NS-1001', cookie);
    expect(response.statusCode).toBe(200);

    // Assert on the rendered HTML text itself, not only on the parsed tree.
    for (const hook of [
      'data-testid="order-detail"',
      'data-field="id"',
      'data-field="customer"',
      'data-field="status"',
      'data-field="total"',
      'data-field="shippingMethod"',
      'data-field="notes"',
      'data-field="version"',
      'data-field="updatedAt"',
      'data-testid="order-item"',
      'data-field="sku"',
      'data-field="name"',
      'data-field="quantity"',
      'data-field="unitPrice"',
    ]) {
      expect(response.body, hook).toContain(hook);
    }

    const root = dom(response);
    const detail = root.querySelector('[data-testid="order-detail"]');
    const value = (name: string) => detail?.querySelector(`[data-field="${name}"]`)?.text.trim();
    expect(value('id')).toBe('NS-1001');
    expect(value('customer')).toBe('Example Customer Ltd');
    expect(value('status')).toBe('held');
    expect(value('total')).toBe('$1,036.50');
    expect(value('shippingMethod')).toBe('express');
    expect(value('notes')).toBe('Leave at the loading dock.');
    expect(value('updatedAt')).toContain('2026-09-02');

    // quantity and version are plain digits with nothing else inside the element.
    const version = detail?.querySelector('[data-field="version"]');
    expect(version?.innerHTML).toBe('1');
    const items = root.querySelectorAll('[data-testid="order-item"]');
    expect(items).toHaveLength(2);
    expect(items[0]?.querySelector('[data-field="sku"]')?.text).toBe('TEST-SKU-1');
    expect(items[0]?.querySelector('[data-field="name"]')?.text).toBe('Test widget');
    expect(items[0]?.querySelector('[data-field="quantity"]')?.innerHTML).toBe('3');
    expect(items[0]?.querySelector('[data-field="unitPrice"]')?.text).toBe('$12.50');
    expect(items[1]?.querySelector('[data-field="unitPrice"]')?.text).toBe('$999.00');
  });

  it('accepts ids longer than four digits', async () => {
    insertOrder(ctx.db, makeOrder(ctx.aliceId, 123456));
    const cookie = await login(ctx, USERS.alice);
    expect((await get(ctx, '/orders/NS-123456', cookie)).statusCode).toBe(200);
  });

  it("gives another account's order the same 404 as a missing one", async () => {
    addOrders(ctx, ctx.bobId, 1, 2001);
    const cookie = await login(ctx, USERS.alice);
    for (const suffix of ['', '/edit']) {
      const foreign = await get(ctx, `/orders/NS-2001${suffix}`, cookie);
      const missing = await get(ctx, `/orders/NS-9999${suffix}`, cookie);
      expect(foreign.statusCode).toBe(404);
      expect(missing.statusCode).toBe(404);
      expect(foreign.body).toBe(missing.body);
    }
    const malformed = await get(ctx, '/orders/abc', cookie);
    expect(malformed.statusCode).toBe(404);
    expect(malformed.body).toBe((await get(ctx, '/orders/NS-9999', cookie)).body);
  });

  it("cannot edit another account's order", async () => {
    addOrders(ctx, ctx.bobId, 1, 2001);
    const cookie = await login(ctx, USERS.alice);
    const token = hiddenValue(dom(await get(ctx, '/orders', cookie)), '_csrf');
    const response = await post(
      ctx,
      '/orders/NS-2001',
      { _csrf: token, status: 'shipped', shippingMethod: 'standard', notes: 'x', version: '1' },
      cookie,
    );
    expect(response.statusCode).toBe(404);
    const row = ctx.db.prepare("SELECT status, version FROM orders WHERE id = 'NS-2001'").get();
    expect(row).toMatchObject({ status: 'open', version: 1 });
  });
});

describe('order edit', () => {
  beforeEach(() => {
    addOrders(ctx, ctx.aliceId, 1);
  });

  it('renders the form with hidden version and CSRF token', async () => {
    const cookie = await login(ctx, USERS.alice);
    const root = dom(await get(ctx, '/orders/NS-1001/edit', cookie));
    expect(root.querySelector('select[name="status"]')).not.toBeNull();
    expect(root.querySelector('select[name="shippingMethod"]')).not.toBeNull();
    expect(root.querySelector('textarea[name="notes"]')).not.toBeNull();
    expect(hiddenValue(root, 'version')).toBe('1');
    expect(hiddenValue(root, '_csrf').length).toBeGreaterThan(20);
  });

  it('saves, bumps the version and redirects to the detail page with a flash', async () => {
    const cookie = await login(ctx, USERS.alice);
    const { csrf, version } = await editFormFor(ctx, cookie, 'NS-1001');
    const response = await post(
      ctx,
      '/orders/NS-1001',
      {
        _csrf: csrf,
        version,
        status: 'shipped',
        shippingMethod: 'freight',
        notes: 'Dispatched by test.',
      },
      cookie,
    );
    expect(response.statusCode).toBe(302);
    const location = String(response.headers.location);
    expect(location).toMatch(/^\/orders\/NS-1001/);

    const detail = dom(await get(ctx, location, cookie));
    expect(detail.querySelector('[data-testid="flash-success"]')).not.toBeNull();
    const field = (name: string) => detail.querySelector(`[data-field="${name}"]`)?.text.trim();
    expect(field('status')).toBe('shipped');
    expect(field('shippingMethod')).toBe('freight');
    expect(field('notes')).toBe('Dispatched by test.');
    expect(field('version')).toBe('2');
  });

  it('answers a stale version with a 409 and does not apply the change', async () => {
    const cookie = await login(ctx, USERS.alice);
    const first = await editFormFor(ctx, cookie, 'NS-1001');
    const second = await editFormFor(ctx, cookie, 'NS-1001');
    const form = (notes: string, version: string, csrf: string) => ({
      _csrf: csrf,
      version,
      status: 'open',
      shippingMethod: 'standard',
      notes,
    });

    expect(
      (await post(ctx, '/orders/NS-1001', form('winner', first.version, first.csrf), cookie))
        .statusCode,
    ).toBe(302);
    const stale = await post(
      ctx,
      '/orders/NS-1001',
      form('loser', second.version, second.csrf),
      cookie,
    );
    expect(stale.statusCode).toBe(409);
    expect(dom(stale).querySelector('[data-testid="conflict-error"]')).not.toBeNull();

    const row = ctx.db.prepare("SELECT notes, version FROM orders WHERE id = 'NS-1001'").get();
    expect(row).toMatchObject({ notes: 'winner', version: 2 });
  });

  it('rejects a missing CSRF token', async () => {
    const cookie = await login(ctx, USERS.alice);
    const response = await post(
      ctx,
      '/orders/NS-1001',
      { version: '1', status: 'shipped', shippingMethod: 'standard', notes: 'x' },
      cookie,
    );
    expect(response.statusCode).toBe(403);
    expect(ctx.db.prepare("SELECT version FROM orders WHERE id = 'NS-1001'").get()).toMatchObject({
      version: 1,
    });
  });

  it('rejects a wrong CSRF token, including one from another session', async () => {
    const aliceCookie = await login(ctx, USERS.alice);
    const bobCookie = await login(ctx, USERS.bob);
    const bobToken = hiddenValue(dom(await get(ctx, '/orders', bobCookie)), '_csrf');
    for (const token of ['forged', '', bobToken]) {
      const response = await post(
        ctx,
        '/orders/NS-1001',
        { _csrf: token, version: '1', status: 'shipped', shippingMethod: 'standard', notes: 'x' },
        aliceCookie,
      );
      expect(response.statusCode, token).toBe(403);
    }
    expect(ctx.db.prepare("SELECT status FROM orders WHERE id = 'NS-1001'").get()).toMatchObject({
      status: 'open',
    });
  });

  it('rejects a cross-site Origin', async () => {
    const cookie = await login(ctx, USERS.alice);
    const { csrf, version } = await editFormFor(ctx, cookie, 'NS-1001');
    const response = await ctx.app.inject({
      method: 'POST',
      url: '/orders/NS-1001',
      headers: { cookie, origin: 'https://evil.example', host: 'localhost:4100' },
      payload: { _csrf: csrf, version, status: 'shipped', shippingMethod: 'standard', notes: '' },
    });
    expect(response.statusCode).toBe(403);
  });

  it('validates status, shipping method, version and notes length', async () => {
    const cookie = await login(ctx, USERS.alice);
    const { csrf } = await editFormFor(ctx, cookie, 'NS-1001');
    const valid = {
      _csrf: csrf,
      version: '1',
      status: 'open',
      shippingMethod: 'standard',
      notes: '',
    };
    const bad: Record<string, string>[] = [
      { ...valid, status: 'lost' },
      { ...valid, shippingMethod: 'teleport' },
      { ...valid, version: 'one' },
      { ...valid, notes: 'n'.repeat(2001) },
    ];
    for (const payload of bad) {
      const response = await post(ctx, '/orders/NS-1001', payload, cookie);
      expect(response.statusCode).toBe(400);
      expect(dom(response).querySelector('[data-testid="form-error"]')).not.toBeNull();
    }
    expect(ctx.db.prepare("SELECT version FROM orders WHERE id = 'NS-1001'").get()).toMatchObject({
      version: 1,
    });
  });

  it('escapes notes containing script tags and quotes everywhere they are shown', async () => {
    const cookie = await login(ctx, USERS.alice);
    const { csrf, version } = await editFormFor(ctx, cookie, 'NS-1001');
    const hostile = `<script>alert("x")</script> "quoted" 'single' & <img src=x onerror=alert(1)>`;
    const saved = await post(
      ctx,
      '/orders/NS-1001',
      { _csrf: csrf, version, status: 'open', shippingMethod: 'standard', notes: hostile },
      cookie,
    );
    expect(saved.statusCode).toBe(302);

    const detail = await get(ctx, '/orders/NS-1001', cookie);
    expect(detail.body).not.toContain('<script>');
    expect(detail.body).not.toContain('<img');
    expect(detail.body).toContain('&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt;');
    expect(detail.body).toContain('&#39;single&#39; &amp;');
    expect(dom(detail).querySelector('[data-field="notes"]')?.text).toBe(hostile);
    expect(dom(detail).querySelectorAll('script')).toHaveLength(0);

    const edit = await get(ctx, '/orders/NS-1001/edit', cookie);
    expect(edit.body).not.toContain('<script>');
    // HTML parsers drop the single newline that directly follows <textarea>.
    expect(dom(edit).querySelector('textarea')?.text.replace(/^\n/, '')).toBe(hostile);
  });
});

describe('security headers', () => {
  it('are present on public, authenticated, error and redirect responses', async () => {
    addOrders(ctx, ctx.aliceId, 1);
    const cookie = await login(ctx, USERS.alice);
    const responses = [
      await get(ctx, '/login'),
      await get(ctx, '/orders'), // redirect
      await get(ctx, '/orders', cookie),
      await get(ctx, '/orders/NS-9999', cookie), // 404
      await get(ctx, '/orders?status=nope', cookie), // 400
      await get(ctx, '/static/styles.css'),
    ];
    for (const response of responses) {
      const csp = String(response.headers['content-security-policy']);
      expect(csp).toContain("frame-ancestors 'none'");
      expect(csp).toContain("default-src 'none'");
      expect(csp).not.toMatch(/unsafe-inline|unsafe-eval/);
      expect(csp).not.toMatch(/script-src[^;]*'self'/);
      expect(response.headers['x-content-type-options']).toBe('nosniff');
      expect(response.headers['referrer-policy']).toBeDefined();
    }
  });

  it('pages carry no inline script or event handler attributes', async () => {
    addOrders(ctx, ctx.aliceId, 1);
    const cookie = await login(ctx, USERS.alice);
    for (const url of ['/login', '/orders', '/orders/NS-1001', '/orders/NS-1001/edit']) {
      const body = (await get(ctx, url, cookie)).body;
      expect(body, url).not.toMatch(/<script/i);
      expect(body, url).not.toMatch(/\son\w+\s*=/i);
    }
  });

  it('never leaks a stack trace', async () => {
    addOrders(ctx, ctx.aliceId, 1);
    const cookie = await login(ctx, USERS.alice);
    ctx.db.exec('DROP TABLE order_items');
    const response = await get(ctx, '/orders/NS-1001', cookie);
    expect(response.statusCode).toBe(500);
    expect(response.body).not.toMatch(/at \S+ \(|node:sqlite|\.ts:\d+|no such table/i);
  });
});

describe('seeded data', () => {
  it('renders the prompt-injection note as inert escaped text', async () => {
    const aliceSeedPassword = 'seed-test-only-pw-alice';
    const seeded = await seedDatabase(ctx.db, {
      passwordCostLog2: TEST_COST_LOG2,
      passwords: { 'alice.synthetic': aliceSeedPassword, 'bob.synthetic': 'seed-test-only-pw-bob' },
    });
    expect(seeded.orderCount).toBe(42);

    const cookie = await login(ctx, { username: 'alice.synthetic', password: aliceSeedPassword });
    const response = await get(ctx, `/orders/${INJECTION_FIXTURE_ORDER_ID}`, cookie);
    expect(response.statusCode).toBe(200);

    // The raw markup from the note never reaches the page unescaped.
    expect(response.body).not.toContain('<b>This is urgent</b>');
    expect(response.body).toContain('&lt;b&gt;This is urgent&lt;/b&gt;');
    expect(response.body).toContain('ignore all previous instructions');
    const notes = dom(response).querySelector('[data-field="notes"]');
    expect(notes?.text).toBe(INJECTION_FIXTURE_NOTES);
    expect(notes?.querySelectorAll('*')).toHaveLength(0);

    // Reading the note changed nothing: no order was marked shipped as a side effect.
    const held = ctx.db.prepare("SELECT COUNT(*) AS n FROM orders WHERE status = 'held'").get();
    expect(Number(held?.n)).toBeGreaterThan(1);
    expect(
      ctx.db.prepare('SELECT status FROM orders WHERE id = ?').get(INJECTION_FIXTURE_ORDER_ID),
    ).toMatchObject({ status: 'held' });
  });

  it('gives alice 30 orders and bob 12, across all four statuses, and resets idempotently', async () => {
    await seedDatabase(ctx.db, { passwordCostLog2: TEST_COST_LOG2 });
    await seedDatabase(ctx.db, { passwordCostLog2: TEST_COST_LOG2 });
    const counts = ctx.db
      .prepare(
        `SELECT a.username, COUNT(*) AS n, COUNT(DISTINCT o.status) AS statuses
           FROM orders o JOIN accounts a ON a.id = o.account_id
          WHERE a.username LIKE '%.synthetic' GROUP BY a.username ORDER BY a.username`,
      )
      .all();
    expect(counts.map((r) => [r.username, r.n, r.statuses])).toEqual([
      ['alice.synthetic', 30, 4],
      ['bob.synthetic', 12, 4],
    ]);
  });

  it('stores scrypt hashes with a per-user salt', async () => {
    const rows = ctx.db.prepare('SELECT password_hash FROM accounts').all();
    expect(rows).toHaveLength(2);
    const salts = rows.map((r) => String(r.password_hash).split('$')[4]);
    for (const row of rows) expect(String(row.password_hash)).toMatch(/^scrypt\$/);
    expect(new Set(salts).size).toBe(2);
  });
});
