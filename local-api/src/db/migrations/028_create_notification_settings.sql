CREATE TABLE IF NOT EXISTS ozon_notification_settings (
  id TEXT PRIMARY KEY,
  shop_id TEXT,
  shop_scope TEXT NOT NULL DEFAULT 'all',
  domain TEXT NOT NULL,
  event_type TEXT NOT NULL DEFAULT '*',
  enabled INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(shop_scope, domain, event_type),
  FOREIGN KEY (shop_id) REFERENCES shops(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_ozon_notification_settings_scope
  ON ozon_notification_settings(shop_scope, domain, event_type);

PRAGMA user_version = 28;
