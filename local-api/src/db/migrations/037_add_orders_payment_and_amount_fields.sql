-- Canonical sales-order read model: retain payment time and amount for SQLite-side list summaries.
ALTER TABLE ozon_orders ADD COLUMN payment_at TEXT;
ALTER TABLE ozon_orders ADD COLUMN amount_value REAL;

CREATE INDEX IF NOT EXISTS idx_ozon_orders_shop_stale_payment_display_order
  ON ozon_orders(
    shop_id,
    is_stale,
    COALESCE(payment_at, in_process_at, updated_at) DESC,
    posting_number ASC,
    order_id ASC,
    id ASC
  );

PRAGMA user_version = 37;
