-- Read-only Ozon settlement report cache. This is intentionally separate from
-- the frozen order-profit ledger and never writes back to Ozon.
CREATE TABLE IF NOT EXISTS ozon_finance_statement_reports (
  id TEXT PRIMARY KEY,
  shop_id TEXT NOT NULL,
  period_id TEXT NOT NULL,
  period_begin TEXT,
  period_end TEXT,
  currency_code TEXT,
  begin_balance_amount REAL,
  end_balance_amount REAL,
  invoice_transfer REAL,
  payment REAL,
  orders_amount REAL,
  returns_amount REAL,
  commission_amount REAL,
  delivery_service_fee REAL,
  agency_service_fee REAL,
  promotion_fee REAL,
  fbo_service_fee REAL,
  other_service_fee REAL,
  other_accruals_fee REAL,
  compensation_and_restitution_fee REAL,
  loan REAL,
  item_delivery_and_return_amount REAL,
  total_services REAL,
  total_others REAL,
  availability_json TEXT,
  details_json TEXT,
  raw_json TEXT,
  remote_hash TEXT NOT NULL,
  last_seen_at TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (shop_id) REFERENCES shops(id) ON DELETE CASCADE,
  UNIQUE(shop_id, period_id)
);

CREATE INDEX IF NOT EXISTS idx_finance_statement_shop_period
  ON ozon_finance_statement_reports(shop_id, period_begin, period_end);

CREATE TABLE IF NOT EXISTS ozon_finance_balance_snapshots (
  id TEXT PRIMARY KEY,
  shop_id TEXT NOT NULL,
  balance_amount REAL,
  currency_code TEXT,
  availability_json TEXT,
  raw_json TEXT,
  remote_hash TEXT NOT NULL,
  recorded_at TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (shop_id) REFERENCES shops(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_finance_balance_shop_recorded
  ON ozon_finance_balance_snapshots(shop_id, recorded_at DESC);

PRAGMA user_version = 96;
