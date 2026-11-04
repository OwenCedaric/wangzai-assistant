import { CustomerMarkAllReadDialog } from './CustomerMarkAllReadDialog.jsx';
import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

const uuid = '64001fdd-351e-43e7-b965-cc1e1596472d';

function createState(overrides = {}) {
  return {
    open: true,
    status: 'ready',
    chats: [{ chat_id: uuid, unread_count: 3 }],
    previewRows: [
      {
        chatId: uuid,
        title: '买家 58465754',
        categoryLabel: '买家咨询',
        unreadCount: 3,
        subtitle: '订单 58465754-0120-1',
      },
    ],
    unreadMessages: 3,
    result: null,
    error: '',
    ...overrides,
  };
}

describe('CustomerMarkAllReadDialog', () => {
  it('shows readable preview information without exposing the raw chat UUID', () => {
    render(<CustomerMarkAllReadDialog state={createState()} onClose={vi.fn()} onConfirm={vi.fn()} />);

    expect(screen.getByText('买家 58465754')).toBeInTheDocument();
    expect(screen.getByText('买家咨询 · 订单 58465754-0120-1')).toBeInTheDocument();
    expect(screen.getByText('未读 3 条')).toBeInTheDocument();
    expect(screen.queryByText(new RegExp(uuid))).not.toBeInTheDocument();
  });

  it('maps failed readback rows back to the readable conversation title', () => {
    render(
      <CustomerMarkAllReadDialog
        state={createState({
          status: 'partial',
          result: { failures: [{ chatId: uuid, error: { message: '仍有未读消息' } }] },
          error: '部分会话未完成',
        })}
        onClose={vi.fn()}
        onConfirm={vi.fn()}
      />
    );

    expect(screen.getAllByText(/买家 58465754/).length).toBeGreaterThan(0);
    expect(screen.queryByText(new RegExp(uuid))).not.toBeInTheDocument();
  });
});
