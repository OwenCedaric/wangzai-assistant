const AGGREGATES = new Set(['all', '*', '__all__', 'all-shops', 'all_shops']);
const text = value => value == null ? '' : String(value).trim();
const ids = value => [...new Set((Array.isArray(value) ? value : [value])
  .flatMap(item => text(item).split(',')).map(text)
  .filter(item => item && !AGGREGATES.has(item.toLowerCase())))];

export function resolveShopQueryIds(query = {}) {
  const direct = ids(query.shopId ?? query.shop_id);
  const listed = ids(query.shopIds ?? query.shop_ids);
  if (direct.length && listed.length
    && (direct.length !== listed.length || direct.some(id => !listed.includes(id)))) {
    const error = new Error('SHOP_QUERY_SCOPE_CONFLICT');
    error.code = 'SHOP_QUERY_SCOPE_CONFLICT';
    throw error;
  }
  return direct.length ? direct : listed;
}

export function normalizeShopQueryScope(query = {}) {
  const selected = resolveShopQueryIds(query);
  return {
    ...query,
    shopId: selected.length === 1 ? selected[0] : '',
    shop_id: selected.length === 1 ? selected[0] : '',
    shopIds: selected.length > 1 ? selected : [],
    shop_ids: selected.length > 1 ? selected : [],
  };
}

export function appendShopQueryFilter(query, where, parameters) {
  const selected = resolveShopQueryIds(query);
  if (selected.length) {
    where.push(`shop_id IN (${selected.map(() => '?').join(',')})`);
    parameters.push(...selected);
  }
}
