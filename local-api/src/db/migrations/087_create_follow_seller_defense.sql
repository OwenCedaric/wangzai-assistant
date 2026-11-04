CREATE TABLE IF NOT EXISTS follow_seller_patrol_runs (
  id TEXT PRIMARY KEY,
  shop_id TEXT NOT NULL,
  mode TEXT NOT NULL DEFAULT 'shop' CHECK (mode IN ('shop', 'manual')),
  status TEXT NOT NULL,
  stage TEXT NOT NULL,
  total_count INTEGER NOT NULL DEFAULT 0 CHECK (total_count >= 0),
  scanned_count INTEGER NOT NULL DEFAULT 0 CHECK (scanned_count >= 0),
  followed_count INTEGER NOT NULL DEFAULT 0 CHECK (followed_count >= 0),
  clear_count INTEGER NOT NULL DEFAULT 0 CHECK (clear_count >= 0),
  failed_count INTEGER NOT NULL DEFAULT 0 CHECK (failed_count >= 0),
  last_error_code TEXT,
  last_error_message TEXT,
  started_at TEXT NOT NULL,
  finished_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (shop_id) REFERENCES shops(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_follow_seller_patrol_shop_time
  ON follow_seller_patrol_runs(shop_id, created_at DESC);

CREATE TABLE IF NOT EXISTS follow_seller_cases (
  id TEXT PRIMARY KEY,
  shop_id TEXT NOT NULL,
  patrol_run_id TEXT,
  input_identifier TEXT,
  product_identity_id TEXT,
  product_id TEXT,
  offer_id TEXT NOT NULL,
  sku TEXT NOT NULL,
  product_name TEXT,
  image_url TEXT,
  status TEXT NOT NULL,
  stage TEXT NOT NULL,
  model_before TEXT,
  model_after TEXT,
  group_offer_ids_json TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(group_offer_ids_json)),
  write_payload_json TEXT CHECK (write_payload_json IS NULL OR json_valid(write_payload_json)),
  write_result_json TEXT CHECK (write_result_json IS NULL OR json_valid(write_result_json)),
  preview_id TEXT,
  ozon_job_id TEXT,
  ozon_task_id TEXT,
  follow_count_before INTEGER CHECK (follow_count_before IS NULL OR follow_count_before >= 0),
  follow_count_after INTEGER CHECK (follow_count_after IS NULL OR follow_count_after >= 0),
  follow_min_price REAL,
  follow_max_price REAL,
  sellers_json TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(sellers_json)),
  retry_count INTEGER NOT NULL DEFAULT 0 CHECK (retry_count >= 0),
  last_error_code TEXT,
  last_error_message TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  completed_at TEXT,
  FOREIGN KEY (shop_id) REFERENCES shops(id) ON DELETE CASCADE,
  FOREIGN KEY (patrol_run_id) REFERENCES follow_seller_patrol_runs(id) ON DELETE CASCADE,
  FOREIGN KEY (product_identity_id) REFERENCES product_identities(product_identity_id) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS idx_follow_seller_cases_shop_status
  ON follow_seller_cases(shop_id, status, updated_at DESC);

CREATE INDEX IF NOT EXISTS idx_follow_seller_cases_patrol
  ON follow_seller_cases(patrol_run_id, created_at ASC);

CREATE INDEX IF NOT EXISTS idx_follow_seller_cases_shop_offer
  ON follow_seller_cases(shop_id, offer_id, updated_at DESC);

CREATE TABLE IF NOT EXISTS follow_seller_action_attempts (
  id TEXT PRIMARY KEY,
  case_id TEXT NOT NULL,
  shop_id TEXT NOT NULL,
  action TEXT NOT NULL,
  status TEXT NOT NULL,
  detail_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(detail_json)),
  created_at TEXT NOT NULL,
  FOREIGN KEY (case_id) REFERENCES follow_seller_cases(id) ON DELETE CASCADE,
  FOREIGN KEY (shop_id) REFERENCES shops(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_follow_seller_attempts_case_time
  ON follow_seller_action_attempts(case_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_follow_seller_attempts_shop_time
  ON follow_seller_action_attempts(shop_id, created_at DESC);

PRAGMA user_version = 87;
