export function getSalesOrderRawPosting(order = {}) {
  const source = order || {};
  return source.raw?.posting ?? source.raw?.result?.posting ?? source.raw?.result ?? source.raw ?? source;
}
