CREATE TABLE IF NOT EXISTS purchase_source_links (
  id TEXT PRIMARY KEY,
  shop_id TEXT NOT NULL DEFAULT '',
  order_key TEXT NOT NULL,
  product_key TEXT,
  offer_id TEXT,
  sku TEXT,
  slot_index INTEGER NOT NULL DEFAULT 0,
  is_primary INTEGER NOT NULL DEFAULT 0 CHECK (is_primary IN (0, 1)),
  platform TEXT,
  url TEXT,
  source_product_id TEXT,
  title TEXT,
  image_url TEXT,
  price_value REAL,
  currency_code TEXT,
  qty TEXT,
  raw_json TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(shop_id, order_key, slot_index)
);

CREATE INDEX IF NOT EXISTS idx_purchase_source_links_shop_order ON purchase_source_links(shop_id, order_key);
CREATE INDEX IF NOT EXISTS idx_purchase_source_links_offer ON purchase_source_links(shop_id, offer_id);
CREATE INDEX IF NOT EXISTS idx_purchase_source_links_platform ON purchase_source_links(shop_id, platform);
CREATE INDEX IF NOT EXISTS idx_purchase_source_links_updated ON purchase_source_links(updated_at DESC);

PRAGMA user_version = 21;
