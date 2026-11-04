-- Migration 038 could not repair rows already persisted as 0. The repository's
-- former blank-number coercion stored 0 when Ozon supplied only product price
-- and quantity. Rebuild those zero/null amounts strictly from persisted Ozon
-- product evidence; keep genuinely zero/unknown rows unchanged.
WITH product_amounts AS (
  SELECT
    orders.id AS order_row_id,
    SUM(
      COALESCE(
        CAST(json_extract(product.value, '$.total_price') AS REAL),
        CAST(json_extract(product.value, '$.totalPrice') AS REAL),
        CAST(json_extract(product.value, '$.total_amount') AS REAL),
        CAST(json_extract(product.value, '$.totalAmount') AS REAL),
        CAST(json_extract(product.value, '$.row_price') AS REAL),
        CAST(json_extract(product.value, '$.rowPrice') AS REAL),
        CAST(json_extract(product.value, '$.line_price') AS REAL),
        CAST(json_extract(product.value, '$.linePrice') AS REAL),
        CAST(json_extract(product.value, '$.final_price') AS REAL),
        CAST(json_extract(product.value, '$.finalPrice') AS REAL),
        CAST(json_extract(product.value, '$.price.price') AS REAL) * COALESCE(
          CAST(json_extract(product.value, '$.qty') AS REAL),
          CAST(json_extract(product.value, '$.quantity') AS REAL),
          CAST(json_extract(product.value, '$.count') AS REAL),
          1
        ),
        CAST(json_extract(product.value, '$.price') AS REAL) * COALESCE(
          CAST(json_extract(product.value, '$.qty') AS REAL),
          CAST(json_extract(product.value, '$.quantity') AS REAL),
          CAST(json_extract(product.value, '$.count') AS REAL),
          1
        )
      )
    ) AS amount_value
  FROM ozon_orders AS orders
  JOIN json_each(COALESCE(orders.products_json, '[]')) AS product
  WHERE orders.amount_value IS NULL OR orders.amount_value = 0
  GROUP BY orders.id
)
UPDATE ozon_orders
SET amount_value = (
  SELECT product_amounts.amount_value
  FROM product_amounts
  WHERE product_amounts.order_row_id = ozon_orders.id
)
WHERE (amount_value IS NULL OR amount_value = 0)
  AND EXISTS (
    SELECT 1
    FROM product_amounts
    WHERE product_amounts.order_row_id = ozon_orders.id
      AND product_amounts.amount_value > 0
  );

PRAGMA user_version = 83;
