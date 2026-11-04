export const APPROVED_IMAGE_API_BASE_URL = String(import.meta.env?.VITE_WANGZAI_IMAGE_API_URL || 'https://images.example.invalid/v1').trim().replace(/\/+$/u, '');
export const APPROVED_IMAGE_MODEL_ID = 'gpt-image-2';

function normalizeText(value) {
  return String(value ?? '').trim();
}

export function normalizeImageApiBaseUrl(value) {
  const normalized = normalizeText(value).replace(/\/+$/u, '');
  try {
    const parsed = new URL(normalized);
    if (
      parsed.protocol !== 'https:' ||
      parsed.username ||
      parsed.password ||
      parsed.search ||
      parsed.hash ||
      parsed.port
    ) return '';
    return `${parsed.origin}${parsed.pathname.replace(/\/+$/u, '')}`;
  } catch {
    return '';
  }
}

export function isApprovedImageApiBaseUrl(value) {
  return normalizeImageApiBaseUrl(value) === APPROVED_IMAGE_API_BASE_URL;
}

export function isApprovedImageModel(value) {
  return normalizeText(value) === APPROVED_IMAGE_MODEL_ID;
}

export function isApprovedImageModelAccount(account = {}) {
  return isApprovedImageApiBaseUrl(account.baseUrl || account.base_url);
}
