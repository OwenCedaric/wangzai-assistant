CREATE TABLE IF NOT EXISTS purchase_browser_tasks (
  id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL,
  owner_incarnation TEXT NOT NULL,
  shop_id TEXT,
  order_key TEXT NOT NULL,
  product_key TEXT NOT NULL,
  idempotency_key_hash TEXT NOT NULL UNIQUE,
  request_fingerprint TEXT NOT NULL,
  preview_encrypted TEXT NOT NULL,
  preview_fingerprint TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN (
    'previewed', 'confirmed', 'executing', 'receipt_pending',
    'completed', 'failed', 'interrupted', 'cancelled'
  )),
  execution_capability_hash TEXT,
  attempt_id TEXT,
  attempt_count INTEGER NOT NULL DEFAULT 0,
  receipt_id TEXT,
  last_error_code TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  confirmed_at TEXT,
  completed_at TEXT,
  FOREIGN KEY (owner_id) REFERENCES purchase_accounts(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_purchase_browser_tasks_owner_updated
  ON purchase_browser_tasks(owner_id, updated_at DESC, id DESC);

CREATE INDEX IF NOT EXISTS idx_purchase_browser_tasks_owner_status
  ON purchase_browser_tasks(owner_id, status, updated_at DESC);

CREATE TABLE IF NOT EXISTS purchase_browser_receipts (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL UNIQUE,
  owner_id TEXT NOT NULL,
  shop_id TEXT,
  attempt_id TEXT NOT NULL,
  receipt_encrypted TEXT NOT NULL,
  receipt_hash TEXT NOT NULL,
  website_readback_hash TEXT NOT NULL,
  created_at TEXT NOT NULL,
  FOREIGN KEY (task_id) REFERENCES purchase_browser_tasks(id) ON DELETE CASCADE,
  FOREIGN KEY (owner_id) REFERENCES purchase_accounts(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_purchase_browser_receipts_owner_created
  ON purchase_browser_receipts(owner_id, created_at DESC, id DESC);

CREATE TABLE IF NOT EXISTS purchase_browser_plugin_state (
  owner_id TEXT PRIMARY KEY,
  owner_incarnation TEXT NOT NULL,
  extension_id TEXT NOT NULL,
  extension_version TEXT NOT NULL,
  package_sha256 TEXT NOT NULL,
  install_state TEXT NOT NULL CHECK (install_state IN ('verified', 'active', 'rollback', 'failed')),
  updated_at TEXT NOT NULL,
  FOREIGN KEY (owner_id) REFERENCES purchase_accounts(id) ON DELETE CASCADE
);
