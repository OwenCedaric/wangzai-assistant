-- Routing/checkpoint metadata only. Profit formulas and business facts are unchanged.
CREATE TABLE IF NOT EXISTS profit_ledger_owner_routes (
  shop_id TEXT PRIMARY KEY,
  profile_id TEXT NOT NULL,
  shop_incarnation TEXT NOT NULL,
  status TEXT NOT NULL,
  backup_path TEXT NOT NULL,
  source_hash TEXT NOT NULL,
  migrated_rows INTEGER NOT NULL,
  migrated_at TEXT NOT NULL
);
PRAGMA user_version = 112;
