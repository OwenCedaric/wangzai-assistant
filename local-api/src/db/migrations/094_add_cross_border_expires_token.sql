ALTER TABLE cross_border_accounts ADD COLUMN expires_token_encrypted TEXT;

PRAGMA user_version = 94;
