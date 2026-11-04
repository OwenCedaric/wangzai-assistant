-- 商品补水不再用单一 synced_at 冒充整批覆盖。
-- 分面观察与佣金/收单来源跟随 ozon_products 一起按 shop_id 隔离、备份和删店。
ALTER TABLE ozon_products ADD COLUMN facet_observations_json TEXT;
ALTER TABLE ozon_products ADD COLUMN commission_percent_fbo REAL;
ALTER TABLE ozon_products ADD COLUMN commission_percent_fbs REAL;
ALTER TABLE ozon_products ADD COLUMN commission_percent_rfbs REAL;
ALTER TABLE ozon_products ADD COLUMN commission_percent_fbp REAL;
ALTER TABLE ozon_products ADD COLUMN commission_status TEXT;
ALTER TABLE ozon_products ADD COLUMN commission_provenance_json TEXT;
ALTER TABLE ozon_products ADD COLUMN acquiring_status TEXT;
ALTER TABLE ozon_products ADD COLUMN acquiring_provenance_json TEXT;

-- 旧版 markProductHydrationFacetChecked 会给未返回实体写 synced_at。
-- 只有相应 response hash 存在，才有足够证据把旧记录视为 returned。
UPDATE ozon_products SET detail_synced_at = NULL WHERE detail_hash IS NULL;
UPDATE ozon_products SET pictures_synced_at = NULL WHERE pictures_hash IS NULL;
UPDATE ozon_products SET prices_synced_at = NULL WHERE prices_hash IS NULL;
UPDATE ozon_products SET stocks_synced_at = NULL WHERE stocks_hash IS NULL;
UPDATE ozon_products SET attributes_synced_at = NULL WHERE attributes_hash IS NULL;

UPDATE ozon_products
SET hydrated_at = NULL
WHERE detail_synced_at IS NULL
   OR pictures_synced_at IS NULL
   OR prices_synced_at IS NULL
   OR stocks_synced_at IS NULL
   OR attributes_synced_at IS NULL;

