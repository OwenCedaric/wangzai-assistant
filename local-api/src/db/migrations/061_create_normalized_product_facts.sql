CREATE TABLE IF NOT EXISTS product_identities (
  product_identity_id TEXT PRIMARY KEY,
  shop_id TEXT NOT NULL,
  product_id TEXT,
  offer_id TEXT,
  sku TEXT,
  source TEXT NOT NULL DEFAULT 'ozon' CHECK (source IN ('ozon', 'user', 'supplier', 'cross_border', 'system')),
  operation_id TEXT,
  contract_version TEXT,
  mapper_version TEXT NOT NULL,
  response_hash TEXT,
  run_id TEXT,
  snapshot_id TEXT,
  observed_at TEXT NOT NULL,
  source_updated_at TEXT,
  row_hash TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (shop_id) REFERENCES shops(id) ON DELETE CASCADE
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_product_identities_shop_product
  ON product_identities(shop_id, product_id) WHERE product_id IS NOT NULL AND product_id <> '';
CREATE UNIQUE INDEX IF NOT EXISTS idx_product_identities_shop_offer
  ON product_identities(shop_id, offer_id) WHERE offer_id IS NOT NULL AND offer_id <> '';
CREATE INDEX IF NOT EXISTS idx_product_identities_shop_sku
  ON product_identities(shop_id, sku);

CREATE TABLE IF NOT EXISTS product_status_facts (
  product_identity_id TEXT PRIMARY KEY,
  shop_id TEXT NOT NULL,
  visibility TEXT NOT NULL,
  status_label TEXT,
  is_stale INTEGER NOT NULL DEFAULT 0 CHECK (is_stale IN (0, 1)),
  snapshot_visibilities_json TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(snapshot_visibilities_json)),
  operation_id TEXT,
  contract_version TEXT,
  mapper_version TEXT NOT NULL,
  response_hash TEXT,
  run_id TEXT,
  snapshot_id TEXT,
  observed_at TEXT NOT NULL,
  row_hash TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (product_identity_id) REFERENCES product_identities(product_identity_id) ON DELETE CASCADE,
  FOREIGN KEY (shop_id) REFERENCES shops(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS product_detail_facts (
  product_identity_id TEXT PRIMARY KEY,
  shop_id TEXT NOT NULL,
  name TEXT,
  category_id TEXT,
  category_name TEXT,
  type_id TEXT,
  operation_id TEXT,
  contract_version TEXT,
  mapper_version TEXT NOT NULL,
  response_hash TEXT,
  run_id TEXT,
  snapshot_id TEXT,
  observed_at TEXT NOT NULL,
  row_hash TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (product_identity_id) REFERENCES product_identities(product_identity_id) ON DELETE CASCADE,
  FOREIGN KEY (shop_id) REFERENCES shops(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS product_dimension_facts (
  product_identity_id TEXT NOT NULL,
  shop_id TEXT NOT NULL,
  source_type TEXT NOT NULL CHECK (source_type IN ('ozon', 'user', 'supplier', 'cross_border')),
  source_priority INTEGER NOT NULL CHECK (source_priority >= 0),
  weight_g INTEGER CHECK (weight_g IS NULL OR weight_g >= 0),
  length_mm INTEGER CHECK (length_mm IS NULL OR length_mm >= 0),
  width_mm INTEGER CHECK (width_mm IS NULL OR width_mm >= 0),
  height_mm INTEGER CHECK (height_mm IS NULL OR height_mm >= 0),
  operation_id TEXT,
  contract_version TEXT,
  mapper_version TEXT NOT NULL,
  response_hash TEXT,
  run_id TEXT,
  snapshot_id TEXT,
  observed_at TEXT NOT NULL,
  row_hash TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (product_identity_id, source_type),
  FOREIGN KEY (product_identity_id) REFERENCES product_identities(product_identity_id) ON DELETE CASCADE,
  FOREIGN KEY (shop_id) REFERENCES shops(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_product_dimensions_shop_priority
  ON product_dimension_facts(shop_id, product_identity_id, source_priority DESC);

CREATE TABLE IF NOT EXISTS product_price_facts (
  product_identity_id TEXT PRIMARY KEY,
  shop_id TEXT NOT NULL,
  price_type TEXT NOT NULL DEFAULT 'seller',
  amount_minor INTEGER,
  currency_code TEXT,
  operation_id TEXT,
  contract_version TEXT,
  mapper_version TEXT NOT NULL,
  response_hash TEXT,
  run_id TEXT,
  snapshot_id TEXT,
  observed_at TEXT NOT NULL,
  row_hash TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (product_identity_id) REFERENCES product_identities(product_identity_id) ON DELETE CASCADE,
  FOREIGN KEY (shop_id) REFERENCES shops(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS product_commission_facts (
  product_identity_id TEXT NOT NULL,
  shop_id TEXT NOT NULL,
  fulfillment_type TEXT NOT NULL CHECK (fulfillment_type IN ('FBO', 'FBS', 'RFBS', 'FBP')),
  rate_ppm INTEGER CHECK (rate_ppm IS NULL OR (rate_ppm > 0 AND rate_ppm <= 1000000)),
  status TEXT NOT NULL CHECK (status IN ('pending', 'returned', 'returned_empty', 'not_applicable', 'unavailable', 'not_returned', 'failed', 'contract_invalid', 'stale_previous')),
  operation_id TEXT,
  contract_version TEXT,
  mapper_version TEXT NOT NULL,
  response_hash TEXT,
  run_id TEXT,
  snapshot_id TEXT,
  observed_at TEXT NOT NULL,
  source_reason TEXT,
  row_hash TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (product_identity_id, fulfillment_type),
  FOREIGN KEY (product_identity_id) REFERENCES product_identities(product_identity_id) ON DELETE CASCADE,
  FOREIGN KEY (shop_id) REFERENCES shops(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS product_acquiring_facts (
  product_identity_id TEXT PRIMARY KEY,
  shop_id TEXT NOT NULL,
  fee_minor INTEGER,
  currency_code TEXT,
  rate_ppm INTEGER CHECK (rate_ppm IS NULL OR (rate_ppm > 0 AND rate_ppm <= 1000000)),
  status TEXT NOT NULL CHECK (status IN ('pending', 'returned', 'returned_empty', 'not_applicable', 'unavailable', 'not_returned', 'failed', 'contract_invalid', 'stale_previous')),
  operation_id TEXT,
  contract_version TEXT,
  mapper_version TEXT NOT NULL,
  response_hash TEXT,
  run_id TEXT,
  snapshot_id TEXT,
  observed_at TEXT NOT NULL,
  source_reason TEXT,
  row_hash TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (product_identity_id) REFERENCES product_identities(product_identity_id) ON DELETE CASCADE,
  FOREIGN KEY (shop_id) REFERENCES shops(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS product_stock_facts (
  product_identity_id TEXT PRIMARY KEY,
  shop_id TEXT NOT NULL,
  present_quantity INTEGER CHECK (present_quantity IS NULL OR present_quantity >= 0),
  status TEXT NOT NULL CHECK (status IN ('pending', 'returned', 'returned_empty', 'not_applicable', 'unavailable', 'not_returned', 'failed', 'contract_invalid', 'stale_previous')),
  operation_id TEXT,
  contract_version TEXT,
  mapper_version TEXT NOT NULL,
  response_hash TEXT,
  run_id TEXT,
  snapshot_id TEXT,
  observed_at TEXT NOT NULL,
  source_reason TEXT,
  row_hash TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (product_identity_id) REFERENCES product_identities(product_identity_id) ON DELETE CASCADE,
  FOREIGN KEY (shop_id) REFERENCES shops(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS product_warehouse_stock_facts (
  product_identity_id TEXT NOT NULL,
  shop_id TEXT NOT NULL,
  warehouse_key TEXT NOT NULL,
  warehouse_id TEXT,
  fulfillment_type TEXT,
  present_quantity INTEGER NOT NULL CHECK (present_quantity >= 0),
  reserved_quantity INTEGER CHECK (reserved_quantity IS NULL OR reserved_quantity >= 0),
  operation_id TEXT,
  contract_version TEXT,
  mapper_version TEXT NOT NULL,
  response_hash TEXT,
  run_id TEXT,
  snapshot_id TEXT,
  observed_at TEXT NOT NULL,
  row_hash TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (product_identity_id, warehouse_key),
  FOREIGN KEY (product_identity_id) REFERENCES product_identities(product_identity_id) ON DELETE CASCADE,
  FOREIGN KEY (shop_id) REFERENCES shops(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS product_image_facts (
  product_identity_id TEXT NOT NULL,
  shop_id TEXT NOT NULL,
  image_index INTEGER NOT NULL CHECK (image_index >= 0),
  image_url TEXT NOT NULL,
  is_primary INTEGER NOT NULL DEFAULT 0 CHECK (is_primary IN (0, 1)),
  operation_id TEXT,
  contract_version TEXT,
  mapper_version TEXT NOT NULL,
  response_hash TEXT,
  run_id TEXT,
  snapshot_id TEXT,
  observed_at TEXT NOT NULL,
  row_hash TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (product_identity_id, image_index),
  FOREIGN KEY (product_identity_id) REFERENCES product_identities(product_identity_id) ON DELETE CASCADE,
  FOREIGN KEY (shop_id) REFERENCES shops(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS product_attribute_facts (
  product_identity_id TEXT PRIMARY KEY,
  shop_id TEXT NOT NULL,
  attributes_json TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(attributes_json)),
  operation_id TEXT,
  contract_version TEXT,
  mapper_version TEXT NOT NULL,
  response_hash TEXT,
  run_id TEXT,
  snapshot_id TEXT,
  observed_at TEXT NOT NULL,
  row_hash TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (product_identity_id) REFERENCES product_identities(product_identity_id) ON DELETE CASCADE,
  FOREIGN KEY (shop_id) REFERENCES shops(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS product_facet_observations (
  product_identity_id TEXT NOT NULL,
  shop_id TEXT NOT NULL,
  facet TEXT NOT NULL CHECK (facet IN ('identity', 'status', 'detail', 'dimensions', 'prices', 'commissions', 'acquiring', 'stocks', 'pictures', 'attributes')),
  status TEXT NOT NULL CHECK (status IN ('pending', 'returned', 'returned_empty', 'not_applicable', 'unavailable', 'not_returned', 'failed', 'contract_invalid', 'stale_previous')),
  operation_id TEXT,
  endpoint_key TEXT,
  contract_version TEXT,
  mapper_version TEXT NOT NULL,
  response_hash TEXT,
  run_id TEXT,
  snapshot_id TEXT,
  expected_at TEXT,
  observed_at TEXT NOT NULL,
  source_reason TEXT,
  row_hash TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (product_identity_id, facet),
  FOREIGN KEY (product_identity_id) REFERENCES product_identities(product_identity_id) ON DELETE CASCADE,
  FOREIGN KEY (shop_id) REFERENCES shops(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_product_facet_observations_shop_status
  ON product_facet_observations(shop_id, facet, status, updated_at DESC);

-- Additive legacy backfill. Runtime dual-write is owned by productCanonicalFactRepository;
-- ozon_products remains the compatibility read model until shadow parity is proven.
INSERT OR IGNORE INTO product_identities (
  product_identity_id, shop_id, product_id, offer_id, sku, source,
  mapper_version, response_hash, observed_at, row_hash, created_at, updated_at
)
SELECT id, shop_id, product_id, offer_id, sku, 'ozon',
       'legacy-product-row-v1', remote_hash, last_seen_at, remote_hash, created_at, updated_at
  FROM ozon_products;

INSERT OR REPLACE INTO product_status_facts (
  product_identity_id, shop_id, visibility, status_label, is_stale,
  snapshot_visibilities_json, mapper_version, response_hash, observed_at, row_hash, updated_at
)
SELECT id, shop_id, visibility, status_label, is_stale,
       CASE WHEN json_valid(snapshot_visibilities_json) THEN snapshot_visibilities_json ELSE '[]' END,
       'legacy-product-status-v1', remote_hash, last_seen_at,
       remote_hash || ':status', updated_at
  FROM ozon_products;

INSERT OR REPLACE INTO product_detail_facts (
  product_identity_id, shop_id, name, category_id, category_name, type_id,
  mapper_version, response_hash, observed_at, row_hash, updated_at
)
SELECT id, shop_id, name, category_id, category_name, type_id,
       'legacy-product-detail-v1', COALESCE(detail_hash, remote_hash),
       COALESCE(detail_synced_at, last_seen_at), COALESCE(detail_hash, remote_hash), updated_at
  FROM ozon_products;

INSERT OR REPLACE INTO product_dimension_facts (
  product_identity_id, shop_id, source_type, source_priority,
  weight_g, length_mm, width_mm, height_mm,
  mapper_version, response_hash, observed_at, row_hash, updated_at
)
SELECT id, shop_id, 'ozon', 10,
       CASE WHEN weight_kg IS NULL THEN NULL ELSE CAST(ROUND(weight_kg * 1000.0) AS INTEGER) END,
       CASE WHEN depth_cm IS NULL THEN NULL ELSE CAST(ROUND(depth_cm * 10.0) AS INTEGER) END,
       CASE WHEN width_cm IS NULL THEN NULL ELSE CAST(ROUND(width_cm * 10.0) AS INTEGER) END,
       CASE WHEN height_cm IS NULL THEN NULL ELSE CAST(ROUND(height_cm * 10.0) AS INTEGER) END,
       'legacy-product-dimensions-v1', COALESCE(detail_hash, attributes_hash, remote_hash),
       COALESCE(detail_synced_at, attributes_synced_at, last_seen_at),
       COALESCE(detail_hash, attributes_hash, remote_hash) || ':dimensions', updated_at
  FROM ozon_products
 WHERE weight_kg IS NOT NULL OR depth_cm IS NOT NULL OR width_cm IS NOT NULL OR height_cm IS NOT NULL;

INSERT OR REPLACE INTO product_price_facts (
  product_identity_id, shop_id, price_type, amount_minor, currency_code,
  mapper_version, response_hash, observed_at, row_hash, updated_at
)
SELECT id, shop_id, 'seller',
       CASE WHEN price_value IS NULL THEN NULL ELSE CAST(ROUND(price_value * 100.0) AS INTEGER) END,
       currency_code, 'legacy-product-price-v1', COALESCE(prices_hash, remote_hash),
       COALESCE(prices_synced_at, last_seen_at), COALESCE(prices_hash, remote_hash), updated_at
  FROM ozon_products;

INSERT OR REPLACE INTO product_commission_facts (
  product_identity_id, shop_id, fulfillment_type, rate_ppm, status,
  mapper_version, response_hash, observed_at, source_reason, row_hash, updated_at
)
SELECT id, shop_id, fulfillment_type,
       CASE WHEN rate_percent IS NULL THEN NULL ELSE CAST(ROUND(rate_percent * 10000.0) AS INTEGER) END,
       CASE WHEN rate_percent > 0 THEN COALESCE(NULLIF(commission_status, ''), 'returned') ELSE COALESCE(NULLIF(commission_status, ''), 'unavailable') END,
       'legacy-product-commission-v1', COALESCE(prices_hash, remote_hash),
       COALESCE(prices_synced_at, last_seen_at), 'legacy-normalized-backfill',
       COALESCE(prices_hash, remote_hash) || ':' || fulfillment_type, updated_at
  FROM ozon_products
  JOIN (
    SELECT 'FBO' AS fulfillment_type, commission_percent_fbo AS rate_percent, id AS source_id FROM ozon_products
    UNION ALL SELECT 'FBS', commission_percent_fbs, id FROM ozon_products
    UNION ALL SELECT 'RFBS', commission_percent_rfbs, id FROM ozon_products
    UNION ALL SELECT 'FBP', commission_percent_fbp, id FROM ozon_products
  ) AS modes ON modes.source_id = ozon_products.id
 WHERE rate_percent > 0 OR commission_status IS NOT NULL;

INSERT OR REPLACE INTO product_acquiring_facts (
  product_identity_id, shop_id, fee_minor, currency_code, rate_ppm, status,
  mapper_version, response_hash, observed_at, source_reason, row_hash, updated_at
)
SELECT id, shop_id,
       CASE WHEN acquiring_fee_value IS NULL THEN NULL ELSE CAST(ROUND(acquiring_fee_value * 100.0) AS INTEGER) END,
       currency_code,
       CASE WHEN acquiring_percent IS NULL THEN NULL ELSE CAST(ROUND(acquiring_percent * 10000.0) AS INTEGER) END,
       COALESCE(NULLIF(acquiring_status, ''), CASE WHEN acquiring_percent > 0 OR acquiring_fee_value > 0 THEN 'returned' ELSE 'unavailable' END),
       'legacy-product-acquiring-v1', COALESCE(fee_hash, prices_hash, remote_hash),
       COALESCE(fee_synced_at, prices_synced_at, last_seen_at), 'legacy-normalized-backfill',
       COALESCE(fee_hash, prices_hash, remote_hash), updated_at
  FROM ozon_products;

INSERT OR REPLACE INTO product_stock_facts (
  product_identity_id, shop_id, present_quantity, status,
  mapper_version, response_hash, observed_at, source_reason, row_hash, updated_at
)
SELECT id, shop_id, stock_value,
       CASE WHEN stock_value IS NULL THEN 'unavailable' ELSE 'returned' END,
       'legacy-product-stock-v1', COALESCE(stocks_hash, remote_hash),
       COALESCE(stocks_synced_at, last_seen_at),
       CASE WHEN stock_value = 0 THEN 'ozon-explicit-zero-stock' ELSE 'legacy-normalized-backfill' END,
       COALESCE(stocks_hash, remote_hash), updated_at
  FROM ozon_products;

INSERT OR REPLACE INTO product_attribute_facts (
  product_identity_id, shop_id, attributes_json,
  mapper_version, response_hash, observed_at, row_hash, updated_at
)
SELECT id, shop_id,
       CASE WHEN json_valid(attributes_json) THEN attributes_json ELSE '[]' END,
       'legacy-product-attributes-v1', COALESCE(attributes_hash, remote_hash),
       COALESCE(attributes_synced_at, last_seen_at), COALESCE(attributes_hash, remote_hash), updated_at
  FROM ozon_products;

INSERT OR REPLACE INTO product_image_facts (
  product_identity_id, shop_id, image_index, image_url, is_primary,
  mapper_version, response_hash, observed_at, row_hash, updated_at
)
SELECT product.id, product.shop_id, CAST(image.key AS INTEGER), CAST(image.value AS TEXT),
       CASE WHEN CAST(image.key AS INTEGER) = 0 THEN 1 ELSE 0 END,
       'legacy-product-pictures-v1', COALESCE(product.pictures_hash, product.remote_hash),
       COALESCE(product.pictures_synced_at, product.last_seen_at),
       COALESCE(product.pictures_hash, product.remote_hash) || ':' || image.key, product.updated_at
  FROM ozon_products AS product,
       json_each(CASE WHEN json_valid(product.images_json) THEN product.images_json ELSE '[]' END) AS image
 WHERE trim(CAST(image.value AS TEXT)) <> '';

INSERT OR REPLACE INTO product_facet_observations (
  product_identity_id, shop_id, facet, status, operation_id, endpoint_key,
  contract_version, mapper_version, response_hash, run_id, snapshot_id,
  expected_at, observed_at, source_reason, row_hash, updated_at
)
SELECT product.id, product.shop_id, facet.key,
       COALESCE(NULLIF(json_extract(facet.value, '$.status'), ''), 'pending'),
       json_extract(facet.value, '$.operationId'), json_extract(facet.value, '$.endpointKey'),
       json_extract(facet.value, '$.contractVersion'),
       COALESCE(NULLIF(json_extract(facet.value, '$.mapperVersion'), ''), 'legacy-facet-v1'),
       json_extract(facet.value, '$.responseHash'), json_extract(facet.value, '$.runId'),
       json_extract(facet.value, '$.snapshotId'), json_extract(facet.value, '$.expectedAt'),
       COALESCE(NULLIF(json_extract(facet.value, '$.observedAt'), ''), product.last_seen_at),
       json_extract(facet.value, '$.sourceReason'),
       COALESCE(NULLIF(json_extract(facet.value, '$.responseHash'), ''), product.remote_hash) || ':' || facet.key,
       product.updated_at
  FROM ozon_products AS product,
       json_each(CASE WHEN json_valid(product.facet_observations_json) THEN product.facet_observations_json ELSE '{}' END) AS facet
 WHERE facet.key IN ('detail', 'prices', 'stocks', 'pictures', 'attributes');

PRAGMA user_version = 61;
