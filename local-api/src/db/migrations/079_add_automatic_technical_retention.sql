CREATE INDEX IF NOT EXISTS idx_product_sync_runs_retention
  ON product_sync_runs(status, finished_at, id);

PRAGMA user_version = 79;
