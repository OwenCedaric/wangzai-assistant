CREATE TABLE IF NOT EXISTS account_removal_operations (
  operation_id TEXT PRIMARY KEY,
  idempotency_key_hash TEXT NOT NULL UNIQUE,
  request_digest TEXT NOT NULL,
  owner_type TEXT NOT NULL,
  owner_ref TEXT NOT NULL,
  payload_encrypted TEXT,
  phase TEXT NOT NULL,
  status TEXT NOT NULL,
  attempt_count INTEGER NOT NULL DEFAULT 0,
  preview_fingerprint TEXT NOT NULL,
  catalog_fingerprint TEXT NOT NULL,
  snapshot_fingerprint TEXT NOT NULL,
  client_cleanup_nonce TEXT,
  client_resource_ids_json TEXT NOT NULL DEFAULT '[]',
  deletion_summary_json TEXT NOT NULL DEFAULT '{}',
  last_error_code TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  completed_at TEXT,
  CHECK (json_valid(client_resource_ids_json)),
  CHECK (json_valid(deletion_summary_json)),
  CHECK (attempt_count >= 0)
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_account_removal_operations_active_owner
  ON account_removal_operations(owner_type, owner_ref)
  WHERE completed_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_account_removal_operations_pending
  ON account_removal_operations(completed_at, updated_at DESC);

PRAGMA user_version = 55;
