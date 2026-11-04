-- 利润页汇率属于可重建的 profile 缓存，避免与大 profit-local-cache.json 重复持久化。
CREATE TABLE IF NOT EXISTS exchange_rate_cache (
  requested_date TEXT PRIMARY KEY,
  mode TEXT NOT NULL,
  rate_date TEXT NOT NULL,
  nearest_fallback INTEGER NOT NULL DEFAULT 0 CHECK (nearest_fallback IN (0, 1)),
  lookback_days_used INTEGER,
  rub_to_cny_rate REAL NOT NULL CHECK (rub_to_cny_rate > 0),
  source TEXT,
  fetched_at TEXT,
  expires_at TEXT,
  immutable INTEGER NOT NULL DEFAULT 1 CHECK (immutable IN (0, 1)),
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_exchange_rate_cache_expires
  ON exchange_rate_cache(expires_at);

PRAGMA user_version = 49;
