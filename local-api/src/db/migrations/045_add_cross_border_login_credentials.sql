ALTER TABLE cross_border_accounts ADD COLUMN user_name_encrypted TEXT;
ALTER TABLE cross_border_accounts ADD COLUMN password_encrypted TEXT;

PRAGMA user_version = 45;
