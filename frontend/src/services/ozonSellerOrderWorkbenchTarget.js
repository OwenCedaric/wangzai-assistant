const OZON_SELLER_ORIGIN = 'https://seller.ozon.ru';
const EMPTY_VALUES = new Set(['', '-', '--', '未返回', '暂无', 'null', 'undefined']);

function text(value) {
  const normalized = String(value ?? '').trim();
  return EMPTY_VALUES.has(normalized.toLowerCase()) || EMPTY_VALUES.has(normalized) ? '' : normalized;
}

function objectRows(row = {}) {
  const raw = row?.raw && typeof row.raw === 'object' && !Array.isArray(row.raw) ? row.raw : {};
  return [row, raw, raw.detail, raw.listItem, raw.entity]
    .filter((value) => value && typeof value === 'object' && !Array.isArray(value));
}

export function resolveOzonSellerOrderPosting(row = {}) {
  const fields = [
    'posting',
    'postingNumber',
    'posting_number',
    'salesOrder',
    'sales_order',
    'orderNumber',
    'order_number',
  ];
  for (const source of objectRows(row)) {
    for (const field of fields) {
      const value = text(source?.[field]);
      if (value) return value;
    }
  }
  return '';
}

export function resolveOzonSellerOrderRouteKind(row = {}) {
  const evidence = objectRows(row)
    .flatMap((source) => [
      source?.source,
      source?.channel,
      source?.fulfillment,
      source?.fulfillmentType,
      source?.fulfillment_type,
      source?.scheme,
      source?.deliveryScheme,
      source?.delivery_schema,
    ])
    .map(text)
    .filter(Boolean)
    .join(' ')
    .toLowerCase();
  if (/\brfbs\b|real[\s_-]*fbs/u.test(evidence)) return 'rfbs';
  if (/\bfbo\b/u.test(evidence)) return 'fbo';
  return 'fbs';
}

export function normalizeOzonSellerOrderLookup(value = {}) {
  const postingNumber = text(value.postingNumber || value.posting || value.posting_number);
  if (!postingNumber || postingNumber.length > 160) return null;
  const rawRouteKind = text(value.routeKind || value.fulfillment).toLowerCase();
  const routeKind = ['fbs', 'fbo', 'rfbs'].includes(rawRouteKind) ? rawRouteKind : 'fbs';
  return Object.freeze({ postingNumber, routeKind });
}

/**
 * Build one shared Seller-order target for every module.  The URL selects the
 * correct fulfillment area; `orderLookup` is mandatory follow-up work for the
 * native browser and is not considered successful until that exact posting is
 * searched, opened and read back from the visible Seller page.
 */
export function resolveOzonSellerOrderWorkbenchTarget(row = {}) {
  const postingNumber = resolveOzonSellerOrderPosting(row);
  const routeKind = resolveOzonSellerOrderRouteKind(row);
  return {
    url: `${OZON_SELLER_ORIGIN}/app/postings/${routeKind}`,
    exact: false,
    posting: postingNumber,
    routeKind,
    targetKind: 'seller-order',
    orderLookup: normalizeOzonSellerOrderLookup({ postingNumber, routeKind }),
  };
}
