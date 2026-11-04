-- Old browser/file migration paths could persist cross-border order records
-- without an internal Ozon shop id.  Purchase overrides already carry the
-- canonical shop owner plus the exact CrossBorder order id, so use only a
-- unique, conflict-free match and leave every ambiguous row untouched.
DROP TABLE IF EXISTS temp._migration_082_cross_border_owner_candidates;

CREATE TEMP TABLE _migration_082_cross_border_owner_candidates (
  record_id TEXT PRIMARY KEY,
  shop_id TEXT NOT NULL
);

INSERT INTO _migration_082_cross_border_owner_candidates (record_id, shop_id)
WITH unique_owner_candidates AS (
  SELECT
    cross_border.id AS record_id,
    MIN(purchase.shop_id) AS shop_id,
    COUNT(DISTINCT purchase.shop_id) AS shop_count
  FROM cross_border_order_records AS cross_border
  JOIN purchase_order_overrides AS purchase
    ON purchase.shop_id IN (SELECT id FROM shops)
   AND json_valid(purchase.raw_json)
   AND (
     TRIM(CAST(json_extract(purchase.raw_json, '$.crossBorderOrderId') AS TEXT))
       IN (TRIM(COALESCE(cross_border.order_id, '')), TRIM(cross_border.record_key))
     OR TRIM(CAST(json_extract(purchase.raw_json, '$.packageOrderId') AS TEXT))
       IN (TRIM(COALESCE(cross_border.order_id, '')), TRIM(cross_border.record_key))
   )
  WHERE TRIM(cross_border.shop_id) = ''
    AND (TRIM(COALESCE(cross_border.order_id, '')) <> '' OR TRIM(cross_border.record_key) <> '')
  GROUP BY cross_border.id
  HAVING COUNT(DISTINCT purchase.shop_id) = 1
)
SELECT record_id, shop_id
FROM unique_owner_candidates
WHERE shop_count = 1;

-- A later canonical read may already have written the same record under the
-- correct owner.  Preserve that canonical row, fill only its missing fields,
-- then retire the duplicate ownerless row instead of violating the unique key.
UPDATE cross_border_order_records AS target
SET (
  order_id,
  platform_order,
  purchase_order_number,
  collection_number,
  tracking_number,
  logistics_order,
  sheet_order_sn,
  offer_id,
  sku,
  status,
  read_status,
  warehouse,
  route_name,
  package_weight_kg,
  length_cm,
  width_cm,
  height_cm,
  volume_items_json,
  status_json,
  out_info_json,
  raw_json,
  remote_hash,
  last_seen_at,
  created_at,
  updated_at
) = (
  SELECT
    COALESCE(NULLIF(TRIM(target.order_id), ''), source_row.order_id),
    COALESCE(NULLIF(TRIM(target.platform_order), ''), source_row.platform_order),
    COALESCE(NULLIF(TRIM(target.purchase_order_number), ''), source_row.purchase_order_number),
    COALESCE(NULLIF(TRIM(target.collection_number), ''), source_row.collection_number),
    COALESCE(NULLIF(TRIM(target.tracking_number), ''), source_row.tracking_number),
    COALESCE(NULLIF(TRIM(target.logistics_order), ''), source_row.logistics_order),
    COALESCE(NULLIF(TRIM(target.sheet_order_sn), ''), source_row.sheet_order_sn),
    COALESCE(NULLIF(TRIM(target.offer_id), ''), source_row.offer_id),
    COALESCE(NULLIF(TRIM(target.sku), ''), source_row.sku),
    COALESCE(NULLIF(TRIM(target.status), ''), source_row.status),
    COALESCE(NULLIF(TRIM(target.read_status), ''), source_row.read_status),
    COALESCE(NULLIF(TRIM(target.warehouse), ''), source_row.warehouse),
    COALESCE(NULLIF(TRIM(target.route_name), ''), source_row.route_name),
    COALESCE(target.package_weight_kg, source_row.package_weight_kg),
    COALESCE(target.length_cm, source_row.length_cm),
    COALESCE(target.width_cm, source_row.width_cm),
    COALESCE(target.height_cm, source_row.height_cm),
    COALESCE(NULLIF(TRIM(target.volume_items_json), ''), source_row.volume_items_json),
    COALESCE(NULLIF(TRIM(target.status_json), ''), source_row.status_json),
    COALESCE(NULLIF(TRIM(target.out_info_json), ''), source_row.out_info_json),
    COALESCE(NULLIF(TRIM(target.raw_json), ''), source_row.raw_json),
    COALESCE(NULLIF(TRIM(target.remote_hash), ''), source_row.remote_hash),
    COALESCE(NULLIF(TRIM(target.last_seen_at), ''), source_row.last_seen_at),
    MIN(target.created_at, source_row.created_at),
    MAX(target.updated_at, source_row.updated_at)
  FROM _migration_082_cross_border_owner_candidates AS candidate
  JOIN cross_border_order_records AS source_row
    ON source_row.id = candidate.record_id
  WHERE target.id <> source_row.id
    AND target.shop_id = candidate.shop_id
    AND target.record_key = source_row.record_key
)
WHERE EXISTS (
  SELECT 1
  FROM _migration_082_cross_border_owner_candidates AS candidate
  JOIN cross_border_order_records AS source_row
    ON source_row.id = candidate.record_id
  WHERE target.id <> source_row.id
    AND target.shop_id = candidate.shop_id
    AND target.record_key = source_row.record_key
);

DELETE FROM cross_border_order_records
WHERE id IN (
  SELECT candidate.record_id
  FROM _migration_082_cross_border_owner_candidates AS candidate
  JOIN cross_border_order_records AS source_row
    ON source_row.id = candidate.record_id
  WHERE EXISTS (
    SELECT 1
    FROM cross_border_order_records AS target
    WHERE target.id <> source_row.id
      AND target.shop_id = candidate.shop_id
      AND target.record_key = source_row.record_key
  )
);

UPDATE cross_border_order_records
SET
  shop_id = (
    SELECT candidate.shop_id
    FROM _migration_082_cross_border_owner_candidates AS candidate
    WHERE candidate.record_id = cross_border_order_records.id
  ),
  updated_at = datetime('now')
WHERE id IN (SELECT record_id FROM _migration_082_cross_border_owner_candidates);

DROP TABLE temp._migration_082_cross_border_owner_candidates;

PRAGMA user_version = 82;
