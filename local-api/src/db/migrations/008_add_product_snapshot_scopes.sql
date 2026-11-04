ALTER TABLE ozon_products ADD COLUMN snapshot_visibilities_json TEXT;

UPDATE ozon_products
SET snapshot_visibilities_json = '["' || REPLACE(COALESCE(NULLIF(visibility, ''), 'ALL'), '"', '') || '"]'
WHERE snapshot_visibilities_json IS NULL OR snapshot_visibilities_json = '';

CREATE INDEX IF NOT EXISTS idx_ozon_products_shop_snapshot
  ON ozon_products(shop_id, snapshot_visibilities_json);

PRAGMA user_version = 8;
