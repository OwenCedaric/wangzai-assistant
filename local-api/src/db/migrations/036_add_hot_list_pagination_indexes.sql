-- Hot page queries always constrain shop_id + is_stale. Keep their default stable display order
-- index-backed so a large cache is not resorted in the renderer or a SQLite temp B-tree.
CREATE INDEX IF NOT EXISTS idx_ozon_products_shop_stale_display_order
  ON ozon_products(shop_id, is_stale, sort_index, product_id, offer_id, updated_at DESC);

CREATE INDEX IF NOT EXISTS idx_ozon_orders_shop_stale_display_order
  ON ozon_orders(
    shop_id,
    is_stale,
    COALESCE(in_process_at, updated_at) DESC,
    posting_number ASC,
    order_id ASC,
    id ASC
  );

PRAGMA user_version = 36;
