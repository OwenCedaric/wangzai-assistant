-- Historical product facts are user-owned data.  They deliberately live
-- outside the Ozon fact tables so an import can never overwrite official
-- product price, stock, commission, dimensions, or attributes.
CREATE TABLE IF NOT EXISTS product_manual_cost_profiles (
  id TEXT PRIMARY KEY,
  shop_id TEXT NOT NULL,
  product_key TEXT NOT NULL CHECK (length(trim(product_key)) > 0),
  product_id TEXT,
  offer_id TEXT,
  sku TEXT,
  source_type TEXT NOT NULL CHECK (source_type IN ('historical_import', 'manual')),
  purchase_cost_minor INTEGER CHECK (purchase_cost_minor IS NULL OR (typeof(purchase_cost_minor) = 'integer' AND purchase_cost_minor >= 0)),
  cross_border_cost_minor INTEGER CHECK (cross_border_cost_minor IS NULL OR (typeof(cross_border_cost_minor) = 'integer' AND cross_border_cost_minor >= 0)),
  domestic_freight_minor INTEGER CHECK (domestic_freight_minor IS NULL OR (typeof(domestic_freight_minor) = 'integer' AND domestic_freight_minor >= 0)),
  packaging_cost_minor INTEGER CHECK (packaging_cost_minor IS NULL OR (typeof(packaging_cost_minor) = 'integer' AND packaging_cost_minor >= 0)),
  other_cost_minor INTEGER CHECK (other_cost_minor IS NULL OR (typeof(other_cost_minor) = 'integer' AND other_cost_minor >= 0)),
  currency_code TEXT NOT NULL DEFAULT 'CNY' CHECK (currency_code = 'CNY'),
  source_platform TEXT,
  source_url TEXT,
  purchase_order_number TEXT,
  tracking_number TEXT,
  note TEXT,
  origin_import_id TEXT,
  row_hash TEXT NOT NULL,
  observed_at TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (shop_id, product_key, source_type),
  FOREIGN KEY (shop_id) REFERENCES shops(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_product_manual_cost_profiles_shop_product
  ON product_manual_cost_profiles(shop_id, product_id, offer_id, sku);
CREATE INDEX IF NOT EXISTS idx_product_manual_cost_profiles_shop_updated
  ON product_manual_cost_profiles(shop_id, updated_at DESC, product_key);

-- Import runs and rows are staging/audit state, not business facts.  The
-- normalized profile above is the only durable business result of a confirm.
CREATE TABLE IF NOT EXISTS historical_import_runs (
  import_id TEXT PRIMARY KEY,
  shop_id TEXT NOT NULL,
  shop_incarnation TEXT NOT NULL,
  source_file_name TEXT,
  source_file_type TEXT,
  source_hash TEXT NOT NULL,
  columns_json TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(columns_json)),
  conflict_mode TEXT NOT NULL CHECK (conflict_mode IN ('preserve', 'overwrite')),
  status TEXT NOT NULL CHECK (
    status IN ('previewed', 'completed', 'completed_with_skips', 'failed')
  ),
  preview_fingerprint TEXT NOT NULL,
  row_count INTEGER NOT NULL DEFAULT 0 CHECK (row_count >= 0),
  insert_count INTEGER NOT NULL DEFAULT 0 CHECK (insert_count >= 0),
  update_count INTEGER NOT NULL DEFAULT 0 CHECK (update_count >= 0),
  unchanged_count INTEGER NOT NULL DEFAULT 0 CHECK (unchanged_count >= 0),
  conflict_count INTEGER NOT NULL DEFAULT 0 CHECK (conflict_count >= 0),
  unmatched_count INTEGER NOT NULL DEFAULT 0 CHECK (unmatched_count >= 0),
  invalid_count INTEGER NOT NULL DEFAULT 0 CHECK (invalid_count >= 0),
  duplicate_count INTEGER NOT NULL DEFAULT 0 CHECK (duplicate_count >= 0),
  no_data_count INTEGER NOT NULL DEFAULT 0 CHECK (no_data_count >= 0),
  committed_count INTEGER NOT NULL DEFAULT 0 CHECK (committed_count >= 0),
  skipped_count INTEGER NOT NULL DEFAULT 0 CHECK (skipped_count >= 0),
  result_summary_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(result_summary_json)),
  error_code TEXT,
  created_at TEXT NOT NULL,
  confirmed_at TEXT,
  completed_at TEXT,
  updated_at TEXT NOT NULL,
  UNIQUE (shop_id, import_id),
  FOREIGN KEY (shop_id) REFERENCES shops(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_historical_import_runs_shop_created
  ON historical_import_runs(shop_id, created_at DESC, import_id);

CREATE TABLE IF NOT EXISTS historical_import_rows (
  import_id TEXT NOT NULL,
  row_index INTEGER NOT NULL CHECK (row_index >= 0),
  shop_id TEXT NOT NULL,
  preview_status TEXT NOT NULL CHECK (
    preview_status IN (
      'ready_insert', 'ready_update', 'unchanged', 'conflict',
      'unmatched', 'invalid', 'duplicate', 'no_data'
    )
  ),
  product_key TEXT,
  product_id TEXT,
  offer_id TEXT,
  sku TEXT,
  identity_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(identity_json)),
  normalized_patch_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(normalized_patch_json)),
  applied_patch_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(applied_patch_json)),
  conflicts_json TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(conflicts_json)),
  before_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(before_json)),
  before_hash TEXT NOT NULL,
  after_json TEXT CHECK (after_json IS NULL OR json_valid(after_json)),
  result_hash TEXT,
  error_code TEXT,
  committed INTEGER NOT NULL DEFAULT 0 CHECK (committed IN (0, 1)),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (import_id, row_index),
  FOREIGN KEY (shop_id, import_id) REFERENCES historical_import_runs(shop_id, import_id) ON DELETE CASCADE,
  FOREIGN KEY (shop_id) REFERENCES shops(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_historical_import_rows_shop_status
  ON historical_import_rows(shop_id, preview_status, import_id, row_index);

PRAGMA user_version = 68;
