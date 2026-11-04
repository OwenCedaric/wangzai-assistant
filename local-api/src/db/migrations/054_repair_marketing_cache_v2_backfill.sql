-- 053 introduced compact summary counters, but rows created by earlier schemas
-- received SQLite's zero defaults rather than a real marketing summary.  Keep a
-- small provenance bit so the repository can derive those historical summaries
-- from canonical facts until the next explicit view-state write.
ALTER TABLE marketing_view_state
  ADD COLUMN summary_initialized INTEGER NOT NULL DEFAULT 0
  CHECK (summary_initialized IN (0, 1));

-- source_tone was previously present only in the rehydratable raw payload.  The
-- recovery exporter intentionally excludes raw_json from optional marketing
-- chunks, so copy the known presentation value into its typed column before an
-- existing database can be exported or compacted.
UPDATE ozon_marketing_activities
SET source_tone = COALESCE(
  NULLIF(TRIM(source_tone), ''),
  CASE WHEN json_valid(raw_json) THEN COALESCE(
    NULLIF(TRIM(CAST(json_extract(raw_json, '$.source_tone') AS TEXT)), ''),
    NULLIF(TRIM(CAST(json_extract(raw_json, '$.sourceTone') AS TEXT)), '')
  ) ELSE NULL END,
  ''
)
WHERE TRIM(source_tone) = '';
