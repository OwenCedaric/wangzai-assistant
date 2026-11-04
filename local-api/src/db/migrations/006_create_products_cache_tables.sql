CREATE TABLE IF NOT EXISTS ozon_products (
  id TEXT PRIMARY KEY,
  shop_id TEXT NOT NULL,
  product_key TEXT NOT NULL,
  product_id TEXT,
  offer_id TEXT,
  sku TEXT,
  name TEXT,
  visibility TEXT NOT NULL DEFAULT 'ALL',
  status_label TEXT,
  category_id TEXT,
  category_name TEXT,
  primary_image_url TEXT,
  price_value REAL,
  currency_code TEXT,
  stock_value INTEGER,
  commission_percent REAL,
  weight_kg REAL,
  width_cm REAL,
  height_cm REAL,
  depth_cm REAL,
  sort_index INTEGER NOT NULL DEFAULT 0,
  source_endpoint_key TEXT,
  raw_json TEXT,
  remote_hash TEXT NOT NULL,
  is_stale INTEGER NOT NULL DEFAULT 0 CHECK (is_stale IN (0, 1)),
  last_seen_at TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (shop_id) REFERENCES shops(id) ON DELETE CASCADE,
  UNIQUE(shop_id, product_key)
);

CREATE INDEX IF NOT EXISTS idx_ozon_products_shop_visibility
  ON ozon_products(shop_id, visibility, is_stale, sort_index);

CREATE INDEX IF NOT EXISTS idx_ozon_products_shop_product_id
  ON ozon_products(shop_id, product_id);

CREATE INDEX IF NOT EXISTS idx_ozon_products_shop_offer_id
  ON ozon_products(shop_id, offer_id);

CREATE INDEX IF NOT EXISTS idx_ozon_products_shop_updated
  ON ozon_products(shop_id, updated_at);

PRAGMA user_version = 6;
