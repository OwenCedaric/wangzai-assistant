import { describe, expect, it } from 'vitest';

import {
  getIntegrationConnectionState,
  reconcilePlatformApiSourceRecords,
  toIntegrationProfileSavePayload,
  toIntegrationStructuredRecord,
} from './integrationProfileRecords.js';

const config = {
  id: 'platformApi',
  mainTitle: '外部接口',
  fields: [
    { id: 'integrationType', label: '接口类型' },
    { id: 'platformName', label: '平台名称' },
    { id: 'shopId', label: '店铺' },
    { id: 'apiKey', label: 'API Key' },
  ],
};

describe('integration profile record helpers', () => {
  it('does not resend an encrypted stored credential when the edit field is blank', () => {
    const record = {
      id: 'seerfar-1',
      title: 'Seerfar',
      values: {
        integrationType: 'seerfar-open-api',
        platformName: 'Seerfar',
        baseUrl: 'https://api.example.test',
        apiKey: '',
        hasApiKey: true,
      },
    };
    expect(toIntegrationProfileSavePayload(record)).toEqual({
      id: 'seerfar-1',
      integrationType: 'seerfar-open-api',
      platformName: 'Seerfar',
      shopId: '',
      apiType: '',
      authMode: '',
      configStatus: '',
      tokenStatus: '',
      readScope: '',
      writeScope: '',
      note: '',
      credentials: {
        baseUrl: 'https://api.example.test',
        loginAccount: '',
      },
    });
  });

  it('maps saved connection results to stable Chinese display states', () => {
    expect(getIntegrationConnectionState({ lastTestStatus: 'connected', hasApiKey: true })).toMatchObject({
      status: '连接成功',
      configStatus: '连接成功',
      tokenStatus: '有效',
    });
    expect(getIntegrationConnectionState({ lastTestStatus: 'limited', hasApiKey: true })).toMatchObject({
      status: '额度不足',
      configStatus: '凭证有效',
    });
    expect(
      getIntegrationConnectionState({
        integrationType: 'ozon-browser-session',
        configStatus: '连接成功',
        tokenStatus: 'Cookie 已保存',
        identityStatus: 'verified',
      }),
    ).toMatchObject({ status: '已连接', statusColor: 'success' });
  });

  it('keeps exact shop scope and masks stored secrets when converting a saved profile', () => {
    const record = toIntegrationStructuredRecord(config, {
      id: 'browser-2',
      integrationType: 'ozon-browser-session',
      platformName: 'Ozon 2店网页登录',
      shopId: 'shop-2',
      configStatus: '连接成功',
      tokenStatus: 'Cookie 已保存',
      identityStatus: 'verified',
      hasLoginPassword: true,
      loginPasswordHint: '••••1234',
    });
    expect(record).toMatchObject({ id: 'browser-2', title: 'Ozon 2店网页登录', status: '已连接' });
    expect(record.values).toMatchObject({
      shopId: 'shop-2',
      loginPassword: '',
      hasLoginPassword: true,
      loginPasswordHint: '••••1234',
    });
  });

  it('removes deleted persisted rows while preserving only unsaved local drafts', () => {
    const result = reconcilePlatformApiSourceRecords(
      config,
      [
        { id: 'deleted-1', values: { integrationType: 'seerfar-open-api' } },
        { id: 'draft-1', isTransientDraft: true, values: { integrationType: '' } },
      ],
      {
        profiles: [],
        performanceAccounts: [],
        previousProfileIds: new Set(['deleted-1']),
      },
    );
    expect(result.map((record) => record.id)).toEqual(['draft-1']);
  });
});
