ALTER TABLE ozon_finance_balance_snapshots ADD COLUMN date_from TEXT;
ALTER TABLE ozon_finance_balance_snapshots ADD COLUMN date_to TEXT;

CREATE INDEX IF NOT EXISTS idx_finance_balance_shop_range_recorded
  ON ozon_finance_balance_snapshots(shop_id, date_from, date_to, recorded_at DESC);

PRAGMA user_version = 97;
