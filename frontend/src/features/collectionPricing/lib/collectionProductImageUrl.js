function cleanRemoteImageUrl(value) {
  try {
    const url = new URL(String(value || '').trim());
    return ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password ? url.toString() : '';
  } catch {
    return '';
  }
}

export function getCollectionProductThumbnailSource(item = {}) {
  const candidates = [
    ...(Array.isArray(item.mainImages) ? item.mainImages : []),
    ...(Array.isArray(item.skuImages) ? item.skuImages.map((row) => row?.imageUrl) : []),
    ...(Array.isArray(item.images) ? item.images : []),
  ];
  return candidates.map(cleanRemoteImageUrl).find(Boolean) || '';
}

export function getCollectionProductThumbnailUrls(item = {}) {
  const source = getCollectionProductThumbnailSource(item);
  return getCollectionProductImageUrls(source);
}

export function getCollectionProductImageUrls(value = '') {
  const source = cleanRemoteImageUrl(value);
  if (!source) return [];
  const desktopProxy = typeof globalThis.wangzaiDesktop?.purchaseBridgeRequest === 'function'
    ? `app://wangzai/purchase-image?url=${encodeURIComponent(source)}`
    : '';
  return [...new Set([desktopProxy, source].filter(Boolean))];
}
