-- The legacy browser snapshot contains a presentation tone in addition to the
-- typed activity fields. Keep that tiny value with the activity so a restored
-- local snapshot does not need to infer it from an omitted raw payload.
ALTER TABLE ozon_marketing_activities ADD COLUMN source_tone TEXT NOT NULL DEFAULT '';

-- The original view-state row kept only the selected activity. A legacy
-- browser snapshot also contains the four compact summary counters, and those
-- counters must survive a recovery without depending on raw_json.
ALTER TABLE marketing_view_state ADD COLUMN activity_total INTEGER NOT NULL DEFAULT 0;
ALTER TABLE marketing_view_state ADD COLUMN joined_activity_total INTEGER NOT NULL DEFAULT 0;
ALTER TABLE marketing_view_state ADD COLUMN joined_product_total INTEGER NOT NULL DEFAULT 0;
ALTER TABLE marketing_view_state ADD COLUMN issue_product_total INTEGER NOT NULL DEFAULT 0;

CREATE INDEX IF NOT EXISTS idx_marketing_view_state_shop_updated
  ON marketing_view_state(shop_id, updated_at DESC);
