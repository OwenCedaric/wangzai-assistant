-- Finance read-only cache foundation: compact Ozon transaction rows for profit actual-fee reuse.
-- This table stores only SQLite cache data. It does not execute or store write operations.
CREATE TABLE IF NOT EXISTS ozon_finance_transactions (
  id TEXT PRIMARY KEY,
  shop_id TEXT NOT NULL,
  operation_key TEXT NOT NULL,
  operation_id TEXT,
  posting_number TEXT,
  order_id TEXT,
  operation_type TEXT,
  operation_type_name TEXT,
  transaction_type TEXT,
  operation_date TEXT,
  amount_total REAL,
  acquiring_fee_cny REAL,
  sale_commission_cny REAL,
  delivery_fee_cny REAL,
  currency_code TEXT,
  services_json TEXT,
  raw_json TEXT,
  remote_hash TEXT NOT NULL,
  is_stale INTEGER NOT NULL DEFAULT 0 CHECK (is_stale IN (0, 1)),
  last_seen_at TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (shop_id) REFERENCES shops(id) ON DELETE CASCADE,
  UNIQUE(shop_id, operation_key)
);

CREATE INDEX IF NOT EXISTS idx_ozon_finance_shop_posting
  ON ozon_finance_transactions(shop_id, posting_number, operation_date);

CREATE INDEX IF NOT EXISTS idx_ozon_finance_shop_date
  ON ozon_finance_transactions(shop_id, operation_date, is_stale);

CREATE INDEX IF NOT EXISTS idx_ozon_finance_shop_type
  ON ozon_finance_transactions(shop_id, operation_type, operation_date);

CREATE INDEX IF NOT EXISTS idx_ozon_finance_shop_updated
  ON ozon_finance_transactions(shop_id, updated_at);

PRAGMA user_version = 14;
