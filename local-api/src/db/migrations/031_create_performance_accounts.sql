CREATE TABLE IF NOT EXISTS performance_accounts (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'inactive',
  client_id TEXT,
  client_secret_encrypted TEXT,
  last_test_at TEXT,
  last_test_message TEXT,
  campaign_count INTEGER,
  statistics_task_count INTEGER,
  note TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_performance_accounts_status ON performance_accounts(status, updated_at DESC);

PRAGMA user_version = 31;