-- Ozon 对部分下架商品会返回全 0 佣金占位。0 不是可证明费率，迁移为 unavailable，
-- 原始零值仍完整保留在 price_json，不能伪装成真实 0% 佣金。
UPDATE ozon_products
SET
  commission_percent_fbo = CASE
    WHEN CAST(json_extract(price_json, '$.commissions.sales_percent_fbo') AS REAL) > 0
      THEN CAST(json_extract(price_json, '$.commissions.sales_percent_fbo') AS REAL)
    ELSE NULL
  END,
  commission_percent_fbs = CASE
    WHEN CAST(json_extract(price_json, '$.commissions.sales_percent_fbs') AS REAL) > 0
      THEN CAST(json_extract(price_json, '$.commissions.sales_percent_fbs') AS REAL)
    ELSE NULL
  END,
  commission_percent_rfbs = CASE
    WHEN CAST(json_extract(price_json, '$.commissions.sales_percent_rfbs') AS REAL) > 0
      THEN CAST(json_extract(price_json, '$.commissions.sales_percent_rfbs') AS REAL)
    ELSE NULL
  END,
  commission_percent_fbp = CASE
    WHEN CAST(json_extract(price_json, '$.commissions.sales_percent_fbp') AS REAL) > 0
      THEN CAST(json_extract(price_json, '$.commissions.sales_percent_fbp') AS REAL)
    ELSE NULL
  END,
  commission_status = CASE
    WHEN COALESCE(
      CASE WHEN commission_percent > 0 THEN commission_percent END,
      CASE WHEN CAST(json_extract(price_json, '$.commissions.sales_percent_rfbs') AS REAL) > 0
        THEN CAST(json_extract(price_json, '$.commissions.sales_percent_rfbs') AS REAL) END,
      CASE WHEN CAST(json_extract(price_json, '$.commissions.sales_percent_fbs') AS REAL) > 0
        THEN CAST(json_extract(price_json, '$.commissions.sales_percent_fbs') AS REAL) END,
      CASE WHEN CAST(json_extract(price_json, '$.commissions.sales_percent_fbo') AS REAL) > 0
        THEN CAST(json_extract(price_json, '$.commissions.sales_percent_fbo') AS REAL) END,
      CASE WHEN CAST(json_extract(price_json, '$.commissions.sales_percent_fbp') AS REAL) > 0
        THEN CAST(json_extract(price_json, '$.commissions.sales_percent_fbp') AS REAL) END
    ) IS NOT NULL THEN 'returned'
    WHEN prices_hash IS NOT NULL AND json_type(price_json, '$.commissions') = 'object'
      THEN 'unavailable'
    WHEN prices_hash IS NOT NULL THEN 'not_returned'
    ELSE 'pending'
  END,
  commission_provenance_json = json_object(
    'status', CASE
      WHEN COALESCE(
        CASE WHEN commission_percent > 0 THEN commission_percent END,
        CASE WHEN CAST(json_extract(price_json, '$.commissions.sales_percent_rfbs') AS REAL) > 0
          THEN CAST(json_extract(price_json, '$.commissions.sales_percent_rfbs') AS REAL) END,
        CASE WHEN CAST(json_extract(price_json, '$.commissions.sales_percent_fbs') AS REAL) > 0
          THEN CAST(json_extract(price_json, '$.commissions.sales_percent_fbs') AS REAL) END,
        CASE WHEN CAST(json_extract(price_json, '$.commissions.sales_percent_fbo') AS REAL) > 0
          THEN CAST(json_extract(price_json, '$.commissions.sales_percent_fbo') AS REAL) END,
        CASE WHEN CAST(json_extract(price_json, '$.commissions.sales_percent_fbp') AS REAL) > 0
          THEN CAST(json_extract(price_json, '$.commissions.sales_percent_fbp') AS REAL) END
      ) IS NOT NULL THEN 'returned'
      WHEN prices_hash IS NOT NULL AND json_type(price_json, '$.commissions') = 'object'
        THEN 'unavailable'
      WHEN prices_hash IS NOT NULL THEN 'not_returned'
      ELSE 'pending'
    END,
    'endpointKey', 'products.prices',
    'contractVersion', 'ozon-products-prices-v5-legacy',
    'mapperVersion', 'product-price-mapper-v1-legacy',
    'responseHash', prices_hash,
    'observedAt', prices_synced_at,
    'sourceReason', CASE
      WHEN commission_percent <= 0 AND json_type(price_json, '$.commissions') = 'object'
        THEN 'legacy-ozon-zero-sentinel'
      WHEN prices_hash IS NULL THEN 'legacy-no-price-response-proof'
      ELSE 'legacy-price-response'
    END
  ),
  acquiring_status = CASE
    WHEN acquiring_fee_value > 0 OR acquiring_percent > 0 THEN 'returned'
    WHEN prices_hash IS NOT NULL AND (acquiring_fee_value = 0 OR acquiring_percent = 0)
      THEN 'unavailable'
    WHEN prices_hash IS NOT NULL THEN 'not_returned'
    ELSE 'pending'
  END,
  acquiring_provenance_json = json_object(
    'status', CASE
      WHEN acquiring_fee_value > 0 OR acquiring_percent > 0 THEN 'returned'
      WHEN prices_hash IS NOT NULL AND (acquiring_fee_value = 0 OR acquiring_percent = 0)
        THEN 'unavailable'
      WHEN prices_hash IS NOT NULL THEN 'not_returned'
      ELSE 'pending'
    END,
    'endpointKey', 'products.prices',
    'contractVersion', 'ozon-products-prices-v5-legacy',
    'mapperVersion', 'product-price-mapper-v1-legacy',
    'responseHash', prices_hash,
    'observedAt', prices_synced_at,
    'sourceReason', CASE
      WHEN acquiring_fee_value = 0 OR acquiring_percent = 0 THEN 'legacy-ozon-zero-sentinel'
      WHEN prices_hash IS NULL THEN 'legacy-no-price-response-proof'
      ELSE 'legacy-price-response'
    END
  );

UPDATE ozon_products
SET commission_percent = NULL
WHERE commission_percent IS NOT NULL AND commission_percent <= 0;

