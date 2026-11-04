CREATE TABLE IF NOT EXISTS data_backup_exports (
  backup_id TEXT PRIMARY KEY,
  owner_type TEXT NOT NULL,
  owner_ref TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('prepared', 'verified', 'failed')),
  data_fingerprint TEXT NOT NULL,
  package_sha256 TEXT NOT NULL,
  package_bytes INTEGER NOT NULL CHECK (package_bytes > 0),
  domain_summary_json TEXT NOT NULL,
  suggested_file_name TEXT NOT NULL,
  survives_account_removal INTEGER NOT NULL DEFAULT 1 CHECK (survives_account_removal IN (0, 1)),
  failure_code TEXT,
  created_at TEXT NOT NULL,
  verified_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_data_backup_exports_owner_status
  ON data_backup_exports(owner_type, owner_ref, status, verified_at DESC, created_at DESC);

PRAGMA user_version = 64;
