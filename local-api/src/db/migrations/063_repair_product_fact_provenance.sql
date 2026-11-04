-- Repair the additive legacy backfill without changing the compatibility row.
-- A zero emitted by the legacy prices contract is an unavailable sentinel, not
-- a real 0% commission.  A field absent from that contract is not_returned.
UPDATE product_commission_facts AS fact
   SET contract_version = COALESCE(
         NULLIF(json_extract(product.commission_provenance_json, '$.contractVersion'), ''),
         fact.contract_version
       ),
       mapper_version = COALESCE(
         NULLIF(json_extract(product.commission_provenance_json, '$.mapperVersion'), ''),
         fact.mapper_version
       ),
       response_hash = COALESCE(
         NULLIF(json_extract(product.commission_provenance_json, '$.responseHash'), ''),
         fact.response_hash
       ),
       observed_at = COALESCE(
         NULLIF(json_extract(product.commission_provenance_json, '$.observedAt'), ''),
         fact.observed_at
       ),
       status = CASE
         WHEN fact.rate_ppm IS NOT NULL THEN 'returned'
         WHEN CASE fact.fulfillment_type
           WHEN 'FBO' THEN json_type(product.price_json, '$.commissions.sales_percent_fbo')
           WHEN 'FBS' THEN json_type(product.price_json, '$.commissions.sales_percent_fbs')
           WHEN 'RFBS' THEN json_type(product.price_json, '$.commissions.sales_percent_rfbs')
           WHEN 'FBP' THEN json_type(product.price_json, '$.commissions.sales_percent_fbp')
         END IS NULL THEN 'not_returned'
         WHEN CASE fact.fulfillment_type
           WHEN 'FBO' THEN json_extract(product.price_json, '$.commissions.sales_percent_fbo')
           WHEN 'FBS' THEN json_extract(product.price_json, '$.commissions.sales_percent_fbs')
           WHEN 'RFBS' THEN json_extract(product.price_json, '$.commissions.sales_percent_rfbs')
           WHEN 'FBP' THEN json_extract(product.price_json, '$.commissions.sales_percent_fbp')
         END = 0 THEN 'unavailable'
         ELSE 'contract_invalid'
       END,
       source_reason = CASE
         WHEN fact.rate_ppm IS NOT NULL THEN COALESCE(
           NULLIF(json_extract(product.commission_provenance_json, '$.sourceReason'), ''),
           'ozon-direct-commission'
         )
         WHEN CASE fact.fulfillment_type
           WHEN 'FBO' THEN json_type(product.price_json, '$.commissions.sales_percent_fbo')
           WHEN 'FBS' THEN json_type(product.price_json, '$.commissions.sales_percent_fbs')
           WHEN 'RFBS' THEN json_type(product.price_json, '$.commissions.sales_percent_rfbs')
           WHEN 'FBP' THEN json_type(product.price_json, '$.commissions.sales_percent_fbp')
         END IS NULL THEN 'ozon-contract-field-not-returned'
         WHEN CASE fact.fulfillment_type
           WHEN 'FBO' THEN json_extract(product.price_json, '$.commissions.sales_percent_fbo')
           WHEN 'FBS' THEN json_extract(product.price_json, '$.commissions.sales_percent_fbs')
           WHEN 'RFBS' THEN json_extract(product.price_json, '$.commissions.sales_percent_rfbs')
           WHEN 'FBP' THEN json_extract(product.price_json, '$.commissions.sales_percent_fbp')
         END = 0 THEN COALESCE(
           NULLIF(json_extract(product.commission_provenance_json, '$.sourceReason'), ''),
           'legacy-ozon-zero-sentinel'
         )
         ELSE 'ozon-contract-invalid-commission'
       END,
       updated_at = MAX(fact.updated_at, product.updated_at)
  FROM ozon_products AS product
 WHERE product.id = fact.product_identity_id
   AND fact.mapper_version = 'legacy-product-commission-v1';

UPDATE product_commission_facts
   SET row_hash = COALESCE(response_hash, 'no-response-hash')
                  || ':' || fulfillment_type || ':' || status
 WHERE product_identity_id IN (SELECT id FROM ozon_products);

