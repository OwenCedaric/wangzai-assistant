-- A saved Cookie is not enough to prove that the Seller browser belongs to
-- the same shop as the configured Ozon Seller API credentials. Persist the
-- non-secret Ozon company identity and require a fresh API readback before a
-- shop-scoped browser profile becomes connected.
ALTER TABLE integration_profiles ADD COLUMN browser_company_id TEXT;
ALTER TABLE integration_profiles ADD COLUMN browser_company_name TEXT;
ALTER TABLE integration_profiles ADD COLUMN api_identity_id TEXT;
ALTER TABLE integration_profiles ADD COLUMN identity_status TEXT;
ALTER TABLE integration_profiles ADD COLUMN identity_source TEXT;
ALTER TABLE integration_profiles ADD COLUMN identity_verified_at TEXT;

UPDATE integration_profiles
SET identity_status = 'unverified',
    config_status = CASE
      WHEN config_status = '连接成功' THEN '待核对'
      ELSE config_status
    END
WHERE integration_type = 'ozon-browser-session';

CREATE INDEX IF NOT EXISTS idx_integration_profiles_ozon_identity
  ON integration_profiles(
    integration_type,
    shop_id,
    identity_status,
    browser_company_id,
    api_identity_id
  );

PRAGMA user_version = 91;
