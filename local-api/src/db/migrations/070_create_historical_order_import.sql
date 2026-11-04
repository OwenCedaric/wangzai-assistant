-- Historical order import is a local-only, user-owned fact pipeline.
-- Ozon orders remain read-only source evidence; confirmed imports never write
-- back to Ozon and never replace the official order/product cache rows.
CREATE TABLE IF NOT EXISTS historical_order_facts (
  id TEXT PRIMARY KEY,
  shop_id TEXT NOT NULL,
  posting_number TEXT NOT NULL CHECK (length(trim(posting_number)) > 0),
  order_id TEXT,
  product_identity_id TEXT NOT NULL,
  product_id TEXT,
  offer_id TEXT,
  sku TEXT,
  product_name TEXT,
  source_type TEXT NOT NULL DEFAULT 'historical_order_import'
    CHECK (source_type = 'historical_order_import'),
  purchase_cost_minor INTEGER CHECK (
    purchase_cost_minor IS NULL OR
    (typeof(purchase_cost_minor) = 'integer' AND purchase_cost_minor >= 0)
  ),
  cross_border_cost_minor INTEGER CHECK (
    cross_border_cost_minor IS NULL OR
    (typeof(cross_border_cost_minor) = 'integer' AND cross_border_cost_minor >= 0)
  ),
  domestic_freight_minor INTEGER CHECK (
    domestic_freight_minor IS NULL OR
    (typeof(domestic_freight_minor) = 'integer' AND domestic_freight_minor >= 0)
  ),
  packaging_cost_minor INTEGER CHECK (
    packaging_cost_minor IS NULL OR
    (typeof(packaging_cost_minor) = 'integer' AND packaging_cost_minor >= 0)
  ),
  other_cost_minor INTEGER CHECK (
    other_cost_minor IS NULL OR
    (typeof(other_cost_minor) = 'integer' AND other_cost_minor >= 0)
  ),
  currency_code TEXT NOT NULL DEFAULT 'CNY' CHECK (currency_code = 'CNY'),
  length_mm INTEGER CHECK (
    length_mm IS NULL OR (typeof(length_mm) = 'integer' AND length_mm > 0)
  ),
  width_mm INTEGER CHECK (
    width_mm IS NULL OR (typeof(width_mm) = 'integer' AND width_mm > 0)
  ),
  height_mm INTEGER CHECK (
    height_mm IS NULL OR (typeof(height_mm) = 'integer' AND height_mm > 0)
  ),
  weight_g INTEGER CHECK (
    weight_g IS NULL OR (typeof(weight_g) = 'integer' AND weight_g > 0)
  ),
  source_platform TEXT,
  source_url TEXT,
  purchase_order_number TEXT,
  tracking_number TEXT,
  note TEXT,
  origin_import_id TEXT NOT NULL,
  row_hash TEXT NOT NULL,
  observed_at TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (shop_id, posting_number, source_type),
  FOREIGN KEY (shop_id) REFERENCES shops(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_historical_order_facts_shop_product
  ON historical_order_facts(shop_id, product_identity_id, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_historical_order_facts_shop_updated
  ON historical_order_facts(shop_id, updated_at DESC, posting_number);

CREATE TABLE IF NOT EXISTS historical_order_import_runs (
  import_id TEXT PRIMARY KEY,
  shop_id TEXT NOT NULL,
  shop_incarnation TEXT NOT NULL,
  source_file_name TEXT,
  source_file_type TEXT,
  source_hash TEXT NOT NULL,
  columns_json TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(columns_json)),
  source_type TEXT NOT NULL DEFAULT 'historical_order_import'
    CHECK (source_type = 'historical_order_import'),
  status TEXT NOT NULL CHECK (
    status IN ('previewed', 'completed', 'completed_with_skips', 'failed')
  ),
  preview_fingerprint TEXT NOT NULL,
  row_count INTEGER NOT NULL DEFAULT 0 CHECK (row_count >= 0),
  insert_count INTEGER NOT NULL DEFAULT 0 CHECK (insert_count >= 0),
  update_count INTEGER NOT NULL DEFAULT 0 CHECK (update_count >= 0),
  unchanged_count INTEGER NOT NULL DEFAULT 0 CHECK (unchanged_count >= 0),
  selection_required_count INTEGER NOT NULL DEFAULT 0 CHECK (selection_required_count >= 0),
  order_not_found_count INTEGER NOT NULL DEFAULT 0 CHECK (order_not_found_count >= 0),
  product_unmatched_count INTEGER NOT NULL DEFAULT 0 CHECK (product_unmatched_count >= 0),
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

CREATE INDEX IF NOT EXISTS idx_historical_order_import_runs_shop_created
  ON historical_order_import_runs(shop_id, created_at DESC, import_id);

CREATE TABLE IF NOT EXISTS historical_order_import_rows (
  import_id TEXT NOT NULL,
  row_index INTEGER NOT NULL CHECK (row_index >= 0),
  shop_id TEXT NOT NULL,
  preview_status TEXT NOT NULL CHECK (
    preview_status IN (
      'ready_insert', 'ready_update', 'unchanged', 'selection_required',
      'order_not_found', 'product_unmatched', 'invalid', 'duplicate', 'no_data'
    )
  ),
  posting_number TEXT,
  order_id TEXT,
  product_identity_id TEXT,
  product_id TEXT,
  offer_id TEXT,
  sku TEXT,
  product_name TEXT,
  match_mode TEXT CHECK (match_mode IS NULL OR match_mode IN ('automatic', 'selected')),
  candidates_json TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(candidates_json)),
  normalized_patch_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(normalized_patch_json)),
  applied_patch_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(applied_patch_json)),
  before_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(before_json)),
  before_hash TEXT NOT NULL,
  after_json TEXT CHECK (after_json IS NULL OR json_valid(after_json)),
  result_hash TEXT,
  error_code TEXT,
  committed INTEGER NOT NULL DEFAULT 0 CHECK (committed IN (0, 1)),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (import_id, row_index),
  FOREIGN KEY (shop_id, import_id)
    REFERENCES historical_order_import_runs(shop_id, import_id) ON DELETE CASCADE,
  FOREIGN KEY (shop_id) REFERENCES shops(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_historical_order_import_rows_shop_status
  ON historical_order_import_rows(shop_id, preview_status, import_id, row_index);

PRAGMA user_version = 70;
