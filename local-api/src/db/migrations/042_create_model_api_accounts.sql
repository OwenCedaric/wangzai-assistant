CREATE TABLE IF NOT EXISTS model_api_accounts (
  id TEXT PRIMARY KEY,
  api_alias TEXT NOT NULL,
  provider TEXT,
  website_url TEXT,
  login_account TEXT,
  login_password_encrypted TEXT,
  base_url TEXT,
  api_key_encrypted TEXT,
  default_model TEXT,
  usage_scene TEXT,
  upscale TEXT,
  quality TEXT,
  style TEXT,
  detection_status TEXT,
  detected_source TEXT,
  detected_at TEXT,
  is_default INTEGER NOT NULL DEFAULT 0 CHECK (is_default IN (0, 1)),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_model_api_accounts_default_updated
  ON model_api_accounts(is_default DESC, updated_at DESC);
