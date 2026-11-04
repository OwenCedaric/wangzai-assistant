import {
  getInternalBrowserLinkErrorMessage,
  openInternalBrowserLink,
} from './internalBrowserLinkClient.js';

const EMPTY_VALUES = new Set(['', '-', '--', '未返回', '暂无', 'null', 'undefined']);

function text(value) {
  const normalized = String(value ?? '').trim();
  return EMPTY_VALUES.has(normalized.toLowerCase()) || EMPTY_VALUES.has(normalized) ? '' : normalized;
}

function sourceCandidates(sources = []) {
  return sources.flatMap((source) => {
    if (!source || typeof source !== 'object' || Array.isArray(source)) return [];
    const firstProduct = Array.isArray(source.products) ? source.products[0] : null;
    return [source, firstProduct, source.raw, source.raw?.entity].filter(Boolean);
  });
}

function exactProductUrl(rows) {
  for (const row of rows) {
    for (const field of ['ozonProductUrl', 'productUrl', 'product_url', 'link', 'url', 'href']) {
      const value = text(row?.[field]);
      if (!value) continue;
      try {
        const url = new URL(value);
        if ((url.hostname === 'ozon.ru' || url.hostname.endsWith('.ozon.ru')) && url.pathname.includes('/product/')) {
          return url.toString();
        }
      } catch {
        // Keep resolving from the canonical Ozon identifiers below.
      }
    }
  }
  return '';
}

function productPageId(rows) {
  const candidates = [];
  rows.forEach((row) => {
    candidates.push(
      row?.ozonSku,
      row?.ozon_sku,
      row?.skuId,
      row?.sku_id,
      row?.sku,
      row?.productSku,
      row?.product_sku,
      row?.ozonProductId,
      row?.ozon_product_id,
      row?.productId,
      row?.product_id,
    );
  });
  return candidates.map(text).filter(Boolean).find((value) => /^\d{5,}$/u.test(value)) || '';
}

function productTitle(rows) {
  for (const row of rows) {
    for (const field of ['name', 'title', 'productTitle', 'productName', 'product_name', 'itemName', 'product']) {
      const value = text(row?.[field]);
      if (value) return value;
    }
  }
  return '';
}

export function resolveOzonProductPageTarget(...sources) {
  const rows = sourceCandidates(sources);
  const existingUrl = exactProductUrl(rows);
  if (existingUrl) return { url: existingUrl, exact: true, productId: '', title: productTitle(rows) };

  const productId = productPageId(rows);
  const title = productTitle(rows);
  if (productId) {
    return {
      url: `https://www.ozon.ru/product/${encodeURIComponent(productId)}/`,
      exact: true,
      productId,
      title,
    };
  }
  if (title) {
    return {
      url: `https://www.ozon.ru/search/?text=${encodeURIComponent(title)}`,
      exact: false,
      productId: '',
      title,
    };
  }
  return { url: '', exact: false, productId: '', title: '' };
}

export function buildOzonProductPageUrl(...sources) {
  return resolveOzonProductPageTarget(...sources).url;
}

export async function openOzonProductPage(sources, options = {}) {
  const sourceList = Array.isArray(sources) ? sources : [sources];
  const target = resolveOzonProductPageTarget(...sourceList);
  if (!target.url) {
    const error = new Error('OZON_PRODUCT_PAGE_TARGET_MISSING');
    error.code = 'OZON_PRODUCT_PAGE_TARGET_MISSING';
    throw error;
  }
  const browserState = await openInternalBrowserLink(target.url, options);
  return { ...target, browserState };
}

export function getOzonProductPageErrorMessage(error) {
  if (String(error?.code || error?.message || '') === 'OZON_PRODUCT_PAGE_TARGET_MISSING') {
    return '当前商品缺少可用的 Ozon 商品标识和标题。';
  }
  return getInternalBrowserLinkErrorMessage(error);
}
