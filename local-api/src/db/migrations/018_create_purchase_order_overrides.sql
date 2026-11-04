CREATE TABLE IF NOT EXISTS purchase_order_overrides (
  id TEXT PRIMARY KEY,
  shop_id TEXT,
  order_key TEXT NOT NULL,
  posting_number TEXT,
  ozon_order_id TEXT,
  offer_id TEXT,
  sku TEXT,
  purchase_platform TEXT,
  purchase_order_number TEXT,
  source_cost_cny REAL,
  manual_status TEXT,
  material_source_json TEXT,
  note TEXT,
  raw_json TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(shop_id, order_key)
);

CREATE INDEX IF NOT EXISTS idx_purchase_order_overrides_shop_order ON purchase_order_overrides(shop_id, order_key);
CREATE INDEX IF NOT EXISTS idx_purchase_order_overrides_shop_posting ON purchase_order_overrides(shop_id, posting_number);
CREATE INDEX IF NOT EXISTS idx_purchase_order_overrides_updated ON purchase_order_overrides(updated_at DESC);

PRAGMA user_version = 18;
