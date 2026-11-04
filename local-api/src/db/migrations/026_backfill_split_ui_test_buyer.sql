UPDATE ozon_orders
SET
  analytics_json = CASE
    WHEN analytics_json IS NULL OR TRIM(analytics_json) = '' THEN '{"buyer_name":"测试买家"}'
    WHEN json_valid(analytics_json) THEN json_set(
      analytics_json,
      '$.buyer_name',
      COALESCE(json_extract(analytics_json, '$.buyer_name'), '测试买家')
    )
    ELSE analytics_json
  END,
  raw_json = CASE
    WHEN raw_json IS NOT NULL AND json_valid(raw_json) THEN json_set(
      raw_json,
      '$.analytics_data.buyer_name',
      COALESCE(json_extract(raw_json, '$.analytics_data.buyer_name'), '测试买家')
    )
    ELSE raw_json
  END
WHERE raw_json LIKE '%"splitUiTestOrder":true%'
  AND (
    analytics_json IS NULL
    OR analytics_json NOT LIKE '%测试买家%'
    OR raw_json NOT LIKE '%测试买家%'
  );

PRAGMA user_version = 26;
