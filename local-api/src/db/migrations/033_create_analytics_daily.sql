CREATE TABLE IF NOT EXISTS ozon_analytics_daily (
  id TEXT PRIMARY KEY,
  shop_id TEXT NOT NULL,
  report_date TEXT NOT NULL,
  revenue_rub REAL,
  ordered_units INTEGER,
  product_views INTEGER,
  cart_adds INTEGER,
  visitor_sessions INTEGER,
  metric_signature TEXT NOT NULL,
  raw_metrics_json TEXT NOT NULL DEFAULT '{}',
  remote_hash TEXT NOT NULL,
  is_stale INTEGER NOT NULL DEFAULT 0,
  last_seen_at TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(shop_id, report_date)
);

CREATE INDEX IF NOT EXISTS idx_ozon_analytics_daily_shop_date
  ON ozon_analytics_daily(shop_id, report_date DESC);
