-- Canonical purchase completion evidence belongs to the Ozon shop, not to the
-- disposable purchase login that happened to submit the order.  Source task,
-- receipt and account references are deliberately retained as non-FK evidence
-- so deleting a purchase account cannot cascade through completed history.
CREATE TABLE IF NOT EXISTS purchase_completion_history (
  shop_id TEXT NOT NULL,
  source_task_id TEXT NOT NULL,
  source_receipt_id TEXT NOT NULL UNIQUE,
  source_account_ref_hash TEXT NOT NULL,
  order_number_hash TEXT NOT NULL,
  receipt_encrypted TEXT NOT NULL,
  receipt_hash TEXT NOT NULL,
  website_readback_hash TEXT NOT NULL,
  order_product_encrypted TEXT NOT NULL,
  order_product_hash TEXT NOT NULL,
  source_summary_encrypted TEXT NOT NULL,
  source_summary_hash TEXT NOT NULL,
  archive_origin TEXT NOT NULL,
  completed_at TEXT NOT NULL,
  archived_at TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (shop_id, source_receipt_id),
  UNIQUE (source_receipt_id),
  FOREIGN KEY (shop_id) REFERENCES shops(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_purchase_completion_history_shop_completed
  ON purchase_completion_history(shop_id, completed_at DESC, source_receipt_id DESC);

CREATE INDEX IF NOT EXISTS idx_purchase_completion_history_shop_order_hash
  ON purchase_completion_history(shop_id, order_number_hash);

CREATE INDEX IF NOT EXISTS idx_purchase_completion_history_receipt_hash
  ON purchase_completion_history(receipt_hash);

PRAGMA user_version = 62;
