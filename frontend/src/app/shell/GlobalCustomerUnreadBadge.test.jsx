import { fireEvent, render, screen } from '@testing-library/react';
import { GlobalCustomerUnreadBadge } from './GlobalCustomerUnreadBadge.jsx';
import { describe, expect, it, vi } from 'vitest';

describe('GlobalCustomerUnreadBadge', () => {
  it('does not occupy the page when there is no unread buyer message', () => {
    const { container } = render(<GlobalCustomerUnreadBadge unreadCount={0} />);
    expect(container).toBeEmptyDOMElement();
  });

  it('shows the exact unread count and opens the customer conversation', () => {
    const onClick = vi.fn();
    render(
      <GlobalCustomerUnreadBadge
        unreadCount={5}
        latest={{ shopName: 'Ozon 2店', customerName: '买家甲' }}
        onClick={onClick}
      />
    );

    fireEvent.click(screen.getByRole('button', { name: '打开在线客服，当前有 5 条未读买家消息' }));
    expect(onClick).toHaveBeenCalledTimes(1);
    expect(screen.getByText('5')).toBeInTheDocument();
  });

  it('caps the visible number while preserving the full accessible count', () => {
    render(<GlobalCustomerUnreadBadge unreadCount={128} />);
    expect(screen.getByText('99+')).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: '打开在线客服，当前有 128 条未读买家消息' })
    ).toBeInTheDocument();
  });
});
