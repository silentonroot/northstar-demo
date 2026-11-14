import { readFileSync } from 'node:fs';
import cookie from '@fastify/cookie';
import formbody from '@fastify/formbody';
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify';
import type { Database } from '../database/db.js';
import {
  conflictPage,
  errorPage,
  loginPage,
  orderDetailPage,
  orderEditPage,
  ordersPage,
} from '../web/templates.js';
import { authenticate, normalizeUsername, USERNAME_MAX_LENGTH } from './accounts.js';
import type { Config } from './config.js';
import { LoginThrottle, type ThrottleOptions } from './login-throttle.js';
import {
  getOrder,
  isOrderStatus,
  isShippingMethod,
  listOrders,
  NOTES_MAX_LENGTH,
  updateOrder,
  type OrderStatus,
} from './orders.js';
import {
  createSession,
  csrfTokenMatches,
  destroySession,
  findSession,
  purgeExpiredSessions,
  SESSION_COOKIE,
  type Session,
} from './sessions.js';

declare module 'fastify' {
  interface FastifyRequest {
    /** The signed-in session, or null. Set for every request before routing decisions. */
    session: Session | null;
  }
  interface FastifyContextConfig {
    /** Routes reachable without signing in. Everything else redirects to /login. */
    public?: boolean;
  }
}

export interface AppOptions {
  db: Database;
  config: Pick<Config, 'sessionTtlSeconds' | 'cookieSecure'>;
  /** Milliseconds since the epoch. Tests inject a controllable clock. */
  clock?: () => number;
  logLevel?: string;
  /** scrypt cost for the timing decoy; tests lower it to stay fast. */
  passwordCostLog2?: number;
  throttle?: ThrottleOptions;
}

const STYLESHEET = readFileSync(new URL('../web/styles.css', import.meta.url), 'utf8');

const SECURITY_HEADERS = {
  // No script source is allowed at all: the app ships no JavaScript, so injected markup that
  // slipped past escaping still could not run.
  'content-security-policy':
    "default-src 'none'; style-src 'self'; img-src 'self'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'",
  'x-content-type-options': 'nosniff',
  'x-frame-options': 'DENY',
  // same-origin (not no-referrer) so browsers still send a real Origin header on our own forms.
  'referrer-policy': 'same-origin',
  'cross-origin-opener-policy': 'same-origin',
  'cache-control': 'no-store',
} as const;

const BAD_CREDENTIALS = 'Incorrect username or password.';
const TOO_MANY_ATTEMPTS = 'Too many sign-in attempts. Wait a few minutes and try again.';
const NOT_FOUND = 'The page or order you asked for does not exist.';

/** Reads one text field from a parsed form body; repeated or missing fields count as absent. */
function field(body: unknown, name: string): string | undefined {
  if (typeof body !== 'object' || body === null) return undefined;
  const value = (body as Record<string, unknown>)[name];
  return typeof value === 'string' ? value : undefined;
}

function queryValue(query: unknown, name: string): string | undefined {
  return field(query, name);
}

function sendHtml(reply: FastifyReply, status: number, page: string): FastifyReply {
  return reply.code(status).type('text/html; charset=utf-8').send(page);
}

function sessionOf(request: FastifyRequest): Session {
  if (request.session === null) {
    throw new Error('route requires a session but none is attached');
  }
  return request.session;
}

function sameOrigin(request: FastifyRequest): boolean {
  const origin = request.headers.origin;
  // Non-browser clients send no Origin header; they still need the session's CSRF token.
  if (origin === undefined) return true;
  try {
    return new URL(origin).host === request.headers.host;
  } catch {
    return false;
  }
}

