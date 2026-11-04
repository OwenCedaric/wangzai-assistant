-- Ozon 商品正式事实只允许按 shop_id + Ozon product_id 唯一落库。
-- offer_id / SKU / 标题均为可变业务字段，不再承担正式商品身份。
CREATE UNIQUE INDEX IF NOT EXISTS idx_ozon_products_shop_product_id_unique
  ON ozon_products(shop_id, product_id)
  WHERE product_id IS NOT NULL AND TRIM(product_id) <> '';

PRAGMA user_version = 98;
