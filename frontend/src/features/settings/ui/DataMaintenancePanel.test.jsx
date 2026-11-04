import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DataMaintenancePanel } from './DataMaintenancePanel.jsx';

const mocks = vi.hoisted(() => ({
  confirmDatabaseCompaction: vi.fn(),
  confirmManualShopScopeResolution: vi.fn(),
  confirmShopScopeRepair: vi.fn(),
  confirmTechnicalRetention: vi.fn(),
  getLocalStorageAudit: vi.fn(),
  getLocalDataConsistencyAudit: vi.fn(),
  getDatabaseCompactionPreview: vi.fn(),
  getManualShopScopeResolutionPreview: vi.fn(),
  getShopScopeRepairPreview: vi.fn(),
  getTechnicalRetentionPreview: vi.fn(),
  getTechnicalRetentionStatus: vi.fn(),
  getProfileMaintenanceContracts: vi.fn(async () => ({
    ok: true,
    commands: { 'rebuild-domain': { targetDomains: ['product-image-health'] } },
  })),
  previewProfileSpaceRelease: vi.fn(async () => ({
    ok: true,
    humanConfirmationToken: 'space-empty-token',
    targetRows: 0,
    targetResources: [],
  })),
  confirmProfileSpaceRelease: vi.fn(),
  previewProfileDomainRebuild: vi.fn(),
  prepareProfileDomainRebuildTicket: vi.fn(),
  confirmProfileDomainRebuild: vi.fn(),
  requestProfileCacheMaintenanceRestart: vi.fn(),
}));

vi.mock('../../../api/localApiClient.js', () => ({
  confirmDatabaseCompaction: mocks.confirmDatabaseCompaction,
  confirmManualShopScopeResolution: mocks.confirmManualShopScopeResolution,
  confirmShopScopeRepair: mocks.confirmShopScopeRepair,
  confirmTechnicalRetention: mocks.confirmTechnicalRetention,
  getLocalStorageAudit: mocks.getLocalStorageAudit,
  getLocalDataConsistencyAudit: mocks.getLocalDataConsistencyAudit,
  getDatabaseCompactionPreview: mocks.getDatabaseCompactionPreview,
  getManualShopScopeResolutionPreview: mocks.getManualShopScopeResolutionPreview,
  getShopScopeRepairPreview: mocks.getShopScopeRepairPreview,
  getTechnicalRetentionPreview: mocks.getTechnicalRetentionPreview,
  getTechnicalRetentionStatus: mocks.getTechnicalRetentionStatus,
}));

vi.mock('../services/profileMaintenanceClient.js', () => ({
  confirmProfileDomainRebuild: mocks.confirmProfileDomainRebuild,
  confirmProfileSpaceRelease: mocks.confirmProfileSpaceRelease,
  getProfileMaintenanceContracts: mocks.getProfileMaintenanceContracts,
  prepareProfileDomainRebuildTicket: mocks.prepareProfileDomainRebuildTicket,
  previewProfileDomainRebuild: mocks.previewProfileDomainRebuild,
  previewProfileSpaceRelease: mocks.previewProfileSpaceRelease,
}));

vi.mock('../services/profileCacheMaintenanceDesktopClient.js', () => ({
  requestProfileCacheMaintenanceRestart:
    mocks.requestProfileCacheMaintenanceRestart,
}));

const audit = {
  ok: true,
  classificationSummary: {
    registeredTables: 48,
    unclassifiedTables: 0,
    byOwnerScope: { shop: { tables: 34, rows: 12, emptyShopId: 1 } },
    byLifecycle: { preserve: { tables: 12, rows: 2, emptyShopId: 1 } },
    byBackup: { required: { tables: 12, rows: 2, emptyShopId: 1 } },
  },
};

const preview = {
  ok: true,
  totalEmptyRows: 1,
  previewFingerprint: 'preview-fingerprint',
  tables: [{
    table: 'purchase_order_overrides',
    domain: 'purchase-overrides',
    emptyRows: 1,
    action: 'assign-after-confirmation',
  }],
};

const emptyRetentionPreview = {
  ok: true,
  previewFingerprint: 'retention-empty-fingerprint',
  maximumCandidateRows: 0,
  tables: [],
};

const emptyCompactionPreview = {
  ok: true,
  previewFingerprint: 'compaction-empty-fingerprint',
  recommended: false,
  sqlite: { reclaimableBytes: 0 },
};

