import { afterEach, expect, it, vi } from 'vitest';
import { createPrivateProfitInput } from './privateProfitInputSnapshot.js';
import { withReadonlyProductMaterialProfiles, readProductMaterialProfiles } from './productMaterialProfileStore.js';
import { withReadonlyLogisticsPricingSettings, readSavedLogisticsPricingSettings } from './logisticsPricingSettingsRuntime.js';
import { withReadonlyFeePlanState } from './feeSettingsRuntime.js';
import { normalizeOzonProfitOrder } from '../entities/profit/profitDisplayRules.jsx';
import { executeProfitBatch } from '../../../desktop/server-core/profitExecution.mjs';
import { createProfitCoreBatch, readProfitCoreResults } from './profitCoreWire.js';
import { buildFinanceParentFallbackIndex } from './profitFinanceMatching.js';

afterEach(() => vi.useRealTimers());
const instant = '2026-09-07T00:00:00.000Z';
const order = { id: '123-456-1', postingNumber: '123-456-1', shopId: 'shop-one', shopClientId: 'account-one',
  status: 'delivered', amountValue: 200, currencyCode: 'RUB', purchasePriceValue: 10,
  products: [{ offerId: 'sku-one', qty: 1, priceValue: 200, weight: '50', length: '10', width: '10', height: '10' }] };
const material = { 'shop-one:sku-one': { shopId: 'shop-one', weight: '300', length: '20', width: '20', height: '20', source: 'supplier-confirmed', applyToProduct: true },
  'shop-other:sku-other': { shopId: 'shop-other', apiKey: 'must-not-travel' } };
const logistics = { globalSelection: { providerId: 'guoo' },
  shopSelections: { 'shop-one': { providerId: 'cel' }, 'shop-other': { providerId: 'ural' } },
  accountSelections: { 'account-one': { providerId: 'zto' }, 'account-other': { providerId: 'cel' } } };

function inScope(work) {
  return withReadonlyFeePlanState({ activeId: 'fixture', plans: [{ id: 'fixture', settings: { platform: 'crossBorderBus', labelFeeUnit: '3' } }] },
    () => withReadonlyProductMaterialProfiles(material, () => withReadonlyLogisticsPricingSettings(logistics, work)));
}

it('projects only the current order lookups, overrides, materials and logistics settings without shop credentials', () => {
  const context = { shop: { id: 'shop-one', clientId: 'private-client', apiKey: 'private-api' },
    purchaseLocalOverrides: { 'account-one:123-456-1': { shopId: 'shop-one', purchasePriceValue: 17 },
      'other:999': { shopId: 'shop-other', apiKey: 'must-not-travel' } },
    financeIndex: new Map([['123-456-1', [{ operation_id: 1, amount: 100 }]], ['unrelated', [{ apiKey: 'must-not-travel' }]]]),
    financeParentFallbackIndex: buildFinanceParentFallbackIndex([order]), fetchedAt: instant,
  };
  const input = inScope(() => createPrivateProfitInput(order, context));
  expect(input.context.shop).toEqual({ id: 'shop-one' });
  expect([...input.context.financeIndex.keys()]).toEqual(['123-456-1']);
  expect(Object.keys(input.context.purchaseLocalOverrides)).toEqual(['account-one:123-456-1']);
  expect(Object.keys(input.materialProfiles)).toEqual(['shop-one:sku-one']);
  expect(Object.keys(input.logisticsPricingSettings.accountSelections)).toEqual(['account-one']);
  expect(Object.keys(input.logisticsPricingSettings.shopSelections)).toEqual(['shop-one']);
  expect(JSON.stringify(input)).not.toMatch(/private-api|private-client|must-not-travel|shop-other/);
  context.financeIndex.get('123-456-1')[0].amount = 999;
  expect(input.context.financeIndex.get('123-456-1')[0].amount).toBe(100);
});

it('remote normalization retains local material/logistics/override results, including ambiguous parent fallback', () => {
  vi.useFakeTimers(); vi.setSystemTime(new Date(instant));
  for (let i = 0; i < 8; i++) {
    const current = { ...order, status: i % 2 ? 'cancelled' : 'delivered', purchasePriceValue: i % 3 ? 10 : null };
    const context = { shop: { id: 'shop-one', clientId: 'account-one', apiKey: 'never-sent' }, fetchedAt: instant,
      rubToCnyRate: 0.1, purchaseLocalOverrides: {
        'account-one:123-456-1': { ...(i % 2 ? { shopId: 'shop-one' } : {}), purchasePriceValue: 17 },
        'wrong:123-456-1': { shopId: 'shop-other', purchasePriceValue: 999 },
      }, financeIndex: new Map([['123-456', [{ operation_id: 1, amount: 150 }]]]),
      financeLookupCheckedIndex: new Map([['123-456-1', i % 2 === 0]]),
      financeParentFallbackIndex: buildFinanceParentFallbackIndex(i % 2 ? [current, { ...current, id: '123-456-2', postingNumber: '123-456-2' }] : [current]),
    };
    const { expected, input } = inScope(() => ({ expected: normalizeOzonProfitOrder(current, context), input: createPrivateProfitInput(current, context) }));
    const calls = [{ id: `case-${i}`, operation: 'normalize', input }];
    const [actual] = readProfitCoreResults(executeProfitBatch(createProfitCoreBatch(calls)), calls);
    expect(actual).toEqual(expected);
  }
});

it('rejects wrong owners and secret-bearing order facts instead of stripping or sending them', () => {
  expect(() => createPrivateProfitInput(order, { shop: { id: 'shop-other' } })).toThrow('PROFIT_INPUT_OWNER_MISMATCH');
  expect(() => createPrivateProfitInput({ ...order, apiKey: 'never-send' })).toThrow('PROFIT_CORE_SECRET_REJECTED');
  expect(() => createPrivateProfitInput({ ...order, shopId: '' })).toThrow('PROFIT_INPUT_OWNER_REQUIRED');
});

it('readonly worker state restores after exceptions and refuses async work before starting it', () => {
  const materials = readProductMaterialProfiles(), pricing = readSavedLogisticsPricingSettings();
  for (const scope of [withReadonlyProductMaterialProfiles, withReadonlyLogisticsPricingSettings]) {
    expect(() => scope({}, () => { throw new Error('fixture'); })).toThrow('fixture');
    const callback = vi.fn(async () => true);
    expect(() => scope({}, callback)).toThrow(); expect(callback).not.toHaveBeenCalled();
  }
  expect(readProductMaterialProfiles()).toEqual(materials);
  expect(readSavedLogisticsPricingSettings()).toEqual(pricing);
});
