import { describe, expect, it } from 'vitest';
import { getPurchaseOrderShop } from './purchaseCrossBorderRuntime.js';

const shops = [
  { id: 'shop-a', clientId: 'client-a' },
  { id: 'shop-b', clientId: 'client-b' },
];

describe('purchase cross-border shop resolution', () => {
  it('uses the canonical internal shop id before compatibility identifiers', () => {
    expect(getPurchaseOrderShop(shops, {
      shopId: 'shop-a',
      shopClientId: 'client-b',
    })).toBe(shops[0]);
  });

  it('fails closed instead of falling back to the active shop for an unknown owner', () => {
    expect(getPurchaseOrderShop(shops, {
      shopId: 'deleted-shop',
      shopClientId: 'client-a',
    }, shops[0])).toBeNull();
    expect(getPurchaseOrderShop(shops, {
      shopClientId: 'deleted-client',
    }, shops[0])).toBeNull();
  });

  it('uses an explicit fallback only when the order carries no owner identity', () => {
    expect(getPurchaseOrderShop(shops, {}, shops[1])).toBe(shops[1]);
    expect(getPurchaseOrderShop([shops[0]], {})).toBe(shops[0]);
    expect(getPurchaseOrderShop(shops, {})).toBeNull();
  });
});
