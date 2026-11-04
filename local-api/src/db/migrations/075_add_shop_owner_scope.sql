-- Bind every Ozon shop to the local tenant/user/profile that owns it.
-- The profile remains the physical SQLite partition; tenant/user are the
-- request scope used by multi-user deployments and charge imports.
ALTER TABLE shops ADD COLUMN tenant_id TEXT NOT NULL DEFAULT 'tenant_local_default';
ALTER TABLE shops ADD COLUMN user_id TEXT NOT NULL DEFAULT 'user_local_default';

-- Legacy profiles already have a stable profile id.  Use it as the owner user
-- when the old row did not carry an explicit owner, while preserving the
-- local-default compatibility profile.
UPDATE shops
SET user_id = CASE
  WHEN trim(COALESCE(profile_id, '')) <> '' AND trim(profile_id) <> 'default'
    THEN trim(profile_id)
  ELSE 'user_local_default'
END
WHERE trim(COALESCE(user_id, '')) IN ('', 'user_local_default');

CREATE INDEX IF NOT EXISTS idx_shops_owner_scope
  ON shops(tenant_id, user_id, profile_id, updated_at DESC, name ASC);

PRAGMA user_version = 75;
