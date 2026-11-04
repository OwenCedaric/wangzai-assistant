import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  getAllDataBackupPreviews: vi.fn(),
  getDataBackupHistory: vi.fn(),
  getDataBackupImportHistory: vi.fn(),
  getDataBackupOwnerHistory: vi.fn(),
  getDataBackupOwnerImportHistory: vi.fn(),
  exportDataBackup: vi.fn(),
  exportDataBackupBatch: vi.fn(),
  preflightSoftwareBackupImport: vi.fn(),
  commitSoftwareBackupImport: vi.fn(),
  getHistoricalOrderImportHistory: vi.fn(),
  preflightHistoricalOrderImport: vi.fn(),
  confirmHistoricalOrderImport: vi.fn(),
}));

vi.mock('./services/dataBackupClient.js', () => ({
  getAllDataBackupPreviews: mocks.getAllDataBackupPreviews,
  getDataBackupHistory: mocks.getDataBackupHistory,
  getDataBackupImportHistory: mocks.getDataBackupImportHistory,
  getDataBackupOwnerHistory: mocks.getDataBackupOwnerHistory,
  getDataBackupOwnerImportHistory: mocks.getDataBackupOwnerImportHistory,
}));
vi.mock('./services/dataBackupDesktopClient.js', () => ({
  exportDataBackup: mocks.exportDataBackup,
  exportDataBackupBatch: mocks.exportDataBackupBatch,
  preflightSoftwareBackupImport: mocks.preflightSoftwareBackupImport,
  commitSoftwareBackupImport: mocks.commitSoftwareBackupImport,
}));
vi.mock('./services/historicalOrderImportClient.js', () => ({
  getHistoricalOrderImportHistory: mocks.getHistoricalOrderImportHistory,
  preflightHistoricalOrderImport: mocks.preflightHistoricalOrderImport,
  confirmHistoricalOrderImport: mocks.confirmHistoricalOrderImport,
}));

import { DataBackupPage } from './DataBackupPage.jsx';

const shops = [
  { id: 'shop-a', shopAlias: '主店', sellerName: 'Ozon 官方旗舰店', clientId: '46000123' },
  { id: 'shop-b', shopAlias: '副店', sellerName: 'Ozon 第二店', clientId: '46000456' },
];

function preview(shopId = 'shop-a', displayName = '主店') {
  const owner = {
    owner: { ownerType: 'ozon_shop', ownerId: shopId },
    ownerType: 'ozon_shop',
    ownerId: shopId,
    ownerTypeLabel: 'Ozon 店铺',
    ownerKey: JSON.stringify(['ozon_shop', shopId]),
    shopId,
    displayName,
    domains: [
      { domain: 'shops', label: '店铺资料', recordCount: 1, logicalBytes: 128, requiredForRestore: true },
      { domain: 'shop-credentials', label: '店铺凭证', recordCount: 1, logicalBytes: 128, requiredForRestore: true },
      { domain: 'purchase-overrides', label: '采购补录', recordCount: 21, logicalBytes: 4096 },
    ],
    totalRecords: 23,
    dataFingerprint: `fingerprint-${shopId}`,
    latestVerifiedBackup: null,
  };
  return {
    owners: [owner],
    shops: [{
      shopId,
      displayName,
      domains: owner.domains,
      totalRecords: 23,
      dataFingerprint: `fingerprint-${shopId}`,
      latestVerifiedBackup: null,
    }],
  };
}

afterEach(() => vi.clearAllMocks());

beforeEach(() => {
  mocks.getHistoricalOrderImportHistory.mockResolvedValue([]);
  mocks.getDataBackupImportHistory.mockResolvedValue([]);
  mocks.getDataBackupOwnerHistory.mockResolvedValue([]);
  mocks.getDataBackupOwnerImportHistory.mockResolvedValue([]);
});

