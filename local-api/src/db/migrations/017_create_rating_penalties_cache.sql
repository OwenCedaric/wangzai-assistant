CREATE TABLE IF NOT EXISTS ozon_rating_penalties (
  id TEXT PRIMARY KEY,
  shop_id TEXT NOT NULL,
  penalty_key TEXT NOT NULL,
  posting_number TEXT,
  order_id TEXT,
  operation_id TEXT,
  rating_index TEXT,
  penalty_status TEXT,
  penalty_type TEXT,
  penalty_name TEXT,
  operation_date TEXT,
  amount_cny REAL,
  currency_code TEXT,
  raw_json TEXT,
  remote_hash TEXT NOT NULL,
  is_stale INTEGER NOT NULL DEFAULT 0,
  last_seen_at TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(shop_id, penalty_key)
);

CREATE INDEX IF NOT EXISTS idx_ozon_rating_penalties_shop_posting ON ozon_rating_penalties(shop_id, posting_number);
CREATE INDEX IF NOT EXISTS idx_ozon_rating_penalties_shop_date ON ozon_rating_penalties(shop_id, operation_date DESC);
CREATE INDEX IF NOT EXISTS idx_ozon_rating_penalties_shop_status ON ozon_rating_penalties(shop_id, penalty_status);
CREATE INDEX IF NOT EXISTS idx_ozon_rating_penalties_shop_updated ON ozon_rating_penalties(shop_id, updated_at DESC);

PRAGMA user_version = 17;
