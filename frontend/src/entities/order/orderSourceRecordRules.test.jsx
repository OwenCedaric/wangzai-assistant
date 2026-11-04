import { describe, expect, it } from 'vitest';
import {
  detectSourcePlatformFromLink,
  normalizeSalesSourceLinkValue,
  normalizeSourcePlatformName,
} from './orderSourceRecordRules.jsx';

describe('order source record rules for Ozon buyer pages', () => {
  it('accepts an Ozon buyer product link and keeps its buyer platform identity', () => {
    const result = normalizeSalesSourceLinkValue(
      'https://www.ozon.ru/product/radioupravlyaemaya-mashinka-123456789/?token=drop-me#reviews'
    );
    expect(result).toMatchObject({
      ok: true,
      platform: 'Ozon买家',
      productId: '123456789',
    });
    expect(result.link).toBe('https://www.ozon.ru/product/radioupravlyaemaya-mashinka-123456789/');
    expect(detectSourcePlatformFromLink(result.link)).toBe('Ozon买家');
    expect(normalizeSourcePlatformName('Ozon Buyer')).toBe('Ozon买家');
  });

  it('does not misclassify Ozon seller pages as buyer source links', () => {
    expect(normalizeSalesSourceLinkValue('https://seller.ozon.ru/app/products').ok).toBe(false);
    expect(detectSourcePlatformFromLink('https://seller.ozon.ru/app/products')).toBe('其他');
  });

  it('keeps Ozon buyer short share links usable until the browser resolves the product URL', () => {
    expect(normalizeSalesSourceLinkValue('https://ozon.ru/t/AbCd123/')).toMatchObject({
      ok: true,
      platform: 'Ozon买家',
      productId: 'AbCd123',
    });
  });
});
