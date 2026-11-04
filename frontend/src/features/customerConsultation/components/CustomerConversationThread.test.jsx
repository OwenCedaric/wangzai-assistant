import { CustomerConversationThread } from './CustomerConversationThread.jsx';
import { CustomerConversationList } from './CustomerConversationList.jsx';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

const conversation = {
  id: 'chat-1',
  category: 'buyer',
  channel: 'chat',
  title: 'Maria Ivanova',
  subtitle: '订单配送咨询',
  status: '待回复',
  unread: 1,
  updatedAt: '今天 14:28',
  messages: [
    {
      id: 'message-1',
      role: 'buyer',
      author: 'Maria Ivanova',
      text: 'Здравствуйте, когда будет доставка?',
      time: '14:28',
    },
  ],
};

describe('customer conversation thread translations', () => {
  it('shows Chinese as the primary text and keeps the Russian source below it', () => {
    render(
      <CustomerConversationThread
        conversation={conversation}
        translationStatus="success"
        translations={{ 'message-1': '您好，请问什么时候配送？' }}
      />
    );

    expect(screen.getByText('中文已翻译')).toBeInTheDocument();
    expect(screen.getByText('您好，请问什么时候配送？')).toBeInTheDocument();
    expect(screen.getByText('俄文原文')).toBeInTheDocument();
    expect(screen.getByText('Здравствуйте, когда будет доставка?')).toBeInTheDocument();
  });

  it('uses the Chinese translation in the buyer conversation preview', () => {
    render(
      <CustomerConversationList
        conversations={[{ ...conversation, lastMessage: conversation.messages[0].text }]}
        previewTranslations={{ 'chat-1': '您好，请问什么时候配送？' }}
        selectedFilterId="all"
        selectedConversationId="chat-1"
        searchText=""
        onSelectFilter={() => {}}
        onSelectConversation={() => {}}
        onSearchChange={() => {}}
      />
    );

    expect(screen.getByText('您好，请问什么时候配送？')).toBeInTheDocument();
  });

  it('shows a retry action when translation is incomplete', () => {
    const onRetryTranslation = vi.fn();
    render(
      <CustomerConversationThread
        conversation={conversation}
        translationStatus="error"
        translationError="翻译未完成，请重试。"
        onRetryTranslation={onRetryTranslation}
      />
    );

    expect(screen.getByText('翻译未完成，点击重试')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '重试翻译' }));
    expect(onRetryTranslation).toHaveBeenCalledTimes(1);
  });

  it('renders message preview links as real external links', () => {
    render(
      <CustomerConversationList
        conversations={[{ ...conversation, lastMessage: '课程链接 https://example.com/course。' }]}
        selectedFilterId="all"
        selectedConversationId="chat-1"
        searchText=""
        onSelectFilter={() => {}}
        onSelectConversation={() => {}}
        onSearchChange={() => {}}
      />
    );

    expect(screen.getByRole('link', { name: 'https://example.com/course' })).toHaveAttribute(
      'href',
      'https://example.com/course'
    );
  });

  it('keeps detail loading local to the thread and provides a retry on detail errors', () => {
    const onRefresh = vi.fn();
    const { rerender } = render(
      <CustomerConversationThread
        conversation={{ ...conversation, messages: [], historyStatus: 'loading' }}
        refreshing
        onRefresh={onRefresh}
      />
    );
    expect(screen.getByText('正在读取 Ozon 聊天记录')).toBeInTheDocument();

    rerender(
      <CustomerConversationThread
        conversation={{
          ...conversation,
          messages: [],
          historyStatus: 'error',
          historyError: '网络连接失败，请检查网络后重试。',
        }}
        onRefresh={onRefresh}
      />
    );
    expect(screen.getByText('网络连接失败，请检查网络后重试。')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '重试' }));
    expect(onRefresh).toHaveBeenCalledTimes(1);
  });

  it('loads earlier Ozon messages from the thread without showing a placeholder', () => {
    const onLoadOlder = vi.fn();
    render(
      <CustomerConversationThread conversation={{ ...conversation, historyHasNext: true }} onLoadOlder={onLoadOlder} />
    );

    expect(screen.queryByText(/分页尚未接入/u)).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '加载更早消息' }));
    expect(onLoadOlder).toHaveBeenCalledTimes(1);
  });

  it('collapses long Ozon system notifications and lets the operator expand them', () => {
    const longText = Array.from({ length: 30 }, (_, index) => `物流节点 ${index + 1} 已更新`).join('；');
    render(
      <CustomerConversationThread
        conversation={{
          ...conversation,
          channel: 'push',
          messages: [{ id: 'push-1', role: 'system', title: '物流更新', text: longText, time: '14:30' }],
        }}
      />
    );

    const toggle = screen.getByRole('button', { name: '展开全文' });
    expect(toggle).toHaveAttribute('aria-expanded', 'false');
    fireEvent.click(toggle);
    expect(screen.getByRole('button', { name: '收起全文' })).toHaveAttribute('aria-expanded', 'true');
  });

  it('renders a buyer image through the shop-scoped proxy and opens the large preview', async () => {
    const imageUrl =
      'https://api-seller.ozon.ru/v2/chat/file/messenger-rotated-3/40ff6bb2-d55b-41d6-8dd2-5c69512acd54.jpg';
    render(
      <CustomerConversationThread
        conversation={{
          ...conversation,
          shopId: 'shop-2',
          messages: [
            {
              id: 'image-message',
              role: 'buyer',
              author: '买家 266352337',
              text: '[图片消息]',
              time: '19:30',
              attachments: [{ type: 'image', name: 'buyer-photo.jpg', url: imageUrl }],
            },
          ],
        }}
      />
    );

    const thumbnail = screen.getByAltText('buyer-photo.jpg');
    expect(thumbnail.getAttribute('src')).toContain('app://wangzai/api/customer-service/chat-file');
    expect(decodeURIComponent(thumbnail.getAttribute('src'))).toContain(imageUrl);
    Object.defineProperties(thumbnail, {
      naturalWidth: { configurable: true, value: 210 },
      naturalHeight: { configurable: true, value: 97 },
    });
    fireEvent.load(thumbnail);
    expect(thumbnail).toHaveClass('customer-chat-image-low-resolution');
    fireEvent.click(screen.getByRole('button', { name: '查看图片 1' }));
    expect(screen.getByRole('dialog')).toBeInTheDocument();
    const preview = screen.getAllByAltText('buyer-photo.jpg').at(-1);
    Object.defineProperties(preview, {
      naturalWidth: { configurable: true, value: 210 },
      naturalHeight: { configurable: true, value: 97 },
    });
    fireEvent.load(preview);
    expect(screen.getByText(/Ozon 源图 210 × 97/u)).toBeInTheDocument();
    expect(screen.getByText('400%')).toBeInTheDocument();
    expect(preview).toHaveStyle({ width: '840px', height: '388px' });
    fireEvent.click(screen.getByRole('button', { name: '关闭图片预览' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
  });
});
