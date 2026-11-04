CREATE TABLE IF NOT EXISTS cross_border_charge_records (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL DEFAULT 'tenant_local_default',
  user_id TEXT NOT NULL DEFAULT 'user_local_default',
  profile_id TEXT NOT NULL DEFAULT 'default',
  browser_account_ref TEXT NOT NULL,
  external_account_ref TEXT NOT NULL DEFAULT '',
  shop_id TEXT NOT NULL DEFAULT '',
  collection_number TEXT NOT NULL,
  posting_number TEXT NOT NULL DEFAULT '',
  purchase_order_number TEXT NOT NULL DEFAULT '',
  direction TEXT NOT NULL CHECK (direction IN ('expense', 'income')),
  amount_cny REAL NOT NULL CHECK (amount_cny >= 0),
  balance_after_cny REAL,
  reason TEXT NOT NULL DEFAULT '',
  occurred_at TEXT NOT NULL DEFAULT '',
  warehouse TEXT NOT NULL DEFAULT '',
  service_company TEXT NOT NULL DEFAULT '',
  source_record_hash TEXT NOT NULL,
  raw_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  CHECK (json_valid(raw_json)),
  UNIQUE (
    tenant_id, user_id, profile_id, browser_account_ref, source_record_hash
  )
);

CREATE INDEX IF NOT EXISTS idx_cross_border_charge_records_scope_posting
  ON cross_border_charge_records(
    tenant_id, user_id, profile_id, shop_id, posting_number, occurred_at DESC
  );

CREATE INDEX IF NOT EXISTS idx_cross_border_charge_records_scope_collection
  ON cross_border_charge_records(
    tenant_id, user_id, profile_id, browser_account_ref, collection_number, occurred_at DESC
  );

CREATE TABLE IF NOT EXISTS cross_border_charge_links (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL DEFAULT 'tenant_local_default',
  user_id TEXT NOT NULL DEFAULT 'user_local_default',
  profile_id TEXT NOT NULL DEFAULT 'default',
  browser_account_ref TEXT NOT NULL,
  external_account_ref TEXT NOT NULL DEFAULT '',
  shop_id TEXT NOT NULL DEFAULT '',
  collection_number TEXT NOT NULL,
  posting_number TEXT NOT NULL DEFAULT '',
  ozon_order_key TEXT NOT NULL DEFAULT '',
  purchase_order_number TEXT NOT NULL DEFAULT '',
  service_name TEXT NOT NULL DEFAULT '',
  warehouse TEXT NOT NULL DEFAULT '',
  actual_fee_cny REAL NOT NULL CHECK (actual_fee_cny >= 0),
  ledger_net_cny REAL NOT NULL,
  currency TEXT NOT NULL DEFAULT 'CNY',
  match_status TEXT NOT NULL CHECK (match_status IN ('exact', 'unmatched', 'ambiguous')),
  confidence INTEGER NOT NULL DEFAULT 0 CHECK (confidence >= 0 AND confidence <= 100),
  evidence_json TEXT NOT NULL DEFAULT '{}',
  source_hash TEXT NOT NULL,
  last_seen_at TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  CHECK (json_valid(evidence_json)),
  UNIQUE (
    tenant_id, user_id, profile_id, browser_account_ref, collection_number
  )
);

CREATE INDEX IF NOT EXISTS idx_cross_border_charge_links_scope_posting
  ON cross_border_charge_links(
    tenant_id, user_id, profile_id, shop_id, posting_number, updated_at DESC
  );

CREATE INDEX IF NOT EXISTS idx_cross_border_charge_links_scope_account
  ON cross_border_charge_links(
    tenant_id, user_id, profile_id, browser_account_ref, updated_at DESC
  );

PRAGMA user_version = 74;
