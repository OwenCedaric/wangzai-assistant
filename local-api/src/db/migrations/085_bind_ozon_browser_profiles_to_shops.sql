-- Every Ozon Seller browser profile owns an independent Cookie partition.
-- Bind that partition to one canonical shop so order links can never fall
-- back to whichever Seller account happened to be opened most recently.
ALTER TABLE integration_profiles ADD COLUMN shop_id TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS idx_integration_profiles_ozon_browser_shop
  ON integration_profiles(shop_id)
  WHERE integration_type = 'ozon-browser-session' AND shop_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_integration_profiles_type_shop_status
  ON integration_profiles(integration_type, shop_id, config_status, token_status, updated_at DESC);

-- A legacy browser profile can be backfilled only when its creation time has
-- exactly one possible shop.  Ambiguous profiles stay unbound and therefore
-- fail closed until the user chooses a shop in Settings.
UPDATE integration_profiles AS profile
SET shop_id = (
  SELECT shop.id
  FROM shops AS shop
  WHERE shop.status = 'active'
    AND shop.created_at <= profile.created_at
  ORDER BY shop.created_at DESC, shop.id ASC
  LIMIT 1
)
WHERE profile.integration_type = 'ozon-browser-session'
  AND profile.shop_id IS NULL
  AND (
    SELECT COUNT(*)
    FROM shops AS shop
    WHERE shop.status = 'active'
      AND shop.created_at <= profile.created_at
  ) = 1;

CREATE TRIGGER IF NOT EXISTS trg_integration_profiles_unbind_deleted_shop
AFTER DELETE ON shops
BEGIN
  UPDATE integration_profiles
  SET shop_id = NULL, updated_at = datetime('now')
  WHERE shop_id = OLD.id;
END;

PRAGMA user_version = 85;
