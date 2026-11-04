import { createCustomerChatImageUrl, isOzonCustomerChatImageUrl } from './customerChatImageUrl.js';
import { describe, expect, it } from 'vitest';

describe('customer chat image URL', () => {
  const imageUrl =
    'https://api-seller.ozon.ru/v2/chat/file/messenger-rotated-3/40ff6bb2-d55b-41d6-8dd2-5c69512acd54.jpg';

  it('routes an authenticated Ozon chat image through the desktop local proxy', () => {
    const result = createCustomerChatImageUrl({ shopId: 'shop-2', url: imageUrl });
    expect(result).toContain('app://wangzai/api/customer-service/chat-file?');
    expect(result).toContain('shopId=shop-2');
    expect(decodeURIComponent(result)).toContain(imageUrl);
  });

  it('rejects foreign hosts and missing shop scope', () => {
    expect(isOzonCustomerChatImageUrl(imageUrl)).toBe(true);
    expect(isOzonCustomerChatImageUrl('https://example.com/v2/chat/file/a.jpg')).toBe(false);
    expect(createCustomerChatImageUrl({ shopId: '', url: imageUrl })).toBe('');
  });
});
