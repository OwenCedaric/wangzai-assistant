ALTER TABLE product_warehouse_stock_facts
  ADD COLUMN warehouse_name TEXT;

ALTER TABLE product_warehouse_stock_facts
  ADD COLUMN sku TEXT;

ALTER TABLE product_warehouse_stock_facts
  ADD COLUMN free_quantity INTEGER
  CHECK (free_quantity IS NULL OR free_quantity >= 0);

-- SQLite cannot widen a CHECK constraint in place. Rebuild the observation
-- table so warehouse inventory has a first-class facet and can record
-- returned/not-returned/stale independently from the comprehensive stock
-- facet.
ALTER TABLE product_facet_observations
  RENAME TO product_facet_observations_before_067;

CREATE TABLE product_facet_observations (
  product_identity_id TEXT NOT NULL,
  shop_id TEXT NOT NULL,
  facet TEXT NOT NULL CHECK (facet IN (
    'identity', 'status', 'detail', 'dimensions', 'prices', 'commissions',
    'acquiring', 'stocks', 'warehouse_stocks', 'pictures', 'attributes'
  )),
  status TEXT NOT NULL CHECK (status IN (
    'pending', 'returned', 'returned_empty', 'not_applicable', 'unavailable',
    'not_returned', 'failed', 'contract_invalid', 'stale_previous'
  )),
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

INSERT INTO product_facet_observations (
  product_identity_id, shop_id, facet, status, operation_id, endpoint_key,
  contract_version, mapper_version, response_hash, run_id, snapshot_id,
  expected_at, observed_at, source_reason, row_hash, updated_at
)
SELECT product_identity_id, shop_id, facet, status, operation_id, endpoint_key,
       contract_version, mapper_version, response_hash, run_id, snapshot_id,
       expected_at, observed_at, source_reason, row_hash, updated_at
  FROM product_facet_observations_before_067;

DROP TABLE product_facet_observations_before_067;

CREATE INDEX idx_product_facet_observations_shop_status
  ON product_facet_observations(shop_id, facet, status, updated_at DESC);

PRAGMA user_version = 67;
