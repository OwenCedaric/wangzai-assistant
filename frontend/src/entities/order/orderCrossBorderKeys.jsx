import { getSalesOrderRawPosting } from './orderRawFields.jsx';

export function getSalesOrderCrossBorderKeys(order = {}) {
  const raw = getSalesOrderRawPosting(order);
  return [
    order.softwareOrderId,
    order.posting,
    order.id,
    raw.posting_number,
    raw.order_number,
    raw.order_id,
    raw.analytics_data?.order_id,
    raw.analytics_data?.posting_number,
  ]
    .map((value) => String(value ?? '').trim())
    .filter((value, index, values) => value && value !== '未返回' && values.indexOf(value) === index);
}
