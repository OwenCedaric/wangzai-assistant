CREATE TABLE IF NOT EXISTS recovery_local_state (
  id TEXT PRIMARY KEY CHECK (id = 'default'),
  keyset_encrypted TEXT NOT NULL,
  key_envelope_json TEXT NOT NULL,
  recovery_aad TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

PRAGMA user_version = 34;
