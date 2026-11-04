import { SOURCE_LINK_LIMIT } from '../../shared/config/appConfigCore.jsx';
import { firstFilled } from './orderIdentityRules.jsx';

export function normalizeSalesSourceLinkValue(value = '') {
  const rawText = String(value || '').trim();
  if (!rawText) return { ok: false, link: '', productId: '', platform: '', error: '请先填写货源链接。' };

  let url = null;
  try {
    url = new URL(rawText);
  } catch {
    return { ok: false, link: rawText, productId: '', platform: '', error: '链接格式不正确。' };
  }

  const host = url.hostname.toLowerCase();
  const path = url.pathname;

  if (host.includes('yangkeduo.com') || host.includes('pinduoduo.com') || host.includes('pdd')) {
    const productId = url.searchParams.get('goods_id') || url.searchParams.get('goodsId') || '';
    if (!productId) {
      return { ok: false, link: rawText, productId: '', platform: '拼多多', error: '未识别到拼多多 goods_id。' };
    }
    return {
      ok: true,
      link: `https://mobile.yangkeduo.com/goods.html?goods_id=${encodeURIComponent(productId)}`,
      productId,
      platform: '拼多多',
    };
  }

  if (host.includes('1688.com')) {
    const match = path.match(/\/offer\/(\d+)\.html/i) || rawText.match(/offer\/(\d+)\.html/i);
    const productId = match?.[1] || '';
    if (!productId) {
      return { ok: false, link: rawText, productId: '', platform: '1688', error: '未识别到 1688 商品ID。' };
    }
    return {
      ok: true,
      link: `https://detail.1688.com/offer/${productId}.html`,
      productId,
      platform: '1688',
    };
  }

  if (host.includes('taobao.com')) {
    const productId = url.searchParams.get('id') || '';
    if (!productId) {
      return { ok: false, link: rawText, productId: '', platform: '淘宝', error: '未识别到淘宝商品ID。' };
    }
    return {
      ok: true,
      link: `https://item.taobao.com/item.htm?id=${encodeURIComponent(productId)}`,
      productId,
      platform: '淘宝',
    };
  }

  if (host.includes('tmall.com')) {
    const productId = url.searchParams.get('id') || '';
    if (!productId) {
      return { ok: false, link: rawText, productId: '', platform: '天猫', error: '未识别到天猫商品ID。' };
    }
    return {
      ok: true,
      link: `https://detail.tmall.com/item.htm?id=${encodeURIComponent(productId)}`,
      productId,
      platform: '天猫',
    };
  }

  if ((host === 'ozon.ru' || host.endsWith('.ozon.ru')) && host !== 'seller.ozon.ru') {
    const productPath = path.match(/^\/product\/([^/]+)/iu)?.[1] || '';
    const shortCode = path.match(/^\/t\/([^/]+)/iu)?.[1] || '';
    const productId =
      url.searchParams.get('id')
      || url.searchParams.get('product_id')
      || url.searchParams.get('sku')
      || productPath.match(/(?:^|-)(\d{5,})(?:$|-)/u)?.[1]
      || productPath.match(/(\d{5,})$/u)?.[1]
      || shortCode
      || '';
    if (!productId) {
      return { ok: false, link: rawText, productId: '', platform: 'Ozon买家', error: '未识别到 Ozon 买家商品ID。' };
    }
    url.hash = '';
    for (const key of [...url.searchParams.keys()]) {
      if (/(?:token|secret|password|credential|session|auth)/iu.test(key)) url.searchParams.delete(key);
    }
    return {
      ok: true,
      link: url.toString(),
      productId,
      platform: 'Ozon买家',
    };
  }

  return { ok: false, link: rawText, productId: '', platform: '', error: '暂只支持拼多多、1688、淘宝、天猫、Ozon 买家链接。' };
}

