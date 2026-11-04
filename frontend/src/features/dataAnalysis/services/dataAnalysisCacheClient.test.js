import { describe, expect, it, vi } from 'vitest';

const localApiMocks = vi.hoisted(() => ({
  saveDataAnalysisSnapshot: vi.fn(),
}));

vi.mock('../../../api/localApiClient.js', () => ({
  getDomainCache: vi.fn(),
  getSyncJob: vi.fn(),
  listIntegrationProfiles: vi.fn(),
  saveDataAnalysisSnapshot: localApiMocks.saveDataAnalysisSnapshot,
  saveDataAnalysisSyncState: vi.fn(),
  deleteDataAnalysisSnapshot: vi.fn(),
  startDomainSync: vi.fn(),
}));

import {
  resolveDataAnalysisMarketProfileScope,
  saveDataAnalysisCacheSnapshot,
} from './dataAnalysisCacheClient.js';

const profiles = [
  {
    id: 'profile-a',
    integrationType: 'ozon-browser-session',
    shopId: 'shop-a',
    configStatus: '连接成功',
    tokenStatus: 'Cookie 已保存',
  },
  {
    id: 'profile-b',
    integrationType: 'ozon-browser-session',
    shopId: 'shop-b',
    configStatus: '连接成功',
    tokenStatus: 'Cookie 已保存',
  },
];

describe('dataAnalysis market profile scope', () => {
  it('resolves an exact profile to its bound shop', async () => {
    const profileLoader = vi.fn().mockResolvedValue({ profiles });
    await expect(resolveDataAnalysisMarketProfileScope(
      { profileId: 'profile-b' },
      { profileLoader },
    )).resolves.toEqual({ profileId: 'profile-b', shopId: 'shop-b' });
  });

  it('fails closed when a caller mixes a profile with another shop', async () => {
    const profileLoader = vi.fn().mockResolvedValue({ profiles });
    await expect(resolveDataAnalysisMarketProfileScope(
      { profileId: 'profile-a', shopId: 'shop-b' },
      { profileLoader },
    )).rejects.toThrow('DATA_ANALYSIS_MARKET_SHOP_SCOPE_MISMATCH');
  });

  it('does not select an unbound or disconnected profile as the default lane', async () => {
    const profileLoader = vi.fn().mockResolvedValue({ profiles: [
      { ...profiles[0], shopId: '', configStatus: '待登录', tokenStatus: 'Cookie 未保存' },
    ] });
    await expect(resolveDataAnalysisMarketProfileScope({}, { profileLoader }))
      .rejects.toThrow('DATA_ANALYSIS_MARKET_PROFILE_NOT_FOUND');
  });
});

describe('dataAnalysis snapshot persistence timeout', () => {
  it('allows a large market snapshot up to 30 seconds by default', async () => {
    localApiMocks.saveDataAnalysisSnapshot.mockResolvedValueOnce({ ok: true });
    const snapshot = { shopId: 'shop-a', sourceKey: 'ozon-market', rows: [{ id: 1 }] };

    await saveDataAnalysisCacheSnapshot(snapshot);

    expect(localApiMocks.saveDataAnalysisSnapshot).toHaveBeenCalledWith(snapshot, {
      timeoutMs: 30_000,
      signal: undefined,
      observe: undefined,
    });
  });

  it('keeps an explicit caller timeout override', async () => {
    localApiMocks.saveDataAnalysisSnapshot.mockResolvedValueOnce({ ok: true });

    await saveDataAnalysisCacheSnapshot({ shopId: 'shop-a' }, { timeoutMs: 45_000 });

    expect(localApiMocks.saveDataAnalysisSnapshot).toHaveBeenLastCalledWith(
      { shopId: 'shop-a' },
      { timeoutMs: 45_000, signal: undefined, observe: undefined },
    );
  });
});
