-- A Cross-Border Bus login can serve more than one Ozon shop. Keep the
-- relationship normalized instead of putting one shop_id on the account row.
ALTER TABLE cross_border_accounts ADD COLUMN tenant_id TEXT NOT NULL DEFAULT 'tenant_local_default';
ALTER TABLE cross_border_accounts ADD COLUMN user_id TEXT NOT NULL DEFAULT 'user_local_default';
ALTER TABLE cross_border_accounts ADD COLUMN profile_id TEXT NOT NULL DEFAULT 'default';

ALTER TABLE cross_border_charge_records ADD COLUMN cross_border_account_id TEXT NOT NULL DEFAULT '';
ALTER TABLE cross_border_charge_links ADD COLUMN cross_border_account_id TEXT NOT NULL DEFAULT '';

CREATE TABLE IF NOT EXISTS cross_border_account_shop_bindings (
  tenant_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  profile_id TEXT NOT NULL,
  account_id TEXT NOT NULL,
  shop_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (tenant_id, user_id, profile_id, account_id, shop_id),
  FOREIGN KEY (account_id) REFERENCES cross_border_accounts(id) ON DELETE CASCADE,
  FOREIGN KEY (shop_id) REFERENCES shops(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_cross_border_account_shop_bindings_account
  ON cross_border_account_shop_bindings(
    tenant_id, user_id, profile_id, account_id, updated_at DESC
  );

CREATE INDEX IF NOT EXISTS idx_cross_border_account_shop_bindings_shop
  ON cross_border_account_shop_bindings(
    tenant_id, user_id, profile_id, shop_id, updated_at DESC
  );

CREATE INDEX IF NOT EXISTS idx_cross_border_charge_links_account_scope
  ON cross_border_charge_links(
    tenant_id, user_id, profile_id, cross_border_account_id, shop_id, updated_at DESC
  );

PRAGMA user_version = 76;
