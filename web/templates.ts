import {
  NOTES_MAX_LENGTH,
  ORDER_STATUSES,
  SHIPPING_METHODS,
  type OrderDetail,
  type OrderPage,
  type OrderStatus,
} from '../server/orders.js';
import type { Session } from '../server/sessions.js';
import { html, type SafeHtml } from './html.js';

/*
 * Every page is a plain function from data to SafeHtml. The data-testid and data-field
 * attributes are a stable contract for browser automation; see the README before renaming any.
 */

const STATUS_LABELS: Readonly<Record<OrderStatus, string>> = {
  held: 'Held',
  open: 'Open',
  shipped: 'Shipped',
  cancelled: 'Cancelled',
};

export function formatMoney(cents: number): string {
  const dollars = Math.trunc(cents / 100).toLocaleString('en-US');
  return `$${dollars}.${String(cents % 100).padStart(2, '0')}`;
}

/** `2026-09-14T08:30:00.000Z` becomes `2026-09-14 08:30 UTC`. */
export function formatTimestamp(iso: string): string {
  return `${iso.slice(0, 10)} ${iso.slice(11, 16)} UTC`;
}

function timestamp(iso: string): SafeHtml {
  return html`<time datetime="${iso}">${formatTimestamp(iso)}</time>`;
}

function layout(page: { title: string; session: Session | null; body: SafeHtml }): string {
  const { session } = page;
  const account = session
    ? html`<div class="account">
        <span>Signed in as <strong data-testid="current-user">${session.username}</strong></span>
        <form method="post" action="/logout">
          <input type="hidden" name="_csrf" value="${session.csrfToken}" />
          <button type="submit" class="button-link" data-testid="logout-submit">Sign out</button>
        </form>
      </div>`
    : null;

  return html`<!doctype html>
    <html lang="en">
      <head>
        <meta charset="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <title>${page.title} · Northstar Orders</title>
        <link rel="stylesheet" href="/static/styles.css" />
      </head>
      <body>
        <a class="skip-link" href="#main">Skip to content</a>
        <header class="site-header">
          <div class="site-header-inner">
            <a class="brand" href="/orders">Northstar <span>Orders</span></a>
            ${account}
          </div>
        </header>
        <main id="main">${page.body}</main>
        <footer class="site-footer">
          Northstar Supply Co. · Demonstration system · All data is synthetic
        </footer>
      </body>
    </html>`.value;
}

export function loginPage(view: { error?: string; username?: string }): string {
  const error = view.error
    ? html`<p class="alert alert-error" role="alert" data-testid="login-error">${view.error}</p>`
    : null;
  return layout({
    title: 'Sign in',
    session: null,
    body: html`<section class="card card-narrow">
      <h1>Sign in</h1>
      ${error}
      <form method="post" action="/login" class="stack">
        <div class="field">
          <label for="username">Username</label>
          <input
            id="username"
            name="username"
            type="text"
            autocomplete="username"
            autocapitalize="none"
            spellcheck="false"
            maxlength="64"
            required
            value="${view.username ?? ''}"
          />
        </div>
        <div class="field">
          <label for="password">Password</label>
          <input
            id="password"
            name="password"
            type="password"
            autocomplete="current-password"
            maxlength="256"
            required
          />
        </div>
        <button type="submit" class="button" data-testid="login-submit">Sign in</button>
      </form>
    </section>`,
  });
}

function ordersHref(status: OrderStatus | undefined, page: number): string {
  const query = new URLSearchParams();
  if (status !== undefined) query.set('status', status);
  if (page > 1) query.set('page', String(page));
  const text = query.toString();
  return text === '' ? '/orders' : `/orders?${text}`;
}

