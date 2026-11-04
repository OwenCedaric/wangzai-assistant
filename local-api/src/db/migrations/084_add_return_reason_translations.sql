ALTER TABLE ozon_returns ADD COLUMN return_reason_zh TEXT;
ALTER TABLE ozon_returns ADD COLUMN return_reason_translation_status TEXT NOT NULL DEFAULT 'pending';
ALTER TABLE ozon_returns ADD COLUMN return_reason_translation_provider TEXT;
ALTER TABLE ozon_returns ADD COLUMN return_reason_translation_updated_at TEXT;

UPDATE ozon_returns
SET return_reason_translation_status = CASE
  WHEN return_reason IS NULL OR TRIM(return_reason) = '' THEN 'not_required'
  WHEN return_reason GLOB '*[А-Яа-яЁё]*' THEN 'pending'
  ELSE 'not_required'
END;

CREATE INDEX IF NOT EXISTS idx_ozon_returns_reason_translation
  ON ozon_returns(shop_id, return_reason_translation_status, updated_at DESC);

PRAGMA user_version = 84;
