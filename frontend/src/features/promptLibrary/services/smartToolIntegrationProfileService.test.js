import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  listIntegrationProfiles: vi.fn(),
  listPerformanceAccounts: vi.fn(),
  getCrossBorderAccounts: vi.fn(),
  listPurchaseAccounts: vi.fn(),
}));

vi.mock('../../../api/localApiClient.js', () => ({
  listIntegrationProfiles: mocks.listIntegrationProfiles,
  listPerformanceAccounts: mocks.listPerformanceAccounts,
  getCrossBorderAccounts: mocks.getCrossBorderAccounts,
  listPurchaseAccounts: mocks.listPurchaseAccounts,
}));

import {
  getReadyPerformanceAccountCount,
  getEnabledIntegrationAccountCount,
  getReadySmartToolIntegrationTypes,
  loadSmartToolIntegrationState,
} from './smartToolIntegrationProfileService.js';

describe('smartToolIntegrationProfileService', () => {
  beforeEach(() => {
    mocks.listIntegrationProfiles.mockReset();
    mocks.listPerformanceAccounts.mockReset().mockResolvedValue({ accounts: [] });
    mocks.getCrossBorderAccounts.mockReset().mockResolvedValue({ rows: [] });
    mocks.listPurchaseAccounts.mockReset().mockResolvedValue({ accounts: [] });
  });

  it('只统计仍启用的物流和采购账号', () => {
    expect(
      getEnabledIntegrationAccountCount([
        { id: 'ready' },
        { id: 'disabled-1', enabled: false },
        { id: 'disabled-2', status: 'disabled' },
      ])
    ).toBe(1);
  });

  it('只把 client_id 和 client_secret 都存在的 Performance 账号标记为可用', () => {
    expect(
      getReadyPerformanceAccountCount([
        { hasClientId: true, hasClientSecret: true },
        { clientId: 'client-only', hasClientSecret: false },
        { clientId: 'client-with-hint', clientSecretHint: '已保存' },
      ])
    ).toBe(2);
  });

  it('只把已保存凭证的外部数据接口标记为可用', () => {
    expect(
      getReadySmartToolIntegrationTypes([
        { integrationType: 'seerfar-open-api', hasApiKey: true },
        { integrationType: 'retired-provider', hasApiKey: true },
        { integrationType: 'linkfox-agent', lastTestStatus: 'limited' },
        { integrationType: 'custom', hasApiKey: true },
      ])
    ).toEqual(['seerfar-open-api', 'linkfox-agent']);
  });

  it('从 local-api 读取配置状态，不读取明文密钥', async () => {
    mocks.listIntegrationProfiles.mockResolvedValue({
      profiles: [{ integrationType: 'seerfar-open-api', hasApiKey: true }],
    });
    mocks.listPerformanceAccounts.mockResolvedValue({
      accounts: [{ hasClientId: true, hasClientSecret: true }],
    });
    mocks.getCrossBorderAccounts.mockResolvedValue({ rows: [{ id: 'bus-1' }] });
    mocks.listPurchaseAccounts.mockResolvedValue({ accounts: [{ id: 'purchase-1' }] });

    await expect(loadSmartToolIntegrationState()).resolves.toEqual({
      integrationTypes: ['seerfar-open-api'],
      hasThirdPartyToolAccount: true,
      hasPerformanceAccount: true,
      performanceAccountCount: 1,
      hasCrossBorderAccount: true,
      crossBorderAccountCount: 1,
      hasPurchaseAccount: true,
      purchaseAccountCount: 1,
    });
    expect(mocks.listIntegrationProfiles).toHaveBeenCalledWith({ timeoutMs: 10000 });
    expect(mocks.listPerformanceAccounts).toHaveBeenCalledWith({ timeoutMs: 10000 });
    expect(mocks.getCrossBorderAccounts).toHaveBeenCalledWith({ timeoutMs: 10000 });
    expect(mocks.listPurchaseAccounts).toHaveBeenCalledWith({ timeoutMs: 10000 });
  });
});
