CREATE TABLE IF NOT EXISTS ozon_request_jobs (
  id TEXT PRIMARY KEY,
  domain TEXT NOT NULL,
  shop_id TEXT,
  endpoint_key TEXT,
  action TEXT,
  priority TEXT NOT NULL DEFAULT 'P2' CHECK (priority IN ('P0', 'P1', 'P2', 'P3', 'P4')),
  status TEXT NOT NULL DEFAULT 'queued' CHECK (status IN ('queued', 'running', 'success', 'partial', 'failed', 'canceled', 'blocked', 'rate_limited', 'circuit_open')),
  requested_by TEXT,
  cache_key TEXT,
  idempotency_key TEXT,
  progress_done INTEGER NOT NULL DEFAULT 0,
  progress_total INTEGER NOT NULL DEFAULT 0,
  changed_count INTEGER NOT NULL DEFAULT 0,
  unchanged_count INTEGER NOT NULL DEFAULT 0,
  failed_count INTEGER NOT NULL DEFAULT 0,
  stale_count INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  started_at TEXT,
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  finished_at TEXT,
  FOREIGN KEY (shop_id) REFERENCES shops(id) ON DELETE SET NULL
);

CREATE TABLE IF NOT EXISTS ozon_request_attempts (
  id TEXT PRIMARY KEY,
  job_id TEXT,
  request_id TEXT NOT NULL,
  shop_id TEXT,
  endpoint_key TEXT NOT NULL,
  payload_hash TEXT,
  status TEXT NOT NULL DEFAULT 'queued',
  status_code INTEGER,
  ozon_error_code TEXT,
  retry_after_ms INTEGER,
  duration_ms INTEGER,
  attempt INTEGER NOT NULL DEFAULT 1,
  error_message TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  finished_at TEXT,
  FOREIGN KEY (job_id) REFERENCES ozon_request_jobs(id) ON DELETE CASCADE,
  FOREIGN KEY (shop_id) REFERENCES shops(id) ON DELETE SET NULL
);

