-- Non-Ozon account restores use the same encrypted .wzb package and profile
-- importer.  This table stores only irreversible owner references and public
-- verification summaries; package bytes, credentials and plaintext owner ids
-- are never persisted here.
CREATE TABLE data_backup_owner_imports (
  import_id TEXT PRIMARY KEY,
  source_backup_id TEXT NOT NULL,
  package_sha256 TEXT NOT NULL CHECK (
    length(package_sha256) = 64 AND package_sha256 NOT GLOB '*[^0-9a-f]*'
  ),
  source_data_fingerprint TEXT NOT NULL CHECK (
    length(source_data_fingerprint) = 64 AND source_data_fingerprint NOT GLOB '*[^0-9a-f]*'
  ),
  target_profile_id TEXT NOT NULL,
  owner_type TEXT NOT NULL,
  owner_ref TEXT NOT NULL CHECK (
    length(owner_ref) = 64 AND owner_ref NOT GLOB '*[^0-9a-f]*'
  ),
  owner_incarnation TEXT NOT NULL,
  strategy TEXT NOT NULL CHECK (strategy IN ('preserve', 'overwrite')),
  preflight_fingerprint TEXT NOT NULL CHECK (
    length(preflight_fingerprint) = 64 AND preflight_fingerprint NOT GLOB '*[^0-9a-f]*'
  ),
  result_data_fingerprint TEXT NOT NULL CHECK (
    length(result_data_fingerprint) = 64 AND result_data_fingerprint NOT GLOB '*[^0-9a-f]*'
  ),
  status TEXT NOT NULL CHECK (status IN ('completed', 'completed_with_skips')),
  domain_summary_json TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(domain_summary_json)),
  skipped_summary_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(skipped_summary_json)),
  created_at TEXT NOT NULL,
  completed_at TEXT NOT NULL
);

CREATE INDEX idx_data_backup_owner_imports_target_created
  ON data_backup_owner_imports(
    target_profile_id, owner_type, owner_ref, completed_at DESC, import_id
  );

CREATE INDEX idx_data_backup_owner_imports_source
  ON data_backup_owner_imports(source_backup_id, package_sha256, completed_at DESC);

PRAGMA user_version = 78;
