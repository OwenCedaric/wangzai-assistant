CREATE TABLE IF NOT EXISTS ozon_returns (
  id TEXT PRIMARY KEY,
  shop_id TEXT NOT NULL,
  return_key TEXT NOT NULL,
  return_id TEXT,
  posting_number TEXT,
  order_id TEXT,
  source TEXT NOT NULL DEFAULT 'returns',
  status TEXT,
  substatus TEXT,
  return_reason TEXT,
  decision TEXT,
  created_at_remote TEXT,
  updated_at_remote TEXT,
  product_json TEXT,
  finance_json TEXT,
  raw_json TEXT,
  remote_hash TEXT NOT NULL,
  is_stale INTEGER NOT NULL DEFAULT 0,
  last_seen_at TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(shop_id, return_key)
);

CREATE INDEX IF NOT EXISTS idx_ozon_returns_shop_return ON ozon_returns(shop_id, return_id);
CREATE INDEX IF NOT EXISTS idx_ozon_returns_shop_posting ON ozon_returns(shop_id, posting_number);
CREATE INDEX IF NOT EXISTS idx_ozon_returns_shop_source ON ozon_returns(shop_id, source);
CREATE INDEX IF NOT EXISTS idx_ozon_returns_shop_status ON ozon_returns(shop_id, status);
CREATE INDEX IF NOT EXISTS idx_ozon_returns_shop_created ON ozon_returns(shop_id, created_at_remote DESC);
CREATE INDEX IF NOT EXISTS idx_ozon_returns_shop_updated ON ozon_returns(shop_id, updated_at DESC);

PRAGMA user_version = 16;
