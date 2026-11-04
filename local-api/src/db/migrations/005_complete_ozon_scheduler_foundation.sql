CREATE TABLE IF NOT EXISTS ozon_sync_locks (
  lock_key TEXT PRIMARY KEY,
  owner_job_id TEXT,
  domain TEXT NOT NULL,
  shop_id TEXT,
  cache_key TEXT,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'released', 'expired')),
  acquired_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  heartbeat_at TEXT,
  released_at TEXT,
  reused_job_id TEXT
);

CREATE INDEX IF NOT EXISTS idx_ozon_sync_locks_domain_shop
  ON ozon_sync_locks(domain, shop_id, status, expires_at);

ALTER TABLE ozon_request_jobs ADD COLUMN request_fingerprint TEXT;
ALTER TABLE ozon_request_jobs ADD COLUMN dedupe_until TEXT;
ALTER TABLE ozon_request_jobs ADD COLUMN reused_from_job_id TEXT;
ALTER TABLE ozon_request_jobs ADD COLUMN lock_key TEXT;

CREATE INDEX IF NOT EXISTS idx_ozon_jobs_fingerprint_status
  ON ozon_request_jobs(request_fingerprint, status, updated_at);

CREATE INDEX IF NOT EXISTS idx_ozon_jobs_idempotency_status
  ON ozon_request_jobs(idempotency_key, status, updated_at);

CREATE INDEX IF NOT EXISTS idx_ozon_jobs_lock_key_status
  ON ozon_request_jobs(lock_key, status, updated_at);

PRAGMA user_version = 5;