export function ordersPage(view: {
  session: Session;
  result: OrderPage;
  status: OrderStatus | undefined;
}): string {
  const { result, status } = view;

  const filters = [undefined, ...ORDER_STATUSES].map((option) => {
    const label = option === undefined ? 'All' : STATUS_LABELS[option];
    return option === status
      ? html`<li><a href="${ordersHref(option, 1)}" aria-current="page">${label}</a></li>`
      : html`<li><a href="${ordersHref(option, 1)}">${label}</a></li>`;
  });

  const rows = result.orders.map(
    (order) =>
      html`<tr data-testid="order-row" data-order-id="${order.id}">
        <td data-field="id"><a href="/orders/${order.id}">${order.id}</a></td>
        <td data-field="customer">${order.customer}</td>
        <td data-field="status"><span class="badge badge-${order.status}">${order.status}</span></td>
        <td data-field="total" class="numeric">${formatMoney(order.totalCents)}</td>
        <td data-field="updatedAt">${timestamp(order.updatedAt)}</td>
      </tr>`,
  );

  const empty =
    result.orders.length === 0
      ? html`<p class="empty" data-testid="orders-empty">No orders match this view.</p>`
      : null;

  const previous =
    result.page > 1
      ? html`<a rel="prev" data-testid="page-prev" href="${ordersHref(status, result.page - 1)}"
          >Previous</a
        >`
      : null;
  const next =
    result.page < result.totalPages
      ? html`<a rel="next" data-testid="page-next" href="${ordersHref(status, result.page + 1)}"
          >Next</a
        >`
      : null;

  return layout({
    title: 'Orders',
    session: view.session,
    body: html`<div class="page-heading">
        <h1>Orders</h1>
        <p class="muted" data-testid="orders-count">
          ${result.totalOrders} ${result.totalOrders === 1 ? 'order' : 'orders'}
        </p>
      </div>
      <nav aria-label="Filter by status">
        <ul class="filters">
          ${filters}
        </ul>
      </nav>
      <div class="table-wrap">
        <table data-testid="orders-table">
          <caption class="visually-hidden">
            Orders, newest first
          </caption>
          <thead>
            <tr>
              <th scope="col">Order</th>
              <th scope="col">Customer</th>
              <th scope="col">Status</th>
              <th scope="col" class="numeric">Total</th>
              <th scope="col">Updated</th>
            </tr>
          </thead>
          <tbody>
            ${rows}
          </tbody>
        </table>
      </div>
      ${empty}
      <nav
        class="pagination"
        aria-label="Pagination"
        data-testid="pagination"
        data-page="${result.page}"
        data-total-pages="${result.totalPages}"
      >
        ${previous}
        <span>Page ${result.page} of ${result.totalPages}</span>
        ${next}
      </nav>`,
  });
}

export function orderDetailPage(view: {
  session: Session;
  order: OrderDetail;
  updated: boolean;
}): string {
  const { order } = view;
  const flash = view.updated
    ? html`<p class="alert alert-success" role="status" data-testid="flash-success">
        Order ${order.id} was updated.
      </p>`
    : null;

  const items = order.items.map(
    (item) =>
      html`<tr data-testid="order-item">
        <td data-field="sku">${item.sku}</td>
        <td data-field="name">${item.name}</td>
        <td data-field="quantity" class="numeric">${item.quantity}</td>
        <td data-field="unitPrice" class="numeric">${formatMoney(item.unitPriceCents)}</td>
      </tr>`,
  );

  return layout({
    title: `Order ${order.id}`,
    session: view.session,
    body: html`<p class="breadcrumb"><a href="/orders">Orders</a> / ${order.id}</p>
      ${flash}
      <section class="card" data-testid="order-detail">
        <div class="page-heading">
          <h1>Order <span data-field="id">${order.id}</span></h1>
          <a class="button" href="/orders/${order.id}/edit" data-testid="order-edit-link"
            >Edit order</a
          >
        </div>
        <dl class="details">
          <div>
            <dt>Customer</dt>
            <dd data-field="customer">${order.customer}</dd>
          </div>
          <div>
            <dt>Status</dt>
            <dd><span class="badge badge-${order.status}" data-field="status">${order.status}</span></dd>
          </div>
          <div>
            <dt>Total</dt>
            <dd data-field="total">${formatMoney(order.totalCents)}</dd>
          </div>
          <div>
            <dt>Shipping method</dt>
            <dd data-field="shippingMethod">${order.shippingMethod}</dd>
          </div>
          <div>
            <dt>Revision</dt>
            <dd data-field="version">${order.version}</dd>
          </div>
          <div>
            <dt>Last updated</dt>
            <dd data-field="updatedAt">${timestamp(order.updatedAt)}</dd>
          </div>
          <div class="details-wide">
            <dt>Notes</dt>
            <dd class="notes" data-field="notes">${order.notes}</dd>
          </div>
        </dl>
        <h2>Items</h2>
        <div class="table-wrap">
          <table data-testid="order-items">
            <thead>
              <tr>
                <th scope="col">SKU</th>
                <th scope="col">Item</th>
                <th scope="col" class="numeric">Quantity</th>
                <th scope="col" class="numeric">Unit price</th>
              </tr>
            </thead>
            <tbody>
              ${items}
            </tbody>
          </table>
        </div>
      </section>`,
  });
}

