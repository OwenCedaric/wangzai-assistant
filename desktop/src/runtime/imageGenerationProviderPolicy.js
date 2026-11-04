export const APPROVED_IMAGE_API_BASE_URL = String(process.env.WANGZAI_IMAGE_API_URL || 'https://images.example.invalid/v1').trim().replace(/\/+$/u, '');
export const APPROVED_IMAGE_MODEL_ID = 'gpt-image-2';

export function normalizeApprovedImageApiBaseUrl(value) {
  const normalized = String(value ?? '').trim().replace(/\/+$/u, '');
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

export function isApprovedImageProvider(baseUrl, model) {
  return (
    normalizeApprovedImageApiBaseUrl(baseUrl) === APPROVED_IMAGE_API_BASE_URL &&
    String(model ?? '').trim() === APPROVED_IMAGE_MODEL_ID
  );
}
