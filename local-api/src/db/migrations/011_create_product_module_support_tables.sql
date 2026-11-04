-- 商品模块完全体支撑底座：材积来源、货源链接、图片健康、费用字段。
ALTER TABLE ozon_products ADD COLUMN acquiring_fee_value REAL;
ALTER TABLE ozon_products ADD COLUMN acquiring_percent REAL;
ALTER TABLE ozon_products ADD COLUMN fee_json TEXT;
ALTER TABLE ozon_products ADD COLUMN fee_hash TEXT;
ALTER TABLE ozon_products ADD COLUMN fee_synced_at TEXT;

CREATE TABLE IF NOT EXISTS product_material_profiles (
  id TEXT PRIMARY KEY,
  shop_id TEXT NOT NULL,
  product_key TEXT NOT NULL,
  product_id TEXT,
  offer_id TEXT,
  sku TEXT,
  source TEXT NOT NULL DEFAULT 'missing',
  source_rank INTEGER NOT NULL DEFAULT 0,
  weight_kg REAL,
  width_cm REAL,
  height_cm REAL,
  depth_cm REAL,
  apply_to_product INTEGER NOT NULL DEFAULT 1 CHECK (apply_to_product IN (0, 1)),
  is_confirmed INTEGER NOT NULL DEFAULT 0 CHECK (is_confirmed IN (0, 1)),
  ozon_synced_at TEXT,
  ozon_sync_status TEXT,
  source_order_id TEXT,
  source_order_number TEXT,
  source_purchase_order_number TEXT,
  raw_json TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (shop_id) REFERENCES shops(id) ON DELETE CASCADE,
  UNIQUE(shop_id, product_key)
);

CREATE INDEX IF NOT EXISTS idx_product_material_profiles_shop_offer
  ON product_material_profiles(shop_id, offer_id);

CREATE INDEX IF NOT EXISTS idx_product_material_profiles_shop_product
  ON product_material_profiles(shop_id, product_id);

CREATE TABLE IF NOT EXISTS product_source_links (
  id TEXT PRIMARY KEY,
  shop_id TEXT NOT NULL,
  product_key TEXT NOT NULL,
  product_id TEXT,
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
  FOREIGN KEY (shop_id) REFERENCES shops(id) ON DELETE CASCADE,
  UNIQUE(shop_id, product_key, slot_index)
);

CREATE INDEX IF NOT EXISTS idx_product_source_links_shop_offer
  ON product_source_links(shop_id, offer_id);

CREATE INDEX IF NOT EXISTS idx_product_source_links_shop_platform
  ON product_source_links(shop_id, platform);

CREATE TABLE IF NOT EXISTS product_image_health (
  id TEXT PRIMARY KEY,
  shop_id TEXT NOT NULL,
  product_key TEXT,
  product_id TEXT,
  offer_id TEXT,
  image_url TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'unknown',
  http_status INTEGER,
  source TEXT,
  checked_at TEXT,
  raw_json TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (shop_id) REFERENCES shops(id) ON DELETE CASCADE,
  UNIQUE(shop_id, image_url)
);

CREATE INDEX IF NOT EXISTS idx_product_image_health_shop_product
  ON product_image_health(shop_id, product_key, status);

PRAGMA user_version = 11;
