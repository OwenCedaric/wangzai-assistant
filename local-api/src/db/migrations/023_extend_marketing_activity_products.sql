ALTER TABLE ozon_marketing_activity_products ADD COLUMN name TEXT NOT NULL DEFAULT '';
ALTER TABLE ozon_marketing_activity_products ADD COLUMN status_tone TEXT NOT NULL DEFAULT '';
ALTER TABLE ozon_marketing_activity_products ADD COLUMN review_tone TEXT NOT NULL DEFAULT '';
ALTER TABLE ozon_marketing_activity_products ADD COLUMN is_stale INTEGER NOT NULL DEFAULT 0 CHECK (is_stale IN (0, 1));

CREATE INDEX IF NOT EXISTS idx_ozon_marketing_activity_products_stale
  ON ozon_marketing_activity_products(shop_id, activity_id, source_type, row_status, is_stale, updated_at DESC);
