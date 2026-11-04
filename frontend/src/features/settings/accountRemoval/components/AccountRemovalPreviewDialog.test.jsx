import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { AccountRemovalPreviewDialog } from './AccountRemovalPreviewDialog.jsx';

const preview = {
  owner: { ownerType: 'purchase_account', ownerId: 'purchase-dialog' },
  previewFingerprint: 'f'.repeat(64),
  plannedResources: [
    { id: 'registry:purchase-accounts', storageKind: 'sqlite' },
  ],
  preserveResources: [
    { id: 'registry:shops', storageKind: 'sqlite' },
  ],
  quiesceResources: [{ resourceId: 'runtime:purchase-task' }],
  fenceResources: [{ resourceId: 'runtime:purchase-task' }],
  drainResources: [{ resourceId: 'runtime:purchase-task' }],
};

const backupReview = {
  required: true,
  previewFingerprint: preview.previewFingerprint,
  dataFingerprint: 'd'.repeat(64),
  totalRecords: 21,
  domains: [{ domain: 'manual-order-facts', label: '采购补录', recordCount: 21, logicalBytes: 1024 }],
  latestVerifiedBackup: {
    backupId: 'backup-recent',
    status: 'verified',
    verified: true,
    dataFingerprint: 'd'.repeat(64),
    survivesAccountRemoval: true,
    verifiedAt: '2026-07-17T10:00:00.000Z',
  },
};

function requiredBackupFlow(overrides = {}) {
  return {
    open: true,
    stage: 'preview',
    owner: preview.owner,
    account: { displayName: '采购主账号' },
    preview,
    backupReview,
    backupAuthorization: null,
    backupError: '',
    operation: null,
    errorMessage: '',
    ...overrides,
  };
}

