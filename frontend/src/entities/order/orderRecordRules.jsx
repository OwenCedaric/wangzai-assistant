function asOrderRecord(order) {
  return order && typeof order === 'object' ? order : {};
}

export function getSalesOrderRecordKey(order = {}) {
  const record = asOrderRecord(order);
  return record.recordKey || record.id || record.posting || '';
}

export function getAfterSalesOrderRecordKey(order = {}) {
  const record = asOrderRecord(order);
  return (
    record.recordKey ||
    record.returnKey ||
    record.returnId ||
    record.return_id ||
    getSalesOrderRecordKey(record) ||
    record.salesOrder ||
    ''
  );
}
