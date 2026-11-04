import { CustomerConversationList } from './CustomerConversationList.jsx';
import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

const baseProps = {
  filters: [
    { id: 'all', label: '全部' },
    { id: 'buyer', label: '买家咨询' },
  ],
  statusFilters: [
    { id: 'all', label: '全部状态' },
    { id: 'waiting', label: '等待回复' },
  ],
  selectedFilterId: 'all',
  selectedStatusId: 'all',
  selectedConversationId: 'shop-a::chat-1',
  searchText: '',
  onSelectFilter: vi.fn(),
  onSelectStatus: vi.fn(),
  onToggleUnread: vi.fn(),
  onSelectConversation: vi.fn(),
  onSearchChange: vi.fn(),
  onRefresh: vi.fn(),
  onLoadMore: vi.fn(),
  onMarkAllRead: vi.fn(),
};

const conversation = {
  id: 'shop-a::chat-1',
  category: 'buyer',
  channel: 'chat',
  title: '买家 1',
  subtitle: 'Ozon 买家咨询',
  status: '待回复',
  unread: 2,
  unreadCount: 2,
  time: '16:00',
  lastMessage: '请问什么时候发货？',
};

describe('customer conversation list controls', () => {
  it('shows status/unread controls and disables unsupported mark-read writes', () => {
    render(
      <CustomerConversationList
        {...baseProps}
        conversations={[conversation]}
        unreadCount={2}
        markReadSupported={false}
        markReadUnavailableReason="后端暂未提供标记已读功能"
      />
    );

    expect(screen.getByRole('combobox', { name: '会话状态' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '全部标记为已读' })).toBeDisabled();
    fireEvent.mouseDown(screen.getByRole('combobox', { name: '会话状态' }));
    fireEvent.click(screen.getByRole('option', { name: '等待回复' }));
    expect(baseProps.onSelectStatus).toHaveBeenCalledWith('waiting');
    fireEvent.click(screen.getByRole('button', { name: '仅看未读' }));
    expect(baseProps.onToggleUnread).toHaveBeenCalledWith(true);
  });

  it('enables mark-all-read when the backend capability is connected', () => {
    const onMarkAllRead = vi.fn();
    render(
      <CustomerConversationList
        {...baseProps}
        onMarkAllRead={onMarkAllRead}
        conversations={[conversation]}
        unreadCount={2}
        markReadSupported
      />
    );

    const button = screen.getByRole('button', { name: '全部标记为已读' });
    expect(button).toBeEnabled();
    fireEvent.click(button);
    expect(onMarkAllRead).toHaveBeenCalledTimes(1);
  });

  it('keeps the bulk action disabled when only read-only push messages remain', () => {
    render(
      <CustomerConversationList
        {...baseProps}
        conversations={[{ ...conversation, category: 'notification', channel: 'push' }]}
        unreadCount={3}
        actionableUnreadCount={0}
        readOnlyUnreadCount={3}
        markReadSupported
      />
    );

    const button = screen.getByRole('button', { name: '全部标记为已读' });
    expect(button).toBeDisabled();
  });

  it('renders load-more and the terminal no-more state', () => {
    const onLoadMore = vi.fn();
    const { rerender } = render(
      <CustomerConversationList {...baseProps} onLoadMore={onLoadMore} conversations={[conversation]} hasNext />
    );
    fireEvent.click(screen.getByRole('button', { name: '加载更多' }));
    expect(onLoadMore).toHaveBeenCalledTimes(1);

    rerender(
      <CustomerConversationList {...baseProps} onLoadMore={onLoadMore} conversations={[conversation]} hasNext={false} />
    );
    expect(screen.getByText('没有更多内容')).toBeInTheDocument();
  });
});
