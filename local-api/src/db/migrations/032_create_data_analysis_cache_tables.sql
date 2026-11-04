CREATE TABLE IF NOT EXISTS data_analysis_snapshots (
  id TEXT PRIMARY KEY,
  shop_id TEXT NOT NULL DEFAULT '',
  analysis_type TEXT NOT NULL,
  source_type TEXT NOT NULL,
  source_key TEXT NOT NULL,
  title TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'cached',
  time_range_start TEXT,
  time_range_end TEXT,
  row_count INTEGER NOT NULL DEFAULT 0,
  cache_key TEXT NOT NULL,
  remote_hash TEXT,
  summary_json TEXT NOT NULL DEFAULT '{}',
  metrics_json TEXT NOT NULL DEFAULT '{}',
  payload_json TEXT NOT NULL DEFAULT '{}',
  source_status TEXT NOT NULL DEFAULT 'local_cache',
  source_synced_at TEXT,
  last_seen_at TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(shop_id, analysis_type, source_type, source_key)
);

CREATE INDEX IF NOT EXISTS idx_data_analysis_snapshots_shop_type
  ON data_analysis_snapshots(shop_id, analysis_type, updated_at DESC);

CREATE INDEX IF NOT EXISTS idx_data_analysis_snapshots_source
  ON data_analysis_snapshots(source_type, source_key, updated_at DESC);

CREATE INDEX IF NOT EXISTS idx_data_analysis_snapshots_cache_key
  ON data_analysis_snapshots(cache_key);

CREATE TABLE IF NOT EXISTS data_analysis_sync_state (
  cache_key TEXT PRIMARY KEY,
  shop_id TEXT NOT NULL DEFAULT '',
  analysis_type TEXT NOT NULL DEFAULT 'all',
  status TEXT NOT NULL DEFAULT 'idle',
  last_success_at TEXT,
  last_attempt_at TEXT,
  last_error_json TEXT NOT NULL DEFAULT '{}',
  changed_count INTEGER NOT NULL DEFAULT 0,
  unchanged_count INTEGER NOT NULL DEFAULT 0,
  deleted_count INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_data_analysis_sync_state_shop
  ON data_analysis_sync_state(shop_id, analysis_type, updated_at DESC);

PRAGMA user_version = 32;
