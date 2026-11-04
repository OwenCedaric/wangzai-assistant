ALTER TABLE cross_border_accounts ADD COLUMN authorization_ref_encrypted TEXT;
ALTER TABLE cross_border_accounts ADD COLUMN authorization_expires_at TEXT;

PRAGMA user_version = 111;
