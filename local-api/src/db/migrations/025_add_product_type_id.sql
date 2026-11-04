ALTER TABLE ozon_products ADD COLUMN type_id TEXT;

CREATE INDEX IF NOT EXISTS idx_ozon_products_shop_type
  ON ozon_products(shop_id, category_id, type_id);

PRAGMA user_version = 25;
