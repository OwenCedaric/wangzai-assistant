ALTER TABLE ozon_request_jobs ADD COLUMN profile TEXT;
ALTER TABLE ozon_request_jobs ADD COLUMN source TEXT;
ALTER TABLE ozon_request_jobs ADD COLUMN stage TEXT;
ALTER TABLE ozon_request_jobs ADD COLUMN message TEXT;
ALTER TABLE ozon_request_jobs ADD COLUMN items_done INTEGER NOT NULL DEFAULT 0;
ALTER TABLE ozon_request_jobs ADD COLUMN items_total INTEGER NOT NULL DEFAULT 0;
ALTER TABLE ozon_request_jobs ADD COLUMN retry_count INTEGER NOT NULL DEFAULT 0;
ALTER TABLE ozon_request_jobs ADD COLUMN next_retry_at TEXT;
ALTER TABLE ozon_request_jobs ADD COLUMN last_retry_after_ms INTEGER;
ALTER TABLE ozon_request_jobs ADD COLUMN last_endpoint_key TEXT;
ALTER TABLE ozon_request_jobs ADD COLUMN last_attempt_id TEXT;
ALTER TABLE ozon_request_jobs ADD COLUMN snapshot_id TEXT;

CREATE TABLE IF NOT EXISTS ozon_sync_snapshots (
  id TEXT PRIMARY KEY,
  domain TEXT NOT NULL,
  shop_id TEXT,
  source TEXT NOT NULL,
  status TEXT NOT NULL,
  active INTEGER NOT NULL DEFAULT 0,
  row_count INTEGER NOT NULL DEFAULT 0,
  changed_count INTEGER NOT NULL DEFAULT 0,
  unchanged_count INTEGER NOT NULL DEFAULT 0,
  failed_count INTEGER NOT NULL DEFAULT 0,
  source_job_id TEXT,
  created_at TEXT NOT NULL,
  activated_at TEXT,
  finished_at TEXT,
  FOREIGN KEY (shop_id) REFERENCES shops(id) ON DELETE SET NULL,
  FOREIGN KEY (source_job_id) REFERENCES ozon_request_jobs(id) ON DELETE SET NULL
);

CREATE TABLE IF NOT EXISTS ozon_scheduler_trace_events (
  id TEXT PRIMARY KEY,
  job_id TEXT,
  request_id TEXT,
  attempt_id TEXT,
  snapshot_id TEXT,
  domain TEXT,
  shop_id TEXT,
  endpoint_key TEXT,
  batch_index INTEGER,
  batch_total INTEGER,
  priority TEXT,
  source TEXT,
  phase TEXT NOT NULL,
  status TEXT NOT NULL,
  queue_wait_ms INTEGER,
  permit_wait_ms INTEGER,
  request_duration_ms INTEGER,
  merge_duration_ms INTEGER,
  retry_count INTEGER,
  retry_after_ms INTEGER,
  status_code INTEGER,
  ozon_code TEXT,
  error_message TEXT,
  source_file TEXT,
  source_function TEXT,
  source_line INTEGER,
  created_at TEXT NOT NULL,
  FOREIGN KEY (job_id) REFERENCES ozon_request_jobs(id) ON DELETE CASCADE,
  FOREIGN KEY (shop_id) REFERENCES shops(id) ON DELETE SET NULL
);

CREATE TABLE IF NOT EXISTS ozon_notification_events (
  id TEXT PRIMARY KEY,
  shop_id TEXT,
  shop_name TEXT,
  domain TEXT NOT NULL,
  event_type TEXT NOT NULL,
  severity TEXT NOT NULL DEFAULT 'info',
  title TEXT NOT NULL,
  summary TEXT,
  old_value_json TEXT,
  new_value_json TEXT,
  source_endpoint TEXT,
  source_job_id TEXT,
  source_attempt_id TEXT,
  snapshot_id TEXT,
  entity_type TEXT,
  entity_id TEXT,
  offer_id TEXT,
  product_id TEXT,
  posting_number TEXT,
  enabled INTEGER NOT NULL DEFAULT 1,
  read_at TEXT,
  created_at TEXT NOT NULL,
  FOREIGN KEY (shop_id) REFERENCES shops(id) ON DELETE SET NULL,
  FOREIGN KEY (source_job_id) REFERENCES ozon_request_jobs(id) ON DELETE SET NULL,
  FOREIGN KEY (source_attempt_id) REFERENCES ozon_request_attempts(id) ON DELETE SET NULL,
  FOREIGN KEY (snapshot_id) REFERENCES ozon_sync_snapshots(id) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS idx_ozon_scheduler_trace_job
  ON ozon_scheduler_trace_events(job_id, created_at);

CREATE INDEX IF NOT EXISTS idx_ozon_scheduler_trace_endpoint
  ON ozon_scheduler_trace_events(domain, shop_id, endpoint_key, created_at);

CREATE INDEX IF NOT EXISTS idx_ozon_sync_snapshots_active
  ON ozon_sync_snapshots(domain, shop_id, active, created_at);

CREATE INDEX IF NOT EXISTS idx_ozon_notification_events_shop_domain
  ON ozon_notification_events(shop_id, domain, event_type, created_at);

CREATE INDEX IF NOT EXISTS idx_ozon_jobs_profile_status
  ON ozon_request_jobs(profile, status, updated_at);

PRAGMA user_version = 27;
