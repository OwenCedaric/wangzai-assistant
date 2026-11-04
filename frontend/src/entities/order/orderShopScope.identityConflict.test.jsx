import { describe, expect, it } from 'vitest';
import { attachOzonShopIdentityToRow } from './orderShopScope.jsx';

const shops = [
  { id: 'shop-a', clientId: 'client-a', hasApiKey: true, shopAlias: 'A 店' },
  { id: 'shop-b', clientId: 'client-b', hasApiKey: true, shopAlias: 'B 店' },
];

describe('attachOzonShopIdentityToRow canonical owner normalization', () => {
  it('prefers canonical shopId when stale Client-Id points to another shop', () => {
    const row = attachOzonShopIdentityToRow(
      {
        shopId: 'shop-a',
        shop_id: 'shop-a',
        shopClientId: 'client-b',
        client_id: 'client-b',
        shopName: 'B 店',
      },
      shops
    );

    expect(row).toMatchObject({
      shopId: 'shop-a',
      shop_id: 'shop-a',
      shopClientId: 'client-a',
      shop_client_id: 'client-a',
      clientId: 'client-a',
      client_id: 'client-a',
      shop: 'A 店',
      shopName: 'A 店',
      storeName: 'A 店',
    });
  });

  it('uses Client-Id only as a fallback when canonical shopId is absent', () => {
    const row = attachOzonShopIdentityToRow({ clientId: 'client-b' }, shops);
    expect(row.shopId).toBe('shop-b');
    expect(row.clientId).toBe('client-b');
    expect(row.shopName).toBe('B 店');
  });
});