UPDATE product_acquiring_facts AS fact
   SET contract_version = COALESCE(
         NULLIF(json_extract(product.acquiring_provenance_json, '$.contractVersion'), ''),
         fact.contract_version
       ),
       mapper_version = COALESCE(
         NULLIF(json_extract(product.acquiring_provenance_json, '$.mapperVersion'), ''),
         fact.mapper_version
       ),
       response_hash = COALESCE(
         NULLIF(json_extract(product.acquiring_provenance_json, '$.responseHash'), ''),
         fact.response_hash
       ),
       observed_at = COALESCE(
         NULLIF(json_extract(product.acquiring_provenance_json, '$.observedAt'), ''),
         fact.observed_at
       ),
       source_reason = COALESCE(
         NULLIF(json_extract(product.acquiring_provenance_json, '$.sourceReason'), ''),
         fact.source_reason
       ),
       updated_at = MAX(fact.updated_at, product.updated_at)
  FROM ozon_products AS product
 WHERE product.id = fact.product_identity_id
   AND fact.mapper_version = 'legacy-product-acquiring-v1';

UPDATE product_acquiring_facts
   SET row_hash = COALESCE(response_hash, 'no-response-hash') || ':' || status
 WHERE product_identity_id IN (SELECT id FROM ozon_products);

-- Explicit [] from products.stocks is valid empty.  Missing endpoint proof stays
-- pending and can never be converted into a synthetic zero.
UPDATE product_stock_facts AS fact
   SET status = CASE
         WHEN fact.present_quantity IS NOT NULL THEN 'returned'
         WHEN product.stocks_hash IS NULL AND product.stocks_synced_at IS NULL THEN 'pending'
         WHEN json_type(product.stock_json, '$.stocks') = 'array'
              AND json_array_length(product.stock_json, '$.stocks') = 0 THEN 'returned_empty'
         WHEN json_type(product.stock_json, '$.stocks') = 'array' THEN 'contract_invalid'
         ELSE 'not_returned'
       END,
       source_reason = CASE
         WHEN fact.present_quantity = 0 THEN 'ozon-explicit-zero-stock'
         WHEN product.stocks_hash IS NULL AND product.stocks_synced_at IS NULL THEN 'legacy-no-stock-response-proof'
         WHEN json_type(product.stock_json, '$.stocks') = 'array'
              AND json_array_length(product.stock_json, '$.stocks') = 0 THEN 'ozon-explicit-empty-stocks'
         WHEN json_type(product.stock_json, '$.stocks') = 'array' THEN 'ozon-stock-contract-invalid'
         ELSE 'ozon-stock-entity-not-returned'
       END,
       updated_at = MAX(fact.updated_at, product.updated_at)
  FROM ozon_products AS product
 WHERE product.id = fact.product_identity_id
   AND fact.mapper_version = 'legacy-product-stock-v1';

UPDATE product_stock_facts
   SET row_hash = COALESCE(response_hash, 'no-response-hash') || ':' || status
 WHERE product_identity_id IN (SELECT id FROM ozon_products);

-- Every normalized legacy product receives a closed facet ledger.  Existing
-- endpoint observations win; these inserts only fill missing facets.
INSERT OR IGNORE INTO product_facet_observations (
  product_identity_id, shop_id, facet, status, endpoint_key, mapper_version,
  response_hash, observed_at, source_reason, row_hash, updated_at
)
SELECT identity.product_identity_id, identity.shop_id, 'identity', 'returned',
       'products.list', 'legacy-product-identity-v1', identity.response_hash,
       identity.observed_at, 'legacy-normalized-backfill',
       identity.row_hash || ':identity', identity.updated_at
  FROM product_identities AS identity;

INSERT OR IGNORE INTO product_facet_observations (
  product_identity_id, shop_id, facet, status, endpoint_key, mapper_version,
  response_hash, observed_at, source_reason, row_hash, updated_at
)
SELECT status.product_identity_id, status.shop_id, 'status', 'returned',
       'products.list', 'legacy-product-status-v1', status.response_hash,
       status.observed_at, 'legacy-normalized-backfill',
       status.row_hash || ':facet', status.updated_at
  FROM product_status_facts AS status;

