import { describe, expect, it } from 'vitest';
import {
  createPurchaseOrderLocalOverrideUpsert,
  findPurchaseOrderLocalOverride,
  mapPurchaseOverrideRows,
} from './purchaseOrderRuntime.js';

const POSTING = '06477778-0475-1';

function shop(id, clientId) {
  return { id, clientId, shopAlias: id };
}

function order(shopId, clientId) {
  return {
    id: POSTING,
    recordKey: `${clientId}:${POSTING}`,
    posting: POSTING,
    salesOrder: POSTING,
    shopId,
    shopClientId: clientId,
  };
}

function override(shopId, fields = {}) {
  return {
    shopId,
    orderKey: POSTING,
    purchasePlatform: 'PDD',
    packageOrderId: '49531424',
    packageWeight: '0.156 kg',
    packageSize: '16.1 x 11.5 x 4.1 cm',
    ...fields,
  };
}

describe('purchase order override scoped lookup', () => {
  it('restores a legacy posting-only row for the current client-scoped Ozon record key', () => {
    const currentShop = shop('ozon-shop-example-01', '4616153');
    const restored = override(currentShop.id);
    const overrides = { [POSTING]: restored };

    expect(findPurchaseOrderLocalOverride(overrides, order(currentShop.id, currentShop.clientId), currentShop)).toEqual(
      restored
    );
  });

  it('rejects an identical posting that belongs to another internal shop', () => {
    const currentShop = shop('shop-current', 'client-current');
    const otherShopOverride = override('shop-other');

    expect(
      findPurchaseOrderLocalOverride(
        { [POSTING]: otherShopOverride },
        order(currentShop.id, currentShop.clientId),
        currentShop
      )
    ).toBeNull();
  });

  it('preserves and resolves two shops that share the same posting number', () => {
    const firstShop = shop('shop-a', 'client-a');
    const secondShop = shop('shop-b', 'client-b');
    const firstOverride = override(firstShop.id, { packageOrderId: 'bus-a' });
    const secondOverride = override(secondShop.id, { packageOrderId: 'bus-b' });
    const overrides = mapPurchaseOverrideRows([firstOverride, secondOverride]);

    expect(Object.keys(overrides).sort()).toEqual([`shop-a:${POSTING}`, `shop-b:${POSTING}`]);
    expect(findPurchaseOrderLocalOverride(overrides, order(firstShop.id, firstShop.clientId), firstShop)).toMatchObject({
      packageOrderId: 'bus-a',
    });
    expect(
      findPurchaseOrderLocalOverride(overrides, order(secondShop.id, secondShop.clientId), secondShop)
    ).toMatchObject({ packageOrderId: 'bus-b' });
  });

  it('fails closed when the supplied shop is only an unverified fallback', () => {
    const fallbackShop = shop('shop-a', 'client-a');
    const unscopedOrder = {
      id: POSTING,
      recordKey: `${fallbackShop.clientId}:${POSTING}`,
      shopClientId: fallbackShop.clientId,
    };

    expect(
      findPurchaseOrderLocalOverride({ [POSTING]: override(fallbackShop.id) }, unscopedOrder, fallbackShop)
    ).toBeNull();
  });

  it('does not accept a wrong-shop row stored under the exact client-scoped key', () => {
    const currentShop = shop('shop-current', 'client-current');
    const currentOrder = order(currentShop.id, currentShop.clientId);
    const exactKey = currentOrder.recordKey;

    expect(
      findPurchaseOrderLocalOverride(
        { [exactKey]: override('shop-other', { orderKey: exactKey }) },
        currentOrder,
        currentShop
      )
    ).toBeNull();
  });

  it('canonical upsert for shop B neither reads nor removes shop A with the same posting', () => {
    const shopA = shop('shop-a', 'client-a');
    const shopB = shop('shop-b', 'client-b');
    const shopAOverride = override(shopA.id, {
      manualPurchaseOrderNo: 'purchase-a',
      packageOrderId: 'bus-a',
    });
    const current = { [POSTING]: shopAOverride };

    const result = createPurchaseOrderLocalOverrideUpsert(
      current,
      order(shopB.id, shopB.clientId),
      shopB,
      { manualBuyerPlatform: '天猫' }
    );

    expect(result.overrides[POSTING]).toBe(shopAOverride);
    expect(result.overrides[`client-b:${POSTING}`]).toMatchObject({
      shopId: 'shop-b',
      manualBuyerPlatform: '天猫',
    });
    expect(result.aliasDeletions).toEqual([]);
    expect(findPurchaseOrderLocalOverride(result.overrides, order(shopA.id, shopA.clientId), shopA)).toEqual(
      shopAOverride
    );
  });

  it('merges a pre-existing canonical partial row over the full same-owner legacy alias for display', () => {
    const currentShop = shop('shop-a', 'client-a');
    const legacyFull = override(currentShop.id, {
      manualPurchaseOrderNo: 'purchase-a',
      packageOrderId: 'bus-a',
      packageWeight: '0.156 kg',
      updatedAt: '2026-07-16T00:00:00.000Z',
    });
    const canonicalPartial = {
      shopId: currentShop.id,
      orderKey: `client-a:${POSTING}`,
      manualBuyerPlatform: '天猫',
      updatedAt: '2026-07-17T00:00:00.000Z',
    };

    expect(
      findPurchaseOrderLocalOverride(
        { [POSTING]: legacyFull, [`client-a:${POSTING}`]: canonicalPartial },
        order(currentShop.id, currentShop.clientId),
        currentShop
      )
    ).toMatchObject({
      manualBuyerPlatform: '天猫',
      manualPurchaseOrderNo: 'purchase-a',
      packageOrderId: 'bus-a',
      packageWeight: '0.156 kg',
    });
  });

  it('keeps a newer canonical clear tombstone from reviving old plain-alias purchase values', () => {
    const currentShop = shop('shop-a', 'client-a');
    const legacyFull = override(currentShop.id, {
      manualBuyerPlatform: '1688',
      manualPurchaseOrderNo: 'purchase-old',
      manualPurchasePrice: '25.8',
      manualPurchaseOrderStatus: '已付款',
      packageOrderId: 'bus-must-remain',
      manualProfitLogisticsFeeCny: 4.2,
      updatedAt: '2026-07-16T00:00:00.000Z',
    });
    const canonicalCleared = {
      shopId: currentShop.id,
      orderKey: `client-a:${POSTING}`,
      postingNumber: `client-a:${POSTING}`,
      clearFields: [
        'purchasePlatform',
        'purchaseOrderNumber',
        'sourceCostCny',
        'manualStatus',
      ],
      forcePurchaseStatus: '待拍单',
      updatedAt: '2026-07-17T00:00:00.000Z',
    };

    const restored = findPurchaseOrderLocalOverride(
      { [POSTING]: legacyFull, [`client-a:${POSTING}`]: canonicalCleared },
      order(currentShop.id, currentShop.clientId),
      currentShop
    );

    expect(restored).not.toHaveProperty('manualBuyerPlatform');
    expect(restored).not.toHaveProperty('manualPurchaseOrderNo');
    expect(restored).not.toHaveProperty('manualPurchasePrice');
    expect(restored).not.toHaveProperty('manualPurchaseOrderStatus');
    expect(restored).toMatchObject({
      clearFields: ['purchasePlatform', 'purchaseOrderNumber', 'sourceCostCny', 'manualStatus'],
      forcePurchaseStatus: '待拍单',
      packageOrderId: 'bus-must-remain',
      manualProfitLogisticsFeeCny: 4.2,
    });
  });
});
