ALTER TABLE shops ADD COLUMN ozon_push_binding_id TEXT;
ALTER TABLE shops ADD COLUMN ozon_push_binding_mode TEXT;
ALTER TABLE shops ADD COLUMN ozon_push_public_base_url TEXT;
ALTER TABLE shops ADD COLUMN ozon_push_status TEXT;
ALTER TABLE shops ADD COLUMN ozon_push_created_at TEXT;
ALTER TABLE shops ADD COLUMN ozon_push_rotated_at TEXT;
ALTER TABLE shops ADD COLUMN ozon_push_last_received_at TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS idx_shops_ozon_push_binding_id
ON shops(ozon_push_binding_id)
WHERE trim(COALESCE(ozon_push_binding_id, '')) <> '';

