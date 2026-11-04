CREATE TABLE IF NOT EXISTS follow_seller_login_preferences (
  shop_id TEXT PRIMARY KEY,
  profile_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (shop_id) REFERENCES shops(id) ON DELETE CASCADE,
  FOREIGN KEY (profile_id) REFERENCES integration_profiles(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_follow_seller_login_preferences_profile
  ON follow_seller_login_preferences(profile_id, updated_at DESC);

PRAGMA user_version = 88;
