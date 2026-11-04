-- 浏览器兼容层只允许作为一次迁移输入。该运行态账本只保存读命中计数、时间和匿名会话标识，
-- 不保存 localStorage 的值、店铺数据或任何凭证，用于证明连续观察期内已没有旧路径命中。
CREATE TABLE IF NOT EXISTS legacy_browser_observation_days (
  profile_id TEXT NOT NULL,
  observed_on TEXT NOT NULL,
  first_observed_at TEXT NOT NULL,
  last_observed_at TEXT NOT NULL,
  session_count INTEGER NOT NULL DEFAULT 0 CHECK (session_count >= 0),
  read_hit_count INTEGER NOT NULL DEFAULT 0 CHECK (read_hit_count >= 0),
  PRIMARY KEY (profile_id, observed_on)
);

CREATE TABLE IF NOT EXISTS legacy_browser_read_key_days (
  profile_id TEXT NOT NULL,
  observed_on TEXT NOT NULL,
  legacy_key TEXT NOT NULL,
  first_seen_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL,
  hit_count INTEGER NOT NULL DEFAULT 0 CHECK (hit_count > 0),
  PRIMARY KEY (profile_id, observed_on, legacy_key)
);

-- 会话和批次表让启动心跳与失败重试可幂等，且只保留有限观察窗口。
CREATE TABLE IF NOT EXISTS legacy_browser_observation_sessions (
  profile_id TEXT NOT NULL,
  session_id TEXT NOT NULL,
  observed_on TEXT NOT NULL,
  first_observed_at TEXT NOT NULL,
  last_observed_at TEXT NOT NULL,
  PRIMARY KEY (profile_id, session_id)
);

CREATE TABLE IF NOT EXISTS legacy_browser_observation_batches (
  profile_id TEXT NOT NULL,
  batch_id TEXT NOT NULL,
  observed_on TEXT NOT NULL,
  recorded_at TEXT NOT NULL,
  PRIMARY KEY (profile_id, batch_id)
);

CREATE INDEX IF NOT EXISTS idx_legacy_browser_observation_days_window
  ON legacy_browser_observation_days(profile_id, observed_on);

CREATE INDEX IF NOT EXISTS idx_legacy_browser_read_key_days_window
  ON legacy_browser_read_key_days(profile_id, observed_on);

CREATE INDEX IF NOT EXISTS idx_legacy_browser_observation_sessions_window
  ON legacy_browser_observation_sessions(profile_id, observed_on);

CREATE INDEX IF NOT EXISTS idx_legacy_browser_observation_batches_window
  ON legacy_browser_observation_batches(profile_id, observed_on);

PRAGMA user_version = 51;
