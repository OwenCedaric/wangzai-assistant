import { describe, expect, it } from 'vitest';
import {
  normalizeLogisticsPricingSettings,
  resolveLogisticsPricingSelection,
  setLogisticsPricingScopeSelection,
} from './logisticsPricingSettingsStore.js';

describe('logistics pricing scope settings', () => {
  it('resolves account before shop and shop before global', () => {
    const settings = normalizeLogisticsPricingSettings({
      globalSelection: { providerId: 'guoo', market: 'RU' },
      shopSelections: { 'shop-1': { providerId: 'cel', market: 'KZ' } },
      accountSelections: { 'client-1': { providerId: 'zto', market: 'RU' } },
    });

    expect(resolveLogisticsPricingSelection(settings, { accountId: 'client-1', shopId: 'shop-1' }))
      .toMatchObject({ providerId: 'zto', scopeType: 'account', scopeId: 'client-1' });
    expect(resolveLogisticsPricingSelection(settings, { shopId: 'shop-1' }))
      .toMatchObject({ providerId: 'cel', market: 'KZ', scopeType: 'shop', scopeId: 'shop-1' });
    expect(resolveLogisticsPricingSelection(settings, { shopId: 'shop-2' }))
      .toMatchObject({ providerId: 'guoo', scopeType: 'global' });
  });

  it('writes separate shop and account selections without changing the global default', () => {
    const base = normalizeLogisticsPricingSettings({ globalSelection: { providerId: 'guoo' } });
    const withShop = setLogisticsPricingScopeSelection(
      base,
      { type: 'shop', id: 'shop-1' },
      { providerId: 'ural', serviceLevel: 'economy' }
    );
    const withAccount = setLogisticsPricingScopeSelection(
      withShop,
      { type: 'account', id: 'client-1' },
      { providerId: 'xingyuan', market: 'KG' }
    );

    expect(withAccount.globalSelection.providerId).toBe('guoo');
    expect(withAccount.shopSelections['shop-1']).toMatchObject({ providerId: 'ural', serviceLevel: 'economy' });
    expect(withAccount.accountSelections['client-1']).toMatchObject({ providerId: 'xingyuan', market: 'KG' });
  });
});
