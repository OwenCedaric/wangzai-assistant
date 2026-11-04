CREATE TABLE IF NOT EXISTS product_image_assets (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  shop_id TEXT NOT NULL,
  profile_asset_id TEXT,
  sha256 TEXT NOT NULL,
  mime_type TEXT NOT NULL,
  byte_length INTEGER NOT NULL,
  width INTEGER,
  height INTEGER,
  storage_scope TEXT NOT NULL CHECK (storage_scope IN ('temporary', 'permanent')),
  variant TEXT NOT NULL,
  source_type TEXT NOT NULL,
  source_url TEXT,
  object_key TEXT,
  object_etag TEXT,
  object_request_id TEXT,
  status TEXT NOT NULL CHECK (status IN ('pending', 'stored', 'published', 'failed', 'deleted')),
  product_id TEXT,
  offer_id TEXT,
  reference_count INTEGER NOT NULL DEFAULT 1 CHECK (reference_count >= 0),
  upload_attempts INTEGER NOT NULL DEFAULT 0 CHECK (upload_attempts >= 0),
  expires_at TEXT,
  published_at TEXT,
  deleted_at TEXT,
  last_error TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY(profile_asset_id) REFERENCES profile_assets(id) ON DELETE SET NULL,
  UNIQUE(tenant_id, user_id, shop_id, sha256, storage_scope, variant)
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_product_image_assets_object_key
  ON product_image_assets(object_key)
  WHERE object_key IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_product_image_assets_scope_status
  ON product_image_assets(tenant_id, user_id, shop_id, status, updated_at DESC);

CREATE INDEX IF NOT EXISTS idx_product_image_assets_shop_owner
  ON product_image_assets(shop_id, id);

CREATE INDEX IF NOT EXISTS idx_product_image_assets_expiry
  ON product_image_assets(storage_scope, status, expires_at)
  WHERE expires_at IS NOT NULL;

CREATE TABLE IF NOT EXISTS product_image_usage_events (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  shop_id TEXT NOT NULL,
  asset_id TEXT,
  operation TEXT NOT NULL,
  byte_length INTEGER NOT NULL DEFAULT 0 CHECK (byte_length >= 0),
  request_count INTEGER NOT NULL DEFAULT 1 CHECK (request_count >= 0),
  status TEXT NOT NULL,
  detail_json TEXT,
  occurred_at TEXT NOT NULL,
  FOREIGN KEY(asset_id) REFERENCES product_image_assets(id) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS idx_product_image_usage_scope_time
  ON product_image_usage_events(tenant_id, user_id, shop_id, occurred_at DESC);

CREATE INDEX IF NOT EXISTS idx_product_image_usage_shop_owner
  ON product_image_usage_events(shop_id, id);

CREATE INDEX IF NOT EXISTS idx_product_image_usage_operation_time
  ON product_image_usage_events(operation, occurred_at DESC);

PRAGMA user_version = 86;