const compactionPreview = {
  ok: true,
  previewFingerprint: 'compaction-fingerprint',
  recommended: true,
  sqlite: { reclaimableBytes: 2 * 1024 * 1024 },
};

const emptyManualResolutionPreview = {
  ok: true,
  previewFingerprint: 'manual-empty-fingerprint',
  totalCandidates: 0,
  shops: [],
  candidates: [],
};

const manualResolutionPreview = {
  ok: true,
  previewFingerprint: 'manual-fingerprint',
  totalCandidates: 1,
  shops: [
    { id: 'shop-a', name: '店铺 A', alias: '', status: 'active' },
    { id: 'shop-b', name: '店铺 B', alias: '', status: 'active' },
  ],
  candidates: [{
    id: 'candidate-1',
    table: 'purchase_source_links',
    domain: 'purchase-source-links',
    identity: [{ column: 'order_key', value: 'order-1' }],
  }],
};

const retentionPreview = {
  ok: true,
  previewFingerprint: 'retention-fingerprint',
  maximumCandidateRows: 2,
  tables: [{
    table: 'ozon_scheduler_trace_events',
    candidateRows: 2,
    eligibleByAge: 2,
    eligibleByRowLimit: 0,
  }],
};

const consistencyAudit = {
  ok: true,
  mode: 'read-only-data-consistency-audit',
  structuralOk: true,
  readyForMigration: true,
  integrity: { ok: true, messages: [] },
  foreignKeys: { ok: true, violations: 0, tables: [] },
  registry: { unclassifiedTables: [], schemaDriftTables: [] },
  keys: { checkedTables: 12, duplicateKeyGroups: 0 },
  scopes: { emptyShopRows: 0, requiresExplicitResolution: false },
};

afterEach(() => {
  vi.clearAllMocks();
});

