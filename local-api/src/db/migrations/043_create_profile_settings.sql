CREATE TABLE IF NOT EXISTS profile_settings (
  namespace TEXT PRIMARY KEY,
  value_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_profile_settings_updated
  ON profile_settings(updated_at DESC, namespace ASC);