export async function buildApp(options: AppOptions): Promise<FastifyInstance> {
  const { db, config } = options;
  const clock = options.clock ?? Date.now;
  const logLevel = options.logLevel ?? 'silent';
  const throttle = new LoginThrottle(clock, options.throttle);

  const app = Fastify({
    logger: logLevel === 'silent' ? false : { level: logLevel },
    bodyLimit: 64 * 1024,
  });

  // Awaited so the cookie parser's hook is installed before the session hook below.
  await app.register(cookie);
  await app.register(formbody);
  app.decorateRequest('session', null);

  const cookieOptions = {
    path: '/',
    httpOnly: true,
    sameSite: 'lax',
    secure: config.cookieSecure,
  } as const;

  app.addHook('onRequest', async (request, reply) => {
    reply.headers(SECURITY_HEADERS);

    const token = request.cookies[SESSION_COOKIE];
    request.session = token === undefined ? null : findSession(db, token, clock());

    if (request.method === 'POST' && !sameOrigin(request)) {
      return sendHtml(
        reply,
        403,
        errorPage({
          session: request.session,
          status: 403,
          message: 'This form was submitted from another site.',
        }),
      );
    }

    const isPublic = request.routeOptions.config?.public === true;
    if (request.session === null && !isPublic) {
      if (token !== undefined) reply.clearCookie(SESSION_COOKIE, cookieOptions);
      return reply.redirect('/login', 302);
    }
    return undefined;
  });

  app.setNotFoundHandler((request, reply) =>
    sendHtml(reply, 404, errorPage({ session: request.session, status: 404, message: NOT_FOUND })),
  );

  app.setErrorHandler((error: { statusCode?: number }, request, reply) => {
    const status = error.statusCode;
    if (status !== undefined && status >= 400 && status < 500) {
      return sendHtml(
        reply,
        status,
        errorPage({
          session: request.session,
          status: 400,
          message: 'The request was malformed or too large.',
        }),
      );
    }
    request.log.error({ err: error }, 'request failed');
    // The session may be what failed to load, so the error page is rendered signed-out.
    return sendHtml(
      reply,
      500,
      errorPage({
        session: null,
        status: 500,
        message: 'The problem has been logged. Please try again in a moment.',
      }),
    );
  });

  const notFound = (request: FastifyRequest, reply: FastifyReply) =>
    sendHtml(reply, 404, errorPage({ session: request.session, status: 404, message: NOT_FOUND }));

  const badRequest = (request: FastifyRequest, reply: FastifyReply, message: string) =>
    sendHtml(reply, 400, errorPage({ session: request.session, status: 400, message }));

  const forbidden = (request: FastifyRequest, reply: FastifyReply) =>
    sendHtml(
      reply,
      403,
      errorPage({
        session: request.session,
        status: 403,
        message: 'Your form has expired or was not sent from this site. Go back, reload and retry.',
      }),
    );

  app.get('/healthz', { config: { public: true } }, (_request, reply) =>
    reply.type('text/plain; charset=utf-8').send('ok'),
  );

  app.get('/static/styles.css', { config: { public: true } }, (_request, reply) =>
    reply
      .header('cache-control', 'public, max-age=300')
      .type('text/css; charset=utf-8')
      .send(STYLESHEET),
  );

  app.get('/', (_request, reply) => reply.redirect('/orders', 302));

  app.get('/login', { config: { public: true } }, (request, reply) => {
    if (request.session !== null) return reply.redirect('/orders', 302);
    return sendHtml(reply, 200, loginPage({}));
  });

  app.post('/login', { config: { public: true } }, async (request, reply) => {
    const username = (field(request.body, 'username') ?? '').slice(0, USERNAME_MAX_LENGTH);
    const password = field(request.body, 'password') ?? '';
    const throttleKey = normalizeUsername(username);

    const retryAfter = throttle.retryAfterSeconds(throttleKey);
    if (retryAfter > 0) {
      reply.header('retry-after', String(retryAfter));
      return sendHtml(reply, 429, loginPage({ error: TOO_MANY_ATTEMPTS, username }));
    }

    const account = await authenticate(db, username, password, options.passwordCostLog2);
    if (account === null) {
      throttle.recordFailure(throttleKey);
      return sendHtml(reply, 401, loginPage({ error: BAD_CREDENTIALS, username }));
    }
    throttle.recordSuccess(throttleKey);

    // Always issue a fresh token on sign-in; never keep one that existed before authentication.
    const previous = request.cookies[SESSION_COOKIE];
    if (previous !== undefined) destroySession(db, previous);
    const now = clock();
    purgeExpiredSessions(db, now);
    const session = createSession(db, account.id, now, config.sessionTtlSeconds);
    reply.setCookie(SESSION_COOKIE, session.token, {
      ...cookieOptions,
      maxAge: config.sessionTtlSeconds,
    });
    return reply.redirect('/orders', 302);
  });

  app.post('/logout', (request, reply) => {
    if (!csrfTokenMatches(sessionOf(request), field(request.body, '_csrf'))) {
      return forbidden(request, reply);
    }
    const token = request.cookies[SESSION_COOKIE];
    if (token !== undefined) destroySession(db, token);
    reply.clearCookie(SESSION_COOKIE, cookieOptions);
    return reply.redirect('/login', 302);
  });

  app.get('/orders', (request, reply) => {
    const session = sessionOf(request);

    const rawStatus = queryValue(request.query, 'status');
    let status: OrderStatus | undefined;
    if (rawStatus !== undefined && rawStatus !== '') {
      if (!isOrderStatus(rawStatus)) {
        return badRequest(request, reply, 'Unknown order status filter.');
      }
      status = rawStatus;
    }

    const rawPage = queryValue(request.query, 'page');
    let page = 1;
    if (rawPage !== undefined && rawPage !== '') {
      if (!/^[1-9]\d{0,5}$/.test(rawPage)) {
        return badRequest(request, reply, 'The page number must be a positive whole number.');
      }
      page = Number(rawPage);
    }

    const result = listOrders(
      db,
      session.accountId,
      status === undefined ? { page } : { status, page },
    );
    return sendHtml(reply, 200, ordersPage({ session, result, status }));
  });

  app.get<{ Params: { id: string } }>('/orders/:id', (request, reply) => {
    const session = sessionOf(request);
    const order = getOrder(db, session.accountId, request.params.id);
    if (order === null) return notFound(request, reply);
    const updated = queryValue(request.query, 'updated') === '1';
    return sendHtml(reply, 200, orderDetailPage({ session, order, updated }));
  });

  app.get<{ Params: { id: string } }>('/orders/:id/edit', (request, reply) => {
    const session = sessionOf(request);
    const order = getOrder(db, session.accountId, request.params.id);
    if (order === null) return notFound(request, reply);
    return sendHtml(
      reply,
      200,
      orderEditPage({
        session,
        orderId: order.id,
        values: {
          status: order.status,
          shippingMethod: order.shippingMethod,
          notes: order.notes,
          version: String(order.version),
        },
      }),
    );
  });

  app.post<{ Params: { id: string } }>('/orders/:id', (request, reply) => {
    const session = sessionOf(request);
    if (!csrfTokenMatches(session, field(request.body, '_csrf'))) {
      return forbidden(request, reply);
    }

    const order = getOrder(db, session.accountId, request.params.id);
    if (order === null) return notFound(request, reply);

    const status = field(request.body, 'status') ?? '';
    const shippingMethod = field(request.body, 'shippingMethod') ?? '';
    // Browsers submit textarea line breaks as CRLF; store them as LF.
    const notes = (field(request.body, 'notes') ?? '').replace(/\r\n?/g, '\n').trimEnd();
    const rawVersion = field(request.body, 'version') ?? '';

    const errors: string[] = [];
    if (!isOrderStatus(status)) errors.push('Choose a valid status.');
    if (!isShippingMethod(shippingMethod)) errors.push('Choose a valid shipping method.');
    if (notes.length > NOTES_MAX_LENGTH) {
      errors.push(`Notes can be at most ${NOTES_MAX_LENGTH} characters.`);
    }
    const versionIsValid = /^[1-9]\d{0,8}$/.test(rawVersion);
    if (!versionIsValid) errors.push('The form is out of date. Reload the order and try again.');

    if (!isOrderStatus(status) || !isShippingMethod(shippingMethod) || errors.length > 0) {
      return sendHtml(
        reply,
        400,
        orderEditPage({
          session,
          orderId: order.id,
          values: {
            status,
            shippingMethod,
            notes: notes.slice(0, NOTES_MAX_LENGTH),
            version: versionIsValid ? rawVersion : String(order.version),
          },
          errors,
        }),
      );
    }

    const expectedVersion = Number(rawVersion);
    const result = updateOrder(
      db,
      session.accountId,
      order.id,
      { status, shippingMethod, notes, expectedVersion },
      new Date(clock()).toISOString(),
    );
    switch (result.outcome) {
      case 'updated':
        return reply.redirect(`/orders/${order.id}?updated=1`, 302);
      case 'conflict':
        return sendHtml(
          reply,
          409,
          conflictPage({
            session,
            orderId: order.id,
            submittedVersion: expectedVersion,
            currentVersion: result.currentVersion,
          }),
        );
      case 'not_found':
        return notFound(request, reply);
    }
  });

  return app;
}
