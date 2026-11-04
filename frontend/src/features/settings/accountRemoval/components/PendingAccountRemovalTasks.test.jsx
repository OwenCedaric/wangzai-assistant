import React from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
const resume = vi.hoisted(() => vi.fn());
vi.mock('../model/useAccountRemovalFlow.js', () => ({ useAccountRemovalFlow: () => ({
  flow: { open: false, stage: 'idle', owner: null }, busy: false, resumePendingOperation: resume,
  confirmRemoval: vi.fn(), refreshPreview: vi.fn(), closeAccountRemoval: vi.fn(),
}) }));
vi.mock('../../SettingsModuleContent.jsx', () => ({ default: () => null }));
import { PendingAccountRemovalTasks } from './PendingAccountRemovalTasks.jsx';
import ShopSettingsDialog from '../../ShopSettingsDialog.jsx';

const task = { operationId: 'pending-old-1', phase: 'external-delete-pending', createdAt: '2026-09-05T00:00:00Z',
  pendingOwner: { ownerType: 'model_api_account', ownerId: 'removed-owner' } };
beforeEach(() => { resume.mockReset().mockResolvedValue({ completed: false }); });

describe('pending removal settings entry', () => {
  it('only reads on view and never resumes unless the user explicitly chooses a task', async () => {
    const read = vi.fn().mockResolvedValue({ ok: true, operations: [task] });
    render(<PendingAccountRemovalTasks read={read} />);
    expect(read).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: '查看 / 继续未完成删除' }));
    await screen.findByText(/pending-old-1/);
    expect(read).toHaveBeenCalledTimes(1);
    expect(resume).not.toHaveBeenCalled();
    expect(screen.queryByText('removed-owner')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '继续删除任务 pending-old-1' }));
    await waitFor(() => expect(resume).toHaveBeenCalledWith(expect.objectContaining({ operationId: task.operationId })));
  });
  it('shows read failure and retry rather than pretending there are zero tasks', async () => {
    const read = vi.fn().mockRejectedValueOnce(new Error('offline')).mockResolvedValue({ operations: [task] });
    render(<PendingAccountRemovalTasks read={read} />);
    fireEvent.click(screen.getByRole('button', { name: '查看 / 继续未完成删除' }));
    await screen.findByText(/未完成删除列表读取失败/);
    expect(screen.queryByText('没有未完成的删除任务。')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '重新读取' }));
    await screen.findByText(/pending-old-1/);
  });
  it('keeps unavailable recovery rows visible but disabled without hiding healthy tasks', async () => {
    const read = vi.fn().mockResolvedValue({ operations: [task, { operationId: 'unavailable', recoveryUnavailable: true,
      error: { code: 'ACCOUNT_REMOVAL_RECOVERY_DATA_UNAVAILABLE' }, phase: 'external-delete-pending' }] });
    render(<PendingAccountRemovalTasks read={read} />);
    fireEvent.click(screen.getByRole('button', { name: '查看 / 继续未完成删除' }));
    await screen.findByText('恢复信息缺失，不能安全继续。');
    expect(screen.getByRole('button', { name: '继续删除任务 unavailable' })).toBeDisabled();
    expect(screen.getByRole('button', { name: '继续删除任务 pending-old-1' })).toBeEnabled();
    expect(resume).not.toHaveBeenCalled();
  });
  it('is reachable from the common settings header even with no surviving account rows', async () => {
    render(<ShopSettingsDialog open shops={[]} activeShopId="" initialModule="modelApi" onClose={() => {}} />);
    expect(await screen.findByRole('button', { name: '查看 / 继续未完成删除' })).toBeVisible();
  });
});
