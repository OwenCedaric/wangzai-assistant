import { describe, expect, it, vi } from 'vitest';
import {
  loadPurchaseAutoPaySettings,
  normalizePurchaseAutoPaySettings,
  savePurchaseAutoPaySettings,
} from './purchaseAutoPaySettingsService.js';

describe('purchase auto-pay settings service', () => {
  it('normalizes the complete payment configuration without retaining unknown fields', () => {
    expect(normalizePurchaseAutoPaySettings({
      enabled: true,
      allowPinduoduo: true,
      allowTaobao: true,
      allowTmall: false,
      intervalMinutes: 0,
      maxPayPrice: 999,
      paymentMode1688: 'protocol',
      allowedPinduoduoAccountIds: ['pdd-a', 'pdd-a', ''],
      allowedTaobaoAccountIds: ['tb-a'],
      allowed1688AccountIds: ['1688-a'],
      unknownSecret: 'drop-me',
    })).toMatchObject({
      enabled: true,
      allowPinduoduo: true,
      allowTaobao: true,
      allowTmall: true,
      intervalMinutes: 1,
      maxPayPrice: 999,
      paymentMode1688: 'password',
      allowedPinduoduoAccountIds: ['pdd-a'],
      allowedTaobaoAccountIds: ['tb-a'],
      allowed1688AccountIds: ['1688-a'],
    });
    expect(normalizePurchaseAutoPaySettings({ unknownSecret: 'drop-me' })).not.toHaveProperty('unknownSecret');
  });

  it('merges legacy Taobao and Tmall switches and permanently migrates 1688 to password payment', () => {
    expect(normalizePurchaseAutoPaySettings({ allowTaobao: false, allowTmall: true })).toMatchObject({
      allowTaobao: true,
      allowTmall: true,
      paymentMode1688: 'password',
    });
    expect(normalizePurchaseAutoPaySettings({ allowTaobao: true, allowTmall: false, paymentMode1688: 'protocol' })).toMatchObject({
      allowTaobao: true,
      allowTmall: true,
      paymentMode1688: 'password',
    });
  });

  it('migrates the old global whitelist into each platform list once', () => {
    const migrated = normalizePurchaseAutoPaySettings({ allowedAccountIds: ['legacy-a', 'legacy-a'] });
    expect(migrated.allowedPinduoduoAccountIds).toEqual(['legacy-a']);
    expect(migrated.allowedTaobaoAccountIds).toEqual(['legacy-a']);
    expect(migrated.allowed1688AccountIds).toEqual(['legacy-a']);
  });

  it('loads and saves through the profile setting service', async () => {
    const read = vi.fn(async () => ({ setting: { value: { enabled: true, allow1688: true } } }));
    const loaded = await loadPurchaseAutoPaySettings({ read });
    expect(loaded).toMatchObject({ enabled: true, allow1688: true });

    const save = vi.fn(async () => ({}));
    const saved = await savePurchaseAutoPaySettings({ enabled: true, intervalMinutes: 5 }, { save });
    expect(saved).toMatchObject({ enabled: true, intervalMinutes: 5 });
    expect(save).toHaveBeenCalledTimes(1);
  });
});
