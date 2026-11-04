CREATE TABLE IF NOT EXISTS purchase_accounts (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  platform_name TEXT,
  login_account TEXT,
  login_password_encrypted TEXT,
  default_usage TEXT,
  risk_note TEXT,
  note TEXT,
  is_default INTEGER NOT NULL DEFAULT 0 CHECK (is_default IN (0, 1)),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_purchase_accounts_default
  ON purchase_accounts(is_default DESC, updated_at DESC);

PRAGMA user_version = 40;