export function normalizeSavedSalesSourceEntry(entry) {
  if (!entry)
    return {
      link: '',
      productId: '',
      platform: '',
      title: '',
      imageUrl: '',
      previewImageUrl: '',
      originalImageUrl: '',
      price: '',
      qty: '',
    };
  if (typeof entry === 'string')
    return {
      link: entry,
      productId: '',
      platform: '',
      title: '',
      imageUrl: '',
      previewImageUrl: '',
      originalImageUrl: '',
      price: '',
      qty: '',
    };
  if (Array.isArray(entry.links)) {
    const primaryIndex = Math.max(0, Math.min(Number(entry.primaryIndex || 0), entry.links.length - 1));
    return normalizeSavedSalesSourceEntry(entry.links[primaryIndex] ?? entry.links[0]);
  }
  const originalImageUrl = String(
    firstFilled(
      entry.originalImageUrl,
      entry.original_image_url,
      entry.originalImage,
      entry.original_image,
      entry.fullImageUrl,
      entry.full_image_url,
      entry.largeImageUrl,
      entry.large_image_url,
      entry.highResImageUrl,
      entry.high_res_image_url,
      entry.raw?.originalImageUrl,
      entry.raw?.original_image_url,
      entry.raw?.originalImage,
      entry.raw?.fullImageUrl,
      Array.isArray(entry.originalImages) ? entry.originalImages[0] : ''
    ) || ''
  );
  const previewImageUrl = String(
    firstFilled(
      entry.previewImageUrl,
      entry.preview_image_url,
      entry.previewImage,
      entry.preview_image,
      entry.largePreviewImageUrl,
      entry.large_preview_image_url,
      entry.raw?.previewImageUrl,
      entry.raw?.preview_image_url,
      originalImageUrl
    ) || ''
  );
  const imageUrl = String(
    firstFilled(
      entry.image,
      entry.imageUrl,
      entry.image_url,
      entry.sourceImage,
      entry.sourceImageUrl,
      entry.source_image_url,
      entry.thumbnail,
      entry.thumbnailUrl,
      entry.thumbUrl,
      entry.picture,
      entry.pictureUrl,
      entry.picUrl,
      Array.isArray(entry.images) ? entry.images[0] : '',
      Array.isArray(entry.pictures) ? entry.pictures[0] : '',
      previewImageUrl,
      originalImageUrl
    ) || ''
  );
  return {
    link: String(entry.link || entry.url || ''),
    productId: String(entry.productId || entry.goodsId || ''),
    platform: String(entry.platform || ''),
    title: String(
      firstFilled(
        entry.title,
        entry.name,
        entry.productTitle,
        entry.product_title,
        entry.sourceTitle,
        entry.source_title,
        entry.goodsTitle,
        entry.goods_title,
        entry.itemTitle,
        entry.item_title
      ) || ''
    ),
    imageUrl,
    previewImageUrl,
    originalImageUrl,
    price: String(
      firstFilled(
        entry.purchasePrice,
        entry.purchase_price,
        entry.sourcePrice,
        entry.source_price,
        entry.amount,
        entry.price
      ) || ''
    ),
    priceValue:
      entry.purchasePriceValue ??
      entry.purchase_price_value ??
      entry.sourcePriceValue ??
      entry.source_price_value ??
      entry.priceValue,
    qty: String(firstFilled(entry.purchaseQty, entry.purchase_qty, entry.qty, entry.quantity) || ''),
  };
}

export function normalizeSourcePlatformName(platform = '') {
  const text = String(platform || '')
    .trim()
    .toLowerCase();
  if (!text) return '其他';
  if (text.includes('pdd') || text.includes('拼多多') || text.includes('yangkeduo')) return 'PDD';
  if (text.includes('1688')) return '1688';
  if (text.includes('taobao') || text.includes('淘宝')) return '淘宝';
  if (text.includes('tmall') || text.includes('天猫')) return '天猫';
  if (text.includes('ozon-buyer') || text.includes('ozon buyer') || text.includes('ozon买家') || text.includes('ozon 买家')) return 'Ozon买家';
  return String(platform || '其他').trim() || '其他';
}

export function detectSourcePlatformFromLink(link = '') {
  const text = String(link || '').toLowerCase();
  if (!text) return '其他';
  if (text.includes('yangkeduo.com') || text.includes('pinduoduo.com') || text.includes('pdd')) return 'PDD';
  if (text.includes('1688.com')) return '1688';
  if (text.includes('taobao.com')) return '淘宝';
  if (text.includes('tmall.com')) return '天猫';
  if (text.includes('ozon.ru') && !text.includes('seller.ozon.ru')) return 'Ozon买家';
  return '其他';
}

export function normalizeProductSourceEntry(entry = {}) {
  const normalized = normalizeSavedSalesSourceEntry(entry);
  const link = String(normalized.link || '').trim();
  return {
    link,
    productId: String(normalized.productId || '').trim(),
    platform: normalizeSourcePlatformName(normalized.platform || detectSourcePlatformFromLink(link)),
    title: String(normalized.title || '').trim(),
    imageUrl: String(normalized.imageUrl || '').trim(),
    previewImageUrl: String(normalized.previewImageUrl || '').trim(),
    originalImageUrl: String(normalized.originalImageUrl || '').trim(),
    price: String(normalized.price || '').trim(),
    priceValue: normalized.priceValue,
    qty: String(normalized.qty || '').trim(),
    savedAt: entry?.savedAt || '',
    scope: String(entry?.scope || ''),
  };
}

export function buildSourceEntryForLink(value = '', existingEntry = {}, selectedEntry = {}) {
  const link = String(value || '').trim();
  const normalizedExisting = normalizeProductSourceEntry(existingEntry);
  const normalizedSelected = normalizeProductSourceEntry(selectedEntry);
  const base =
    normalizedSelected.link === link ? normalizedSelected : normalizedExisting.link === link ? normalizedExisting : {};

  return {
    ...base,
    link,
    platform: normalizeSourcePlatformName(base.platform || detectSourcePlatformFromLink(link)),
  };
}

export function normalizeProductSourceRecord(record = {}) {
  const rawItems = Array.isArray(record?.links) ? record.links : record ? [record] : [];
  const uniqueItems = [];
  rawItems.forEach((item) => {
    const normalized = normalizeProductSourceEntry(item);
    if (!normalized.link) return;
    if (uniqueItems.some((current) => current.link === normalized.link)) return;
    uniqueItems.push(normalized);
  });
  const primaryIndex = Math.max(0, Math.min(Number(record?.primaryIndex || 0), Math.max(uniqueItems.length - 1, 0)));
  return {
    links: uniqueItems.slice(0, SOURCE_LINK_LIMIT),
    primaryIndex,
    updatedAt: record?.updatedAt || '',
  };
}

export function buildProductSourceStorageRecord(record = {}) {
  const normalized = normalizeProductSourceRecord(record);
  return {
    links: normalized.links,
    primaryIndex: normalized.primaryIndex,
    updatedAt: new Date().toISOString(),
  };
}
