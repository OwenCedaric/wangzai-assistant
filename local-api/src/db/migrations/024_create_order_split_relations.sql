CREATE TABLE IF NOT EXISTS ozon_order_split_relations (
  id TEXT PRIMARY KEY,
  shop_id TEXT NOT NULL,
  parent_posting_number TEXT NOT NULL,
  child_posting_numbers_json TEXT,
  split_quantities_json TEXT,
  status TEXT NOT NULL DEFAULT 'submitted_waiting_readback',
  readback_status TEXT NOT NULL DEFAULT 'pending',
  parent_ozon_visible INTEGER,
  children_confirmed INTEGER NOT NULL DEFAULT 0 CHECK (children_confirmed IN (0, 1)),
  child_count INTEGER NOT NULL DEFAULT 0,
  quantity_sum INTEGER NOT NULL DEFAULT 0,
  submitted_payload_json TEXT,
  ozon_response_json TEXT,
  parent_snapshot_json TEXT,
  child_snapshots_json TEXT,
  readback_rows_json TEXT,
  mismatch_reason TEXT,
  submitted_at TEXT NOT NULL,
  readback_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (shop_id) REFERENCES shops(id) ON DELETE CASCADE,
  UNIQUE(shop_id, parent_posting_number)
);

CREATE INDEX IF NOT EXISTS idx_ozon_order_split_parent
  ON ozon_order_split_relations(shop_id, parent_posting_number);

CREATE INDEX IF NOT EXISTS idx_ozon_order_split_status
  ON ozon_order_split_relations(shop_id, status, readback_status);

PRAGMA user_version = 24;
