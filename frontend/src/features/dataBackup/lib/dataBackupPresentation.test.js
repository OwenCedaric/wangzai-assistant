import { describe, expect, it } from 'vitest';
import {
  getDataBackupDomainLabel,
  normalizeDataBackupPreview,
  normalizeDataBackupShopOption,
} from './dataBackupPresentation.js';

describe('dataBackupPresentation domain labels', () => {
  it('keeps the Ozon seller name, client id, alias, and internal shop id separate', () => {
    expect(normalizeDataBackupShopOption({
      id: 'ozon-shop-internal-a',
      shopAlias: '俄罗斯主店',
      sellerName: 'Ozon 官方旗舰店',
      clientId: '46000123',
    })).toEqual({
      shopId: 'ozon-shop-internal-a',
      shopExternalId: '46000123',
      shopName: 'Ozon 官方旗舰店',
      shopAlias: '俄罗斯主店',
      displayName: '俄罗斯主店',
    });
  });

  it('uses Chinese names for canonical domains and never renders an unknown English slug', () => {
    expect(getDataBackupDomainLabel('product-identities')).toBe('商品识别信息');
    expect(getDataBackupDomainLabel('product-dimension-facts')).toBe('商品长宽高信息');
    expect(getDataBackupDomainLabel('historical-order-facts')).toBe('历史订单导入数据');
    expect(getDataBackupDomainLabel('product-manual-cost-profiles')).toBe('商品历史成本');
    expect(getDataBackupDomainLabel('historical-order-facts')).toBe('历史订单导入数据');
    expect(getDataBackupDomainLabel('historical-order-import-runs')).toBe('历史订单导入记录');
    expect(getDataBackupDomainLabel('purchase-browser-plugin-state')).toBe('拍单插件状态');
    expect(getDataBackupDomainLabel('shared-catalog-attribute-values')).toBe('公共类目属性值');
    expect(getDataBackupDomainLabel('account-removal-operations')).toBe('账号删除操作记录');
    expect(getDataBackupDomainLabel('catalog-category-mappings')).toBe('类目映射');
    expect(getDataBackupDomainLabel('future-english-domain')).toBe('其他用户数据');
  });

  it('does not trust an English server label for an unknown domain', () => {
    const preview = normalizeDataBackupPreview({
      shops: [{
        shopId: 'shop-a',
        domains: [{
          domain: 'future-english-domain',
          label: 'private-internal-name',
          recordCount: 1,
        }],
      }],
    });
    expect(preview.shops[0].domains[0]).toMatchObject({
      domain: 'future-english-domain',
      label: '其他用户数据',
    });
    expect(JSON.stringify(preview.shops[0].domains[0])).not.toContain('private-internal-name');
  });
});
