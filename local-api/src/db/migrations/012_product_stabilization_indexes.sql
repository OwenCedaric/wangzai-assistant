-- 商品模块稳定化：只补索引和 response_cache 清理辅助索引，不复制商品摘要大表。
CREATE INDEX IF NOT EXISTS idx_ozon_products_shop_stale_visibility_status
  ON ozon_products(shop_id, is_stale, visibility, status_label, sort_index, product_id, offer_id);

CREATE INDEX IF NOT EXISTS idx_ozon_products_aggregate_stale_visibility
  ON ozon_products(is_stale, visibility, status_label, sort_index, product_id, offer_id);

CREATE INDEX IF NOT EXISTS idx_ozon_response_cache_endpoint_updated
  ON ozon_response_cache(endpoint_key, updated_at);

CREATE INDEX IF NOT EXISTS idx_ozon_response_cache_expires
  ON ozon_response_cache(expires_at);

PRAGMA user_version = 12;
