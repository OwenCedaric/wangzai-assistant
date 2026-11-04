CREATE TABLE IF NOT EXISTS cross_border_accounts (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'inactive',
  company_secret_encrypted TEXT,
  access_token_encrypted TEXT,
  app_uid_encrypted TEXT,
  default_storehouse TEXT,
  default_section TEXT,
  default_service TEXT,
  note TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_cross_border_accounts_status ON cross_border_accounts(status, updated_at DESC);

PRAGMA user_version = 20;
