import { normalizeCustomerShopProfile } from './customerShopProfile.js';
import { describe, expect, it } from 'vitest';

describe('customer shop profile normalization', () => {
  it('uses only a real seller profile logo field', () => {
    expect(
      normalizeCustomerShopProfile(
        { data: { result: { logo_url: 'https://cdn.ozon.ru/logo.png' } } },
        { shopId: 'shop-a' }
      )
    ).toMatchObject({
      shopId: 'shop-a',
      logoUrl: 'https://cdn.ozon.ru/logo.png',
      logoField: 'logo_url',
      source: 'shop.sellerInfo',
    });
  });

  it('returns an empty logo when Ozon does not provide one', () => {
    expect(normalizeCustomerShopProfile({ data: { result: { company_name: 'SuperBaiss' } } })).toMatchObject({
      logoUrl: '',
      logoField: '',
    });
  });
});
