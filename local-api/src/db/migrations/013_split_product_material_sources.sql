-- 商品材积多来源底座：同一商品允许同时保存 Ozon、上游/人工、跨境巴士等来源。
-- 有效采用值仍按 source_rank 选择最高优先级，不复制商品大表。

PRAGMA foreign_keys = OFF;

ALTER TABLE product_material_profiles RENAME TO product_material_profiles_legacy_013;

CREATE TABLE product_material_profiles (
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
  UNIQUE(shop_id, product_key, source)
);

INSERT OR IGNORE INTO product_material_profiles (
  id, shop_id, product_key, product_id, offer_id, sku, source, source_rank,
  weight_kg, width_cm, height_cm, depth_cm, apply_to_product, is_confirmed,
  ozon_synced_at, ozon_sync_status, source_order_id, source_order_number,
  source_purchase_order_number, raw_json, created_at, updated_at
)
SELECT
  id, shop_id, product_key, product_id, offer_id, sku, source, source_rank,
  weight_kg, width_cm, height_cm, depth_cm, apply_to_product, is_confirmed,
  ozon_synced_at, ozon_sync_status, source_order_id, source_order_number,
  source_purchase_order_number, raw_json, created_at, updated_at
FROM product_material_profiles_legacy_013;

DROP TABLE product_material_profiles_legacy_013;

CREATE INDEX IF NOT EXISTS idx_product_material_profiles_shop_offer
  ON product_material_profiles(shop_id, offer_id);

CREATE INDEX IF NOT EXISTS idx_product_material_profiles_shop_product
  ON product_material_profiles(shop_id, product_id);

CREATE INDEX IF NOT EXISTS idx_product_material_profiles_shop_key_rank
  ON product_material_profiles(shop_id, product_key, source_rank DESC, updated_at DESC);

PRAGMA foreign_keys = ON;

PRAGMA user_version = 13;
