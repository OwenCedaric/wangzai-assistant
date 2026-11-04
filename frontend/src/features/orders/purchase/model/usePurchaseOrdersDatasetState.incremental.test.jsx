import { act, renderHook, waitFor } from '@testing-library/react';
import { expect, it, vi } from 'vitest';
const state = vi.hoisted(() => ({ snapshot: null, products: new Map(), rates: { todayKey: '', realtime: null, dailyRates: new Map(), errors: [] }, overrides: {} }));
vi.mock('../../../../entities/marketing/marketingSnapshotRuntime.jsx', () => ({ useOzonRealtimeSnapshot: () => state.snapshot }));
vi.mock('../services/purchaseProfitLedgerService.js', () => ({ readPurchaseProfitLedgerSnapshot: async () => ({ rowsByKey: {} }) }));
vi.mock('../../../../services/salesOrderProductSummaryService', () => ({ readSalesOrderProductSummaryEntities: async () => ({ entityMap: state.products }) }));
vi.mock('../../../../services/exchangeRateClient', async importOriginal => ({ ...(await importOriginal()), readRubCnyExchangeRateContext: async () => state.rates }));
vi.mock('../../../settings/lib/feeSettings.jsx', () => ({ loadFeePlanState: async () => ({}) }));
vi.mock('../lib/purchaseOrderNormalize.jsx', async importOriginal => ({ ...(await importOriginal()),
  readPurchaseOrderLocalOverrides: () => state.overrides,
  hydratePurchaseOrderLocalOverridesFromLocalFile: async () => state.overrides,
}));
import { usePurchaseOrdersDatasetState } from './usePurchaseOrdersDatasetState.jsx';
import { getSalesOrderRecordKey } from '../../../../entities/order/orderRecordRules.jsx';

it('keeps untouched enriched rows stable while exposing changed images, current money and new scope rows', async () => {
  const shop = { id: 'incremental-fixture', clientId: 'test-client', apiKey: 'test-only', status: 'active', shopIncarnation: 'one' };
  const rows = Array.from({ length: 200 }, (_, i) => ({ id: `POST-${i}`, posting: `POST-${i}`, shopId: shop.id,
    shopClientId: shop.clientId, raw: { status: 'awaiting_packaging', paid_at: '2026-09-01T00:00:00Z' },
    products: [{ offerId: `SKU-${i}`, name: `商品${i}`, price: '20', qty: 1 }], amount: '40' }));
  state.snapshot = { data: { rows, fetchedAt: '2026-09-07' }, reload: vi.fn(), refresh: vi.fn() };
  const { result, rerender } = renderHook(props => usePurchaseOrdersDatasetState(props), {
    initialProps: { shops: [shop], activeShopId: shop.id, isActive: true, externalRefreshTick: 0 },
  });
  await waitFor(() => expect(result.current.purchaseOrders).toHaveLength(200));
  await act(async () => {});
  const before = result.current.purchaseOrders;
  await act(async () => result.current.setPurchaseImageMap(new Map([[getSalesOrderRecordKey(rows[0]), {
    ...rows[0], products: [{ ...rows[0].products[0], image: 'fixture-image', price: '99' }],
  }]])));
  expect(result.current.purchaseOrders[0].products[0].image).toBe('fixture-image');
  expect(result.current.purchaseOrders[0].products[0].price).toBe('99');
  expect(result.current.purchaseOrders[1]).toBe(before[1]);
  expect(result.current.purchaseOrders[0].status).toBe(before[0].status);
  const after = result.current.purchaseOrders;
  await act(async () => rerender({ shops: [{ ...shop, shopIncarnation: 'two' }], activeShopId: shop.id, isActive: true, externalRefreshTick: 0 }));
  expect(result.current.purchaseOrders[1]).not.toBe(after[1]);
});