describe('DataMaintenancePanel', () => {
  it('keeps ordinary cache clear as a dedicated desktop maintenance command', async () => {
    mocks.getLocalStorageAudit.mockResolvedValue(audit);
    mocks.getDatabaseCompactionPreview.mockResolvedValue(emptyCompactionPreview);
    mocks.getShopScopeRepairPreview.mockResolvedValue({ ...preview, totalEmptyRows: 0, tables: [] });
    mocks.getManualShopScopeResolutionPreview.mockResolvedValue(emptyManualResolutionPreview);
    mocks.getTechnicalRetentionPreview.mockResolvedValue(emptyRetentionPreview);
    mocks.requestProfileCacheMaintenanceRestart.mockResolvedValue({
      ok: true,
      scheduled: true,
    });

    render(<DataMaintenancePanel />);
    const button = await screen.findByRole('button', { name: '普通清缓存' });
    expect(screen.getByText(/不执行释放空间、领域重建或永久删除/u)).toBeInTheDocument();
    fireEvent.click(button);
    await waitFor(() => {
      expect(mocks.requestProfileCacheMaintenanceRestart).toHaveBeenCalledTimes(1);
    });
    expect(mocks.confirmProfileSpaceRelease).not.toHaveBeenCalled();
    expect(mocks.confirmProfileDomainRebuild).not.toHaveBeenCalled();
  });

  it('shows registry-driven preview and requires a second explicit confirmation before the local repair command', async () => {
    mocks.getLocalStorageAudit.mockResolvedValue(audit);
    mocks.getDatabaseCompactionPreview.mockResolvedValue(emptyCompactionPreview);
    mocks.getShopScopeRepairPreview.mockResolvedValue(preview);
    mocks.getManualShopScopeResolutionPreview.mockResolvedValue(emptyManualResolutionPreview);
    mocks.getTechnicalRetentionPreview.mockResolvedValue(emptyRetentionPreview);
    mocks.confirmShopScopeRepair.mockResolvedValue({
      ok: true,
      applied: [{ changed: 1 }],
      deferred: [],
    });

    render(<DataMaintenancePanel />);

    await screen.findByText('数据归属维护');
    expect(await screen.findByText('已登记 48 张表，未登记 0 张表。')).toBeInTheDocument();
    expect(screen.getByText('店铺账户')).toBeInTheDocument();
    expect(screen.getByText('必须保留')).toBeInTheDocument();
    expect(screen.getByText('必须备份')).toBeInTheDocument();
    expect(screen.getByText('purchase_order_overrides')).toBeInTheDocument();
    expect(screen.getByText(/不调用 Ozon/u)).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: '确认修复安全项' }));
    expect(await screen.findByRole('dialog')).toBeInTheDocument();
    expect(screen.getByText(/多店数据和可重建数据不会改动/u)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '确认并修复' }));

    await waitFor(() =>
      expect(mocks.confirmShopScopeRepair).toHaveBeenCalledWith(
        'preview-fingerprint',
        { timeoutMs: 30000 }
      )
    );
    expect(await screen.findByText(/已完成安全修复：\s*1\s*行；\s*仍有\s*0\s*项需来源续传或人工处理/u)).toBeInTheDocument();
  });

  it('requires the backup acknowledgement in the second dialog before submitting a confirmed technical-retention cleanup', async () => {
    mocks.getLocalStorageAudit.mockResolvedValue(audit);
    mocks.getDatabaseCompactionPreview.mockResolvedValue(emptyCompactionPreview);
    mocks.getShopScopeRepairPreview.mockResolvedValue({ ...preview, totalEmptyRows: 0, tables: [] });
    mocks.getManualShopScopeResolutionPreview.mockResolvedValue(emptyManualResolutionPreview);
    mocks.getTechnicalRetentionPreview
      .mockResolvedValueOnce(retentionPreview)
      .mockResolvedValue(emptyRetentionPreview);
    mocks.confirmTechnicalRetention.mockResolvedValue({
      ok: true,
      deleted: [{ table: 'ozon_scheduler_trace_events', rows: 2 }],
      preview: emptyRetentionPreview,
    });

    render(<DataMaintenancePanel />);

    expect(await screen.findByText('ozon_scheduler_trace_events')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '清理技术运行数据' }));

    expect(await screen.findByRole('dialog')).toBeInTheDocument();
    expect(screen.getByText(/不会自动压缩文件/u)).toBeInTheDocument();
    const confirmButton = screen.getByRole('button', { name: '确认清理' });
    expect(confirmButton).toBeDisabled();
    fireEvent.click(screen.getByRole('checkbox', { name: /我已创建可恢复保护副本/u }));
    expect(confirmButton).toBeEnabled();
    fireEvent.click(confirmButton);

    await waitFor(() =>
      expect(mocks.confirmTechnicalRetention).toHaveBeenCalledWith(
        'retention-fingerprint',
        { backupAcknowledged: true, timeoutMs: 30000 }
      )
    );
    expect(await screen.findByText(/已清理技术运行数据：\s*2\s*行/u)).toBeInTheDocument();
  });

  it('requires a user-selected shop for each chosen multi-shop record before the separate confirmed resolution command', async () => {
    mocks.getLocalStorageAudit.mockResolvedValue(audit);
    mocks.getDatabaseCompactionPreview.mockResolvedValue(emptyCompactionPreview);
    mocks.getShopScopeRepairPreview.mockResolvedValue({ ...preview, totalEmptyRows: 1, tables: [{
      table: 'purchase_source_links',
      domain: 'purchase-source-links',
      emptyRows: 1,
      action: 'isolate-for-manual-resolution',
    }] });
    mocks.getManualShopScopeResolutionPreview
      .mockResolvedValueOnce(manualResolutionPreview)
      .mockResolvedValue(emptyManualResolutionPreview);
    mocks.getTechnicalRetentionPreview.mockResolvedValue(emptyRetentionPreview);
    mocks.confirmManualShopScopeResolution.mockResolvedValue({
      ok: true,
      applied: [{ candidateId: 'candidate-1', table: 'purchase_source_links', targetShopId: 'shop-b' }],
      preview: emptyManualResolutionPreview,
    });

    render(<DataMaintenancePanel />);

    expect(await screen.findByText(/当前有\s*1\s*条待人工归属数据/u)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '处理多店手工数据' }));
    expect(await screen.findByRole('dialog')).toBeInTheDocument();
    expect(screen.getByText(/系统不会根据当前店铺/u)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /确认归属 0 条/u })).toBeDisabled();

    const shopSelect = screen.getByRole('combobox', { name: /order_key: order-1/u });
    fireEvent.mouseDown(shopSelect);
    fireEvent.click(await screen.findByRole('option', { name: /店铺 B（shop-b）/u }));
    fireEvent.click(screen.getByRole('button', { name: '确认归属 1 条' }));

    await waitFor(() =>
      expect(mocks.confirmManualShopScopeResolution).toHaveBeenCalledWith(
        'manual-fingerprint',
        [{ candidateId: 'candidate-1', targetShopId: 'shop-b' }],
        { timeoutMs: 30000 }
      )
    );
    expect(await screen.findByText(/已完成多店数据归属：\s*1\s*条/u)).toBeInTheDocument();
  });

  it('requires backup acknowledgement before requesting the separate SQLite physical compaction command', async () => {
    mocks.getLocalStorageAudit.mockResolvedValue(audit);
    mocks.getDatabaseCompactionPreview
      .mockResolvedValueOnce(compactionPreview)
      .mockResolvedValue(emptyCompactionPreview);
    mocks.getShopScopeRepairPreview.mockResolvedValue({ ...preview, totalEmptyRows: 0, tables: [] });
    mocks.getManualShopScopeResolutionPreview.mockResolvedValue(emptyManualResolutionPreview);
    mocks.getTechnicalRetentionPreview.mockResolvedValue(emptyRetentionPreview);
    mocks.confirmDatabaseCompaction.mockResolvedValue({
      ok: true,
      mode: 'confirmed-vacuum',
      reclaimedDatabaseBytes: 2 * 1024 * 1024,
      before: { logicalBytes: 4 * 1024 * 1024 },
      after: { logicalBytes: 2 * 1024 * 1024 },
    });

    render(<DataMaintenancePanel />);

    expect(await screen.findByText(/当前预计可回收约 2\.00 MiB/u)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '压缩本机数据库' }));
    expect(await screen.findByRole('dialog')).toBeInTheDocument();
    const confirmButton = screen.getByRole('button', { name: '确认压缩' });
    expect(confirmButton).toBeDisabled();
    fireEvent.click(screen.getByRole('checkbox', { name: /确认压缩本机 SQLite 文件/u }));
    fireEvent.click(confirmButton);

    await waitFor(() =>
      expect(mocks.confirmDatabaseCompaction).toHaveBeenCalledWith(
        'compaction-fingerprint',
        { backupAcknowledged: true, timeoutMs: 120000 }
      )
    );
    expect(await screen.findByText(/已完成 SQLite 物理压缩：回收 2\.00 MiB/u)).toBeInTheDocument();
  });

  it('runs the explicit read-only integrity preflight without turning it into a repair command', async () => {
    mocks.getLocalStorageAudit.mockResolvedValue(audit);
    mocks.getDatabaseCompactionPreview.mockResolvedValue(emptyCompactionPreview);
    mocks.getShopScopeRepairPreview.mockResolvedValue(preview);
    mocks.getManualShopScopeResolutionPreview.mockResolvedValue(emptyManualResolutionPreview);
    mocks.getTechnicalRetentionPreview.mockResolvedValue(emptyRetentionPreview);
    mocks.getLocalDataConsistencyAudit.mockResolvedValue(consistencyAudit);

    render(<DataMaintenancePanel />);

    expect(await screen.findByText(/尚未运行完整性预检/u)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '运行完整性核验' }));

    await waitFor(() => expect(mocks.getLocalDataConsistencyAudit).toHaveBeenCalledWith(
      expect.objectContaining({ timeoutMs: 30000, signal: expect.any(AbortSignal) })
    ));
    expect(await screen.findByText(/结构、业务键和店铺作用域预检通过/u)).toBeInTheDocument();
    expect(screen.getByText(/空店铺：0 行/u)).toBeInTheDocument();
    expect(mocks.confirmShopScopeRepair).not.toHaveBeenCalled();
  });

  it('requires a second explicit human acknowledgement before releasing registry-approved derived cache', async () => {
    mocks.getLocalStorageAudit.mockResolvedValue(audit);
    mocks.getDatabaseCompactionPreview.mockResolvedValue(emptyCompactionPreview);
    mocks.getShopScopeRepairPreview.mockResolvedValue({ ...preview, totalEmptyRows: 0, tables: [] });
    mocks.getManualShopScopeResolutionPreview.mockResolvedValue(emptyManualResolutionPreview);
    mocks.getTechnicalRetentionPreview.mockResolvedValue(emptyRetentionPreview);
    mocks.previewProfileSpaceRelease
      .mockResolvedValueOnce({
        ok: true,
        humanConfirmationToken: 'space-preview-token',
        targetRows: 3,
        targetResources: [{
          domain: 'response-cache',
          resourceId: 'registry:response-cache',
          table: 'ozon_response_cache',
          rows: 3,
        }],
      })
      .mockResolvedValue({
        ok: true,
        humanConfirmationToken: 'space-empty-after-token',
        targetRows: 0,
        targetResources: [],
      });
    mocks.confirmProfileSpaceRelease.mockResolvedValue({
      ok: true,
      completed: true,
      releasedRows: 3,
    });

    render(<DataMaintenancePanel />);

    expect(await screen.findByText('registry:response-cache / ozon_response_cache')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '释放派生缓存' }));
    expect(await screen.findByRole('dialog')).toBeInTheDocument();
    const confirmButton = screen.getByRole('button', { name: '确认释放派生缓存' });
    expect(confirmButton).toBeDisabled();
    fireEvent.click(screen.getByRole('checkbox', { name: /我已核对本次预览/u }));
    fireEvent.click(confirmButton);

    await waitFor(() => expect(mocks.confirmProfileSpaceRelease).toHaveBeenCalledWith(
      { humanConfirmationToken: 'space-preview-token', humanConfirmed: true },
      { timeoutMs: 120000 },
    ));
    expect(await screen.findByText(/已释放 3 行派生缓存/u)).toBeInTheDocument();
  });

  it('prepares an internal one-time source ticket and requires explicit confirmation before rebuilding one domain', async () => {
    mocks.getLocalStorageAudit.mockResolvedValue(audit);
    mocks.getDatabaseCompactionPreview.mockResolvedValue(emptyCompactionPreview);
    mocks.getShopScopeRepairPreview.mockResolvedValue({ ...preview, totalEmptyRows: 0, tables: [] });
    mocks.getManualShopScopeResolutionPreview.mockResolvedValue(emptyManualResolutionPreview);
    mocks.getTechnicalRetentionPreview.mockResolvedValue(emptyRetentionPreview);
    mocks.previewProfileDomainRebuild.mockResolvedValue({
      ok: true,
      domain: 'product-image-health',
      humanConfirmationToken: 'rebuild-preview-token',
    });
    mocks.prepareProfileDomainRebuildTicket.mockResolvedValue({
      ok: true,
      domain: 'product-image-health',
      trustedSourceTicket: 'opaque-one-time-ticket',
      source: 'ozon',
      proofId: 'sync-proof-1',
      rowCount: 2,
      rowsSha256: 'a'.repeat(64),
    });
    mocks.confirmProfileDomainRebuild.mockResolvedValue({
      ok: true,
      domain: 'product-image-health',
      completed: true,
    });

    render(<DataMaintenancePanel />);

    const action = await screen.findByRole('button', { name: '检查并重建领域' });
    await waitFor(() => expect(action).toBeEnabled());
    fireEvent.click(action);
    expect(await screen.findByRole('dialog', { name: '确认从可信来源重建领域' })).toBeInTheDocument();
    expect(mocks.previewProfileDomainRebuild).toHaveBeenCalledWith(
      'product-image-health',
      expect.objectContaining({ timeoutMs: 30000, signal: expect.any(AbortSignal) }),
    );
    expect(mocks.prepareProfileDomainRebuildTicket).toHaveBeenCalledWith(
      { domain: 'product-image-health', humanConfirmationToken: 'rebuild-preview-token' },
      expect.objectContaining({ timeoutMs: 30000, signal: expect.any(AbortSignal) }),
    );
    expect(screen.getByText(/候选行数：2/u)).toBeInTheDocument();
    const confirmButton = screen.getByRole('button', { name: '确认重建领域' });
    expect(confirmButton).toBeDisabled();
    fireEvent.click(screen.getByRole('checkbox', { name: /我已核对领域、来源证明和候选行数/u }));
    fireEvent.click(confirmButton);

    await waitFor(() => expect(mocks.confirmProfileDomainRebuild).toHaveBeenCalledWith(
      {
        domain: 'product-image-health',
        humanConfirmationToken: 'rebuild-preview-token',
        humanConfirmed: true,
        trustedSourceTicket: 'opaque-one-time-ticket',
      },
      { timeoutMs: 120000 },
    ));
    expect(await screen.findByText(/已从可信来源重建 product-image-health/u)).toBeInTheDocument();
  });
});

