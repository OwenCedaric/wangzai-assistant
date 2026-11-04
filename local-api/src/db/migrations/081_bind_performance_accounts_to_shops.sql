-- Performance credentials are account-owned, but every live read/write must
-- also be tied to the Ozon shop whose products and advertising data they own.
-- Existing accounts remain explicitly unbound until the user selects a shop;
-- guessing by insertion order would silently mix stores.
ALTER TABLE performance_accounts ADD COLUMN shop_id TEXT;

CREATE INDEX IF NOT EXISTS idx_performance_accounts_shop_status
  ON performance_accounts(shop_id, status, updated_at DESC);

CREATE TRIGGER IF NOT EXISTS trg_performance_accounts_unbind_deleted_shop
AFTER DELETE ON shops
BEGIN
  UPDATE performance_accounts
  SET shop_id = NULL, updated_at = datetime('now')
  WHERE shop_id = OLD.id;
END;

PRAGMA user_version = 81;
