-- Orders read-only cache foundation. Stores compact Ozon posting rows for sales orders, purchase cards and profit reuse.
CREATE TABLE IF NOT EXISTS ozon_orders (
  id TEXT PRIMARY KEY,
  shop_id TEXT NOT NULL,
  order_key TEXT NOT NULL,
  posting_number TEXT,
  order_id TEXT,
  source TEXT NOT NULL DEFAULT 'FBS',
  status TEXT,
  substatus TEXT,
  fulfillment TEXT,
  in_process_at TEXT,
  shipment_date TEXT,
  delivering_date TEXT,
  cutoff_at TEXT,
  products_json TEXT,
  analytics_json TEXT,
  financial_json TEXT,
  raw_json TEXT,
  remote_hash TEXT NOT NULL,
  is_stale INTEGER NOT NULL DEFAULT 0 CHECK (is_stale IN (0, 1)),
  last_seen_at TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (shop_id) REFERENCES shops(id) ON DELETE CASCADE,
  UNIQUE(shop_id, order_key)
);

CREATE INDEX IF NOT EXISTS idx_ozon_orders_shop_posting
  ON ozon_orders(shop_id, posting_number);

CREATE INDEX IF NOT EXISTS idx_ozon_orders_shop_status
  ON ozon_orders(shop_id, status, is_stale, in_process_at);

CREATE INDEX IF NOT EXISTS idx_ozon_orders_shop_date
  ON ozon_orders(shop_id, in_process_at, is_stale);

CREATE INDEX IF NOT EXISTS idx_ozon_orders_shop_updated
  ON ozon_orders(shop_id, updated_at);

PRAGMA user_version = 15;