INSERT OR IGNORE INTO product_facet_observations (
  product_identity_id, shop_id, facet, status, endpoint_key, mapper_version,
  response_hash, observed_at, source_reason, row_hash, updated_at
)
SELECT identity.product_identity_id, identity.shop_id, 'dimensions',
       CASE WHEN dimension.product_identity_id IS NULL THEN 'pending' ELSE 'returned' END,
       'products.infoList', 'legacy-product-dimensions-v1', dimension.response_hash,
       COALESCE(dimension.observed_at, identity.observed_at),
       CASE WHEN dimension.product_identity_id IS NULL THEN 'legacy-dimensions-not-observed'
            ELSE 'legacy-normalized-backfill' END,
       identity.row_hash || ':dimensions',
       COALESCE(dimension.updated_at, identity.updated_at)
  FROM product_identities AS identity
  LEFT JOIN product_dimension_facts AS dimension
    ON dimension.product_identity_id = identity.product_identity_id
   AND dimension.source_type = 'ozon';

INSERT OR IGNORE INTO product_facet_observations (
  product_identity_id, shop_id, facet, status, endpoint_key, contract_version,
  mapper_version, response_hash, observed_at, source_reason, row_hash, updated_at
)
SELECT identity.product_identity_id, identity.shop_id, 'commissions',
       CASE
         WHEN EXISTS (SELECT 1 FROM product_commission_facts AS c WHERE c.product_identity_id = identity.product_identity_id AND c.status = 'returned') THEN 'returned'
         WHEN EXISTS (SELECT 1 FROM product_commission_facts AS c WHERE c.product_identity_id = identity.product_identity_id AND c.status = 'contract_invalid') THEN 'contract_invalid'
         WHEN EXISTS (SELECT 1 FROM product_commission_facts AS c WHERE c.product_identity_id = identity.product_identity_id AND c.status = 'unavailable') THEN 'unavailable'
         ELSE 'not_returned'
       END,
       'products.prices',
       (SELECT MAX(c.contract_version) FROM product_commission_facts AS c WHERE c.product_identity_id = identity.product_identity_id),
       COALESCE((SELECT MAX(c.mapper_version) FROM product_commission_facts AS c WHERE c.product_identity_id = identity.product_identity_id), 'legacy-product-commission-v1'),
       (SELECT MAX(c.response_hash) FROM product_commission_facts AS c WHERE c.product_identity_id = identity.product_identity_id),
       COALESCE((SELECT MAX(c.observed_at) FROM product_commission_facts AS c WHERE c.product_identity_id = identity.product_identity_id), identity.observed_at),
       CASE
         WHEN EXISTS (SELECT 1 FROM product_commission_facts AS c WHERE c.product_identity_id = identity.product_identity_id AND c.status = 'unavailable') THEN 'legacy-ozon-zero-sentinel'
         ELSE 'ozon-contract-field-not-returned'
       END,
       identity.row_hash || ':commissions', identity.updated_at
  FROM product_identities AS identity;

INSERT OR IGNORE INTO product_facet_observations (
  product_identity_id, shop_id, facet, status, endpoint_key, contract_version,
  mapper_version, response_hash, observed_at, source_reason, row_hash, updated_at
)
SELECT fact.product_identity_id, fact.shop_id, 'acquiring', fact.status,
       'products.prices', fact.contract_version, fact.mapper_version,
       fact.response_hash, fact.observed_at, fact.source_reason,
       fact.row_hash || ':facet', fact.updated_at
  FROM product_acquiring_facts AS fact;

INSERT OR IGNORE INTO product_facet_observations (
  product_identity_id, shop_id, facet, status, endpoint_key, mapper_version,
  response_hash, observed_at, source_reason, row_hash, updated_at
)
SELECT fact.product_identity_id, fact.shop_id, 'stocks', fact.status,
       'products.stocks', fact.mapper_version, fact.response_hash,
       fact.observed_at, fact.source_reason,
       fact.row_hash || ':facet', fact.updated_at
  FROM product_stock_facts AS fact;

-- Repair the 061 legacy stock observation that recorded a mapped empty entity
-- as generic returned.
UPDATE product_facet_observations AS observation
   SET status = fact.status,
       source_reason = fact.source_reason,
       row_hash = fact.row_hash || ':facet',
       updated_at = MAX(observation.updated_at, fact.updated_at)
  FROM product_stock_facts AS fact
 WHERE observation.product_identity_id = fact.product_identity_id
   AND observation.facet = 'stocks'
   AND observation.mapper_version LIKE '%legacy%';

PRAGMA user_version = 63;
