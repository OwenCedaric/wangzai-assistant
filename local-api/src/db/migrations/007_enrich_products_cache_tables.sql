ALTER TABLE ozon_products ADD COLUMN images_json TEXT;
ALTER TABLE ozon_products ADD COLUMN attributes_json TEXT;
ALTER TABLE ozon_products ADD COLUMN price_json TEXT;
ALTER TABLE ozon_products ADD COLUMN stock_json TEXT;
ALTER TABLE ozon_products ADD COLUMN detail_hash TEXT;
ALTER TABLE ozon_products ADD COLUMN pictures_hash TEXT;
ALTER TABLE ozon_products ADD COLUMN prices_hash TEXT;
ALTER TABLE ozon_products ADD COLUMN stocks_hash TEXT;
ALTER TABLE ozon_products ADD COLUMN attributes_hash TEXT;
ALTER TABLE ozon_products ADD COLUMN detail_synced_at TEXT;
ALTER TABLE ozon_products ADD COLUMN pictures_synced_at TEXT;
ALTER TABLE ozon_products ADD COLUMN prices_synced_at TEXT;
ALTER TABLE ozon_products ADD COLUMN stocks_synced_at TEXT;
ALTER TABLE ozon_products ADD COLUMN attributes_synced_at TEXT;
ALTER TABLE ozon_products ADD COLUMN hydrated_at TEXT;

CREATE INDEX IF NOT EXISTS idx_ozon_products_shop_hydrated
  ON ozon_products(shop_id, hydrated_at);

PRAGMA user_version = 7;
