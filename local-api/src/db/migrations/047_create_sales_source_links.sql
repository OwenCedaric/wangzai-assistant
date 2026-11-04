-- 销售订单历史货源链接：按真实店铺和 posting 归属，不能复用商品或采购来源表。
CREATE TABLE IF NOT EXISTS sales_source_links (
  id TEXT PRIMARY KEY,
  shop_id TEXT NOT NULL,
  order_key TEXT NOT NULL,
  slot_index INTEGER NOT NULL DEFAULT 0,
  is_primary INTEGER NOT NULL DEFAULT 0 CHECK (is_primary IN (0, 1)),
  platform TEXT,
  url TEXT,
  source_product_id TEXT,
  title TEXT,
  image_url TEXT,
  price_value REAL,
  currency_code TEXT,
  qty TEXT,
  raw_json TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (shop_id) REFERENCES shops(id) ON DELETE CASCADE,
  UNIQUE(shop_id, order_key, slot_index)
);

CREATE INDEX IF NOT EXISTS idx_sales_source_links_shop_order
  ON sales_source_links(shop_id, order_key);
CREATE INDEX IF NOT EXISTS idx_sales_source_links_updated
  ON sales_source_links(updated_at DESC);

PRAGMA user_version = 47;
