ALTER TABLE shops ADD COLUMN profile_id TEXT NOT NULL DEFAULT 'default';
ALTER TABLE shops ADD COLUMN external_identity_hash TEXT;
ALTER TABLE shops ADD COLUMN shop_incarnation TEXT NOT NULL DEFAULT 'legacy';
ALTER TABLE shops ADD COLUMN credential_revision INTEGER NOT NULL DEFAULT 1 CHECK (credential_revision >= 1);
ALTER TABLE shops ADD COLUMN bound_at TEXT;
ALTER TABLE shops ADD COLUMN disabled_at TEXT;

-- Existing rows receive a deterministic, non-secret generation marker. The
-- application repository replaces legacy/missing external identity hashes with
-- SHA-256 after the SQL migration because stock SQLite has no SHA-256 function.
UPDATE shops
SET
  profile_id = CASE
    WHEN trim(COALESCE(profile_id, '')) = '' THEN 'default'
    ELSE trim(profile_id)
  END,
  shop_incarnation = CASE
    WHEN trim(COALESCE(shop_incarnation, '')) IN ('', 'legacy') THEN 'legacy:' || id
    ELSE trim(shop_incarnation)
  END,
  credential_revision = CASE
    WHEN credential_revision IS NULL OR credential_revision < 1 THEN 1
    ELSE credential_revision
  END,
  bound_at = COALESCE(NULLIF(trim(bound_at), ''), created_at, datetime('now')),
  disabled_at = CASE
    WHEN status = 'disabled' THEN COALESCE(NULLIF(trim(disabled_at), ''), updated_at, created_at, datetime('now'))
    ELSE NULL
  END;

CREATE UNIQUE INDEX IF NOT EXISTS idx_shops_profile_external_identity
  ON shops(profile_id, external_identity_hash)
  WHERE external_identity_hash IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS idx_shops_profile_id
  ON shops(profile_id, id);

CREATE INDEX IF NOT EXISTS idx_shops_profile_status
  ON shops(profile_id, status, updated_at DESC);

-- Direct restore/import writers cannot bypass external Ozon identity
-- uniqueness while the cryptographic hash is awaiting repository backfill.
-- Existing ambiguous legacy rows are preserved for quarantine; only new drift
-- is rejected.
CREATE TRIGGER IF NOT EXISTS trg_shops_external_identity_before_insert
BEFORE INSERT ON shops
WHEN NEW.client_id IS NOT NULL AND trim(NEW.client_id) <> ''
  AND EXISTS (
    SELECT 1 FROM shops
    WHERE profile_id = NEW.profile_id
      AND id <> NEW.id
      AND lower(trim(client_id)) = lower(trim(NEW.client_id))
  )
BEGIN
  SELECT RAISE(ABORT, 'SHOP_EXTERNAL_IDENTITY_ALREADY_BOUND');
END;

CREATE TRIGGER IF NOT EXISTS trg_shops_external_identity_before_update
BEFORE UPDATE OF profile_id, client_id ON shops
WHEN NEW.client_id IS NOT NULL AND trim(NEW.client_id) <> ''
  AND EXISTS (
    SELECT 1 FROM shops
    WHERE profile_id = NEW.profile_id
      AND id <> NEW.id
      AND lower(trim(client_id)) = lower(trim(NEW.client_id))
  )
BEGIN
  SELECT RAISE(ABORT, 'SHOP_EXTERNAL_IDENTITY_ALREADY_BOUND');
END;

-- Compatibility guard for controlled restore/import code that still writes the
-- shops table directly. Repository writes provide their own UUID incarnation;
-- direct inserts receive a collision-resistant generation instead of sharing
-- the ALTER TABLE placeholder value.
CREATE TRIGGER IF NOT EXISTS trg_shops_identity_defaults_after_insert
AFTER INSERT ON shops
WHEN NEW.shop_incarnation = 'legacy' OR NEW.bound_at IS NULL
BEGIN
  UPDATE shops
  SET
    shop_incarnation = CASE
      WHEN NEW.shop_incarnation = 'legacy' THEN 'inc_sql_' || lower(hex(randomblob(16)))
      ELSE NEW.shop_incarnation
    END,
    bound_at = COALESCE(NEW.bound_at, NEW.created_at, datetime('now')),
    disabled_at = CASE
      WHEN NEW.status = 'disabled' THEN COALESCE(NEW.disabled_at, NEW.updated_at, NEW.created_at, datetime('now'))
      ELSE NEW.disabled_at
    END
  WHERE id = NEW.id;
