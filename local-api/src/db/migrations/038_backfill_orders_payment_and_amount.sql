-- Existing caches were written before payment_at / amount_value existed.
-- Backfill only from stored Ozon payload fields; never invent a value when evidence is absent.
UPDATE ozon_orders
SET payment_at = COALESCE(
  payment_at,
  json_extract(raw_json, '$.paid_at'),
  json_extract(raw_json, '$.payment_date'),
  json_extract(raw_json, '$.paidAt'),
  json_extract(raw_json, '$.paymentDate'),
  in_process_at
)
WHERE payment_at IS NULL;

UPDATE ozon_orders
SET amount_value = COALESCE(
  amount_value,
  CAST(json_extract(raw_json, '$.total_price') AS REAL),
  CAST(json_extract(raw_json, '$.totalPrice') AS REAL),
  CAST(json_extract(raw_json, '$.order_price') AS REAL),
  CAST(json_extract(raw_json, '$.orderPrice') AS REAL),
  CAST(json_extract(raw_json, '$.sum_price') AS REAL),
  CAST(json_extract(raw_json, '$.sumPrice') AS REAL),
  CAST(json_extract(raw_json, '$.total_amount') AS REAL),
  CAST(json_extract(raw_json, '$.totalAmount') AS REAL),
  CAST(json_extract(raw_json, '$.order_amount') AS REAL),
  CAST(json_extract(raw_json, '$.orderAmount') AS REAL),
  (
    SELECT SUM(
      COALESCE(
        CAST(json_extract(value, '$.total_price') AS REAL),
        CAST(json_extract(value, '$.totalPrice') AS REAL),
        CAST(json_extract(value, '$.total_amount') AS REAL),
        CAST(json_extract(value, '$.totalAmount') AS REAL),
        CAST(json_extract(value, '$.row_price') AS REAL),
        CAST(json_extract(value, '$.rowPrice') AS REAL),
        CAST(json_extract(value, '$.line_price') AS REAL),
        CAST(json_extract(value, '$.linePrice') AS REAL),
        CAST(json_extract(value, '$.final_price') AS REAL),
        CAST(json_extract(value, '$.finalPrice') AS REAL),
        CAST(json_extract(value, '$.price.price') AS REAL) * COALESCE(CAST(json_extract(value, '$.qty') AS REAL), CAST(json_extract(value, '$.quantity') AS REAL), CAST(json_extract(value, '$.count') AS REAL), 1),
        CAST(json_extract(value, '$.price') AS REAL) * COALESCE(CAST(json_extract(value, '$.qty') AS REAL), CAST(json_extract(value, '$.quantity') AS REAL), CAST(json_extract(value, '$.count') AS REAL), 1)
      )
    )
    FROM json_each(COALESCE(products_json, '[]'))
  )
)
WHERE amount_value IS NULL;

PRAGMA user_version = 38;
