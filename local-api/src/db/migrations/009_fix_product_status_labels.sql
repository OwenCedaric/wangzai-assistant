-- Fix product status labels that were previously polluted by the synthetic ALL tab label.
-- ALL is a query scope, not an actual product business status.
UPDATE ozon_products
SET status_label = CASE
  WHEN visibility = 'IN_SALE' THEN '出售中'
  WHEN visibility = 'TO_SUPPLY' THEN '待销售'
  WHEN visibility = 'STATE_FAILED' THEN '错误品'
  WHEN visibility = 'VALIDATION_STATE_FAIL' THEN '待修改'
  WHEN visibility = 'REMOVED_FROM_SALE' THEN '违规品'
  WHEN visibility = 'ARCHIVED' THEN '已下架'
  WHEN visibility = 'ALL' AND stock_value = 0 THEN '待销售'
  WHEN visibility = 'ALL' AND stock_value > 0 THEN '出售中'
  ELSE NULL
END
WHERE status_label IS NULL
   OR status_label = ''
   OR status_label = '全部商品'
   OR status_label = '未知状态';

PRAGMA user_version = 9;