describe('DataBackupPage', () => {
  it('loads the selected shop and requires a second confirmation before passwordless export', async () => {
    mocks.getAllDataBackupPreviews.mockResolvedValue(preview());
    mocks.getDataBackupHistory.mockResolvedValue([{
      id: 'history-1',
      fileName: 'verified-backup.wzb',
      completedAt: '2026-07-17T09:00:00.000Z',
      totalRecords: 21,
      logicalBytes: 4096,
      verified: true,
      verificationStatus: 'verified',
      path: 'C:/must-not-render/history.wzb',
    }]);
    mocks.exportDataBackup.mockResolvedValue({ canceled: false, verified: true });

    render(<DataBackupPage shops={shops} activeShopId="shop-a" />);

    expect((await screen.findAllByText('采购补录')).length).toBeGreaterThanOrEqual(2);
    expect(screen.queryByText('purchase-overrides')).not.toBeInTheDocument();
    expect(screen.queryByText(/商品和订单可以重新同步/u)).not.toBeInTheDocument();
    expect(screen.getByText('恢复软件备份')).toBeInTheDocument();
    expect(screen.getByText('选择账号或店铺，导出本地备份。')).toBeInTheDocument();
    expect(screen.queryByText(/数据注册表|本机服务统一提供|不设固定容量配额/u)).not.toBeInTheDocument();
    expect(screen.getAllByText('Ozon 官方旗舰店').length).toBeGreaterThanOrEqual(1);
    expect(screen.getAllByText(/店铺 ID：46000123/u).length).toBeGreaterThanOrEqual(1);
    expect(screen.getByRole('combobox', { name: '历史订单所属店铺' })).toHaveTextContent('Ozon 官方旗舰店');
    expect(screen.getByRole('combobox', { name: '历史订单所属店铺' })).toHaveTextContent('店铺 ID：46000123');
    expect(screen.getByRole('heading', { name: '历史订单导入' })).toBeInTheDocument();
    expect(screen.queryByText('导入历史商品数据')).not.toBeInTheDocument();
    expect(mocks.getAllDataBackupPreviews).toHaveBeenCalled();
    expect(screen.getByText('verified-backup.wzb')).toBeInTheDocument();
    expect(screen.queryByText(/must-not-render/u)).not.toBeInTheDocument();

    const exportButton = screen.getByRole('button', { name: '导出备份' });
    expect(exportButton).toBeEnabled();
    expect(screen.queryByLabelText('导出口令')).not.toBeInTheDocument();
    fireEvent.click(exportButton);
    expect(mocks.exportDataBackup).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: '确认导出' }));

    await waitFor(() => expect(mocks.exportDataBackup).toHaveBeenCalledWith({
      owner: { ownerType: 'ozon_shop', ownerId: 'shop-a' },
      expectedDataFingerprint: 'fingerprint-shop-a',
      selectedDomains: ['purchase-overrides', 'shop-credentials', 'shops'],
    }));
    expect(await screen.findByText('备份文件已落盘并通过完整性校验。')).toBeInTheDocument();
    expect(mocks.getAllDataBackupPreviews.mock.calls.length).toBeGreaterThanOrEqual(2);
  });

  it('does not read backup data while its workspace tab is inactive', async () => {
    mocks.getAllDataBackupPreviews.mockResolvedValue(preview());
    mocks.getDataBackupHistory.mockResolvedValue([]);
    const { rerender } = render(<DataBackupPage shops={shops} activeShopId="shop-a" isActive={false} />);
    expect(mocks.getAllDataBackupPreviews).not.toHaveBeenCalled();
    rerender(<DataBackupPage shops={shops} activeShopId="shop-a" isActive />);
    await waitFor(() => expect(mocks.getAllDataBackupPreviews).toHaveBeenCalledTimes(1));
  });

  it('exports only checked domains and keeps restore identity locked', async () => {
    mocks.getAllDataBackupPreviews.mockResolvedValue(preview());
    mocks.getDataBackupHistory.mockResolvedValue([]);
    mocks.exportDataBackup.mockResolvedValue({ canceled: false, verified: true });
    render(<DataBackupPage shops={shops} activeShopId="shop-a" />);
    await screen.findAllByText('采购补录');

    expect(screen.queryByText('当前账号/店铺还没有已验证的用户导出备份。')).not.toBeInTheDocument();
    expect(screen.queryByText('当前店铺还没有备份或导入记录。')).not.toBeInTheDocument();
    expect(screen.queryByText('恢复必需')).not.toBeInTheDocument();
    expect(screen.queryByText(/店铺身份与映射信息用于安全恢复/u)).not.toBeInTheDocument();

    expect(screen.getByRole('checkbox', { name: /店铺资料/u })).toBeDisabled();
    expect(screen.getByRole('checkbox', { name: /店铺凭证/u })).toBeDisabled();
    const optionalDomain = screen.getByRole('checkbox', { name: /采购补录/u });
    expect(optionalDomain).toBeChecked();
    fireEvent.click(optionalDomain);
    expect(optionalDomain).not.toBeChecked();

    fireEvent.click(screen.getByRole('button', { name: '导出备份' }));
    expect(screen.getByText(/本次选择 2 类、2 条/u)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '确认导出' }));
    await waitFor(() => expect(mocks.exportDataBackup).toHaveBeenCalledWith({
      owner: { ownerType: 'ozon_shop', ownerId: 'shop-a' },
      expectedDataFingerprint: 'fingerprint-shop-a',
      selectedDomains: ['shop-credentials', 'shops'],
    }));
  });

  it('reports a canceled save without claiming that a backup completed', async () => {
    mocks.getAllDataBackupPreviews.mockResolvedValue(preview());
    mocks.getDataBackupHistory.mockResolvedValue([]);
    mocks.exportDataBackup.mockResolvedValue({ canceled: true });
    render(<DataBackupPage shops={shops} activeShopId="shop-a" />);
    await screen.findAllByText('采购补录');
    fireEvent.click(screen.getByRole('button', { name: '导出备份' }));
    fireEvent.click(screen.getByRole('button', { name: '确认导出' }));
    expect(await screen.findByText('已取消导出，没有创建备份文件。')).toBeInTheDocument();
    expect(screen.queryByText('备份文件已落盘并通过完整性校验。')).not.toBeInTheDocument();
  });

  it('backs up every account with one confirmation and one desktop batch command', async () => {
    const ozonPreview = preview();
    const purchaseOwner = {
      owner: { ownerType: 'purchase_account', ownerId: 'purchase-a' },
      ownerType: 'purchase_account',
      ownerId: 'purchase-a',
      ownerTypeLabel: '采购账号',
      ownerKey: JSON.stringify(['purchase_account', 'purchase-a']),
      shopId: '',
      displayName: '1688 主账号',
      domains: [{
        domain: 'purchase-accounts',
        label: '采购账号',
        recordCount: 1,
        logicalBytes: 256,
        requiredForRestore: true,
      }],
      totalRecords: 1,
      dataFingerprint: 'fingerprint-purchase-a',
      latestVerifiedBackup: null,
    };
    mocks.getAllDataBackupPreviews.mockResolvedValue({
      owners: [...ozonPreview.owners, purchaseOwner],
      shops: ozonPreview.shops,
    });
    mocks.getDataBackupHistory.mockResolvedValue([]);
    mocks.exportDataBackupBatch.mockResolvedValue({
      canceled: false,
      verified: true,
      backups: [{ backupId: 'backup-a' }, { backupId: 'backup-b' }],
    });

    render(<DataBackupPage shops={shops} activeShopId="shop-a" />);
    const batchButton = await screen.findByRole('button', { name: '一键备份全部' });
    expect(batchButton).toBeEnabled();
    fireEvent.click(batchButton);
    expect(mocks.exportDataBackupBatch).not.toHaveBeenCalled();
    expect(screen.getByText(/一次性导出 2 个账号\/店铺/u)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '确认导出' }));

    await waitFor(() => expect(mocks.exportDataBackupBatch).toHaveBeenCalledWith([
      {
        owner: { ownerType: 'ozon_shop', ownerId: 'shop-a' },
        expectedDataFingerprint: 'fingerprint-shop-a',
        selectedDomains: ['shops', 'shop-credentials', 'purchase-overrides'],
      },
      {
        owner: { ownerType: 'purchase_account', ownerId: 'purchase-a' },
        expectedDataFingerprint: 'fingerprint-purchase-a',
        selectedDomains: ['purchase-accounts'],
      },
    ]));
    expect(await screen.findByText('已完成 2 个账号/店铺的批量备份并通过校验。')).toBeInTheDocument();
  });
});
