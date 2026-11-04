import {
  getCustomerSyncStatusLabel,
  translateCustomerConversationStatus,
  translateCustomerError,
  translateCustomerReadStatus,
} from './customerConsultationLocale.js';
import { describe, expect, it } from 'vitest';

describe('customer consultation Chinese locale boundary', () => {
  it('translates English and Russian conversation statuses without losing raw status', () => {
    expect(translateCustomerConversationStatus('OPENED')).toMatchObject({
      key: 'open',
      label: '处理中',
      rawStatus: 'OPENED',
    });
    expect(translateCustomerConversationStatus('ЗАКРЫТ')).toMatchObject({
      key: 'closed',
      label: '已关闭',
      rawStatus: 'ЗАКРЫТ',
    });
    expect(
      translateCustomerConversationStatus('OPENED', {
        unreadCount: 2,
        buyerConversation: true,
      }).label
    ).toBe('待回复');
  });

  it('translates English and Russian errors into stable Chinese UI messages', () => {
    expect(translateCustomerError({ code: 'FORBIDDEN', message: 'Forbidden' })).toBe(
      '当前账号没有访问客服数据的权限。'
    );
    expect(translateCustomerError(new Error('Не удалось подключиться к сети'))).toBe(
      '网络连接失败，请检查网络后重试。'
    );
    expect(translateCustomerError(new Error('Resource not found'))).toBe('未找到对应的客服数据。');
    expect(translateCustomerError({ code: 'CUSTOMER_SERVICE_WRITE_ACTION_NOT_REGISTERED' })).toBe(
      '后端暂未提供此客服操作。'
    );
  });

  it('keeps read status and sync status Chinese', () => {
    expect(translateCustomerReadStatus(false)).toBe('未读');
    expect(translateCustomerReadStatus('прочитано')).toBe('已读');
    expect(getCustomerSyncStatusLabel('loadingMore')).toBe('正在加载更多');
  });
});
