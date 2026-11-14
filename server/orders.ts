import { inTransaction, type Database } from '../database/db.js';

export const ORDER_STATUSES = ['held', 'open', 'shipped', 'cancelled'] as const;
export type OrderStatus = (typeof ORDER_STATUSES)[number];

export const SHIPPING_METHODS = ['standard', 'express', 'freight', 'pickup'] as const;
export type ShippingMethod = (typeof SHIPPING_METHODS)[number];

export const PAGE_SIZE = 20;
export const NOTES_MAX_LENGTH = 2000;
const ORDER_ID_PATTERN = /^NS-\d{4,}$/;

export function isOrderStatus(value: string): value is OrderStatus {
  return (ORDER_STATUSES as readonly string[]).includes(value);
}

export function isShippingMethod(value: string): value is ShippingMethod {
  return (SHIPPING_METHODS as readonly string[]).includes(value);
}

export function isOrderId(value: string): boolean {
  return ORDER_ID_PATTERN.test(value);
}

export interface OrderSummary {
  id: string;
  customer: string;
  status: OrderStatus;
  totalCents: number;
  updatedAt: string;
}

export interface OrderItem {
  sku: string;
  name: string;
  quantity: number;
  unitPriceCents: number;
}

export interface OrderDetail extends OrderSummary {
  shippingMethod: ShippingMethod;
  notes: string;
  version: number;
  createdAt: string;
  items: OrderItem[];
}

export interface OrderPage {
  orders: OrderSummary[];
  totalOrders: number;
  page: number;
  totalPages: number;
}

export interface NewOrder {
  id: string;
  accountId: number;
  customer: string;
  status: OrderStatus;
  shippingMethod: ShippingMethod;
  notes: string;
  createdAt: string;
  updatedAt: string;
  items: OrderItem[];
}

const TOTAL_CENTS = `(SELECT COALESCE(SUM(i.quantity * i.unit_price_cents), 0)
                       FROM order_items i WHERE i.order_id = o.id)`;

/*
 * Every query below takes the signed-in account's id and filters on it. An order that belongs
 * to another account is indistinguishable from one that does not exist.
 */

/** One page of the account's orders, newest order number first. */
export function listOrders(
  db: Database,
  accountId: number,
  filter: { status?: OrderStatus; page: number },
): OrderPage {
  const where = filter.status === undefined ? '' : 'AND o.status = ?';
  const params = filter.status === undefined ? [accountId] : [accountId, filter.status];

  const countRow = db
    .prepare(`SELECT COUNT(*) AS n FROM orders o WHERE o.account_id = ? ${where}`)
    .get(...params);
  const totalOrders = Number(countRow?.n ?? 0);

  const rows = db
    .prepare(
      `SELECT o.id, o.customer, o.status, o.updated_at, ${TOTAL_CENTS} AS total_cents
         FROM orders o
        WHERE o.account_id = ? ${where}
        ORDER BY o.id DESC
        LIMIT ? OFFSET ?`,
    )
    .all(...params, PAGE_SIZE, (filter.page - 1) * PAGE_SIZE);

  return {
    orders: rows.map((row) => ({
      id: String(row.id),
      customer: String(row.customer),
      status: String(row.status) as OrderStatus,
      totalCents: Number(row.total_cents),
      updatedAt: String(row.updated_at),
    })),
    totalOrders,
    page: filter.page,
    totalPages: Math.max(1, Math.ceil(totalOrders / PAGE_SIZE)),
  };
}

export function getOrder(db: Database, accountId: number, orderId: string): OrderDetail | null {
  if (!isOrderId(orderId)) return null;

  const row = db
    .prepare(
      `SELECT o.id, o.customer, o.status, o.shipping_method, o.notes, o.version,
              o.created_at, o.updated_at, ${TOTAL_CENTS} AS total_cents
         FROM orders o
        WHERE o.id = ? AND o.account_id = ?`,
    )
    .get(orderId, accountId);
  if (row === undefined) return null;

  const items = db
    .prepare(
      `SELECT sku, name, quantity, unit_price_cents
         FROM order_items WHERE order_id = ? ORDER BY position`,
    )
    .all(orderId);

  return {
    id: String(row.id),
    customer: String(row.customer),
    status: String(row.status) as OrderStatus,
    totalCents: Number(row.total_cents),
    shippingMethod: String(row.shipping_method) as ShippingMethod,
    notes: String(row.notes),
    version: Number(row.version),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
    items: items.map((item) => ({
      sku: String(item.sku),
      name: String(item.name),
      quantity: Number(item.quantity),
      unitPriceCents: Number(item.unit_price_cents),
    })),
  };
}

export type UpdateResult =
  | { outcome: 'updated' }
  | { outcome: 'conflict'; currentVersion: number }
  | { outcome: 'not_found' };

/**
 * Applies an edit only if `expectedVersion` is still the order's current version, and bumps
 * the version. The version check is part of the UPDATE itself, so two concurrent edits based
 * on the same version cannot both succeed.
 */
export function updateOrder(
  db: Database,
  accountId: number,
  orderId: string,
  change: {
    status: OrderStatus;
    shippingMethod: ShippingMethod;
    notes: string;
    expectedVersion: number;
  },
  updatedAt: string,
): UpdateResult {
  if (!isOrderId(orderId)) return { outcome: 'not_found' };

  const result = db
    .prepare(
      `UPDATE orders
          SET status = ?, shipping_method = ?, notes = ?, version = version + 1, updated_at = ?
        WHERE id = ? AND account_id = ? AND version = ?`,
    )
    .run(
      change.status,
      change.shippingMethod,
      change.notes,
      updatedAt,
      orderId,
      accountId,
      change.expectedVersion,
    );
  if (Number(result.changes) === 1) return { outcome: 'updated' };

  const current = db
    .prepare('SELECT version FROM orders WHERE id = ? AND account_id = ?')
    .get(orderId, accountId);
  if (current === undefined) return { outcome: 'not_found' };
  return { outcome: 'conflict', currentVersion: Number(current.version) };
}

/** Inserts an order with its line items. Used by the seed script and by tests. */
export function insertOrder(db: Database, order: NewOrder): void {
  inTransaction(db, () => {
    db.prepare(
      `INSERT INTO orders
         (id, account_id, customer, status, shipping_method, notes, version, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?)`,
    ).run(
      order.id,
      order.accountId,
      order.customer,
      order.status,
      order.shippingMethod,
      order.notes,
      order.createdAt,
      order.updatedAt,
    );
    const insertItem = db.prepare(
      `INSERT INTO order_items (order_id, position, sku, name, quantity, unit_price_cents)
       VALUES (?, ?, ?, ?, ?, ?)`,
    );
    order.items.forEach((item, index) => {
      insertItem.run(order.id, index + 1, item.sku, item.name, item.quantity, item.unitPriceCents);
    });
  });
}