export interface OrderFormValues {
  status: string;
  shippingMethod: string;
  notes: string;
  version: string;
}

export function orderEditPage(view: {
  session: Session;
  orderId: string;
  values: OrderFormValues;
  errors?: string[];
}): string {
  const { values, orderId } = view;
  const errors =
    view.errors && view.errors.length > 0
      ? html`<div class="alert alert-error" role="alert" data-testid="form-error">
          <p>The order was not saved:</p>
          <ul>
            ${view.errors.map((message) => html`<li>${message}</li>`)}
          </ul>
        </div>`
      : null;

  const option = (value: string, label: string, selected: boolean) =>
    selected
      ? html`<option value="${value}" selected>${label}</option>`
      : html`<option value="${value}">${label}</option>`;

  return layout({
    title: `Edit order ${orderId}`,
    session: view.session,
    body: html`<p class="breadcrumb">
        <a href="/orders">Orders</a> / <a href="/orders/${orderId}">${orderId}</a> / Edit
      </p>
      <section class="card card-form">
        <h1>Edit order ${orderId}</h1>
        ${errors}
        <form method="post" action="/orders/${orderId}" class="stack" data-testid="order-edit-form">
          <input type="hidden" name="_csrf" value="${view.session.csrfToken}" />
          <input type="hidden" name="version" value="${values.version}" />
          <div class="field">
            <label for="status">Status</label>
            <select id="status" name="status" required>
              ${ORDER_STATUSES.map((status) =>
                option(status, STATUS_LABELS[status], status === values.status),
              )}
            </select>
          </div>
          <div class="field">
            <label for="shippingMethod">Shipping method</label>
            <select id="shippingMethod" name="shippingMethod" required>
              ${SHIPPING_METHODS.map((method) => option(method, method, method === values.shippingMethod))}
            </select>
          </div>
          <div class="field">
            <label for="notes">Notes</label>
            <textarea id="notes" name="notes" rows="6" maxlength="${NOTES_MAX_LENGTH}">
${values.notes}</textarea
            >
            <p class="hint">Up to ${NOTES_MAX_LENGTH} characters.</p>
          </div>
          <div class="actions">
            <button type="submit" class="button" data-testid="order-save">Save changes</button>
            <a href="/orders/${orderId}">Cancel</a>
          </div>
        </form>
      </section>`,
  });
}

export function conflictPage(view: {
  session: Session;
  orderId: string;
  submittedVersion: number;
  currentVersion: number;
}): string {
  return layout({
    title: 'Order changed',
    session: view.session,
    body: html`<section class="card">
      <h1>This order has changed</h1>
      <p class="alert alert-error" role="alert" data-testid="conflict-error">
        Order ${view.orderId} was changed after you opened it: you were editing revision
        ${view.submittedVersion}, and it is now at revision ${view.currentVersion}. Your changes
        were not saved.
      </p>
      <p>
        <a href="/orders/${view.orderId}">Review the current order</a> or
        <a href="/orders/${view.orderId}/edit">start the edit again</a>.
      </p>
    </section>`,
  });
}

const ERROR_TITLES: Readonly<Record<number, string>> = {
  400: 'That request could not be understood',
  403: 'That request was not allowed',
  404: 'Page not found',
  500: 'Something went wrong',
};

export function errorPage(view: {
  session: Session | null;
  status: number;
  message: string;
}): string {
  return layout({
    title: ERROR_TITLES[view.status] ?? 'Error',
    session: view.session,
    body: html`<section class="card" data-testid="error-page" data-status="${view.status}">
      <h1>${ERROR_TITLES[view.status] ?? 'Error'}</h1>
      <p>${view.message}</p>
      <p><a href="/orders">Back to orders</a></p>
    </section>`,
  });
}
