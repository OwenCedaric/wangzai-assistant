import { describe, expect, it } from 'vitest';
import { findCustomerFileReadback, findCustomerMessageReadback } from './customerSubmissionReadback.js';

const conversation = { id: 'chat-a', chatId: 'chat-a', conversationId: 'chat-a', chatType: 'BUYER_SELLER' };

describe('customer submission readback', () => {
  it('finds an already submitted seller text without sending it again', () => {
    const found = findCustomerMessageReadback(
      conversation,
      {
        data: {
          messages: [{ message_id: 'm-1', user: { type: 'Seller', id: 'seller' }, data: ['已发送内容'] }],
        },
      },
      { messageId: 'm-1', text: '已发送内容' }
    );
    expect(found?.messageId).toBe('m-1');
  });

  it('finds an already submitted image attachment by its message id', () => {
    const found = findCustomerFileReadback(
      conversation,
      {
        data: {
          messages: [
            {
              message_id: 'image-1',
              user: { type: 'Seller', id: 'seller' },
              is_image: true,
              data: ['![图片](https://cdn.example.com/customer-test.png)'],
            },
          ],
        },
      },
      { messageId: 'image-1', fileName: 'customer-test.png', isImage: true }
    );
    expect(found?.messageId).toBe('image-1');
  });
});
