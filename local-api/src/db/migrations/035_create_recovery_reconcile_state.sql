CREATE TABLE IF NOT EXISTS recovery_reconcile_state (
  restore_id TEXT NOT NULL,
  generation_id TEXT NOT NULL,
  shop_id TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'queued')),
  overlap_minutes INTEGER NOT NULL DEFAULT 30 CHECK (overlap_minutes BETWEEN 1 AND 1440),
  queued_policy_count INTEGER NOT NULL DEFAULT 0 CHECK (queued_policy_count >= 0),
  queued_at TEXT,
  last_error TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (restore_id, shop_id),
  FOREIGN KEY (shop_id) REFERENCES shops(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_recovery_reconcile_pending
  ON recovery_reconcile_state(status, updated_at, shop_id);

PRAGMA user_version = 35;
