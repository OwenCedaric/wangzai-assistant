CREATE TABLE IF NOT EXISTS profit_ledger_snapshots (
  snapshot_key TEXT PRIMARY KEY,
  logical_scope TEXT NOT NULL,
  cache_group TEXT NOT NULL,
  calculation_version TEXT NOT NULL,
  source_key TEXT,
  signature TEXT,
  snapshot_json TEXT NOT NULL,
  fetched_at TEXT,
  updated_at TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_profit_ledger_snapshots_scope_updated
  ON profit_ledger_snapshots(logical_scope, updated_at DESC);

CREATE INDEX IF NOT EXISTS idx_profit_ledger_snapshots_updated
  ON profit_ledger_snapshots(updated_at DESC);

PRAGMA user_version = 46;
