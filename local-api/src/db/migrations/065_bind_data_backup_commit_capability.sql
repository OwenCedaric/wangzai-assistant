ALTER TABLE data_backup_exports
  ADD COLUMN commit_capability_hash TEXT;

ALTER TABLE data_backup_exports
  ADD COLUMN capability_consumed_at TEXT;

PRAGMA user_version = 65;
