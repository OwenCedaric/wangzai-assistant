ALTER TABLE ozon_marketing_activities ADD COLUMN date_start TEXT NOT NULL DEFAULT '';
ALTER TABLE ozon_marketing_activities ADD COLUMN date_end TEXT NOT NULL DEFAULT '';
ALTER TABLE ozon_marketing_activity_products ADD COLUMN ozon_sku TEXT NOT NULL DEFAULT '';

-- Historical marketing rows kept their typed values inside raw_json.  json_valid()
-- keeps a corrupt legacy payload from aborting the whole schema migration.
UPDATE ozon_marketing_activities
SET
  date_start = COALESCE(
    NULLIF(TRIM(date_start), ''),
    CASE WHEN json_valid(raw_json) THEN COALESCE(
      NULLIF(TRIM(CAST(json_extract(raw_json, '$.date_start') AS TEXT)), ''),
      NULLIF(TRIM(CAST(json_extract(raw_json, '$.dateStart') AS TEXT)), ''),
      NULLIF(TRIM(CAST(json_extract(raw_json, '$.start_at') AS TEXT)), ''),
      NULLIF(TRIM(CAST(json_extract(raw_json, '$.startAt') AS TEXT)), ''),
      NULLIF(TRIM(CAST(json_extract(raw_json, '$.start_date') AS TEXT)), ''),
      NULLIF(TRIM(CAST(json_extract(raw_json, '$.startDate') AS TEXT)), '')
    ) ELSE NULL END,
    ''
  ),
  date_end = COALESCE(
    NULLIF(TRIM(date_end), ''),
    CASE WHEN json_valid(raw_json) THEN COALESCE(
      NULLIF(TRIM(CAST(json_extract(raw_json, '$.date_end') AS TEXT)), ''),
      NULLIF(TRIM(CAST(json_extract(raw_json, '$.dateEnd') AS TEXT)), ''),
      NULLIF(TRIM(CAST(json_extract(raw_json, '$.end_at') AS TEXT)), ''),
      NULLIF(TRIM(CAST(json_extract(raw_json, '$.endAt') AS TEXT)), ''),
      NULLIF(TRIM(CAST(json_extract(raw_json, '$.end_date') AS TEXT)), ''),
      NULLIF(TRIM(CAST(json_extract(raw_json, '$.endDate') AS TEXT)), '')
    ) ELSE NULL END,
    ''
  );

UPDATE ozon_marketing_activity_products
SET ozon_sku = COALESCE(
  NULLIF(TRIM(ozon_sku), ''),
  CASE WHEN json_valid(raw_json) THEN COALESCE(
    NULLIF(TRIM(CAST(json_extract(raw_json, '$.ozon_sku') AS TEXT)), ''),
    NULLIF(TRIM(CAST(json_extract(raw_json, '$.ozonSku') AS TEXT)), ''),
    NULLIF(TRIM(CAST(json_extract(raw_json, '$.sku') AS TEXT)), '')
  ) ELSE NULL END,
  NULLIF(TRIM(sku), ''),
  ''
);

CREATE INDEX IF NOT EXISTS idx_ozon_marketing_activities_schedule
  ON ozon_marketing_activities(shop_id, source_type, date_end, date_start, updated_at DESC);

CREATE INDEX IF NOT EXISTS idx_ozon_marketing_activity_products_ozon_sku
  ON ozon_marketing_activity_products(shop_id, ozon_sku, updated_at DESC);

CREATE TABLE IF NOT EXISTS marketing_view_state (
  shop_id TEXT PRIMARY KEY,
  selected_activity_id TEXT NOT NULL DEFAULT '',
  selected_source_type TEXT NOT NULL DEFAULT '',
  product_scope TEXT NOT NULL DEFAULT 'joined',
  selected_product_ids_json TEXT NOT NULL DEFAULT '[]',
  cached_at TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CHECK (product_scope IN ('joined', 'available', 'all'))
);

CREATE INDEX IF NOT EXISTS idx_marketing_view_state_updated
  ON marketing_view_state(updated_at DESC);