END;

CREATE TRIGGER IF NOT EXISTS trg_shops_disabled_at_after_update
AFTER UPDATE OF status ON shops
WHEN NEW.status = 'disabled' AND NEW.disabled_at IS NULL
BEGIN
  UPDATE shops
  SET disabled_at = COALESCE(NEW.updated_at, NEW.created_at, datetime('now'))
  WHERE id = NEW.id;
END;

CREATE TABLE IF NOT EXISTS shop_identity_tombstones (
  tombstone_id TEXT PRIMARY KEY,
  profile_id TEXT NOT NULL,
  former_shop_id TEXT NOT NULL,
  external_identity_hash TEXT,
  former_shop_incarnation TEXT NOT NULL,
  final_credential_revision INTEGER NOT NULL CHECK (final_credential_revision >= 1),
  deletion_operation_id TEXT NOT NULL,
  deletion_reason TEXT NOT NULL DEFAULT 'permanent_delete',
  metadata_json TEXT NOT NULL DEFAULT '{}',
  deleted_at TEXT NOT NULL,
  created_at TEXT NOT NULL,
  CHECK (json_valid(metadata_json)),
  UNIQUE (profile_id, former_shop_id, former_shop_incarnation),
  UNIQUE (deletion_operation_id)
);

CREATE INDEX IF NOT EXISTS idx_shop_identity_tombstones_external
  ON shop_identity_tombstones(profile_id, external_identity_hash, deleted_at DESC);

CREATE TABLE IF NOT EXISTS shop_bootstrap_runs (
  run_id TEXT PRIMARY KEY,
  profile_id TEXT NOT NULL,
  shop_id TEXT NOT NULL,
  shop_incarnation TEXT NOT NULL,
  credential_revision INTEGER NOT NULL CHECK (credential_revision >= 1),
  reason TEXT NOT NULL CHECK (reason IN ('initial_bind', 'rebind', 'credential_rotation', 'manual_full', 'restore_reconcile')),
  status TEXT NOT NULL DEFAULT 'queued' CHECK (
    status IN (
      'queued', 'running', 'verifying', 'completed', 'completed_with_source_gaps',
      'partial', 'failed', 'interrupted', 'cancelled', 'invalid'
    )
  ),
  required_domains_json TEXT NOT NULL DEFAULT '[]',
  completed_domains_json TEXT NOT NULL DEFAULT '[]',
  source_gaps_json TEXT NOT NULL DEFAULT '[]',
  proof_hash TEXT,
  last_error_code TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  started_at TEXT,
  completed_at TEXT,
  CHECK (json_valid(required_domains_json)),
  CHECK (json_valid(completed_domains_json)),
  CHECK (json_valid(source_gaps_json)),
  FOREIGN KEY (profile_id, shop_id) REFERENCES shops(profile_id, id) ON DELETE CASCADE
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_shop_bootstrap_runs_singleflight
  ON shop_bootstrap_runs(profile_id, shop_id)
  WHERE status IN ('queued', 'running', 'verifying');

CREATE INDEX IF NOT EXISTS idx_shop_bootstrap_runs_resume
  ON shop_bootstrap_runs(status, updated_at, profile_id, shop_id);

CREATE TABLE IF NOT EXISTS shop_domain_sync_state (
  profile_id TEXT NOT NULL,
  shop_id TEXT NOT NULL,
  shop_incarnation TEXT NOT NULL,
  credential_revision INTEGER NOT NULL CHECK (credential_revision >= 1),
  domain TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (
    status IN (
      'pending', 'syncing', 'completed', 'completed_with_source_gaps',
      'partial', 'failed', 'interrupted', 'invalid'
    )
  ),
  bootstrap_run_id TEXT,
  active_snapshot_id TEXT,
  committed_cursor TEXT,
  proof_hash TEXT,
  last_error_code TEXT,
  last_attempt_at TEXT,
  last_success_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (profile_id, shop_id, shop_incarnation, domain),
  FOREIGN KEY (profile_id, shop_id) REFERENCES shops(profile_id, id) ON DELETE CASCADE,
  FOREIGN KEY (bootstrap_run_id) REFERENCES shop_bootstrap_runs(run_id) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS idx_shop_domain_sync_state_current
  ON shop_domain_sync_state(profile_id, shop_id, shop_incarnation, status, domain);

PRAGMA user_version = 58;
