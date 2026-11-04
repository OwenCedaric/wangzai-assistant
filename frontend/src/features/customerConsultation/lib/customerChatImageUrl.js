const OZON_CHAT_FILE_ORIGIN = 'https://api-seller.ozon.ru';
const OZON_CHAT_FILE_PREFIX = '/v2/chat/file/';

export function isOzonCustomerChatImageUrl(value) {
  try {
    const parsed = new URL(String(value || '').trim());
    return (
      parsed.origin === OZON_CHAT_FILE_ORIGIN &&
      parsed.pathname.startsWith(OZON_CHAT_FILE_PREFIX) &&
      !parsed.username &&
      !parsed.password &&
      !parsed.hash
    );
  } catch {
    return false;
  }
}

export function createCustomerChatImageUrl({ shopId, url, retry = 0 } = {}) {
  const normalizedShopId = String(shopId || '').trim();
  const normalizedUrl = String(url || '').trim();
  if (!normalizedShopId || !isOzonCustomerChatImageUrl(normalizedUrl)) return '';
  const target = new URL('app://wangzai/api/customer-service/chat-file');
  target.searchParams.set('shopId', normalizedShopId);
  target.searchParams.set('url', normalizedUrl);
  if (Number(retry) > 0) target.searchParams.set('retry', String(Math.floor(Number(retry))));
  return target.toString();
}
