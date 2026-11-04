import { describe, expect, it } from 'vitest';

import {
  getCollectionSkuShopInventory,
  normalizeCollectionSkuInventoryByShop,
  setCollectionSkuShopInventories,
  sharedCollectionSkuShopInventory,
} from './collectionProductShopInventory.js';

describe('collection product shop inventory', () => {
  it('migrates one legacy shop inventory without copying it to another shop', () => {
    const normalized = normalizeCollectionSkuInventoryByShop({}, {
      shopId: 'shop-a', warehouseId: 'warehouse-a', stock: 100,
    });
    expect(normalized).toEqual({
      'shop-a': { warehouseId: 'warehouse-a', stock: '100' },
    });
    expect(getCollectionSkuShopInventory({
      stock: '100', warehouseId: 'warehouse-a', inventoryByShopId: normalized,
    }, 'shop-b')).toEqual({ warehouseId: '', stock: '' });
    expect(getCollectionSkuShopInventory({
      stock: '100', warehouseId: 'warehouse-a',
    }, 'shop-a')).toEqual({ warehouseId: '', stock: '' });
  });

  it('keeps warehouse and stock isolated by shop id', () => {
    const inventoryByShopId = setCollectionSkuShopInventories({}, {
      'shop-a': { warehouseId: 'warehouse-a', stock: 20 },
      'shop-b': { warehouseId: 'warehouse-b', stock: 35 },
    });
    expect(inventoryByShopId['shop-a']).toEqual({ warehouseId: 'warehouse-a', stock: '20' });
    expect(inventoryByShopId['shop-b']).toEqual({ warehouseId: 'warehouse-b', stock: '35' });
  });

  it('returns a shared value only when all enabled SKUs agree for that shop', () => {
    const skus = [
      { enabled: true, inventoryByShopId: { 'shop-a': { warehouseId: 'a', stock: '20' } } },
      { enabled: true, inventoryByShopId: { 'shop-a': { warehouseId: 'a', stock: '20' } } },
      { enabled: false, inventoryByShopId: { 'shop-a': { warehouseId: 'x', stock: '99' } } },
    ];
    expect(sharedCollectionSkuShopInventory(skus, 'shop-a')).toEqual({ warehouseId: 'a', stock: '20' });
  });
});
