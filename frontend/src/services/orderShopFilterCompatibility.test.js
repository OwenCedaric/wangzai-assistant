import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  getOzonConfiguredShopScopeValues,
  getOzonRowShopScopeValues,
  getOzonShopScopeForSelection,
  resolveOzonShopSelectionId,
} from '../entities/order/orderShopScope.jsx';
import { buildRowsIndex, queryRowsIndex } from './localMirrorDataset.js';

const purchaseViewPath = path.join(
  process.cwd(),
  'src',
  'features',
  'orders',
  'purchase',
  'view',
  'PurchaseOrdersPageView.jsx'
);
const afterSalesViewPath = path.join(
  process.cwd(),
  'src',
  'features',
  'orders',
  'afterSales',
  'AfterSalesOrdersPage.jsx'
);
const salesViewPath = path.join(process.cwd(), 'src', 'features', 'orders', 'sales', 'view', 'SalesOrdersPageView.jsx');
const productViewPath = path.join(process.cwd(), 'src', 'features', 'products', 'view', 'ProductListPageView.jsx');
const profitViewPath = path.join(process.cwd(), 'src', 'features', 'profit', 'ProfitPage.jsx');

describe('order page shop-filter compatibility', () => {
  it('uses the canonical internal shop id in every order and product selector', () => {
    for (const filePath of [salesViewPath, purchaseViewPath, afterSalesViewPath, productViewPath]) {
      const source = fs.readFileSync(filePath, 'utf8');
      expect(source).toContain('<MenuItem key={item.id} value={item.id}>');
      expect(source).not.toContain('value={getOzonShopFilterValue(item)}');
    }
  });

  it('matches purchase and after-sales rows by the same SQLite owner id emitted by the selector', () => {
    const rows = [
      { id: 'order-1', shopId: 'shop-1', shopClientId: 'client-1', shop: 'Ozon 1店' },
      { id: 'order-2', shopId: 'shop-2', shopClientId: 'client-2', shop: 'Ozon 2店' },
    ];
    const index = buildRowsIndex(rows, {
      getRowKey: (row) => row.id,
      getRowShop: getOzonRowShopScopeValues,
    });

    expect(queryRowsIndex(index, { shopScope: 'shop-1' })).toEqual([rows[0]]);
    expect(queryRowsIndex(index, { shopScope: 'shop-2' })).toEqual([rows[1]]);
  });

  it('matches historical rows through the configured shop identity set', () => {
    const configuredShop = {
      id: 'shop-2',
      clientId: 'client-2',
      apiKey: 'secret',
      shopAlias: 'Ozon 2店',
      shopIncarnation: 'incarnation-2',
      credentialRevision: 7,
    };
    const historicalRows = [
      {
        id: 'return-2',
        shopId: 'ozon-shop:client:client-2:incarnation:incarnation-1:revision:3',
        shopClientId: 'client-2',
        shop: 'Ozon 2店',
      },
    ];
    const index = buildRowsIndex(historicalRows, {
      getRowKey: (row) => row.id,
      getRowShop: getOzonRowShopScopeValues,
    });

    expect(
      queryRowsIndex(index, { shopScope: getOzonConfiguredShopScopeValues(configuredShop) })
    ).toEqual(historicalRows);
  });

  it('canonicalizes legacy renderer identities but preserves unknown single-shop selections', () => {
    const configuredShop = {
      id: 'shop-2',
      clientId: 'client-2',
      apiKey: 'secret',
      shopAlias: 'Ozon 2店',
      shopIncarnation: 'incarnation-2',
      credentialRevision: 7,
    };
    expect(resolveOzonShopSelectionId([configuredShop], 'client-2')).toBe('shop-2');
    expect(resolveOzonShopSelectionId([configuredShop], 'Ozon 2店')).toBe('shop-2');
    expect(resolveOzonShopSelectionId([configuredShop], 'removed-shop')).toBe('removed-shop');
    expect(getOzonShopScopeForSelection([configuredShop], 'all')).toBe('all');
  });

  it('does not leak rows across stores that share the same display name', () => {
    const shops = [
      { id: 'shop-1', clientId: 'client-1', apiKey: 'secret', shopAlias: '同名店铺' },
      { id: 'shop-2', clientId: 'client-2', apiKey: 'secret', shopAlias: '同名店铺' },
    ];
    const rows = [
      { id: 'order-1', shopId: 'shop-1', shopClientId: 'client-1', shop: '同名店铺' },
      { id: 'order-2', shopId: 'shop-2', shopClientId: 'client-2', shop: '同名店铺' },
    ];
    const scope = getOzonShopScopeForSelection(shops, 'shop-1');
    expect(scope).not.toContain('同名店铺');
    expect(scope).not.toContain('ozon-shop:label:同名店铺');
    const index = buildRowsIndex(rows, {
      getRowKey: (row) => row.id,
      getRowShop: getOzonRowShopScopeValues,
    });
    expect(queryRowsIndex(index, { shopScope: scope })).toEqual([rows[0]]);
  });

  it('profit page filters, tabs and summary through the canonical shop scope', () => {
    const source = fs.readFileSync(profitViewPath, 'utf8');
    expect(source).toContain('getOzonShopScopeForSelection(readableShops, shop)');
    expect(source).toContain('getProfitModeSummaryValue(profitFilterScopeRows, profitMode)');
    expect(source).toContain('getProfitTabCount(profitFilterScopeRows, tab.value, profitMode)');
    expect(source).toContain('<MenuItem key={item.value} value={item.value}>');
    expect(source).not.toContain("const matchShop = shop === 'all' || order.shop === shop;");
  });
});
