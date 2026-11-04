-- Account deletion removes large owner-scoped histories in one transaction.
-- SQLite scans the full child table for every deleted parent row when a foreign-key
-- column has no leading index. These indexes keep ON DELETE checks set-based and
-- prevent a normal account deletion from appearing frozen or timing out.
CREATE INDEX IF NOT EXISTS idx_ozon_error_events_job_id
  ON ozon_error_events(job_id);
CREATE INDEX IF NOT EXISTS idx_ozon_sync_snapshots_source_job_id
  ON ozon_sync_snapshots(source_job_id);
CREATE INDEX IF NOT EXISTS idx_ozon_notification_events_snapshot_id
  ON ozon_notification_events(snapshot_id);
CREATE INDEX IF NOT EXISTS idx_ozon_notification_events_source_attempt_id
  ON ozon_notification_events(source_attempt_id);
CREATE INDEX IF NOT EXISTS idx_ozon_notification_events_source_job_id
  ON ozon_notification_events(source_job_id);
CREATE INDEX IF NOT EXISTS idx_shop_domain_sync_state_bootstrap_run_id
  ON shop_domain_sync_state(bootstrap_run_id);
CREATE INDEX IF NOT EXISTS idx_product_sync_outbox_run_id
  ON product_sync_outbox(run_id);
CREATE INDEX IF NOT EXISTS idx_product_sync_quarantine_run_id
  ON product_sync_quarantine(run_id);
CREATE INDEX IF NOT EXISTS idx_product_image_usage_events_asset_id
  ON product_image_usage_events(asset_id);
CREATE INDEX IF NOT EXISTS idx_follow_seller_cases_product_identity_id
  ON follow_seller_cases(product_identity_id);

PRAGMA user_version = 93;
