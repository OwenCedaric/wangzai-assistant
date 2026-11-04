import { describe, expect, it } from 'vitest';
import { getLatestRenderedMessageId } from './useCustomerConsultationPageModel.js';

describe('getLatestRenderedMessageId', () => {
  it('waits until history has loaded successfully', () => {
    expect(
      getLatestRenderedMessageId({
        historyStatus: 'loading',
        messages: [{ senderType: 'buyer', messageId: 'buyer-1' }],
      })
    ).toBe('');
  });

  it('uses the newest rendered message including an Ozon automatic message', () => {
    expect(
      getLatestRenderedMessageId({
        historyStatus: 'success',
        messages: [
          { senderType: 'buyer', messageId: 'buyer-1' },
          { senderType: 'buyer', messageId: 'buyer-2' },
          { senderType: 'seller', messageId: 'seller-3' },
          { senderType: 'system', messageId: 'system-4' },
        ],
      })
    ).toBe('system-4');
  });
});
