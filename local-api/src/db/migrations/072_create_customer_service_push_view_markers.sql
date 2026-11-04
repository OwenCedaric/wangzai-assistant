CREATE TABLE IF NOT EXISTS customer_service_push_view_markers (
  shop_id TEXT NOT NULL,
  account_scope TEXT NOT NULL,
  chat_id TEXT NOT NULL,
  last_message_id TEXT NOT NULL DEFAULT '',
  last_message_at TEXT NOT NULL DEFAULT '',
  viewed_at TEXT NOT NULL,
  PRIMARY KEY (shop_id, account_scope, chat_id, last_message_id, last_message_at),
  FOREIGN KEY (shop_id) REFERENCES shops(id) ON DELETE CASCADE,
  CHECK (last_message_id <> '' OR last_message_at <> '')
);

CREATE INDEX IF NOT EXISTS idx_customer_service_push_view_markers_scope
  ON customer_service_push_view_markers(shop_id, account_scope, viewed_at DESC);

PRAGMA user_version = 72;