describe('AccountRemovalPreviewDialog', () => {
  it('uses one clear checkbox confirmation and renders resource names in Chinese', () => {
    const onConfirm = vi.fn();
    render(<AccountRemovalPreviewDialog
      flow={{
        open: true,
        stage: 'preview',
        owner: preview.owner,
        account: { displayName: '采购主账号' },
        preview,
        operation: null,
        errorMessage: '',
      }}
      busy={false}
      onConfirm={onConfirm}
      onRefresh={() => {}}
      onClose={() => {}}
    />);

    expect(screen.getByText('采购主账号')).toBeInTheDocument();
    expect(screen.getByText('将删除 1 项')).toBeInTheDocument();
    expect(screen.getByText('明确保留 1 项')).toBeInTheDocument();
    expect(screen.getByText('删除前停止 1 个相关任务')).toBeInTheDocument();
    expect(screen.getAllByText('采购账号').length).toBeGreaterThan(0);
    expect(screen.getByText('店铺资料')).toBeInTheDocument();
    expect(screen.queryByText('registry:purchase-accounts')).not.toBeInTheDocument();
    expect(screen.queryByText('registry:shops')).not.toBeInTheDocument();
    const confirmButton = screen.getByRole('button', { name: '确认永久删除' });
    expect(confirmButton).toBeDisabled();
    fireEvent.click(screen.getByRole('checkbox'));
    expect(confirmButton).toBeEnabled();
    fireEvent.click(confirmButton);
    expect(onConfirm).toHaveBeenCalledTimes(1);
  });

  it('allows a pre-operation failure to close and cancel the prepared removal', () => {
    const onClose = vi.fn();
    render(<AccountRemovalPreviewDialog
      flow={{
        open: true,
        stage: 'error',
        owner: { ownerType: 'model_api_account', ownerId: 'model-dialog' },
        account: null,
        preview: null,
        operation: null,
        errorMessage: '回读仍发现账号数据',
      }}
      busy={false}
      onConfirm={() => {}}
      onRefresh={() => {}}
      onClose={onClose}
    />);
    expect(screen.getByText('回读仍发现账号数据')).toBeInTheDocument();
    const cancel = screen.getByRole('button', { name: '关闭并取消删除' });
    expect(cancel).toBeEnabled();
    fireEvent.click(cancel);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('allows dismissing a durable unfinished removal while clearly retaining its retry task', () => {
    const onClose = vi.fn();
    render(<AccountRemovalPreviewDialog
      flow={{
        open: true,
        stage: 'error',
        owner: { ownerType: 'model_api_account', ownerId: 'model-dialog' },
        account: null,
        preview: null,
        operation: { operationId: 'account_removal_dialog_1', completed: false },
        errorMessage: '删除任务仍在恢复中',
      }}
      busy={false}
      onConfirm={() => {}}
      onRefresh={() => {}}
      onClose={onClose}
    />);
    expect(screen.getByText(/删除任务和安全保护会保留/u)).toBeInTheDocument();
    const cancel = screen.getByRole('button', { name: '关闭弹窗（任务继续）' });
    expect(cancel).toBeEnabled();
    fireEvent.click(screen.getByRole('button', { name: '关闭删除账号' }));
    expect(onClose).toHaveBeenCalledTimes(1);
    fireEvent.click(cancel);
    expect(onClose).toHaveBeenCalledTimes(2);
  });
  it('does not describe an uncertain submitted deletion as cancelled just because its operation id was lost', () => {
    const onClose = vi.fn();
    render(<AccountRemovalPreviewDialog
      flow={{ open: true, stage: 'error', owner: preview.owner, preview, operation: null, confirmationUncertain: true }}
      busy={false} onConfirm={() => {}} onRefresh={() => {}} onClose={onClose}
    />);
    expect(screen.queryByRole('button', { name: '关闭并取消删除' })).not.toBeInTheDocument();
    expect(screen.getByText(/删除请求已发送，结果尚未确认/u)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '关闭弹窗（任务继续）' }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });
  it('offers only continue-view and dismiss for a pending browser task, not another destructive confirmation', () => {
    const onRefresh = vi.fn();
    render(<AccountRemovalPreviewDialog flow={{ open: true, mode: 'direct', stage: 'pending', owner: preview.owner,
      preview, operation: { operationId: 'pending-op' }, errorMessage: '清理仍在进行，可稍后继续查看。' }}
      busy={false} onConfirm={() => {}} onRefresh={onRefresh} onClose={() => {}}
    />);
    expect(screen.queryByRole('button', { name: '确认永久删除' })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '继续查看' }));
    expect(onRefresh).toHaveBeenCalledTimes(1);
    expect(screen.getByRole('button', { name: '关闭弹窗（任务继续）' })).toBeEnabled();
  });

  it('defaults to passwordless backup confirmation and keeps permanent delete hidden', async () => {
    const onExportBackup = vi.fn(async () => null);
    const onUseRecentBackup = vi.fn(async () => null);
    render(<AccountRemovalPreviewDialog
      flow={requiredBackupFlow()}
      busy={false}
      onConfirm={() => {}}
      onExportBackup={onExportBackup}
      onUseRecentBackup={onUseRecentBackup}
      onSkipBackup={() => {}}
      onRefresh={() => {}}
      onClose={() => {}}
    />);

    expect(screen.getByText(/21 条数据无法通过重新同步恢复/u)).toBeInTheDocument();
    expect(screen.getByText('采购补录 21 条')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '确认永久删除' })).not.toBeInTheDocument();
    const backupButton = screen.getByRole('button', { name: '先备份再删除' });
    expect(backupButton).toBeEnabled();
    expect(screen.queryByLabelText('删除前备份口令')).not.toBeInTheDocument();
    fireEvent.click(backupButton);
    await waitFor(() => expect(onExportBackup).toHaveBeenCalledWith());
    fireEvent.click(screen.getByRole('button', { name: '使用最近已验证备份' }));
    expect(onUseRecentBackup).toHaveBeenCalledTimes(1);
  });

  it('uses an independent checkbox before allowing the user to skip backup', async () => {
    const onSkipBackup = vi.fn(async () => ({ outcome: 'explicitly-skipped' }));
    const { rerender } = render(<AccountRemovalPreviewDialog
      flow={requiredBackupFlow()}
      busy={false}
      onConfirm={() => {}}
      onExportBackup={() => {}}
      onUseRecentBackup={() => {}}
      onSkipBackup={onSkipBackup}
      onRefresh={() => {}}
      onClose={() => {}}
    />);

    fireEvent.click(screen.getByRole('button', { name: '跳过备份并永久删除' }));
    const skipConfirmButton = screen.getByRole('button', { name: '仍然永久删除' });
    expect(skipConfirmButton).toBeDisabled();
    fireEvent.click(screen.getByRole('checkbox', {
      name: '我了解跳过备份后这些数据可能无法恢复',
    }));
    expect(skipConfirmButton).toBeEnabled();
    fireEvent.click(skipConfirmButton);
    await waitFor(() => expect(onSkipBackup).toHaveBeenCalledWith());

    rerender(<AccountRemovalPreviewDialog
      flow={requiredBackupFlow({
        backupAuthorization: {
          outcome: 'explicitly-skipped',
          previewFingerprint: preview.previewFingerprint,
          dataFingerprint: backupReview.dataFingerprint,
          skipConfirmationCode: 'SKIP_BACKUP_AND_DELETE_PERMANENTLY',
        },
      })}
      busy={false}
      onConfirm={() => {}}
      onExportBackup={() => {}}
      onUseRecentBackup={() => {}}
      onSkipBackup={onSkipBackup}
      onRefresh={() => {}}
      onClose={() => {}}
    />);
    expect(screen.getByText(/已明确选择跳过备份/u)).toBeInTheDocument();
    await waitFor(() => expect(screen.getByRole('checkbox', {
      name: '我已核对删除账号和数据范围，确认继续永久删除',
    })).toBeInTheDocument());
  });

  it('keeps direct deletion free of preview, backup, refresh, and retry actions', () => {
    render(<AccountRemovalPreviewDialog
      flow={{
        ...requiredBackupFlow(),
        mode: 'direct',
        stage: 'error',
        operation: { operationId: 'account_removal_direct_1', completed: false },
        errorMessage: '删除执行中断',
      }}
      busy={false}
      onConfirm={() => {}}
      onExportBackup={() => {}}
      onUseRecentBackup={() => {}}
      onSkipBackup={() => {}}
      onRefresh={() => {}}
      onClose={() => {}}
    />);

    expect(screen.getByText('删除执行中断')).toBeInTheDocument();
    expect(screen.queryByText('本次精确删除')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '先备份再删除' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '刷新预览' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '安全重试' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '确认永久删除' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: '关闭弹窗（任务继续）' })).toBeEnabled();
  });
});
