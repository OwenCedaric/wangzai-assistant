CREATE TABLE IF NOT EXISTS integration_credentials (
  profile_id TEXT PRIMARY KEY,
  base_url TEXT NOT NULL,
  login_account TEXT,
  login_password_encrypted TEXT,
  api_key_encrypted TEXT,
  last_test_status TEXT,
  last_test_message TEXT,
  last_test_at TEXT,
  last_test_metadata_json TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (profile_id) REFERENCES integration_profiles(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_integration_credentials_test_status
  ON integration_credentials(last_test_status, updated_at DESC);

PRAGMA user_version = 73;
