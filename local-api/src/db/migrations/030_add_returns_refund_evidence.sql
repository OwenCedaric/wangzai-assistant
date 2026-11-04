ALTER TABLE ozon_returns ADD COLUMN refund_status TEXT;
ALTER TABLE ozon_returns ADD COLUMN refund_time TEXT;
ALTER TABLE ozon_returns ADD COLUMN refund_json TEXT;

CREATE INDEX IF NOT EXISTS idx_ozon_returns_shop_refund_status ON ozon_returns(shop_id, refund_status);

PRAGMA user_version = 30;
