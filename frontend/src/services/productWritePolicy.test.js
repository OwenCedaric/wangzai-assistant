import { describe, expect, it } from 'vitest';
import {
  PRODUCT_WRITE_STAGE,
  getProductWriteFieldPolicy,
  isProductFieldAllowedInWriteGuard,
  listProductWriteFieldPolicies,
} from './productWritePolicy';

describe('productWritePolicy', () => {
  it('keeps editable Ozon fields routed through write guard with real-write/readback wording', () => {
    expect(getProductWriteFieldPolicy('name')).toMatchObject({
      endpointKey: 'products.import',
      action: 'product.updateInfo',
      stage: PRODUCT_WRITE_STAGE.WRITE_GUARD_ONLY,
    });
    expect(getProductWriteFieldPolicy('price')).toMatchObject({
      endpointKey: 'products.updatePrices',
      action: 'product.updatePrice',
      stage: PRODUCT_WRITE_STAGE.WRITE_GUARD_ONLY,
    });
    expect(getProductWriteFieldPolicy('stock')).toMatchObject({
      endpointKey: 'products.updateStocks',
      action: 'product.updateStock',
      stage: PRODUCT_WRITE_STAGE.WRITE_GUARD_ONLY,
    });
    expect(isProductFieldAllowedInWriteGuard('attribute:color')).toBe(true);
    for (const field of ['name', 'price', 'oldPrice', 'stock', 'attribute']) {
      const note = getProductWriteFieldPolicy(field).note;
      expect(note).toContain('提交 Ozon');
      expect(note).toContain('回读');
      expect(note).not.toMatch(/未开放|尚未开放|白名单|名单/u);
    }
  });

  it('keeps material source local-only and routes detail images through the write guard', () => {
    expect(getProductWriteFieldPolicy('materialSource')).toMatchObject({
      stage: PRODUCT_WRITE_STAGE.LOCAL_ONLY,
      label: '本地来源',
    });
    expect(getProductWriteFieldPolicy('detailImages')).toMatchObject({
      endpointKey: 'products.import',
      action: 'product.updateInfo',
      stage: PRODUCT_WRITE_STAGE.WRITE_GUARD_ONLY,
      label: '安全门预览',
    });
    expect(listProductWriteFieldPolicies().some((item) => item.field === 'detailImages')).toBe(true);
  });
});
