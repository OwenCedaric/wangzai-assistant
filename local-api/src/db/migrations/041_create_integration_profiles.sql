CREATE TABLE IF NOT EXISTS integration_profiles (
  id TEXT PRIMARY KEY,
  integration_type TEXT NOT NULL,
  platform_name TEXT NOT NULL,
  api_type TEXT,
  auth_mode TEXT,
  config_status TEXT,
  token_status TEXT,
  read_scope TEXT,
  write_scope TEXT,
  note TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_integration_profiles_type_updated
  ON integration_profiles(integration_type, updated_at DESC);
