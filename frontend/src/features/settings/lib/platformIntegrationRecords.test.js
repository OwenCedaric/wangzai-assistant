import { describe, expect, it } from 'vitest';

import {
  buildPlatformApiProfileItems,
  createBlankPlatformApiRecord,
  getPlatformApiErrorMessage,
  getPlatformIntegrationPreset,
  mergePerformanceAccountsIntoStructuredRecords,
} from './platformIntegrationRecords.js';

const platformApiConfig = {
  id: 'platformApi',
  mainTitle: '外部接口',
  fields: [
    {
      id: 'integrationType',
      label: '接口类型',
      options: [
        { value: 'ozon-performance', label: 'Ozon Performance API' },
        { value: 'ozon-browser-session', label: 'Ozon 网页登录' },
      ],
    },
    { id: 'platformName', label: '平台名称' },
    { id: 'performanceClientId', label: 'Client ID' },
    { id: 'performanceClientSecret', label: 'Client Secret' },
    { id: 'shopId', label: '绑定店铺' },
  ],
};

describe('platform integration record helpers', () => {
  it('creates an empty local draft without inventing credentials', () => {
    const draft = createBlankPlatformApiRecord(platformApiConfig, 2);
    expect(draft).toMatchObject({
      title: '外部接口 2',
      status: '待配置',
      isTransientDraft: true,
    });
    expect(draft.values).toMatchObject({
      integrationType: '',
      performanceClientId: '',
      performanceClientSecret: '',
      apiKey: '',
    });
  });

  it('hydrates the selected shop and encrypted credential flags without exposing the secret', () => {
    const records = mergePerformanceAccountsIntoStructuredRecords(platformApiConfig, [], [
      {
        id: 'performance-1',
        title: 'Ozon 2店推广',
        shopId: 'shop-2',
        clientId: '4067587',
        hasClientId: true,
        hasClientSecret: true,
        clientSecretHint: '••••••••••',
        status: 'active',
        campaignCount: 12,
      },
    ]);

    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({
      id: 'performance-1',
      status: '连接成功',
      statusColor: 'success',
    });
    expect(records[0].values).toMatchObject({
      integrationType: 'ozon-performance',
      shopId: 'shop-2',
      performanceClientId: '4067587',
      performanceClientSecret: '',
      hasPerformanceClientSecret: true,
      campaignCount: 12,
    });
    expect(buildPlatformApiProfileItems(records[0])).toEqual(
      expect.arrayContaining([
        { label: '绑定店铺', value: 'shop-2' },
        { label: 'Client ID', value: '4067587' },
        { label: 'Client Secret', value: '••••••••••' },
        { label: '连接状态', value: '连接成功' },
      ]),
    );
  });

  it('keeps official preset copy and translates known browser binding errors', () => {
    expect(getPlatformIntegrationPreset('ozon-performance').values.authMode).toBe(
      'client_id + client_secret',
    );
    expect(getPlatformApiErrorMessage({ payload: { message: 'OZON_BROWSER_SHOP_REQUIRED' } })).toBe(
      '请先选择这个网页登录所属的 Ozon 店铺。',
    );
  });
});
