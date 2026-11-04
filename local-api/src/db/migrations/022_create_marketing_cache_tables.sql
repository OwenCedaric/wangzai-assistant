CREATE TABLE IF NOT EXISTS ozon_marketing_activities (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  shop_id TEXT NOT NULL,
  activity_id TEXT NOT NULL,
  source_type TEXT NOT NULL DEFAULT 'official',
  source_label TEXT NOT NULL DEFAULT '',
  title TEXT NOT NULL DEFAULT '',
  original_title TEXT NOT NULL DEFAULT '',
  description TEXT NOT NULL DEFAULT '',
  joined_count INTEGER NOT NULL DEFAULT 0,
  available_count INTEGER NOT NULL DEFAULT 0,
  has_available_count INTEGER NOT NULL DEFAULT 0 CHECK (has_available_count IN (0, 1)),
  estimate TEXT NOT NULL DEFAULT '',
  raw_json TEXT NOT NULL DEFAULT '{}',
  remote_hash TEXT NOT NULL DEFAULT '',
  first_seen_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  last_seen_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(shop_id, activity_id, source_type)
);

CREATE INDEX IF NOT EXISTS idx_ozon_marketing_activities_shop
  ON ozon_marketing_activities(shop_id, source_type, updated_at DESC);

CREATE TABLE IF NOT EXISTS ozon_marketing_activity_products (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  shop_id TEXT NOT NULL,
  activity_id TEXT NOT NULL,
  source_type TEXT NOT NULL DEFAULT 'official',
  product_id TEXT NOT NULL,
  offer_id TEXT NOT NULL DEFAULT '',
  sku TEXT NOT NULL DEFAULT '',
  row_status TEXT NOT NULL DEFAULT '',
  source_activity_price TEXT NOT NULL DEFAULT '',
  activity_price TEXT NOT NULL DEFAULT '',
  price TEXT NOT NULL DEFAULT '',
  stock TEXT NOT NULL DEFAULT '',
  review TEXT NOT NULL DEFAULT '',
  raw_json TEXT NOT NULL DEFAULT '{}',
  remote_hash TEXT NOT NULL DEFAULT '',
  first_seen_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  last_seen_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(shop_id, activity_id, source_type, product_id)
);

CREATE INDEX IF NOT EXISTS idx_ozon_marketing_activity_products_scope
  ON ozon_marketing_activity_products(shop_id, activity_id, source_type, row_status, updated_at DESC);
