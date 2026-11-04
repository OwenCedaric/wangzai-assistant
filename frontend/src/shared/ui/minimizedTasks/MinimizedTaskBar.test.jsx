import { fireEvent, render, screen } from '@testing-library/react';
import React from 'react';
import { describe, expect, it, vi } from 'vitest';
import { MinimizedTaskBar } from './MinimizedTaskBar.jsx';
import {
  MinimizedTaskProvider,
  useMinimizedTaskRegistration,
} from './MinimizedTaskProvider.jsx';
import { useMinimizableDialogTask } from './useMinimizableDialogTask.js';

function RegisteredTask({ id, title, subtitle, restore, close }) {
  useMinimizedTaskRegistration({
    active: true,
    id,
    kind: 'order-workbench',
    title,
    subtitle,
    restore,
    close,
  });
  return null;
}

function MinimizableDialogHarness() {
  const [open, setOpen] = React.useState(true);
  const task = useMinimizableDialogTask({
    open,
    kind: 'purchase-operation',
    title: '采购操作',
    subtitle: 'ORDER-88',
    onClose: () => setOpen(false),
  });
  if (!open) return <span>弹窗已关闭</span>;
  return task.visibleOpen ? (
    <button type="button" onClick={task.minimize}>最小化采购操作</button>
  ) : null;
}

describe('MinimizedTaskBar', () => {
  it('restores and closes multiple minimized order tasks independently', () => {
    const restoreFirst = vi.fn();
    const closeFirst = vi.fn();
    const restoreSecond = vi.fn();
    const closeSecond = vi.fn();
    render(
      <MinimizedTaskProvider>
        <RegisteredTask
          id="task-order-1"
          title="订单操作台"
          subtitle="ORDER-1"
          restore={restoreFirst}
          close={closeFirst}
        />
        <RegisteredTask
          id="task-after-sales-1"
          title="售后订单操作台"
          subtitle="AFTER-1"
          restore={restoreSecond}
          close={closeSecond}
        />
        <MinimizedTaskBar />
      </MinimizedTaskProvider>
    );

    expect(screen.getByRole('region', { name: '已最小化的订单任务' })).toBeInTheDocument();
    expect(screen.getByText('2')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '恢复订单操作台' }));
    expect(restoreFirst).toHaveBeenCalledOnce();
    expect(closeFirst).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: '关闭售后订单操作台' }));
    expect(closeSecond).toHaveBeenCalledOnce();
    expect(restoreSecond).not.toHaveBeenCalled();
  });

  it('keeps a normal order dialog mounted while its card is minimized', () => {
    render(
      <MinimizedTaskProvider>
        <MinimizableDialogHarness />
        <MinimizedTaskBar />
      </MinimizedTaskProvider>
    );

    fireEvent.click(screen.getByRole('button', { name: '最小化采购操作' }));
    expect(screen.queryByRole('button', { name: '最小化采购操作' })).not.toBeInTheDocument();
    expect(screen.getByText('ORDER-88')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '恢复采购操作' }));
    expect(screen.getByRole('button', { name: '最小化采购操作' })).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: '最小化采购操作' }));
    fireEvent.click(screen.getByRole('button', { name: '关闭采购操作' }));
    expect(screen.getByText('弹窗已关闭')).toBeInTheDocument();
  });
});
