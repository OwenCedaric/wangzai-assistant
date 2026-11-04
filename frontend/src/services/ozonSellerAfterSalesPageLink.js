const OZON_SELLER_ORIGIN = 'https://seller.ozon.ru';
import { resolveOzonSellerOrderWorkbenchTarget } from './ozonSellerOrderWorkbenchTarget.js';
const EMPTY_VALUES = new Set(['', '-', '--', '未返回', '暂无', 'null', 'undefined']);
const SELLER_RETURN_DETAIL_PATH = /^\/app\/returns\/details\/(?:fbs|rfbs(?:\/fbp|\/united)?|common(?:\/supply)?)\/([^/]+)\/?$/iu;

function text(value) {
  const normalized = String(value ?? '').trim();
  return EMPTY_VALUES.has(normalized.toLowerCase()) || EMPTY_VALUES.has(normalized) ? '' : normalized;
}

function objectRows(row = {}) {
  const raw = row?.raw && typeof row.raw === 'object' && !Array.isArray(row.raw) ? row.raw : {};
  return [
    row,
    raw,
    raw.detail,
    raw.listItem,
    raw.entity,
  ].filter((value) => value && typeof value === 'object' && !Array.isArray(value));
}

function existingSellerReturnUrl(rows = [], returnId = '') {
  const fields = [
    'sellerAfterSalesUrl',
    'seller_after_sales_url',
    'afterSalesUrl',
    'after_sales_url',
    'returnUrl',
    'return_url',
    'detailsUrl',
    'details_url',
  ];
  for (const row of rows) {
    for (const field of fields) {
      const value = text(row?.[field]);
      if (!value) continue;
      try {
        const url = new URL(value);
        const pathMatch = url.pathname.match(SELLER_RETURN_DETAIL_PATH);
        const pathReturnId = text(pathMatch?.[1]);
        if (
          url.protocol === 'https:'
          && url.hostname.toLowerCase() === 'seller.ozon.ru'
          && pathReturnId
          && (!returnId || decodeURIComponent(pathReturnId) === returnId)
        ) {
          return url.toString();
        }
      } catch {
        // Continue with the canonical Seller route below.
      }
    }
  }
  return '';
}

function explicitAfterSalesId(rows = []) {
  const fields = ['afterSalesId', 'after_sales_id', 'returnId', 'return_id'];
  for (const row of rows) {
    for (const field of fields) {
      const value = text(row?.[field]);
      if (/^[a-zA-Z0-9_-]{1,128}$/u.test(value)) return value;
    }
  }
  return '';
}

function routeKind(rows = []) {
  const evidence = rows
    .flatMap((row) => [
      row?.source,
      row?.fulfillment,
      row?.fulfillmentType,
      row?.fulfillment_type,
      row?.scheme,
      row?.deliveryScheme,
      row?.delivery_schema,
    ])
    .map(text)
    .filter(Boolean)
    .join(' ')
    .toLowerCase();
  if (/\brfbs\b|real[\s_-]*fbs/u.test(evidence)) return 'rfbs';
  if (/\bfbs\b/u.test(evidence)) return 'fbs';
  return '';
}

function originalPosting(rows = []) {
  const fields = [
    'salesOrder',
    'sales_order',
    'posting',
    'postingNumber',
    'posting_number',
  ];
  for (const row of rows) {
    for (const field of fields) {
      const value = text(row?.[field]);
      if (value) return value;
    }
  }
  return '';
}

export function resolveOzonSellerAfterSalesPageTarget(row = {}) {
  const rows = objectRows(row);
  const returnId = explicitAfterSalesId(rows);
  if (!returnId) return { url: '', exact: false, returnId: '', routeKind: '' };

  const existingUrl = existingSellerReturnUrl(rows, returnId);
  if (existingUrl) {
    const match = new URL(existingUrl).pathname.match(SELLER_RETURN_DETAIL_PATH);
    const resolvedKind = String(new URL(existingUrl).pathname).includes('/rfbs') ? 'rfbs' : 'fbs';
    return {
      url: existingUrl,
      exact: Boolean(match),
      returnId,
      routeKind: resolvedKind,
    };
  }

  const resolvedKind = routeKind(rows);
  if (!resolvedKind) return { url: '', exact: false, returnId, routeKind: '' };
  return {
    url: `${OZON_SELLER_ORIGIN}/app/returns/details/${resolvedKind}/${encodeURIComponent(returnId)}`,
    exact: true,
    returnId,
    routeKind: resolvedKind,
  };
}

export function buildOzonSellerAfterSalesPageUrl(row = {}) {
  return resolveOzonSellerAfterSalesPageTarget(row).url;
}

export function resolveOzonSellerAfterSalesWorkbenchTarget(row = {}) {
  const exactTarget = resolveOzonSellerAfterSalesPageTarget(row);
  if (exactTarget.url) {
    return {
      ...exactTarget,
      posting: originalPosting(objectRows(row)),
      targetKind: 'after-sales-detail',
    };
  }

  const originalOrderTarget = resolveOzonSellerOrderWorkbenchTarget(row);
  return {
    ...originalOrderTarget,
    returnId: '',
    targetKind: 'original-order-list',
  };
}
