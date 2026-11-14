CREATE TABLE accounts (
  id            INTEGER PRIMARY KEY,
  username      TEXT NOT NULL UNIQUE,
  display_name  TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  created_at    TEXT NOT NULL
) STRICT;

-- The cookie carries a random token; only its SHA-256 is stored here.
CREATE TABLE sessions (
  token_hash  TEXT PRIMARY KEY,
  account_id  INTEGER NOT NULL REFERENCES accounts (id) ON DELETE CASCADE,
  csrf_token  TEXT NOT NULL,
  created_at  INTEGER NOT NULL,
  expires_at  INTEGER NOT NULL
) STRICT;

CREATE INDEX sessions_expires_at ON sessions (expires_at);

CREATE TABLE orders (
  id              TEXT PRIMARY KEY,
  account_id      INTEGER NOT NULL REFERENCES accounts (id) ON DELETE CASCADE,
  customer        TEXT NOT NULL,
  status          TEXT NOT NULL CHECK (status IN ('held', 'open', 'shipped', 'cancelled')),
  shipping_method TEXT NOT NULL CHECK (shipping_method IN ('standard', 'express', 'freight', 'pickup')),
  notes           TEXT NOT NULL DEFAULT '',
  version         INTEGER NOT NULL DEFAULT 1 CHECK (version >= 1),
  created_at      TEXT NOT NULL,
  updated_at      TEXT NOT NULL
) STRICT;

CREATE INDEX orders_account_status ON orders (account_id, status);

CREATE TABLE order_items (
  id               INTEGER PRIMARY KEY,
  order_id         TEXT NOT NULL REFERENCES orders (id) ON DELETE CASCADE,
  position         INTEGER NOT NULL,
  sku              TEXT NOT NULL,
  name             TEXT NOT NULL,
  quantity         INTEGER NOT NULL CHECK (quantity > 0),
  unit_price_cents INTEGER NOT NULL CHECK (unit_price_cents >= 0),
  UNIQUE (order_id, position)
) STRICT;
