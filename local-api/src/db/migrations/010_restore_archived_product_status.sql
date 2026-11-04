-- Hydration must not turn archived products into stock-derived statuses.
-- If a row was ever read through the ARCHIVED snapshot, keep it as archived unless a later explicit list sync changes that scope.
UPDATE ozon_products
SET visibility = 'ARCHIVED',
    status_label = '已下架'
WHERE snapshot_visibilities_json LIKE '%"ARCHIVED"%';

PRAGMA user_version = 10;
