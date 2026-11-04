-- Profile-wide shared marketplace catalog.
--
-- The catalog identity deliberately has no shop_id.  A shop may be used as a
-- read credential while importing, but its identity is retained only as a
-- non-secret provenance summary.  Deleting that shop must therefore never
-- cascade into these tables.  Shop-specific user mappings remain in the
-- legacy catalog_category_mappings table created by migration 003.

CREATE TABLE IF NOT EXISTS shared_catalog_versions (
  catalog_id TEXT PRIMARY KEY,
  platform TEXT NOT NULL,
  marketplace TEXT NOT NULL,
  locale TEXT NOT NULL,
  contract_version TEXT NOT NULL,
  mapper_version TEXT NOT NULL,
  source_kind TEXT NOT NULL CHECK (source_kind IN ('remote', 'packaged_seed', 'legacy_migration', 'test')),
  content_hash TEXT,
  active_snapshot_id TEXT,
  source_summary_json TEXT NOT NULL DEFAULT '{}',
  last_seeded_at TEXT,
  last_synced_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (platform, marketplace, locale, contract_version)
);

CREATE TABLE IF NOT EXISTS shared_catalog_import_runs (
  import_id TEXT PRIMARY KEY,
  catalog_id TEXT NOT NULL,
  source_kind TEXT NOT NULL CHECK (source_kind IN ('remote', 'packaged_seed', 'legacy_migration', 'test')),
  source_shop_id TEXT,
  source_ref_hash TEXT NOT NULL,
  contract_version TEXT NOT NULL,
  mapper_version TEXT NOT NULL,
  payload_hash TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('running', 'completed', 'completed_with_conflicts', 'failed')),
  inserted_count INTEGER NOT NULL DEFAULT 0 CHECK (inserted_count >= 0),
  deduplicated_count INTEGER NOT NULL DEFAULT 0 CHECK (deduplicated_count >= 0),
  replaced_count INTEGER NOT NULL DEFAULT 0 CHECK (replaced_count >= 0),
  quarantined_count INTEGER NOT NULL DEFAULT 0 CHECK (quarantined_count >= 0),
  error_json TEXT,
  started_at TEXT NOT NULL,
  completed_at TEXT,
  FOREIGN KEY (catalog_id) REFERENCES shared_catalog_versions(catalog_id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS shared_catalog_categories (
  catalog_id TEXT NOT NULL,
  category_id TEXT NOT NULL,
  parent_category_id TEXT,
  name TEXT NOT NULL,
  level INTEGER NOT NULL DEFAULT 0 CHECK (level >= 0),
  is_disabled INTEGER NOT NULL DEFAULT 0 CHECK (is_disabled IN (0, 1)),
  content_hash TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  first_seen_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL,
  PRIMARY KEY (catalog_id, category_id),
  FOREIGN KEY (catalog_id) REFERENCES shared_catalog_versions(catalog_id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS shared_catalog_types (
  catalog_id TEXT NOT NULL,
  category_id TEXT NOT NULL,
  type_id TEXT NOT NULL,
  name TEXT NOT NULL,
  is_disabled INTEGER NOT NULL DEFAULT 0 CHECK (is_disabled IN (0, 1)),
  content_hash TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  first_seen_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL,
  PRIMARY KEY (catalog_id, category_id, type_id),
  FOREIGN KEY (catalog_id) REFERENCES shared_catalog_versions(catalog_id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS shared_catalog_attributes (
  catalog_id TEXT NOT NULL,
  category_id TEXT NOT NULL,
  type_id TEXT NOT NULL,
  attribute_id TEXT NOT NULL,
  name TEXT NOT NULL,
  description TEXT,
  group_name TEXT,
  value_type TEXT,
  is_required INTEGER NOT NULL DEFAULT 0 CHECK (is_required IN (0, 1)),
  is_collection INTEGER NOT NULL DEFAULT 0 CHECK (is_collection IN (0, 1)),
  is_dictionary INTEGER NOT NULL DEFAULT 0 CHECK (is_dictionary IN (0, 1)),
  content_hash TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  first_seen_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL,
  PRIMARY KEY (catalog_id, category_id, type_id, attribute_id),
  FOREIGN KEY (catalog_id) REFERENCES shared_catalog_versions(catalog_id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS shared_catalog_attribute_values (
  catalog_id TEXT NOT NULL,
  category_id TEXT NOT NULL,
  type_id TEXT NOT NULL,
  attribute_id TEXT NOT NULL,
  value_id TEXT NOT NULL,
  value_text TEXT NOT NULL,
  info TEXT,
  content_hash TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  first_seen_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL,
  PRIMARY KEY (catalog_id, category_id, type_id, attribute_id, value_id),
  FOREIGN KEY (catalog_id) REFERENCES shared_catalog_versions(catalog_id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS shared_catalog_entity_sources (
  catalog_id TEXT NOT NULL,
  entity_kind TEXT NOT NULL CHECK (entity_kind IN ('category', 'type', 'attribute', 'value')),
  stable_key TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  source_kind TEXT NOT NULL CHECK (source_kind IN ('remote', 'packaged_seed', 'legacy_migration', 'test')),
  source_shop_id TEXT,
  source_ref_hash TEXT NOT NULL,
  import_id TEXT NOT NULL,
  observed_at TEXT NOT NULL,
  PRIMARY KEY (catalog_id, entity_kind, stable_key, content_hash, source_ref_hash),
  FOREIGN KEY (catalog_id) REFERENCES shared_catalog_versions(catalog_id) ON DELETE CASCADE,
  FOREIGN KEY (import_id) REFERENCES shared_catalog_import_runs(import_id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS shared_catalog_quarantine (
  quarantine_id TEXT PRIMARY KEY,
  catalog_id TEXT NOT NULL,
  entity_kind TEXT NOT NULL CHECK (entity_kind IN ('category', 'type', 'attribute', 'value')),
  stable_key TEXT NOT NULL,
  reason TEXT NOT NULL CHECK (reason IN ('stable_key_content_conflict', 'invalid_legacy_row')),
  existing_content_hash TEXT,
  incoming_content_hash TEXT NOT NULL,
  existing_payload_json TEXT,
  incoming_payload_json TEXT NOT NULL,
  source_kind TEXT NOT NULL CHECK (source_kind IN ('remote', 'packaged_seed', 'legacy_migration', 'test')),
  source_shop_id TEXT,
  source_ref_hash TEXT NOT NULL,
  import_id TEXT NOT NULL,
  resolution_status TEXT NOT NULL DEFAULT 'pending' CHECK (resolution_status IN ('pending', 'accepted_existing', 'accepted_incoming', 'ignored')),
  detected_at TEXT NOT NULL,
  resolved_at TEXT,
  UNIQUE (catalog_id, entity_kind, stable_key, incoming_content_hash, source_ref_hash),
  FOREIGN KEY (catalog_id) REFERENCES shared_catalog_versions(catalog_id) ON DELETE CASCADE,
  FOREIGN KEY (import_id) REFERENCES shared_catalog_import_runs(import_id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_shared_catalog_identity
  ON shared_catalog_versions(platform, marketplace, locale, contract_version);
CREATE INDEX IF NOT EXISTS idx_shared_catalog_categories_parent
  ON shared_catalog_categories(catalog_id, parent_category_id, level, category_id);
CREATE INDEX IF NOT EXISTS idx_shared_catalog_types_lookup
  ON shared_catalog_types(catalog_id, type_id, category_id);
CREATE INDEX IF NOT EXISTS idx_shared_catalog_attributes_lookup
  ON shared_catalog_attributes(catalog_id, category_id, type_id, attribute_id);
CREATE INDEX IF NOT EXISTS idx_shared_catalog_values_lookup
  ON shared_catalog_attribute_values(catalog_id, attribute_id, value_text);
CREATE INDEX IF NOT EXISTS idx_shared_catalog_imports_source
  ON shared_catalog_import_runs(source_kind, source_shop_id, started_at);
CREATE INDEX IF NOT EXISTS idx_shared_catalog_quarantine_pending
  ON shared_catalog_quarantine(resolution_status, catalog_id, detected_at);

PRAGMA user_version = 59;
