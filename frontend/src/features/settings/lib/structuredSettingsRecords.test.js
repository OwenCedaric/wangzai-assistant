import { describe, expect, it } from 'vitest';

import {
  buildPurchaseStructuredRecords,
  buildStructuredProfileItems,
  createBlankStructuredRecord,
  getStructuredRecordCountLabel,
  normalizeStructuredRecord,
  toPurchaseAccountSavePayload,
} from './structuredSettingsRecords.js';

const purchaseConfig = {
  id: 'purchaseAccount',
  mainTitle: '拍单账号',
  fields: [
    { id: 'accountAlias', label: '账号简称' },
    { id: 'platformName', label: '平台' },
    { id: 'loginPassword', label: '密码' },
    { id: 'recipientNickname', label: '收件人' },
  ],
};

describe('structured settings record helpers', () => {
  it('keeps account values and password flags without exposing stored plaintext', () => {
    const records = buildPurchaseStructuredRecords(purchaseConfig, [
      {
        id: 'purchase-1',
        name: '1688账号',
        platformName: '1688',
        loginAccount: 'buyer-1',
        hasLoginPassword: true,
        loginPasswordHint: '••••1234',
        recipientNickname: '仓库A',
        cookieStatus: 'Cookie 已保存',
        isDefault: true,
      },
    ]);
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({ id: 'purchase-1', status: '登录已保存', statusColor: 'success' });
    expect(records[0].values).toMatchObject({
      loginAccount: 'buyer-1',
      loginPassword: '',
      hasLoginPassword: true,
      loginPasswordHint: '••••1234',
      recipientNickname: '仓库A',
      isDefault: true,
    });
    expect(buildStructuredProfileItems(purchaseConfig, records[0])).toEqual(
      expect.arrayContaining([
        { label: '密码', value: '••••1234' },
        { label: '收件人', value: '仓库A' },
      ]),
    );
  });

  it('keeps blank drafts local and only sends a newly typed password', () => {
    const blank = createBlankStructuredRecord(purchaseConfig, 3);
    expect(blank).toMatchObject({ title: '拍单账号 3', status: '待配置' });
    expect(blank.values).toMatchObject({ accountAlias: '', platformName: '', loginPassword: '' });

    const normalized = normalizeStructuredRecord(purchaseConfig, {
      id: 'purchase-2',
      values: { accountAlias: '测试账号', platformName: '1688', loginPassword: '' },
    });
    expect(toPurchaseAccountSavePayload(normalized, { keepId: true })).not.toHaveProperty('loginPassword');
    normalized.values.loginPassword = 'new-secret';
    expect(toPurchaseAccountSavePayload(normalized, { keepId: true })).toMatchObject({
      id: 'purchase-2',
      loginPassword: 'new-secret',
    });
    expect(getStructuredRecordCountLabel(purchaseConfig, 3)).toBe('共 3 个账号');
  });
});
