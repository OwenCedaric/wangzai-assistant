import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { RecoveryBackupCard } from './RecoveryBackupCard.jsx';

const mocks = vi.hoisted(() => ({
  getLocalShops: vi.fn(),
  getRecoveryStatus: vi.fn(),
  backupShopRecovery: vi.fn(),
  listRecoveryGenerations: vi.fn(),
  stageRecoveryGenerations: vi.fn(),
  activateStagedRecovery: vi.fn(),
  reloadDesktopAfterRestore: vi.fn(),
}));

vi.mock('../../../api/localApiClient.js', () => ({ getLocalShops: mocks.getLocalShops }));
vi.mock('../services/recoveryDesktopClient.js', () => ({
  backupShopRecovery: mocks.backupShopRecovery,
  getRecoveryStatus: mocks.getRecoveryStatus,
  listRecoveryGenerations: mocks.listRecoveryGenerations,
  stageRecoveryGenerations: mocks.stageRecoveryGenerations,
  activateStagedRecovery: mocks.activateStagedRecovery,
  reloadDesktopAfterRestore: mocks.reloadDesktopAfterRestore,
}));

afterEach(() => vi.clearAllMocks());

describe('RecoveryBackupCard', () => {
  it('does not load shops until opened, then sends only shop id and optional passphrase to the desktop client', async () => {
    mocks.getLocalShops.mockResolvedValue({ shops: [{ id: 'shop-a', alias: '主店' }] });
    mocks.getRecoveryStatus.mockResolvedValue({ enrolled: false, reconcile: { pending: 0, queued: 1, rows: [] } });
    mocks.backupShopRecovery.mockResolvedValue({ remoteGenerationId: 'remote-1' });
    render(<RecoveryBackupCard />);
    expect(mocks.getLocalShops).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: '设置备份' }));
    await waitFor(() => expect(mocks.getLocalShops).toHaveBeenCalledTimes(1));
    expect(await screen.findByText(/Ozon 数据核对已在后台排队/)).toBeTruthy();
    fireEvent.change(screen.getByLabelText('恢复口令（首次设置必填）'), {
      target: { value: 'portable recovery passphrase' },
    });
    fireEvent.click(screen.getByRole('button', { name: '立即备份' }));
    await waitFor(() => expect(mocks.backupShopRecovery).toHaveBeenCalledWith({
      shopId: 'shop-a', passphrase: 'portable recovery passphrase',
    }));
    expect(await screen.findByText(/已加密提交服务器备份/)).toBeTruthy();
  });

  it('stages server recovery before explicitly activating the verified database switch', async () => {
    mocks.getLocalShops.mockResolvedValue({ shops: [] });
    mocks.getRecoveryStatus.mockResolvedValue({ enrolled: false });
    mocks.listRecoveryGenerations.mockResolvedValue([{ generation_id: 'g1', created_at: '2026-07-11', logical_cipher_bytes: 1024 }]);
    mocks.stageRecoveryGenerations.mockResolvedValue({ restoreId: 'restore-1', mode: 'staging-ready', shopCount: 1 });
    mocks.activateStagedRecovery.mockResolvedValue({ mode: 'activated' });
    mocks.reloadDesktopAfterRestore.mockResolvedValue(undefined);
    render(<RecoveryBackupCard />);
    fireEvent.click(screen.getByRole('button', { name: '设置备份' }));
    await waitFor(() => expect(mocks.getLocalShops).toHaveBeenCalledTimes(1));
    fireEvent.click(screen.getByRole('button', { name: '从服务器恢复到此电脑' }));
    await waitFor(() => expect(mocks.listRecoveryGenerations).toHaveBeenCalledTimes(1));
    fireEvent.change(screen.getByLabelText('恢复口令'), { target: { value: 'portable recovery passphrase' } });
    fireEvent.click(screen.getByRole('button', { name: '下载并校验全部恢复数据' }));
    await waitFor(() => expect(mocks.stageRecoveryGenerations).toHaveBeenCalledWith({
      generationIds: ['g1'], passphrase: 'portable recovery passphrase',
    }));
    fireEvent.click(screen.getByRole('button', { name: '确认切换' }));
    await waitFor(() => expect(mocks.activateStagedRecovery).toHaveBeenCalledWith({ restoreId: 'restore-1' }));
    expect(mocks.reloadDesktopAfterRestore).toHaveBeenCalledTimes(1);
  });

  it('shows a completed recovery reconcile result instead of treating accepted jobs as permanently queued', async () => {
    mocks.getLocalShops.mockResolvedValue({ shops: [{ id: 'shop-a', alias: '主店' }] });
    mocks.getRecoveryStatus.mockResolvedValue({ enrolled: true, reconcile: { pending: 0, queued: 0, completed: 1, partial: 0, failed: 0 } });
    render(<RecoveryBackupCard />);
    fireEvent.click(screen.getByRole('button', { name: '设置备份' }));
    expect(await screen.findByText(/Ozon 数据核对已完成/)).toBeTruthy();
  });

  it('recovery-only mode hides backup controls and directs the user straight to server restore', async () => {
    mocks.getRecoveryStatus.mockResolvedValue({ enrolled: false });
    render(<RecoveryBackupCard recoveryOnly />);
    fireEvent.click(screen.getByRole('button', { name: '恢复资料' }));
    await waitFor(() => expect(mocks.getRecoveryStatus).toHaveBeenCalledTimes(1));
    expect(mocks.getLocalShops).not.toHaveBeenCalled();
    expect(screen.queryByRole('button', { name: '立即备份' })).not.toBeInTheDocument();
    expect(screen.getByText(/当前处于恢复模式/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: '读取服务器恢复备份' }));
    await waitFor(() => expect(mocks.listRecoveryGenerations).toHaveBeenCalledTimes(1));
  });
});