CREATE TABLE IF NOT EXISTS ozon_rate_limit_state (
  id TEXT PRIMARY KEY,
  shop_id TEXT,
  endpoint_key TEXT NOT NULL,
  bucket TEXT NOT NULL,
  state TEXT NOT NULL DEFAULT 'ready' CHECK (state IN ('ready', 'paused', 'rate_limited', 'blocked')),
  paused_until TEXT,
  retry_after_ms INTEGER,
  consecutive_failures INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (shop_id) REFERENCES shops(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS ozon_circuit_breakers (
  id TEXT PRIMARY KEY,
  shop_id TEXT,
  endpoint_key TEXT NOT NULL,
  state TEXT NOT NULL DEFAULT 'closed' CHECK (state IN ('open', 'half_open', 'closed')),
  opened_at TEXT,
  half_open_at TEXT,
  closed_at TEXT,
  failure_count INTEGER NOT NULL DEFAULT 0,
  success_count INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (shop_id) REFERENCES shops(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS ozon_sync_state (
  id TEXT PRIMARY KEY,
  domain TEXT NOT NULL,
  shop_id TEXT,
  scope_key TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'idle' CHECK (status IN ('idle', 'queued', 'running', 'success', 'partial', 'failed', 'canceled', 'blocked', 'rate_limited', 'circuit_open')),
  last_success_at TEXT,
  last_attempt_at TEXT,
  last_error TEXT,
  remote_cursor TEXT,
  changed_count INTEGER NOT NULL DEFAULT 0,
  unchanged_count INTEGER NOT NULL DEFAULT 0,
  stale_count INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (shop_id) REFERENCES shops(id) ON DELETE CASCADE,
  UNIQUE(domain, shop_id, scope_key)
);

CREATE TABLE IF NOT EXISTS ozon_response_cache (
  id TEXT PRIMARY KEY,
  domain TEXT NOT NULL,
  shop_id TEXT,
  endpoint_key TEXT NOT NULL,
  cache_key TEXT NOT NULL,
  payload_hash TEXT,
  response_hash TEXT,
  remote_hash TEXT,
  status TEXT NOT NULL DEFAULT 'confirmed' CHECK (status IN ('confirmed', 'partial', 'stale', 'failed')),
  is_stale INTEGER NOT NULL DEFAULT 0 CHECK (is_stale IN (0, 1)),
  stale_reason TEXT,
  expires_at TEXT,
  last_seen_at TEXT,
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  payload_json TEXT,
  FOREIGN KEY (shop_id) REFERENCES shops(id) ON DELETE CASCADE,
  UNIQUE(domain, shop_id, cache_key)
);

CREATE TABLE IF NOT EXISTS ozon_cache_keys (
  cache_key TEXT PRIMARY KEY,
  domain TEXT NOT NULL,
  shop_id TEXT,
  endpoint_key TEXT,
  scope_key TEXT,
  params_hash TEXT,
  policy TEXT NOT NULL DEFAULT 'entity_snapshot',
  allow_stale INTEGER NOT NULL DEFAULT 1 CHECK (allow_stale IN (0, 1)),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (shop_id) REFERENCES shops(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS ozon_cache_merge_log (
  id TEXT PRIMARY KEY,
  domain TEXT NOT NULL,
  shop_id TEXT,
  cache_key TEXT NOT NULL,
  merge_status TEXT NOT NULL CHECK (merge_status IN ('inserted', 'updated', 'unchanged', 'stale_marked', 'skipped', 'failed')),
  old_remote_hash TEXT,
  new_remote_hash TEXT,
  reason TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (shop_id) REFERENCES shops(id) ON DELETE SET NULL
);

CREATE TABLE IF NOT EXISTS ozon_write_audit_log (
  id TEXT PRIMARY KEY,
  domain TEXT NOT NULL,
  shop_id TEXT,
  endpoint_key TEXT,
  action TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'preview' CHECK (status IN ('preview', 'confirmed', 'rejected', 'executed', 'failed')),
  idempotency_key TEXT,
  requested_by TEXT,
  diff_hash TEXT,
  audit_payload_json TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  confirmed_at TEXT,
  FOREIGN KEY (shop_id) REFERENCES shops(id) ON DELETE SET NULL
);

CREATE TABLE IF NOT EXISTS ozon_error_events (
  id TEXT PRIMARY KEY,
  job_id TEXT,
  domain TEXT,
  shop_id TEXT,
  endpoint_key TEXT,
  error_code TEXT NOT NULL,
  error_message TEXT NOT NULL,
  severity TEXT NOT NULL DEFAULT 'warning' CHECK (severity IN ('info', 'warning', 'error', 'critical')),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (job_id) REFERENCES ozon_request_jobs(id) ON DELETE SET NULL,
  FOREIGN KEY (shop_id) REFERENCES shops(id) ON DELETE SET NULL
);

CREATE TABLE IF NOT EXISTS ozon_shop_runtime_state (
  shop_id TEXT PRIMARY KEY,
  status TEXT NOT NULL DEFAULT 'ready' CHECK (status IN ('ready', 'blocked', 'rate_limited', 'auth_failed', 'disabled')),
  last_success_at TEXT,
  last_failure_at TEXT,
  last_error TEXT,
  active_jobs INTEGER NOT NULL DEFAULT 0,
  queued_jobs INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (shop_id) REFERENCES shops(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_ozon_request_jobs_status_priority ON ozon_request_jobs(status, priority, created_at);
CREATE INDEX IF NOT EXISTS idx_ozon_request_jobs_domain_shop ON ozon_request_jobs(domain, shop_id, updated_at);
CREATE INDEX IF NOT EXISTS idx_ozon_attempts_job ON ozon_request_attempts(job_id, created_at);
CREATE INDEX IF NOT EXISTS idx_ozon_rate_limit_lookup ON ozon_rate_limit_state(shop_id, endpoint_key, bucket);
CREATE INDEX IF NOT EXISTS idx_ozon_circuit_lookup ON ozon_circuit_breakers(shop_id, endpoint_key, state);
CREATE INDEX IF NOT EXISTS idx_ozon_sync_state_domain ON ozon_sync_state(domain, shop_id, scope_key);
CREATE INDEX IF NOT EXISTS idx_ozon_response_cache_lookup ON ozon_response_cache(domain, shop_id, cache_key);
CREATE INDEX IF NOT EXISTS idx_ozon_response_cache_stale ON ozon_response_cache(domain, is_stale, updated_at);
CREATE INDEX IF NOT EXISTS idx_ozon_merge_log_cache ON ozon_cache_merge_log(domain, shop_id, cache_key, created_at);
CREATE INDEX IF NOT EXISTS idx_ozon_error_events_domain ON ozon_error_events(domain, shop_id, endpoint_key, created_at);

PRAGMA user_version = 4;
