export function collectImageUrlsFromValue(value, urls = new Set()) {
  if (!value) return urls;
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (/^https?:\/\//i.test(trimmed) || /^data:image\//i.test(trimmed) || trimmed.startsWith('/')) {
      urls.add(trimmed);
    }
    return urls;
  }
  if (Array.isArray(value)) {
    value.forEach((item) => collectImageUrlsFromValue(item, urls));
    return urls;
  }
  if (typeof value === 'object') {
    Object.values(value).forEach((item) => collectImageUrlsFromValue(item, urls));
  }
  return urls;
}

export function getImageUrlFromValue(value) {
  if (!value) return '';
  if (typeof value === 'string') return value.trim();
  if (typeof value !== 'object') return '';

  const directKeys = ['url', 'src', 'file_name', 'image', 'image_url', 'picture', 'picture_url', 'link'];
  for (const key of directKeys) {
    const url = getImageUrlFromValue(value[key]);
    if (url) return url;
  }

  const collected = collectImageUrlsFromValue(value);
  return collected.values().next().value || '';
}

export function normalizeImageList(images) {
  return (images || []).map(getImageUrlFromValue).filter(Boolean);
}

export function isRemoteImageUrl(image) {
  return /^https?:\/\//i.test(String(image || '').trim());
}

export function normalizeRemoteImageList(images) {
  return normalizeImageList(images).filter(isRemoteImageUrl);
}

export function safeImageUrl(image) {
  const url = getImageUrlFromValue(image);
  return isRemoteImageUrl(url) || /^data:image\//i.test(url) || url.startsWith('/') ? url : '';
}

export function getOzonImages(detail, attributes, pictures) {
  const candidates = [
    pictures?.images,
    pictures?.pictures,
    pictures?.primary_image ? [pictures.primary_image, ...(pictures.images || [])] : null,
    attributes?.images,
    detail?.images,
  ];
  const images = candidates
    .flatMap((value) => (Array.isArray(value) ? value : []))
    .map(getImageUrlFromValue)
    .filter(Boolean);
  const primary =
    pictures?.primary_image ?? attributes?.primary_image ?? detail?.primary_image ?? detail?.images?.[0] ?? '';
  return [...new Set(normalizeImageList([primary, ...images]))];
}
