ALTER TABLE follow_seller_login_preferences
  RENAME TO follow_seller_login_preferences_v88;

CREATE TABLE follow_seller_login_preferences (
  preference_key TEXT PRIMARY KEY CHECK (preference_key = 'global'),
  profile_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (profile_id) REFERENCES integration_profiles(id) ON DELETE CASCADE
);

INSERT INTO follow_seller_login_preferences (
  preference_key,
  profile_id,
  created_at,
  updated_at
)
SELECT
  'global',
  preference.profile_id,
  preference.created_at,
  preference.updated_at
FROM follow_seller_login_preferences_v88 AS preference
JOIN integration_profiles AS profile ON profile.id = preference.profile_id
WHERE profile.integration_type = 'ozon-follow-seller-session'
ORDER BY preference.updated_at DESC
LIMIT 1;

DROP TABLE follow_seller_login_preferences_v88;

CREATE INDEX idx_follow_seller_login_preferences_profile
  ON follow_seller_login_preferences(profile_id, updated_at DESC);

UPDATE integration_profiles
SET shop_id = NULL
WHERE integration_type = 'ozon-follow-seller-session';

PRAGMA user_version = 89;
