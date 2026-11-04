-- Ozon 订单缓存必须携带真实货件号或订单 ID。字符串、空对象和残缺响应
-- 只能继续回读，禁止用内容哈希伪造成可展示订单。
DELETE FROM ozon_orders
WHERE TRIM(COALESCE(posting_number, '')) = ''
  AND TRIM(COALESCE(order_id, '')) = '';

CREATE TRIGGER IF NOT EXISTS trg_ozon_orders_require_identity_insert
BEFORE INSERT ON ozon_orders
WHEN TRIM(COALESCE(NEW.posting_number, '')) = ''
 AND TRIM(COALESCE(NEW.order_id, '')) = ''
BEGIN
  SELECT RAISE(ABORT, 'OZON_ORDER_IDENTITY_REQUIRED');
END;

CREATE TRIGGER IF NOT EXISTS trg_ozon_orders_require_identity_update
BEFORE UPDATE OF posting_number, order_id ON ozon_orders
WHEN TRIM(COALESCE(NEW.posting_number, '')) = ''
 AND TRIM(COALESCE(NEW.order_id, '')) = ''
BEGIN
  SELECT RAISE(ABORT, 'OZON_ORDER_IDENTITY_REQUIRED');
END;

PRAGMA user_version = 95;
