CREATE TABLE recovery_reconcile_state_next (
  restore_id TEXT NOT NULL,
  generation_id TEXT NOT NULL,
  shop_id TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'queued', 'completed', 'partial', 'failed')),
  overlap_minutes INTEGER NOT NULL DEFAULT 30 CHECK (overlap_minutes BETWEEN 1 AND 1440),
  queued_policy_count INTEGER NOT NULL DEFAULT 0 CHECK (queued_policy_count >= 0),
  completed_policy_count INTEGER NOT NULL DEFAULT 0 CHECK (completed_policy_count >= 0),
  failed_policy_count INTEGER NOT NULL DEFAULT 0 CHECK (failed_policy_count >= 0),
  job_ids_json TEXT NOT NULL DEFAULT '[]',
  queued_at TEXT,
  completed_at TEXT,
  last_error TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (restore_id, shop_id),
  FOREIGN KEY (shop_id) REFERENCES shops(id) ON DELETE CASCADE
);

INSERT INTO recovery_reconcile_state_next (
  restore_id, generation_id, shop_id, status, overlap_minutes, queued_policy_count,
  completed_policy_count, failed_policy_count, job_ids_json, queued_at, completed_at,
  last_error, created_at, updated_at
)
SELECT
  restore_id, generation_id, shop_id, status, overlap_minutes, queued_policy_count,
  0, 0, '[]', queued_at, NULL, last_error, created_at, updated_at
FROM recovery_reconcile_state;

DROP TABLE recovery_reconcile_state;
ALTER TABLE recovery_reconcile_state_next RENAME TO recovery_reconcile_state;

CREATE INDEX idx_recovery_reconcile_pending
  ON recovery_reconcile_state(status, updated_at, shop_id);

PRAGMA user_version = 39;
