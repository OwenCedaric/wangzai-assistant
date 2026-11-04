CREATE TABLE IF NOT EXISTS cross_border_order_records (
  id TEXT PRIMARY KEY,
  shop_id TEXT NOT NULL DEFAULT '',
  record_key TEXT NOT NULL,
  order_id TEXT,
  platform_order TEXT,
  purchase_order_number TEXT,
  collection_number TEXT,
  tracking_number TEXT,
  logistics_order TEXT,
  sheet_order_sn TEXT,
  offer_id TEXT,
  sku TEXT,
  status TEXT,
  read_status TEXT,
  warehouse TEXT,
  route_name TEXT,
  package_weight_kg REAL,
  length_cm REAL,
  width_cm REAL,
  height_cm REAL,
  volume_items_json TEXT,
  status_json TEXT,
  out_info_json TEXT,
  raw_json TEXT,
  remote_hash TEXT,
  is_stale INTEGER NOT NULL DEFAULT 0,
  last_seen_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(shop_id, record_key)
);

CREATE INDEX IF NOT EXISTS idx_cross_border_order_records_shop_record ON cross_border_order_records(shop_id, record_key);
CREATE INDEX IF NOT EXISTS idx_cross_border_order_records_order_id ON cross_border_order_records(shop_id, order_id);
CREATE INDEX IF NOT EXISTS idx_cross_border_order_records_platform_order ON cross_border_order_records(shop_id, platform_order);
CREATE INDEX IF NOT EXISTS idx_cross_border_order_records_purchase_order ON cross_border_order_records(shop_id, purchase_order_number);
CREATE INDEX IF NOT EXISTS idx_cross_border_order_records_tracking ON cross_border_order_records(shop_id, tracking_number);
CREATE INDEX IF NOT EXISTS idx_cross_border_order_records_updated ON cross_border_order_records(updated_at DESC);

PRAGMA user_version = 19;