UPDATE ozon_products
SET acquiring_fee_value = NULL
WHERE acquiring_fee_value IS NOT NULL AND acquiring_fee_value <= 0;

UPDATE ozon_products
SET acquiring_percent = NULL
WHERE acquiring_percent IS NOT NULL AND acquiring_percent <= 0;

-- 修复“营销价 0 抢在真实 price 前面”的旧数据。只从 Ozon 原始 price_json 回填正价。
UPDATE ozon_products
SET price_value = COALESCE(
  CASE WHEN CAST(json_extract(price_json, '$.marketing_price') AS REAL) > 0
    THEN CAST(json_extract(price_json, '$.marketing_price') AS REAL) END,
  CASE WHEN CAST(json_extract(price_json, '$.marketing_seller_price') AS REAL) > 0
    THEN CAST(json_extract(price_json, '$.marketing_seller_price') AS REAL) END,
  CASE WHEN CAST(json_extract(price_json, '$.price') AS REAL) > 0
    THEN CAST(json_extract(price_json, '$.price') AS REAL) END,
  CASE WHEN CAST(json_extract(price_json, '$.old_price') AS REAL) > 0
    THEN CAST(json_extract(price_json, '$.old_price') AS REAL) END,
  price_value
)
WHERE (price_value IS NULL OR price_value <= 0) AND json_valid(price_json);

UPDATE ozon_products
SET facet_observations_json = json_object(
  'detail', json_object(
    'status', CASE WHEN detail_hash IS NOT NULL THEN 'returned' ELSE 'stale_previous' END,
    'endpointKey', 'products.infoList',
    'mapperVersion', 'product-detail-mapper-v1-legacy',
    'responseHash', detail_hash,
    'observedAt', detail_synced_at,
    'sourceReason', CASE WHEN detail_hash IS NOT NULL THEN 'legacy-response-hash' ELSE 'legacy-unproved-check' END
  ),
  'pictures', json_object(
    'status', CASE WHEN pictures_hash IS NOT NULL THEN 'returned' ELSE 'stale_previous' END,
    'endpointKey', 'products.pictures',
    'mapperVersion', 'product-pictures-mapper-v1-legacy',
    'responseHash', pictures_hash,
    'observedAt', pictures_synced_at,
    'sourceReason', CASE WHEN pictures_hash IS NOT NULL THEN 'legacy-response-hash' ELSE 'legacy-unproved-check' END
  ),
  'prices', json_object(
    'status', CASE WHEN prices_hash IS NOT NULL THEN 'returned' ELSE 'stale_previous' END,
    'endpointKey', 'products.prices',
    'contractVersion', 'ozon-products-prices-v5-legacy',
    'mapperVersion', 'product-price-mapper-v1-legacy',
    'responseHash', prices_hash,
    'observedAt', prices_synced_at,
    'sourceReason', CASE WHEN prices_hash IS NOT NULL THEN 'legacy-response-hash' ELSE 'legacy-unproved-check' END
  ),
  'stocks', json_object(
    'status', CASE WHEN stocks_hash IS NOT NULL THEN 'returned' ELSE 'stale_previous' END,
    'endpointKey', 'products.stocks',
    'mapperVersion', 'product-stock-mapper-v1-legacy',
    'responseHash', stocks_hash,
    'observedAt', stocks_synced_at,
    'sourceReason', CASE WHEN stocks_hash IS NOT NULL THEN 'legacy-response-hash' ELSE 'legacy-unproved-check' END
  ),
  'attributes', json_object(
    'status', CASE WHEN attributes_hash IS NOT NULL THEN 'returned' ELSE 'stale_previous' END,
    'endpointKey', 'products.attributes',
    'mapperVersion', 'product-attributes-mapper-v1-legacy',
    'responseHash', attributes_hash,
    'observedAt', attributes_synced_at,
    'sourceReason', CASE WHEN attributes_hash IS NOT NULL THEN 'legacy-response-hash' ELSE 'legacy-unproved-check' END
  )
);

PRAGMA user_version = 57;
