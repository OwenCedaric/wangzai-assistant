CREATE TABLE IF NOT EXISTS product_sync_runs (
  id TEXT PRIMARY KEY,
  shop_id TEXT NOT NULL,
  shop_incarnation TEXT NOT NULL,
  credential_revision INTEGER NOT NULL CHECK (credential_revision >= 1),
  mode TEXT NOT NULL CHECK (mode IN ('bootstrap', 'full', 'reconcile', 'incremental', 'fast', 'details', 'readback')),
  visibility TEXT NOT NULL,
  request_fingerprint TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN (
    'queued', 'fetching', 'proving', 'activating',
    'completed', 'completed_with_source_gaps',
    'partial', 'failed', 'interrupted', 'invalid', 'canceled'
  )),
  contract_hash TEXT NOT NULL,
  mapper_version TEXT NOT NULL,
  base_snapshot_id TEXT,
  activated_snapshot_id TEXT,
  start_cursor TEXT,
  committed_cursor TEXT,
  expected_count INTEGER NOT NULL DEFAULT 0 CHECK (expected_count >= 0),
  actual_count INTEGER NOT NULL DEFAULT 0 CHECK (actual_count >= 0),
  staged_batch_count INTEGER NOT NULL DEFAULT 0 CHECK (staged_batch_count >= 0),
  source_gap_count INTEGER NOT NULL DEFAULT 0 CHECK (source_gap_count >= 0),
  proof_json TEXT,
  proof_hash TEXT,
  lease_owner TEXT,
  lease_expires_at TEXT,
  heartbeat_at TEXT,
  error_code TEXT,
  error_message TEXT,
  created_at TEXT NOT NULL,
  started_at TEXT,
  updated_at TEXT NOT NULL,
  finished_at TEXT,
  FOREIGN KEY (shop_id) REFERENCES shops(id) ON DELETE CASCADE
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_product_sync_runs_singleflight
  ON product_sync_runs(shop_id, request_fingerprint)
  WHERE status IN ('queued', 'fetching', 'proving', 'activating');

CREATE INDEX IF NOT EXISTS idx_product_sync_runs_shop_status
  ON product_sync_runs(shop_id, status, updated_at DESC);

CREATE INDEX IF NOT EXISTS idx_product_sync_runs_lease
  ON product_sync_runs(status, lease_expires_at);

CREATE TABLE IF NOT EXISTS product_sync_stage_batches (
  run_id TEXT NOT NULL,
  shop_id TEXT NOT NULL,
  batch_key TEXT NOT NULL,
  stage_kind TEXT NOT NULL CHECK (stage_kind IN ('list', 'facet')),
  endpoint_key TEXT NOT NULL,
  facet TEXT NOT NULL,
  visibility TEXT,
  batch_index INTEGER NOT NULL CHECK (batch_index >= 0),
  request_cursor TEXT,
  next_cursor TEXT,
  expected_product_ids_json TEXT NOT NULL DEFAULT '[]',
  expected_offer_ids_json TEXT NOT NULL DEFAULT '[]',
  actual_product_ids_json TEXT NOT NULL DEFAULT '[]',
  actual_offer_ids_json TEXT NOT NULL DEFAULT '[]',
  normalized_rows_json TEXT NOT NULL,
  row_count INTEGER NOT NULL CHECK (row_count >= 0),
  payload_hash TEXT NOT NULL,
  response_hash TEXT NOT NULL,
  contract_version TEXT NOT NULL,
  mapper_version TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('returned', 'returned_empty', 'failed', 'contract_invalid')),
  source_reason TEXT,
  observed_at TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (run_id, batch_key),
  FOREIGN KEY (run_id) REFERENCES product_sync_runs(id) ON DELETE CASCADE,
  FOREIGN KEY (shop_id) REFERENCES shops(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_product_sync_stage_batches_run_order
  ON product_sync_stage_batches(run_id, stage_kind, batch_index, batch_key);

CREATE TABLE IF NOT EXISTS product_sync_page_proofs (
  run_id TEXT NOT NULL,
  shop_id TEXT NOT NULL,
  visibility TEXT NOT NULL,
  page_index INTEGER NOT NULL CHECK (page_index >= 1),
  request_cursor TEXT,
  next_cursor TEXT,
  row_count INTEGER NOT NULL CHECK (row_count >= 0),
  page_limit INTEGER NOT NULL CHECK (page_limit > 0),
  is_short_page INTEGER NOT NULL CHECK (is_short_page IN (0, 1)),
  is_terminal INTEGER NOT NULL CHECK (is_terminal IN (0, 1)),
  response_hash TEXT NOT NULL,
  contract_version TEXT NOT NULL,
  mapper_version TEXT NOT NULL,
  observed_at TEXT NOT NULL,
  PRIMARY KEY (run_id, visibility, page_index),
  FOREIGN KEY (run_id) REFERENCES product_sync_runs(id) ON DELETE CASCADE,
  FOREIGN KEY (shop_id) REFERENCES shops(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS product_sync_outbox (
  event_id TEXT PRIMARY KEY,
  shop_id TEXT NOT NULL,
  run_id TEXT NOT NULL,
  snapshot_id TEXT NOT NULL,
  event_type TEXT NOT NULL CHECK (event_type IN ('ProductSnapshotActivated', 'ProductSnapshotActivatedWithSourceGaps')),
  payload_json TEXT NOT NULL,
  payload_hash TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'processing', 'published', 'failed')),
  attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  available_at TEXT NOT NULL,
  created_at TEXT NOT NULL,
  published_at TEXT,
  last_error TEXT,
  FOREIGN KEY (shop_id) REFERENCES shops(id) ON DELETE CASCADE,
  FOREIGN KEY (run_id) REFERENCES product_sync_runs(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_product_sync_outbox_pending
  ON product_sync_outbox(status, available_at, created_at);

CREATE TABLE IF NOT EXISTS product_sync_quarantine (
  id TEXT PRIMARY KEY,
  shop_id TEXT NOT NULL,
  run_id TEXT,
  endpoint_key TEXT,
  reason_code TEXT NOT NULL,
  evidence_hash TEXT NOT NULL,
  evidence_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  FOREIGN KEY (shop_id) REFERENCES shops(id) ON DELETE CASCADE,
  FOREIGN KEY (run_id) REFERENCES product_sync_runs(id) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS idx_product_sync_quarantine_shop
  ON product_sync_quarantine(shop_id, created_at DESC);

PRAGMA user_version = 60;
