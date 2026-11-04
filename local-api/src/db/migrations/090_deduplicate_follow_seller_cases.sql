ALTER TABLE follow_seller_cases
  ADD COLUMN is_latest INTEGER NOT NULL DEFAULT 1 CHECK (is_latest IN (0, 1));

-- 同一店铺、同一 Ozon SKU 的多次巡查仍保留原始批次记录，但只把最后
-- 一次更新标记为当前有效记录。页面清单和统计只读取 is_latest = 1，
-- 因此重复巡查不会再累计商品数或跟卖数。
WITH ranked AS (
  SELECT id,
         ROW_NUMBER() OVER (
           PARTITION BY shop_id, sku
           ORDER BY updated_at DESC, created_at DESC, id DESC
         ) AS row_number
    FROM follow_seller_cases
)
UPDATE follow_seller_cases
   SET is_latest = CASE
     WHEN id IN (SELECT id FROM ranked WHERE row_number = 1) THEN 1
     ELSE 0
   END;

CREATE UNIQUE INDEX IF NOT EXISTS idx_follow_seller_cases_shop_sku_latest
  ON follow_seller_cases(shop_id, sku)
  WHERE is_latest = 1;

CREATE INDEX IF NOT EXISTS idx_follow_seller_cases_shop_latest_status
  ON follow_seller_cases(shop_id, is_latest, status, updated_at DESC);

PRAGMA user_version = 90;
